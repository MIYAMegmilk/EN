/**
 * サーバーのエントリポイント
 * 詳細仕様書 §3.2 / §3.8 / §4 に対応する。
 *
 *   GET /ws       … WebSocket。全リアルタイム用途を1本で共用する（§3.2）
 *   GET /api/ice  … WebRTC の ICE サーバー設定（§3.6）
 *   その他        … public/ の静的配信
 *
 * 軽量スコープ: §4.0 の HTTP API のうち認証（/api/auth/*, /api/me）は実装済み。
 * 公開ルーム一覧・スタジオ CRUD は未実装。
 */

import { loadSync } from "@std/dotenv";
import { serveDir } from "@std/http/file-server";
import { fromFileUrl } from "@std/path";
import { getCookies } from "@std/http/cookie";
import { AuthApi, SESSION_COOKIE_NAME, verifySession } from "./auth.ts";
import { type ClientLink, RoomManager } from "./rooms.ts";
import {
  type C2S,
  type S2C,
  WS_RATE_MAX,
  WS_RATE_WINDOW_MS,
  WS_SIGNAL_HARD_MAX,
  WS_SIGNAL_RATE_MAX,
} from "./types.ts";

/** WS メッセージ1件の上限（§3.8 の KV 上限に合わせた 64KB） */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** 静的配信のルート */
const PUBLIC_DIR = fromFileUrl(new URL("../public/", import.meta.url));

/** 受理する C2S の t 一覧。未知の t は INVALID_INPUT で弾く */
const C2S_TYPES: ReadonlySet<string> = new Set([
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
  "rtcSignal",
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
 * 本番は VPS上のリバースプロキシ経由（§6）のため、TCP 接続元（remoteAddrHostname）は
 * 常にプロキシのアドレスになる。プロキシが付与する X-Forwarded-For の先頭値を優先する。
 */
export function clientIp(req: Request, remoteAddrHostname: string): string {
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
  for (const [key, value] of SECURITY_HEADERS) headers.set(key, value);
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

/** 起動時に作った応答本文をそのまま返す。認証情報を含むため保存させない */
function iceResponse(body: string): Response {
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
  const manager = new RoomManager();
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
      return iceResponse(iceBody);
    }
    if (url.pathname.startsWith("/api/")) {
      if (!isAllowedOrigin(req)) return new Response("forbidden origin", { status: 403 });
      if (auth === null) return new Response("auth not configured", { status: 501 });
      const res = await auth.handle(req, url, clientIp(req, info.remoteAddr.hostname));
      if (res !== null) return res;
      return new Response("not found", { status: 404 });
    }
    // TODO(チーム分担): §4.0 HTTP API（/api/rooms, /api/games/*）
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
  const kv = await Deno.openKv();
  const handle = startServer(Number.isInteger(port) && port > 0 ? port : 8000, "0.0.0.0", kv);
  console.log(`宴 -EN- server listening on http://localhost:${handle.port}/`);
}
