/**
 * server/main.ts のテスト。
 * /api/ice が TURN 認証情報の有無で正しく応答を変えることを確認する（§3.6 / §3.8）。
 * §6: 本番はリバースプロキシ経由のため、TCP接続元だけでは実クライアントIPが分からない。
 * clientIp は X-Forwarded-For を優先して実クライアントIPを判定する。
 * /api/rooms は稼働中の公開ルームだけを返す（§2 / §4.0）。
 */

import { assert, assertEquals } from "@std/assert";
import { clientIp, startServer } from "../main.ts";
import type { ClientLink } from "../rooms.ts";
import type { PublicRoomSummary, S2C } from "../types.ts";

/** 受信内容を捨てるだけの接続。ルームを立てる副作用だけが要るテストで使う */
class MockLink implements ClientLink {
  readonly id = crypto.randomUUID();
  constructor(readonly userId: string | null = "testUser") {}
  send(_msg: S2C): void {}
  close(): void {}
}

/** 読み取る環境変数 */
const TURN_KEYS = ["TURN_URL", "TURN_USER", "TURN_PASS"] as const;

/** 応答に載る ICE サーバー1件 */
type IceServer = { urls: string; username?: string; credential?: string };

/** 既定で必ず載る STUN */
const STUN: IceServer = { urls: "stun:stun.l.google.com:19302" };

/**
 * 指定した環境変数だけを立てた状態でサーバーを起動し、/api/ice を叩く。
 * 作業ディレクトリを空の一時ディレクトリへ移し、開発者の `.env` に影響されないようにする。
 */
async function fetchIce(
  values: Partial<Record<(typeof TURN_KEYS)[number], string>>,
  method = "GET",
): Promise<{ status: number; headers: Headers; body: string }> {
  const saved = TURN_KEYS.map((key) => [key, Deno.env.get(key)] as const);
  const cwd = Deno.cwd();
  const temp = await Deno.makeTempDir();
  Deno.chdir(temp);
  for (const key of TURN_KEYS) Deno.env.delete(key);
  for (const [key, value] of Object.entries(values)) Deno.env.set(key, value);
  const handle = startServer(0);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/ice`, { method });
    return { status: res.status, headers: res.headers, body: await res.text() };
  } finally {
    await handle.shutdown();
    Deno.chdir(cwd);
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(temp, { recursive: true });
  }
}

Deno.test("/api/ice: TURN 未設定なら STUN のみを返す", async () => {
  const res = await fetchIce({});
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/json; charset=utf-8");
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(JSON.parse(res.body), { iceServers: [STUN] });
});

Deno.test("/api/ice: TURN が3つ揃えば TURN も返す", async () => {
  const res = await fetchIce({
    TURN_URL: "turn:turn.example.test:3478",
    TURN_USER: "en-user",
    TURN_PASS: "en-pass",
  });
  assertEquals(res.status, 200);
  assertEquals(JSON.parse(res.body), {
    iceServers: [
      STUN,
      {
        urls: "turn:turn.example.test:3478",
        username: "en-user",
        credential: "en-pass",
      },
    ],
  });
});

Deno.test("/api/ice: TURN が一部だけなら載せない", async () => {
  const res = await fetchIce({ TURN_URL: "turn:turn.example.test:3478", TURN_USER: "en-user" });
  assertEquals(JSON.parse(res.body), { iceServers: [STUN] });
});

Deno.test("/api/ice: 空文字の TURN 設定は無視する", async () => {
  const res = await fetchIce({ TURN_URL: "  ", TURN_USER: "en-user", TURN_PASS: "en-pass" });
  assertEquals(JSON.parse(res.body), { iceServers: [STUN] });
});

Deno.test("/api/ice: GET 以外は 405", async () => {
  const res = await fetchIce({}, "POST");
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "GET");
});

Deno.test("clientIp: X-Forwarded-For があれば先頭のIPを使う（リバースプロキシ配下）", () => {
  const req = new Request("http://example.com/", {
    headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
  });
  assertEquals(clientIp(req, "127.0.0.1"), "203.0.113.5");
});

Deno.test("clientIp: X-Forwarded-For が無ければ TCP 接続元を使う", () => {
  const req = new Request("http://example.com/");
  assertEquals(clientIp(req, "127.0.0.1"), "127.0.0.1");
});

Deno.test("clientIp: 空文字の X-Forwarded-For は TCP 接続元にフォールバックする", () => {
  const req = new Request("http://example.com/", {
    headers: { "x-forwarded-for": "" },
  });
  assertEquals(clientIp(req, "127.0.0.1"), "127.0.0.1");
});

Deno.test("clientIp: 先頭要素の前後の空白を取り除く", () => {
  const req = new Request("http://example.com/", {
    headers: { "x-forwarded-for": "  203.0.113.5  , 10.0.0.1" },
  });
  assertEquals(clientIp(req, "127.0.0.1"), "203.0.113.5");
});

Deno.test("clientIp: ::1 からの接続も信頼済みプロキシとして扱う", () => {
  const req = new Request("http://example.com/", {
    headers: { "x-forwarded-for": "203.0.113.5" },
  });
  assertEquals(clientIp(req, "::1"), "203.0.113.5");
});

Deno.test("clientIp: プロキシ（localhost）以外からの直接接続は X-Forwarded-For を偽装されても無視する", () => {
  const req = new Request("http://example.com/", {
    headers: { "x-forwarded-for": "203.0.113.5" },
  });
  assertEquals(clientIp(req, "198.51.100.9"), "198.51.100.9");
});

// ---------------------------------------------------------------------------
// 公開ルーム一覧（§4.0 GET /api/rooms）
// ---------------------------------------------------------------------------

Deno.test("/api/rooms: 公開ルームが無ければ空配列を返す", async () => {
  const handle = startServer(0);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/rooms`);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("cache-control"), "no-store");
    assertEquals(await res.json(), { rooms: [] });
  } finally {
    await handle.shutdown();
  }
});

Deno.test("/api/rooms: 稼働中の公開ルームを返し、招待制は載せない", async () => {
  const handle = startServer(0);
  const link = new MockLink("owner1");
  try {
    handle.manager.handle(link, {
      t: "createRoom",
      nickname: "ホスト",
      visibility: "public",
      roomName: "とりあえず生",
    });
    handle.manager.handle(new MockLink("owner2"), {
      t: "createRoom",
      nickname: "ホスト",
      visibility: "private",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/rooms`);
    const body = await res.json() as { rooms: PublicRoomSummary[] };
    assertEquals(body.rooms.length, 1);
    assertEquals(body.rooms[0].roomName, "とりあえず生");
    assertEquals(body.rooms[0].playerCount, 1);
    assert(/^[0-9]{6}$/.test(body.rooms[0].code));
  } finally {
    await handle.shutdown();
  }
});

Deno.test("/api/rooms: GET 以外は 405", async () => {
  const handle = startServer(0);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/rooms`, { method: "POST" });
    assertEquals(res.status, 405);
    await res.body?.cancel();
  } finally {
    await handle.shutdown();
  }
});
