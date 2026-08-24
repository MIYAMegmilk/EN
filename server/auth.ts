/**
 * 認証 API（§3.0 / §4.0）
 *
 *   POST /api/auth/register … 登録 + ログイン
 *   POST /api/auth/login    … ログイン
 *   POST /api/auth/logout   … ログアウト
 *   GET  /api/me            … ログイン状態の確認
 *
 * アカウント（User）・認証セッション（AuthSession）は Deno KV に保存する（§5）。
 * ルーム状態とは異なり永続化対象。
 */

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { deleteCookie, getCookies, setCookie } from "@std/http/cookie";
import { HOBBY_TAGS, type HobbyTagId, isValidHobbyTagId } from "./hobby_tags.ts";
import { validateNickname } from "./rooms.ts";
import type { AuthSession, User } from "./types.ts";

/** userId の文字数制約（§3.0） */
export const USER_ID_MIN = 4;
export const USER_ID_MAX = 20;
/** パスワードの文字数制約（§3.0） */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;
/** PBKDF2-HMAC-SHA256 の反復回数（§3.0、OWASP 推奨値） */
export const PBKDF2_ITERATIONS = 600_000;
/** salt の長さ（バイト、§3.0 の「16バイト以上」を採用） */
const SALT_BYTES = 16;
/** セッショントークンの長さ（バイト、§3.0 の「32バイト」） */
const SESSION_TOKEN_BYTES = 32;
/** セッションの有効期限（ミリ秒、§3.0 の「30日」） */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** セッション Cookie 名 */
export const SESSION_COOKIE_NAME = "session";
/** 軽量プロフィールに保存できる趣味タグの上限（§3.11） */
export const PROFILE_TAGS_MAX = 5;

/** ログイン試行のレート制限（§3.8: IPごとに5回/分） */
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;
/** 登録のレート制限（§3.8: IPごとに3件/時） */
const REGISTER_LIMIT = 3;
const REGISTER_WINDOW_MS = 60 * 60_000;

const USER_ID_RE = /^[A-Za-z0-9]+$/;

function isValidUserId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= USER_ID_MIN &&
    value.length <= USER_ID_MAX &&
    USER_ID_RE.test(value)
  );
}

function isValidPassword(value: unknown): value is string {
  return (
    typeof value === "string" && value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX
  );
}

/** ランダムなバイト列を Base64 にして返す */
function randomBase64(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64(bytes);
}

/** ランダムなバイト列を16進文字列にして返す（Cookie に入れる値なのでURL安全な16進を使う） */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** PBKDF2-HMAC-SHA256 でパスワードをハッシュ化する（§3.0） */
async function hashPassword(password: string, saltB64: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: decodeBase64(saltB64), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return encodeBase64(new Uint8Array(bits));
}

/** 定数時間でのバイト列比較（タイミング攻撃対策） */
function timingSafeEqual(a: string, b: string): boolean {
  const bytesA = new TextEncoder().encode(a);
  const bytesB = new TextEncoder().encode(b);
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

/**
 * 固定窓カウンタ方式の簡易レート制限（§3.8）。プロセスメモリのみで永続化しない。
 * 二度とアクセスが来ない key の記録が残り続けないよう、windowMs 周期で全体を掃除する。
 */
class RateLimiter {
  #hits = new Map<string, number[]>();
  #sweepTimer: ReturnType<typeof setInterval>;

  constructor(private readonly limit: number, private readonly windowMs: number) {
    this.#sweepTimer = setInterval(() => this.#sweep(), this.windowMs);
  }

  /** 呼び出しを1回計上し、上限を超えていれば false を返す */
  tryConsume(key: string, now: number): boolean {
    const cutoff = now - this.windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    if (hits.length >= this.limit) {
      this.#hits.set(key, hits);
      return false;
    }
    hits.push(now);
    this.#hits.set(key, hits);
    return true;
  }

  /** 期限切れの記録だけになった key を削除する */
  #sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, hits] of this.#hits) {
      const fresh = hits.filter((t) => t > cutoff);
      if (fresh.length === 0) this.#hits.delete(key);
      else this.#hits.set(key, fresh);
    }
  }

  /** 定期掃除タイマーを止める */
  dispose(): void {
    clearInterval(this.#sweepTimer);
  }
}

/**
 * セッション Cookie の値からログイン中の userId を求める（§3.0）。
 * WS アップグレード時の Cookie 検証など、HTTP レスポンスを作らない箇所からも使う。
 */
export async function verifySession(
  kv: Deno.Kv,
  token: string | undefined,
): Promise<string | null> {
  if (token === undefined) return null;
  const entry = await kv.get<AuthSession>(["authSession", token]);
  if (entry.value === null || entry.value.expiresAt <= Date.now()) return null;
  return entry.value.userId;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, { status });
}

/** 認証 API のハンドラ一式。Deno KV への読み書きをカプセル化する */
export class AuthApi {
  #kv: Deno.Kv;
  #loginLimiter = new RateLimiter(LOGIN_LIMIT, LOGIN_WINDOW_MS);
  #registerLimiter = new RateLimiter(REGISTER_LIMIT, REGISTER_WINDOW_MS);

  constructor(kv: Deno.Kv) {
    this.#kv = kv;
  }

  /** レート制限の定期掃除タイマーを止める。サーバー停止時に呼ぶ */
  dispose(): void {
    this.#loginLimiter.dispose();
    this.#registerLimiter.dispose();
  }

  /** このモジュールが担当するパスなら処理して Response を返す。担当外なら null */
  async handle(req: Request, url: URL, clientIp: string): Promise<Response | null> {
    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      return await this.register(req, clientIp);
    }
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      return await this.login(req, clientIp);
    }
    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      return await this.logout(req);
    }
    if (url.pathname === "/api/me" && req.method === "GET") {
      return await this.me(req);
    }
    if (url.pathname === "/api/tags" && req.method === "GET") {
      return this.tags();
    }
    if (url.pathname === "/api/profile" && req.method === "PUT") {
      return await this.saveProfile(req);
    }
    return null;
  }

  private async register(req: Request, clientIp: string): Promise<Response> {
    if (!this.#registerLimiter.tryConsume(clientIp, Date.now())) {
      return errorResponse(
        429,
        "登録の試行回数が上限を超えました。しばらくしてから再度お試しください",
      );
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(400, "リクエストの形式が正しくありません");
    }
    const { userId, password } = (body ?? {}) as { userId?: unknown; password?: unknown };
    if (!isValidUserId(userId)) {
      return errorResponse(400, "ユーザーIDは半角英数4〜20文字で入力してください");
    }
    if (!isValidPassword(password)) {
      return errorResponse(400, "パスワードは8〜64文字で入力してください");
    }

    const salt = randomBase64(SALT_BYTES);
    const passwordHash = await hashPassword(password, salt);
    const user: User = { userId, passwordHash, salt, createdAt: Date.now() };
    const userKey = ["user", userId];

    const commit = await this.#kv.atomic().check({ key: userKey, versionstamp: null }).set(
      userKey,
      user,
    ).commit();
    if (!commit.ok) {
      return errorResponse(409, "このユーザーIDは既に使用されています");
    }

    return await this.#issueSession(userId);
  }

  private async login(req: Request, clientIp: string): Promise<Response> {
    if (!this.#loginLimiter.tryConsume(clientIp, Date.now())) {
      return errorResponse(
        429,
        "ログイン試行回数が上限を超えました。しばらくしてから再度お試しください",
      );
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(400, "リクエストの形式が正しくありません");
    }
    const { userId, password } = (body ?? {}) as { userId?: unknown; password?: unknown };
    if (typeof userId !== "string" || typeof password !== "string") {
      return errorResponse(400, "ユーザーIDとパスワードを入力してください");
    }

    const entry = await this.#kv.get<User>(["user", userId]);
    if (entry.value === null) {
      return errorResponse(401, "ユーザーIDまたはパスワードが正しくありません");
    }
    const computed = await hashPassword(password, entry.value.salt);
    if (!timingSafeEqual(computed, entry.value.passwordHash)) {
      return errorResponse(401, "ユーザーIDまたはパスワードが正しくありません");
    }

    return await this.#issueSession(userId);
  }

  private async logout(req: Request): Promise<Response> {
    const token = getCookies(req.headers)[SESSION_COOKIE_NAME];
    if (token !== undefined) {
      await this.#kv.delete(["authSession", token]);
    }
    const res = jsonResponse({ ok: true });
    deleteCookie(res.headers, SESSION_COOKIE_NAME, { path: "/" });
    return res;
  }

  /** プリセット趣味タグの一覧を返す（§3.11、ログイン不要） */
  private tags(): Response {
    return jsonResponse({ tags: HOBBY_TAGS });
  }

  /** ログイン中ユーザーのあだ名・趣味タグを保存する（§3.0 / §3.11、要ログイン） */
  private async saveProfile(req: Request): Promise<Response> {
    const token = getCookies(req.headers)[SESSION_COOKIE_NAME];
    const userId = await verifySession(this.#kv, token);
    if (userId === null) {
      return errorResponse(401, "ログインしていません");
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(400, "リクエストの形式が正しくありません");
    }
    const { nickname, tags } = (body ?? {}) as { nickname?: unknown; tags?: unknown };

    const nicknameResult = validateNickname(nickname);
    if (!nicknameResult.ok) {
      return errorResponse(400, nicknameResult.message);
    }
    if (!Array.isArray(tags) || !tags.every(isValidHobbyTagId)) {
      return errorResponse(400, "趣味タグはプリセットの中から選んでください");
    }
    const uniqueTags = [...new Set(tags as HobbyTagId[])];
    if (uniqueTags.length > PROFILE_TAGS_MAX) {
      return errorResponse(400, `趣味タグは${PROFILE_TAGS_MAX}個以内で選んでください`);
    }

    const userKey = ["user", userId];
    const entry = await this.#kv.get<User>(userKey);
    if (entry.value === null) {
      return errorResponse(404, "アカウントが見つかりません");
    }
    const updated: User = { ...entry.value, nickname: nicknameResult.value, tags: uniqueTags };
    await this.#kv.set(userKey, updated);

    return jsonResponse({ nickname: updated.nickname, tags: updated.tags });
  }

  private async me(req: Request): Promise<Response> {
    const token = getCookies(req.headers)[SESSION_COOKIE_NAME];
    const userId = await verifySession(this.#kv, token);
    if (userId === null) {
      return errorResponse(401, "ログインしていません");
    }
    const entry = await this.#kv.get<User>(["user", userId]);
    const body: { userId: string; nickname?: string; tags?: string[] } = { userId };
    if (entry.value?.nickname !== undefined) body.nickname = entry.value.nickname;
    if (entry.value?.tags !== undefined) body.tags = entry.value.tags;
    return jsonResponse(body);
  }

  /** セッションを新規発行し、Cookie 付きのレスポンスを返す（register/login 共通） */
  async #issueSession(userId: string): Promise<Response> {
    const token = randomHex(SESSION_TOKEN_BYTES);
    const session: AuthSession = { userId, expiresAt: Date.now() + SESSION_TTL_MS };
    // expireIn を付けて、ログアウトなしで放置されたセッションも KV から自動的に消す
    await this.#kv.set(["authSession", token], session, { expireIn: SESSION_TTL_MS });

    const res = jsonResponse({ userId });
    setCookie(res.headers, {
      name: SESSION_COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return res;
  }
}
