/**
 * tools/board/server.ts のテスト（docs/design/board.md §11「テスト観点」）
 *
 * **ネットワークには一切出ない。** GitHub クライアントには偽の `fetch` を注入し、
 * ポートも開かない（`BoardServer.handle()` を直接呼ぶ）。
 *
 * 観点:
 *   - 認証: 全エンドポイントがトークン無し / 誤りで拒否されること（**`GET /` も**）
 *   - 表明: 作成・一覧・更新・1セッション1表明
 *   - TTL の境界（直前・直後）
 *   - 重なり判定: 完全一致 / ディレクトリ配下 / 重ならない / 自分自身は除外 / パス無し
 *   - 秘密文字列を含む表明の拒否（§7-7）
 *   - ボディサイズ超過の拒否（§7-8）
 *   - PR 索引: 取得失敗時に古いキャッシュを返すこと（§9）
 *   - 応答にトークン・ハッシュ・CORS ヘッダが混ざっていないこと（§7-4 / §7-8）
 */

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { AUTH_FAIL_LIMIT, BoardAuth, hashToken } from "./auth.ts";
import { BoardGitHubClient, type FetchLike } from "./github.ts";
import {
  anyPathOverlaps,
  BoardServer,
  normalizePath,
  normalizePaths,
  pathsOverlap,
  ulid,
} from "./server.ts";
import {
  BOARD_REQUEST_BODY_MAX_BYTES,
  type Claim,
  CLAIM_TTL_MS,
  type ClaimCheckResponse,
  type ClaimListResponse,
  type ClaimResponse,
  type ClaimView,
  KV_PREFIX,
  type PrListResponse,
  type TaskListResponse,
  type TaskResponse,
} from "./types.ts";

const ORIGIN = "http://board.test.local";
const IP = "203.0.113.10";
/** 認証の起点となる固定時刻（2026-08-26T00:00:00Z） */
const T0 = Date.UTC(2026, 7, 26, 0, 0, 0);

// ---------------------------------------------------------------------------
// 足場
// ---------------------------------------------------------------------------

type Ctx = {
  kv: Deno.Kv;
  auth: BoardAuth;
  board: BoardServer;
  /** ちいかわ（呼び出し元） */
  token: string;
  memberId: string;
  /** ひろし（他人） */
  otherToken: string;
  otherMemberId: string;
  /** 差し替えられる現在時刻 */
  clock: { now: number };
  /** 認証付きのリクエストを投げる */
  call(
    method: string,
    path: string,
    options?: { token?: string | null; body?: unknown; rawBody?: string; ip?: string },
  ): Promise<Response>;
};

async function withBoard(
  fn: (ctx: Ctx) => Promise<void>,
  options: {
    github?: BoardGitHubClient | null;
    htmlPath?: string;
    prIndexRefreshMs?: number;
  } = {},
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const auth = new BoardAuth(kv);
  const clock = { now: T0 };
  const me = await auth.registerMember("chiikawa", "ちいかわ");
  const other = await auth.registerMember("hiroshi", "ひろし");
  assert(me.ok && other.ok);
  const board = new BoardServer({
    kv,
    auth,
    github: options.github ?? null,
    htmlPath: options.htmlPath,
    prIndexRefreshMs: options.prIndexRefreshMs,
    now: () => clock.now,
  });
  const call: Ctx["call"] = (method, path, opts = {}) => {
    const headers = new Headers();
    const token = opts.token === undefined ? me.token : opts.token;
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    let body: string | undefined;
    if (opts.rawBody !== undefined) body = opts.rawBody;
    else if (opts.body !== undefined) body = JSON.stringify(opts.body);
    // GET / HEAD は本文を持てない（Request のコンストラクタが例外を投げる）
    if (method === "GET" || method === "HEAD") body = undefined;
    if (body !== undefined) headers.set("content-type", "application/json");
    const req = new Request(new URL(path, ORIGIN), { method, headers, body });
    return board.handle(req, opts.ip ?? IP);
  };
  try {
    await fn({
      kv,
      auth,
      board,
      token: me.token,
      memberId: me.member.id,
      otherToken: other.token,
      otherMemberId: other.member.id,
      clock,
      call,
    });
  } finally {
    board.dispose();
    auth.dispose();
    kv.close();
  }
}

/** 表明を1件作る（呼び出し元の既定はちいかわ） */
async function createClaim(
  ctx: Ctx,
  body: Record<string, unknown>,
  token?: string,
): Promise<ClaimView> {
  const res = await ctx.call("POST", "/api/claims", { body, token });
  assertEquals(res.status, 201, await res.clone().text());
  const parsed = (await res.json()) as ClaimResponse;
  return parsed.claim;
}

/** GitHub の PR / files を返す偽 fetch を作る */
function fakeGitHub(state: {
  prs: { number: number; title: string; login: string; ref: string; files: string[] }[];
  fail?: boolean;
}): { client: BoardGitHubClient; calls: string[] } {
  const calls: string[] = [];
  const fetchLike: FetchLike = (url) => {
    calls.push(url);
    if (state.fail === true) {
      return Promise.resolve(
        new Response("boom", { status: 500, headers: { "content-type": "text/plain" } }),
      );
    }
    const filesMatch = /\/pulls\/(\d+)\/files/.exec(url);
    if (filesMatch !== null) {
      const pr = state.prs.find((p) => p.number === Number(filesMatch[1]));
      const files = (pr?.files ?? []).map((f) => ({ filename: f, status: "modified" }));
      return Promise.resolve(json(files));
    }
    if (url.includes("/pulls?")) {
      return Promise.resolve(
        json(state.prs.map((p) => ({
          number: p.number,
          title: p.title,
          user: { login: p.login },
          head: { ref: p.ref },
          draft: false,
        }))),
      );
    }
    return Promise.resolve(new Response("[]", { status: 200 }));
  };
  const client = new BoardGitHubClient({
    repo: "MIYAMegmilk/EN",
    token: "ghp_FAKE0123456789",
    apiRoot: "https://api.test.local",
    fetch: fetchLike,
  });
  return { client, calls };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** ちょうど `size` バイト（ASCII）になる JSON 本文を作る */
function bodyOfExactSize(base: Record<string, string>, size: number): string {
  const head = JSON.stringify({ ...base, pad: "" });
  // pad は ASCII の "x" なので、1文字 = 1バイトで足りる分だけ足す
  const padLength = size - new TextEncoder().encode(head).byteLength;
  assert(padLength >= 0, "base が大きすぎます");
  return JSON.stringify({ ...base, pad: "x".repeat(padLength) });
}

/** テスト対象の全エンドポイント（認証テストで総当たりする） */
const ALL_ENDPOINTS: ReadonlyArray<[string, string]> = [
  ["GET", "/"],
  ["GET", "/api/claims"],
  ["POST", "/api/claims"],
  ["PATCH", "/api/claims/01ABC"],
  ["GET", "/api/claims/check?paths=public/app.js"],
  ["GET", "/api/tasks"],
  ["POST", "/api/tasks"],
  ["PATCH", "/api/tasks/01ABC"],
  ["GET", "/api/prs"],
  ["POST", "/api/messages"],
  ["GET", "/unknown"],
];

// ---------------------------------------------------------------------------
// 認証（§6 / §7-6 / §7-8）
// ---------------------------------------------------------------------------

Deno.test("認証: トークン無しでは全エンドポイントが401（GET / を含む）", async () => {
  await withBoard(async (ctx) => {
    for (const [i, [method, path]] of ALL_ENDPOINTS.entries()) {
      // 失敗の連打でレート制限にかからないよう、IP を毎回変える
      const res = await ctx.call(method, path, {
        token: null,
        body: {},
        ip: `192.0.2.${i + 1}`,
      });
      assertEquals(res.status, 401, `${method} ${path}`);
      assertEquals(res.headers.get("www-authenticate"), "Bearer");
      const body = await res.json();
      assertEquals(body.error, "トークンが必要です");
    }
  });
});

Deno.test("認証: 誤ったトークンでは全エンドポイントが401（GET / を含む）", async () => {
  await withBoard(async (ctx) => {
    for (const [i, [method, path]] of ALL_ENDPOINTS.entries()) {
      // 失敗の連打でレート制限にかからないよう、IP を毎回変える
      const res = await ctx.call(method, path, {
        token: "enboard_wrongwrongwrong",
        body: {},
        ip: `198.51.100.${i + 1}`,
      });
      assertEquals(res.status, 401, `${method} ${path}`);
      await res.body?.cancel();
    }
  });
});

Deno.test("認証: Bearer 以外のスキームや空の値も401", async () => {
  await withBoard(async (ctx) => {
    for (const raw of ["", "Basic abc", "Bearer", "Bearer    ", "token abc"]) {
      const headers = new Headers({ authorization: raw });
      const req = new Request(new URL("/api/claims", ORIGIN), { headers });
      const res = await ctx.board.handle(req, "198.51.100.200");
      assertEquals(res.status, 401, raw);
      await res.body?.cancel();
    }
  });
});

Deno.test("認証: 失敗を連打すると429になる（総当たり対策 §7-8）", async () => {
  await withBoard(async (ctx) => {
    const ip = "198.51.100.250";
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) {
      const res = await ctx.call("GET", "/api/claims", { token: "enboard_bad", ip });
      assertEquals(res.status, 401);
      await res.body?.cancel();
    }
    const limited = await ctx.call("GET", "/api/claims", { token: "enboard_bad", ip });
    assertEquals(limited.status, 429);
    await limited.body?.cancel();
    // 正しいトークンでも、その IP は締め出されたままになる（失敗だけを数えているため）
    const blocked = await ctx.call("GET", "/api/claims", { ip });
    assertEquals(blocked.status, 429);
    await blocked.body?.cancel();
    // 別の IP は影響を受けない
    const ok = await ctx.call("GET", "/api/claims", { ip: "198.51.100.251" });
    assertEquals(ok.status, 200);
    await ok.body?.cancel();
  });
});

Deno.test("認証: 正しいトークンなら通る", async () => {
  await withBoard(async (ctx) => {
    const res = await ctx.call("GET", "/api/claims");
    assertEquals(res.status, 200);
    const body = (await res.json()) as ClaimListResponse;
    assertEquals(body.claims, []);
    assertEquals(body.serverTime, T0);
  });
});

// ---------------------------------------------------------------------------
// 応答の作法（§7-4 / §7-8）
// ---------------------------------------------------------------------------

Deno.test("応答: CORS を許可せず、キャッシュもさせない", async () => {
  await withBoard(async (ctx) => {
    for (const [method, path] of ALL_ENDPOINTS) {
      const res = await ctx.call(method, path, { body: { sessionId: "s", title: "t" } });
      assertEquals(res.headers.get("cache-control"), "no-store", `${method} ${path}`);
      assertEquals(res.headers.get("access-control-allow-origin"), null);
      assertEquals(res.headers.get("access-control-allow-credentials"), null);
      assertEquals(res.headers.get("access-control-allow-headers"), null);
      assertEquals(res.headers.get("x-content-type-options"), "nosniff");
      assertEquals(res.headers.get("referrer-policy"), "no-referrer");
      await res.body?.cancel();
    }
  });
});

Deno.test("応答: トークンもハッシュも本文に出てこない（§7-4）", async () => {
  await withBoard(async (ctx) => {
    const tokenHash = await hashToken(ctx.token);
    await createClaim(ctx, { sessionId: "s-1", title: "画面共有", paths: ["public/app.js"] });
    const paths = [
      "/api/claims",
      "/api/claims/check?paths=public/app.js",
      "/api/tasks",
      "/api/prs",
    ];
    for (const path of paths) {
      const res = await ctx.call("GET", path);
      const text = await res.text();
      assertFalse(text.includes(ctx.token), path);
      assertFalse(text.includes(tokenHash), path);
      assertFalse(text.includes("tokenHash"), path);
    }
    // 認証に失敗したときの応答にも、送られてきた値を含めない
    const failed = await ctx.call("GET", "/api/claims", {
      token: "enboard_SECRETVALUE",
      ip: "198.51.100.9",
    });
    const failedText = await failed.text();
    assertFalse(failedText.includes("SECRETVALUE"));
  });
});

Deno.test("応答: 使えないメソッドは405、知らないパスは404", async () => {
  await withBoard(async (ctx) => {
    const cases: ReadonlyArray<[string, string, string]> = [
      ["DELETE", "/api/claims", "GET, POST"],
      ["POST", "/api/claims/check", "GET"],
      ["GET", "/api/claims/01ABCDEF", "PATCH"],
      ["DELETE", "/api/tasks", "GET, POST"],
      ["GET", "/api/tasks/01ABCDEF", "PATCH"],
      ["POST", "/api/prs", "GET"],
      ["GET", "/api/messages", "POST"],
      ["POST", "/", "GET"],
    ];
    for (const [method, path, allow] of cases) {
      const res = await ctx.call(method, path, { body: {} });
      assertEquals(res.status, 405, `${method} ${path}`);
      assertEquals(res.headers.get("allow"), allow);
      await res.body?.cancel();
    }
    const notFound = await ctx.call("GET", "/api/nothing");
    assertEquals(notFound.status, 404);
    await notFound.body?.cancel();
  });
});

Deno.test("応答: OPTIONS にプリフライトを返さない（CORS 不許可 §7-8）", async () => {
  await withBoard(async (ctx) => {
    const res = await ctx.call("OPTIONS", "/api/claims");
    assertEquals(res.status, 405);
    assertEquals(res.headers.get("access-control-allow-methods"), null);
    await res.body?.cancel();
  });
});

// ---------------------------------------------------------------------------
// 画面（§7-6）
// ---------------------------------------------------------------------------

Deno.test("画面: HTML があれば認証付きで返す", async () => {
  const file = await Deno.makeTempFile({ suffix: ".html" });
  await Deno.writeTextFile(file, "<!doctype html><title>board</title>");
  try {
    await withBoard(async (ctx) => {
      const res = await ctx.call("GET", "/");
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
      assertEquals(res.headers.get("cache-control"), "no-store");
      assertStringIncludes(await res.text(), "<title>board</title>");
    }, { htmlPath: file });
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("画面: HTML が置かれていなければ、置き場所を示す503を返す", async () => {
  const missing = `${await Deno.makeTempDir()}/not-created.html`;
  await withBoard(async (ctx) => {
    const res = await ctx.call("GET", "/");
    assertEquals(res.status, 503);
    const body = await res.json();
    assertStringIncludes(body.error, "not-created.html");
    assertStringIncludes(body.error, "画面");
  }, { htmlPath: missing });
});

// ---------------------------------------------------------------------------
// 表明（§4 / §5）
// ---------------------------------------------------------------------------

Deno.test("表明: 作成すると一覧に出る。member はトークンから決まる", async () => {
  await withBoard(async (ctx) => {
    const claim = await createClaim(ctx, {
      sessionId: "sess-1",
      title: "VC ルームの画面共有",
      paths: ["public/app.js", "server/rooms.ts"],
      branch: "feature/screen-share",
      prNumber: 41,
      note: "まず送信側から",
      // クライアントが名乗っても無視される（§7-1）
      member: "hiroshi",
    });
    assertEquals(claim.member, ctx.memberId);
    assertEquals(claim.memberName, "ちいかわ");
    assertEquals(claim.status, "working");
    assertEquals(claim.startedAt, T0);
    assertEquals(claim.heartbeatAt, T0);
    assertEquals(claim.stale, false);
    assertEquals(claim.paths, ["public/app.js", "server/rooms.ts"]);
    assertEquals(claim.branch, "feature/screen-share");
    assertEquals(claim.prNumber, 41);
    assertEquals(claim.id.length, 26);

    const res = await ctx.call("GET", "/api/claims");
    const list = (await res.json()) as ClaimListResponse;
    assertEquals(list.claims.length, 1);
    assertEquals(list.claims[0].id, claim.id);
    assertEquals(list.claims[0].memberName, "ちいかわ");
  });
});

Deno.test("表明: title が無い・型違い・長すぎるものを拒否する", async () => {
  await withBoard(async (ctx) => {
    const cases: Record<string, unknown>[] = [
      { sessionId: "s" },
      { sessionId: "s", title: "" },
      { sessionId: "s", title: 123 },
      { title: "セッションが無い" },
      { sessionId: "s", title: "x".repeat(201) },
      { sessionId: "s", title: "ok", paths: "public/app.js" },
      { sessionId: "s", title: "ok", paths: [1, 2] },
      { sessionId: "s", title: "ok", prNumber: -1 },
      { sessionId: "s", title: "ok", prNumber: 1.5 },
      { sessionId: "s", title: "ok", note: 42 },
    ];
    for (const body of cases) {
      const res = await ctx.call("POST", "/api/claims", { body });
      assertEquals(res.status, 400, JSON.stringify(body));
      await res.body?.cancel();
    }
    const broken = await ctx.call("POST", "/api/claims", { rawBody: "{ではない" });
    assertEquals(broken.status, 400);
    await broken.body?.cancel();
    const empty = await ctx.call("POST", "/api/claims", { rawBody: "" });
    assertEquals(empty.status, 400);
    await empty.body?.cancel();
    const array = await ctx.call("POST", "/api/claims", { rawBody: "[1,2,3]" });
    assertEquals(array.status, 400);
    await array.body?.cancel();
  });
});

Deno.test("表明: 1セッション1表明（同じ sessionId の2件目は409）", async () => {
  await withBoard(async (ctx) => {
    await createClaim(ctx, { sessionId: "sess-1", title: "1件目" });
    const second = await ctx.call("POST", "/api/claims", {
      body: { sessionId: "sess-1", title: "2件目" },
    });
    assertEquals(second.status, 409);
    assertStringIncludes((await second.json()).error, "1セッション1表明");

    // 別セッションなら通る
    await createClaim(ctx, { sessionId: "sess-2", title: "2件目" });
    // 別メンバーなら同じ sessionId でも通る（セッションはメンバーごとに数える）
    await createClaim(ctx, { sessionId: "sess-1", title: "ひろしの1件目" }, ctx.otherToken);

    const list = (await (await ctx.call("GET", "/api/claims")).json()) as ClaimListResponse;
    assertEquals(list.claims.length, 3);
  });
});

Deno.test("表明: 同じセッションからの同時 POST は片方だけ通る", async () => {
  await withBoard(async (ctx) => {
    const bodies = { sessionId: "race", title: "同時" };
    const [a, b] = await Promise.all([
      ctx.call("POST", "/api/claims", { body: bodies }),
      ctx.call("POST", "/api/claims", { body: bodies }),
    ]);
    const statuses = [a.status, b.status].sort();
    assertEquals(statuses, [201, 409]);
    await a.body?.cancel();
    await b.body?.cancel();
  });
});

Deno.test("表明: PATCH で status を変えると heartbeat も更新される（§5）", async () => {
  await withBoard(async (ctx) => {
    const claim = await createClaim(ctx, { sessionId: "s", title: "作業中", paths: ["a.ts"] });
    ctx.clock.now = T0 + 60_000;
    const res = await ctx.call("PATCH", `/api/claims/${claim.id}`, {
      body: { status: "paused", note: "中断", paths: ["b.ts"], branch: "fix/x", prNumber: 7 },
    });
    assertEquals(res.status, 200);
    const updated = ((await res.json()) as ClaimResponse).claim;
    assertEquals(updated.status, "paused");
    assertEquals(updated.note, "中断");
    assertEquals(updated.paths, ["b.ts"]);
    assertEquals(updated.branch, "fix/x");
    assertEquals(updated.prNumber, 7);
    assertEquals(updated.heartbeatAt, T0 + 60_000);
    assertEquals(updated.startedAt, T0, "startedAt は動かさない");
    assertEquals(updated.member, ctx.memberId);
  });
});

Deno.test("表明: PATCH は heartbeat だけでも打てる。無い id は404、不正な status は400", async () => {
  await withBoard(async (ctx) => {
    const claim = await createClaim(ctx, { sessionId: "s", title: "作業中" });
    ctx.clock.now = T0 + 5_000;
    const beat = await ctx.call("PATCH", `/api/claims/${claim.id}`, { body: {} });
    assertEquals(beat.status, 200);
    assertEquals(((await beat.json()) as ClaimResponse).claim.heartbeatAt, T0 + 5_000);

    const missing = await ctx.call("PATCH", "/api/claims/0123456789ABCDEFGHJKMNPQRS", {
      body: { status: "done" },
    });
    assertEquals(missing.status, 404);
    await missing.body?.cancel();

    const bad = await ctx.call("PATCH", `/api/claims/${claim.id}`, { body: { status: "zzz" } });
    assertEquals(bad.status, 400);
    await bad.body?.cancel();
  });
});

Deno.test("表明: 空文字を送ると任意項目を消せる", async () => {
  await withBoard(async (ctx) => {
    const claim = await createClaim(ctx, {
      sessionId: "s",
      title: "t",
      note: "のこす",
      branch: "feature/x",
      paths: ["a.ts"],
    });
    const res = await ctx.call("PATCH", `/api/claims/${claim.id}`, {
      body: { note: "", branch: "", paths: [] },
    });
    const updated = ((await res.json()) as ClaimResponse).claim;
    assertEquals(updated.note, undefined);
    assertEquals(updated.branch, undefined);
    assertEquals(updated.paths, undefined);
  });
});

// ---------------------------------------------------------------------------
// TTL の境界（§5）
// ---------------------------------------------------------------------------

Deno.test("TTL: ちょうど8時間は古くない。1ミリ秒でも超えたら古い（境界）", async () => {
  await withBoard(async (ctx) => {
    await createClaim(ctx, { sessionId: "s", title: "長い作業" });

    ctx.clock.now = T0 + CLAIM_TTL_MS - 1;
    let list = (await (await ctx.call("GET", "/api/claims")).json()) as ClaimListResponse;
    assertEquals(list.claims[0].stale, false, "TTL 直前");

    ctx.clock.now = T0 + CLAIM_TTL_MS;
    list = (await (await ctx.call("GET", "/api/claims")).json()) as ClaimListResponse;
    assertEquals(list.claims[0].stale, false, "ちょうど TTL");

    ctx.clock.now = T0 + CLAIM_TTL_MS + 1;
    list = (await (await ctx.call("GET", "/api/claims")).json()) as ClaimListResponse;
    assertEquals(list.claims[0].stale, true, "TTL 直後");
  });
});

Deno.test("TTL: working 以外は古くならない。自動削除もしない（§5）", async () => {
  await withBoard(async (ctx) => {
    const claim = await createClaim(ctx, { sessionId: "s", title: "中断した作業" });
    const paused = await ctx.call("PATCH", `/api/claims/${claim.id}`, {
      body: { status: "paused" },
    });
    await paused.body?.cancel();

    ctx.clock.now = T0 + CLAIM_TTL_MS * 10;
    const list = (await (await ctx.call("GET", "/api/claims")).json()) as ClaimListResponse;
    assertEquals(list.claims.length, 1, "古くなっても消さない");
    assertEquals(list.claims[0].stale, false);
    // KV にも残っている
    const stored = await ctx.kv.get<Claim>([KV_PREFIX.claim, claim.id]);
    assert(stored.value !== null);
  });
});

Deno.test("TTL: heartbeat を打ち直すと古い扱いが解ける", async () => {
  await withBoard(async (ctx) => {
    const claim = await createClaim(ctx, { sessionId: "s", title: "作業" });
    ctx.clock.now = T0 + CLAIM_TTL_MS + 1;
    let list = (await (await ctx.call("GET", "/api/claims")).json()) as ClaimListResponse;
    assertEquals(list.claims[0].stale, true);

    const beat = await ctx.call("PATCH", `/api/claims/${claim.id}`, { body: {} });
    await beat.body?.cancel();
    list = (await (await ctx.call("GET", "/api/claims")).json()) as ClaimListResponse;
    assertEquals(list.claims[0].stale, false);
  });
});

// ---------------------------------------------------------------------------
// 重なり判定（§6 の中核）
// ---------------------------------------------------------------------------

Deno.test("正規化: 区切り文字・末尾のスラッシュ・相対指定をそろえる", () => {
  assertEquals(normalizePath("public/app.js"), "public/app.js");
  assertEquals(normalizePath("public\\app.js"), "public/app.js");
  assertEquals(normalizePath("public/"), "public");
  assertEquals(normalizePath("/public//app.js"), "public/app.js");
  assertEquals(normalizePath("./public/app.js"), "public/app.js");
  assertEquals(normalizePath("  public/app.js  "), "public/app.js");
  assertEquals(normalizePath("server/a/../b.ts"), "server/b.ts");
  // リポジトリ全体を指すものは重なり判定から外す
  assertEquals(normalizePath(""), null);
  assertEquals(normalizePath("."), null);
  assertEquals(normalizePath("/"), null);
  assertEquals(normalizePath("./"), null);
  // 大文字小文字は git に合わせて区別する
  assertFalse(normalizePath("Public/App.js") === normalizePath("public/app.js"));
  assertEquals(normalizePaths(["public/", "public", "a\\b", "", "."]), ["public", "a/b"]);
});

Deno.test("重なり: 完全一致・ディレクトリ配下・別物", () => {
  assert(pathsOverlap("public/app.js", "public/app.js"));
  assert(pathsOverlap("public", "public/app.js"), "ディレクトリは配下と重なる");
  assert(pathsOverlap("public/app.js", "public"), "順序を入れ替えても同じ");
  assert(pathsOverlap("server", "server/rooms/index.ts"));
  assertFalse(pathsOverlap("public", "publicity.md"), "接頭辞が同じだけの別物は重ならない");
  assertFalse(pathsOverlap("public/app.js", "public/rooms.js"));
  assertFalse(pathsOverlap("server", "public"));
  assert(anyPathOverlaps(["a.ts", "public"], ["b.ts", "public/app.js"]));
  assertFalse(anyPathOverlaps(["a.ts"], ["b.ts"]));
  assertFalse(anyPathOverlaps([], ["b.ts"]));
});

Deno.test("check: 他人の表明のうち重なるものだけを返す", async () => {
  await withBoard(async (ctx) => {
    // ひろし: 完全一致
    await createClaim(
      ctx,
      { sessionId: "h1", title: "app.js を直す", paths: ["public/app.js"] },
      ctx.otherToken,
    );
    // ひろし: ディレクトリ指定（配下と重なる）
    await createClaim(
      ctx,
      { sessionId: "h2", title: "public 全体", paths: ["public/"] },
      ctx.otherToken,
    );
    // ひろし: 重ならない
    await createClaim(
      ctx,
      { sessionId: "h3", title: "別のところ", paths: ["server/rooms.ts"] },
      ctx.otherToken,
    );
    // ひろし: パス無し（重なりようがない）
    await createClaim(ctx, { sessionId: "h4", title: "パス未記入" }, ctx.otherToken);
    // 自分の表明（同じパスでも自分自身は返さない）
    await createClaim(ctx, {
      sessionId: "c1",
      title: "自分の作業",
      paths: ["public/app.js"],
    });

    const res = await ctx.call("GET", "/api/claims/check?paths=public/app.js");
    assertEquals(res.status, 200);
    const body = (await res.json()) as ClaimCheckResponse;
    assertEquals(body.paths, ["public/app.js"]);
    const titles = body.claims.map((c) => c.title).sort();
    assertEquals(titles, ["app.js を直す", "public 全体"]);
    for (const c of body.claims) {
      assertEquals(c.member, ctx.otherMemberId, "自分の表明は含めない");
    }
    assertEquals(body.serverTime, T0);
    assertEquals(body.prs, []);
    assertEquals(body.prsFetchedAt, null);
  });
});

Deno.test("check: 問い合わせ側がディレクトリでも、配下を触る表明を拾う", async () => {
  await withBoard(async (ctx) => {
    await createClaim(
      ctx,
      { sessionId: "h1", title: "配下のファイル", paths: ["public/rooms.js"] },
      ctx.otherToken,
    );
    const res = await ctx.call("GET", "/api/claims/check?paths=public");
    const body = (await res.json()) as ClaimCheckResponse;
    assertEquals(body.claims.length, 1);
    assertEquals(body.claims[0].title, "配下のファイル");
  });
});

Deno.test("check: 区切り文字と末尾スラッシュが違っても重なりとみなす", async () => {
  await withBoard(async (ctx) => {
    await createClaim(
      ctx,
      { sessionId: "h1", title: "Windows 風のパス", paths: ["public\\app.js"] },
      ctx.otherToken,
    );
    const res = await ctx.call("GET", "/api/claims/check?paths=.%2Fpublic%2Fapp.js");
    const body = (await res.json()) as ClaimCheckResponse;
    assertEquals(body.paths, ["public/app.js"]);
    assertEquals(body.claims.length, 1);
  });
});

Deno.test("check: done の表明は重なりに含めない", async () => {
  await withBoard(async (ctx) => {
    const claim = await createClaim(
      ctx,
      { sessionId: "h1", title: "終わった作業", paths: ["public/app.js"] },
      ctx.otherToken,
    );
    const done = await ctx.call("PATCH", `/api/claims/${claim.id}`, {
      body: { status: "done" },
      token: ctx.otherToken,
    });
    await done.body?.cancel();

    const res = await ctx.call("GET", "/api/claims/check?paths=public/app.js");
    const body = (await res.json()) as ClaimCheckResponse;
    assertEquals(body.claims, []);
  });
});

Deno.test("check: 古い表明も返すが stale で区別できる", async () => {
  await withBoard(async (ctx) => {
    await createClaim(
      ctx,
      { sessionId: "h1", title: "放置された作業", paths: ["public/app.js"] },
      ctx.otherToken,
    );
    ctx.clock.now = T0 + CLAIM_TTL_MS + 1;
    const res = await ctx.call("GET", "/api/claims/check?paths=public/app.js");
    const body = (await res.json()) as ClaimCheckResponse;
    assertEquals(body.claims.length, 1);
    assertEquals(body.claims[0].stale, true);
  });
});

Deno.test("check: paths が無い・空・多すぎるときは400", async () => {
  await withBoard(async (ctx) => {
    for (const query of ["", "?paths=", "?paths=,,", "?paths=.", "?other=x"]) {
      const res = await ctx.call("GET", `/api/claims/check${query}`);
      assertEquals(res.status, 400, query);
      await res.body?.cancel();
    }
    const many = Array.from({ length: 201 }, (_, i) => `f${i}.ts`).join(",");
    const res = await ctx.call("GET", `/api/claims/check?paths=${many}`);
    assertEquals(res.status, 400);
    await res.body?.cancel();
  });
});

Deno.test("check: paths は複数回・カンマ区切りのどちらでも受ける", async () => {
  await withBoard(async (ctx) => {
    await createClaim(
      ctx,
      { sessionId: "h1", title: "rooms", paths: ["server/rooms.ts"] },
      ctx.otherToken,
    );
    const res = await ctx.call(
      "GET",
      "/api/claims/check?paths=public/app.js,server/rooms.ts&paths=README.md",
    );
    const body = (await res.json()) as ClaimCheckResponse;
    assertEquals(body.paths, ["public/app.js", "server/rooms.ts", "README.md"]);
    assertEquals(body.claims.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 秘密検出（§7-7）
// ---------------------------------------------------------------------------

Deno.test("秘密検出: トークンらしき文字列を含む表明・タスクを拒否する", async () => {
  await withBoard(async (ctx) => {
    const cases: ReadonlyArray<[string, string, Record<string, unknown>]> = [
      ["POST", "/api/claims", {
        sessionId: "s",
        title: "ghp_0123456789abcdefghij を使う",
      }],
      ["POST", "/api/claims", {
        sessionId: "s",
        title: "ふつうの表明",
        note: "token=github_pat_11ABCDEFG0123456789",
      }],
      ["POST", "/api/tasks", { title: "gho_abcdef0123 を差し替える", body: "" }],
      ["POST", "/api/tasks", { title: "ふつうのタスク", body: "enboard_AAAABBBBCCCC" }],
    ];
    for (const [method, path, body] of cases) {
      const res = await ctx.call(method, path, { body });
      assertEquals(res.status, 400, JSON.stringify(body));
      assertStringIncludes((await res.json()).error, "秘密情報");
    }
    // 何も保存されていない
    const claims = (await (await ctx.call("GET", "/api/claims")).json()) as ClaimListResponse;
    assertEquals(claims.claims, []);
    const tasks = (await (await ctx.call("GET", "/api/tasks")).json()) as TaskListResponse;
    assertEquals(tasks.tasks, []);
  });
});

Deno.test("秘密検出: PATCH の自由文にも効く", async () => {
  await withBoard(async (ctx) => {
    const claim = await createClaim(ctx, { sessionId: "s", title: "ふつう" });
    const res = await ctx.call("PATCH", `/api/claims/${claim.id}`, {
      body: { note: "ghp_ABCDEFGHIJKLMNOP" },
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();

    const task = await ctx.call("POST", "/api/tasks", { body: { title: "t", body: "" } });
    const created = ((await task.json()) as TaskResponse).task;
    const patched = await ctx.call("PATCH", `/api/tasks/${created.id}`, {
      body: { body: "ghs_ZZZZ9999" },
    });
    assertEquals(patched.status, 400);
    await patched.body?.cancel();
  });
});

Deno.test("秘密検出: 接頭辞そのものへの言及は通す（誤検出させない）", async () => {
  await withBoard(async (ctx) => {
    const claim = await createClaim(ctx, {
      sessionId: "s",
      title: "ghp_ で始まる文字列を弾く処理を書く",
    });
    assertStringIncludes(claim.title, "ghp_");
  });
});

Deno.test("検証: 1行の自由文に制御文字を混ぜられない。note の改行は通す", async () => {
  await withBoard(async (ctx) => {
    const bad = await ctx.call("POST", "/api/claims", {
      body: { sessionId: "s", title: "改行\nを含む見出し" },
    });
    assertEquals(bad.status, 400);
    assertStringIncludes((await bad.json()).error, "制御文字");

    const nul = await ctx.call("POST", "/api/claims", {
      body: { sessionId: "s", title: "NUL\u0000混入" },
    });
    assertEquals(nul.status, 400);
    await nul.body?.cancel();

    const claim = await createClaim(ctx, {
      sessionId: "s",
      title: "ふつうの見出し",
      note: "1行目\n2行目\tタブ",
    });
    assertEquals(claim.note, "1行目\n2行目\tタブ");

    const badNote = await ctx.call("POST", "/api/claims", {
      body: { sessionId: "s2", title: "t", note: "壊れた\u0007文字" },
    });
    assertEquals(badNote.status, 400);
    await badNote.body?.cancel();
  });
});

// ---------------------------------------------------------------------------
// ボディサイズ（§7-8）
// ---------------------------------------------------------------------------

Deno.test("ボディ: 上限ちょうどは通り、1バイト超えると413（境界）", async () => {
  await withBoard(async (ctx) => {
    const base = { sessionId: "size", title: "境界" };
    const exact = bodyOfExactSize(base, BOARD_REQUEST_BODY_MAX_BYTES);
    assertEquals(new TextEncoder().encode(exact).byteLength, BOARD_REQUEST_BODY_MAX_BYTES);
    const ok = await ctx.call("POST", "/api/claims", { rawBody: exact });
    assertEquals(ok.status, 201, await ok.clone().text());
    await ok.body?.cancel();

    const over = bodyOfExactSize(
      { sessionId: "size2", title: "超過" },
      BOARD_REQUEST_BODY_MAX_BYTES + 1,
    );
    const rejected = await ctx.call("POST", "/api/claims", { rawBody: over });
    assertEquals(rejected.status, 413);
    assertStringIncludes((await rejected.json()).error, "大きすぎます");
  });
});

Deno.test("ボディ: 上限超過は PATCH / タスクでも413", async () => {
  await withBoard(async (ctx) => {
    const huge = bodyOfExactSize({ title: "x" }, BOARD_REQUEST_BODY_MAX_BYTES + 1024);
    for (const [method, path] of [["POST", "/api/tasks"], ["PATCH", "/api/claims/01ABC"]]) {
      const res = await ctx.call(method, path, { rawBody: huge });
      assertEquals(res.status, 413, `${method} ${path}`);
      await res.body?.cancel();
    }
  });
});

// ---------------------------------------------------------------------------
// タスク（§4）
// ---------------------------------------------------------------------------

Deno.test("タスク: 作成・一覧・更新", async () => {
  await withBoard(async (ctx) => {
    const created = await ctx.call("POST", "/api/tasks", {
      body: { title: "ロビーの導線を直す", body: "入口が分かりにくい", assignee: "hiroshi" },
    });
    assertEquals(created.status, 201);
    const task = ((await created.json()) as TaskResponse).task;
    assertEquals(task.status, "open");
    assertEquals(task.assignee, "hiroshi");
    assertEquals(task.createdAt, T0);

    const list = (await (await ctx.call("GET", "/api/tasks")).json()) as TaskListResponse;
    assertEquals(list.tasks.length, 1);

    const patched = await ctx.call("PATCH", `/api/tasks/${task.id}`, {
      body: { status: "doing", title: "ロビーの導線", body: "直した", assignee: "" },
    });
    const updated = ((await patched.json()) as TaskResponse).task;
    assertEquals(updated.status, "doing");
    assertEquals(updated.title, "ロビーの導線");
    assertEquals(updated.body, "直した");
    assertEquals(updated.assignee, undefined);

    const missing = await ctx.call("PATCH", "/api/tasks/0123456789ABCDEFGHJKMNPQRS", {
      body: { status: "done" },
    });
    assertEquals(missing.status, 404);
    await missing.body?.cancel();

    const bad = await ctx.call("PATCH", `/api/tasks/${task.id}`, { body: { status: "zzz" } });
    assertEquals(bad.status, 400);
    await bad.body?.cancel();
  });
});

Deno.test("タスク: title が無いものは拒否し、body は省略できる", async () => {
  await withBoard(async (ctx) => {
    const rejected = await ctx.call("POST", "/api/tasks", { body: { body: "詳細だけ" } });
    assertEquals(rejected.status, 400);
    await rejected.body?.cancel();

    const created = await ctx.call("POST", "/api/tasks", { body: { title: "本文なし" } });
    assertEquals(created.status, 201);
    assertEquals(((await created.json()) as TaskResponse).task.body, "");
  });
});

// ---------------------------------------------------------------------------
// PR 索引（§9）
// ---------------------------------------------------------------------------

Deno.test("PR索引: GitHub から取得して返し、更新間隔の内は叩き直さない", async () => {
  const state = {
    prs: [
      {
        number: 36,
        title: "corridor",
        login: "chiikawa",
        ref: "feature/a",
        files: ["public/corridor.js"],
      },
      {
        number: 35,
        title: "profile",
        login: "hiroshi",
        ref: "feature/b",
        files: ["server/auth.ts"],
      },
    ],
  };
  const { client, calls } = fakeGitHub(state);
  await withBoard(async (ctx) => {
    const res = await ctx.call("GET", "/api/prs");
    assertEquals(res.status, 200);
    const body = (await res.json()) as PrListResponse;
    assertEquals(body.prs.map((p) => p.prNumber), [35, 36]);
    assertEquals(body.prs[1].files, ["public/corridor.js"]);
    assertEquals(body.prs[1].author, "chiikawa");
    assertEquals(body.fetchedAt, T0);
    const firstCallCount = calls.length;
    assert(firstCallCount >= 3, "PR 一覧 + files の2件");

    // 更新間隔の内なので GitHub は叩かない
    ctx.clock.now = T0 + 60_000;
    const again = await ctx.call("GET", "/api/prs");
    const againBody = (await again.json()) as PrListResponse;
    assertEquals(againBody.fetchedAt, T0);
    assertEquals(calls.length, firstCallCount, "キャッシュから返す");

    // 5分を超えたら取り直す
    ctx.clock.now = T0 + 5 * 60_000;
    const refreshed = await ctx.call("GET", "/api/prs");
    const refreshedBody = (await refreshed.json()) as PrListResponse;
    assertEquals(refreshedBody.fetchedAt, T0 + 5 * 60_000);
    assert(calls.length > firstCallCount);
  }, { github: client });
});

Deno.test("PR索引: 取得に失敗したら古いキャッシュを fetchedAt 付きで返す（§9）", async () => {
  const state = {
    prs: [{
      number: 36,
      title: "corridor",
      login: "chiikawa",
      ref: "feature/a",
      files: ["public/corridor.js"],
    }],
    fail: false,
  };
  const { client } = fakeGitHub(state);
  await withBoard(async (ctx) => {
    const first = (await (await ctx.call("GET", "/api/prs")).json()) as PrListResponse;
    assertEquals(first.prs.length, 1);
    assertEquals(first.fetchedAt, T0);

    // GitHub が落ちた状態で、更新間隔を超えて取りに行く
    state.fail = true;
    ctx.clock.now = T0 + 10 * 60_000;
    const stale = (await (await ctx.call("GET", "/api/prs")).json()) as PrListResponse;
    assertEquals(stale.prs.length, 1, "古いキャッシュを消さない");
    assertEquals(stale.prs[0].prNumber, 36);
    assertEquals(stale.fetchedAt, T0, "いつ時点かを示す");

    // check でも同じ扱い
    const checked = (await (await ctx.call(
      "GET",
      "/api/claims/check?paths=public/corridor.js",
    )).json()) as ClaimCheckResponse;
    assertEquals(checked.prs.length, 1);
    assertEquals(checked.prsFetchedAt, T0);

    // 復帰したら新しい時刻で入れ替わる
    state.fail = false;
    ctx.clock.now = T0 + 20 * 60_000;
    const recovered = (await (await ctx.call("GET", "/api/prs")).json()) as PrListResponse;
    assertEquals(recovered.fetchedAt, T0 + 20 * 60_000);
  }, { github: client });
});

Deno.test("PR索引: 最初の取得から失敗した場合は空 + fetchedAt=null", async () => {
  const { client } = fakeGitHub({ prs: [], fail: true });
  await withBoard(async (ctx) => {
    const body = (await (await ctx.call("GET", "/api/prs")).json()) as PrListResponse;
    assertEquals(body.prs, []);
    assertEquals(body.fetchedAt, null);
  }, { github: client });
});

Deno.test("PR索引: 閉じた PR はキャッシュから消える", async () => {
  const state = {
    prs: [
      { number: 1, title: "a", login: "x", ref: "a", files: ["a.ts"] },
      { number: 2, title: "b", login: "y", ref: "b", files: ["b.ts"] },
    ],
  };
  const { client } = fakeGitHub(state);
  await withBoard(async (ctx) => {
    const first = (await (await ctx.call("GET", "/api/prs")).json()) as PrListResponse;
    assertEquals(first.prs.length, 2);
    state.prs = [state.prs[0]];
    ctx.clock.now = T0 + 6 * 60_000;
    const second = (await (await ctx.call("GET", "/api/prs")).json()) as PrListResponse;
    assertEquals(second.prs.map((p) => p.prNumber), [1]);
  }, { github: client });
});

Deno.test("check: オープン PR の重なりも返す（ディレクトリ配下を含む）", async () => {
  const { client } = fakeGitHub({
    prs: [
      {
        number: 33,
        title: "corridor を書き換える",
        login: "hiroshi",
        ref: "feature/corridor",
        files: ["public/corridor.js", "public/corridor.html"],
      },
      { number: 34, title: "無関係", login: "mitsuo", ref: "feature/other", files: ["docs/a.md"] },
    ],
  });
  await withBoard(async (ctx) => {
    const body = (await (await ctx.call(
      "GET",
      "/api/claims/check?paths=public",
    )).json()) as ClaimCheckResponse;
    assertEquals(body.prs.map((p) => p.prNumber), [33]);
    assertEquals(body.prsFetchedAt, T0);

    const none = (await (await ctx.call(
      "GET",
      "/api/claims/check?paths=server/main.ts",
    )).json()) as ClaimCheckResponse;
    assertEquals(none.prs, []);
  }, { github: client });
});

// ---------------------------------------------------------------------------
// メッセージ（今回はスコープ外）
// ---------------------------------------------------------------------------

Deno.test("メッセージ: 認証は通るが501を返す（PR コメント投稿は未実装）", async () => {
  await withBoard(async (ctx) => {
    const res = await ctx.call("POST", "/api/messages", {
      body: { prNumber: 41, body: "見てください" },
    });
    assertEquals(res.status, 501);
    assertStringIncludes((await res.json()).error, "まだ実装されていません");
  });
});

// ---------------------------------------------------------------------------
// ULID
// ---------------------------------------------------------------------------

Deno.test("ulid: 26文字で、時刻順に並び、衝突しない", () => {
  const a = ulid(T0);
  const b = ulid(T0 + 1000);
  assertEquals(a.length, 26);
  assertEquals(b.length, 26);
  assert(a.slice(0, 10) < b.slice(0, 10), "先頭10文字が時刻順");
  const ids = new Set(Array.from({ length: 500 }, () => ulid(T0)));
  assertEquals(ids.size, 500);
  assert(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(a), a);
});
