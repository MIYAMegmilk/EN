/**
 * デバッグ機能（開発チーム向け内部診断。§3.8 のセキュリティ基準を満たす形で実装する）
 *
 * オーナーの困りごと: 「どこでログインがはじかれているのかわからない」
 * login はユーザー不在とパスワード不一致を **同じ文言・同じ401** で返す（アカウントの
 * 有無を外部に漏らさないための正しい設計。§3.0）。この応答は変えない。代わりに、
 * サーバー内部のリングバッファに構造化イベントを記録し、開発チームだけが専用APIで
 * 参照できるようにする。
 *
 * 有効化・アクセス制御（最重要。詳しくは main.ts 側の配線を参照）:
 *   - 環境変数 `EN_DEBUG_TOKEN` が設定されているときだけ有効。
 *   - 未設定なら、デバッグ関連のパスはすべて **404**（無効ではなく「存在しない」ように見せる）。
 *   - 設定されていても、リクエストヘッダ `x-debug-token` が一致しない場合も **404**
 *     （401 だと「パスは存在する」ことが漏れるため）。
 *   - トークンの比較はタイミング安全に行う（server/auth.ts の timingSafeEqual と同じ
 *     アルゴリズム。auth.ts ⇔ debug.ts の循環importを避けるため、ここでは独立実装にした）。
 *
 * 機微情報対策:
 *   - detail に既知の危険なキー（password / token / cookie / secret / credential /
 *     passwordHash / salt。大文字小文字を区別しない）が来たら、値を "[redacted]" に
 *     必ず置き換える。呼び出し側の実装ミスで生パスワード等が漏れることを防ぐ最後の砦。
 */

/**
 * record() が記録した1件を1行にして受け取るロガー。
 * 既定は console.log（systemd 経由で journalctl から追える。§ 追加要望「サーバーの
 * コンソールにも出す」）。テストからは配列に積む関数を注入して覗く。
 */
export type DebugLogger = (line: string) => void;

/** リングバッファに積む1件の構造化イベント */
export type DebugEvent = {
  /** 連番（新しいほど大きい） */
  seq: number;
  /** 記録時刻（epoch ms） */
  at: number;
  /** 階層つきの種別（例: "login.userNotFound"） */
  kind: string;
  /** 日本語の一行説明（人が読む用） */
  message: string;
  /** 付随情報。危険なキーは自動的に redact される */
  detail?: Record<string, string | number | boolean>;
};

/** リングバッファの保持件数上限 */
export const MAX_EVENTS = 500;

/** list() の limit の既定値・上限値 */
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;

/** detail に入れてはいけない既知の危険なキー（小文字化して比較する） */
const SENSITIVE_DETAIL_KEYS = new Set([
  "password",
  "token",
  "cookie",
  "secret",
  "credential",
  "passwordhash",
  "salt",
]);

/** 危険なキーの値を置き換える文字列 */
export const REDACTED = "[redacted]";

/** detail のうち危険なキーの値を "[redacted]" に置き換えたコピーを返す */
function sanitizeDetail(
  detail: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (detail === undefined) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(detail)) {
    out[key] = SENSITIVE_DETAIL_KEYS.has(key.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

/** limit クエリパラメータを既定値・上限値の範囲に収める */
function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIST_LIMIT);
}

/**
 * イベント1件を journalctl で追いやすい1行に整形する。
 * **redact 済みの event.detail（sanitizeDetail を通した後）だけを使うこと。**
 * 生の detail を直接渡すと機微情報がコンソールに漏れる。
 */
export function formatLogLine(event: DebugEvent): string {
  const parts = [
    "[debug]",
    new Date(event.at).toISOString(),
    event.kind,
    event.message,
  ];
  if (event.detail !== undefined) {
    for (const [key, value] of Object.entries(event.detail)) {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(" ");
}

/**
 * 構造化イベントを直近 MAX_EVENTS 件だけメモリに保持するリングバッファ。
 * `enabled` が false のときは record() が即座に無視する（デバッグ無効時にメモリを
 * 無駄にしない。EN_DEBUG_TOKEN 未設定時の既定の使い方）。
 *
 * 有効時は record() のたびに `log`（既定 console.log）へも1行出力する
 * （journalctl だけを見ている開発フロー向け。§ 追加要望）。無効時は1行も出さない。
 * 出力する値は必ず redact 済みの event.detail から作る（sanitizeDetail 後）。
 */
export class DebugRecorder {
  readonly enabled: boolean;
  #events: DebugEvent[] = [];
  #seq = 0;
  #log: DebugLogger;

  constructor(enabled: boolean, log: DebugLogger = console.log) {
    this.enabled = enabled;
    this.#log = log;
  }

  /** イベントを1件記録する。無効時は何もしない（コンソール出力もしない） */
  record(
    kind: string,
    message: string,
    detail?: Record<string, string | number | boolean>,
  ): void {
    if (!this.enabled) return;
    this.#seq += 1;
    const event: DebugEvent = { seq: this.#seq, at: Date.now(), kind, message };
    const sanitized = sanitizeDetail(detail);
    if (sanitized !== undefined) event.detail = sanitized;
    this.#events.push(event);
    if (this.#events.length > MAX_EVENTS) this.#events.shift();
    // event は redact 済みの detail を持つ状態（上で組み立て済み）。生の detail は使わない
    this.#log(formatLogLine(event));
  }

  /**
   * 記録済みイベントを取り出す。
   * - kind は前方一致（"login." で login 系だけ絞れる）
   * - limit は既定 200・最大 500。「直近 limit 件」を古い順に返す
   */
  list(opts: { limit?: number; kind?: string } = {}): DebugEvent[] {
    const limit = clampLimit(opts.limit);
    const filtered = opts.kind === undefined
      ? this.#events
      : this.#events.filter((e) => e.kind.startsWith(opts.kind as string));
    return filtered.length <= limit ? filtered : filtered.slice(filtered.length - limit);
  }
}

// ---------------------------------------------------------------------------
// アクセス制御
// ---------------------------------------------------------------------------

/** デバッグ用トークンを受け取るヘッダ名 */
export const DEBUG_TOKEN_HEADER = "x-debug-token";

/**
 * 定数時間でのバイト列比較（タイミング攻撃対策）。
 * server/auth.ts の timingSafeEqual と同じアルゴリズム
 * （debug.ts と auth.ts の相互 import を避けるため、あえて独立に持つ）。
 */
function timingSafeEqual(a: string, b: string): boolean {
  const bytesA = new TextEncoder().encode(a);
  const bytesB = new TextEncoder().encode(b);
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

/**
 * リクエストの x-debug-token ヘッダが設定済みトークンと一致するか。
 * token が null（EN_DEBUG_TOKEN 未設定 = デバッグ無効）なら常に false。
 */
export function hasValidDebugToken(req: Request, token: string | null): boolean {
  if (token === null) return false;
  const header = req.headers.get(DEBUG_TOKEN_HEADER);
  if (header === null) return false;
  return timingSafeEqual(header, token);
}

// ---------------------------------------------------------------------------
// HTTP API: GET /api/debug/events, GET /api/debug/summary,
//           POST /api/debug/reset-limits
// ---------------------------------------------------------------------------

export const DEBUG_EVENTS_PATH = "/api/debug/events";
export const DEBUG_SUMMARY_PATH = "/api/debug/summary";
/**
 * 開発中にログイン・登録・プロフィール保存のレート制限（server/auth.ts の #loginLimiter /
 * #registerLimiter / #profileLimiter）で詰まったとき、待たずに解除するための口。
 * 「消す」操作なので必ず POST（GET だと誤って踏んだリンクやプリフェッチで消えてしまう）。
 */
export const DEBUG_RESET_LIMITS_PATH = "/api/debug/reset-limits";

/** POST /api/debug/reset-limits が返す、実際に消えた枠（IP）の件数 */
export type ResetLimitsResult = { login: number; register: number; profile: number };

function jsonNoStore(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      // summary/events/reset-limits はその場の内部状態を返す・変更するため、キャッシュさせない
      "cache-control": "no-store",
      ...init?.headers,
    },
  });
}

/** 「存在しない」ように見せるための404。無効時・トークン不一致時のどちらも同じ応答にする */
function notFound(): Response {
  return new Response("not found", { status: 404 });
}

/**
 * Origin ヘッダがこのサーバーと同一かどうか（§3.8 CSRF対策）。
 * main.ts の isAllowedOrigin と同じロジック（ヘッダ無しのクライアントは許可する）。
 * debug.ts と main.ts の相互importを避けるため、ここでは独立実装にした
 * （timingSafeEqual と同じ理由。main.ts 側を変更したら忘れずにこちらも合わせること）。
 */
function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  const host = req.headers.get("host") ?? new URL(req.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * /api/debug/* のハンドラ。
 * token が null（EN_DEBUG_TOKEN 未設定）なら常に404。
 * token が設定されていても x-debug-token が一致しなければ404（401にしない。
 * 401だと「パスは存在するが権限がない」ことが漏れるため）。
 *
 * summary の中身・reset-limits の実行は呼び出し側（main.ts）が buildSummary /
 * resetLimits で組み立てる・実行する。RoomManager や AuthApi など他モジュールへの
 * 依存を debug.ts に持ち込まないための設計（auth.ts が debug.ts を import しているため、
 * 逆方向の import は循環依存になる）。
 */
export class DebugApi {
  constructor(
    private readonly token: string | null,
    private readonly recorder: DebugRecorder,
    private readonly buildSummary: () => Record<string, unknown>,
    /**
     * ログイン・登録・プロフィール保存のレート制限をリセットする関数。ip を指定すれば
     * そのIPの枠だけ、省略すれば全IPの枠を消す。呼び出し元（main.ts）で AuthApi が
     * 無い（kv 未設定）ときは null を渡す。
     */
    private readonly resetLimits: ((ip?: string) => ResetLimitsResult) | null = null,
  ) {}

  /** このパスを担当するなら Response を返す。担当外なら null */
  async handle(req: Request, url: URL): Promise<Response | null> {
    if (
      url.pathname !== DEBUG_EVENTS_PATH &&
      url.pathname !== DEBUG_SUMMARY_PATH &&
      url.pathname !== DEBUG_RESET_LIMITS_PATH
    ) {
      return null;
    }
    if (!hasValidDebugToken(req, this.token)) {
      return notFound();
    }
    if (url.pathname === DEBUG_RESET_LIMITS_PATH) {
      return await this.#handleResetLimits(req);
    }
    if (req.method !== "GET") {
      return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
    }
    if (url.pathname === DEBUG_EVENTS_PATH) {
      const limitParam = url.searchParams.get("limit");
      const kindParam = url.searchParams.get("kind");
      const events = this.recorder.list({
        limit: limitParam !== null ? Number(limitParam) : undefined,
        kind: kindParam ?? undefined,
      });
      return jsonNoStore({ events });
    }
    return jsonNoStore(this.buildSummary());
  }

  /**
   * POST /api/debug/reset-limits の実処理。
   * トークン検証は呼び出し元の handle() で済んでいる前提（ここでは行わない）。
   *
   * - GET 等は 405（405 にした理由は他の /api/debug/* エンドポイントや main.ts の
   *   /api/ice・/api/rooms 等と同じ「method not allowed」の流儀に合わせるため。
   *   404 は「トークン不一致・未設定でパスの存在自体を隠す」用途に限定している）
   * - Origin 不一致は 403（§3.8 CSRF対策。main.ts の /api/ 入口と同じ扱い）
   * - 実行したことは必ず DebugRecorder に記録する（誰かが勝手に消したのか
   *   分からなくならないため。detail に対象と消した件数を入れる）
   */
  async #handleResetLimits(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    }
    if (!isAllowedOrigin(req)) {
      this.recorder.record(
        "origin.rejected",
        "デバッグ操作を拒否: Origin がこのサーバーと一致しません",
        { path: DEBUG_RESET_LIMITS_PATH, origin: req.headers.get("origin") ?? "" },
      );
      return new Response("forbidden origin", { status: 403 });
    }
    if (this.resetLimits === null) {
      return jsonNoStore({ error: "auth not configured" }, { status: 501 });
    }

    let ip: string | undefined;
    const rawBody = await req.text();
    if (rawBody.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return jsonNoStore({ error: "リクエストの形式が正しくありません" }, { status: 400 });
      }
      const value = (parsed ?? {}) as { ip?: unknown };
      if (value.ip !== undefined) {
        if (typeof value.ip !== "string" || value.ip.length === 0) {
          return jsonNoStore({ error: "ip は空でない文字列で指定してください" }, {
            status: 400,
          });
        }
        ip = value.ip;
      }
    }

    const cleared = this.resetLimits(ip);
    const scope: "ip" | "all" = ip !== undefined ? "ip" : "all";
    this.recorder.record(
      "debug.resetLimits",
      scope === "ip"
        ? `デバッグ操作: IP ${ip} のレート制限をリセットしました（login:${cleared.login}件, register:${cleared.register}件, profile:${cleared.profile}件）`
        : `デバッグ操作: 全IPのレート制限をリセットしました（login:${cleared.login}件, register:${cleared.register}件, profile:${cleared.profile}件）`,
      {
        scope,
        ip: ip ?? "",
        clearedLogin: cleared.login,
        clearedRegister: cleared.register,
        clearedProfile: cleared.profile,
      },
    );
    return jsonNoStore({ cleared, scope });
  }

  /**
   * /debug.html・/debug.js の静的配信ゲートに使う判定。
   *
   * **あえて x-debug-token の一致は要求しない。EN_DEBUG_TOKEN が設定されているかどうか
   * だけで判定する。** ブラウザは URL を直接開く（トップレベルのナビゲーション）ときに
   * カスタムヘッダを送れないため、ここでトークン一致まで要求すると /debug.html に
   * 到達する手段が無くなり、デバッグ画面そのものが開けなくなる（実際に統合後に発覚した
   * 不具合。二度と同じ間違いを繰り返さないためコメントを残す）。
   *
   * これで安全性は損なわれない:
   *   - debug.html / debug.js に秘密情報は含まれない（画面の骨組みと表示ロジックのみ）
   *   - 画面が開けても、x-debug-token を知らなければ /api/debug/* が404を返すため
   *     中身は一切見えない（実質的な防御は API 側のトークン一致で行う）
   *   - 本番では EN_DEBUG_TOKEN を設定しない運用のため、ファイル自体が配信されない
   */
  isEnabled(): boolean {
    return this.token !== null;
  }
}
