/**
 * サーバーのエントリポイント
 * 詳細仕様書 §3.2 / §3.8 / §4 に対応する。
 *
 *   GET /ws        … WebSocket。全リアルタイム用途を1本で共用する（§3.2）
 *   GET /api/ice   … WebRTC の ICE サーバー設定（§3.6）
 *   GET /api/rooms … 稼働中の公開ルーム一覧（§4.0。認証不要・10秒ポーリング）
 *   その他         … public/ の静的配信
 *
 * 軽量スコープ: §4.0 の HTTP API のうち認証（/api/auth/*, /api/me）、公開ルーム一覧、
 * 軽量プロフィール（GET /api/tags, PUT /api/profile、§3.11）は実装済み。
 * スタジオ CRUD は未実装。
 */

import { loadSync } from "@std/dotenv";
import { serveDir } from "@std/http/file-server";
import { fromFileUrl } from "@std/path";
import { AuthApi, sessionToken, verifySession } from "./auth.ts";
import {
  DEBUG_EVENTS_PATH,
  DEBUG_RESET_LIMITS_PATH,
  DEBUG_SUMMARY_PATH,
  DebugApi,
  DebugRecorder,
} from "./debug.ts";
import {
  type ClientLink,
  RoomManager,
  roomPhaseOf,
  SHUTDOWN_CLOSE_CODE,
  SHUTDOWN_CLOSE_REASON,
  validateRoomDescription,
} from "./rooms.ts";
import { isValidRoomTagId, ROOM_TAGS, type RoomTagId } from "./room_tags.ts";
import { createSenryuDetector } from "./senryu.ts";
import {
  type C2S,
  ROOM_TAGS_MAX,
  type S2C,
  WS_GAME_EVENT_HARD_MAX,
  WS_GAME_EVENT_RATE_MAX,
  WS_RATE_MAX,
  WS_RATE_WINDOW_MS,
  WS_SIGNAL_HARD_MAX,
  WS_SIGNAL_RATE_MAX,
} from "./types.ts";

/** WS メッセージ1件の上限（§3.8 の KV 上限に合わせた 64KB） */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * デバッグ画面を構成する静的ファイル（public/debug.html・public/debug.js）。
 * EN_DEBUG_TOKEN が無効、または x-debug-token が不一致のときは、この2つとも
 * 「存在しない」ように404にする（handleStatic 参照）。
 */
const DEBUG_STATIC_PATHS: ReadonlySet<string> = new Set(["/debug.html", "/debug.js"]);

/** 静的配信のルート */
const PUBLIC_DIR = fromFileUrl(new URL("../public/", import.meta.url));

/**
 * 受理する C2S の t 一覧。未知の t は INVALID_INPUT で弾く。
 * types.ts の C2S 型と過不足があってはならない（server/tests/main_test.ts で機械的に照合する）。
 */
export const C2S_TYPES: ReadonlySet<string> = new Set([
  "createRoom",
  "join",
  "knock",
  "approveKnock",
  "rejectKnock",
  "kick",
  "selectGame",
  "startGame",
  "skipPhase",
  "submitInput",
  "submitVote",
  "importGame",
  "chat",
  "voice",
  "setBot",
  "endPollVote",
  "rtcSignal",
  "gameEvent",
  "joinQueue",
  "leaveQueue",
  "leave",
]);

/**
 * 静的配信に付けるセキュリティヘッダ（§3.8）。
 * connect-src は default-src 'self' に従うため、同一オリジンの WebSocket は許可される。
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
  /*
   * 画面取得・カメラ・マイクを自分のオリジンにだけ許す
   * （docs/design/vc-screenshare.md §9-2）。
   * display-capture の既定の許可リストはもともと self なので、この行は
   * 挙動を変えない。**変えないことに意味がある**: 明示しておけば、将来
   * 誰かが埋め込みや iframe を足したときに、既定値の解釈に頼らずこの1行を
   * 読んで判断できる。アプリ本体は frame-ancestors 'none' なので
   * 第三者に埋め込まれる経路自体が無く、これはその補強にあたる。
   */
  ["permissions-policy", "display-capture=(self), camera=(self), microphone=(self)"],
];

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/** WebSocket を ClientLink として扱うためのラッパー */
class SocketLink implements ClientLink {
  readonly id = crypto.randomUUID();

  constructor(private readonly socket: WebSocket, readonly userId: string | null) {}

  send(msg: S2C): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(msg));
  }

  /**
   * 接続を閉じる。既定は 1000（正常終了・退室やキック）。
   * サーバー停止時だけ rooms.ts の dispose() が 1001（going away）を渡してくる
   */
  close(code = 1000, reason = "closed by server"): void {
    // 閉じ済み・閉じかけのソケットに close() を呼ぶと例外になり得るので触らない
    if (this.socket.readyState === WebSocket.CLOSED) return;
    if (this.socket.readyState === WebSocket.CLOSING) return;
    this.socket.close(code, reason);
  }
}

/** UTF-8 バイト数が上限を超えるか。全走査を避けるため長さで先に判定する */
export function exceedsByteLimit(text: string, limit: number): boolean {
  // UTF-16 の1コード単位は UTF-8 で最大3バイト（サロゲートペアは2単位で4バイト）
  if (text.length > limit) return true;
  if (text.length * 3 <= limit) return false;
  return new TextEncoder().encode(text).length > limit;
}

/**
 * WS メッセージのレート制限（§3.8: 1接続あたり 20件/秒 を超えたら切断）。
 * 1接続につき用途ごとに1個を持ち、直近 WS_RATE_WINDOW_MS 以内の受信時刻だけをスライディング
 * ウィンドウとして保持する。判定窓内の上限 max はコンストラクタで受け取る（一般枠は
 * WS_RATE_MAX、rtcSignal 枠はソフト上限 WS_SIGNAL_RATE_MAX とハードキャップ
 * WS_SIGNAL_HARD_MAX の2個）。
 * 時刻もコンストラクタで注入でき、テストから固定できる。
 */
export class MessageRateLimiter {
  /** 判定窓内に受信した時刻（古い順、epoch ms） */
  private readonly times: number[] = [];

  constructor(
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * メッセージ1件を受信したものとして記録し、受理してよいかを返す。
   * false は制限超過（＝窓内 max 件を「超えた」件）。超過時の処置は呼び出し側が決める
   * （一般枠と rtcSignal のハードキャップは切断、rtcSignal のソフト上限は破棄）。
   */
  accept(): boolean {
    const at = this.now();
    // 窓から外れた時刻は捨ててメモリを増やさない（handleChat と同じ「経過 < 窓」を窓内とする）
    while (this.times.length > 0 && at - this.times[0] >= WS_RATE_WINDOW_MS) this.times.shift();
    this.times.push(at);
    return this.times.length <= this.max;
  }
}

/** JSON.parse 済みの値を C2S として受理できるか判定する */
export function asC2S(value: unknown): C2S | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const t = (value as { t?: unknown }).t;
  if (typeof t !== "string" || !C2S_TYPES.has(t)) return null;
  return value as C2S;
}

/** Origin ヘッダが同一オリジンか（§3.8 CSRF）。ヘッダ無しのクライアントは許可する */
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

/** 信頼するプロキシ段数を指定する環境変数。`.env` でも環境変数でもよい */
const TRUSTED_PROXY_HOPS_ENV = "EN_TRUSTED_PROXY_HOPS";

/**
 * 信頼するプロキシ段数の既定値。§6 の構成（同一VPS上の Caddy/Nginx が1段）に合わせる。
 * 1 なら X-Forwarded-For の**右端の1件**＝直前のプロキシが自分で追記した値を採る。
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

/** 段数の上限。これを超える値は設定ミスとみなして既定値へ倒す */
const MAX_TRUSTED_PROXY_HOPS = 16;

/**
 * `EN_TRUSTED_PROXY_HOPS` の値を段数として解釈する。
 * 0〜16 の十進整数だけを受理し、それ以外（空・負数・小数・非数値・上限超過）は null を返す。
 * 0 は「X-Forwarded-For を一切信頼しない（TCP 接続元をそのまま使う）」の意味。
 */
export function parseTrustedProxyHops(raw: string | null | undefined): number | null {
  const value = (raw ?? "").trim();
  if (!/^\d{1,2}$/.test(value)) return null;
  const hops = Number(value);
  return hops <= MAX_TRUSTED_PROXY_HOPS ? hops : null;
}

/**
 * 起動時に段数を1回だけ読む（`.env` → 環境変数の順。TURN や kuromoji と同じ流儀）。
 * 未設定は既定値、壊れた値は警告のうえ既定値に倒す（安全側は「右端に寄せる」方）。
 */
export function trustedProxyHops(): number {
  let dotenv: Record<string, string> = {};
  try {
    dotenv = loadSync({ export: false });
  } catch {
    // .env を読めない環境（権限なし等）では環境変数だけを使う
  }
  const raw = (dotenv[TRUSTED_PROXY_HOPS_ENV] ?? Deno.env.get(TRUSTED_PROXY_HOPS_ENV) ?? "").trim();
  if (raw === "") return DEFAULT_TRUSTED_PROXY_HOPS;
  const hops = parseTrustedProxyHops(raw);
  if (hops === null) {
    console.warn(
      `${TRUSTED_PROXY_HOPS_ENV}: "${raw}" は 0〜${MAX_TRUSTED_PROXY_HOPS} の整数ではありません。` +
        `既定値 ${DEFAULT_TRUSTED_PROXY_HOPS} を使います`,
    );
    return DEFAULT_TRUSTED_PROXY_HOPS;
  }
  return hops;
}

/**
 * IPv4 のドット10進表記か検証し、正規形（そのまま）を返す。妥当でなければ null。
 * `01.2.3.4` のような先頭ゼロは、同じアドレスが別キーになるのを避けるため受理しない。
 */
function normalizeIpv4(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    if (Number(part) > 255) return null;
  }
  return parts.join(".");
}

/** IPv6 の8グループ（各16bit）を RFC 5952 の正規形へ整える */
function renderIpv6(groups: number[]): string {
  // IPv4 射影アドレス（::ffff:a.b.c.d）は RFC 5952 §5 のとおり混在表記のまま出す
  if (groups[5] === 0xffff && groups.slice(0, 5).every((g) => g === 0)) {
    const a = groups[6] >> 8, b = groups[6] & 0xff, c = groups[7] >> 8, d = groups[7] & 0xff;
    return `::ffff:${a}.${b}.${c}.${d}`;
  }
  // 最長の0連続（長さ2以上）を1か所だけ "::" に畳む。同長なら最初の並びを選ぶ
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      const len = i - runStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}

/**
 * IPv6 のテキスト表記を検証し、正規形（小文字・0畳み込み済み）を返す。妥当でなければ null。
 * ゾーンID付き（`fe80::1%eth0`）はプロキシが書く値として想定しないので受理しない。
 */
function normalizeIpv6(value: string): string | null {
  const lower = value.trim().toLowerCase();
  if (lower === "" || lower.includes("%")) return null;
  const halves = lower.split("::");
  if (halves.length > 2) return null;
  /** ":" 区切りの片側を16bitグループ列へ。末尾側だけ IPv4 混在表記を許す */
  const parseSide = (side: string, allowIpv4Tail: boolean): number[] | null => {
    if (side === "") return [];
    const items = side.split(":");
    const groups: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.includes(".")) {
        if (!allowIpv4Tail || i !== items.length - 1) return null;
        const v4 = normalizeIpv4(item);
        if (v4 === null) return null;
        const [a, b, c, d] = v4.split(".").map(Number);
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
      groups.push(Number.parseInt(item, 16));
    }
    return groups;
  };
  if (halves.length === 1) {
    const groups = parseSide(halves[0], true);
    if (groups === null || groups.length !== 8) return null;
    return renderIpv6(groups);
  }
  const head = parseSide(halves[0], false);
  const tail = parseSide(halves[1], true);
  if (head === null || tail === null) return null;
  // "::" は1グループ以上の0を表す（RFC 4291）。7グループ以下でなければ畳めていない
  if (head.length + tail.length > 7) return null;
  const filled = [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
  return renderIpv6(filled);
}

/**
 * X-Forwarded-For の1要素を IP として検証し、レート制限のキーに使う正規形を返す。
 * 妥当でなければ null（呼び出し側が TCP 接続元へ倒す）。
 *
 * 実装によってポート付きで書かれることがあるため、次の形を受理してポートを落とす:
 * `1.2.3.4` / `1.2.3.4:5678` / `2001:db8::1` / `[2001:db8::1]` / `[2001:db8::1]:443`。
 * RFC 7239 の難読化識別子（`_hidden`）や `unknown` は IP ではないので弾く。
 */
export function normalizeForwardedIp(value: string): string | null {
  const text = value.trim();
  if (text === "") return null;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) return null;
    const rest = text.slice(close + 1);
    if (rest !== "" && !/^:\d{1,5}$/.test(rest)) return null;
    return normalizeIpv6(text.slice(1, close));
  }
  const colons = text.split(":").length - 1;
  if (colons === 0) return normalizeIpv4(text);
  if (colons === 1) {
    const cut = text.indexOf(":");
    if (!/^\d{1,5}$/.test(text.slice(cut + 1))) return null;
    return normalizeIpv4(text.slice(0, cut));
  }
  return normalizeIpv6(text);
}

/**
 * クライアントの実IPを求める（§3.8 のレート制限のキーに使う）。
 *
 * 本番は同一VPS上の Caddy/Nginx がリバースプロキシする構成（§6）のため、正規の経路では
 * TCP 接続元（remoteAddrHostname）は常に localhost になる。つまり「TCP 接続元が localhost
 * なら信頼する」だけでは何の防御にもならない（全リクエストが該当する）。
 *
 * X-Forwarded-For は**左から順に古い**（左端＝送信者が名乗った値＝偽装し放題、右端＝直前の
 * プロキシが自分で見た TCP 接続元）。Caddy の reverse_proxy は既定でクライアントから届いた
 * 値を置き換えず**追記**するため、左端を採ると攻撃者が毎回別IPを名乗ってレート制限を
 * すり抜けられる。そこで**右端から hops 段目**（既定1＝右端）を実クライアントとして採る。
 * Cloudflare → Caddy のように前段が複数あるときは EN_TRUSTED_PROXY_HOPS で段数を増やす。
 *
 * 次のいずれかでは X-Forwarded-For を使わず TCP 接続元へ倒す（安全側＝キーが1つに寄って
 * 制限が厳しくなる方。攻撃者が決めた値をキーにするより望ましい）:
 * - TCP 接続元が localhost でない（リバースプロキシを経由しない直接アクセス）
 * - hops が 0（プロキシを信頼しない設定）
 * - ヘッダーが無い / 要素数が hops に満たない（＝プロキシが期待どおり追記していない）
 * - 採った要素が IP として妥当でない
 */
export function clientIp(
  req: Request,
  remoteAddrHostname: string,
  hops: number = DEFAULT_TRUSTED_PROXY_HOPS,
): string {
  const trustedProxy = remoteAddrHostname === "127.0.0.1" || remoteAddrHostname === "::1";
  if (!trustedProxy) return remoteAddrHostname;
  if (!Number.isInteger(hops) || hops < 1) return remoteAddrHostname;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded === null) return remoteAddrHostname;
  // 同名ヘッダーが複数あっても Headers.get が ", " で連結するので、この分割で全段を見られる
  const parts = forwarded.split(",");
  if (parts.length < hops) return remoteAddrHostname;
  return normalizeForwardedIp(parts[parts.length - hops]) ?? remoteAddrHostname;
}

/**
 * WebSocket へアップグレードして RoomManager につなぐ。
 * live には生きている接続を登録する。RoomManager が把握しているのはルームに入った接続
 * だけで、ロビーで待っている接続（app.js はページを開いた直後に繋ぎに来るので、
 * 実際にはこちらの方が多い）は含まれない。停止時にどのコードで閉じるかを Deno.serve の
 * shutdown() 任せにせず、自分たちで 1001 を明示するためにここで持つ
 */
async function handleWebSocket(
  req: Request,
  manager: RoomManager,
  kv: Deno.Kv | null,
  debug: DebugRecorder,
  live: Set<ClientLink>,
): Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket upgrade", { status: 400 });
  }
  if (!isAllowedOrigin(req)) {
    debug.record("origin.rejected", "WS接続を拒否: Origin がこのサーバーと一致しません", {
      path: "/ws",
      origin: req.headers.get("origin") ?? "",
    });
    return new Response("forbidden origin", { status: 403 });
  }
  // アップグレード時の Cookie でログイン状態を確定する（§3.0: createRoom の認証判定に使う）。
  // 壊れた Cookie ヘッダーは sessionToken が undefined に倒すので、未ログインとして接続は通る
  const token = sessionToken(req);
  const userId = kv !== null ? await verifySession(kv, token) : null;
  const { socket, response } = Deno.upgradeWebSocket(req);
  const link = new SocketLink(socket, userId);
  live.add(link);
  // レート制限は「1接続あたり」の規定（§3.8）だが、用途で枠を分ける。VC のシグナリング
  // （§3.6）はフルメッシュの trickle ICE が短時間に集中するため、一般枠（20件/秒）では
  // 正当な利用者を切断してしまう。rtcSignal だけは別枠（100件/秒）で数える。
  const generalLimiter = new MessageRateLimiter(WS_RATE_MAX);
  // signal 枠は2段構え。ソフト上限（100件/秒）の超過は当該メッセージを破棄するだけで
  // 切断しない。WS は全用途1本共用（§3.2）なので、ここで切断するとチャットもゲーム進行も
  // 巻き添えで落ちるが、VC は §3.6 のとおりフォールバックできるため破棄で足りる。
  // ハードキャップ（500件/秒）の超過だけは乱用とみなして切断する。
  const signalLimiter = new MessageRateLimiter(WS_SIGNAL_RATE_MAX);
  const signalHardLimiter = new MessageRateLimiter(WS_SIGNAL_HARD_MAX);
  // ソフト上限超過を最後に通知した時刻（epoch ms）。未通知は null。
  // 超過1件ごとに RATE_LIMITED を返すとエラーの増幅になる（100件を超えて送られた分だけ
  // 返信が増える）ため、判定窓（WS_RATE_WINDOW_MS）につき最大1回だけ通知する。
  let signalNoticeAt: number | null = null;
  // gameEvent は rtcSignal と同じ構造の別枠（設計書 docs/design/games-unified.md §2.2 / §9.3）。
  // お絵かき当てのようなリアルタイム描画は毎秒10件前後のチャンクを送るため、
  // 一般枠（20件/秒。他の操作と共用）では正当な描き手を切断してしまう。
  // ソフト超過は破棄のみ・通知は判定窓1回、ハード超過だけ切断する
  const gameEventLimiter = new MessageRateLimiter(WS_GAME_EVENT_RATE_MAX);
  const gameEventHardLimiter = new MessageRateLimiter(WS_GAME_EVENT_HARD_MAX);
  let gameEventNoticeAt: number | null = null;
  socket.onmessage = (event) => {
    const data = event.data;
    if (typeof data !== "string") {
      socket.close(1003, "text frames only");
      return;
    }
    // サイズ超過はパース前の安価な判定なので先に置く
    if (exceedsByteLimit(data, MAX_MESSAGE_BYTES)) {
      socket.close(1009, "message too large");
      return;
    }
    // どちらの枠で数えるかの判断に t が要るため、レート判定より先にパースする。
    // ガベージ連投では JSON.parse のコストを切断前に払うことになるが、1件 64KB 上限 ×
    // 21件（rtcSignal を名乗る場合も WS_SIGNAL_HARD_MAX + 1 件）で切断されるため
    // 許容範囲とする。
    let parsed: unknown = null;
    let parseFailed = false;
    try {
      parsed = JSON.parse(data);
    } catch {
      parseFailed = true;
    }
    const msg = parseFailed ? null : asC2S(parsed);
    // rtcSignal と確定したものだけを signal 枠へ回す。壊れた JSON や未知の t は必ず
    // 一般枠で数える（数えないとガベージの連投を切断できなくなるため）。
    // ルーム参加前の連打も「1接続あたり」の規定どおり一般枠で数える。
    const isSignal = msg !== null && msg.t === "rtcSignal";
    // gameEvent と確定したものだけを別枠へ回す（壊れた JSON・未知の t は必ず一般枠）
    const isGameEvent = msg !== null && msg.t === "gameEvent";
    const windowSec = WS_RATE_WINDOW_MS / 1000;
    // 1003（受理できない種類のデータ）/ 1009（サイズ超過）と区別し、送信ポリシー違反を示す
    // 1008 で閉じる。切断後は onclose → manager.disconnect が走るため、§3.2 の60秒猶予で
    // そのまま再接続できる。
    const disconnect = (max: number, bucket: string) => {
      debug.record(
        "ws.rateLimited",
        `WS切断: ${bucket}枠のレート制限（${windowSec}秒に${max}件）を超えたため切断しました`,
        { bucket, max },
      );
      link.send({
        t: "error",
        code: "RATE_LIMITED",
        message: `メッセージの送信が多すぎます（${windowSec}秒に${max}件まで）`,
      });
      socket.close(1008, "rate limited");
    };
    if (isSignal) {
      // 両方の枠に記録してから判定する（同じ受信列を別々の上限で数える）
      const withinSoft = signalLimiter.accept();
      const withinHard = signalHardLimiter.accept();
      if (!withinHard) {
        disconnect(WS_SIGNAL_HARD_MAX, "rtcSignal-hard");
        return;
      }
      if (!withinSoft) {
        // ソフト上限の超過は当該メッセージを破棄するだけで切断しない（§3.6 / §3.8）。
        // 通知は判定窓につき1回に絞り、超過分の件数だけ返信が増えるのを防ぐ。
        // デバッグ記録も同じタイミングに絞る（そうしないと連投のたびにリングバッファを
        // 消費し、他の有用なイベントを押し出してしまうため）。
        const at = Date.now();
        if (signalNoticeAt === null || at - signalNoticeAt >= WS_RATE_WINDOW_MS) {
          signalNoticeAt = at;
          debug.record(
            "ws.rateLimited",
            `WS破棄: rtcSignal枠のソフト上限（${windowSec}秒に${WS_SIGNAL_RATE_MAX}件）を超えたため以降のメッセージを破棄します`,
            { bucket: "rtcSignal-soft", max: WS_SIGNAL_RATE_MAX },
          );
          link.send({
            t: "error",
            code: "RATE_LIMITED",
            message:
              `シグナリングの送信が多すぎます（${windowSec}秒に${WS_SIGNAL_RATE_MAX}件まで）。超過分は破棄しました`,
          });
        }
        return;
      }
    } else if (isGameEvent) {
      // 両方の枠に記録してから判定する（同じ受信列を別々の上限で数える）
      const withinSoft = gameEventLimiter.accept();
      const withinHard = gameEventHardLimiter.accept();
      if (!withinHard) {
        disconnect(WS_GAME_EVENT_HARD_MAX, "gameEvent-hard");
        return;
      }
      if (!withinSoft) {
        // ソフト上限の超過は当該メッセージを破棄するだけで切断しない（設計書 §9.3）。
        // WS は全用途1本共用（§3.2）なので、ここで切断するとチャットも VC も巻き添えになる。
        // 通知は判定窓につき1回に絞り、超過分の件数だけ返信が増えるのを防ぐ
        const at = Date.now();
        if (gameEventNoticeAt === null || at - gameEventNoticeAt >= WS_RATE_WINDOW_MS) {
          gameEventNoticeAt = at;
          debug.record(
            "ws.rateLimited",
            `WS破棄: gameEvent枠のソフト上限（${windowSec}秒に${WS_GAME_EVENT_RATE_MAX}件）を超えたため以降のメッセージを破棄します`,
            { bucket: "gameEvent-soft", max: WS_GAME_EVENT_RATE_MAX },
          );
          link.send({
            t: "error",
            code: "RATE_LIMITED",
            message:
              `ゲームの送信が多すぎます（${windowSec}秒に${WS_GAME_EVENT_RATE_MAX}件まで）。超過分は破棄しました`,
          });
        }
        return;
      }
    } else if (!generalLimiter.accept()) {
      disconnect(WS_RATE_MAX, "general");
      return;
    }
    if (parseFailed) {
      link.send({ t: "error", code: "INVALID_INPUT", message: "メッセージを解釈できませんでした" });
      return;
    }
    if (msg === null) {
      debug.record("ws.unknownType", "WS受信: 未知または不正な形式のメッセージを拒否しました", {
        t: typeof (parsed as { t?: unknown } | null)?.t === "string"
          ? (parsed as { t: string }).t
          : "",
      });
      link.send({
        t: "error",
        code: "INVALID_INPUT",
        message: "メッセージの形式が正しくありません",
      });
      return;
    }
    manager.handle(link, msg);
  };
  socket.onclose = () => {
    live.delete(link);
    manager.disconnect(link);
  };
  socket.onerror = () => {
    live.delete(link);
    manager.disconnect(link);
  };
  return response;
}

// ---------------------------------------------------------------------------
// 静的配信
// ---------------------------------------------------------------------------

/**
 * public/ を配信する。serveDir が fsRoot の外へ出ないためパストラバーサルは起きない。
 * トップページはログイン済みなら entrance.html、未ログインなら login.html を返す。
 */
async function handleStatic(
  req: Request,
  kv: Deno.Kv | null,
  debugApi: DebugApi,
): Promise<Response> {
  const url = new URL(req.url);
  // デバッグ画面（public/debug.html・public/debug.js の2ファイル）は EN_DEBUG_TOKEN が
  // 未設定のときだけ「存在しない」ように404を返す（無効を示す応答にしない）。
  //
  // ここは x-debug-token の一致を **あえて** 要求しない（DebugApi.isEnabled 参照）。
  // ブラウザは URL を直接開く（トップレベルのナビゲーション）ときにカスタムヘッダを
  // 送れないため、ここでトークン一致まで要求すると /debug.html に到達する手段が無くなり
  // デバッグ画面そのものが開けなくなる。実質的な防御は /api/debug/* 側のトークン一致で行う
  // （画面が開けても、トークンを知らなければ API が404を返すので中身は見えない）。
  if (DEBUG_STATIC_PATHS.has(url.pathname) && !debugApi.isEnabled()) {
    return new Response("not found", { status: 404 });
  }
  let path = url.pathname;
  // "/" の中身はログイン状態（Cookie）で変わるため、ブラウザにキャッシュさせない。
  // これが無いと、ログアウト後に "/" を開いてもキャッシュされた entrance.html が
  // そのまま返ってしまう（ログイン状態が変わったことにブラウザは気づけない）
  const isSessionDependent = url.pathname === "/";
  if (/^\/r\/[0-9]{6}\/?$/.test(url.pathname)) {
    // 招待 URL（/r/{code}）は同じ画面を返す（§2）
    path = "/index.html";
  } else if (isSessionDependent) {
    // 壊れた Cookie ヘッダーでトップページが 500 にならないよう、取り出しは sessionToken に任せる
    const token = sessionToken(req);
    const userId = kv !== null ? await verifySession(kv, token) : null;
    path = userId !== null ? "/entrance.html" : "/login.html";
  }
  const rewritten = new Request(new URL(path + url.search, url.origin), req);
  const res = await serveDir(rewritten, { fsRoot: PUBLIC_DIR, quiet: true });
  const headers = new Headers(res.headers);
  for (const [key, value] of SECURITY_HEADERS) headers.set(key, value);
  if (isSessionDependent) headers.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ---------------------------------------------------------------------------
// ICE サーバー設定（§3.6）
// ---------------------------------------------------------------------------

/** 常に配る公開 STUN */
const STUN_URL = "stun:stun.l.google.com:19302";

/** RTCIceServer として配る1件 */
export type IceServer = {
  urls: string;
  username?: string;
  credential?: string;
};

/**
 * ICE サーバー一覧を組み立てる。
 * TURN 認証情報は `.env`（無ければ環境変数）から読み、3つ揃ったときだけ載せる。
 * 値は /api/ice の応答以外に出さない（ログにも残さない §3.8）。
 */
export function buildIceServers(): IceServer[] {
  let dotenv: Record<string, string> = {};
  try {
    dotenv = loadSync({ export: false });
  } catch {
    // .env を読めない環境（権限なし等）では環境変数だけを使う
  }
  const read = (key: string): string => (dotenv[key] ?? Deno.env.get(key) ?? "").trim();
  const servers: IceServer[] = [{ urls: STUN_URL }];
  const urls = read("TURN_URL");
  const username = read("TURN_USER");
  const credential = read("TURN_PASS");
  if (urls !== "" && username !== "" && credential !== "") {
    servers.push({ urls, username, credential });
  }
  return servers;
}

/** kuromoji を倒すための環境変数。`.env` でも環境変数でもよい */
const KUROMOJI_ENV = "EN_SENRYU_KUROMOJI";

/** これらを設定したときだけ kuromoji を使わない。それ以外はすべて既定（使う） */
const KUROMOJI_OFF_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * 川柳判定（§3.10 せり）で kuromoji を使うかどうか。**既定は ON**。
 *
 * kuromoji の辞書はサーバープロセスに常駐して +220〜330MB になる（senryu.ts の実測）。
 * 4GB プラン（§6）に対して約 10%、かつルーム数に比例しない一度きりの定数なので既定で使う。
 * かなのみに倒すと せり が漢字混じりを拾えず、bot-voice.md の文字起こしが実質発火しない。
 *
 * メモリが問題になったときに再デプロイなしで倒せるよう、逃げ道だけ環境変数に出しておく。
 * `EN_SENRYU_KUROMOJI=0`（false / off / no も可）で かなのみに戻る。
 */
export function useKuromojiSenryu(): boolean {
  let dotenv: Record<string, string> = {};
  try {
    dotenv = loadSync({ export: false });
  } catch {
    // .env を読めない環境（権限なし等）では環境変数だけを使う
  }
  const value = (dotenv[KUROMOJI_ENV] ?? Deno.env.get(KUROMOJI_ENV) ?? "").trim().toLowerCase();
  return !KUROMOJI_OFF_VALUES.has(value);
}

/** JSON をそのまま返す。TURN 認証情報や在室人数を含むため保存させない */
function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

/** JSON のエラー応答を返す */
function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * GET /api/debug/summary の中身を組み立てる。
 * RoomManager の**既存の公開メソッド**（roomCount / listPublicRooms / getRoom）で取れる
 * 範囲にとどめる（rooms.ts は変更しないという制約のため）。
 *
 * 制約により省いた情報（rooms.ts に手を入れられないため取得手段がない）:
 *   - 招待制（visibility: "private"）ルームは rooms 一覧に出てこない。全ルームを列挙する
 *     公開メソッドが無く、公開ルームだけを返す listPublicRooms() 経由でしか一覧を得られない
 *     ため。roomCount（総ルーム数）は招待制ルームも含むので rooms.length と一致しないことがある。
 */
function buildDebugSummary(manager: RoomManager, startedAt: number): Record<string, unknown> {
  const now = Date.now();
  const rooms = manager.listPublicRooms().map((summary) => {
    const room = manager.getRoom(summary.code);
    return {
      code: summary.code,
      playerCount: summary.playerCount,
      phase: room === undefined ? "lobby" : roomPhaseOf(room),
    };
  });
  return {
    uptimeMs: now - startedAt,
    serverTime: now,
    roomCount: manager.roomCount,
    rooms,
  };
}

// ---------------------------------------------------------------------------
// サーバー起動
// ---------------------------------------------------------------------------

/** 起動中のサーバー */
export type ServerHandle = {
  /** 待ち受けポート */
  port: number;
  /** ルーム管理層 */
  manager: RoomManager;
  /** 停止する（タイマーもすべて解除する） */
  shutdown: () => Promise<void>;
};

/**
 * サーバーを起動する。port に 0 を渡すと空きポートを自動で選ぶ。
 * kv を省略すると認証 API は 501 を返し、WS 側もログイン済みと判定できないため
 * createRoom は常に AUTH_REQUIRED になる（本番では必ず kv を渡す）。
 */
export function startServer(
  port = 8000,
  hostname = "127.0.0.1",
  kv?: Deno.Kv,
): ServerHandle {
  // 川柳判定（§3.10 せり）。kuromoji は既定で使う（常駐 +220〜330MB。§6 に見積り）。
  // 初回の判定時に辞書を読み込み、読めるまでは かな のみで判定する。
  // EN_SENRYU_KUROMOJI=0 で かなのみに倒せる。
  // 辞書のない環境では かな のまま動き続ける（createSenryuDetector 参照）
  const manager = new RoomManager({
    senryu: createSenryuDetector({
      kuromoji: useKuromojiSenryu(),
      onReady: (provider) => {
        console.log(
          provider === null
            ? "senryu: kuromoji を読み込めませんでした。かなのみで判定します"
            : "senryu: kuromoji を読み込みました（漢字混じりの句も拾います）",
        );
      },
    }),
  });
  // 環境変数の読込は起動時の1回だけにする
  const iceBody = JSON.stringify({ iceServers: buildIceServers() });
  // デバッグ機能（オーナー困りごと: 「どこでログインがはじかれているのかわからない」への対応）。
  // EN_DEBUG_TOKEN が設定されているときだけ有効。空文字（未設定 or 空値）は無効扱いにする。
  const debugToken = (Deno.env.get("EN_DEBUG_TOKEN") ?? "").trim();
  // 信頼するプロキシ段数も起動時の1回だけ読む（clientIp が X-Forwarded-For を右から数える段数）
  const proxyHops = trustedProxyHops();
  const debugEnabled = debugToken !== "";
  const debug = new DebugRecorder(debugEnabled);
  const startedAt = Date.now();
  // 生きている WebSocket 接続。停止時に 1001 で閉じるために持つ（handleWebSocket 参照）
  const liveLinks = new Set<ClientLink>();
  const auth = kv !== undefined ? new AuthApi(kv, debug) : null;
  const debugApi = new DebugApi(
    debugEnabled ? debugToken : null,
    debug,
    () => buildDebugSummary(manager, startedAt),
    auth !== null ? (ip?: string) => auth.resetRateLimits(ip) : null,
  );
  const server = Deno.serve({ port, hostname, onListen: () => {} }, async (req, info) => {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      return await handleWebSocket(req, manager, kv ?? null, debug, liveLinks);
    }
    if (url.pathname === "/api/ice") {
      if (req.method !== "GET") {
        return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
      }
      return jsonResponse(iceBody);
    }
    // 公開ルーム一覧（§4.0）。認証不要・10秒ポーリング前提なのでキャッシュさせない
    if (url.pathname === "/api/rooms") {
      if (req.method !== "GET") {
        return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
      }
      return jsonResponse(JSON.stringify({ rooms: manager.listPublicRooms() }));
    }
    // プリセット部屋タグ一覧（ログイン不要）
    if (url.pathname === "/api/room-tags") {
      if (req.method !== "GET") {
        return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
      }
      return jsonResponse(JSON.stringify({ tags: ROOM_TAGS }));
    }
    // 卓の説明文・タグの更新（オーナー本人のみ）
    const roomMetaMatch = /^\/api\/rooms\/([0-9]{6})$/.exec(url.pathname);
    if (roomMetaMatch !== null) {
      if (req.method !== "PATCH") {
        return new Response("method not allowed", { status: 405, headers: { allow: "PATCH" } });
      }
      if (!isAllowedOrigin(req)) {
        debug.record(
          "origin.rejected",
          "APIリクエストを拒否: Origin がこのサーバーと一致しません",
          {
            path: url.pathname,
            origin: req.headers.get("origin") ?? "",
          },
        );
        return new Response("forbidden origin", { status: 403 });
      }
      if (kv === undefined) return new Response("auth not configured", { status: 501 });
      const token = sessionToken(req);
      const userId = await verifySession(kv, token);
      if (userId === null) {
        debug.record(
          "session.invalid",
          "セッションが無効です（未ログイン・期限切れ・不正なCookie）",
          { path: url.pathname },
        );
        return jsonError(401, "ログインしていません");
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonError(400, "リクエストの形式が正しくありません");
      }
      const { description, tags } = (body ?? {}) as { description?: unknown; tags?: unknown };
      const descriptionResult = validateRoomDescription(description);
      if (!descriptionResult.ok) {
        return jsonError(400, descriptionResult.message);
      }
      if (!Array.isArray(tags) || !tags.every(isValidRoomTagId)) {
        return jsonError(400, "タグはプリセットの中から選んでください");
      }
      const uniqueTags = [...new Set(tags as RoomTagId[])];
      if (uniqueTags.length > ROOM_TAGS_MAX) {
        return jsonError(400, `タグは${ROOM_TAGS_MAX}個以内で選んでください`);
      }

      const result = manager.setRoomMeta(roomMetaMatch[1], userId, {
        description: descriptionResult.value,
        tags: uniqueTags,
      });
      if (!result.ok) {
        return jsonError(
          result.status,
          result.status === 404 ? "ルームが見つかりません" : "この卓のオーナーのみ変更できます",
        );
      }
      return jsonResponse(JSON.stringify({ description: result.description, tags: result.tags }));
    }
    // デバッグ用API（§ オーナー困りごと対応）。Origin検証より前に判定する。無効時・トークン
    // 不一致時は常に404（debug.ts 参照。存在自体を伏せるため、Origin不一致の403とは分けない）。
    // reset-limits だけは POST 限定・Origin検証ありだが、その判定も debug.ts 側で行う
    // （トークン一致より前に Origin 不一致を理由にパスの存在を漏らさないため）。
    if (
      url.pathname === DEBUG_EVENTS_PATH ||
      url.pathname === DEBUG_SUMMARY_PATH ||
      url.pathname === DEBUG_RESET_LIMITS_PATH
    ) {
      return (await debugApi.handle(req, url)) ?? new Response("not found", { status: 404 });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!isAllowedOrigin(req)) {
        debug.record(
          "origin.rejected",
          "APIリクエストを拒否: Origin がこのサーバーと一致しません",
          {
            path: url.pathname,
            origin: req.headers.get("origin") ?? "",
          },
        );
        return new Response("forbidden origin", { status: 403 });
      }
      if (auth === null) return new Response("auth not configured", { status: 501 });
      const res = await auth.handle(
        req,
        url,
        clientIp(req, info.remoteAddr.hostname, proxyHops),
      );
      if (res !== null) return res;
      return new Response("not found", { status: 404 });
    }
    // TODO(チーム分担): §4.0 HTTP API（/api/rooms 以外の未実装分）
    return handleStatic(req, kv ?? null, debugApi);
  });
  return {
    port: (server.addr as Deno.NetAddr).port,
    manager,
    shutdown: async () => {
      // ルームに入っている接続はここで 1001 で閉じられる（rooms.ts の dispose 参照）
      manager.dispose();
      // ロビーで待っているだけの接続は RoomManager が知らないので、ここで閉じる。
      // server.shutdown() も接続を閉じるが、そのクローズコードは Deno の実装依存なので、
      // クライアントの再接続判断（app.js）が頼る 1001 は自分たちで送る
      for (const link of liveLinks) {
        try {
          link.close(SHUTDOWN_CLOSE_CODE, SHUTDOWN_CLOSE_REASON);
        } catch {
          // 1本の失敗で残りの切断を止めない
        }
      }
      liveLinks.clear();
      auth?.dispose();
      await server.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// 終了処理（SIGTERM / SIGINT）
// ---------------------------------------------------------------------------

/**
 * 後始末が終わるのを待つ上限。これを過ぎたら諦めて終了する。
 * 「終了しないサービス」は systemd に SIGKILL される分だけ強制終了より悪いので、
 * 必ず自力で終わる保険を置く
 */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

/** createShutdownHandler の差し替え口（テスト用） */
export type ShutdownHandlerOptions = {
  /** 後始末の本体。startServer が返す handle.shutdown を渡す */
  shutdown: () => Promise<void>;
  /** プロセスを終了する。テストでは呼ばれたことだけ記録する */
  exit?: (code: number) => void;
  /** ログ出力 */
  log?: (message: string) => void;
  /** 保険のタイムアウト（ms） */
  timeoutMs?: number;
};

/**
 * 終了シグナルを受けたときの処理を作る。
 *
 * シグナルの購読そのものは OS 依存で自動テストしづらいため、ハンドラの「中身」だけを
 * ここに切り出し、返した関数を直接呼んでテストできるようにしている。
 *
 * ここで終了コードを 0 にすることが本題。シグナルをハンドルしないと Deno は
 * SIGTERM の既定動作で死に、systemd には status=143（128+15）＝失敗として記録される
 */
export function createShutdownHandler(
  options: ShutdownHandlerOptions,
): (signal: string) => Promise<void> {
  const exit = options.exit ?? ((code: number) => Deno.exit(code));
  const log = options.log ?? ((message: string) => console.log(message));
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  // 連続してシグナルが来ても後始末は1回だけ走らせる
  let started = false;
  return async (signal: string) => {
    if (started) return;
    started = true;
    log(`${signal} を受け取りました。接続を閉じて終了します`);
    // 後始末がハングしても必ず終わるようにする。
    // unref しておくのは、正常に終わるときにこのタイマーがプロセスを引き止めないため
    const guard = setTimeout(() => {
      log(`後始末が ${timeoutMs}ms で終わらないため強制終了します`);
      exit(0);
    }, timeoutMs);
    Deno.unrefTimer(guard);
    try {
      await options.shutdown();
    } catch (err) {
      // 後始末で転んでも終了はする。ここで止まると再起動が完了しない
      log(`後始末でエラーが出ましたが終了します: ${err}`);
    }
    clearTimeout(guard);
    exit(0);
  };
}

/**
 * 終了シグナルを購読し、実際に購読できたものを返す。
 *
 * Windows では SIGTERM を購読できず、Deno.addSignalListener("SIGTERM", ...) は例外を
 * 投げる（Windows がサポートするのは SIGINT と SIGBREAK）。開発機が Windows なので、
 * ここで例外が漏れると deno task dev が起動しなくなる。OS で購読する集合を分けたうえで、
 * 将来の Deno / OS の差異でも落ちないよう try/catch でも受け止める
 */
export function listenShutdownSignals(
  handler: (signal: string) => void,
  addListener: (signal: Deno.Signal, fn: () => void) => void = Deno.addSignalListener,
  os: string = Deno.build.os,
): Deno.Signal[] {
  const wanted: Deno.Signal[] = os === "windows" ? ["SIGINT", "SIGBREAK"] : ["SIGTERM", "SIGINT"];
  const registered: Deno.Signal[] = [];
  for (const signal of wanted) {
    try {
      addListener(signal, () => handler(signal));
      registered.push(signal);
    } catch (err) {
      // 購読できないシグナルがあっても起動そのものは続ける（購読できた分だけで動く）
      console.error(`シグナル ${signal} を購読できませんでした: ${err}`);
    }
  }
  return registered;
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8000");
  // KV_PATH で保存先を指定できるようにする。未設定なら undefined が渡り、従来どおり
  // Deno の既定位置（~/.cache/deno/ 配下）になる。既定位置はキャッシュ扱いのディレクトリ
  // のため、deno のキャッシュ削除や OS の掃除で消える可能性がある。本番はアカウント・
  // 認証セッション・ゲーム定義・共有コードを失わないよう永続ディレクトリを指定する。
  const kv = await Deno.openKv(Deno.env.get("KV_PATH"));
  const handle = startServer(Number.isInteger(port) && port > 0 ? port : 8000, "127.0.0.1", kv);
  console.log(`宴 -EN- server listening on http://localhost:${handle.port}/`);
  // 川柳判定がどちらのモードで動くかは起動時に見えるようにしておく（§6）
  console.log(
    useKuromojiSenryu()
      ? `senryu: 初回の発言で kuromoji の辞書を読み込みます（常駐 +220〜330MB。${KUROMOJI_ENV}=0 で無効化）`
      : `senryu: かなのみで判定します。漢字混じりの句は拾いません（${KUROMOJI_ENV}）`,
  );
  // systemd の restart で毎回 status=143（SIGTERM で強制終了）にならないよう、
  // シグナルを受けて自分で片付けてから終了コード 0 で終わる
  listenShutdownSignals(createShutdownHandler({
    shutdown: async () => {
      await handle.shutdown();
      // KV はここ（import.meta.main）で開いたので、閉じるのもここの責任
      try {
        kv.close();
      } catch {
        // 既に閉じていても終了は続ける
      }
    },
  }));
}
