/**
 * GET /api/room-tags・PATCH /api/rooms/:code の結合テスト
 * 実サーバーを空きポートで起動し、fetch と生の WebSocket で確認する。
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { startServer } from "../main.ts";
import type { S2C } from "../types.ts";

/** 使い捨てユーザーを登録し、セッション Cookie を返す */
async function registerCookie(base: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: "u" + crypto.randomUUID().replace(/-/g, "").slice(0, 10),
      password: "correcthorse",
    }),
  });
  assertEquals(res.status, 200);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  assertExists(cookie);
  return cookie;
}

/** cookie でログイン済みとして公開ルームを1件作り、6桁コードを返す */
function createPublicRoom(port: number, cookie: string, roomName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // deno-lint-ignore no-explicit-any
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } } as any);
    const timer = setTimeout(
      () => reject(new Error("roomState を待機中にタイムアウトしました")),
      5_000,
    );
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data) as S2C;
      if (msg.t === "roomState") {
        clearTimeout(timer);
        socket.close();
        resolve(msg.snapshot.code);
      }
    };
    socket.onopen = () => {
      socket.send(
        JSON.stringify({ t: "createRoom", nickname: "ホスト", visibility: "public", roomName }),
      );
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket接続に失敗しました"));
    };
  });
}

Deno.test("GET /api/room-tags: ログイン不要でプリセット一覧を返す", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/room-tags`);
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(Array.isArray(body.tags));
    assert(body.tags.length > 0);
    assert(typeof body.tags[0].id === "string");
    assert(typeof body.tags[0].label === "string");
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PATCH /api/rooms/:code: オーナーが説明文・タグを設定でき、一覧に反映される", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const cookie = await registerCookie(base);
    const code = await createPublicRoom(server.port, cookie, "金曜の反省会");

    const patchRes = await fetch(`${base}/api/rooms/${code}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ description: "ゆるく飲みます", tags: ["casual_chat"] }),
    });
    assertEquals(patchRes.status, 200);
    const patchBody = await patchRes.json();
    assertEquals(patchBody.description, "ゆるく飲みます");
    assertEquals(patchBody.tags, ["casual_chat"]);

    const listRes = await fetch(`${base}/api/rooms`);
    const listBody = await listRes.json();
    const room = listBody.rooms.find((r: { code: string }) => r.code === code);
    assertExists(room);
    assertEquals(room.description, "ゆるく飲みます");
    assertEquals(room.tags, ["casual_chat"]);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PATCH /api/rooms/:code: 未ログインは401", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const cookie = await registerCookie(base);
    const code = await createPublicRoom(server.port, cookie, "金曜の反省会");

    const res = await fetch(`${base}/api/rooms/${code}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "", tags: [] }),
    });
    assertEquals(res.status, 401);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PATCH /api/rooms/:code: オーナー以外は403", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const ownerCookie = await registerCookie(base);
    const code = await createPublicRoom(server.port, ownerCookie, "金曜の反省会");
    const otherCookie = await registerCookie(base);

    const res = await fetch(`${base}/api/rooms/${code}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: otherCookie },
      body: JSON.stringify({ description: "乗っ取り", tags: [] }),
    });
    assertEquals(res.status, 403);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PATCH /api/rooms/:code: 存在しないコードは404", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const cookie = await registerCookie(base);

    const res = await fetch(`${base}/api/rooms/000000`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ description: "", tags: [] }),
    });
    assertEquals(res.status, 404);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PATCH /api/rooms/:code: プリセット外のタグは400", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const cookie = await registerCookie(base);
    const code = await createPublicRoom(server.port, cookie, "金曜の反省会");

    const res = await fetch(`${base}/api/rooms/${code}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ description: "", tags: ["no-such-tag"] }),
    });
    assertEquals(res.status, 400);
  } finally {
    await server.shutdown();
    kv.close();
  }
});
