/**
 * 作業ボード（board）のサーバー本体（docs/design/board.md §6 / §7 / §9 / §10）
 *
 * EN 本体（`server/`）とは完全に独立させる（§3）。同じリポジトリに置くが、プロセスも
 * ポートも KV も別で、`server/` からは何も import しない。
 *
 * 提供する口（`/api/*` はすべて `Authorization: Bearer <token>` 必須、§6 / §7-6）:
 *
 *   GET    /api/claims             表明の一覧
 *   POST   /api/claims             表明の作成（1セッション1表明）
 *   PATCH  /api/claims/:id         表明の更新（heartbeat / status）
 *   GET    /api/claims/check       指定パスに重なる「他人の表明」とオープン PR
 *   GET    /api/tasks              タスクの一覧
 *   POST   /api/tasks              タスクの作成
 *   PATCH  /api/tasks/:id          タスクの更新
 *   GET    /api/prs                PR 索引（キャッシュ）
 *   POST   /api/messages           **未実装**（501。github.ts にコメント投稿が無いため）
 *   GET    /                       画面のシェル HTML。**ここだけ認証を求めない**（§7-6）
 *
 * `GET /` を無認証にしてある理由（§7-6）:
 *   ブラウザはトップレベルのページ遷移に `Authorization` ヘッダーを付けられない。
 *   画面まで認証必須にすると「トークンを入力する画面」自体に到達できず、
 *   **誰も画面を開けない**。そこで `public/index.html` を「情報を持たないシェル」に保ち、
 *   シェルだけ無認証で配る。表明・タスク・PR・あだ名といった中身は例外なく
 *   認証付きの `/api/*` から取り、トークンは画面が `sessionStorage` に持つ。
 *   **シェルにデータを埋め込まないことが、この判断の前提条件**（tools/board/server_test.ts が見張る）。
 *
 * 守っていること:
 *   - `/api/*` と、それ以外の未知のパスはすべてトークン認証（緩めているのは `GET /` だけ、§7-6）
 *   - 自由文（title / note / タスクの title / body）の秘密検出（§7-7）
 *   - リクエストボディのサイズ上限（§7-8）。ストリームを読みながら打ち切る
 *   - CORS は許可しない（`access-control-allow-*` を一切返さない、§7-8）
 *   - すべての応答を `cache-control: no-store` にする
 *   - **トークンとそのハッシュを応答にもログにも出さない**（§7-4）。
 *     ログに出すのは「どのメンバーが・いつ・どの API を」まで
 */

import { BoardAuth, containsSecretLike } from "./auth.ts";
import { BoardGitHubClient, type PrIndex as GitHubPrIndex, resolveGitHubToken } from "./github.ts";
import {
  BOARD_REQUEST_BODY_MAX_BYTES,
  type Claim,
  CLAIM_TTL_MS,
  type ClaimCheckResponse,
  type ClaimListResponse,
  type ClaimResponse,
  type ClaimStatus,
  type ClaimView,
  KV_PREFIX,
  PR_INDEX_REFRESH_MS,
  type PrIndex,
  type PrListResponse,
  type Task,
  type TaskListResponse,
  type TaskResponse,
  type TaskStatus,
} from "./types.ts";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/**
 * PR 索引の「最後に取得できた時刻」を置く KV キー。
 *
 * `types.ts` の `KV_PREFIX` に足さずここに置いてあるのは、あちらが共有の契約
 * （型定義）であり、サーバー内部の都合で増やす置き場所ではないため。
 * §10 の撤去は KV ファイルごと削除するので、キーが1本増えても手順は変わらない。
 */
export const KV_PR_INDEX_META_KEY: readonly string[] = ["boardPrIndexMeta"];

/**
 * `sessionId` → `claimId` の索引（§4「1セッション1表明」）。
 * 全表明を走査しても件数的には足りるが、同時に2回 POST が来たときに
 * 原子的に弾くために索引を持つ（`atomic().check({ versionstamp: null })`）。
 */
export const KV_CLAIM_SESSION_PREFIX = "boardClaimSession";

/** 自由文の上限（文字数）。設計書に具体値の指定が無いため、実用上十分な値を置いた */
export const TITLE_MAX = 200;
export const NOTE_MAX = 2000;
export const TASK_BODY_MAX = 4000;
export const BRANCH_MAX = 200;
export const SESSION_ID_MAX = 200;
export const ASSIGNEE_MAX = 100;
/** 1つの表明に書けるパスの本数と、1本あたりの長さ */
export const PATHS_MAX = 100;
export const PATH_MAX = 500;
/** `/api/claims/check` に一度に渡せるパスの本数 */
export const CHECK_PATHS_MAX = 200;

/** PR 番号として受け付ける上限（桁あふれや不正値を弾くだけの緩い上限） */
const PR_NUMBER_MAX = 1_000_000;

/**
 * 応答に付けるセキュリティヘッダ。`server/main.ts` の SECURITY_HEADERS と同じ流儀。
 * **CORS のヘッダは1つも含めない**（§7-8「CORS は許可しない」）。
 *
 * これは **JSON の応答用**。画面（HTML）には下の HTML_SECURITY_HEADERS を使う。
 */
const SECURITY_HEADERS: ReadonlyArray<[string, string]> = [
  [
    "content-security-policy",
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
    ].join("; "),
  ],
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "no-referrer"],
  // 画面もチームの内部情報なので、検索・キャッシュのどちらにも残さない
  ["cache-control", "no-store"],
];

/**
 * 画面のシェル HTML（`GET /`）に付けるセキュリティヘッダ。流儀は SECURITY_HEADERS と同じ
 * （CORS のヘッダは1つも含めない・`cache-control: no-store` は維持）だが、CSP だけ別にする。
 *
 * シェルは**無認証で誰にでも配る**ので、JSON より締める。`public/index.html` の
 * `<meta http-equiv="Content-Security-Policy">` と同じ内容を、**ヘッダー側にも**張る
 * （meta は `frame-ancestors` を無視する仕様があり、クリックジャッキング対策は
 * ヘッダーでしか効かない。逆に meta 側は、ファイルを直接開いたときの保険として残す）。
 *
 * - `default-src 'none'`: 外部からは何も読み込ませない
 * - `connect-src 'self'`: 画面が叩くのは同一オリジンの `/api/*` だけ
 * - `script-src 'sha256-…'`: index.html のインライン `<script>` **1本だけ**を許す。
 *   **index.html のスクリプトを1文字でも変えたら、この値も index.html の meta も
 *   更新すること。** tools/board/ui_test.ts がハッシュを、tools/board/server_test.ts が
 *   「ヘッダーと meta が一致していること」を見張っていて、ずれると失敗する
 * - `style-src 'unsafe-inline'`: 見た目を1ファイルに収める都合（EN 本体の流儀に揃える）
 * - `frame-ancestors 'none'` / `base-uri 'none'` / `form-action 'none'`
 */
const HTML_SECURITY_HEADERS: ReadonlyArray<[string, string]> = [
  [
    "content-security-policy",
    [
      "default-src 'none'",
      "connect-src 'self'",
      "style-src 'unsafe-inline'",
      "script-src 'sha256-G5bK6EgVQu9/YPcy6TlKfemSESkUsTYVzHdoUkKx210='",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  ],
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "no-referrer"],
  // シェル自体は誰でも取れるが、共用 PC の履歴やプロキシに残さない
  ["cache-control", "no-store"],
];

// ---------------------------------------------------------------------------
// 応答の組み立て
// ---------------------------------------------------------------------------

/** 共通ヘッダを載せた Response を作る */
function respond(
  body: BodyInit | null,
  status: number,
  contentType: string,
  securityHeaders: ReadonlyArray<[string, string]> = SECURITY_HEADERS,
): Response {
  const headers = new Headers({ "content-type": contentType });
  for (const [key, value] of securityHeaders) headers.set(key, value);
  return new Response(body, { status, headers });
}

/** JSON 応答 */
export function jsonResponse(value: unknown, status = 200): Response {
  return respond(JSON.stringify(value), status, "application/json; charset=utf-8");
}

/**
 * JSON のエラー応答（`BoardErrorResponse`）。
 * **メッセージに入力値をそのまま載せない。** トークンを打ち間違えた文字列や、
 * 秘密が混ざった自由文をそのまま返すと、それ自体が漏洩経路になるため（§7-4）。
 */
export function jsonError(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * ルーティングに使うパス。末尾のスラッシュを落とし、空になったら `/` に戻す。
 * **認証の分岐（`GET /`）とルーティングで同じ値を使う**ため、1か所に切り出してある
 * （片方だけ `/` を `//` と別物に見てしまうと、認証を迂回する穴になりかねない）。
 */
function routePath(url: URL): string {
  const trimmed = url.pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** 405。許可メソッドを添える */
function methodNotAllowed(allow: string): Response {
  const res = jsonError(405, "このパスでは使えないメソッドです");
  const headers = new Headers(res.headers);
  headers.set("allow", allow);
  return new Response(res.body, { status: res.status, headers });
}

// ---------------------------------------------------------------------------
// ULID
// ---------------------------------------------------------------------------

/** Crockford base32（`I` `L` `O` `U` を除く32文字） */
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * ULID を生成する（§4 の `id`）。
 * 先頭10文字が48ビットのミリ秒時刻、続く16文字が80ビットの乱数。
 * 乱数は `crypto.getRandomValues` の1バイトを32で割った余りで取るが、
 * 256 は 32 の倍数なので偏りは生じない。
 */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let rest = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = ULID_ALPHABET[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let random = "";
  for (let i = 0; i < 16; i++) random += ULID_ALPHABET[bytes[i] % 32];
  return time + random;
}

// ---------------------------------------------------------------------------
// パスの正規化と重なり判定（§6「フックの中核」）
// ---------------------------------------------------------------------------

/**
 * パスを比較できる形に正規化する。比較の土台なので、ここが甘いと重なりを取り逃がす。
 *
 *   - 区切り文字を `/` に統一する（Windows のメンバーは `\` で渡してくる）
 *   - 連続した区切りを1つに畳む（`public//app.js` → `public/app.js`）
 *   - 先頭の `/` と、`.` / `..` の段を解決する（`./public/` → `public`、`a/b/../c` → `a/c`）
 *   - 末尾の `/` を落とす（`public/` と `public` を同じものとして扱うため）
 *   - 前後の空白を落とす
 *
 * 正規化した結果が空（`""` / `.` / `/` のようにリポジトリ全体を指すもの）になった場合は
 * `null` を返す。**「全体」を1本のパスとして扱うと、そのパスを書いた表明が他の全員の
 * 作業と重なってしまい、警告が意味を成さなくなる**ため、重なり判定からは外す。
 *
 * 大文字小文字は区別する（GitHub 上のパスがそう扱われるため）。Windows のファイル
 * システムでは `Public/` と `public/` が同じ物を指すが、正本である git の扱いに合わせた。
 */
export function normalizePath(raw: string): string | null {
  const unified = raw.trim().replace(/\\/g, "/");
  if (unified === "") return null;
  const out: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // ルートを越える `..`（例: `../../etc/passwd`）は、リポジトリ内の別のパスに
      // 化けて誤検出のもとになるので、正規化不能として捨てる
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  if (out.length === 0) return null;
  return out.join("/");
}

/**
 * 正規化済みの2つのパスが重なるかを判定する。
 *
 *   - 完全一致（`public/app.js` と `public/app.js`）
 *   - 一方がもう一方のディレクトリ（`public` と `public/app.js`）
 *
 * ディレクトリ判定は必ず区切り文字まで含めて比べる。`startsWith("public")` だけだと
 * `publicity.md` のような別物まで拾ってしまうため、`public/` で比べる。
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (b.startsWith(a + "/")) return true;
  if (a.startsWith(b + "/")) return true;
  return false;
}

/** 正規化済みのパス集合どうしが1本でも重なるか */
export function anyPathOverlaps(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (pathsOverlap(x, y)) return true;
    }
  }
  return false;
}

/** 生のパス列を正規化し、空になったものを捨てて重複を除く */
export function normalizePaths(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const path = normalizePath(item);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 入力の検証
// ---------------------------------------------------------------------------

/**
 * 制御文字を含むか（1行の自由文で使う）。改行・タブも許さない。
 * 正規表現に制御文字を直接書くとソースに見えない文字が混ざるので、符号位置で判定する。
 */
function hasControlChar(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 改行・タブ以外の制御文字を含むか（複数行を許す自由文で使う） */
function hasForbiddenControlChar(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 検証の失敗。呼び出し側はこのメッセージをそのまま 400 で返す */
type Invalid = { ok: false; message: string };
type Valid<T> = { ok: true; value: T };
type Checked<T> = Valid<T> | Invalid;

/**
 * 1行の自由文を検証する。**秘密らしき文字列を含むものは拒否する**（§7-7）。
 * 拒否のメッセージに入力値は載せない。
 */
function checkLine(
  value: unknown,
  label: string,
  max: number,
  options: { required: boolean },
): Checked<string | undefined> {
  if (value === undefined || value === null) {
    if (options.required) return { ok: false, message: `${label}を指定してください` };
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string") {
    return { ok: false, message: `${label}は文字列で指定してください` };
  }
  const trimmed = value.trim();
  if (options.required && trimmed === "") {
    return { ok: false, message: `${label}を指定してください` };
  }
  if ([...trimmed].length > max) {
    return { ok: false, message: `${label}は${max}文字以内で指定してください` };
  }
  if (hasControlChar(trimmed)) {
    return { ok: false, message: `${label}に制御文字は使えません` };
  }
  if (containsSecretLike(trimmed)) {
    return {
      ok: false,
      message: `${label}にトークンらしき文字列が含まれています（秘密情報は書かないでください）`,
    };
  }
  return { ok: true, value: trimmed };
}

/** 複数行を許す自由文（note / タスクの body）。改行とタブだけ通す */
function checkText(
  value: unknown,
  label: string,
  max: number,
  options: { required: boolean },
): Checked<string | undefined> {
  if (value === undefined || value === null) {
    if (options.required) return { ok: false, message: `${label}を指定してください` };
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string") {
    return { ok: false, message: `${label}は文字列で指定してください` };
  }
  const trimmed = value.trim();
  if (options.required && trimmed === "") {
    return { ok: false, message: `${label}を指定してください` };
  }
  if ([...trimmed].length > max) {
    return { ok: false, message: `${label}は${max}文字以内で指定してください` };
  }
  if (hasForbiddenControlChar(trimmed)) {
    return { ok: false, message: `${label}に制御文字は使えません` };
  }
  if (containsSecretLike(trimmed)) {
    return {
      ok: false,
      message: `${label}にトークンらしき文字列が含まれています（秘密情報は書かないでください）`,
    };
  }
  return { ok: true, value: trimmed };
}

/** `paths` を検証して正規化する */
/**
 * マシン固有の絶対パスか（ドライブレター `C:` / UNC `\\`）。
 *
 * `paths` の契約は「リポジトリルートからの相対パス」（types.ts）だが、フックが
 * Claude Code のツール入力（絶対パス）を相対化せずそのまま送ると、表明どうしが
 * **絶対に重ならなくなり、しかも 200 が返るので誰も気づかない**。黙って空振りする
 * より、ここで拒否して「相対化していない」ことを呼び出し側に気づかせる。
 * POSIX の先頭 `/`（例: `/public/app.js`）はリポジトリルート相対の書き方として
 * 通す（normalizePath が先頭の `/` を落とす）。マシンの絶対パスと区別できないため、
 * 機械的に見分けられる Windows 形式だけを弾く。
 */
function isMachineAbsolutePath(raw: string): boolean {
  const t = raw.trimStart();
  return /^[A-Za-z]:[\\/]/.test(t) || t.startsWith("\\\\") || t.startsWith("//");
}

function checkPaths(value: unknown): Checked<string[] | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!Array.isArray(value)) return { ok: false, message: "paths は配列で指定してください" };
  if (value.length > PATHS_MAX) {
    return { ok: false, message: `paths は${PATHS_MAX}件以内で指定してください` };
  }
  for (const item of value) {
    if (typeof item !== "string") {
      return { ok: false, message: "paths の要素は文字列で指定してください" };
    }
    if ([...item].length > PATH_MAX) {
      return { ok: false, message: `paths の要素は${PATH_MAX}文字以内で指定してください` };
    }
    if (hasControlChar(item)) {
      return { ok: false, message: "paths に制御文字は使えません" };
    }
    if (isMachineAbsolutePath(item)) {
      return {
        ok: false,
        message:
          "paths は絶対パスではなく、リポジトリルートからの相対パスで指定してください（例: public/app.js）",
      };
    }
    if (containsSecretLike(item)) {
      return {
        ok: false,
        message: "paths にトークンらしき文字列が含まれています（秘密情報は書かないでください）",
      };
    }
  }
  return { ok: true, value: normalizePaths(value as string[]) };
}

/** `prNumber` を検証する */
function checkPrNumber(value: unknown): Checked<number | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, message: "prNumber は整数で指定してください" };
  }
  if (value < 1 || value > PR_NUMBER_MAX) {
    return { ok: false, message: "prNumber が範囲外です" };
  }
  return { ok: true, value };
}

const CLAIM_STATUSES: ReadonlySet<string> = new Set(["working", "paused", "done"]);
const TASK_STATUSES: ReadonlySet<string> = new Set(["open", "doing", "done"]);

/** 表明の状態を検証する */
function checkClaimStatus(value: unknown): Checked<ClaimStatus | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string" || !CLAIM_STATUSES.has(value)) {
    return { ok: false, message: "status は working / paused / done のいずれかです" };
  }
  return { ok: true, value: value as ClaimStatus };
}

/** タスクの状態を検証する */
function checkTaskStatus(value: unknown): Checked<TaskStatus | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string" || !TASK_STATUSES.has(value)) {
    return { ok: false, message: "status は open / doing / done のいずれかです" };
  }
  return { ok: true, value: value as TaskStatus };
}

// ---------------------------------------------------------------------------
// リクエストボディ
// ---------------------------------------------------------------------------

/**
 * ボディを上限まで読む（§7-8「リクエストボディのサイズ上限を設ける」）。
 *
 * `content-length` を見るだけでは足りない（chunked で送られると値が無い）ので、
 * **ストリームを読みながら合計を数え、超えた時点で打ち切る**。上限を超えたら `null`。
 */
async function readLimitedBody(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > max) return null;
  }
  if (req.body === null) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** JSON のオブジェクトとしてボディを読む。失敗時は返す Response をそのまま返す */
async function readJsonObject(
  req: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; res: Response }> {
  const bytes = await readLimitedBody(req, BOARD_REQUEST_BODY_MAX_BYTES);
  if (bytes === null) {
    return {
      ok: false,
      res: jsonError(413, `リクエストが大きすぎます（${BOARD_REQUEST_BODY_MAX_BYTES}バイトまで）`),
    };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, res: jsonError(400, "リクエストの本文がありません") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, res: jsonError(400, "リクエストの形式が正しくありません") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, res: jsonError(400, "リクエストの形式が正しくありません") };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// PR 索引のキャッシュ（§9）
// ---------------------------------------------------------------------------

/** KV に置く「最後の取得」の記録 */
type PrIndexMeta = {
  /** 最後に**成功した**取得の時刻（epoch ms）。一度も成功していなければ null */
  fetchedAt: number | null;
  /** 最後に取得を**試みた**時刻（epoch ms）。失敗の連打を避けるために使う */
  attemptedAt: number;
};

/**
 * オープン PR の索引を KV にキャッシュし、`PR_INDEX_REFRESH_MS` 間隔で取り直す（§9）。
 *
 * **リクエストのたびに GitHub を叩かない**（§4）。取得に失敗したときは古いキャッシュを
 * そのまま返し、`fetchedAt` で「いつ時点か」を示す。失敗しても古い索引は消さない。
 */
export class PrIndexCache {
  #kv: Deno.Kv;
  #client: BoardGitHubClient | null;
  #refreshMs: number;
  #now: () => number;
  /** 進行中の取得。同時に複数のリクエストが来ても GitHub を叩くのは1回だけにする */
  #inflight: Promise<void> | null = null;

  constructor(options: {
    kv: Deno.Kv;
    client?: BoardGitHubClient | null;
    refreshMs?: number;
    now?: () => number;
  }) {
    this.#kv = options.kv;
    this.#client = options.client ?? null;
    this.#refreshMs = options.refreshMs ?? PR_INDEX_REFRESH_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** KV に入っている索引をそのまま読む（GitHub は叩かない） */
  async read(): Promise<{ prs: PrIndex[]; fetchedAt: number | null }> {
    const prs: PrIndex[] = [];
    for await (const entry of this.#kv.list<PrIndex>({ prefix: [KV_PREFIX.prIndex] })) {
      prs.push(entry.value);
    }
    prs.sort((a, b) => a.prNumber - b.prNumber);
    const meta = await this.#kv.get<PrIndexMeta>(KV_PR_INDEX_META_KEY);
    return { prs, fetchedAt: meta.value?.fetchedAt ?? null };
  }

  /**
   * 必要なら GitHub から取り直す。**失敗しても例外を投げない**（古いキャッシュで続行する）。
   * 取得を試みた事実は記録し、失敗の直後に何度も叩きにいかないようにする。
   */
  async refreshIfDue(): Promise<void> {
    if (this.#client === null) return;
    try {
      const meta = await this.#kv.get<PrIndexMeta>(KV_PR_INDEX_META_KEY);
      const attemptedAt = meta.value?.attemptedAt ?? null;
      if (attemptedAt !== null && this.#now() - attemptedAt < this.#refreshMs) return;
      await this.refresh();
    } catch {
      // PR 索引は補助情報。KV の異常でリクエストを 500 に落とさない
    }
  }

  /**
   * GitHub から取り直して KV を入れ替える。**失敗しても例外を投げない**。
   * 同時呼び出しは1本にまとめる。
   */
  refresh(): Promise<void> {
    if (this.#inflight !== null) return this.#inflight;
    const task = this.#refreshOnce().finally(() => {
      this.#inflight = null;
    });
    this.#inflight = task;
    return task;
  }

  async #refreshOnce(): Promise<void> {
    const client = this.#client;
    if (client === null) return;
    const startedAt = this.#now();
    let fetched: GitHubPrIndex[];
    try {
      fetched = await client.buildPrIndex(new Date(startedAt));
    } catch {
      // 失敗の理由は握りつぶす。**例外メッセージを記録しない**のは、そこに URL や
      // 本文の断片が載りうるため（§7-4）。古いキャッシュのまま続行するのが §9 の方針。
      await this.#markAttempt(startedAt);
      return;
    }
    const fetchedAt = this.#now();
    const alive = new Set<number>();
    let complete = true;
    try {
      for (const pr of fetched) {
        alive.add(pr.prNumber);
        const value: PrIndex = {
          prNumber: pr.prNumber,
          title: pr.title,
          author: pr.author,
          headRef: pr.headRef,
          files: pr.files,
          // github.ts は ISO 8601 で持つ。types.ts の契約は epoch ms なのでここで揃える
          fetchedAt: Number.isNaN(Date.parse(pr.fetchedAt)) ? fetchedAt : Date.parse(pr.fetchedAt),
        };
        try {
          await this.#kv.set([KV_PREFIX.prIndex, pr.prNumber], value);
        } catch {
          // KV の値の上限（64KiB）を超えるほど巨大な PR は書けない。その1件を飛ばして
          // 残りを更新する（`alive` には入れてあるので、既にある古い索引は消さない）。
          // 全部は書けなかったので、fetchedAt は前回成功時のまま残す（下記 complete）
          complete = false;
          continue;
        }
      }
      // 閉じた PR の索引は消す（open だけを持つ）
      for await (const entry of this.#kv.list<PrIndex>({ prefix: [KV_PREFIX.prIndex] })) {
        if (!alive.has(entry.value.prNumber)) await this.#kv.delete(entry.key);
      }
    } catch {
      // KV 側の異常。**リクエストを 500 に落とさない**（PR 索引はあくまで補助情報）
      await this.#markAttempt(startedAt);
      return;
    }
    if (!complete) {
      // 一部の PR を書けていないのに「今取れた」と示すと欠落が隠れる。試行だけ記録する
      await this.#markAttempt(startedAt);
      return;
    }
    try {
      await this.#kv.set(
        KV_PR_INDEX_META_KEY,
        { fetchedAt, attemptedAt: startedAt } satisfies PrIndexMeta,
      );
    } catch {
      // メタが書けなくても索引本体は更新済み。次のリクエストでまた試す
    }
  }

  /** 取得を試みた事実だけを記録する（`fetchedAt` は前回成功したときのまま残す） */
  async #markAttempt(startedAt: number): Promise<void> {
    try {
      const previous = await this.#kv.get<PrIndexMeta>(KV_PR_INDEX_META_KEY);
      await this.#kv.set(
        KV_PR_INDEX_META_KEY,
        {
          fetchedAt: previous.value?.fetchedAt ?? null,
          attemptedAt: startedAt,
        } satisfies PrIndexMeta,
      );
    } catch {
      // ここまで失敗するなら KV 自体が壊れている。次のリクエストでまた試す
    }
  }

  /** 必要なら取り直したうえで返す。API はこれを使う */
  async get(): Promise<{ prs: PrIndex[]; fetchedAt: number | null }> {
    await this.refreshIfDue();
    return await this.read();
  }
}

// ---------------------------------------------------------------------------
// サーバー本体
// ---------------------------------------------------------------------------

/** 画面の既定の置き場所。**別担当が作るので、無いことを前提に動く**（下記 #handleIndex） */
const DEFAULT_HTML_PATH = new URL("./public/index.html", import.meta.url);

export type BoardServerOptions = {
  /** Deno KV。EN 本体とは別ファイルにする（§10） */
  kv: Deno.Kv;
  /** 認証。省略時は kv から作る（作った場合は dispose() で後始末する） */
  auth?: BoardAuth;
  /** GitHub クライアント。null なら PR 索引は空のまま（GitHub を叩かない） */
  github?: BoardGitHubClient | null;
  /** PR 索引の更新間隔（ミリ秒）。省略時は PR_INDEX_REFRESH_MS */
  prIndexRefreshMs?: number;
  /** 現在時刻。TTL の境界をテストするために差し替えられるようにしてある */
  now?: () => number;
  /** 画面の HTML のパス。省略時は tools/board/public/index.html */
  htmlPath?: string | URL;
  /**
   * アクセスログを出すか。出す場合も「メンバー・時刻・メソッド・パス」までで、
   * **トークンやその一部は決して出さない**（§7-4）
   */
  accessLog?: boolean;
};

/**
 * 作業ボードのサーバー。`handle()` が1リクエストを処理する。
 * `Deno.serve` から切り離してあるのは、テストがポートを開かずに済むようにするため。
 */
export class BoardServer {
  #kv: Deno.Kv;
  #auth: BoardAuth;
  #ownsAuth: boolean;
  #prIndex: PrIndexCache;
  #now: () => number;
  #htmlPath: string | URL;
  #accessLog: boolean;

  constructor(options: BoardServerOptions) {
    this.#kv = options.kv;
    this.#ownsAuth = options.auth === undefined;
    this.#auth = options.auth ?? new BoardAuth(options.kv);
    this.#now = options.now ?? (() => Date.now());
    this.#prIndex = new PrIndexCache({
      kv: options.kv,
      client: options.github ?? null,
      refreshMs: options.prIndexRefreshMs,
      now: this.#now,
    });
    this.#htmlPath = options.htmlPath ?? DEFAULT_HTML_PATH;
    this.#accessLog = options.accessLog ?? false;
  }

  /** 認証のレート制限が持つタイマーを止める。停止時に呼ぶ */
  dispose(): void {
    if (this.#ownsAuth) this.#auth.dispose();
  }

  /** PR 索引のキャッシュ（起動時のウォームアップや運用の確認に使う） */
  get prIndexCache(): PrIndexCache {
    return this.#prIndex;
  }

  /**
   * 1リクエストを処理する。
   *
   * **認証をルーティングより先に行う**（§6「すべてトークン必須」）。こうしておけば、
   * 後から口を足したときに認証を書き忘れる余地が無い。
   *
   * 例外は `GET /`（画面のシェル HTML）**1本だけ**（§7-6）。
   * ブラウザはトップレベルのページ遷移に `Authorization` ヘッダーを付けられないので、
   * ここを認証必須にすると「トークンを入力する画面」に到達する経路が無くなり、
   * 誰も画面を開けない。シェルは情報を持たない器なので、そこだけ先に返す。
   * **この分岐に足せるのは「情報を持たない静的な器」だけで、`/api/*` は決して通さない。**
   */
  async handle(req: Request, ip: string): Promise<Response> {
    const url = new URL(req.url);
    const now = this.#now();
    const path = routePath(url);

    if (req.method === "GET" && path === "/") {
      try {
        return await this.#handleIndex();
      } catch {
        return jsonError(500, "サーバー内部でエラーが発生しました");
      }
    }

    const outcome = await this.#auth.authenticate(req, ip, now);
    if (!outcome.ok) {
      if (outcome.reason === "rateLimited") {
        return jsonError(429, "認証の失敗が続いています。しばらく待ってからやり直してください");
      }
      // missing と invalid を応答で区別しない（どちらも「認証が必要」だけを返す）。
      // **入力されたトークンには一切触れない**（§7-4）
      const res = jsonError(401, "トークンが必要です");
      const headers = new Headers(res.headers);
      headers.set("www-authenticate", "Bearer");
      return new Response(res.body, { status: res.status, headers });
    }
    const member = outcome.member;
    if (this.#accessLog) {
      // 記録するのは「どのメンバーが・いつ・どの API を」まで（§7-4）
      console.log(
        `[board] ${new Date(now).toISOString()} ${member.id} ${req.method} ${url.pathname}`,
      );
    }

    try {
      return await this.#route(req, url, path, member.id, now);
    } catch {
      // 想定外の例外でも中身を漏らさない（§7-4）。500 とだけ伝える
      return jsonError(500, "サーバー内部でエラーが発生しました");
    }
  }

  /**
   * 認証済みのリクエストを各処理へ振り分ける。
   * `path` は `handle()` が正規化済み（`GET /` だけは既にここへ来る前に返している）。
   */
  async #route(
    req: Request,
    url: URL,
    path: string,
    memberId: string,
    now: number,
  ): Promise<Response> {
    if (path === "/") {
      // GET は handle() が先に返しているので、ここへ来るのは他のメソッドだけ
      return methodNotAllowed("GET");
    }
    if (path === "/api/claims") {
      if (req.method === "GET") return await this.#listClaims(now);
      if (req.method === "POST") return await this.#createClaim(req, memberId, now);
      return methodNotAllowed("GET, POST");
    }
    if (path === "/api/claims/check") {
      if (req.method !== "GET") return methodNotAllowed("GET");
      return await this.#checkClaims(url, memberId, now);
    }
    const claimMatch = /^\/api\/claims\/([A-Za-z0-9]{1,64})$/.exec(path);
    if (claimMatch !== null) {
      if (req.method !== "PATCH") return methodNotAllowed("PATCH");
      return await this.#updateClaim(req, claimMatch[1], now);
    }
    if (path === "/api/tasks") {
      if (req.method === "GET") return await this.#listTasks();
      if (req.method === "POST") return await this.#createTask(req, now);
      return methodNotAllowed("GET, POST");
    }
    const taskMatch = /^\/api\/tasks\/([A-Za-z0-9]{1,64})$/.exec(path);
    if (taskMatch !== null) {
      if (req.method !== "PATCH") return methodNotAllowed("PATCH");
      return await this.#updateTask(req, taskMatch[1]);
    }
    if (path === "/api/prs") {
      if (req.method !== "GET") return methodNotAllowed("GET");
      const { prs, fetchedAt } = await this.#prIndex.get();
      return jsonResponse({ prs, fetchedAt } satisfies PrListResponse);
    }
    if (path === "/api/messages") {
      if (req.method !== "POST") return methodNotAllowed("POST");
      // TODO: PR コメントの投稿は未実装。tools/board/github.ts に
      // `POST /repos/{owner}/{repo}/issues/{number}/comments` を叩く口が無いため、
      // それが入ってから実装する（設計書 §9 の「PR 宛メッセージ」）。
      // 実装時はここで本文に containsSecretLike を掛けてから投稿すること（§7-7）。
      return jsonError(501, "PR 宛メッセージの投稿はまだ実装されていません");
    }
    return jsonError(404, "見つかりません");
  }

  // -------------------------------------------------------------------------
  // 画面（§7-6）
  // -------------------------------------------------------------------------

  /**
   * 画面のシェル HTML を返す。**認証を通っていなくてもここへ来る**（§7-6）。
   *
   * したがって、ここから返してよいのは `public/index.html` の中身そのものだけで、
   * **表明・タスク・メンバーのあだ名・トークンなどを一切混ぜてはいけない**。
   * 画面は起動後に自分でトークンを受け取り、認証付きの `/api/*` から中身を取りに行く。
   *
   * 画面が置かれていないことがある（撤去したときや、配布物を取り違えたとき）。
   * その場合に 500 や素の Deno のエラーを見せると原因が分からないので、
   * **何が足りないのかを述べた 503** を返す。
   * ただしこの応答は**無認証で誰でも引ける**ので、サーバー上の絶対パスは載せない
   * （ファイル名だけにする。運用の置き場所は tools/board/README.md にある）。
   */
  async #handleIndex(): Promise<Response> {
    let html: string;
    try {
      html = await Deno.readTextFile(this.#htmlPath);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        return jsonError(
          503,
          `画面（HTML）がまだ置かれていません: ${this.#describeHtmlPath()}` +
            "（既定は tools/board/public/index.html）。API は使えます（GET /api/claims など）",
        );
      }
      if (e instanceof Deno.errors.PermissionDenied) {
        return jsonError(
          500,
          `画面（HTML）を読む権限がありません: ${this.#describeHtmlPath()}` +
            "。--allow-read に含めてください",
        );
      }
      return jsonError(500, "画面（HTML）を読めませんでした");
    }
    return respond(html, 200, "text/html; charset=utf-8", HTML_SECURITY_HEADERS);
  }

  /**
   * 画面のパスを人が読める形にする。**ファイル名だけ**を返す。
   * この文字列は無認証の 503 / 500 に載るので、サーバーの絶対パス（配置場所や
   * ユーザー名が透ける）を外へ出さない。トークン等はもとより含まない。
   */
  #describeHtmlPath(): string {
    const path = this.#htmlPath;
    const full = typeof path === "string"
      ? path
      : path.protocol === "file:"
      ? decodeURIComponent(path.pathname)
      : path.toString();
    const name = full.split(/[\\/]/).filter((part) => part.length > 0).pop();
    return name ?? "index.html";
  }

  // -------------------------------------------------------------------------
  // 表明（§4 / §5）
  // -------------------------------------------------------------------------

  /** メンバー id → 表示名。ハッシュは読まない（listMembers が公開部分しか返さない） */
  async #memberNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const m of await this.#auth.listMembers()) names.set(m.id, m.displayName);
    return names;
  }

  /** 保存されている表明を、一覧・検査で返す形にする */
  #toView(claim: Claim, names: Map<string, string>, now: number): ClaimView {
    return {
      ...claim,
      memberName: names.get(claim.member) ?? claim.member,
      // §5: TTL を過ぎた working を「古い表明」として区別する。**自動削除はしない**。
      // ちょうど TTL の瞬間はまだ古くない（超えたら古い）
      stale: claim.status === "working" && now - claim.heartbeatAt > CLAIM_TTL_MS,
    };
  }

  /** 保存されている表明を全部読む */
  async #allClaims(): Promise<Claim[]> {
    const claims: Claim[] = [];
    for await (const entry of this.#kv.list<Claim>({ prefix: [KV_PREFIX.claim] })) {
      claims.push(entry.value);
    }
    return claims;
  }

  /** GET /api/claims */
  async #listClaims(now: number): Promise<Response> {
    const [claims, names] = await Promise.all([this.#allClaims(), this.#memberNames()]);
    claims.sort((a, b) => b.startedAt - a.startedAt);
    const body: ClaimListResponse = {
      claims: claims.map((c) => this.#toView(c, names, now)),
      serverTime: now,
    };
    return jsonResponse(body);
  }

  /**
   * POST /api/claims
   *
   * `member` はクライアントから受け取らない。**トークンから解決した値だけを使う**（§7-1）。
   * 同じ `sessionId` の表明が既にあれば 409（§4「1セッション1表明」）。
   */
  async #createClaim(req: Request, memberId: string, now: number): Promise<Response> {
    const parsed = await readJsonObject(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value;

    const sessionId = checkLine(body.sessionId, "sessionId", SESSION_ID_MAX, { required: true });
    if (!sessionId.ok) return jsonError(400, sessionId.message);
    const title = checkLine(body.title, "title", TITLE_MAX, { required: true });
    if (!title.ok) return jsonError(400, title.message);
    const note = checkText(body.note, "note", NOTE_MAX, { required: false });
    if (!note.ok) return jsonError(400, note.message);
    const branch = checkLine(body.branch, "branch", BRANCH_MAX, { required: false });
    if (!branch.ok) return jsonError(400, branch.message);
    const paths = checkPaths(body.paths);
    if (!paths.ok) return jsonError(400, paths.message);
    const prNumber = checkPrNumber(body.prNumber);
    if (!prNumber.ok) return jsonError(400, prNumber.message);

    const claim: Claim = {
      id: ulid(now),
      member: memberId,
      sessionId: sessionId.value as string,
      title: title.value as string,
      status: "working",
      startedAt: now,
      heartbeatAt: now,
    };
    if (paths.value !== undefined && paths.value.length > 0) claim.paths = paths.value;
    if (branch.value !== undefined && branch.value !== "") claim.branch = branch.value;
    if (prNumber.value !== undefined) claim.prNumber = prNumber.value;
    if (note.value !== undefined && note.value !== "") claim.note = note.value;

    // sessionId の索引を versionstamp 条件付きで立てる。同時に2回来ても片方しか通らない。
    // 既存の表明が working のときだけ 409 にする（§4「1セッション1表明」は「作業中の
    // 表明は同時に1つ」の意味に取る）。done / paused なら同じセッションからの
    // 表明し直しを許し、索引を新しい表明へ付け替える。古い表明は消さない（§5）。
    const sessionKey = [KV_CLAIM_SESSION_PREFIX, claim.member, claim.sessionId];
    const existing = await this.#kv.get<string>(sessionKey);
    if (existing.value !== null) {
      const current = await this.#kv.get<Claim>([KV_PREFIX.claim, existing.value]);
      if (current.value !== null && current.value.status === "working") {
        return jsonError(
          409,
          "このセッションには作業中の表明があります（1セッション1表明）。更新は PATCH /api/claims/:id を使ってください",
        );
      }
    }
    const commit = await this.#kv.atomic()
      .check(existing)
      .set(sessionKey, claim.id)
      .set([KV_PREFIX.claim, claim.id], claim)
      .commit();
    if (!commit.ok) {
      // 読んでから書くまでに同じセッションの別の POST が通った
      return jsonError(
        409,
        "このセッションには既に表明があります（1セッション1表明）。もう一度やり直してください",
      );
    }
    const names = await this.#memberNames();
    return jsonResponse({ claim: this.#toView(claim, names, now) } satisfies ClaimResponse, 201);
  }

  /**
   * PATCH /api/claims/:id
   *
   * §2 のとおり権限は細分化しない（全員が全部見える・書ける）ので、認証さえ通っていれば
   * 他人の表明も更新できる。代わりに `member` と `sessionId` は**書き換えさせない**
   * （詐称の余地を作らないため、§7-1）。
   *
   * 呼ばれるたびに `heartbeatAt` を更新する（§5）。
   */
  async #updateClaim(req: Request, id: string, now: number): Promise<Response> {
    const parsed = await readJsonObject(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value;

    const status = checkClaimStatus(body.status);
    if (!status.ok) return jsonError(400, status.message);
    const title = checkLine(body.title, "title", TITLE_MAX, { required: false });
    if (!title.ok) return jsonError(400, title.message);
    const note = checkText(body.note, "note", NOTE_MAX, { required: false });
    if (!note.ok) return jsonError(400, note.message);
    const branch = checkLine(body.branch, "branch", BRANCH_MAX, { required: false });
    if (!branch.ok) return jsonError(400, branch.message);
    const paths = checkPaths(body.paths);
    if (!paths.ok) return jsonError(400, paths.message);
    const prNumber = checkPrNumber(body.prNumber);
    if (!prNumber.ok) return jsonError(400, prNumber.message);

    const key = [KV_PREFIX.claim, id];
    const entry = await this.#kv.get<Claim>(key);
    if (entry.value === null) return jsonError(404, "表明が見つかりません");

    const updated: Claim = { ...entry.value, heartbeatAt: now };
    if (status.value !== undefined) updated.status = status.value;
    if (title.value !== undefined && title.value !== "") updated.title = title.value;
    if (paths.value !== undefined) {
      if (paths.value.length === 0) delete updated.paths;
      else updated.paths = paths.value;
    }
    if (branch.value !== undefined) {
      if (branch.value === "") delete updated.branch;
      else updated.branch = branch.value;
    }
    if (prNumber.value !== undefined) updated.prNumber = prNumber.value;
    if (note.value !== undefined) {
      if (note.value === "") delete updated.note;
      else updated.note = note.value;
    }

    // 読んでから書くまでに別の更新が入っていたら書かない（後勝ちで取りこぼさない）
    const commit = await this.#kv.atomic().check(entry).set(key, updated).commit();
    if (!commit.ok) {
      return jsonError(409, "同時に別の更新が入りました。もう一度やり直してください");
    }
    const names = await this.#memberNames();
    return jsonResponse({ claim: this.#toView(updated, names, now) } satisfies ClaimResponse);
  }

  /**
   * GET /api/claims/check?paths=a,b （§6「フックの中核」）
   *
   * 指定パスに重なる**他人の**表明と、指定パスを触っているオープン PR を返す。
   *
   *   - 自分（トークンで解決したメンバー）の表明は含めない
   *   - `done` の表明は含めない（終わった作業と重なっても事故にならない）
   *   - `paths` を持たない表明は重なりようがないので含めない
   *   - PR 索引は**キャッシュから**返す（必要なら §9 の間隔で取り直す）
   */
  async #checkClaims(url: URL, memberId: string, now: number): Promise<Response> {
    // CLI（tools/board/board.ts）は `?paths=a,b` のカンマ結合1本で送ってくるため、
    // カンマ区切りを受ける（§6 の表記もこの形）。既知の制約として、カンマを含む
    // ファイル名はこのクエリでは表現できない（`?paths=` を複数回指定しても同じ）。
    const raw: string[] = [];
    for (const value of url.searchParams.getAll("paths")) {
      for (const item of value.split(",")) raw.push(item);
    }
    if (raw.length > CHECK_PATHS_MAX) {
      return jsonError(400, `paths は${CHECK_PATHS_MAX}件以内で指定してください`);
    }
    for (const item of raw) {
      if ([...item].length > PATH_MAX) {
        return jsonError(400, `paths の要素は${PATH_MAX}文字以内で指定してください`);
      }
      if (isMachineAbsolutePath(item)) {
        // 絶対パスは表明側と絶対に重ならず、200 が返るぶん壊れていることに気づけない。
        // 黙って空の結果を返すより、相対化されていないことをここで知らせる
        return jsonError(
          400,
          "paths は絶対パスではなく、リポジトリルートからの相対パスで指定してください（例: public/app.js）",
        );
      }
    }
    const paths = normalizePaths(raw);
    if (paths.length === 0) {
      return jsonError(
        400,
        "paths を指定してください（例: /api/claims/check?paths=public/app.js）",
      );
    }

    const [claims, names, index] = await Promise.all([
      this.#allClaims(),
      this.#memberNames(),
      this.#prIndex.get(),
    ]);

    const overlapping: ClaimView[] = [];
    for (const claim of claims) {
      if (claim.member === memberId) continue;
      if (claim.status === "done") continue;
      const claimPaths = normalizePaths(claim.paths ?? []);
      if (claimPaths.length === 0) continue;
      if (!anyPathOverlaps(paths, claimPaths)) continue;
      overlapping.push(this.#toView(claim, names, now));
    }
    overlapping.sort((a, b) => b.startedAt - a.startedAt);

    const prs = index.prs.filter((pr) => anyPathOverlaps(paths, normalizePaths(pr.files)));

    const body: ClaimCheckResponse = {
      paths,
      claims: overlapping,
      prs,
      prsFetchedAt: index.fetchedAt,
      serverTime: now,
    };
    return jsonResponse(body);
  }

  // -------------------------------------------------------------------------
  // タスク（§4）
  // -------------------------------------------------------------------------

  /** GET /api/tasks */
  async #listTasks(): Promise<Response> {
    const tasks: Task[] = [];
    for await (const entry of this.#kv.list<Task>({ prefix: [KV_PREFIX.task] })) {
      tasks.push(entry.value);
    }
    tasks.sort((a, b) => b.createdAt - a.createdAt);
    return jsonResponse({ tasks } satisfies TaskListResponse);
  }

  /** POST /api/tasks */
  async #createTask(req: Request, now: number): Promise<Response> {
    const parsed = await readJsonObject(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value;

    const title = checkLine(body.title, "title", TITLE_MAX, { required: true });
    if (!title.ok) return jsonError(400, title.message);
    const text = checkText(body.body, "body", TASK_BODY_MAX, { required: false });
    if (!text.ok) return jsonError(400, text.message);
    const assignee = checkLine(body.assignee, "assignee", ASSIGNEE_MAX, { required: false });
    if (!assignee.ok) return jsonError(400, assignee.message);

    const task: Task = {
      id: ulid(now),
      title: title.value as string,
      body: text.value ?? "",
      status: "open",
      createdAt: now,
    };
    if (assignee.value !== undefined && assignee.value !== "") task.assignee = assignee.value;
    await this.#kv.set([KV_PREFIX.task, task.id], task);
    return jsonResponse({ task } satisfies TaskResponse, 201);
  }

  /** PATCH /api/tasks/:id */
  async #updateTask(req: Request, id: string): Promise<Response> {
    const parsed = await readJsonObject(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value;

    const status = checkTaskStatus(body.status);
    if (!status.ok) return jsonError(400, status.message);
    const title = checkLine(body.title, "title", TITLE_MAX, { required: false });
    if (!title.ok) return jsonError(400, title.message);
    const text = checkText(body.body, "body", TASK_BODY_MAX, { required: false });
    if (!text.ok) return jsonError(400, text.message);
    const assignee = checkLine(body.assignee, "assignee", ASSIGNEE_MAX, { required: false });
    if (!assignee.ok) return jsonError(400, assignee.message);

    const key = [KV_PREFIX.task, id];
    const entry = await this.#kv.get<Task>(key);
    if (entry.value === null) return jsonError(404, "タスクが見つかりません");

    const updated: Task = { ...entry.value };
    if (status.value !== undefined) updated.status = status.value;
    if (title.value !== undefined && title.value !== "") updated.title = title.value;
    if (text.value !== undefined) updated.body = text.value;
    if (assignee.value !== undefined) {
      if (assignee.value === "") delete updated.assignee;
      else updated.assignee = assignee.value;
    }

    const commit = await this.#kv.atomic().check(entry).set(key, updated).commit();
    if (!commit.ok) {
      return jsonError(409, "同時に別の更新が入りました。もう一度やり直してください");
    }
    return jsonResponse({ task: updated } satisfies TaskResponse);
  }
}

// ---------------------------------------------------------------------------
// 起動（§10）
// ---------------------------------------------------------------------------

/**
 * クライアントの実IPを求める（認証失敗のレート制限のキーに使う、§7-8）。
 * `server/main.ts` の同名関数と同じ考え方: 本番は Caddy 配下（§7-8）なので TCP 接続元は
 * 常に localhost になる。`x-forwarded-for` は偽装できるヘッダーなので、TCP 接続元が
 * localhost のときだけ信頼する。
 */
export function clientIp(req: Request, remoteAddrHostname: string): string {
  const trustedProxy = remoteAddrHostname === "127.0.0.1" || remoteAddrHostname === "::1";
  if (!trustedProxy) return remoteAddrHostname;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded === null) return remoteAddrHostname;
  const first = forwarded.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : remoteAddrHostname;
}

/**
 * 環境変数から GitHub クライアントを作る。作れなければ null（PR 索引は空になる）。
 * **トークンの値はログに出さない。** 未設定のときも「設定されていない」としか言わない。
 */
function buildGitHubClient(): BoardGitHubClient | null {
  const repo = (Deno.env.get("BOARD_REPO") ?? "").trim();
  if (repo === "") {
    console.log("[board] BOARD_REPO が未設定のため PR 索引は取得しません");
    return null;
  }
  try {
    return new BoardGitHubClient({ repo, token: resolveGitHubToken() });
  } catch {
    // 例外メッセージにトークンは含まれない設計だが、念のため中身を出さない
    console.log("[board] GitHub クライアントを作れませんでした。PR 索引は取得しません");
    return null;
  }
}

/** サーバーを起動する（§10: EN とは別ポート・別 KV ファイル） */
export async function main(): Promise<void> {
  const port = Number(Deno.env.get("BOARD_PORT") ?? "8788");
  const hostname = Deno.env.get("BOARD_HOST") ?? "127.0.0.1";
  const kv = await Deno.openKv(Deno.env.get("BOARD_KV_PATH"));
  const htmlPath = Deno.env.get("BOARD_HTML_PATH");
  const board = new BoardServer({
    kv,
    github: buildGitHubClient(),
    htmlPath: htmlPath !== undefined && htmlPath !== "" ? htmlPath : undefined,
    accessLog: true,
  });
  // PR 索引はタイマーで定期取得する（§9）。リクエスト側の refreshIfDue は、
  // タイマーが不調でも索引が止まらないための保険として残る。
  // refresh() は失敗しても例外を投げない（古いキャッシュで続行、§9）
  void board.prIndexCache.refresh();
  setInterval(() => void board.prIndexCache.refresh(), PR_INDEX_REFRESH_MS);
  Deno.serve({ port, hostname, onListen: () => {} }, (req, info) => {
    return board.handle(req, clientIp(req, info.remoteAddr.hostname));
  });
  console.log(`[board] listening on http://${hostname}:${port}`);
}

if (import.meta.main) {
  await main();
}
