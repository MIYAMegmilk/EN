/**
 * 認証 API の結合テスト（§3.0 / §4.0）
 * 実サーバーを空きポートで起動し、fetch で register / login / me / logout を確認する。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { startServer } from "../main.ts";
import { SESSION_COOKIE_NAME } from "../auth.ts";
import type { AuthSession } from "../types.ts";

function randomUserId(): string {
  return "user" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

/** Set-Cookie ヘッダーから Cookie 文字列を取り出す（次のリクエストの Cookie ヘッダーに使う） */
function cookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie");
  assert(raw !== null, "Set-Cookie が返ること");
  return raw.split(";")[0];
}

Deno.test("register → me でログイン状態が確認できる", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();

    const registerRes = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });
    assertEquals(registerRes.status, 200);
    const registerBody = await registerRes.json();
    assertEquals(registerBody.userId, userId);
    const cookie = cookieFrom(registerRes);

    const meRes = await fetch(`${base}/api/me`, { headers: { cookie } });
    assertEquals(meRes.status, 200);
    assertEquals((await meRes.json()).userId, userId);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("me は未ログインだと401", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/me`);
    assertEquals(res.status, 401);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("同じuserIdは二重登録できない", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();
    const payload = JSON.stringify({ userId, password: "correcthorse" });

    const first = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assertEquals(first.status, 200);

    const second = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assertEquals(second.status, 409);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("login は誤ったパスワードを拒否する", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();
    await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });

    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "wrongpassword" }),
    });
    assertEquals(loginRes.status, 401);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("login → logout でセッションが破棄される", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();
    await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });

    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });
    assertEquals(loginRes.status, 200);
    const cookie = cookieFrom(loginRes);

    const logoutRes = await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    assertEquals(logoutRes.status, 200);

    const meRes = await fetch(`${base}/api/me`, { headers: { cookie } });
    assertEquals(meRes.status, 401);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("register は不正なuserId/passwordを拒否する", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;

    const shortUserId = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "ab", password: "correcthorse" }),
    });
    assertEquals(shortUserId.status, 400);

    const shortPassword = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: randomUserId(), password: "short" }),
    });
    assertEquals(shortPassword.status, 400);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("login は1分に5回を超えると429（§3.8）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();
    await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });

    // 誤ったパスワードでの試行もレート制限にカウントされる
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, password: "wrongpassword" }),
      });
      assertEquals(res.status, 401);
    }

    const limited = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });
    assertEquals(limited.status, 429);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("register は1時間に3回を超えると429（§3.8）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: randomUserId(), password: "correcthorse" }),
      });
      assertEquals(res.status, 200);
    }

    const limited = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: randomUserId(), password: "correcthorse" }),
    });
    assertEquals(limited.status, 429);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("me は期限切れセッションを401で拒否する", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();

    const registerRes = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });
    const cookie = cookieFrom(registerRes);
    const token = cookie.slice(SESSION_COOKIE_NAME.length + 1);

    // KV上のセッションを直接書き換えて期限切れにする
    const session: AuthSession = { userId, expiresAt: Date.now() - 1 };
    await kv.set(["authSession", token], session);

    const meRes = await fetch(`${base}/api/me`, { headers: { cookie } });
    assertEquals(meRes.status, 401);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("GET /api/me はプロフィール未保存だとnickname/tagsキーを含まない", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();
    const registerRes = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });
    const cookie = cookieFrom(registerRes);

    const meRes = await fetch(`${base}/api/me`, { headers: { cookie } });
    assertEquals(meRes.status, 200);
    const meBody = await meRes.json();
    assertEquals(meBody.userId, userId);
    assertFalse("nickname" in meBody, "未保存なら nickname キーが無いこと");
    assertFalse("tags" in meBody, "未保存なら tags キーが無いこと");
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("GET /api/tags はプリセットタグ一覧を返す（ログイン不要）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tags`);
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(Array.isArray(body.tags));
    assert(
      body.tags.some((t: { id: string; label: string }) => t.id === "game" && t.label === "ゲーム"),
    );
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PUT /api/profile は未ログインだと401", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "たろう", tags: ["game"] }),
    });
    assertEquals(res.status, 401);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PUT /api/profile: あだ名とタグを保存するとGET /api/meに反映される", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();
    const registerRes = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });
    const cookie = cookieFrom(registerRes);

    const putRes = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ nickname: "たろう", tags: ["game", "pet"] }),
    });
    assertEquals(putRes.status, 200);
    const putBody = await putRes.json();
    assertEquals(putBody.nickname, "たろう");
    assertEquals(putBody.tags, ["game", "pet"]);

    const meRes = await fetch(`${base}/api/me`, { headers: { cookie } });
    const meBody = await meRes.json();
    assertEquals(meBody.userId, userId);
    assertEquals(meBody.nickname, "たろう");
    assertEquals(meBody.tags, ["game", "pet"]);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PUT /api/profile: あだ名の前後の空白はトリムされて保存される", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();
    const registerRes = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });
    const cookie = cookieFrom(registerRes);

    const putRes = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ nickname: "  たろう  ", tags: [] }),
    });
    assertEquals(putRes.status, 200);
    const putBody = await putRes.json();
    assertEquals(putBody.nickname, "たろう");

    const meRes = await fetch(`${base}/api/me`, { headers: { cookie } });
    const meBody = await meRes.json();
    assertEquals(meBody.nickname, "たろう");
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PUT /api/profile は不正なあだ名を400で拒否する", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();
    const registerRes = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });
    const cookie = cookieFrom(registerRes);

    const res = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ nickname: "", tags: [] }),
    });
    assertEquals(res.status, 400);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PUT /api/profile はプリセットにないタグIDを400で拒否する", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();
    const registerRes = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });
    const cookie = cookieFrom(registerRes);

    const res = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ nickname: "たろう", tags: ["not-a-preset"] }),
    });
    assertEquals(res.status, 400);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PUT /api/profile はタグを6個以上指定すると400（§3.11: 最大5個）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();
    const registerRes = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });
    const cookie = cookieFrom(registerRes);

    const res = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        nickname: "たろう",
        tags: ["game", "anime", "manga", "music", "movie", "sports"],
      }),
    });
    assertEquals(res.status, 400);
  } finally {
    await server.shutdown();
    kv.close();
  }
});
