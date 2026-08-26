/**
 * 認証 API の結合テスト（§3.0 / §4.0）
 * 実サーバーを空きポートで起動し、fetch で register / login / me / logout を確認する。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { startServer } from "../main.ts";
import { SESSION_COOKIE_NAME } from "../auth.ts";
import { DEBUG_TOKEN_HEADER } from "../debug.ts";
import type { AuthSession, User } from "../types.ts";

function randomUserId(): string {
  return "user" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

/**
 * `kv.get()` が値を返した直後にフックを差し込む Deno.Kv のラッパー（テスト専用）。
 *
 * 楽観ロックの検査対象は「読み出してから書き戻すまでの間に別の書き込みが入ったら409」という
 * 性質そのものなので、その隙間に確実に別の書き込みを割り込ませるために使う。
 * 本番コードには一切手を入れず、`startServer` へ渡す Deno.Kv を差し替えるだけで成立させる
 * （サーバーは受け取った Deno.Kv をそのまま使うので、テストからは境界がここしかない）。
 *
 * get 以外のメソッドは元の kv に束縛して素通しする（Proxy 越しに呼ぶと Deno.Kv 内部の
 * プライベートフィールドへアクセスできず壊れるため、必ず bind してから返す）。
 *
 * 注意: このラッパーはキーの絞り込みをせず、すべての get でフックを呼ぶ。
 * どのキーに反応するかはフック側で判定すること（例: `key[0] !== "user"` なら何もしない）。
 * 絞らずに書き込みを差し込むと、セッション検証など無関係な読み出しにも割り込んでしまう。
 */
function kvWithGetHook(kv: Deno.Kv, hook: (key: Deno.KvKey) => Promise<void>): Deno.Kv {
  return new Proxy(kv, {
    get(target, prop) {
      if (prop === "get") {
        return async (key: Deno.KvKey, options?: { consistency?: Deno.KvConsistencyLevel }) => {
          const entry = await target.get(key, options);
          await hook(key);
          return entry;
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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

Deno.test("register: 不正なJSONを3回送っても枠を消費せず4回目の正しい登録が成功する（§3.8）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid json",
      });
      assertEquals(res.status, 400);
    }

    const ok = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: randomUserId(), password: "correcthorse" }),
    });
    assertEquals(ok.status, 200);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("register: 形式不正なuserIdを3回送っても枠を消費せず4回目の正しい登録が成功する（§3.8）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "ab", password: "correcthorse" }),
      });
      assertEquals(res.status, 400);
    }

    const ok = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: randomUserId(), password: "correcthorse" }),
    });
    assertEquals(ok.status, 200);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("register: 形式不正なpasswordを3回送っても枠を消費せず4回目の正しい登録が成功する（§3.8）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: randomUserId(), password: "short" }),
      });
      assertEquals(res.status, 400);
    }

    const ok = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: randomUserId(), password: "correcthorse" }),
    });
    assertEquals(ok.status, 200);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("register: 登録成功3件のあと4件目は429（§3.8、成功は数える）", async () => {
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

Deno.test("register: userId重複を3回試したあと4件目は429（§3.8、重複は数える）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();
    const payload = JSON.stringify({ userId, password: "correcthorse" });

    // 対象のuserIdを作るのは別IPで行い、テスト対象IPの枠を消費しないようにする
    const setup = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "10.1.0.1",
      },
      body: payload,
    });
    assertEquals(setup.status, 200);

    const dupHeaders = {
      "content-type": "application/json",
      "x-forwarded-for": "10.1.0.2",
    };

    for (let i = 0; i < 3; i++) {
      const dup = await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: dupHeaders,
        body: payload,
      });
      assertEquals(dup.status, 409);
    }

    // 重複3回で10.1.0.2の枠を使い切っているので、新規userIdでも429になる
    const limited = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: dupHeaders,
      body: JSON.stringify({ userId: randomUserId(), password: "correcthorse" }),
    });
    assertEquals(limited.status, 429);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("register: 別IPの枠は独立している（§3.8、回帰）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const base = `http://127.0.0.1:${server.port}`;

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "10.0.0.1",
        },
        body: JSON.stringify({ userId: randomUserId(), password: "correcthorse" }),
      });
      assertEquals(res.status, 200);
    }

    const sameIpLimited = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.1",
      },
      body: JSON.stringify({ userId: randomUserId(), password: "correcthorse" }),
    });
    assertEquals(sameIpLimited.status, 429);

    const otherIpOk = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.2",
      },
      body: JSON.stringify({ userId: randomUserId(), password: "correcthorse" }),
    });
    assertEquals(otherIpOk.status, 200);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

// ---------------------------------------------------------------------------
// 壊れた Cookie ヘッダーの扱い（回帰）
//
// `getCookies()` は空文字・空白のみ・`"; ;"`・`"=abc"` の Cookie ヘッダーで例外を投げる。
// セッションの取り出しが素の `getCookies()` だったころは、この例外がそのまま外まで抜けて
// 認証不要のまま誰でも 500 を踏める状態だった。Cookie が無いのと同じ扱いになること。
// ---------------------------------------------------------------------------

/**
 * サーバーまで届く「壊れた Cookie ヘッダー」。
 * 空白のみのものは送信の途中で "" に詰められるが、いずれも getCookies が例外を投げる値。
 */
const BROKEN_COOKIES = ["", "   ", "; ;", "=abc"];

// どのCookieでどのエンドポイントが落ちたかを取り違えないよう、組み合わせごとに1件ずつ立てる。
// サーバーの起こし方（:memory: の KV → startServer → try/finally で後始末）は他のテストと同じ。
for (const cookie of BROKEN_COOKIES) {
  const label = JSON.stringify(cookie);

  Deno.test(`GET /api/me は壊れたCookie ${label} を500ではなく401で返す（回帰）`, async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/me`, {
        headers: { cookie },
      });
      await res.body?.cancel();
      assertEquals(res.status, 401);
    } finally {
      await server.shutdown();
      kv.close();
    }
  });

  Deno.test(`POST /api/auth/logout は壊れたCookie ${label} でも500にならない（回帰）`, async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/auth/logout`, {
        method: "POST",
        headers: { cookie },
      });
      await res.body?.cancel();
      // logout は消すセッションが無いだけなので、未ログインでも従来どおり200で終わる
      assertEquals(res.status, 200);
    } finally {
      await server.shutdown();
      kv.close();
    }
  });

  Deno.test(`PUT /api/profile は壊れたCookie ${label} を500ではなく401で返す（回帰）`, async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/profile`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ nickname: "たろう", tags: ["game"] }),
      });
      await res.body?.cancel();
      assertEquals(res.status, 401);
    } finally {
      await server.shutdown();
      kv.close();
    }
  });
}

// ---------------------------------------------------------------------------
// PUT /api/profile のレート制限（IPごとに30件/分・暫定値）
// ---------------------------------------------------------------------------

Deno.test("PUT /api/profile: 上限の30件/分を超えると429（暫定値）", async () => {
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
    // 登録の枠（3件/時）と混ざらないよう、プロフィール保存だけ別IPから送る
    const headers = {
      "content-type": "application/json",
      cookie,
      "x-forwarded-for": "10.2.0.1",
    };
    const body = JSON.stringify({ nickname: "たろう", tags: [] });

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/api/profile`, { method: "PUT", headers, body });
      assertEquals(res.status, 200, `${i + 1}件目までは上限内なので通ること`);
      await res.body?.cancel();
    }

    const limited = await fetch(`${base}/api/profile`, { method: "PUT", headers, body });
    assertEquals(limited.status, 429);
    assert(typeof (await limited.json()).error === "string", "error メッセージが返ること");
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PUT /api/profile: 上限内（30件目）までは保存でき、GET /api/meに反映される", async () => {
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
    const headers = {
      "content-type": "application/json",
      cookie,
      "x-forwarded-for": "10.2.0.2",
    };

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/api/profile`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ nickname: `たろう${i}`, tags: ["game"] }),
      });
      assertEquals(res.status, 200, `${i + 1}件目は上限内なので通ること`);
      await res.body?.cancel();
    }

    const meRes = await fetch(`${base}/api/me`, { headers: { cookie } });
    assertEquals(meRes.status, 200);
    assertEquals((await meRes.json()).nickname, "たろう29", "30件目の内容が保存されていること");
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PUT /api/profile: レート制限の枠はIPごとに独立している（§3.8、回帰）", async () => {
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
    const body = JSON.stringify({ nickname: "たろう", tags: [] });
    const firstIp = { "content-type": "application/json", cookie, "x-forwarded-for": "10.2.1.1" };
    const secondIp = { "content-type": "application/json", cookie, "x-forwarded-for": "10.2.1.2" };

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/api/profile`, { method: "PUT", headers: firstIp, body });
      assertEquals(res.status, 200);
      await res.body?.cancel();
    }

    const sameIpLimited = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers: firstIp,
      body,
    });
    assertEquals(sameIpLimited.status, 429);
    await sameIpLimited.body?.cancel();

    const otherIpProfileOk = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers: secondIp,
      body,
    });
    assertEquals(otherIpProfileOk.status, 200, "別IPの枠は消費されていないこと");
    await otherIpProfileOk.body?.cancel();
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PUT /api/profile: 429で弾かれたリクエストはあだ名・タグを書き換えない", async () => {
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
    const headers = {
      "content-type": "application/json",
      cookie,
      "x-forwarded-for": "10.2.2.1",
    };

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/api/profile`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ nickname: "さいしょ", tags: [] }),
      });
      assertEquals(res.status, 200);
      await res.body?.cancel();
    }

    const limited = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ nickname: "うわがき", tags: ["game"] }),
    });
    assertEquals(limited.status, 429);
    await limited.body?.cancel();

    const meBody = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    assertEquals(meBody.nickname, "さいしょ", "429のリクエストは保存されていないこと");
    assertEquals(meBody.tags, [], "タグも書き換わっていないこと");
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PUT /api/profile: 未ログインのリクエストも枠を消費する（401より先に判定する）", async () => {
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
    const body = JSON.stringify({ nickname: "たろう", tags: [] });

    // Cookie 無しの連打でも枠は消費される（KVへの書き込み口をログインの有無によらず守る）
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/api/profile`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.2.3.1" },
        body,
      });
      assertEquals(res.status, 401);
      await res.body?.cancel();
    }

    const limited = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie, "x-forwarded-for": "10.2.3.1" },
      body,
    });
    assertEquals(limited.status, 429, "同じIPならログイン済みでも枠は使い切られていること");
    await limited.body?.cancel();
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test(
  "reset-limits: プロフィール保存の上限まで使ったあと、リセットで保存が復活する",
  async () => {
    const savedToken = Deno.env.get("EN_DEBUG_TOKEN");
    Deno.env.set("EN_DEBUG_TOKEN", "the-correct-token");
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
      const headers = {
        "content-type": "application/json",
        cookie,
        "x-forwarded-for": "10.2.4.1",
      };
      const body = JSON.stringify({ nickname: "たろう", tags: [] });

      for (let i = 0; i < 30; i++) {
        const res = await fetch(`${base}/api/profile`, { method: "PUT", headers, body });
        assertEquals(res.status, 200);
        await res.body?.cancel();
      }
      const limited = await fetch(`${base}/api/profile`, { method: "PUT", headers, body });
      assertEquals(limited.status, 429, "枠を使い切って429になっていること（前提）");
      await limited.body?.cancel();

      const resetRes = await fetch(`${base}/api/debug/reset-limits`, {
        method: "POST",
        headers: { [DEBUG_TOKEN_HEADER]: "the-correct-token" },
      });
      assertEquals(resetRes.status, 200);
      const resetBody = await resetRes.json();
      assertEquals(resetBody.scope, "all");
      assert(resetBody.cleared.profile >= 1, "プロフィール保存の枠も集計されていること");

      const afterReset = await fetch(`${base}/api/profile`, { method: "PUT", headers, body });
      assertEquals(afterReset.status, 200, "リセット後は再び保存できること");
      await afterReset.body?.cancel();
    } finally {
      await server.shutdown();
      kv.close();
      if (savedToken === undefined) Deno.env.delete("EN_DEBUG_TOKEN");
      else Deno.env.set("EN_DEBUG_TOKEN", savedToken);
    }
  },
);

Deno.test("reset-limits: IPを指定したときもプロフィール保存の枠が消える", async () => {
  const savedToken = Deno.env.get("EN_DEBUG_TOKEN");
  Deno.env.set("EN_DEBUG_TOKEN", "the-correct-token");
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
    const headers = {
      "content-type": "application/json",
      cookie,
      "x-forwarded-for": "10.2.5.1",
    };
    const body = JSON.stringify({ nickname: "たろう", tags: [] });

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/api/profile`, { method: "PUT", headers, body });
      assertEquals(res.status, 200);
      await res.body?.cancel();
    }
    const limited = await fetch(`${base}/api/profile`, { method: "PUT", headers, body });
    assertEquals(limited.status, 429, "枠を使い切って429になっていること（前提）");
    await limited.body?.cancel();

    const resetRes = await fetch(`${base}/api/debug/reset-limits`, {
      method: "POST",
      headers: { "content-type": "application/json", [DEBUG_TOKEN_HEADER]: "the-correct-token" },
      body: JSON.stringify({ ip: "10.2.5.1" }),
    });
    assertEquals(resetRes.status, 200);
    const resetBody = await resetRes.json();
    assertEquals(resetBody.scope, "ip");
    assertEquals(resetBody.cleared.profile, 1, "指定したIPのプロフィール枠が消えたこと");

    const afterReset = await fetch(`${base}/api/profile`, { method: "PUT", headers, body });
    assertEquals(afterReset.status, 200, "リセット後は再び保存できること");
    await afterReset.body?.cancel();
  } finally {
    await server.shutdown();
    kv.close();
    if (savedToken === undefined) Deno.env.delete("EN_DEBUG_TOKEN");
    else Deno.env.set("EN_DEBUG_TOKEN", savedToken);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/profile の楽観ロック（versionstamp の照合。競合したら409）
// ---------------------------------------------------------------------------

// 以前はこのケースを「2本の PUT を Promise.all で同時に投げ、片方が409になること」で
// 確かめていたが、それは2本がサーバー内で本当に並行処理されることに賭けたテストだった。
// 片方が先に完走してしまうと、後続は commit 済みの新しい versionstamp を読むため
// check が通り、両方200になる（＝直後の「続けて保存する分には409にならず」と同じ状況）。
// フルランで負荷が高いときほど直列化しやすく、散発的に落ちていた。
// そこで「読み出しから書き戻すまでの間に別の書き込みが入る」状況を、タイミングではなく
// Deno.Kv のラッパー（kvWithGetHook）で確実に作り出す形に直した。
Deno.test("PUT /api/profile: 読み出しから書き戻すまでの間に別の保存が入ると409（楽観ロック）", async () => {
  const kv = await Deno.openKv(":memory:");
  // ["user", ...] を読んだ直後に、1回だけ「横取りの保存」を差し込む。
  // 仕込むまでは null なので、register や me など他の読み出しには影響しない
  let steal: (() => Promise<void>) | null = null;
  const hookedKv = kvWithGetHook(kv, async (key) => {
    if (key[0] !== "user" || steal === null) return;
    const run = steal;
    steal = null;
    await run();
  });
  const server = startServer(0, "127.0.0.1", hookedKv);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = randomUserId();
    const registerRes = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "correcthorse" }),
    });
    const cookie = cookieFrom(registerRes);

    // 別のタブがこちらの読み出し直後に保存を済ませた状況。
    // 素の kv を使うのでフックは再入しない
    steal = async () => {
      const current = await kv.get<User>(["user", userId]);
      assert(current.value !== null, "横取り前にアカウントが存在すること");
      await kv.set(["user", userId], {
        ...current.value,
        nickname: "よこどり",
        tags: ["music"],
      });
    };

    const res = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ nickname: "ひだり", tags: ["game"] }),
    });
    // 先に「横取りが実際に差し込まれたか」を確かめる。ここが空振りしたまま
    // ステータスの assert に進むと、「ロックが無い」のか「フックが刺さらなかった」のか
    // 失敗メッセージから区別できなくなる
    assertEquals(steal, null, "横取りの保存が実際に差し込まれたこと");
    assertEquals(res.status, 409, "読んだ versionstamp が変わっているので409で弾かれること");
    assert(typeof (await res.json()).error === "string", "error メッセージが返ること");

    // 横取りした内容がそのまま残っている＝409を返した側は書き込んでいない
    const stored = await kv.get<User>(["user", userId]);
    assertEquals(stored.value?.nickname, "よこどり");
    assertEquals(stored.value?.tags, ["music"]);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PUT /api/profile: 続けて保存する分には409にならず後の内容が残る（回帰）", async () => {
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
    const headers = { "content-type": "application/json", cookie };

    const first = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ nickname: "はじめ", tags: ["game"] }),
    });
    assertEquals(first.status, 200);
    await first.body?.cancel();

    const second = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ nickname: "あとから", tags: ["music"] }),
    });
    assertEquals(second.status, 200, "直前の保存を読み直しているので競合しないこと");
    assertEquals(await second.json(), { nickname: "あとから", tags: ["music"] });

    const meBody = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    assertEquals(meBody.nickname, "あとから");
    assertEquals(meBody.tags, ["music"]);
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("PUT /api/profile: 保存の直前にアカウントが消えていると404（楽観ロックの前提）", async () => {
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

    // セッションは有効なままアカウントだけ消す（楽観ロックの check 以前に弾く経路）
    await kv.delete(["user", userId]);

    const res = await fetch(`${base}/api/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ nickname: "たろう", tags: [] }),
    });
    assertEquals(res.status, 404);
    assert(typeof (await res.json()).error === "string", "error メッセージが返ること");
  } finally {
    await server.shutdown();
    kv.close();
  }
});
