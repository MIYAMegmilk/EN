/**
 * 作業ボード: GitHub REST API 連携（設計書 docs/design/board.md §9）
 *
 * 目的は 1 つだけ。**オープン中の PR と、それぞれが変更しているファイル一覧を取得する。**
 * ボードのサーバーがこれを定期実行して KV にキャッシュし、表明（claim）のパスと突き合わせる。
 *
 * 方針:
 * - 外部パッケージは使わない（Deno 標準機能のみ）。
 * - GitHub トークンは環境変数 `BOARD_GITHUB_TOKEN` から読む。引数で直接渡すこともできる（テスト用）。
 * - **トークンは一切ログに出さない。** このモジュールは console 出力を行わず、
 *   例外メッセージからもトークン文字列を伏字に置き換える（§7-4 / §7-5）。
 * - `fetch` を注入できるようにしてあり、テストはネットワークに出ない。
 * - このモジュールは「判断」をしない。GitHub との入出力と、PrIndex への整形に徹する。
 *
 * 参考にした公式ドキュメント:
 * - List pull requests
 *   https://docs.github.com/en/rest/pulls/pulls#list-pull-requests
 * - List pull requests files（レスポンスは最大 3000 ファイル / 既定 30 件・per_page 最大 100）
 *   https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files
 * - Rate limits（x-ratelimit-remaining / x-ratelimit-reset は UTC epoch 秒）
 *   https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 * - Pagination（`link` ヘッダの `rel="next"` を辿る）
 *   https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
 *
 * 注意: `tools/board/types.ts` は別担当が並行作業中のため、ここではローカルに型を定義している。
 * 型名・項目名は設計書 §4 の `prIndex` に揃えてある（統合時にこちらの定義を移す想定）。
 */

/** GitHub API のルート。テストではダミーのオリジンを渡す。 */
const DEFAULT_API_ROOT = "https://api.github.com";
const USER_AGENT = "en-board";
const API_VERSION = "2022-11-28";
/** per_page の最大値は 100（公式ドキュメント） */
const DEFAULT_PER_PAGE = 100;
/** files は最大 3000 件しか返らないので、100 件/ページなら 30 ページで足りる */
const DEFAULT_MAX_PAGES = 30;
/** エラーメッセージに載せるレスポンス本文の最大長 */
const MAX_BODY_SNIPPET = 500;
/** 伏字 */
const REDACTED = "***";

// ---------------------------------------------------------------------------
// 型（統合時に types.ts へ移す）
// ---------------------------------------------------------------------------

/** PR が変更した 1 ファイル */
export interface PrFile {
  /** 変更後のパス（リポジトリルートからの相対） */
  filename: string;
  /** added / removed / modified / renamed / copied / changed / unchanged */
  status: string;
  /** リネーム時のみ、変更前のパス */
  previousFilename?: string;
}

/**
 * PR 索引の 1 件（設計書 §4 prIndex）。
 * KV にキャッシュされ、`GET /api/prs` と `/api/claims/check` から使われる。
 */
export interface PrIndex {
  prNumber: number;
  title: string;
  /** PR の作成者（`user.login`）。取得できない場合は "unknown" */
  author: string;
  /** PR のブランチ名（`head.ref`） */
  headRef: string;
  /** この PR が触っているパス（リネーム前のパスも含む・重複排除済み） */
  files: string[];
  /** 取得時刻（ISO 8601）。古いキャッシュを返すときに「いつ時点か」を示す */
  fetchedAt: string;
}

/** オープン PR のメタ情報（files を取りに行く前の中間表現） */
export interface OpenPullRequest {
  prNumber: number;
  title: string;
  author: string;
  headRef: string;
  /** ドラフト PR かどうか（索引には含めないが、呼び出し側が絞り込めるように返す） */
  draft: boolean;
}

/** 注入可能な fetch。テストでは偽の応答を返す関数を渡す。 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 環境変数の読み取り口（テストで差し替えられるように最小の形にする） */
export interface EnvLike {
  get(key: string): string | undefined;
}

/** クライアントの生成オプション */
export interface GitHubClientOptions {
  /** "owner/name" 形式 */
  repo: string;
  /** GitHub トークン。省略時は `resolveGitHubToken()` で環境変数から読む */
  token?: string;
  /** 注入する fetch（省略時はグローバル fetch） */
  fetch?: FetchLike;
  /** API のルート URL（省略時は https://api.github.com）。テスト用 */
  apiRoot?: string;
  /** 1 ページあたりの件数（1〜100） */
  perPage?: number;
  /** ページングの上限（無限ループ防止） */
  maxPages?: number;
}

// ---------------------------------------------------------------------------
// エラー
// ---------------------------------------------------------------------------

/** ボードの GitHub 連携で起きたエラー（トークンは絶対に含めない） */
export class BoardGitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardGitHubError";
  }
}

/** レート制限に達したことを示すエラー */
export class RateLimitError extends BoardGitHubError {
  /** x-ratelimit-reset（UTC epoch 秒）。取得できなければ null */
  readonly resetEpochSec: number | null;

  constructor(message: string, resetEpochSec: number | null) {
    super(message);
    this.name = "RateLimitError";
    this.resetEpochSec = resetEpochSec;
  }
}

// ---------------------------------------------------------------------------
// 小さな純関数
// ---------------------------------------------------------------------------

/** "owner/name" 形式を検証して分解する */
export function parseRepo(repo: unknown): { owner: string; name: string } {
  if (typeof repo !== "string") {
    throw new BoardGitHubError('repo は "owner/name" 形式の文字列である必要があります');
  }
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(repo.trim());
  if (!m) {
    throw new BoardGitHubError(
      `repo が "owner/name" 形式ではありません: ${JSON.stringify(repo)}`,
    );
  }
  return { owner: m[1], name: m[2] };
}

/**
 * 環境変数 `BOARD_GITHUB_TOKEN` から GitHub トークンを読む。
 * **戻り値はログ・ファイルに出さないこと。** 未設定時のエラーにも値は含めない。
 */
export function resolveGitHubToken(env: EnvLike = Deno.env): string {
  const raw = env.get("BOARD_GITHUB_TOKEN");
  const token = typeof raw === "string" ? raw.trim() : "";
  if (token.length === 0) {
    throw new BoardGitHubError(
      "環境変数 BOARD_GITHUB_TOKEN が設定されていません。VPS の .env に設定してください" +
        "（値はログに出力しません）。",
    );
  }
  return token;
}

/**
 * `link` ヘッダから `rel="next"` の URL を取り出す。
 * 形式: `<https://api.github.com/...?page=2>; rel="next", <...>; rel="last"`
 * （GitHub が返す URL にカンマは含まれないため、カンマ区切りで分割してよい）
 */
export function parseNextLink(header: string | null | undefined): string | null {
  if (typeof header !== "string" || header.length === 0) return null;
  for (const part of header.split(",")) {
    const m = /^\s*<([^>]+)>\s*;\s*(.+)$/.exec(part);
    if (!m) continue;
    if (/\brel\s*=\s*"?next"?/i.test(m[2])) return m[1].trim();
  }
  return null;
}

/** レート制限のリセット時刻を人間が読める形にする（ロケール非依存） */
export function formatResetTime(resetEpochSec: number | null, nowMs = Date.now()): string {
  if (resetEpochSec === null) return "不明";
  const resetMs = resetEpochSec * 1000;
  const waitSec = Math.max(0, Math.ceil((resetMs - nowMs) / 1000));
  return `${new Date(resetMs).toISOString()}（約 ${waitSec} 秒後）`;
}

/** ヘッダの数値を安全に読む */
function readNumericHeader(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (raw === null) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

/** URL の `page` パラメータを差し替える（link ヘッダが無いときのフォールバック用） */
function withPage(url: string, page: number): string {
  const u = new URL(url);
  u.searchParams.set("page", String(page));
  return u.toString();
}

// ---------------------------------------------------------------------------
// クライアント
// ---------------------------------------------------------------------------

/**
 * ボード用の最小 GitHub クライアント。
 * オープン PR の一覧と、各 PR の変更ファイル一覧の取得しかできない（それで足りる）。
 */
export class BoardGitHubClient {
  readonly owner: string;
  readonly name: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #apiRoot: string;
  readonly #apiOrigin: string;
  readonly #perPage: number;
  readonly #maxPages: number;
  /** 直近のレスポンスが示したレート制限の残量（未取得なら null） */
  #remaining: number | null = null;
  /** 直近のレスポンスが示したリセット時刻（UTC epoch 秒。未取得なら null） */
  #resetEpochSec: number | null = null;

  constructor(options: GitHubClientOptions) {
    const { owner, name } = parseRepo(options.repo);
    this.owner = owner;
    this.name = name;

    const token = options.token ?? resolveGitHubToken();
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new BoardGitHubError("GitHub トークンが空です（値はログに出力しません）。");
    }
    this.#token = token.trim();

    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));

    const apiRoot = (options.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/, "");
    let origin: string;
    try {
      origin = new URL(apiRoot).origin;
    } catch {
      throw new BoardGitHubError(`apiRoot が URL として不正です: ${JSON.stringify(apiRoot)}`);
    }
    this.#apiRoot = apiRoot;
    this.#apiOrigin = origin;

    const perPage = options.perPage ?? DEFAULT_PER_PAGE;
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
      throw new BoardGitHubError("perPage は 1〜100 の整数である必要があります");
    }
    this.#perPage = perPage;

    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new BoardGitHubError("maxPages は 1 以上の整数である必要があります");
    }
    this.#maxPages = maxPages;
  }

  get repoPath(): string {
    return `${this.owner}/${this.name}`;
  }

  /** 直近のレスポンスから分かるレート制限の状態（監視・ログ表示用。トークンは含まない） */
  get rateLimit(): { remaining: number | null; resetEpochSec: number | null } {
    return { remaining: this.#remaining, resetEpochSec: this.#resetEpochSec };
  }

  /**
   * オープン中の PR を全件取得する。
   * `GET /repos/{owner}/{repo}/pulls?state=open`
   */
  async listOpenPullRequests(): Promise<OpenPullRequest[]> {
    const url = `${this.#apiRoot}/repos/${this.owner}/${this.name}/pulls` +
      `?state=open&sort=created&direction=asc&per_page=${this.#perPage}&page=1`;
    const raw = await this.#paginate(url);
    return raw.map((item) => this.#toOpenPullRequest(item));
  }

  /**
   * 1 つの PR が変更したファイルを全件取得する（ページネーション対応）。
   * `GET /repos/{owner}/{repo}/pulls/{number}/files`
   *
   * 注意: GitHub は 1 PR あたり最大 3000 ファイルしか返さない（公式ドキュメント）。
   * それを超える PR では取りこぼしが起きるが、これは API の仕様上どうにもならない。
   */
  async listPullRequestFiles(prNumber: number): Promise<PrFile[]> {
    if (!Number.isInteger(prNumber) || prNumber < 1) {
      throw new BoardGitHubError(`PR 番号が不正です: ${JSON.stringify(prNumber)}`);
    }
    const url = `${this.#apiRoot}/repos/${this.owner}/${this.name}/pulls/${prNumber}/files` +
      `?per_page=${this.#perPage}&page=1`;
    const raw = await this.#paginate(url);
    return raw.map((item) => this.#toPrFile(item, prNumber));
  }

  /**
   * オープン PR と各 PR の変更ファイルをまとめて `PrIndex[]` にする（設計書 §4）。
   *
   * リクエスト数は「1 + PR 数（+ ページ数）」。5 分間隔なら 5000 req/hour の枠に十分収まる。
   * PR が 1 件でも失敗したら例外を投げる（呼び出し側が古いキャッシュを返す判断をする）。
   */
  async buildPrIndex(now: Date = new Date()): Promise<PrIndex[]> {
    const fetchedAt = now.toISOString();
    const prs = await this.listOpenPullRequests();
    const index: PrIndex[] = [];
    for (const pr of prs) {
      const files = await this.listPullRequestFiles(pr.prNumber);
      index.push({
        prNumber: pr.prNumber,
        title: pr.title,
        author: pr.author,
        headRef: pr.headRef,
        files: collectPaths(files),
        fetchedAt,
      });
    }
    return index;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** `link` ヘッダの `rel="next"` を辿って全ページを集める */
  async #paginate(firstUrl: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let url = firstUrl;
    for (let page = 1; page <= this.#maxPages; page++) {
      const res = await this.#request(url);
      const chunk = await this.#readJsonArray(res, url);
      items.push(...chunk);

      const linkHeader = res.headers.get("link");
      const next = parseNextLink(linkHeader);
      if (next !== null) {
        this.#assertSameOrigin(next);
        url = next;
        continue;
      }
      // link ヘッダを返さないサーバー向けのフォールバック。
      // ちょうど per_page 件返ってきた場合のみ、page を進めてもう一度試す。
      if (linkHeader === null && chunk.length === this.#perPage) {
        url = withPage(url, page + 1);
        continue;
      }
      return items;
    }
    throw new BoardGitHubError(
      `ページングが上限 ${this.#maxPages} ページに達しました: ${this.#redact(firstUrl)}`,
    );
  }

  /** 1 リクエスト。レート制限と 2xx 以外をここで例外にする。 */
  async #request(url: string): Promise<Response> {
    this.#assertRateLimitBudget();

    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.#token}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": USER_AGENT,
        },
      });
    } catch (e) {
      // 例外メッセージに Authorization ヘッダが載る実装は無い想定だが、念のため伏字にする
      throw new BoardGitHubError(
        `GitHub API へのリクエストに失敗しました: ${this.#redact(url)}\n  ` +
          this.#redact(e instanceof Error ? e.message : String(e)),
      );
    }

    this.#remaining = readNumericHeader(res, "x-ratelimit-remaining");
    this.#resetEpochSec = readNumericHeader(res, "x-ratelimit-reset");

    if (!res.ok) {
      await this.#throwHttpError(res, url);
    }
    return res;
  }

  /** 直近のレスポンスで残量が 0 なら、リセットまで新規リクエストを投げない */
  #assertRateLimitBudget(): void {
    if (this.#remaining === null || this.#remaining > 0) return;
    const resetMs = this.#resetEpochSec === null ? 0 : this.#resetEpochSec * 1000;
    if (resetMs <= Date.now()) return;
    throw new RateLimitError(
      `GitHub API のレート制限を使い切っています（残り 0）。` +
        `リセット: ${formatResetTime(this.#resetEpochSec)}。リクエストを送らずに中止します。`,
      this.#resetEpochSec,
    );
  }

  /** 2xx 以外を例外にする。リクエストヘッダ（＝トークン）は絶対に含めない。 */
  async #throwHttpError(res: Response, url: string): Promise<never> {
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    const reset = this.#resetEpochSec;

    // 一次レート制限: 403 / 429 かつ残り 0
    if ((res.status === 403 || res.status === 429) && this.#remaining === 0) {
      throw new RateLimitError(
        `GitHub API のレート制限に達しました（残り 0）。` +
          `リセット: ${formatResetTime(reset)}。自動リトライはしません。`,
        reset,
      );
    }
    // 二次レート制限: Retry-After が付く
    const retryAfter = res.headers.get("retry-after");
    if ((res.status === 403 || res.status === 429) && retryAfter !== null) {
      throw new RateLimitError(
        `GitHub API の二次レート制限を受けました（Retry-After: ${retryAfter} 秒）。` +
          `自動リトライはしません。`,
        reset,
      );
    }

    const snippet = text.length > MAX_BODY_SNIPPET ? `${text.slice(0, MAX_BODY_SNIPPET)}…` : text;
    throw new BoardGitHubError(
      `GitHub API エラー ${res.status} ${res.statusText}\n  GET ${this.#redact(url)}\n  ` +
        this.#redact(snippet),
    );
  }

  /** レスポンス本文を JSON 配列として読む */
  async #readJsonArray(res: Response, url: string): Promise<unknown[]> {
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new BoardGitHubError(
        `GitHub API のレスポンスを読めませんでした: ${this.#redact(url)}\n  ` +
          this.#redact(e instanceof Error ? e.message : String(e)),
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BoardGitHubError(
        `GitHub API のレスポンスが JSON ではありません: ${this.#redact(url)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new BoardGitHubError(
        `GitHub API のレスポンスが配列ではありません: ${this.#redact(url)}`,
      );
    }
    return parsed;
  }

  /** next の URL が API と同一オリジンであることを確認する（トークンを他所へ送らないため） */
  #assertSameOrigin(url: string): void {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      throw new BoardGitHubError(`link ヘッダの next が URL として不正です: ${this.#redact(url)}`);
    }
    if (origin !== this.#apiOrigin) {
      throw new BoardGitHubError(
        `link ヘッダの next が API と別のオリジンを指しています（${origin}）。追跡を中止します。`,
      );
    }
  }

  /** PR オブジェクトを検証して中間表現にする（推測で補完しない） */
  #toOpenPullRequest(item: unknown): OpenPullRequest {
    const o = asRecord(item, "PR");
    const prNumber = o.number;
    if (typeof prNumber !== "number" || !Number.isInteger(prNumber)) {
      throw new BoardGitHubError("PR の number が整数ではありません");
    }
    const title = typeof o.title === "string" ? o.title : "";
    const user = isRecord(o.user) ? o.user : null;
    const author = user !== null && typeof user.login === "string" && user.login.length > 0
      ? user.login
      : "unknown";
    const head = isRecord(o.head) ? o.head : null;
    if (head === null || typeof head.ref !== "string") {
      throw new BoardGitHubError(`PR #${prNumber} の head.ref を取得できません`);
    }
    return {
      prNumber,
      title,
      author,
      headRef: head.ref,
      draft: o.draft === true,
    };
  }

  /** files の 1 要素を検証して PrFile にする */
  #toPrFile(item: unknown, prNumber: number): PrFile {
    const o = asRecord(item, `PR #${prNumber} の変更ファイル`);
    if (typeof o.filename !== "string" || o.filename.length === 0) {
      throw new BoardGitHubError(`PR #${prNumber} の変更ファイルに filename がありません`);
    }
    const file: PrFile = {
      filename: o.filename,
      status: typeof o.status === "string" ? o.status : "unknown",
    };
    if (typeof o.previous_filename === "string" && o.previous_filename.length > 0) {
      file.previousFilename = o.previous_filename;
    }
    return file;
  }

  /** 万一トークンが混ざった文字列を外に出さないための最後の砦 */
  #redact(text: string): string {
    if (this.#token.length === 0) return text;
    return text.split(this.#token).join(REDACTED);
  }
}

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (!isRecord(v)) {
    throw new BoardGitHubError(`${what} がオブジェクトではありません`);
  }
  return v;
}

/**
 * 変更ファイルから「触っているパス」の一覧を作る。
 * リネームは変更前のパスも書き換えの対象なので、重なり検出のために両方を含める。
 */
export function collectPaths(files: readonly PrFile[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const f of files) {
    for (const p of [f.filename, f.previousFilename]) {
      if (typeof p !== "string" || p.length === 0 || seen.has(p)) continue;
      seen.add(p);
      paths.push(p);
    }
  }
  return paths;
}
