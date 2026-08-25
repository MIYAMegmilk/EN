/**
 * デバッグ機能のテスト（§: オーナー困りごと「どこでログインがはじかれているのかわからない」対応）。
 *
 * - server/debug.ts の DebugRecorder 単体（リングバッファ・機微情報のredact・kindフィルタ）
 * - 実サーバーを空きポートで起動しての結合テスト（EN_DEBUG_TOKEN の有効化・アクセス制御・
 *   /debug.html のゲート・login の内部記録とHTTP応答の回帰確認）
 */

import { assert, assertEquals } from "@std/assert";
import { startServer } from "../main.ts";
import { DEBUG_TOKEN_HEADER, DebugRecorder, MAX_EVENTS, REDACTED } from "../debug.ts";

/** DebugRecorder のコンソール出力を覗くための捕獲用ロガー */
function captureLog(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

const ENV_KEY = "EN_DEBUG_TOKEN";

/** EN_DEBUG_TOKEN を一時的に token（undefined なら未設定）にして fn を実行し、必ず元に戻す */
async function withDebugToken<T>(
  token: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = Deno.env.get(ENV_KEY);
  if (token === undefined) Deno.env.delete(ENV_KEY);
  else Deno.env.set(ENV_KEY, token);
  try {
    return await fn();
  } finally {
    if (saved === undefined) Deno.env.delete(ENV_KEY);
    else Deno.env.set(ENV_KEY, saved);
  }
}

function randomUserId(): string {
  return "u" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

// ---------------------------------------------------------------------------
// DebugRecorder 単体テスト（サーバー起動なし）
// ---------------------------------------------------------------------------

Deno.test("DebugRecorder: 無効(enabled=false)のときはrecordしても記録されない", () => {
  const recorder = new DebugRecorder(false);
  recorder.record("test.kind", "メモリを無駄にしないことの確認");
  assertEquals(recorder.list().length, 0);
});

Deno.test("DebugRecorder: detailの危険なキーは値が[redacted]に置き換わる", () => {
  const recorder = new DebugRecorder(true);
  recorder.record("test.sensitive", "危険なキーを含む記録", {
    password: "hunter2",
    token: "session-token-abc",
    cookie: "session=abc123",
    secret: "s3cr3t",
    credential: "cred-value",
    passwordHash: "base64hash==",
    salt: "base64salt==",
    // 大文字小文字違いも拾えることの確認
    PASSWORD: "should-also-be-redacted",
    // 安全なキーはそのまま残ることの確認
    userId: "safe-user-id",
    count: 3,
    ok: true,
  });
  const [event] = recorder.list();
  assertEquals(event.detail?.password, REDACTED);
  assertEquals(event.detail?.token, REDACTED);
  assertEquals(event.detail?.cookie, REDACTED);
  assertEquals(event.detail?.secret, REDACTED);
  assertEquals(event.detail?.credential, REDACTED);
  assertEquals(event.detail?.passwordHash, REDACTED);
  assertEquals(event.detail?.salt, REDACTED);
  assertEquals(event.detail?.PASSWORD, REDACTED);
  assertEquals(event.detail?.userId, "safe-user-id");
  assertEquals(event.detail?.count, 3);
  assertEquals(event.detail?.ok, true);
});

Deno.test("DebugRecorder: リングバッファは直近MAX_EVENTS件だけを保持し、古いものを捨てる", () => {
  const recorder = new DebugRecorder(true);
  const total = MAX_EVENTS + 10;
  for (let i = 0; i < total; i++) {
    recorder.record("fill", `event ${i}`);
  }
  const events = recorder.list({ limit: MAX_EVENTS });
  assertEquals(events.length, MAX_EVENTS);
  // 先頭10件（event 0〜9）は捨てられ、直近MAX_EVENTS件だけが残っているはず
  assertEquals(events[0].message, "event 10");
  assertEquals(events[events.length - 1].message, `event ${total - 1}`);
});

Deno.test("DebugRecorder: kindの前方一致フィルタが効く", () => {
  const recorder = new DebugRecorder(true);
  recorder.record("login.ok", "ログイン成功");
  recorder.record("login.userNotFound", "ユーザー不在");
  recorder.record("register.ok", "登録成功");
  const loginEvents = recorder.list({ kind: "login." });
  assertEquals(loginEvents.length, 2);
  assert(loginEvents.every((e) => e.kind.startsWith("login.")));
});

Deno.test("DebugRecorder: 無効(enabled=false)のときはコンソールにも1行も出力されない", () => {
  const { lines, log } = captureLog();
  const recorder = new DebugRecorder(false, log);
  recorder.record("login.userNotFound", "ログイン失敗: ユーザーID 'foo' は存在しません", {
    userId: "foo",
    ip: "203.0.113.1",
  });
  assertEquals(lines.length, 0);
});

Deno.test("DebugRecorder: 有効時はrecordのたびにコンソールへ1行出力され、redact済みの値が使われる", () => {
  const { lines, log } = captureLog();
  const recorder = new DebugRecorder(true, log);
  recorder.record("login.userNotFound", "ログイン失敗: ユーザーID 'foo' は存在しません", {
    userId: "foo",
    ip: "203.0.113.1",
    password: "hunter2", // 誤って渡されても漏れないことを確認する
  });
  assertEquals(lines.length, 1);
  const line = lines[0];
  // 1イベント1行・種別・説明・主要なdetailが収まっていること
  assert(line.includes("login.userNotFound"));
  assert(line.includes("ログイン失敗: ユーザーID 'foo' は存在しません"));
  assert(line.includes("userId=foo"));
  assert(line.includes("ip=203.0.113.1"));
  // 生のパスワードは出ず、redact済みの値だけが出ること
  assert(!line.includes("hunter2"));
  assert(line.includes(`password=${REDACTED}`));

  recorder.record("login.ok", "ログイン成功", { userId: "bar" });
  assertEquals(lines.length, 2, "record 1回につき1行だけ出ること");
});

// ---------------------------------------------------------------------------
// 結合テスト（実サーバー起動）
// ---------------------------------------------------------------------------

Deno.test("EN_DEBUG_TOKEN未設定なら /api/debug/events は404", async () => {
  await withDebugToken(undefined, async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/debug/events`, {
        headers: { [DEBUG_TOKEN_HEADER]: "anything" },
      });
      assertEquals(res.status, 404);
    } finally {
      await server.shutdown();
      kv.close();
    }
  });
});

Deno.test("EN_DEBUG_TOKEN未設定なら /api/debug/summary も404", async () => {
  await withDebugToken(undefined, async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/debug/summary`);
      assertEquals(res.status, 404);
    } finally {
      await server.shutdown();
      kv.close();
    }
  });
});

Deno.test("EN_DEBUG_TOKEN未設定なら /debug.html と /debug.js も404", async () => {
  await withDebugToken(undefined, async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      for (const path of ["/debug.html", "/debug.js"]) {
        const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
        assertEquals(res.status, 404, `${path} は未設定時404であること`);
        // トークンっぽいヘッダを付けても未設定なら変わらず404（無効時は常に404）
        const withHeader = await fetch(`http://127.0.0.1:${server.port}${path}`, {
          headers: { [DEBUG_TOKEN_HEADER]: "whatever" },
        });
        assertEquals(withHeader.status, 404, `${path} はヘッダ付きでも未設定時404であること`);
      }
    } finally {
      await server.shutdown();
      kv.close();
    }
  });
});

Deno.test(
  "EN_DEBUG_TOKEN設定済みなら /debug.html と /debug.js はヘッダの有無・一致に関わらず200で配信される" +
    "（ブラウザはトップレベルのナビゲーションでカスタムヘッダを送れないため。実質的な防御はAPI側のトークン一致）",
  async () => {
    await withDebugToken("the-correct-token", async () => {
      const kv = await Deno.openKv(":memory:");
      const server = startServer(0, "127.0.0.1", kv);
      try {
        for (const path of ["/debug.html", "/debug.js"]) {
          // ヘッダなし = ブラウザでURLを直接開いたときの実際の挙動。ここが本題
          const noHeader = await fetch(`http://127.0.0.1:${server.port}${path}`);
          assertEquals(noHeader.status, 200, `${path} はヘッダなしでも200であること`);
          const noHeaderBody = await noHeader.text();
          assert(noHeaderBody.length > 0, `${path} の本文が空でないこと`);

          // 不一致ヘッダが付いていても静的配信は妨げない（トークン一致は要求しない）
          const wrongHeader = await fetch(`http://127.0.0.1:${server.port}${path}`, {
            headers: { [DEBUG_TOKEN_HEADER]: "the-wrong-token" },
          });
          assertEquals(wrongHeader.status, 200, `${path} は不一致ヘッダでも200であること`);
        }
      } finally {
        await server.shutdown();
        kv.close();
      }
    });
  },
);

Deno.test("EN_DEBUG_TOKEN設定済みでもx-debug-tokenが不一致なら404（401ではない）", async () => {
  await withDebugToken("the-correct-token", async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const wrongToken = await fetch(`${base}/api/debug/events`, {
        headers: { [DEBUG_TOKEN_HEADER]: "the-wrong-token" },
      });
      assertEquals(wrongToken.status, 404);
      const noToken = await fetch(`${base}/api/debug/events`);
      assertEquals(noToken.status, 404);
    } finally {
      await server.shutdown();
      kv.close();
    }
  });
});

Deno.test("トークンが一致すれば200でeventsが返る（キャッシュさせない）", async () => {
  await withDebugToken("the-correct-token", async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/debug/events`, {
        headers: { [DEBUG_TOKEN_HEADER]: "the-correct-token" },
      });
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("cache-control"), "no-store");
      const body = await res.json();
      assert(Array.isArray(body.events));
    } finally {
      await server.shutdown();
      kv.close();
    }
  });
});

Deno.test("トークンが一致すれば200でsummaryが返る（キャッシュさせない）", async () => {
  await withDebugToken("the-correct-token", async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/debug/summary`, {
        headers: { [DEBUG_TOKEN_HEADER]: "the-correct-token" },
      });
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("cache-control"), "no-store");
      const body = await res.json();
      assertEquals(typeof body.uptimeMs, "number");
      assertEquals(typeof body.serverTime, "number");
      assertEquals(typeof body.roomCount, "number");
      assert(Array.isArray(body.rooms));
    } finally {
      await server.shutdown();
      kv.close();
    }
  });
});

Deno.test(
  "ログイン失敗: ユーザー不在とパスワード不一致が別々のkindで記録され、HTTP応答は従来どおり同じ401・同じ文言のまま（回帰）",
  async () => {
    await withDebugToken("the-correct-token", async () => {
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

        // 経路1: ユーザーが存在しない
        const userNotFoundRes = await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: "nosuchuser0000", password: "whatever1" }),
        });
        // 経路2: パスワードが一致しない
        const passwordMismatchRes = await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId, password: "totallywrongpassword" }),
        });

        // --- 回帰確認: レスポンスは絶対に変えない ---
        assertEquals(userNotFoundRes.status, 401);
        assertEquals(passwordMismatchRes.status, 401);
        const userNotFoundBody = await userNotFoundRes.json();
        const passwordMismatchBody = await passwordMismatchRes.json();
        assertEquals(userNotFoundBody.error, "ユーザーIDまたはパスワードが正しくありません");
        assertEquals(passwordMismatchBody.error, "ユーザーIDまたはパスワードが正しくありません");
        assertEquals(userNotFoundBody.error, passwordMismatchBody.error);

        // --- 本題: サーバー内部の記録では区別できる ---
        const eventsRes = await fetch(`${base}/api/debug/events?kind=login.`, {
          headers: { [DEBUG_TOKEN_HEADER]: "the-correct-token" },
        });
        assertEquals(eventsRes.status, 200);
        // deno-lint-ignore no-explicit-any
        const { events } = await eventsRes.json() as { events: any[] };
        const kinds = events.map((e) => e.kind);
        assert(kinds.includes("login.userNotFound"), "login.userNotFound が記録されていること");
        assert(
          kinds.includes("login.passwordMismatch"),
          "login.passwordMismatch が記録されていること",
        );

        const userNotFoundEvent = events.find((e) => e.kind === "login.userNotFound");
        const passwordMismatchEvent = events.find((e) => e.kind === "login.passwordMismatch");
        assert(userNotFoundEvent.message.includes("nosuchuser0000"));
        assert(passwordMismatchEvent.message.includes(userId));

        // detail にパスワードそのものは絶対に含まれない
        const raw = JSON.stringify(events);
        assert(!raw.includes("whatever1"));
        assert(!raw.includes("totallywrongpassword"));
        assert(!raw.includes("correcthorse"));
      } finally {
        await server.shutdown();
        kv.close();
      }
    });
  },
);

Deno.test("kindクエリの前方一致フィルタがAPI越しにも効く", async () => {
  await withDebugToken("the-correct-token", async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      // login系・register系の両方を発生させる
      await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "nosuchuser1111", password: "whatever1" }),
      });
      await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: randomUserId(), password: "correcthorse" }),
      });

      const res = await fetch(`${base}/api/debug/events?kind=login.`, {
        headers: { [DEBUG_TOKEN_HEADER]: "the-correct-token" },
      });
      // deno-lint-ignore no-explicit-any
      const { events } = await res.json() as { events: any[] };
      assert(events.length > 0);
      assert(events.every((e) => (e.kind as string).startsWith("login.")));
    } finally {
      await server.shutdown();
      kv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/debug/reset-limits
// （§ 中間レビュー指摘「ログイン試行回数の消去？」対応。開発中にレート制限で詰まった
//   とき、待たずに解除できるようにする）
// ---------------------------------------------------------------------------

Deno.test("reset-limits: EN_DEBUG_TOKEN未設定なら404", async () => {
  await withDebugToken(undefined, async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/debug/reset-limits`, {
        method: "POST",
      });
      assertEquals(res.status, 404);
    } finally {
      await server.shutdown();
      kv.close();
    }
  });
});

Deno.test("reset-limits: x-debug-tokenが不一致でも404", async () => {
  await withDebugToken("the-correct-token", async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/debug/reset-limits`, {
        method: "POST",
        headers: { [DEBUG_TOKEN_HEADER]: "the-wrong-token" },
      });
      assertEquals(res.status, 404);
    } finally {
      await server.shutdown();
      kv.close();
    }
  });
});

Deno.test(
  "reset-limits: トークンが正しくてもGETでは実行されない（405・Allow: POST。誤って踏んだ" +
    "リンクやプリフェッチで消えないようにするため必ずPOST限定にしている）",
  async () => {
    await withDebugToken("the-correct-token", async () => {
      const kv = await Deno.openKv(":memory:");
      const server = startServer(0, "127.0.0.1", kv);
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/debug/reset-limits`, {
          method: "GET",
          headers: { [DEBUG_TOKEN_HEADER]: "the-correct-token" },
        });
        assertEquals(res.status, 405);
        assertEquals(res.headers.get("allow"), "POST");
      } finally {
        await server.shutdown();
        kv.close();
      }
    });
  },
);

Deno.test("reset-limits: Originがこのサーバーと異なると403（§3.8 CSRF対策）", async () => {
  await withDebugToken("the-correct-token", async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/debug/reset-limits`, {
        method: "POST",
        headers: {
          [DEBUG_TOKEN_HEADER]: "the-correct-token",
          "content-type": "application/json",
          origin: "http://evil.example",
        },
        body: JSON.stringify({}),
      });
      assertEquals(res.status, 403);
    } finally {
      await server.shutdown();
      kv.close();
    }
  });
});

Deno.test(
  "reset-limits: ログインを5回失敗させて429になったあと、リセットすると再びログインできる（本題）",
  async () => {
    await withDebugToken("the-correct-token", async () => {
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

        // ログインのレート制限（5回/分）を実際に使い切る
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
        assertEquals(limited.status, 429, "枠を使い切って429になっていること（前提）");

        // リセットを実行する（全IP対象、本文省略）
        const resetRes = await fetch(`${base}/api/debug/reset-limits`, {
          method: "POST",
          headers: { [DEBUG_TOKEN_HEADER]: "the-correct-token" },
        });
        assertEquals(resetRes.status, 200);
        const resetBody = await resetRes.json();
        assertEquals(resetBody.scope, "all");
        assert(resetBody.cleared.login >= 1, "少なくとも今使った枠が消えていること");

        // 再びログインできる（正しいパスワードで200）
        const afterReset = await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId, password: "correcthorse" }),
        });
        assertEquals(afterReset.status, 200, "リセット後は再びログインできること");
      } finally {
        await server.shutdown();
        kv.close();
      }
    });
  },
);

Deno.test(
  "reset-limits: 登録の上限（3件/時）まで使ったあと、リセットで登録が復活する",
  async () => {
    await withDebugToken("the-correct-token", async () => {
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
        assertEquals(limited.status, 429, "枠を使い切って429になっていること（前提）");

        const resetRes = await fetch(`${base}/api/debug/reset-limits`, {
          method: "POST",
          headers: { [DEBUG_TOKEN_HEADER]: "the-correct-token" },
        });
        assertEquals(resetRes.status, 200);
        const resetBody = await resetRes.json();
        assert(resetBody.cleared.register >= 1);

        const afterReset = await fetch(`${base}/api/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: randomUserId(), password: "correcthorse" }),
        });
        assertEquals(afterReset.status, 200, "リセット後は再び登録できること");
      } finally {
        await server.shutdown();
        kv.close();
      }
    });
  },
);

Deno.test(
  "reset-limits: IPを指定したときは、指定していないIPの枠は消えない",
  async () => {
    await withDebugToken("the-correct-token", async () => {
      const kv = await Deno.openKv(":memory:");
      const server = startServer(0, "127.0.0.1", kv);
      try {
        const base = `http://127.0.0.1:${server.port}`;
        const targetIp = "203.0.113.10";
        const otherIp = "203.0.113.20";

        // 両方のIPでログインのレート制限を使い切る（5回/分）
        for (const ip of [targetIp, otherIp]) {
          for (let i = 0; i < 5; i++) {
            const res = await fetch(`${base}/api/auth/login`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-forwarded-for": ip,
              },
              body: JSON.stringify({ userId: "nosuchuser", password: "wrongpassword" }),
            });
            assertEquals(res.status, 401);
          }
          const limited = await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": ip },
            body: JSON.stringify({ userId: "nosuchuser", password: "wrongpassword" }),
          });
          assertEquals(limited.status, 429, `${ip} の枠が使い切られていること（前提）`);
        }

        // targetIp の枠だけリセットする
        const resetRes = await fetch(`${base}/api/debug/reset-limits`, {
          method: "POST",
          headers: {
            [DEBUG_TOKEN_HEADER]: "the-correct-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ ip: targetIp }),
        });
        assertEquals(resetRes.status, 200);
        const resetBody = await resetRes.json();
        assertEquals(resetBody.scope, "ip");
        assertEquals(resetBody.cleared.login, 1);

        // targetIp は復活している
        const targetAfter = await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": targetIp },
          body: JSON.stringify({ userId: "nosuchuser", password: "wrongpassword" }),
        });
        assertEquals(targetAfter.status, 401, "targetIp はリセットされ、429ではないこと");

        // otherIp は消えたままなので依然として429
        const otherAfter = await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": otherIp },
          body: JSON.stringify({ userId: "nosuchuser", password: "wrongpassword" }),
        });
        assertEquals(otherAfter.status, 429, "otherIp の枠は消えていないこと");
      } finally {
        await server.shutdown();
        kv.close();
      }
    });
  },
);

Deno.test("reset-limits: 実行するとdebug.resetLimitsとして記録される", async () => {
  await withDebugToken("the-correct-token", async () => {
    const kv = await Deno.openKv(":memory:");
    const server = startServer(0, "127.0.0.1", kv);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const resetRes = await fetch(`${base}/api/debug/reset-limits`, {
        method: "POST",
        headers: {
          [DEBUG_TOKEN_HEADER]: "the-correct-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ip: "198.51.100.1" }),
      });
      assertEquals(resetRes.status, 200);

      const eventsRes = await fetch(`${base}/api/debug/events?kind=debug.resetLimits`, {
        headers: { [DEBUG_TOKEN_HEADER]: "the-correct-token" },
      });
      // deno-lint-ignore no-explicit-any
      const { events } = await eventsRes.json() as { events: any[] };
      assertEquals(events.length, 1);
      assertEquals(events[0].kind, "debug.resetLimits");
      assertEquals(events[0].detail.scope, "ip");
      assertEquals(events[0].detail.ip, "198.51.100.1");
      assertEquals(typeof events[0].detail.clearedLogin, "number");
      assertEquals(typeof events[0].detail.clearedRegister, "number");
    } finally {
      await server.shutdown();
      kv.close();
    }
  });
});
