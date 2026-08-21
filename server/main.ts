/**
 * サーバーのエントリポイント
 * 詳細仕様書 §3.2 / §3.8 / §4 に対応する。
 *
 *   GET /ws  … WebSocket。全リアルタイム用途を1本で共用する（§3.2）
 *   その他   … public/ の静的配信
 *
 * 軽量スコープ: §4.0 の HTTP API（認証・公開ルーム一覧・スタジオ CRUD）は未実装。
 */

import { serveDir } from "@std/http/file-server";
import { fromFileUrl } from "@std/path";
import { type ClientLink, RoomManager } from "./rooms.ts";
import type { C2S, S2C } from "./types.ts";

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

  constructor(private readonly socket: WebSocket) {}

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

/** WebSocket へアップグレードして RoomManager につなぐ */
function handleWebSocket(req: Request, manager: RoomManager): Response {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket upgrade", { status: 400 });
  }
  if (!isAllowedOrigin(req)) {
    return new Response("forbidden origin", { status: 403 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  const link = new SocketLink(socket);
  socket.onmessage = (event) => {
    const data = event.data;
    if (typeof data !== "string") {
      socket.close(1003, "text frames only");
      return;
    }
    if (exceedsByteLimit(data, MAX_MESSAGE_BYTES)) {
      socket.close(1009, "message too large");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      link.send({ t: "error", code: "INVALID_INPUT", message: "メッセージを解釈できませんでした" });
      return;
    }
    const msg = asC2S(parsed);
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

/** public/ を配信する。serveDir が fsRoot の外へ出ないためパストラバーサルは起きない */
async function handleStatic(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // 招待 URL（/r/{code}）は同じ画面を返す（§2）
  const path = /^\/r\/[0-9]{6}\/?$/.test(url.pathname) ? "/index.html" : url.pathname;
  const rewritten = new Request(new URL(path + url.search, url.origin), req);
  const res = await serveDir(rewritten, { fsRoot: PUBLIC_DIR, quiet: true });
  const headers = new Headers(res.headers);
  for (const [key, value] of SECURITY_HEADERS) headers.set(key, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
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

/** サーバーを起動する。port に 0 を渡すと空きポートを自動で選ぶ */
export function startServer(port = 8000, hostname = "127.0.0.1"): ServerHandle {
  const manager = new RoomManager();
  const server = Deno.serve({ port, hostname, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/ws") return handleWebSocket(req, manager);
    // TODO(チーム分担): §4.0 HTTP API（/api/auth/*, /api/me, /api/rooms, /api/games/*）
    return handleStatic(req);
  });
  return {
    port: (server.addr as Deno.NetAddr).port,
    manager,
    shutdown: async () => {
      manager.dispose();
      await server.shutdown();
    },
  };
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8000");
  const handle = startServer(Number.isInteger(port) && port > 0 ? port : 8000, "0.0.0.0");
  console.log(`宴 -EN- server listening on http://localhost:${handle.port}/`);
}
