/**
 * 作業ボード（board）の CLI（docs/design/board.md §6 / §8）
 *
 *   board.ts claim <title>   … これから何を作るかを表明する
 *   board.ts list            … 現在の表明一覧を表示する
 *   board.ts check <paths…>  … 指定パスに重なる表明・オープン PR を確認する
 *   board.ts done            … 自分の表明を完了（--paused で中断）にする
 *   board.ts task add/list/done
 *
 * 設計上の約束（§7 / §8）:
 *
 *   - **トークンを画面にもログにも一切出さない**（§7-4）。`Authorization` ヘッダーに載せる
 *     以外の用途では触らず、サーバーの応答に万一混ざっていても `redactToken()` で伏せる。
 *   - **ボードに繋がらないときは終了コード 0 で終わる**（§8「ボードが落ちていても作業は止めない」）。
 *     フックはこの CLI を呼ぶだけなので、CLI が非 0 を返すと本業が止まりかねない。
 *     したがって「未設定」「接続失敗」「タイムアウト」はすべて 0 とし、
 *     非 0 にするのは「使い方の誤り」と「サーバーがエラー応答を返した場合」だけにする。
 *   - **平文 HTTP には送らない**（§7-8「HTTPS 必須」）。localhost を除き http:// は拒否する。
 *
 * §3 のとおり board は EN 本体と完全に独立させるため、`server/` からは何も import しない。
 *
 * 実行例:
 *   deno run --allow-net --allow-read --allow-env tools/board/board.ts list
 */

import { loadSync } from "@std/dotenv";
import { fromFileUrl } from "@std/path";
import type {
  ClaimCheckResponse,
  ClaimCreateRequest,
  ClaimListResponse,
  ClaimResponse,
  ClaimStatus,
  ClaimUpdateRequest,
  ClaimView,
  PrIndex,
  TaskCreateRequest,
  TaskListResponse,
  TaskResponse,
  TaskStatus,
  TaskUpdateRequest,
} from "./types.ts";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** `.env` / 環境変数から読む接続先 */
export const ENV_URL = "BOARD_URL";
/** `.env` / 環境変数から読むトークン（**値は決して表示しない**、§7-4） */
export const ENV_TOKEN = "BOARD_TOKEN";

/**
 * 既定のタイムアウト（ミリ秒）。
 * フックから毎回呼ばれるため**短くする**（§8「接続失敗時はフックを素通りさせる」）。
 * 待たされること自体が「本業を止める」ことになるので、数秒で見切る。
 */
export const DEFAULT_TIMEOUT_MS = 4_000;

/** 一覧表示でパスを並べる上限。これを超えたら「ほかN件」に畳む */
export const PATHS_DISPLAY_MAX = 8;

/** 表明の本文に秘密情報を書かせないための注意書き（§7-7） */
export const SECRET_WARNING = "※ title / note にトークン・パスワード等の秘密情報を書かないこと。";

// ---------------------------------------------------------------------------
// 引数の解析
// ---------------------------------------------------------------------------

/** 解析済みのサブコマンド */
export type Command =
  | { kind: "help" }
  | {
    kind: "claim";
    title: string;
    paths: string[];
    branch?: string;
    prNumber?: number;
    note?: string;
  }
  | { kind: "list" }
  | { kind: "check"; paths: string[] }
  | { kind: "done"; status: Extract<ClaimStatus, "done" | "paused"> }
  | { kind: "task-add"; title: string; body: string; assignee?: string }
  | { kind: "task-list" }
  | { kind: "task-done"; id: string };

/** すべてのサブコマンドで共通のオプション */
export type GlobalOptions = {
  /** JSON で出力するか（フックが読むため） */
  json: boolean;
  /** セッション識別子。フックは `--session` で hook 入力の `session_id` を渡す */
  sessionId?: string;
  /** タイムアウト（ミリ秒） */
  timeoutMs: number;
};

/** 引数の解析結果 */
export type ParsedArgs =
  | { ok: true; command: Command; options: GlobalOptions }
  | { ok: false; message: string };

/** 値を取るフラグ */
const VALUE_FLAGS = new Set([
  "--paths",
  "--branch",
  "--pr",
  "--note",
  "--body",
  "--assignee",
  "--session",
  "--timeout",
]);

/** 値を取らないフラグ */
const BOOL_FLAGS = new Set(["--json", "--paused", "--help", "-h"]);

/**
 * `a,b , c` のような指定を配列にする。空要素は落とす。
 * `--paths` は繰り返し指定もできるので、呼び出し側で連結する。
 */
export function splitList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * パスを比較しやすい形に正規化する。
 *
 * Windows で作業するメンバーが `server\rooms.ts` と打っても、サーバー側（リポジトリルート
 * からの相対パス）と突き合わせられるように `/` 区切りへ寄せ、`./` と末尾の `/` を落とす。
 * 絶対パスはここでは判定できないので触らない（サーバー側の正規化に委ねる）。
 */
export function normalizePath(p: string): string {
  let s = p.trim().replaceAll("\\", "/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/**
 * コマンドライン引数を解析する（副作用なし。テストしやすいよう純関数にしてある）。
 *
 * `--flag value` と `--flag=value` の両方を受ける。未知のフラグはエラーにする
 * （黙って無視すると「指定したのに効かない」事故になるため）。
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const options: GlobalOptions = { json: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    let name = arg;
    let inlineValue: string | undefined;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }
    if (BOOL_FLAGS.has(name)) {
      if (inlineValue !== undefined) return { ok: false, message: `${name} は値を取りません。` };
      if (name === "--help" || name === "-h") help = true;
      else flags.set(name, ["true"]);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      return { ok: false, message: `不明なオプション: ${name}` };
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined) return { ok: false, message: `${name} には値が必要です。` };
    const list = flags.get(name) ?? [];
    list.push(value);
    flags.set(name, list);
  }

  /** 値フラグの最後の指定を返す */
  const one = (name: string): string | undefined => flags.get(name)?.at(-1);

  const session = one("--session");
  if (session !== undefined && session.trim() !== "") options.sessionId = session.trim();
  options.json = flags.has("--json");

  const timeout = one("--timeout");
  if (timeout !== undefined) {
    const ms = Number(timeout);
    if (!Number.isFinite(ms) || ms <= 0) {
      return { ok: false, message: "--timeout には正の数（ミリ秒）を指定してください。" };
    }
    options.timeoutMs = ms;
  }

  if (help || positionals.length === 0) return { ok: true, command: { kind: "help" }, options };

  const sub = positionals[0];
  const rest = positionals.slice(1);

  switch (sub) {
    case "help":
      return { ok: true, command: { kind: "help" }, options };

    case "claim": {
      const title = rest.join(" ").trim();
      if (title === "") {
        return { ok: false, message: "claim には表明する内容（title）が必要です。" };
      }
      const paths = (flags.get("--paths") ?? []).flatMap(splitList).map(normalizePath);
      const command: Command = { kind: "claim", title, paths };
      const branch = one("--branch")?.trim();
      if (branch) command.branch = branch;
      const note = one("--note")?.trim();
      if (note) command.note = note;
      const pr = one("--pr");
      if (pr !== undefined) {
        const n = Number(pr.trim().replace(/^#/, ""));
        if (!Number.isInteger(n) || n <= 0) {
          return { ok: false, message: "--pr には PR 番号（正の整数）を指定してください。" };
        }
        command.prNumber = n;
      }
      return { ok: true, command, options };
    }

    case "list":
      if (rest.length > 0) return { ok: false, message: "list は引数を取りません。" };
      return { ok: true, command: { kind: "list" }, options };

    case "check": {
      const paths = rest.flatMap(splitList).map(normalizePath).filter((p) => p !== "");
      if (paths.length === 0) {
        return { ok: false, message: "check には確認するパスを1つ以上指定してください。" };
      }
      return { ok: true, command: { kind: "check", paths: unique(paths) }, options };
    }

    case "done":
      if (rest.length > 0) return { ok: false, message: "done は引数を取りません。" };
      return {
        ok: true,
        command: { kind: "done", status: flags.has("--paused") ? "paused" : "done" },
        options,
      };

    case "task": {
      const action = rest[0];
      const args = rest.slice(1);
      if (action === "add") {
        const title = args.join(" ").trim();
        if (title === "") return { ok: false, message: "task add にはタイトルが必要です。" };
        const command: Command = { kind: "task-add", title, body: one("--body")?.trim() ?? "" };
        const assignee = one("--assignee")?.trim();
        if (assignee) command.assignee = assignee;
        return { ok: true, command, options };
      }
      if (action === "list") {
        if (args.length > 0) return { ok: false, message: "task list は引数を取りません。" };
        return { ok: true, command: { kind: "task-list" }, options };
      }
      if (action === "done") {
        const id = args[0]?.trim();
        if (!id) return { ok: false, message: "task done には タスク ID が必要です。" };
        if (args.length > 1) return { ok: false, message: "task done の引数は ID 1つだけです。" };
        return { ok: true, command: { kind: "task-done", id }, options };
      }
      return { ok: false, message: "task のサブコマンドは add / list / done です。" };
    }

    default:
      return { ok: false, message: `不明なサブコマンド: ${sub}` };
  }
}

/** 順序を保ったまま重複を落とす */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// 設定（.env）
// ---------------------------------------------------------------------------

/** `Deno.env` と差し替え可能にするための最小インターフェース */
export type EnvLike = { get(key: string): string | undefined };

/** 接続設定 */
export type BoardConfig = { url: string; token: string };

/** 設定の解決結果 */
export type ConfigResult =
  | { ok: true; config: BoardConfig }
  | { ok: false; message: string };

/**
 * `tools/board/.env` を読む。存在しない・読めない場合は空とみなす。
 *
 * `export: false` にして**プロセスの環境変数を汚さない**（他のツールへ漏らさない、§7-4）。
 * 読み取り権限が無い等の例外もここで握りつぶす。CLI が落ちてよい場面ではない。
 */
export function readEnvFile(envPath: string): Record<string, string> {
  try {
    return loadSync({ envPath, export: false });
  } catch {
    return {};
  }
}

/**
 * 接続先 URL を検証する（§7-8「HTTPS 必須。平文 HTTP では受けない」）。
 *
 * 平文 HTTP へトークンを送るのは、そのまま盗聴でトークンが漏れることを意味する。
 * ローカル開発（localhost / 127.0.0.1 / ::1）だけは例外として許す。
 */
export function validateBoardUrl(raw: string): { ok: true; url: string } | {
  ok: false;
  message: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: `${ENV_URL} が URL として不正です: ${raw}` };
  }
  if (parsed.protocol === "https:") return { ok: true, url: raw };
  if (parsed.protocol === "http:") {
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
      return { ok: true, url: raw };
    }
    return {
      ok: false,
      message: `${ENV_URL} が平文 HTTP です（${parsed.origin}）。` +
        "トークンが盗聴されるため https:// にしてください（localhost のみ例外）。",
    };
  }
  return { ok: false, message: `${ENV_URL} は http(s) にしてください: ${parsed.protocol}` };
}

/**
 * `.env` の内容とプロセスの環境変数から接続設定を組み立てる。
 * **環境変数を優先する**（CI やフックから一時的に上書きできるようにするため）。
 */
export function resolveConfig(fileEnv: Record<string, string>, env: EnvLike): ConfigResult {
  const url = (env.get(ENV_URL) ?? fileEnv[ENV_URL] ?? "").trim();
  const token = (env.get(ENV_TOKEN) ?? fileEnv[ENV_TOKEN] ?? "").trim();
  const missing: string[] = [];
  if (url === "") missing.push(ENV_URL);
  if (token === "") missing.push(ENV_TOKEN);
  if (missing.length > 0) {
    return {
      ok: false,
      message: `${missing.join(" と ")} が未設定です。` +
        "tools/board/.env.example を tools/board/.env にコピーして値を入れてください" +
        "（.env は .gitignore 済み。トークンは各自で管理し、git に入れないこと）。",
    };
  }
  const checked = validateBoardUrl(url);
  if (!checked.ok) return { ok: false, message: checked.message };
  return { ok: true, config: { url: checked.url, token } };
}

/**
 * セッション識別子を決める（§4「1セッション1表明」）。
 *
 * フックは hook 入力の `session_id` を `--session` で渡す。人間が手で叩くときのために
 * 環境変数と、最後の手段として「利用者名から作る固定値」を用意してある。固定値は
 * **同じ人が同時に複数の手動表明を持てない**ことを意味するが、手で表明を出すのは
 * せいぜい1件なので実用上の困りは無い。
 */
export function resolveSessionId(explicit: string | undefined, env: EnvLike): string {
  const fromFlag = explicit?.trim();
  if (fromFlag) return fromFlag;
  for (const key of ["CLAUDE_SESSION_ID", "BOARD_SESSION_ID"]) {
    const v = env.get(key)?.trim();
    if (v) return v;
  }
  const user = (env.get("USERNAME") ?? env.get("USER") ?? "unknown").trim() || "unknown";
  return `manual-${user}`;
}

// ---------------------------------------------------------------------------
// HTTP クライアント
// ---------------------------------------------------------------------------

/** `fetch` を差し替え可能にするための型（テストはネットワークに出ない） */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** ボードに到達できなかった（接続失敗・タイムアウト・DNS 等） */
export class BoardUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardUnreachableError";
  }
}

/** ボードはエラー応答を返した（401 / 400 / 500 等） */
export class BoardApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BoardApiError";
    this.status = status;
  }
}

/**
 * 文字列からトークンを伏せる（§7-4「エラー応答にトークンを含めない」の受け側の備え）。
 *
 * サーバーが誤ってトークンを反射しても、こちらの画面とログには出さない。
 * 短すぎる値まで置換すると無関係な文字列を壊すため、8文字以上のときだけ働く。
 */
export function redactToken(text: string, token: string): string {
  if (!token || token.length < 8) return text;
  return text.replaceAll(token, "***");
}

/** ベース URL とパスを繋ぐ（末尾スラッシュの有無を吸収する） */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return base + suffix;
}

/** ボードの API クライアント。**トークンは Authorization ヘッダー以外に載せない** */
export class BoardClient {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(config: BoardConfig, fetchLike: FetchLike, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.#url = config.url;
    this.#token = config.token;
    this.#fetch = fetchLike;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * 1リクエストを投げる。
   *
   * タイムアウトは `AbortController` + `setTimeout` で自前に持ち、**本文の読み取りまで含めた
   * 全体の期限**にしてある（応答ヘッダーだけ返して本文が来ない相手でも待ち続けないため）。
   * タイマーは必ず `finally` で解除する（テストや常駐利用でタイマーを残さない）。
   */
  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("timeout", "TimeoutError")),
      this.#timeoutMs,
    );
    try {
      return await this.#send<T>(method, path, body, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async #send<T>(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.#fetch(joinUrl(this.#url, path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      const reason = name === "TimeoutError"
        ? `応答がありません（${this.#timeoutMs}ms で打ち切り）`
        : redactToken(e instanceof Error ? e.message : String(e), this.#token);
      throw new BoardUnreachableError(reason);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const text = await res.text();
        const parsed = safeJsonParse(text);
        detail = typeof (parsed as { error?: unknown })?.error === "string"
          ? (parsed as { error: string }).error
          : text.slice(0, 200);
      } catch {
        detail = "";
      }
      const hint = res.status === 401 || res.status === 403
        ? `${ENV_TOKEN} が正しいか確認してください（値は表示しません）。`
        : "";
      const message = [`ボードが ${res.status} を返しました`, detail, hint]
        .filter((s) => s !== "").join(" / ");
      throw new BoardApiError(res.status, redactToken(message, this.#token));
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new BoardUnreachableError(
        redactToken(e instanceof Error ? e.message : String(e), this.#token),
      );
    }
    const parsed = safeJsonParse(text);
    if (parsed === undefined) {
      throw new BoardApiError(res.status, "ボードの応答を JSON として解釈できませんでした。");
    }
    return parsed as T;
  }

  listClaims(): Promise<ClaimListResponse> {
    return this.#request<ClaimListResponse>("GET", "/api/claims");
  }

  createClaim(req: ClaimCreateRequest): Promise<ClaimResponse> {
    return this.#request<ClaimResponse>("POST", "/api/claims", req);
  }

  updateClaim(id: string, req: ClaimUpdateRequest): Promise<ClaimResponse> {
    return this.#request<ClaimResponse>("PATCH", `/api/claims/${encodeURIComponent(id)}`, req);
  }

  checkPaths(paths: readonly string[]): Promise<ClaimCheckResponse> {
    const query = `?paths=${encodeURIComponent(paths.join(","))}`;
    return this.#request<ClaimCheckResponse>("GET", `/api/claims/check${query}`);
  }

  listTasks(): Promise<TaskListResponse> {
    return this.#request<TaskListResponse>("GET", "/api/tasks");
  }

  createTask(req: TaskCreateRequest): Promise<TaskResponse> {
    return this.#request<TaskResponse>("POST", "/api/tasks", req);
  }

  updateTask(id: string, req: TaskUpdateRequest): Promise<TaskResponse> {
    return this.#request<TaskResponse>("PATCH", `/api/tasks/${encodeURIComponent(id)}`, req);
  }
}

/** JSON として読めなければ undefined を返す（例外を投げない） */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 表示の整形
// ---------------------------------------------------------------------------

/** 表明の状態の日本語表記 */
export function claimStatusLabel(status: ClaimStatus): string {
  switch (status) {
    case "working":
      return "作業中";
    case "paused":
      return "中断";
    case "done":
      return "完了";
  }
}

/** タスクの状態の日本語表記 */
export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "open":
      return "未着手";
    case "doing":
      return "着手中";
    case "done":
      return "完了";
  }
}

/** 経過時間を「12分前」のように読める形にする */
export function formatAge(deltaMs: number): string {
  if (!Number.isFinite(deltaMs)) return "時刻不明";
  const ms = Math.max(0, deltaMs);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

/** epoch ms を `YYYY-MM-DD HH:mm`（ローカル時刻）にする */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return "時刻不明";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 長い一覧を「, ほかN件」に畳む */
export function truncateList(values: readonly string[], max = PATHS_DISPLAY_MAX): string {
  if (values.length === 0) return "";
  if (values.length <= max) return values.join(", ");
  return `${values.slice(0, max).join(", ")}, ほか${values.length - max}件`;
}

/** 表明1件を複数行に整形する */
export function formatClaim(claim: ClaimView, now: number): string[] {
  const status = claim.stale && claim.status === "working"
    ? `${claimStatusLabel(claim.status)}・古い`
    : claimStatusLabel(claim.status);
  const lines = [
    `- [${status}] ${claim.memberName}: ${claim.title} (${formatAge(now - claim.heartbeatAt)})`,
  ];
  const meta: string[] = [];
  if (claim.branch) meta.push(`ブランチ ${claim.branch}`);
  if (typeof claim.prNumber === "number") meta.push(`PR #${claim.prNumber}`);
  if (meta.length > 0) lines.push(`    ${meta.join(" / ")}`);
  if (claim.paths && claim.paths.length > 0) lines.push(`    パス: ${truncateList(claim.paths)}`);
  if (claim.note) lines.push(`    メモ: ${claim.note}`);
  return lines;
}

/** 表明を「作業中 → 中断 → 完了」の順、同順位は新しい順に並べる */
export function sortClaims(claims: readonly ClaimView[]): ClaimView[] {
  const rank: Record<ClaimStatus, number> = { working: 0, paused: 1, done: 2 };
  return [...claims].sort((a, b) =>
    rank[a.status] - rank[b.status] || b.heartbeatAt - a.heartbeatAt
  );
}

/** `list` の出力を作る */
export function formatClaimList(res: ClaimListResponse, now: number): string {
  const claims = sortClaims(res.claims);
  if (claims.length === 0) {
    return "== 作業ボード: 現在の表明 ==\n表明はありません。着手前に board.ts claim で表明してください。";
  }
  const lines = [`== 作業ボード: 現在の表明 (${claims.length}件) ==`];
  for (const claim of claims) lines.push(...formatClaim(claim, now));
  const stale = claims.filter((c) => c.stale && c.status === "working").length;
  if (stale > 0) {
    lines.push(`※ 「古い」表明が ${stale}件 あります（8時間以上更新なし）。放置かもしれません。`);
  }
  return lines.join("\n");
}

/** PR 索引1件を1行に整形する */
export function formatPr(pr: PrIndex): string {
  const files = truncateList(pr.files, 5);
  return `- PR #${pr.prNumber} ${pr.title} (${pr.author} / ${pr.headRef})` +
    (files === "" ? "" : `\n    ファイル: ${files}`);
}

/** `check` の出力を作る。`claimed` は「このセッションで表明済みか」 */
export function formatCheck(
  res: ClaimCheckResponse,
  claimed: boolean | undefined,
  now: number,
): string {
  const lines = [`== 重なりの確認 ==`, `対象: ${truncateList(res.paths)}`];
  if (claimed === false) {
    lines.push("! このセッションの表明がありません。board.ts claim で表明してください。");
  }
  if (res.claims.length === 0 && res.prs.length === 0) {
    lines.push("重なる表明・オープン PR はありません。");
    return lines.join("\n");
  }
  if (res.claims.length > 0) {
    lines.push(`! 他のメンバーの表明と重なります (${res.claims.length}件)`);
    for (const claim of sortClaims(res.claims)) lines.push(...formatClaim(claim, now));
  }
  if (res.prs.length > 0) {
    const at = res.prsFetchedAt === null
      ? "取得できていません"
      : `${formatTimestamp(res.prsFetchedAt)} 時点`;
    lines.push(`! 同じファイルを触るオープン PR があります (${res.prs.length}件 / ${at})`);
    for (const pr of res.prs) lines.push(formatPr(pr));
  }
  lines.push("※ 重なりは警告のみです。分担済みなら、そのまま進めて構いません。");
  return lines.join("\n");
}

/** タスク一覧の出力を作る */
export function formatTaskList(res: TaskListResponse): string {
  const rank: Record<TaskStatus, number> = { doing: 0, open: 1, done: 2 };
  const tasks = [...res.tasks].sort((a, b) =>
    rank[a.status] - rank[b.status] || b.createdAt - a.createdAt
  );
  if (tasks.length === 0) return "== 作業ボード: タスク ==\nタスクはありません。";
  const lines = [`== 作業ボード: タスク (${tasks.length}件) ==`];
  for (const task of tasks) {
    lines.push(`- [${taskStatusLabel(task.status)}] ${task.id}  ${task.title}`);
    const meta: string[] = [];
    if (task.assignee) meta.push(`担当 ${task.assignee}`);
    if (task.body) meta.push(task.body);
    if (meta.length > 0) lines.push(`    ${meta.join(" / ")}`);
  }
  return lines.join("\n");
}

/**
 * 表明の一覧から「このセッションの自分の表明」を探す。
 *
 * `sessionId` は Claude Code のセッション識別子で、実質的に一意。
 * 作業中を優先し、同順位なら新しいものを採る（完了済みは対象外）。
 */
export function findOwnClaim(
  claims: readonly ClaimView[],
  sessionId: string,
): ClaimView | undefined {
  const mine = claims.filter((c) => c.sessionId === sessionId && c.status !== "done");
  return sortClaims(mine)[0];
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

/**
 * CLI の実行結果。`--json` のときはこれをそのまま出力する。
 * フック（PowerShell）は `claimed` と `message` だけ見れば済むようにしてある。
 */
export type CliResult = {
  /** 目的を果たせたか */
  ok: boolean;
  /** ボードに到達できたか（false ならフックは素通りする） */
  reachable: boolean;
  /** `.env` の設定が揃っているか */
  configured: boolean;
  /** 人間向けの本文（複数行） */
  message: string;
  /** `check` のときのみ: このセッションで表明済みか */
  claimed?: boolean;
  /**
   * `check` のときのみ: 重なりの件数。
   * フック（PowerShell）が `message` を解析せずに「警告を出すか」を決められるようにする。
   */
  overlaps?: { claims: number; prs: number };
  /** 失敗した理由（ok=false のとき） */
  error?: string;
};

/** 入出力の差し替え口（テストは文字列を集める） */
export type Io = { out: (text: string) => void; err: (text: string) => void };

/** `runCli` に渡す依存 */
export type RunDeps = {
  argv: readonly string[];
  env: EnvLike;
  fileEnv: Record<string, string>;
  fetch: FetchLike;
  now: () => number;
  io: Io;
};

/** ヘルプ本文 */
export const HELP = `作業ボード CLI （docs/design/board.md）

使い方: deno run --allow-net --allow-read --allow-env tools/board/board.ts <コマンド>

  claim <title>        これから作るものを表明する
      --paths a,b        触る予定のファイル・ディレクトリ（重なり検出に使う）
      --branch <name>    作業ブランチ名
      --pr <number>      対応する PR 番号
      --note <text>      補足
  list                 現在の表明一覧を表示する
  check <paths...>     指定パスに重なる表明・オープン PR を確認する
  done                 自分の表明を完了にする（--paused で中断にする）
  task add <title>     タスクを追加する（--body / --assignee）
  task list            タスク一覧
  task done <id>       タスクを完了にする

共通オプション:
  --session <id>       セッション識別子（フックが hook 入力の session_id を渡す）
  --json               JSON で出力する（フック用）
  --timeout <ms>       応答待ちの上限（既定 ${DEFAULT_TIMEOUT_MS}ms）
  -h, --help           このヘルプ

接続先は tools/board/.env の ${ENV_URL} / ${ENV_TOKEN} から読む
（tools/board/.env.example を参照。トークンは各自が管理し、git に入れないこと）。
${SECRET_WARNING}
ボードに繋がらないときは警告だけ出して終了コード 0 で終わる（作業を止めないため）。`;

/** サブコマンドを実行する。到達できなければ `BoardUnreachableError` が飛ぶ */
async function runCommand(
  command: Command,
  sessionId: string,
  client: BoardClient,
  now: () => number,
): Promise<CliResult> {
  const base = { ok: true, reachable: true, configured: true } as const;
  switch (command.kind) {
    case "help":
      return { ...base, message: HELP };

    case "claim": {
      const req: ClaimCreateRequest = { sessionId, title: command.title };
      if (command.paths.length > 0) req.paths = command.paths;
      if (command.branch) req.branch = command.branch;
      if (command.prNumber !== undefined) req.prNumber = command.prNumber;
      if (command.note) req.note = command.note;
      const res = await client.createClaim(req);
      const lines = ["表明しました。", ...formatClaim(res.claim, now())];
      if (command.paths.length > 0) {
        const check = await client.checkPaths(command.paths);
        if (check.claims.length > 0 || check.prs.length > 0) {
          lines.push(formatCheck(check, true, now()));
        }
      }
      return { ...base, message: lines.join("\n") };
    }

    case "list": {
      const res = await client.listClaims();
      return { ...base, message: formatClaimList(res, res.serverTime || now()) };
    }

    case "check": {
      const list = await client.listClaims();
      const own = findOwnClaim(list.claims, sessionId);
      const res = await client.checkPaths(command.paths);
      return {
        ...base,
        claimed: own !== undefined,
        overlaps: { claims: res.claims.length, prs: res.prs.length },
        message: formatCheck(res, own !== undefined, res.serverTime || now()),
      };
    }

    case "done": {
      const list = await client.listClaims();
      const own = findOwnClaim(list.claims, sessionId);
      if (!own) {
        return { ...base, message: "このセッションの表明は見つかりませんでした（変更なし）。" };
      }
      const res = await client.updateClaim(own.id, { status: command.status });
      return {
        ...base,
        message: `表明を「${claimStatusLabel(res.claim.status)}」にしました: ${res.claim.title}`,
      };
    }

    case "task-add": {
      const req: TaskCreateRequest = { title: command.title, body: command.body };
      if (command.assignee) req.assignee = command.assignee;
      const res = await client.createTask(req);
      return { ...base, message: `タスクを追加しました: ${res.task.id}  ${res.task.title}` };
    }

    case "task-list":
      return { ...base, message: formatTaskList(await client.listTasks()) };

    case "task-done": {
      const req: TaskUpdateRequest = { status: "done" };
      const res = await client.updateTask(command.id, req);
      return { ...base, message: `タスクを完了にしました: ${res.task.id}  ${res.task.title}` };
    }
  }
}

/**
 * CLI 本体。**終了コードを返す**（プロセスは呼び出し側で終える）。
 *
 *   0 … 成功、ボードに繋がらない、未設定（**作業を止めないため**、§8）
 *   1 … 使い方の誤り、ボードがエラー応答を返した
 */
export async function runCli(deps: RunDeps): Promise<number> {
  const parsed = parseArgs(deps.argv);
  if (!parsed.ok) {
    deps.io.err(`${parsed.message}\n\n${HELP}`);
    return 1;
  }
  const { command, options } = parsed;

  const emit = (result: CliResult, code: number): number => {
    if (options.json) deps.io.out(JSON.stringify(result));
    else if (result.ok) deps.io.out(result.message);
    else deps.io.err(result.message);
    return code;
  };

  if (command.kind === "help") {
    return emit({ ok: true, reachable: false, configured: true, message: HELP }, 0);
  }

  const config = resolveConfig(deps.fileEnv, deps.env);
  if (!config.ok) {
    return emit({
      ok: false,
      reachable: false,
      configured: false,
      message: `作業ボードは未設定です。${config.message}`,
      error: config.message,
    }, 0);
  }

  const client = new BoardClient(config.config, deps.fetch, options.timeoutMs);
  const sessionId = resolveSessionId(options.sessionId, deps.env);
  try {
    return emit(await runCommand(command, sessionId, client, deps.now), 0);
  } catch (e) {
    if (e instanceof BoardUnreachableError) {
      return emit({
        ok: false,
        reachable: false,
        configured: true,
        message: `作業ボードに繋がりませんでした（${e.message}）。作業は止めずに続けて構いません。`,
        error: e.message,
      }, 0);
    }
    if (e instanceof BoardApiError) {
      return emit({
        ok: false,
        reachable: true,
        configured: true,
        message: e.message,
        error: e.message,
      }, 1);
    }
    const message = e instanceof Error ? e.message : String(e);
    return emit({
      ok: false,
      reachable: true,
      configured: true,
      message: `予期しないエラー: ${message}`,
      error: message,
    }, 1);
  }
}

/**
 * `tools/board/.env` の絶対パス（このファイルの隣）。
 * カレントディレクトリに依存させない（フックはどこから呼ばれるか分からないため）。
 */
export function defaultEnvPath(): string {
  return fromFileUrl(new URL("./.env", import.meta.url));
}

if (import.meta.main) {
  const code = await runCli({
    argv: Deno.args,
    env: Deno.env,
    fileEnv: readEnvFile(defaultEnvPath()),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    io: {
      out: (text) => console.log(text),
      err: (text) => console.error(text),
    },
  });
  Deno.exit(code);
}
