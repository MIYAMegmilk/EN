/**
 * server/main.ts のテスト。
 * /api/ice が TURN 認証情報の有無で正しく応答を変えることを確認する（§3.6 / §3.8）。
 * §6: 本番はリバースプロキシ経由のため、TCP接続元だけでは実クライアントIPが分からない。
 * clientIp は X-Forwarded-For を優先して実クライアントIPを判定する。
 * /api/rooms は稼働中の公開ルームだけを返す（§2 / §4.0）。
 * asC2S は types.ts の C2S 型と同じ t を受理しなければならない（§4.1、末尾の照合テスト）。
 */

import { assert, assertEquals } from "@std/assert";
import { asC2S, C2S_TYPES, clientIp, startServer } from "../main.ts";
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

// ---------------------------------------------------------------------------
// C2S の受理集合の照合（§4.1）
//
// 過去に C2S_TYPES から setBot / endPollVote が抜け落ち、rooms.ts にハンドラがあるのに
// 実際の WebSocket 経由では asC2S に弾かれて機能しない、という不具合が出た。
// rooms_bot_test.ts は RoomManager を直接叩くため main.ts の asC2S を通らず、この齟齬を
// 検出できなかった。TypeScript の型は実行時に列挙できないので、types.ts のソースから
// C2S 型の t を抜き出して C2S_TYPES と集合として突き合わせ、過不足を機械的に検出する。
// ---------------------------------------------------------------------------

/**
 * types.ts のソースから C2S 型の union に現れる t のリテラルを抽出する。
 * S2C 等の t を拾わないよう、`export type C2S =` から次の `export` までに範囲を限定する。
 */
async function c2sTypesFromSource(): Promise<Set<string>> {
  const source = await Deno.readTextFile(new URL("../types.ts", import.meta.url));
  const start = source.indexOf("export type C2S =");
  assert(start >= 0, "types.ts に `export type C2S =` が見つからない（実装変更で抽出が空振り）");
  const after = source.indexOf("\nexport ", start + 1);
  const block = after >= 0 ? source.slice(start, after) : source.slice(start);
  const found = new Set<string>();
  for (const m of block.matchAll(/\bt:\s*"([^"]+)"/g)) found.add(m[1]);
  assert(found.size > 0, "C2S 型から t を1件も抽出できなかった（抽出の正規表現が空振り）");
  return found;
}

Deno.test("C2S_TYPES: types.ts の C2S 型と過不足なく一致する", async () => {
  const declared = await c2sTypesFromSource();
  const missing = [...declared].filter((t) => !C2S_TYPES.has(t));
  const extra = [...C2S_TYPES].filter((t) => !declared.has(t));
  assertEquals(missing, [], `C2S_TYPES に不足している t: ${missing.join(", ")}`);
  assertEquals(extra, [], `C2S 型に存在しないのに C2S_TYPES にある t: ${extra.join(", ")}`);
});

Deno.test("asC2S: types.ts の C2S 型に載っている t はすべて受理する", async () => {
  for (const t of await c2sTypesFromSource()) {
    assert(asC2S({ t }) !== null, `asC2S が ${t} を弾いた（C2S_TYPES に足りていない）`);
  }
});

Deno.test("asC2S: bot の ON/OFF と終了アンケートの投票を受理する（§3.10）", () => {
  assertEquals(asC2S({ t: "setBot", botId: "shunpi", enabled: true }), {
    t: "setBot",
    botId: "shunpi",
    enabled: true,
  });
  assertEquals(asC2S({ t: "setBot", enabled: false }), { t: "setBot", enabled: false });
  assertEquals(asC2S({ t: "endPollVote", pollId: "p1", agree: true }), {
    t: "endPollVote",
    pollId: "p1",
    agree: true,
  });
});

Deno.test("asC2S: 未知の t や t 以外の形は弾く", () => {
  assertEquals(asC2S({ t: "nonexistent" }), null);
  assertEquals(asC2S({ t: 1 }), null);
  assertEquals(asC2S({}), null);
  assertEquals(asC2S(null), null);
  assertEquals(asC2S([{ t: "chat", text: "こんばんは" }]), null);
  assertEquals(asC2S("chat"), null);
});
