/**
 * HTTP 層のセキュリティ回帰テスト（監査 02 の Medium / 01 の Medium）。
 *
 * 対象:
 *   - デバッグ画面の 404 ゲートがパーセントエンコードで回避できた件
 *   - 静的配信のパス再構築によるオープンリダイレクト（`//evil.com/room`）
 *   - `//` で始まるパスの未処理例外（無認証で 500 + スタックトレース）
 *   - `/api/ice` が TURN 認証情報を無認証・無制限に配っていた件
 *   - ログイン応答のタイミング差によるユーザー列挙
 *
 * どれも「実サーバーを空きポートで起動して fetch する」既存の流儀（main_test.ts /
 * auth_test.ts / static_test.ts）に合わせている。
 */

import { assert, assertEquals, assertFalse, assertNotEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import {
  collapseLeadingSlashes,
  debugStaticPathOf,
  ICE_RATE_MAX,
  IpRateLimiter,
  startServer,
  TURN_CREDENTIAL_TTL_DEFAULT_SEC,
  turnRestCredential,
} from "../main.ts";
import { pbkdf2CallCount } from "../auth.ts";

/** デバッグ機能を有効にする環境変数（debug.ts / debug_test.ts と同じ名前） */
const DEBUG_TOKEN_ENV = "EN_DEBUG_TOKEN";

/** テスト中に触る環境変数（保存して必ず戻す） */
const ENV_KEYS = [
  "TURN_URL",
  "TURN_USER",
  "TURN_PASS",
  "TURN_SECRET",
  "TURN_TTL_SEC",
  DEBUG_TOKEN_ENV,
] as const;

/**
 * 指定した環境変数だけを立てた状態でサーバーを起動し、fn に base URL を渡す。
 * 作業ディレクトリを空の一時ディレクトリへ移し、開発者の `.env` に影響されないようにする
 * （main_test.ts の fetchIce と同じ手）。
 */
async function withServer(
  env: Record<string, string>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const saved = ENV_KEYS.map((key) => [key, Deno.env.get(key)] as const);
  const cwd = Deno.cwd();
  const temp = await Deno.makeTempDir();
  Deno.chdir(temp);
  for (const key of ENV_KEYS) Deno.env.delete(key);
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  const handle = startServer(0);
  try {
    await fn(`http://127.0.0.1:${handle.port}`);
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

/** リダイレクトを追わずに1件叩く */
async function probe(base: string, path: string) {
  const res = await fetch(base + path, { redirect: "manual" });
  const body = await res.text();
  return { status: res.status, location: res.headers.get("location"), body };
}

// ---------------------------------------------------------------------------
// 単体: パス正規化とデバッグ判定
// ---------------------------------------------------------------------------

Deno.test("collapseLeadingSlashes: 先頭の連続スラッシュだけを1つに畳む", () => {
  assertEquals(collapseLeadingSlashes("//"), "/");
  assertEquals(collapseLeadingSlashes("///"), "/");
  assertEquals(collapseLeadingSlashes("//evil.com/room"), "/evil.com/room");
  // 境界: スラッシュ1つは変えない。途中の連続スラッシュにも触らない
  assertEquals(collapseLeadingSlashes("/"), "/");
  assertEquals(collapseLeadingSlashes("/index.html"), "/index.html");
  assertEquals(collapseLeadingSlashes("/a//b"), "/a//b");
  assertEquals(collapseLeadingSlashes(""), "");
});

Deno.test("debugStaticPathOf: パーセントエンコード・大小文字を正規化して判定する", () => {
  assertEquals(debugStaticPathOf("/debug.html"), { isDebug: true });
  assertEquals(debugStaticPathOf("/debug.js"), { isDebug: true });
  // 監査で回避に使われた形
  assertEquals(debugStaticPathOf("/%64ebug.html"), { isDebug: true });
  assertEquals(debugStaticPathOf("/%64ebug.js"), { isDebug: true });
  assertEquals(debugStaticPathOf("/debug%2ehtml"), { isDebug: true });
  assertEquals(debugStaticPathOf("/DEBUG.HTML"), { isDebug: true });
  assertEquals(debugStaticPathOf("//debug.html"), { isDebug: true });
  // 正常系: 関係ないパスは false
  assertEquals(debugStaticPathOf("/index.html"), { isDebug: false });
  assertEquals(debugStaticPathOf("/debugger.html"), { isDebug: false });
  // 異常系: 壊れたパーセントエスケープは null（呼び出し側が 400 にする）
  assertEquals(debugStaticPathOf("/%zz"), null);
  assertEquals(debugStaticPathOf("/%"), null);
});

// ---------------------------------------------------------------------------
// デバッグ画面の 404 ゲート（監査 01 Medium）
// ---------------------------------------------------------------------------

Deno.test("デバッグ静的: トークン未設定なら、エンコードで書いても 404 になる", async () => {
  await withServer({}, async (base) => {
    for (
      const path of ["/debug.html", "/debug.js", "/%64ebug.html", "/%64ebug.js", "/debug%2ehtml"]
    ) {
      const res = await probe(base, path);
      assertEquals(res.status, 404, `${path} は 404 であること`);
      assertFalse(res.body.includes("<!DOCTYPE html>"), `${path} の本体が漏れていないこと`);
    }
  });
});

Deno.test("デバッグ静的: トークンを設定すれば従来どおり配信される（過剰に塞いでいない）", async () => {
  await withServer({ [DEBUG_TOKEN_ENV]: "test-token" }, async (base) => {
    const html = await probe(base, "/debug.html");
    assertEquals(html.status, 200);
    assert(html.body.includes("<!DOCTYPE html>"));
    const js = await probe(base, "/debug.js");
    assertEquals(js.status, 200);
    // パス再構築でエンコードが壊れていないこと（%64 が二重エンコードされない）
    const encoded = await probe(base, "/%64ebug.html");
    assertEquals(encoded.status, 200);
    assertEquals(encoded.body, html.body);
  });
});

// ---------------------------------------------------------------------------
// `//` で始まるパス: オープンリダイレクト / 未処理例外（監査 01・02 Medium）
// ---------------------------------------------------------------------------

Deno.test("静的配信: `//host/...` が外部ホストへの 301 にならない", async () => {
  await withServer({}, async (base) => {
    for (const path of ["//evil.com/room", "//evil.com/assets"]) {
      const res = await probe(base, path);
      assertNotEquals(res.status, 301, `${path} がリダイレクトにならないこと`);
      assertEquals(res.status, 404, `${path} は 404 であること`);
      assertEquals(res.location, null, `${path} に Location が付かないこと`);
    }
  });
});

Deno.test("静的配信: `//` `///` `//?a=1` が 500 にならない", async () => {
  await withServer({}, async (base) => {
    // "//" 系はトップページ扱いに畳まれる（未ログインなので login.html）
    for (const path of ["//", "///", "//?a=1"]) {
      const res = await probe(base, path);
      assertEquals(res.status, 200, `${path} が 200 であること`);
      assert(res.body.includes("guest-link"), `${path} で login.html が返ること`);
    }
    // ホストらしき文字列が続く形も 500 にせず 404 にする
    const nested = await probe(base, "///evil.com/room");
    assertEquals(nested.status, 404);
    assertEquals(nested.location, null);
  });
});

Deno.test("静的配信: `//存在しないパス` は index.html ではなく 404", async () => {
  await withServer({}, async (base) => {
    const res = await probe(base, "//nonexistent.txt");
    assertEquals(res.status, 404);
  });
});

Deno.test("静的配信: 壊れたパーセントエスケープは 400（500 にしない）", async () => {
  await withServer({}, async (base) => {
    const res = await probe(base, "/%zz");
    assertEquals(res.status, 400);
  });
});

Deno.test("静的配信: 正常なパスの挙動は変わっていない", async () => {
  await withServer({}, async (base) => {
    assertEquals((await probe(base, "/login.html")).status, 200);
    assertEquals((await probe(base, "/index.html")).status, 200);
    // 招待 URL は index.html を返す（§2）
    const invite = await probe(base, "/r/123456");
    assertEquals(invite.status, 200);
    assert(invite.body.includes("app.js"));
    // トップページは未ログインなら login.html
    const top = await probe(base, "/");
    assertEquals(top.status, 200);
    assert(top.body.includes("guest-link"));
  });
});

// ---------------------------------------------------------------------------
// /api/ice（監査 02 Medium）
// ---------------------------------------------------------------------------

Deno.test("/api/ice: 別オリジンからの要求は 403（TURN 認証情報を返さない）", async () => {
  await withServer({
    TURN_URL: "turn:turn.example.test:3478",
    TURN_USER: "en-user",
    TURN_PASS: "en-pass",
  }, async (base) => {
    const res = await fetch(`${base}/api/ice`, { headers: { origin: "https://evil.example" } });
    const body = await res.text();
    assertEquals(res.status, 403);
    assertFalse(body.includes("en-pass"), "認証情報が本文に出ていないこと");
  });
});

Deno.test("/api/ice: 同一オリジンからは従来どおり 200", async () => {
  await withServer({}, async (base) => {
    const host = new URL(base).host;
    const res = await fetch(`${base}/api/ice`, { headers: { origin: `http://${host}` } });
    assertEquals(res.status, 200);
    await res.body?.cancel();
  });
});

Deno.test("/api/ice: 同一IPからの連続取得は上限で 429 になる", async () => {
  await withServer({}, async (base) => {
    let ok = 0;
    let limited = 0;
    for (let i = 0; i < ICE_RATE_MAX + 3; i++) {
      const res = await fetch(`${base}/api/ice`);
      await res.body?.cancel();
      if (res.status === 200) ok++;
      else if (res.status === 429) limited++;
    }
    // 境界値: ちょうど上限まで通り、それ以降は 429
    assertEquals(ok, ICE_RATE_MAX);
    assertEquals(limited, 3);
  });
});

Deno.test("/api/ice: TURN_SECRET があれば時限クレデンシャルを発行する", async () => {
  await withServer({
    TURN_URL: "turn:turn.example.test:3478",
    TURN_SECRET: "shared-secret-for-test",
  }, async (base) => {
    const res = await fetch(`${base}/api/ice`);
    const body = await res.json() as {
      iceServers: { urls: string; username?: string; credential?: string }[];
    };
    const turn = body.iceServers.find((s) => s.urls.startsWith("turn:"));
    assert(turn !== undefined, "TURN が載ること");
    assert(turn.username !== undefined && turn.credential !== undefined);
    // 共有秘密そのものは出さない
    assertFalse(JSON.stringify(body).includes("shared-secret-for-test"));
    // username は "<有効期限のUNIX秒>:<ラベル>"
    const [expiryText] = turn.username.split(":");
    const expiry = Number(expiryText);
    const nowSec = Math.floor(Date.now() / 1000);
    assert(
      expiry > nowSec && expiry <= nowSec + TURN_CREDENTIAL_TTL_DEFAULT_SEC + 5,
      `有効期限が既定TTL以内であること: expiry=${expiry} now=${nowSec}`,
    );
    // credential は独立に計算した HMAC-SHA1 と一致する（coturn が検証できる形）
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("shared-secret-for-test"),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(turn.username),
    );
    assertEquals(turn.credential, encodeBase64(new Uint8Array(sig)));
  });
});

Deno.test("/api/ice: TURN_SECRET があれば TURN_USER / TURN_PASS は配らない", async () => {
  await withServer({
    TURN_URL: "turn:turn.example.test:3478",
    TURN_USER: "en-user",
    TURN_PASS: "en-pass",
    TURN_SECRET: "shared-secret-for-test",
  }, async (base) => {
    const text = await (await fetch(`${base}/api/ice`)).text();
    assertFalse(text.includes("en-pass"), "長期パスワードが混ざらないこと");
    assertFalse(text.includes("en-user"), "長期ユーザー名が混ざらないこと");
  });
});

Deno.test("turnRestCredential: 有効期限とラベルから決まる（同じ入力なら同じ出力）", async () => {
  const at = 1_700_000_000_000;
  const a = await turnRestCredential("s3cret", 600, at, "en");
  const b = await turnRestCredential("s3cret", 600, at, "en");
  assertEquals(a.username, `${Math.floor(at / 1000) + 600}:en`);
  assertEquals(a.credential, b.credential);
  // 異常系相当: 秘密が違えば資格情報も変わる（総当たり以外で作れない）
  const other = await turnRestCredential("other", 600, at, "en");
  assertNotEquals(a.credential, other.credential);
  // 境界: 期限が1秒違えば別の資格情報になる
  const later = await turnRestCredential("s3cret", 601, at, "en");
  assertNotEquals(a.credential, later.credential);
});

Deno.test("IpRateLimiter: 上限ちょうどまで通し、窓を跨げば戻る", () => {
  const limiter = new IpRateLimiter(3, 1_000);
  const t = 1_000_000;
  assert(limiter.tryConsume("a", t));
  assert(limiter.tryConsume("a", t));
  assert(limiter.tryConsume("a", t)); // 3件目（境界）は通る
  assertFalse(limiter.tryConsume("a", t)); // 4件目は超過
  assert(limiter.tryConsume("b", t), "キーが違えば独立していること");
  assert(limiter.tryConsume("a", t + 1_001), "窓を跨げばまた通ること");
});

// ---------------------------------------------------------------------------
// ログインのタイミング差（監査 02 Medium・ユーザー列挙）
//
// 時間そのものを測ると並列実行で不安定になる（server/tests/senryu_test.ts の経緯）。
// 「存在しないIDでも、存在するIDと同じ回数だけ PBKDF2 を回してから 401 を返す」ことを
// 実行回数で決定的に確認する。
// ---------------------------------------------------------------------------

Deno.test("ログイン: 存在しないIDでも同じ回数の鍵導出を通ってから 401 になる", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const userId = "enumtest01";
    const registered = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password: "password123" }),
    });
    await registered.body?.cancel();
    assertEquals(registered.status, 200);

    const login = async (id: string) => {
      const before = pbkdf2CallCount();
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: id, password: "wrongpassword" }),
      });
      const body = await res.text();
      return { calls: pbkdf2CallCount() - before, status: res.status, body };
    };

    const existing = await login(userId);
    const unknown = await login("nosuchuser1");

    // 応答は完全に同じ（文言・ステータス）
    assertEquals(existing.status, 401);
    assertEquals(unknown.status, 401);
    assertEquals(existing.body, unknown.body);
    // 経路も同じ: どちらも PBKDF2 を1回だけ回す
    assertEquals(existing.calls, 1, "実在IDは1回だけ鍵導出すること");
    assertEquals(unknown.calls, 1, "不在IDでも同じ回数だけ鍵導出すること（監査の回帰）");
  } finally {
    await server.shutdown();
    kv.close();
  }
});
