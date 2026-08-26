/**
 * tools/board/board.ts（CLI）のユニットテスト
 *
 * **ネットワークには一切出ない。** `fetch` はすべて注入し、偽の `Response` を返す。
 * `.env` の読み取りも行わない（`fileEnv` を直接渡す）。
 *
 * とくに検証したいこと（docs/design/board.md §8）:
 *   - ボードに繋がらないとき **終了コード 0** で終わること（作業を止めないため）
 *   - トークンが **標準出力にも標準エラーにも出ない**こと（§7-4）
 */

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
  BoardClient,
  type CliResult,
  DEFAULT_TIMEOUT_MS,
  ENV_TOKEN,
  ENV_URL,
  type EnvLike,
  type FetchLike,
  findOwnClaim,
  formatAge,
  formatCheck,
  formatClaimList,
  formatTaskList,
  formatTimestamp,
  joinUrl,
  normalizePath,
  parseArgs,
  redactToken,
  resolveConfig,
  resolveSessionId,
  runCli,
  sortClaims,
  splitList,
  truncateList,
  validateBoardUrl,
} from "./board.ts";
import type { ClaimCheckResponse, ClaimListResponse, ClaimView, Task } from "./types.ts";

const URL_OK = "https://board.test.local";
const TOKEN = "enboard_TESTTOKEN0123456789abcdefghij";
const NOW = 1_756_000_000_000; // 固定時刻（テストを時計に依存させない）

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/** 記録付きの偽 fetch */
function fakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return await handler(url, init);
  };
  return { fetch: fn, calls };
}

/** JSON の Response を作る */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 環境変数の偽物 */
function env(values: Record<string, string> = {}): EnvLike {
  return { get: (key: string) => values[key] };
}

/** CLI を1回実行して、終了コードと出力を集める */
async function run(
  argv: string[],
  options: {
    fetch?: FetchLike;
    fileEnv?: Record<string, string>;
    envValues?: Record<string, string>;
  } = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli({
    argv,
    env: env(options.envValues ?? {}),
    fileEnv: options.fileEnv ?? { [ENV_URL]: URL_OK, [ENV_TOKEN]: TOKEN },
    fetch: options.fetch ?? (() => {
      throw new Error("fetch が呼ばれてはいけない");
    }),
    now: () => NOW,
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** `--json` 実行の結果を CliResult として取り出す */
async function runJson(
  argv: string[],
  options: Parameters<typeof run>[1] = {},
): Promise<{ code: number; result: CliResult }> {
  const r = await run([...argv, "--json"], options);
  return { code: r.code, result: JSON.parse(r.out) as CliResult };
}

/** 表明のひな形 */
function claim(overrides: Partial<ClaimView> = {}): ClaimView {
  return {
    id: "01JCLAIM0000000000000000",
    member: "m1",
    memberName: "ちいかわ",
    sessionId: "session-a",
    title: "VC ルームの画面共有",
    status: "working",
    startedAt: NOW - 3_600_000,
    heartbeatAt: NOW - 600_000,
    stale: false,
    ...overrides,
  };
}

/** タスクのひな形 */
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "01JTASK00000000000000000",
    title: "VC の再接続を直す",
    body: "",
    status: "open",
    createdAt: NOW - 100_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 引数の解析
// ---------------------------------------------------------------------------

Deno.test("parseArgs: 引数なしと --help はヘルプ", () => {
  for (const argv of [[], ["--help"], ["-h"], ["help"]]) {
    const parsed = parseArgs(argv);
    assert(parsed.ok);
    assertEquals(parsed.command.kind, "help");
  }
});

Deno.test("parseArgs: claim はタイトルとオプションを取る", () => {
  const parsed = parseArgs([
    "claim",
    "VC の画面共有",
    "--paths",
    "server/rooms.ts,public/vc.js",
    "--paths",
    "server\\auth.ts",
    "--branch=feature/vc",
    "--pr",
    "#12",
    "--note",
    "音声から着手",
  ]);
  assert(parsed.ok);
  assertEquals(parsed.command, {
    kind: "claim",
    title: "VC の画面共有",
    paths: ["server/rooms.ts", "public/vc.js", "server/auth.ts"],
    branch: "feature/vc",
    prNumber: 12,
    note: "音声から着手",
  });
});

Deno.test("parseArgs: claim のタイトルは複数の位置引数を連結する", () => {
  const parsed = parseArgs(["claim", "VC", "の", "画面共有"]);
  assert(parsed.ok);
  assertEquals(parsed.command.kind === "claim" && parsed.command.title, "VC の 画面共有");
});

Deno.test("parseArgs: 誤った使い方は理由つきで拒否する", () => {
  const cases: [string[], string][] = [
    [["claim"], "title"],
    [["claim", "x", "--pr", "abc"], "--pr"],
    [["claim", "x", "--branch"], "値が必要"],
    [["check"], "パスを1つ以上"],
    [["list", "extra"], "引数を取りません"],
    [["done", "extra"], "引数を取りません"],
    [["task"], "add / list / done"],
    [["task", "done"], "タスク ID"],
    [["claim", "x", "--unknown", "v"], "不明なオプション"],
    [["nope"], "不明なサブコマンド"],
    [["list", "--timeout", "0"], "--timeout"],
    [["list", "--json=1"], "値を取りません"],
  ];
  for (const [argv, expected] of cases) {
    const parsed = parseArgs(argv);
    assertFalse(parsed.ok, `${argv.join(" ")} は拒否されるはず`);
    if (!parsed.ok) assertStringIncludes(parsed.message, expected);
  }
});

Deno.test("parseArgs: check はパスを正規化して重複を落とす", () => {
  const parsed = parseArgs(["check", "./server/rooms.ts", "server\\rooms.ts", "public/,docs/"]);
  assert(parsed.ok);
  assertEquals(parsed.command, { kind: "check", paths: ["server/rooms.ts", "public", "docs"] });
});

Deno.test("parseArgs: done は既定が done、--paused で paused", () => {
  const a = parseArgs(["done"]);
  assert(a.ok);
  assertEquals(a.command, { kind: "done", status: "done" });
  const b = parseArgs(["done", "--paused"]);
  assert(b.ok);
  assertEquals(b.command, { kind: "done", status: "paused" });
});

Deno.test("parseArgs: task の3つのサブコマンド", () => {
  const add = parseArgs(["task", "add", "VC を直す", "--body", "詳細", "--assignee", "m2"]);
  assert(add.ok);
  assertEquals(add.command, {
    kind: "task-add",
    title: "VC を直す",
    body: "詳細",
    assignee: "m2",
  });
  const list = parseArgs(["task", "list"]);
  assert(list.ok);
  assertEquals(list.command, { kind: "task-list" });
  const done = parseArgs(["task", "done", "01JTASK"]);
  assert(done.ok);
  assertEquals(done.command, { kind: "task-done", id: "01JTASK" });
});

Deno.test("parseArgs: 共通オプション（--session / --json / --timeout）", () => {
  const parsed = parseArgs(["list", "--session", " abc ", "--json", "--timeout", "1500"]);
  assert(parsed.ok);
  assertEquals(parsed.options, { json: true, sessionId: "abc", timeoutMs: 1500 });
  const bare = parseArgs(["list"]);
  assert(bare.ok);
  assertEquals(bare.options, { json: false, timeoutMs: DEFAULT_TIMEOUT_MS });
});

// ---------------------------------------------------------------------------
// 小さな純関数
// ---------------------------------------------------------------------------

Deno.test("normalizePath: 区切りと ./ と末尾スラッシュを揃える", () => {
  assertEquals(normalizePath("  server\\rooms.ts "), "server/rooms.ts");
  assertEquals(normalizePath("./public/"), "public");
  assertEquals(normalizePath("././docs/design/"), "docs/design");
  assertEquals(normalizePath("/"), "/");
});

Deno.test("splitList: カンマ区切りを分解し空要素を落とす", () => {
  assertEquals(splitList("a, b ,,c"), ["a", "b", "c"]);
  assertEquals(splitList("  "), []);
});

Deno.test("truncateList: 上限を超えたら畳む", () => {
  assertEquals(truncateList([]), "");
  assertEquals(truncateList(["a", "b"], 2), "a, b");
  assertEquals(truncateList(["a", "b", "c"], 2), "a, b, ほか1件");
});

Deno.test("formatAge: 経過時間を日本語にする", () => {
  assertEquals(formatAge(0), "たった今");
  assertEquals(formatAge(-5), "たった今");
  assertEquals(formatAge(59_000), "たった今");
  assertEquals(formatAge(60_000), "1分前");
  assertEquals(formatAge(59 * 60_000), "59分前");
  assertEquals(formatAge(60 * 60_000), "1時間前");
  assertEquals(formatAge(25 * 3_600_000), "1日前");
  assertEquals(formatAge(Number.NaN), "時刻不明");
});

Deno.test("formatTimestamp: YYYY-MM-DD HH:mm で出す", () => {
  assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(formatTimestamp(NOW)));
  assertEquals(formatTimestamp(Number.NaN), "時刻不明");
});

Deno.test("joinUrl: 末尾スラッシュの有無を吸収する", () => {
  assertEquals(joinUrl("https://b.example", "/api/claims"), "https://b.example/api/claims");
  assertEquals(joinUrl("https://b.example/", "/api/claims"), "https://b.example/api/claims");
  assertEquals(joinUrl("https://b.example//", "api/claims"), "https://b.example/api/claims");
});

Deno.test("redactToken: トークンを伏せる。短い値では働かない", () => {
  assertEquals(redactToken(`a ${TOKEN} b`, TOKEN), "a *** b");
  assertEquals(redactToken("abc", "abc"), "abc");
  assertEquals(redactToken("abc", ""), "abc");
});

Deno.test("validateBoardUrl: 平文 HTTP は localhost 以外を拒否する（§7-8）", () => {
  assert(validateBoardUrl("https://board.example/").ok);
  assert(validateBoardUrl("http://localhost:8001").ok);
  assert(validateBoardUrl("http://127.0.0.1:8001").ok);
  const remote = validateBoardUrl("http://board.example");
  assertFalse(remote.ok);
  if (!remote.ok) assertStringIncludes(remote.message, "平文 HTTP");
  assertFalse(validateBoardUrl("ftp://board.example").ok);
  assertFalse(validateBoardUrl("board.example").ok);
});

Deno.test("resolveConfig: 未設定を検出し、環境変数を .env より優先する", () => {
  const missing = resolveConfig({}, env());
  assertFalse(missing.ok);
  if (!missing.ok) {
    assertStringIncludes(missing.message, ENV_URL);
    assertStringIncludes(missing.message, ENV_TOKEN);
    assertStringIncludes(missing.message, ".env.example");
  }

  const onlyUrl = resolveConfig({ [ENV_URL]: URL_OK }, env());
  assertFalse(onlyUrl.ok);
  if (!onlyUrl.ok) assertStringIncludes(onlyUrl.message, ENV_TOKEN);

  const fromFile = resolveConfig({ [ENV_URL]: URL_OK, [ENV_TOKEN]: TOKEN }, env());
  assert(fromFile.ok);
  if (fromFile.ok) assertEquals(fromFile.config, { url: URL_OK, token: TOKEN });

  const overridden = resolveConfig(
    { [ENV_URL]: URL_OK, [ENV_TOKEN]: TOKEN },
    env({ [ENV_URL]: "https://other.test.local", [ENV_TOKEN]: "enboard_OTHERTOKEN0000" }),
  );
  assert(overridden.ok);
  if (overridden.ok) assertEquals(overridden.config.url, "https://other.test.local");
});

Deno.test("resolveSessionId: --session > 環境変数 > 利用者名からの既定値", () => {
  assertEquals(resolveSessionId("  s-1 ", env({ CLAUDE_SESSION_ID: "s-2" })), "s-1");
  assertEquals(resolveSessionId(undefined, env({ CLAUDE_SESSION_ID: "s-2" })), "s-2");
  assertEquals(resolveSessionId(undefined, env({ BOARD_SESSION_ID: "s-3" })), "s-3");
  assertEquals(resolveSessionId(undefined, env({ USERNAME: "shiba" })), "manual-shiba");
  assertEquals(resolveSessionId(undefined, env()), "manual-unknown");
});

Deno.test("findOwnClaim / sortClaims: 自分のセッションの表明を選ぶ", () => {
  const claims = [
    claim({ id: "done", sessionId: "session-a", status: "done" }),
    claim({ id: "other", sessionId: "session-b" }),
    claim({ id: "paused", sessionId: "session-a", status: "paused", heartbeatAt: NOW - 10 }),
    claim({ id: "working", sessionId: "session-a", status: "working", heartbeatAt: NOW - 1000 }),
  ];
  assertEquals(findOwnClaim(claims, "session-a")?.id, "working");
  assertEquals(findOwnClaim(claims, "session-z"), undefined);
  assertEquals(sortClaims(claims).map((c) => c.id), ["working", "other", "paused", "done"]);
});

// ---------------------------------------------------------------------------
// 表示の整形
// ---------------------------------------------------------------------------

Deno.test("formatClaimList: 空のときは表明を促す", () => {
  const text = formatClaimList({ claims: [], serverTime: NOW }, NOW);
  assertStringIncludes(text, "表明はありません");
  assertStringIncludes(text, "claim");
});

Deno.test("formatClaimList: 表明・メタ情報・古い表明の注意を出す", () => {
  const res: ClaimListResponse = {
    claims: [
      claim({
        branch: "feature/vc",
        prNumber: 12,
        paths: ["server/rooms.ts", "public/vc.js"],
        note: "音声から着手",
      }),
      claim({
        id: "old",
        memberName: "ひろし",
        title: "コリドーの当たり判定",
        sessionId: "session-b",
        stale: true,
        heartbeatAt: NOW - 10 * 3_600_000,
      }),
    ],
    serverTime: NOW,
  };
  const text = formatClaimList(res, NOW);
  assertStringIncludes(text, "現在の表明 (2件)");
  assertStringIncludes(text, "[作業中] ちいかわ: VC ルームの画面共有 (10分前)");
  assertStringIncludes(text, "ブランチ feature/vc / PR #12");
  assertStringIncludes(text, "パス: server/rooms.ts, public/vc.js");
  assertStringIncludes(text, "メモ: 音声から着手");
  assertStringIncludes(text, "[作業中・古い] ひろし");
  assertStringIncludes(text, "「古い」表明が 1件");
});

Deno.test("formatCheck: 重なりが無ければその旨だけ出す", () => {
  const res: ClaimCheckResponse = {
    paths: ["server/rooms.ts"],
    claims: [],
    prs: [],
    prsFetchedAt: NOW,
    serverTime: NOW,
  };
  const text = formatCheck(res, true, NOW);
  assertStringIncludes(text, "対象: server/rooms.ts");
  assertStringIncludes(text, "重なる表明・オープン PR はありません。");
});

Deno.test("formatCheck: 表明・PR の重なりと未表明の警告を出す", () => {
  const res: ClaimCheckResponse = {
    paths: ["server/auth.ts"],
    claims: [claim({ memberName: "みつお", title: "プロフィール保存", sessionId: "session-c" })],
    prs: [{
      prNumber: 35,
      title: "プロフィールの保存を直す",
      author: "mitsuo",
      headRef: "fix/profile",
      files: ["server/auth.ts", "public/profile.js"],
      fetchedAt: NOW - 60_000,
    }],
    prsFetchedAt: NOW - 60_000,
    serverTime: NOW,
  };
  const text = formatCheck(res, false, NOW);
  assertStringIncludes(text, "このセッションの表明がありません");
  assertStringIncludes(text, "他のメンバーの表明と重なります (1件)");
  assertStringIncludes(text, "みつお: プロフィール保存");
  assertStringIncludes(text, "オープン PR があります (1件");
  assertStringIncludes(text, "PR #35 プロフィールの保存を直す (mitsuo / fix/profile)");
  assertStringIncludes(text, "警告のみ");
});

Deno.test("formatCheck: PR 索引が未取得なら「取得できていません」と添える", () => {
  const res: ClaimCheckResponse = {
    paths: ["server/auth.ts"],
    claims: [],
    prs: [{
      prNumber: 1,
      title: "t",
      author: "a",
      headRef: "h",
      files: [],
      fetchedAt: 0,
    }],
    prsFetchedAt: null,
    serverTime: NOW,
  };
  assertStringIncludes(formatCheck(res, true, NOW), "取得できていません");
});

Deno.test("formatTaskList: 状態順に並べて表示する", () => {
  const text = formatTaskList({
    tasks: [
      task({ id: "t-done", title: "完了したもの", status: "done" }),
      task({ id: "t-doing", title: "着手中のもの", status: "doing", assignee: "m2", body: "詳細" }),
      task({ id: "t-open", title: "未着手のもの" }),
    ],
  });
  const lines = text.split("\n");
  assertStringIncludes(lines[0], "タスク (3件)");
  assertStringIncludes(lines[1], "[着手中] t-doing  着手中のもの");
  assertStringIncludes(lines[2], "担当 m2 / 詳細");
  assertStringIncludes(lines[3], "[未着手] t-open");
  assertStringIncludes(lines[4], "[完了] t-done");
  assertStringIncludes(formatTaskList({ tasks: [] }), "タスクはありません");
});

// ---------------------------------------------------------------------------
// runCli: 正常系
// ---------------------------------------------------------------------------

Deno.test("runCli: 引数なしはヘルプを出して 0（通信しない）", async () => {
  const r = await run([]);
  assertEquals(r.code, 0);
  assertStringIncludes(r.out, "作業ボード CLI");
  assertStringIncludes(r.out, "秘密情報を書かないこと");
});

Deno.test("runCli: 使い方の誤りは標準エラーに出して 1", async () => {
  const r = await run(["check"]);
  assertEquals(r.code, 1);
  assertEquals(r.out, "");
  assertStringIncludes(r.err, "パスを1つ以上");
});

Deno.test("runCli: list は一覧を整形して 0", async () => {
  const f = fakeFetch(() => json({ claims: [claim()], serverTime: NOW } as ClaimListResponse));
  const r = await run(["list"], { fetch: f.fetch });
  assertEquals(r.code, 0);
  assertStringIncludes(r.out, "ちいかわ: VC ルームの画面共有");
  assertEquals(f.calls.length, 1);
  assertEquals(f.calls[0].url, `${URL_OK}/api/claims`);
  assertEquals(f.calls[0].init.method, "GET");
});

Deno.test("runCli: トークンは Authorization にだけ載り、出力には現れない（§7-4）", async () => {
  const f = fakeFetch(() => json({ claims: [], serverTime: NOW }));
  const r = await run(["list"], { fetch: f.fetch });
  const headers = f.calls[0].init.headers as Record<string, string>;
  assertEquals(headers.authorization, `Bearer ${TOKEN}`);
  assertFalse(r.out.includes(TOKEN));
  assertFalse(r.err.includes(TOKEN));
  assertFalse(f.calls[0].url.includes(TOKEN));
});

Deno.test("runCli: claim は sessionId とオプションを本文に載せる", async () => {
  const f = fakeFetch((url) => {
    if (url.includes("/api/claims/check")) {
      return json({
        paths: ["server/rooms.ts"],
        claims: [],
        prs: [],
        prsFetchedAt: null,
        serverTime: NOW,
      });
    }
    return json({ claim: claim({ paths: ["server/rooms.ts"] }) });
  });
  const r = await run([
    "claim",
    "VC の画面共有",
    "--paths",
    "server/rooms.ts",
    "--branch",
    "feature/vc",
    "--pr",
    "12",
    "--note",
    "音声から",
    "--session",
    "session-a",
  ], { fetch: f.fetch });
  assertEquals(r.code, 0);
  assertStringIncludes(r.out, "表明しました。");
  const body = JSON.parse(String(f.calls[0].init.body));
  assertEquals(body, {
    sessionId: "session-a",
    title: "VC の画面共有",
    paths: ["server/rooms.ts"],
    branch: "feature/vc",
    prNumber: 12,
    note: "音声から",
  });
  assertEquals(f.calls[0].init.method, "POST");
  // paths を出したときは、その場で重なりも見に行く
  assertEquals(f.calls.length, 2);
});

Deno.test("runCli: check は自分の表明の有無を claimed で返す", async () => {
  const check: ClaimCheckResponse = {
    paths: ["server/auth.ts"],
    claims: [],
    prs: [],
    prsFetchedAt: NOW,
    serverTime: NOW,
  };
  const withClaim = fakeFetch((url) =>
    url.includes("/check") ? json(check) : json({ claims: [claim()], serverTime: NOW })
  );
  const a = await runJson(["check", "server/auth.ts", "--session", "session-a"], {
    fetch: withClaim.fetch,
  });
  assertEquals(a.code, 0);
  assertEquals(a.result.claimed, true);
  assertEquals(a.result.overlaps, { claims: 0, prs: 0 });
  assertStringIncludes(
    decodeURIComponent(withClaim.calls.find((c) => c.url.includes("/check"))!.url),
    "paths=server/auth.ts",
  );

  const withoutClaim = fakeFetch((url) =>
    url.includes("/check") ? json(check) : json({ claims: [], serverTime: NOW })
  );
  const b = await runJson(["check", "server/auth.ts", "--session", "session-z"], {
    fetch: withoutClaim.fetch,
  });
  assertEquals(b.result.claimed, false);
  assertStringIncludes(b.result.message, "このセッションの表明がありません");
});

Deno.test("runCli: done は自分の表明を探して PATCH する", async () => {
  const f = fakeFetch((_url, init) => {
    if (init.method === "PATCH") return json({ claim: claim({ status: "done" }) });
    return json({ claims: [claim({ id: "mine", sessionId: "session-a" })], serverTime: NOW });
  });
  const r = await run(["done", "--session", "session-a"], { fetch: f.fetch });
  assertEquals(r.code, 0);
  assertStringIncludes(r.out, "「完了」にしました");
  assertEquals(f.calls[1].url, `${URL_OK}/api/claims/mine`);
  assertEquals(JSON.parse(String(f.calls[1].init.body)), { status: "done" });
});

Deno.test("runCli: done --paused は paused を送る（SessionEnd フック用）", async () => {
  const f = fakeFetch((_url, init) => {
    if (init.method === "PATCH") return json({ claim: claim({ status: "paused" }) });
    return json({ claims: [claim({ id: "mine", sessionId: "session-a" })], serverTime: NOW });
  });
  const r = await run(["done", "--paused", "--session", "session-a"], { fetch: f.fetch });
  assertEquals(r.code, 0);
  assertEquals(JSON.parse(String(f.calls[1].init.body)), { status: "paused" });
  assertStringIncludes(r.out, "「中断」にしました");
});

Deno.test("runCli: done は表明が無ければ何もせず 0", async () => {
  const f = fakeFetch(() => json({ claims: [], serverTime: NOW }));
  const r = await run(["done", "--session", "session-a"], { fetch: f.fetch });
  assertEquals(r.code, 0);
  assertEquals(f.calls.length, 1);
  assertStringIncludes(r.out, "見つかりませんでした");
});

Deno.test("runCli: task add / list / done", async () => {
  const add = fakeFetch(() => json({ task: task() }));
  const rAdd = await run(["task", "add", "VC の再接続を直す", "--body", "詳細"], {
    fetch: add.fetch,
  });
  assertEquals(rAdd.code, 0);
  assertEquals(JSON.parse(String(add.calls[0].init.body)), {
    title: "VC の再接続を直す",
    body: "詳細",
  });

  const list = fakeFetch(() => json({ tasks: [task()] }));
  const rList = await run(["task", "list"], { fetch: list.fetch });
  assertEquals(rList.code, 0);
  assertStringIncludes(rList.out, "VC の再接続を直す");
  assertEquals(list.calls[0].url, `${URL_OK}/api/tasks`);

  const done = fakeFetch(() => json({ task: task({ status: "done" }) }));
  const rDone = await run(["task", "done", "01JTASK"], { fetch: done.fetch });
  assertEquals(rDone.code, 0);
  assertEquals(done.calls[0].url, `${URL_OK}/api/tasks/01JTASK`);
  assertEquals(JSON.parse(String(done.calls[0].init.body)), { status: "done" });
});

// ---------------------------------------------------------------------------
// runCli: 異常系（**ここが本丸**。落ちても作業を止めない）
// ---------------------------------------------------------------------------

Deno.test("runCli: 接続できないときは警告だけ出して終了コード 0", async () => {
  const f = fakeFetch(() => {
    throw new TypeError("error sending request for url");
  });
  const r = await run(["list"], { fetch: f.fetch });
  assertEquals(r.code, 0);
  // 失敗の知らせは標準エラーに出す（標準出力は「結果」だけに保つ）。フックは両方を拾う
  assertEquals(r.out, "");
  assertStringIncludes(r.err, "作業ボードに繋がりませんでした");
  assertStringIncludes(r.err, "作業は止めずに続けて構いません");
});

Deno.test("runCli: タイムアウトも終了コード 0（--json では reachable=false）", async () => {
  const f = fakeFetch(() => {
    throw new DOMException("timeout", "TimeoutError");
  });
  const r = await runJson(["check", "server/auth.ts", "--timeout", "50"], { fetch: f.fetch });
  assertEquals(r.code, 0);
  assertEquals(r.result.reachable, false);
  assertEquals(r.result.ok, false);
  assertStringIncludes(r.result.message, "50ms で打ち切り");
});

Deno.test("runCli: すべてのサブコマンドが、繋がらないときに 0 で終わる", async () => {
  const argvs = [
    ["list"],
    ["check", "server/auth.ts"],
    ["claim", "何か"],
    ["done"],
    ["task", "list"],
    ["task", "add", "何か"],
    ["task", "done", "01JTASK"],
  ];
  for (const argv of argvs) {
    const f = fakeFetch(() => {
      throw new TypeError("connection refused");
    });
    const r = await run(argv, { fetch: f.fetch });
    assertEquals(r.code, 0, `${argv.join(" ")} は 0 で終わるはず`);
  }
});

Deno.test("runCli: .env 未設定でも 0（未設定であることを伝える）", async () => {
  const r = await runJson(["list"], { fileEnv: {} });
  assertEquals(r.code, 0);
  assertEquals(r.result.configured, false);
  assertEquals(r.result.reachable, false);
  assertStringIncludes(r.result.message, "未設定");
  assertStringIncludes(r.result.message, ".env.example");
});

Deno.test("runCli: 平文 HTTP の設定はトークンを送らずに 0 で止まる（§7-8）", async () => {
  const f = fakeFetch(() => json({ claims: [], serverTime: NOW }));
  const r = await run(["list"], {
    fetch: f.fetch,
    fileEnv: { [ENV_URL]: "http://board.example", [ENV_TOKEN]: TOKEN },
  });
  assertEquals(r.code, 0);
  assertEquals(f.calls.length, 0);
  assertStringIncludes(r.err, "平文 HTTP");
});

Deno.test("runCli: 401 は終了コード 1。トークンの値は出さない", async () => {
  const f = fakeFetch(() => json({ error: "認証に失敗しました" }, 401));
  const r = await run(["list"], { fetch: f.fetch });
  assertEquals(r.code, 1);
  assertStringIncludes(r.err, "401");
  assertStringIncludes(r.err, "認証に失敗しました");
  assertStringIncludes(r.err, ENV_TOKEN);
  assertFalse(r.err.includes(TOKEN));
});

Deno.test("runCli: サーバーがトークンを反射しても伏せて表示する", async () => {
  const f = fakeFetch(() => json({ error: `不正なトークン: ${TOKEN}` }, 400));
  const r = await run(["list"], { fetch: f.fetch });
  assertEquals(r.code, 1);
  assertFalse(r.err.includes(TOKEN));
  assertStringIncludes(r.err, "***");
});

Deno.test("runCli: JSON でない応答はエラーとして 1", async () => {
  const f = fakeFetch(() => new Response("<html>502</html>", { status: 200 }));
  const r = await run(["list"], { fetch: f.fetch });
  assertEquals(r.code, 1);
  assertStringIncludes(r.err, "JSON として解釈できません");
});

Deno.test("runCli: 500 の本文が JSON でなくても状態コードを伝える", async () => {
  const f = fakeFetch(() => new Response("Internal Server Error", { status: 500 }));
  const r = await run(["list"], { fetch: f.fetch });
  assertEquals(r.code, 1);
  assertStringIncludes(r.err, "500");
});

// ---------------------------------------------------------------------------
// BoardClient 単体
// ---------------------------------------------------------------------------

Deno.test("BoardClient: タイムアウトのタイマーを残さない（signal が渡る）", async () => {
  const f = fakeFetch(() => json({ claims: [], serverTime: NOW }));
  const client = new BoardClient({ url: URL_OK, token: TOKEN }, f.fetch, 1000);
  await client.listClaims();
  const signal = f.calls[0].init.signal;
  assert(signal instanceof AbortSignal);
  assertFalse(signal.aborted);
});

Deno.test("BoardClient: PATCH の本文と URL エンコード", async () => {
  const f = fakeFetch(() => json({ claim: claim() }));
  const client = new BoardClient({ url: `${URL_OK}/`, token: TOKEN }, f.fetch);
  await client.updateClaim("a/b", { status: "paused" });
  assertEquals(f.calls[0].url, `${URL_OK}/api/claims/a%2Fb`);
  assertEquals(
    (f.calls[0].init.headers as Record<string, string>)["content-type"],
    "application/json",
  );
});
