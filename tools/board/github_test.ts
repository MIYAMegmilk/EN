/**
 * tools/board/github.ts のユニットテスト
 *
 * **ネットワークには一切出ない。** すべて `fetch` を注入し、偽の Response を返して検証する。
 * apiRoot もダミーのオリジン（https://api.test.local）を使う。
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  BoardGitHubClient,
  BoardGitHubError,
  collectPaths,
  type FetchLike,
  formatResetTime,
  parseNextLink,
  parseRepo,
  RateLimitError,
  resolveGitHubToken,
} from "./github.ts";

const API_ROOT = "https://api.test.local";
const REPO = "MIYAMegmilk/EN";
const TOKEN = "ghp_TESTTOKEN0123456789";

/** 記録付きの偽 fetch */
function fakeFetch(
  handler: (url: string, init: RequestInit) => Response,
): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return { fetch: fn, calls };
}

/** JSON レスポンスを組み立てる */
function jsonResponse(
  body: unknown,
  opts: { status?: number; statusText?: string; headers?: Record<string, string> } = {},
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "",
    headers: {
      "content-type": "application/json",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      ...(opts.headers ?? {}),
    },
  });
}

/** PR の生 JSON（GitHub のレスポンス形に合わせた最小形） */
function rawPr(
  n: number,
  title: string,
  login: string,
  ref: string,
  draft = false,
): Record<string, unknown> {
  return {
    number: n,
    title,
    state: "open",
    draft,
    user: { login },
    head: { ref },
    html_url: `https://github.com/${REPO}/pull/${n}`,
  };
}

function makeClient(fetchFn: FetchLike, extra: Record<string, unknown> = {}) {
  return new BoardGitHubClient({
    repo: REPO,
    token: TOKEN,
    fetch: fetchFn,
    apiRoot: API_ROOT,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// オープン PR の一覧
// ---------------------------------------------------------------------------

Deno.test("オープン PR の一覧を正しくパースできる", async () => {
  const { fetch, calls } = fakeFetch(() =>
    jsonResponse([
      rawPr(35, "プロフィール保存の修正", "chiikawa", "fix/profile"),
      rawPr(36, "廊下の描画を軽くする", "hiroshi", "feature/corridor-perf", true),
    ])
  );
  const client = makeClient(fetch);
  const prs = await client.listOpenPullRequests();

  assertEquals(prs.length, 2);
  assertEquals(prs[0], {
    prNumber: 35,
    title: "プロフィール保存の修正",
    author: "chiikawa",
    headRef: "fix/profile",
    draft: false,
  });
  assertEquals(prs[1].prNumber, 36);
  assertEquals(prs[1].headRef, "feature/corridor-perf");
  assert(prs[1].draft);

  // リクエストの中身: state=open / per_page / 認証ヘッダ
  assertEquals(calls.length, 1);
  const url = new URL(calls[0].url);
  assertEquals(url.origin, API_ROOT);
  assertEquals(url.pathname, `/repos/${REPO}/pulls`);
  assertEquals(url.searchParams.get("state"), "open");
  assertEquals(url.searchParams.get("per_page"), "100");
  const headers = calls[0].init.headers as Record<string, string>;
  assertEquals(headers["Authorization"], `Bearer ${TOKEN}`);
  assertEquals(headers["Accept"], "application/vnd.github+json");
  assertEquals(headers["X-GitHub-Api-Version"], "2022-11-28");
});

Deno.test("オープン PR が 0 件でも空配列として扱える", async () => {
  const { fetch } = fakeFetch(() => jsonResponse([]));
  const client = makeClient(fetch);
  assertEquals(await client.listOpenPullRequests(), []);
  assertEquals(await client.buildPrIndex(), []);
});

Deno.test("PR の user が null でも author は unknown になる", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse([{ number: 7, title: "t", user: null, head: { ref: "b" } }])
  );
  const prs = await makeClient(fetch).listOpenPullRequests();
  assertEquals(prs[0].author, "unknown");
});

Deno.test("PR の head.ref が欠けていたらエラーになる", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse([{ number: 7, title: "t", user: { login: "a" } }])
  );
  const err = await assertRejects(
    () => makeClient(fetch).listOpenPullRequests(),
    BoardGitHubError,
  );
  assertStringIncludes(err.message, "head.ref");
});

Deno.test("レスポンスが配列でなければエラーになる", async () => {
  const { fetch } = fakeFetch(() => jsonResponse({ message: "Not Found" }));
  await assertRejects(() => makeClient(fetch).listOpenPullRequests(), BoardGitHubError, "配列");
});

// ---------------------------------------------------------------------------
// ページネーション
// ---------------------------------------------------------------------------

Deno.test("ページネーション: link ヘッダを辿って 3 ページ分のファイルを集められる", async () => {
  const perPage = 2;
  const pages: Record<string, Record<string, unknown>[]> = {
    "1": [{ filename: "a.ts", status: "modified" }, { filename: "b.ts", status: "added" }],
    "2": [{ filename: "c.ts", status: "modified" }, { filename: "d.ts", status: "removed" }],
    "3": [{ filename: "e.ts", status: "modified" }],
  };
  const { fetch, calls } = fakeFetch((url) => {
    const page = new URL(url).searchParams.get("page") ?? "1";
    const headers: Record<string, string> = {};
    const nextPage = String(Number(page) + 1);
    if (pages[nextPage]) {
      const nextUrl = new URL(url);
      nextUrl.searchParams.set("page", nextPage);
      headers["link"] = `<${nextUrl.toString()}>; rel="next", ` +
        `<${nextUrl.toString()}>; rel="last"`;
    }
    return jsonResponse(pages[page] ?? [], { headers });
  });

  const client = makeClient(fetch, { perPage });
  const files = await client.listPullRequestFiles(42);

  assertEquals(calls.length, 3);
  assertEquals(files.map((f) => f.filename), ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  assertEquals(new URL(calls[0].url).pathname, `/repos/${REPO}/pulls/42/files`);
  assertEquals(new URL(calls[0].url).searchParams.get("per_page"), String(perPage));
  assertEquals(new URL(calls[2].url).searchParams.get("page"), "3");
});

Deno.test("ページネーション: link ヘッダが無い場合は page を進めて追従する", async () => {
  const perPage = 2;
  const { fetch, calls } = fakeFetch((url) => {
    const page = new URL(url).searchParams.get("page") ?? "1";
    if (page === "1") {
      return jsonResponse([{ filename: "a.ts" }, { filename: "b.ts" }]);
    }
    return jsonResponse([{ filename: "c.ts" }]);
  });
  const files = await makeClient(fetch, { perPage }).listPullRequestFiles(1);
  assertEquals(calls.length, 2);
  assertEquals(files.map((f) => f.filename), ["a.ts", "b.ts", "c.ts"]);
});

Deno.test("ページネーション: 上限ページ数を超えたらエラーで打ち切る", async () => {
  const { fetch, calls } = fakeFetch((url) => {
    const next = new URL(url);
    next.searchParams.set("page", String(Number(next.searchParams.get("page") ?? "1") + 1));
    return jsonResponse([{ filename: "x.ts" }], {
      headers: { link: `<${next.toString()}>; rel="next"` },
    });
  });
  await assertRejects(
    () => makeClient(fetch, { maxPages: 3 }).listPullRequestFiles(1),
    BoardGitHubError,
    "上限 3 ページ",
  );
  assertEquals(calls.length, 3);
});

Deno.test("ページネーション: next が別オリジンなら追跡しない", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse([{ filename: "a.ts" }], {
      headers: { link: '<https://evil.example.com/steal?page=2>; rel="next"' },
    })
  );
  await assertRejects(
    () => makeClient(fetch).listPullRequestFiles(1),
    BoardGitHubError,
    "別のオリジン",
  );
});

Deno.test("parseNextLink: rel=next だけを取り出す", () => {
  const header = '<https://api.github.com/x?page=1>; rel="prev", ' +
    '<https://api.github.com/x?page=3>; rel="next", ' +
    '<https://api.github.com/x?page=9>; rel="last"';
  assertEquals(parseNextLink(header), "https://api.github.com/x?page=3");
  assertEquals(parseNextLink('<https://api.github.com/x?page=9>; rel="last"'), null);
  assertEquals(parseNextLink(null), null);
  assertEquals(parseNextLink(""), null);
});

// ---------------------------------------------------------------------------
// レート制限
// ---------------------------------------------------------------------------

Deno.test("レート制限枯渇（403 かつ残り 0）はそれと分かるエラーになる", async () => {
  const reset = Math.floor(Date.now() / 1000) + 1800;
  const { fetch } = fakeFetch(() =>
    jsonResponse({ message: "API rate limit exceeded" }, {
      status: 403,
      statusText: "Forbidden",
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    })
  );
  const err = await assertRejects(
    () => makeClient(fetch).listOpenPullRequests(),
    RateLimitError,
  );
  assertStringIncludes(err.message, "レート制限");
  assertStringIncludes(err.message, new Date(reset * 1000).toISOString());
  assertEquals(err.resetEpochSec, reset);
  assert(err instanceof BoardGitHubError);
});

Deno.test("二次レート制限（429 + Retry-After）もレート制限エラーになる", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ message: "You have exceeded a secondary rate limit" }, {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "x-ratelimit-remaining": "1234", "retry-after": "60" },
    })
  );
  const err = await assertRejects(
    () => makeClient(fetch).listOpenPullRequests(),
    RateLimitError,
  );
  assertStringIncludes(err.message, "二次レート制限");
  assertStringIncludes(err.message, "60");
});

Deno.test("残り 0 を観測したら次のリクエストは送らずに中止する", async () => {
  const reset = Math.floor(Date.now() / 1000) + 900;
  const { fetch, calls } = fakeFetch((url) => {
    if (url.includes("/pulls?")) {
      return jsonResponse([rawPr(1, "t", "a", "b")], {
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      });
    }
    return jsonResponse([{ filename: "a.ts" }]);
  });
  const client = makeClient(fetch);
  const err = await assertRejects(() => client.buildPrIndex(), RateLimitError);
  assertStringIncludes(err.message, "使い切っています");
  // files のリクエストは飛んでいない
  assertEquals(calls.length, 1);
  assertEquals(client.rateLimit.remaining, 0);
});

Deno.test("formatResetTime: 未取得なら不明、取得済みなら ISO と残り秒", () => {
  assertEquals(formatResetTime(null), "不明");
  const now = 1_700_000_000_000;
  const s = formatResetTime(1_700_000_060, now);
  assertStringIncludes(s, "2023-11-14T22:14:20.000Z");
  assertStringIncludes(s, "60 秒後");
});

// ---------------------------------------------------------------------------
// 2xx 以外
// ---------------------------------------------------------------------------

Deno.test("404 は内容の分かるエラーになる", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ message: "Not Found" }, { status: 404, statusText: "Not Found" })
  );
  const err = await assertRejects(
    () => makeClient(fetch).listOpenPullRequests(),
    BoardGitHubError,
  );
  assertStringIncludes(err.message, "404");
  assertStringIncludes(err.message, "Not Found");
  assertStringIncludes(err.message, `/repos/${REPO}/pulls`);
  assertFalse(err instanceof RateLimitError);
});

Deno.test("500 も 2xx 以外としてエラーになる", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse("boom", { status: 500, statusText: "Internal Server Error" })
  );
  await assertRejects(() => makeClient(fetch).listOpenPullRequests(), BoardGitHubError, "500");
});

Deno.test("fetch 自体が失敗した場合もエラーになる", async () => {
  const fn: FetchLike = () => Promise.reject(new TypeError("network unreachable"));
  await assertRejects(
    () => makeClient(fn).listOpenPullRequests(),
    BoardGitHubError,
    "リクエストに失敗",
  );
});

// ---------------------------------------------------------------------------
// トークンを漏らさない
// ---------------------------------------------------------------------------

Deno.test("エラーメッセージにトークンが含まれない（本文に混ざっていても伏字にする）", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ message: `Bad credentials for ${TOKEN}` }, {
      status: 401,
      statusText: "Unauthorized",
    })
  );
  const err = await assertRejects(
    () => makeClient(fetch).listOpenPullRequests(),
    BoardGitHubError,
  );
  assertFalse(err.message.includes(TOKEN));
  assertStringIncludes(err.message, "***");
  assertFalse(String(err.stack ?? "").includes(TOKEN));
});

Deno.test("レート制限エラーにもトークンは含まれない", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse(`rate limited (${TOKEN})`, {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
    })
  );
  const err = await assertRejects(() => makeClient(fetch).listOpenPullRequests(), RateLimitError);
  assertFalse(err.message.includes(TOKEN));
});

Deno.test("ネットワーク例外のメッセージにトークンが混ざっても伏字にする", async () => {
  const fn: FetchLike = () => Promise.reject(new Error(`failed with Bearer ${TOKEN}`));
  const err = await assertRejects(() => makeClient(fn).listOpenPullRequests(), BoardGitHubError);
  assertFalse(err.message.includes(TOKEN));
});

Deno.test("resolveGitHubToken: 環境変数から読み、未設定ならトークンを含まないエラーになる", () => {
  assertEquals(resolveGitHubToken({ get: () => `  ${TOKEN}  ` }), TOKEN);
  const err = assertThrows(
    () => resolveGitHubToken({ get: () => undefined }),
    BoardGitHubError,
  );
  assertStringIncludes(err.message, "BOARD_GITHUB_TOKEN");
  assertFalse(err.message.includes(TOKEN));
  // 空白のみも未設定として扱う
  assertThrows(() => resolveGitHubToken({ get: () => "   " }), BoardGitHubError);
});

// ---------------------------------------------------------------------------
// PrIndex への整形
// ---------------------------------------------------------------------------

Deno.test("buildPrIndex: PR とファイルをまとめて PrIndex の形にする", async () => {
  const filesByPr: Record<string, Record<string, unknown>[]> = {
    "35": [
      { filename: "server/auth.ts", status: "modified" },
      { filename: "public/js/profile.js", status: "added" },
    ],
    "36": [
      { filename: "public/js/corridor.js", status: "renamed", previous_filename: "public/js/c.js" },
    ],
  };
  const { fetch, calls } = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/pulls")) {
      return jsonResponse([
        rawPr(35, "プロフィール保存の修正", "chiikawa", "fix/profile"),
        rawPr(36, "廊下の描画", "hiroshi", "feature/corridor-perf"),
      ]);
    }
    const m = /\/pulls\/(\d+)\/files$/.exec(u.pathname);
    return jsonResponse(m ? filesByPr[m[1]] ?? [] : []);
  });

  const now = new Date("2026-08-26T12:00:00.000Z");
  const index = await makeClient(fetch).buildPrIndex(now);

  assertEquals(calls.length, 3); // 一覧 1 + PR 2 件
  assertEquals(index.length, 2);
  assertEquals(index[0], {
    prNumber: 35,
    title: "プロフィール保存の修正",
    author: "chiikawa",
    headRef: "fix/profile",
    files: ["server/auth.ts", "public/js/profile.js"],
    fetchedAt: "2026-08-26T12:00:00.000Z",
  });
  // リネームは変更前のパスも「触っている」ものとして含める
  assertEquals(index[1].files, ["public/js/corridor.js", "public/js/c.js"]);
  assertEquals(index[1].fetchedAt, "2026-08-26T12:00:00.000Z");
});

Deno.test("collectPaths: 重複を除き、リネーム前のパスも含める", () => {
  assertEquals(
    collectPaths([
      { filename: "a.ts", status: "modified" },
      { filename: "a.ts", status: "modified" },
      { filename: "b.ts", status: "renamed", previousFilename: "a.ts" },
      { filename: "c.ts", status: "renamed", previousFilename: "d.ts" },
    ]),
    ["a.ts", "b.ts", "c.ts", "d.ts"],
  );
  assertEquals(collectPaths([]), []);
});

Deno.test("変更ファイルに filename が無ければエラーになる", async () => {
  const { fetch } = fakeFetch((url) =>
    url.includes("/files") ? jsonResponse([{ status: "modified" }]) : jsonResponse([])
  );
  await assertRejects(
    () => makeClient(fetch).listPullRequestFiles(1),
    BoardGitHubError,
    "filename",
  );
});

// ---------------------------------------------------------------------------
// 入力検証
// ---------------------------------------------------------------------------

Deno.test("parseRepo: owner/name 形式だけを受理する", () => {
  assertEquals(parseRepo("MIYAMegmilk/EN"), { owner: "MIYAMegmilk", name: "EN" });
  assertEquals(parseRepo("  a-b_c./d  "), { owner: "a-b_c.", name: "d" });
  assertThrows(() => parseRepo("EN"), BoardGitHubError);
  assertThrows(() => parseRepo("a/b/c"), BoardGitHubError);
  assertThrows(() => parseRepo("a/b?x=1"), BoardGitHubError);
  assertThrows(() => parseRepo(42), BoardGitHubError);
});

Deno.test("コンストラクタ: 空トークン・不正な perPage / maxPages を拒否する", () => {
  const { fetch } = fakeFetch(() => jsonResponse([]));
  assertThrows(() => makeClient(fetch, { token: "   " }), BoardGitHubError, "トークン");
  assertThrows(() => makeClient(fetch, { perPage: 0 }), BoardGitHubError, "perPage");
  assertThrows(() => makeClient(fetch, { perPage: 101 }), BoardGitHubError, "perPage");
  assertThrows(() => makeClient(fetch, { maxPages: 0 }), BoardGitHubError, "maxPages");
  assertThrows(() => makeClient(fetch, { apiRoot: "not a url" }), BoardGitHubError, "apiRoot");
});

Deno.test("PR 番号が不正ならリクエストを送らない", async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse([]));
  await assertRejects(() => makeClient(fetch).listPullRequestFiles(0), BoardGitHubError, "PR 番号");
  await assertRejects(
    () => makeClient(fetch).listPullRequestFiles(1.5),
    BoardGitHubError,
    "PR 番号",
  );
  assertEquals(calls.length, 0);
});
