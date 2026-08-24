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
import { getCookies } from "@std/http/cookie";
import { AuthApi, SESSION_COOKIE_NAME, verifySession } from "./auth.ts";
import { type ClientLink, RoomManager } from "./rooms.ts";
import { createSenryuDetector } from "./senryu.ts";
import { charLength, hasControlChar } from "./validation.ts";
import {
  type C2S,
  ROOM_CAPACITY,
  type S2C,
  type SandboxGameInfo,
  WS_RATE_MAX,
  WS_RATE_WINDOW_MS,
  WS_SANDBOX_HARD_MAX,
  WS_SANDBOX_RATE_MAX,
  WS_SIGNAL_HARD_MAX,
  WS_SIGNAL_RATE_MAX,
} from "./types.ts";

/** WS メッセージ1件の上限（§3.8 の KV 上限に合わせた 64KB） */
export const MAX_MESSAGE_BYTES = 64 * 1024;

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
  "sandboxStart",
  "sandboxEnd",
  "sandboxSignal",
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
];

/**
 * `/sandbox/` 配下（runner）専用のセキュリティヘッダ
 * （docs/design/game-sandbox.md §2.3 / §2.6 / §7.4）。
 * このページはユーザーコード（第1段はチーム製だが、悪意あるコードを前提に設計する）を
 * 実行するため、アプリ本体の SECURITY_HEADERS とは別の、閉じた CSP を張る。
 * 同じ CSP を runner.html の <meta> にも書く想定だが、正本はこのヘッダー側とする
 * （meta は frame-ancestors を無視する仕様があり、§7.4 のとおりヘッダーでしか効かない）。
 *
 * - `script-src 'self' 'unsafe-eval'`: runner.js の読み込みと、`new Function` による
 *   ゲームコード評価のため（§2.3）。このページの唯一の役目がユーザーコードの実行なので
 *   ここだけ許す
 * - `connect-src 'none'`: fetch / XHR / WebSocket / EventSource / sendBeacon を全面禁止（§2.3）
 * - `worker-src 'none'`: **書き忘れてはならない**。無いと `script-src` にフォールバックし、
 *   `new Worker(...)` が通って Worker 自身の CSP（親の connect-src 'none' を継承しない）
 *   経由で外部通信できてしまう、プロトタイプで実測した穴（§2.4）
 * - `frame-ancestors 'self'`: アプリ本体は全レスポンスに 'none' を付けているため、
 *   このままだと自分のページから自分の runner を iframe に入れられない。
 *   runner だけ 'self' に緩める。同時にこれは「外部サイトが sandbox 属性なしの
 *   `<iframe>` で runner を埋め込み、アプリのオリジンでユーザーコードを走らせる」経路を
 *   塞ぐ、同一オリジン配信（§2.6 B）にとって必須の補償措置でもある（§7.4）
 */
const SANDBOX_SECURITY_HEADERS: ReadonlyArray<[string, string]> = [
  [
    "content-security-policy",
    [
      "default-src 'none'",
      "script-src 'self' 'unsafe-eval'",
      "script-src-elem 'self'",
      "style-src 'unsafe-inline'",
      "img-src data: blob:",
      "connect-src 'none'",
      "worker-src 'none'",
      "child-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join("; "),
  ],
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "no-referrer"],
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

  close(): void {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close(1000, "closed by server");
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

/**
 * クライアントの実IPを求める（§3.8 のレート制限のキーに使う）。
 * 本番は同一VPS上のCaddy/Nginxがリバースプロキシする構成（§6）のため、正規の経路では
 * TCP 接続元（remoteAddrHostname）は常に localhost になる。X-Forwarded-For は送信者が
 * 自由に偽装できるヘッダーなので、TCP 接続元が localhost（＝信頼できるプロキシ経由）の
 * ときだけ信頼する。リバースプロキシを経由しない直接アクセスでは TCP 接続元は偽装できない
 * ため、この場合は X-Forwarded-For を無視して TCP 接続元をそのまま使う。
 */
export function clientIp(req: Request, remoteAddrHostname: string): string {
  const trustedProxy = remoteAddrHostname === "127.0.0.1" || remoteAddrHostname === "::1";
  if (!trustedProxy) return remoteAddrHostname;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded === null) return remoteAddrHostname;
  const first = forwarded.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : remoteAddrHostname;
}

/** WebSocket へアップグレードして RoomManager につなぐ */
async function handleWebSocket(
  req: Request,
  manager: RoomManager,
  kv: Deno.Kv | null,
): Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket upgrade", { status: 400 });
  }
  if (!isAllowedOrigin(req)) {
    return new Response("forbidden origin", { status: 403 });
  }
  // アップグレード時の Cookie でログイン状態を確定する（§3.0: createRoom の認証判定に使う）
  const token = getCookies(req.headers)[SESSION_COOKIE_NAME];
  const userId = kv !== null ? await verifySession(kv, token) : null;
  const { socket, response } = Deno.upgradeWebSocket(req);
  const link = new SocketLink(socket, userId);
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
  // sandboxSignal も rtcSignal と同じ構造の別枠（docs/design/game-sandbox.md §4.3）。
  // WS は全用途1本共用（§3.2）なので、ゲームの高頻度送信で切断するとチャットも
  // 既存ゲーム進行も巻き添えで落ちる。ソフト超過は破棄のみ、ハード超過だけ切断する。
  const sandboxLimiter = new MessageRateLimiter(WS_SANDBOX_RATE_MAX);
  const sandboxHardLimiter = new MessageRateLimiter(WS_SANDBOX_HARD_MAX);
  let sandboxNoticeAt: number | null = null;
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
    const isSandboxSignal = msg !== null && msg.t === "sandboxSignal";
    const windowSec = WS_RATE_WINDOW_MS / 1000;
    // 1003（受理できない種類のデータ）/ 1009（サイズ超過）と区別し、送信ポリシー違反を示す
    // 1008 で閉じる。切断後は onclose → manager.disconnect が走るため、§3.2 の60秒猶予で
    // そのまま再接続できる。
    const disconnect = (max: number) => {
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
        disconnect(WS_SIGNAL_HARD_MAX);
        return;
      }
      if (!withinSoft) {
        // ソフト上限の超過は当該メッセージを破棄するだけで切断しない（§3.6 / §3.8）。
        // 通知は判定窓につき1回に絞り、超過分の件数だけ返信が増えるのを防ぐ。
        const at = Date.now();
        if (signalNoticeAt === null || at - signalNoticeAt >= WS_RATE_WINDOW_MS) {
          signalNoticeAt = at;
          link.send({
            t: "error",
            code: "RATE_LIMITED",
            message:
              `シグナリングの送信が多すぎます（${windowSec}秒に${WS_SIGNAL_RATE_MAX}件まで）。超過分は破棄しました`,
          });
        }
        return;
      }
    } else if (isSandboxSignal) {
      // 両方の枠に記録してから判定する（同じ受信列を別々の上限で数える）
      const withinSoft = sandboxLimiter.accept();
      const withinHard = sandboxHardLimiter.accept();
      if (!withinHard) {
        disconnect(WS_SANDBOX_HARD_MAX);
        return;
      }
      if (!withinSoft) {
        // ソフト上限の超過は当該メッセージを破棄するだけで切断しない
        // （docs/design/game-sandbox.md §4.3）。通知は判定窓につき1回に絞る。
        const at = Date.now();
        if (sandboxNoticeAt === null || at - sandboxNoticeAt >= WS_RATE_WINDOW_MS) {
          sandboxNoticeAt = at;
          link.send({
            t: "error",
            code: "RATE_LIMITED",
            message:
              `サンドボックスゲームの送信が多すぎます（${windowSec}秒に${WS_SANDBOX_RATE_MAX}件まで）。超過分は破棄しました`,
          });
        }
        return;
      }
    } else if (!generalLimiter.accept()) {
      disconnect(WS_RATE_MAX);
      return;
    }
    if (parseFailed) {
      link.send({ t: "error", code: "INVALID_INPUT", message: "メッセージを解釈できませんでした" });
      return;
    }
    if (msg === null) {
      link.send({
        t: "error",
        code: "INVALID_INPUT",
        message: "メッセージの形式が正しくありません",
      });
      return;
    }
    manager.handle(link, msg);
  };
  socket.onclose = () => manager.disconnect(link);
  socket.onerror = () => manager.disconnect(link);
  return response;
}

// ---------------------------------------------------------------------------
// 静的配信
// ---------------------------------------------------------------------------

/**
 * public/ を配信する。serveDir が fsRoot の外へ出ないためパストラバーサルは起きない。
 * トップページはログイン済みなら index.html、未ログインなら login.html を返す。
 */
async function handleStatic(req: Request, kv: Deno.Kv | null): Promise<Response> {
  const url = new URL(req.url);
  let path = url.pathname;
  if (/^\/r\/[0-9]{6}\/?$/.test(url.pathname)) {
    // 招待 URL（/r/{code}）は同じ画面を返す（§2）
    path = "/index.html";
  } else if (url.pathname === "/") {
    const token = getCookies(req.headers)[SESSION_COOKIE_NAME];
    const userId = kv !== null ? await verifySession(kv, token) : null;
    path = userId !== null ? "/index.html" : "/login.html";
  }
  const rewritten = new Request(new URL(path + url.search, url.origin), req);
  const res = await serveDir(rewritten, { fsRoot: PUBLIC_DIR, quiet: true });
  const headers = new Headers(res.headers);
  // /sandbox/ 配下（runner）だけは専用の CSP・frame-ancestors に差し替える
  // （docs/design/game-sandbox.md §2.6 / §7.4）。他のパスは SECURITY_HEADERS のまま
  // （frame-ancestors 'none' を維持し、既存への影響を出さない）
  const securityHeaders = path.startsWith("/sandbox/")
    ? SANDBOX_SECURITY_HEADERS
    : SECURITY_HEADERS;
  for (const [key, value] of securityHeaders) headers.set(key, value);
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

// ---------------------------------------------------------------------------
// サンドボックスゲームのマニフェスト（docs/design/game-sandbox.md §6.2）
// ---------------------------------------------------------------------------

/** マニフェストの id の形式（§6.2） */
const SANDBOX_GAME_ID_RE = /^[a-z0-9_][a-z0-9_-]{0,31}$/;
/** タイトル・作者名の最大文字数（§6.2。§3.5 の title と同じ上限） */
const SANDBOX_NAME_MAX = 20;
/** 説明文の最大文字数（§6.2。§3.5 の description と同じ上限） */
const SANDBOX_DESCRIPTION_MAX = 100;
/** マニフェストに載せられるゲーム数の下限・上限（§6.2） */
const SANDBOX_GAMES_MIN = 1;
const SANDBOX_GAMES_MAX = 50;

/** manifest.json の1件の内部表現。公開型 SandboxGameInfo に dev フラグを足したもの */
type SandboxManifestGame = SandboxGameInfo & { dev: boolean };

/** 文字列フィールドの検証（charLength の範囲・制御文字禁止。§6.2 の title/description/author 共通） */
function isValidSandboxText(value: unknown, min: number, max: number): value is string {
  if (typeof value !== "string") return false;
  const length = charLength(value);
  return length >= min && length <= max && !hasControlChar(value);
}

/**
 * public/games/manifest.json の中身を検証する（§6.2）。
 * 1件でも規則違反があれば null を返す。ファイル I/O を持たない純粋関数なので、
 * ディスクを介さずユニットテストできる。
 */
export function parseSandboxManifest(raw: string): SandboxManifestGame[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) return null;
  const rawGames = obj.games;
  if (
    !Array.isArray(rawGames) || rawGames.length < SANDBOX_GAMES_MIN ||
    rawGames.length > SANDBOX_GAMES_MAX
  ) {
    return null;
  }
  const seenIds = new Set<string>();
  const games: SandboxManifestGame[] = [];
  for (const item of rawGames) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const g = item as Record<string, unknown>;
    if (typeof g.id !== "string" || !SANDBOX_GAME_ID_RE.test(g.id) || seenIds.has(g.id)) {
      return null;
    }
    if (!isValidSandboxText(g.title, 1, SANDBOX_NAME_MAX)) return null;
    if (!isValidSandboxText(g.description, 0, SANDBOX_DESCRIPTION_MAX)) return null;
    if (g.file !== `${g.id}.js`) return null;
    if (
      typeof g.minPlayers !== "number" || !Number.isInteger(g.minPlayers) ||
      g.minPlayers < 1 || g.minPlayers > ROOM_CAPACITY
    ) {
      return null;
    }
    if (
      typeof g.maxPlayers !== "number" || !Number.isInteger(g.maxPlayers) ||
      g.maxPlayers < g.minPlayers || g.maxPlayers > ROOM_CAPACITY
    ) {
      return null;
    }
    if (!isValidSandboxText(g.author, 1, SANDBOX_NAME_MAX)) return null;
    if (g.dev !== undefined && typeof g.dev !== "boolean") return null;
    seenIds.add(g.id);
    games.push({
      id: g.id,
      title: g.title as string,
      description: g.description as string,
      file: g.file,
      minPlayers: g.minPlayers,
      maxPlayers: g.maxPlayers,
      author: g.author as string,
      dev: g.dev === true,
    });
  }
  return games;
}

/**
 * dev:true の項目を EN_SANDBOX_DEV が有効なときだけ残し、公開型 SandboxGameInfo
 * （dev フラグを含まない、クライアントへ配る形）に変換する（§6.2 / §8.2）。
 */
export function filterSandboxGames(
  games: readonly SandboxManifestGame[],
  devEnabled: boolean,
): SandboxGameInfo[] {
  return games
    .filter((g) => devEnabled || !g.dev)
    .map(({ dev: _dev, ...info }) => info);
}

/** public/games/manifest.json の既定の配置場所 */
const SANDBOX_MANIFEST_PATH = fromFileUrl(
  new URL("../public/games/manifest.json", import.meta.url),
);

/**
 * サンドボックスゲームの一覧をディスクから読み込む。
 *
 * 設計書 §6.2 は「検証に失敗したらサーバーは起動しない（fail fast）」だが、本実装では
 * サーバー起動そのものは止めず、読み込み・検証に失敗したら0件（空配列）として扱う判断とした。
 * 理由: 第1段の実装順序（設計書 §9.3）ではサーバー側とフロント（public/games/ 配下）が
 * 並行作業になるため、public/games/manifest.json がまだ存在しない・作業途中で一時的に
 * 壊れている状態でサーバー全体を起動不能にすると、無関係な担当（チャット・VC 等）の
 * 動作確認まで止めてしまう。サンドボックスゲームが0件でも既存機能は成立するため、
 * 500 やサーバー起動失敗ではなく「サンドボックスゲームなし」に縮退させる。
 * この判断は仕様書に明記されていない差分のため、実装報告に明記する。
 */
function loadSandboxManifestGames(path: string): SandboxManifestGame[] {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(path);
  } catch {
    return [];
  }
  const parsed = parseSandboxManifest(raw);
  if (parsed === null) {
    console.warn(
      `sandbox: ${path} の検証に失敗しました。サンドボックスゲームは0件として起動します`,
    );
    return [];
  }
  return parsed;
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
 * sandboxManifestPath はテスト用（public/games/manifest.json 以外のパスを読ませる）。
 * 省略時は既定の配置場所（SANDBOX_MANIFEST_PATH）を読む。
 */
export function startServer(
  port = 8000,
  hostname = "127.0.0.1",
  kv?: Deno.Kv,
  sandboxManifestPath: string = SANDBOX_MANIFEST_PATH,
): ServerHandle {
  // 川柳判定（§3.10 せり）。kuromoji は既定で使う（常駐 +220〜330MB。§6 に見積り）。
  // 初回の判定時に辞書を読み込み、読めるまでは かな のみで判定する。
  // EN_SENRYU_KUROMOJI=0 で かなのみに倒せる。
  // 辞書のない環境では かな のまま動き続ける（createSenryuDetector 参照）
  //
  // サンドボックスゲームのマニフェスト読み込みも環境変数の読込と同じく起動時の1回だけ
  // （docs/design/game-sandbox.md §6.2）。EN_SANDBOX_DEV が "1" のときだけ dev:true の
  // ゲームを有効化する（§8.2: 本番では構造的に起動できないようにする）
  const sandboxDevEnabled = Deno.env.get("EN_SANDBOX_DEV") === "1";
  const sandboxManifestGames = loadSandboxManifestGames(sandboxManifestPath);
  const sandboxGameIds = new Set(
    sandboxManifestGames
      .filter((g) => sandboxDevEnabled || !g.dev)
      .map((g) => g.id),
  );
  const sandboxGamesBody = JSON.stringify({
    games: filterSandboxGames(sandboxManifestGames, sandboxDevEnabled),
  });
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
    sandboxGameIds,
  });
  // 環境変数の読込は起動時の1回だけにする
  const iceBody = JSON.stringify({ iceServers: buildIceServers() });
  const auth = kv !== undefined ? new AuthApi(kv) : null;
  const server = Deno.serve({ port, hostname, onListen: () => {} }, async (req, info) => {
    const url = new URL(req.url);
    if (url.pathname === "/ws") return await handleWebSocket(req, manager, kv ?? null);
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
    // サンドボックスゲーム一覧（docs/design/game-sandbox.md §6.2）。認証不要。
    // マニフェストが無い・壊れている場合も 500 にはせず空配列で応答する
    // （loadSandboxManifestGames 参照）
    if (url.pathname === "/api/sandboxGames") {
      if (req.method !== "GET") {
        return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
      }
      return jsonResponse(sandboxGamesBody);
    }
    if (url.pathname.startsWith("/api/")) {
      if (!isAllowedOrigin(req)) return new Response("forbidden origin", { status: 403 });
      if (auth === null) return new Response("auth not configured", { status: 501 });
      const res = await auth.handle(req, url, clientIp(req, info.remoteAddr.hostname));
      if (res !== null) return res;
      return new Response("not found", { status: 404 });
    }
    // TODO(チーム分担): §4.0 HTTP API（/api/rooms 以外の未実装分）
    return handleStatic(req, kv ?? null);
  });
  return {
    port: (server.addr as Deno.NetAddr).port,
    manager,
    shutdown: async () => {
      manager.dispose();
      auth?.dispose();
      await server.shutdown();
    },
  };
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
}
