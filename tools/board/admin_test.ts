/**
 * tools/board/admin.ts（管理用 CLI）のユニットテスト
 *
 * 見張っていること（docs/design/board.md §7 / §11）:
 *
 *   - `add` で登録したトークンで**実際に認証が通る**こと（`BoardAuth.authenticate` で確認）
 *   - **KV に平文のトークンが残っていない**こと（KV の値だけでなく **KV ファイルの中身**も見る）
 *   - 既存 id への `add` が拒否され、**既存のトークンが失効しない**こと
 *   - `reissue` で**旧トークンが使えなくなり、新トークンが使える**こと
 *   - `list` の出力に**トークンもハッシュも混ざらない**こと
 *   - トークンが出力に現れるのは `add` / `reissue` の発行結果**1回だけ**であること
 *   - 引数不足・不正な id・KV を開けないときの**終了コード**
 *
 * KV は毎回**一時ファイル**に作り、CLI 実行のたびに開き直す（本番と同じく、別プロセスが
 * 同じファイルを開く形を再現するため）。`:memory:` だと実行間で中身が消えてしまう。
 */

import { assert, assertEquals, assertFalse, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import {
  type AdminIo,
  DISPLAY_NAME_MAX_LENGTH,
  ENV_KV_PATH,
  formatMemberList,
  HELP,
  MEMBER_ID_MAX_LENGTH,
  parseArgs,
  runAdmin,
} from "./admin.ts";
import { BOARD_TOKEN_PREFIX, BoardAuth, hashToken } from "./auth.ts";
import { KV_PREFIX, type Member } from "./types.ts";

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/** CLI を1回実行した結果 */
type RunResult = { code: number; out: string; err: string; all: string };

/** 一時 KV を用意して後始末まで面倒を見る。`run` は CLI を1回実行する */
async function withTempKv(
  fn: (ctx: {
    kvPath: string;
    run: (...argv: string[]) => Promise<RunResult>;
    /** 検証用に KV を開く（呼び出し側で close すること） */
    openKv: () => Promise<Deno.Kv>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "board-admin-test-" });
  const kvPath = join(dir, "board-test.kv");
  const run = async (...argv: string[]): Promise<RunResult> => {
    const out: string[] = [];
    const err: string[] = [];
    const io: AdminIo = { out: (t) => out.push(t), err: (t) => err.push(t) };
    const code = await runAdmin({
      argv,
      io,
      kvPath,
      openKv: (path) => Deno.openKv(path),
    });
    return {
      code,
      out: out.join("\n"),
      err: err.join("\n"),
      all: [...out, ...err].join("\n"),
    };
  };
  try {
    await fn({ kvPath, run, openKv: () => Deno.openKv(kvPath) });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * 出力から発行されたトークンを取り出す。
 * **「トークンだけの行」が1行だけ存在すること**もここで確かめている（コピーしやすさの要件）。
 */
function extractToken(output: string): string {
  const lines = output.split("\n").filter((line) => line.startsWith(BOARD_TOKEN_PREFIX));
  assertEquals(lines.length, 1, "トークンは単独の1行として、出力に1回だけ現れること");
  return lines[0];
}

/** 出力のどこにもトークン形式の文字列が現れないことを確かめる */
function assertNoTokenAnywhere(output: string, label: string): void {
  assertFalse(output.includes(BOARD_TOKEN_PREFIX), `${label}: トークンらしき文字列が出ている`);
}

/** `Authorization: Bearer <token>` 付きのリクエスト */
function requestWithToken(token: string): Request {
  return new Request("http://board.test/api/claims", {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** そのトークンで認証が通るかを、実際の `BoardAuth` で確かめる */
async function authenticateWith(
  kvPath: string,
  token: string,
  clientIp: string,
): Promise<{ ok: boolean; memberId?: string }> {
  const kv = await Deno.openKv(kvPath);
  const auth = new BoardAuth(kv);
  try {
    const result = await auth.authenticate(requestWithToken(token), clientIp);
    return result.ok ? { ok: true, memberId: result.member.id } : { ok: false };
  } finally {
    auth.dispose();
    kv.close();
  }
}

/** KV に保存されている Member をそのまま読む（テストだけがここを覗く） */
async function readMember(kvPath: string, id: string): Promise<Member | null> {
  const kv = await Deno.openKv(kvPath);
  try {
    return (await kv.get<Member>([KV_PREFIX.member, id])).value;
  } finally {
    kv.close();
  }
}

// ---------------------------------------------------------------------------
// 引数の解析（純関数）
// ---------------------------------------------------------------------------

Deno.test("parseArgs: add は id と表示名を取る（表示名の空白は連結される）", () => {
  const parsed = parseArgs(["add", "chiikawa", "ちい", "かわ"]);
  assert(parsed.ok);
  assertEquals(parsed.command, { kind: "add", id: "chiikawa", displayName: "ちい かわ" });
});

Deno.test("parseArgs: list / reissue / help", () => {
  const list = parseArgs(["list"]);
  assert(list.ok);
  assertEquals(list.command.kind, "list");

  const reissue = parseArgs(["reissue", "hiroshi"]);
  assert(reissue.ok);
  assertEquals(reissue.command, { kind: "reissue", id: "hiroshi" });

  for (const argv of [[], ["--help"], ["-h"], ["help"], ["add", "--help"]]) {
    const parsed = parseArgs(argv);
    assert(parsed.ok, `${JSON.stringify(argv)} は help になること`);
    assertEquals(parsed.command.kind, "help");
  }
});

Deno.test("parseArgs: 使い方の誤りは値で返る", () => {
  const cases: readonly string[][] = [
    ["add"], // id も表示名も無い
    ["add", "chiikawa"], // 表示名が無い
    ["reissue"], // id が無い
    ["reissue", "a", "b"], // 引数が多い
    ["list", "extra"], // list は引数を取らない
    ["unknown"], // 不明なサブコマンド
    ["--verbose", "list"], // 不明なオプション
  ];
  for (const argv of cases) {
    const parsed = parseArgs(argv);
    assertFalse(parsed.ok, `${JSON.stringify(argv)} は誤りとして弾かれること`);
  }
});

Deno.test("parseArgs: 不正な id を弾く", () => {
  const bad = [
    "../evil", // パスらしき文字
    "-leading", // ハイフン始まり（オプションと紛らわしい）
    "ちいかわ", // 日本語（表示名のほうに書く）
    "with space",
    "a".repeat(MEMBER_ID_MAX_LENGTH + 1),
  ];
  for (const id of bad) {
    const parsed = parseArgs(["add", id, "なまえ"]);
    assertFalse(parsed.ok, `id「${id}」は弾かれること`);
    const reissue = parseArgs(["reissue", id]);
    assertFalse(reissue.ok, `reissue の id「${id}」も弾かれること`);
  }
  const ok = parseArgs(["add", "a-b_C9", "なまえ"]);
  assert(ok.ok, "英数字・ハイフン・アンダースコアは通ること");
});

Deno.test("parseArgs: 表示名の長さと制御文字", () => {
  assertFalse(parseArgs(["add", "m1", "あ".repeat(DISPLAY_NAME_MAX_LENGTH + 1)]).ok);
  assert(parseArgs(["add", "m1", "あ".repeat(DISPLAY_NAME_MAX_LENGTH)]).ok);
  const bell = String.fromCharCode(7);
  assertFalse(parseArgs(["add", "m1", `ちい${bell}かわ`]).ok, "制御文字は弾くこと");
  const lf = String.fromCharCode(10);
  assertFalse(parseArgs(["add", "m1", `ちい${lf}かわ`]).ok, "改行は弾くこと");
});

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

Deno.test("add: 登録され、発行されたトークンで実際に認証が通る", async () => {
  await withTempKv(async ({ kvPath, run }) => {
    const result = await run("add", "chiikawa", "ちいかわ");
    assertEquals(result.code, 0);
    assertEquals(result.err, "");

    const token = extractToken(result.out);
    assert(token.startsWith(BOARD_TOKEN_PREFIX));

    const auth = await authenticateWith(kvPath, token, "203.0.113.10");
    assert(auth.ok, "発行されたトークンで認証が通ること");
    assertEquals(auth.memberId, "chiikawa");
  });
});

Deno.test("add: 出力はトークンが1回だけで、二度と表示されない旨と .env の書き方を含む", async () => {
  await withTempKv(async ({ run }) => {
    const result = await run("add", "chiikawa", "ちいかわ");
    const token = extractToken(result.out);

    // 出力全体でトークンが現れるのはちょうど1回（.env の例には実物を埋めない）
    assertEquals(result.out.split(token).length - 1, 1, "トークンは出力に1回だけ");

    for (const phrase of ["1回だけ", "取り出すことはできません", "他人に渡さない", "貼らない"]) {
      assert(result.out.includes(phrase), `注意書き「${phrase}」が出ること`);
    }
    assert(result.out.includes("tools/board/.env"), ".env の書き方を案内すること");
    assert(result.out.includes("BOARD_TOKEN="), "BOARD_TOKEN の記入例があること");
    assertFalse(
      result.out.includes(`BOARD_TOKEN=${token}`),
      ".env の記入例に実物のトークンを埋め込まないこと",
    );
  });
});

Deno.test("add: KV に平文のトークンが保存されていない（KV ファイルの中身も見る）", async () => {
  await withTempKv(async ({ kvPath, run }) => {
    const token = extractToken((await run("add", "chiikawa", "ちいかわ")).out);

    const member = await readMember(kvPath, "chiikawa");
    assert(member !== null);
    assertEquals(member.id, "chiikawa");
    assertEquals(member.displayName, "ちいかわ");
    assertEquals(member.tokenHash, await hashToken(token), "保存されているのはハッシュだけ");
    assertFalse(
      JSON.stringify(member).includes(token),
      "Member のどのフィールドにも平文が入っていないこと",
    );

    // KV ファイル（SQLite）そのものを走査する。平文が1バイトも書かれていないこと
    const bytes = await Deno.readFile(kvPath);
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    assertFalse(raw.includes(token), "KV ファイルに平文のトークンが残っていないこと");
    assert(raw.includes(member.tokenHash), "ハッシュのほうは保存されていること（対照）");
  });
});

Deno.test("add: 既存 id は拒否され、既存のトークンは失効しない", async () => {
  await withTempKv(async ({ kvPath, run }) => {
    const token = extractToken((await run("add", "chiikawa", "ちいかわ")).out);
    const before = await readMember(kvPath, "chiikawa");

    const again = await run("add", "chiikawa", "べつのなまえ");
    assertEquals(again.code, 1, "重複は終了コード 1");
    assertEquals(again.out, "", "重複時は標準出力に何も出さない");
    assert(again.err.includes("既に登録されています"));
    assert(again.err.includes("reissue"), "reissue を案内すること");
    assertNoTokenAnywhere(again.all, "重複した add");

    // 既存のトークンはそのまま有効で、表示名も書き換わっていない
    const auth = await authenticateWith(kvPath, token, "203.0.113.11");
    assert(auth.ok, "既存のトークンが失効していないこと");
    const after = await readMember(kvPath, "chiikawa");
    assertEquals(after?.tokenHash, before?.tokenHash, "ハッシュが上書きされていないこと");
    assertEquals(after?.displayName, "ちいかわ", "表示名も上書きされていないこと");
    assertEquals(after?.createdAt, before?.createdAt);
  });
});

// ---------------------------------------------------------------------------
// reissue
// ---------------------------------------------------------------------------

Deno.test("reissue: 旧トークンが使えなくなり、新トークンが使える", async () => {
  await withTempKv(async ({ kvPath, run }) => {
    const oldToken = extractToken((await run("add", "chiikawa", "ちいかわ")).out);

    const result = await run("reissue", "chiikawa");
    assertEquals(result.code, 0);
    assertEquals(result.err, "");
    const newToken = extractToken(result.out);
    assertNotEquals(newToken, oldToken);
    assertFalse(result.out.includes(oldToken), "旧トークンは出力に出さない");
    assert(result.out.includes("失効"), "旧トークンが失効した旨を伝えること");
    assert(result.out.includes("1回だけ"), "再発行でも1回きりである旨を伝えること");

    const withOld = await authenticateWith(kvPath, oldToken, "203.0.113.20");
    assertFalse(withOld.ok, "旧トークンでは認証が通らないこと");
    const withNew = await authenticateWith(kvPath, newToken, "203.0.113.21");
    assert(withNew.ok, "新トークンで認証が通ること");
    assertEquals(withNew.memberId, "chiikawa");

    // ハッシュしか保存されていないのは再発行後も同じ
    const member = await readMember(kvPath, "chiikawa");
    assertEquals(member?.tokenHash, await hashToken(newToken));
    assertEquals(member?.displayName, "ちいかわ", "表示名は引き継がれること");
  });
});

Deno.test("reissue: 未登録の id は終了コード 1 で、何も変更しない", async () => {
  await withTempKv(async ({ kvPath, run }) => {
    const token = extractToken((await run("add", "chiikawa", "ちいかわ")).out);

    const result = await run("reissue", "hiroshi");
    assertEquals(result.code, 1);
    assertEquals(result.out, "");
    assert(result.err.includes("登録されていません"));
    assertNoTokenAnywhere(result.all, "未登録 id の reissue");

    assertEquals(await readMember(kvPath, "hiroshi"), null, "勝手に作らないこと");
    const auth = await authenticateWith(kvPath, token, "203.0.113.22");
    assert(auth.ok, "他のメンバーのトークンに影響しないこと");
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

Deno.test("list: トークンもハッシュも出力に含まれない", async () => {
  await withTempKv(async ({ kvPath, run }) => {
    const token1 = extractToken((await run("add", "chiikawa", "ちいかわ")).out);
    const token2 = extractToken((await run("add", "hiroshi", "ひろし")).out);

    const result = await run("list");
    assertEquals(result.code, 0);
    assertEquals(result.err, "");

    assert(result.out.includes("chiikawa"));
    assert(result.out.includes("ちいかわ"));
    assert(result.out.includes("hiroshi"));
    assert(result.out.includes("ひろし"));

    assertNoTokenAnywhere(result.out, "list");
    for (const token of [token1, token2]) {
      assertFalse(result.out.includes(token), "list にトークンが出ていないこと");
      assertFalse(result.out.includes(await hashToken(token)), "list にハッシュが出ていないこと");
    }
    for (const id of ["chiikawa", "hiroshi"]) {
      const member = await readMember(kvPath, id);
      assert(member !== null);
      assertFalse(result.out.includes(member.tokenHash), "保存済みハッシュも出ていないこと");
    }
  });
});

Deno.test("list: 誰も居ないときは案内だけを出して 0 で終わる", async () => {
  await withTempKv(async ({ run }) => {
    const result = await run("list");
    assertEquals(result.code, 0);
    assert(result.out.includes("まだ誰も登録されていません"));
    assertNoTokenAnywhere(result.out, "空の list");
  });
});

Deno.test("formatMemberList: id 順に並び、ハッシュを受け取る余地が無い", () => {
  const text = formatMemberList([
    { id: "mitsuo", displayName: "みつお" },
    { id: "chiikawa", displayName: "ちいかわ" },
  ]);
  const ids = text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  assertEquals(ids[0].startsWith("chiikawa"), true);
  assertEquals(ids[1].startsWith("mitsuo"), true);
  assertNoTokenAnywhere(text, "formatMemberList");
});

// ---------------------------------------------------------------------------
// ヘルプ・終了コード・KV を開けないとき
// ---------------------------------------------------------------------------

Deno.test("--help は 0 で終わり、ヘルプにトークンは出ない", async () => {
  await withTempKv(async ({ run }) => {
    for (const argv of [["--help"], ["-h"], ["help"], []]) {
      const result = await run(...argv);
      assertEquals(result.code, 0, `${JSON.stringify(argv)} は終了コード 0`);
      assertEquals(result.out, HELP);
      assertNoTokenAnywhere(result.all, "ヘルプ");
    }
  });
});

Deno.test("引数不足・不正な id は終了コード 1 で、KV を触らない", async () => {
  await withTempKv(async ({ kvPath, run }) => {
    const cases: readonly string[][] = [
      ["add"],
      ["add", "chiikawa"],
      ["add", "../evil", "ちいかわ"],
      ["add", "ちいかわ", "ちいかわ"],
      ["reissue"],
      ["reissue", "../evil"],
      ["list", "extra"],
      ["unknown"],
      ["--verbose"],
    ];
    for (const argv of cases) {
      const result = await run(...argv);
      assertEquals(result.code, 1, `${JSON.stringify(argv)} は終了コード 1`);
      assertEquals(result.out, "", "誤りは標準エラーへ出すこと");
      assert(result.err.includes(HELP), "誤りのときはヘルプを添えること");
      assertNoTokenAnywhere(result.all, `誤った引数 ${JSON.stringify(argv)}`);
    }
    // 引数の誤りだけで KV ファイルが作られていないこと
    assertFalse(
      await Deno.stat(kvPath).then(() => true).catch(() => false),
      "引数の誤りでは KV を開かないこと",
    );
  });
});

Deno.test("KV を開けないときは終了コード 1 で、原因と確認事項を案内する", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdmin({
    argv: ["list"],
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
    kvPath: "/nowhere/board.kv",
    openKv: () => Promise.reject(new Error("permission denied")),
  });
  assertEquals(code, 1);
  assertEquals(out.length, 0);
  const message = err.join("\n");
  assert(message.includes(ENV_KV_PATH));
  assert(message.includes("/nowhere/board.kv"));
  assert(message.includes("permission denied"), "原因をそのまま伝えること");
  assert(message.includes("止める必要はありません"), "サーバーを止めなくてよい旨を伝えること");
  assertNoTokenAnywhere(message, "KV エラー");
});

Deno.test("サーバーが KV を開いたままでも実行できる", async () => {
  await withTempKv(async ({ kvPath, run }) => {
    // 先に「サーバー役」の接続を張ったまま CLI を動かす（board.service を止めずに使う想定）
    const server = await Deno.openKv(kvPath);
    try {
      const added = await run("add", "chiikawa", "ちいかわ");
      assertEquals(added.code, 0);
      const token = extractToken(added.out);

      // サーバー役の接続からも、登録された内容がそのまま見える
      const member = (await server.get<Member>([KV_PREFIX.member, "chiikawa"])).value;
      assertEquals(member?.tokenHash, await hashToken(token));

      const listed = await run("list");
      assertEquals(listed.code, 0);
      assert(listed.out.includes("chiikawa"));
    } finally {
      server.close();
    }
  });
});
