/**
 * gamedef.ts / official_games.ts のユニットテスト
 * 詳細仕様書 §3.5 / §3.8 のバリデーションと KV 操作を検証する。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  createGame,
  deleteGame,
  DESCRIPTION_MAX,
  generateShareCode,
  getGame,
  INPUT_TIME_MAX,
  INPUT_TIME_MIN,
  issueShareCode,
  isValidShareCode,
  listUserGameIds,
  listUserGames,
  normalizeShareCode,
  OPTION_TEXT_MAX,
  PROMPT_TEXT_MAX,
  PROMPTS_MAX,
  resolveShareCode,
  ROUNDS_MAX,
  serializedSize,
  shareCodeKey,
  TITLE_MAX,
  toSummary,
  updateGame,
  validateGameDefinition,
  validateGameDefinitionDraft,
} from "../gamedef.ts";
import { OFFICIAL_GAMES } from "../official_games.ts";
import {
  GAME_DEFINITION_BYTES_MAX,
  type GameDefinition,
  type GameDefinitionDraft,
  GAMES_PER_USER_MAX,
  SHARE_CODE_LENGTH,
} from "../types.ts";

/** 妥当な text 系の入稿データ */
function textDraft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "大喜利もどき",
    description: "説明",
    rounds: 3,
    inputType: "text",
    inputTimeSec: 60,
    reveal: "anonymous",
    scoring: "vote",
    prompts: [{ kind: "open", text: "お題1" }],
    ...over,
  };
}

/** 妥当な choice 系の入稿データ */
function choiceDraft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "クイズもどき",
    rounds: 2,
    inputType: "choice",
    inputTimeSec: 20,
    reveal: "anonymous",
    scoring: "correct",
    prompts: [{ kind: "choice", text: "Q1", options: ["A", "B"], answer: 1 }],
    ...over,
  };
}

/** 検証が成功することを確認する */
function assertValid(input: unknown): GameDefinitionDraft {
  const res = validateGameDefinitionDraft(input);
  assert(res.ok, `検証に失敗: ${res.ok ? "" : res.errors.join(" / ")}`);
  return res.value;
}

/** 検証が失敗することを確認する */
function assertInvalid(input: unknown) {
  const res = validateGameDefinitionDraft(input);
  assertFalse(res.ok);
}

/** メモリ上の KV を使ってテスト本体を実行する */
async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

// ---------------------------------------------------------------------------
// バリデーション: 正常系
// ---------------------------------------------------------------------------

Deno.test("validate: 妥当な text 定義を受理する", () => {
  const v = assertValid(textDraft());
  assertEquals(v.title, "大喜利もどき");
  assertEquals(v.prompts.length, 1);
});

Deno.test("validate: 妥当な choice 定義を受理する", () => {
  const v = assertValid(choiceDraft());
  assertEquals(v.prompts[0], { kind: "choice", text: "Q1", options: ["A", "B"], answer: 1 });
});

Deno.test("validate: 文字列は trim され、空の説明は省かれる", () => {
  const v = assertValid(textDraft({ title: "  題名  ", description: "   " }));
  assertEquals(v.title, "題名");
  assertEquals(v.description, undefined);
});

Deno.test("validate: 公式ゲームはすべて仕様を満たす", () => {
  for (const g of OFFICIAL_GAMES) {
    const res = validateGameDefinition(g);
    assert(res.ok, `${g.title}: ${res.ok ? "" : res.errors.join(" / ")}`);
    assert(g.prompts.length >= 25, `${g.title}: お題は25件以上必要です`);
  }
  assertEquals(OFFICIAL_GAMES.length, 4);
  assertEquals(new Set(OFFICIAL_GAMES.map((g) => g.id)).size, 4);
});

Deno.test("validate: 公式ゲームのお題本文はゲーム内で重複しない", () => {
  for (const g of OFFICIAL_GAMES) {
    const texts = g.prompts.map((p) => p.text);
    assertEquals(
      new Set(texts).size,
      texts.length,
      `${g.title}: お題本文が重複しています`,
    );
  }
});

// ---------------------------------------------------------------------------
// バリデーション: 境界値
// ---------------------------------------------------------------------------

Deno.test("validate: タイトルの境界値（0 / 20 / 21文字）", () => {
  assertInvalid(textDraft({ title: "" }));
  assertInvalid(textDraft({ title: "   " }));
  assertValid(textDraft({ title: "あ".repeat(TITLE_MAX) }));
  assertInvalid(textDraft({ title: "あ".repeat(TITLE_MAX + 1) }));
});

Deno.test("validate: 説明の境界値（100 / 101文字）", () => {
  assertValid(textDraft({ description: "あ".repeat(DESCRIPTION_MAX) }));
  assertInvalid(textDraft({ description: "あ".repeat(DESCRIPTION_MAX + 1) }));
});

Deno.test("validate: ラウンド数の境界値（0 / 1 / 10 / 11）", () => {
  assertInvalid(textDraft({ rounds: 0 }));
  assertValid(textDraft({ rounds: 1 }));
  assertValid(textDraft({ rounds: ROUNDS_MAX }));
  assertInvalid(textDraft({ rounds: ROUNDS_MAX + 1 }));
  assertInvalid(textDraft({ rounds: 1.5 }));
  assertInvalid(textDraft({ rounds: "3" }));
});

Deno.test("validate: 入力時間の境界値（9 / 10 / 180 / 181）", () => {
  assertInvalid(textDraft({ inputTimeSec: INPUT_TIME_MIN - 1 }));
  assertValid(textDraft({ inputTimeSec: INPUT_TIME_MIN }));
  assertValid(textDraft({ inputTimeSec: INPUT_TIME_MAX }));
  assertInvalid(textDraft({ inputTimeSec: INPUT_TIME_MAX + 1 }));
});

Deno.test("validate: お題件数の境界値（0 / 1 / 50 / 51）", () => {
  assertInvalid(textDraft({ prompts: [] }));
  assertValid(textDraft({ prompts: [{ kind: "open", text: "1" }] }));
  const many = Array.from({ length: PROMPTS_MAX }, (_, i) => ({ kind: "open", text: `お題${i}` }));
  assertValid(textDraft({ prompts: many }));
  assertInvalid(textDraft({ prompts: [...many, { kind: "open", text: "超過" }] }));
  assertInvalid(textDraft({ prompts: "お題" }));
});

Deno.test("validate: お題本文・選択肢の文字数境界値", () => {
  assertValid(textDraft({ prompts: [{ kind: "open", text: "あ".repeat(PROMPT_TEXT_MAX) }] }));
  assertInvalid(textDraft({ prompts: [{ kind: "open", text: "あ".repeat(PROMPT_TEXT_MAX + 1) }] }));
  assertValid(
    choiceDraft({
      prompts: [{
        kind: "choice",
        text: "Q",
        options: ["あ".repeat(OPTION_TEXT_MAX), "B"],
        answer: 0,
      }],
    }),
  );
  assertInvalid(
    choiceDraft({
      prompts: [{
        kind: "choice",
        text: "Q",
        options: ["あ".repeat(OPTION_TEXT_MAX + 1), "B"],
        answer: 0,
      }],
    }),
  );
});

Deno.test("validate: 選択肢の件数境界値（1 / 2 / 6 / 7）と重複", () => {
  const mk = (n: number) =>
    choiceDraft({
      prompts: [{
        kind: "choice",
        text: "Q",
        options: Array.from({ length: n }, (_, i) => `opt${i}`),
        answer: 0,
      }],
    });
  assertInvalid(mk(1));
  assertValid(mk(2));
  assertValid(mk(6));
  assertInvalid(mk(7));
  assertInvalid(
    choiceDraft({ prompts: [{ kind: "choice", text: "Q", options: ["A", "A"], answer: 0 }] }),
  );
});

// ---------------------------------------------------------------------------
// バリデーション: 異常系
// ---------------------------------------------------------------------------

Deno.test("validate: オブジェクト以外は拒否する", () => {
  assertInvalid(null);
  assertInvalid("定義");
  assertInvalid([textDraft()]);
  assertInvalid(42);
});

Deno.test("validate: scoring と inputType の整合（§3.5）", () => {
  assertValid(textDraft({ scoring: "vote", inputType: "text" }));
  assertValid(textDraft({ scoring: "match", inputType: "text" }));
  assertValid(choiceDraft({ scoring: "correct", inputType: "choice" }));
  // vote / match は choice 不可、correct は text 不可
  assertInvalid(choiceDraft({ scoring: "vote" }));
  assertInvalid(choiceDraft({ scoring: "match" }));
  assertInvalid(textDraft({ scoring: "correct" }));
});

Deno.test("validate: 列挙値が不正なら拒否する", () => {
  assertInvalid(textDraft({ inputType: "voice" }));
  assertInvalid(textDraft({ reveal: "secret" }));
  assertInvalid(textDraft({ scoring: "random" }));
});

Deno.test("validate: お題の kind が inputType と一致しないと拒否する", () => {
  assertInvalid(textDraft({ prompts: [{ kind: "choice", text: "Q", options: ["A", "B"] }] }));
  assertInvalid(choiceDraft({ prompts: [{ kind: "open", text: "Q" }] }));
});

Deno.test("validate: scoring=correct では answer が必須かつ範囲内", () => {
  assertInvalid(choiceDraft({ prompts: [{ kind: "choice", text: "Q", options: ["A", "B"] }] }));
  assertInvalid(
    choiceDraft({ prompts: [{ kind: "choice", text: "Q", options: ["A", "B"], answer: 2 }] }),
  );
  assertInvalid(
    choiceDraft({ prompts: [{ kind: "choice", text: "Q", options: ["A", "B"], answer: -1 }] }),
  );
  assertValid(
    choiceDraft({ prompts: [{ kind: "choice", text: "Q", options: ["A", "B"], answer: 0 }] }),
  );
});

Deno.test("validate: open のお題に選択肢や正解を付けると拒否する", () => {
  assertInvalid(textDraft({ prompts: [{ kind: "open", text: "Q", options: ["A"] }] }));
  assertInvalid(textDraft({ prompts: [{ kind: "open", text: "Q", answer: 0 }] }));
});

Deno.test("validate: 制御文字を含むテキストは拒否する", () => {
  assertInvalid(textDraft({ title: `題名${String.fromCharCode(0)}` }));
  assertInvalid(textDraft({ prompts: [{ kind: "open", text: `お題${String.fromCharCode(27)}` }] }));
});

Deno.test("validate: 完全な定義は id / ownerId も検証する", () => {
  const full = { ...textDraft(), id: "abc", ownerId: "user1" };
  assert(validateGameDefinition(full).ok);
  assertFalse(validateGameDefinition({ ...textDraft(), ownerId: "user1" }).ok);
  assertFalse(validateGameDefinition({ ...textDraft(), id: "", ownerId: "user1" }).ok);
  assertFalse(validateGameDefinition({ ...textDraft(), id: "abc" }).ok);
});

// ---------------------------------------------------------------------------
// 要約・サイズ
// ---------------------------------------------------------------------------

Deno.test("toSummary: prompts を含まない要約を返す", () => {
  const summary = toSummary(OFFICIAL_GAMES[0], true);
  assertEquals(summary.official, true);
  assertEquals(summary.promptCount, OFFICIAL_GAMES[0].prompts.length);
  assertFalse(Object.hasOwn(summary, "prompts"));
});

Deno.test("serializedSize: UTF-8 バイト数を返す", () => {
  const def: GameDefinition = { id: "i", ownerId: "o", ...assertValid(textDraft()) };
  assertEquals(serializedSize(def), new TextEncoder().encode(JSON.stringify(def)).length);
  assert(serializedSize(def) < GAME_DEFINITION_BYTES_MAX);
});

// ---------------------------------------------------------------------------
// KV: 作成・取得・一覧
// ---------------------------------------------------------------------------

Deno.test("createGame: 保存して取得できる。ownerId はサーバーが付与する", async () => {
  await withKv(async (kv) => {
    const res = await createGame(kv, "user1", { ...textDraft(), ownerId: "なりすまし", id: "x" });
    assert(res.ok);
    assertEquals(res.value.ownerId, "user1");
    assert(res.value.id !== "x");
    const fetched = await getGame(kv, res.value.id);
    assertEquals(fetched?.title, "大喜利もどき");
    assertEquals(await listUserGameIds(kv, "user1"), [res.value.id]);
  });
});

Deno.test("createGame: 不正な定義は INVALID_INPUT", async () => {
  await withKv(async (kv) => {
    const res = await createGame(kv, "user1", textDraft({ rounds: 99 }));
    assertFalse(res.ok);
    if (!res.ok) assertEquals(res.code, "INVALID_INPUT");
    assertEquals(await listUserGameIds(kv, "user1"), []);
  });
});

Deno.test("createGame: 64KB を超える定義は拒否する（§3.8）", async () => {
  await withKv(async (kv) => {
    // 1文字4バイトの文字で上限いっぱいの定義を作る
    const big = "𠀋";
    const prompts = Array.from({ length: PROMPTS_MAX }, () => ({
      kind: "choice",
      text: big.repeat(PROMPT_TEXT_MAX),
      options: Array.from({ length: 6 }, (_, i) => big.repeat(OPTION_TEXT_MAX - 1) + String(i)),
      answer: 0,
    }));
    const res = await createGame(kv, "user1", choiceDraft({ prompts }));
    assertFalse(res.ok);
    if (!res.ok) {
      assertEquals(res.code, "INVALID_INPUT");
      assert(res.message.includes("64KB"));
    }
  });
});

Deno.test("createGame: 1アカウント50件で上限（境界値、§3.5）", async () => {
  await withKv(async (kv) => {
    for (let i = 0; i < GAMES_PER_USER_MAX; i++) {
      const res = await createGame(kv, "user1", textDraft({ title: `ゲーム${i}` }));
      assert(res.ok, `${i}件目で失敗`);
    }
    assertEquals((await listUserGameIds(kv, "user1")).length, GAMES_PER_USER_MAX);
    const over = await createGame(kv, "user1", textDraft({ title: "51件目" }));
    assertFalse(over.ok);
    if (!over.ok) assertEquals(over.code, "INVALID_INPUT");
    // 他のユーザーには影響しない
    assert((await createGame(kv, "user2", textDraft())).ok);
  });
});

Deno.test("listUserGames: 自分の定義のみ返す", async () => {
  await withKv(async (kv) => {
    await createGame(kv, "user1", textDraft({ title: "A" }));
    await createGame(kv, "user2", textDraft({ title: "B" }));
    const mine = await listUserGames(kv, "user1");
    assertEquals(mine.map((g) => g.title), ["A"]);
    assertEquals(await listUserGames(kv, "unknown"), []);
  });
});

// ---------------------------------------------------------------------------
// KV: 更新・削除
// ---------------------------------------------------------------------------

Deno.test("updateGame: 所有者のみ更新できる", async () => {
  await withKv(async (kv) => {
    const created = await createGame(kv, "user1", textDraft());
    assert(created.ok);
    const id = created.value.id;

    const other = await updateGame(kv, "user2", id, textDraft({ title: "乗っ取り" }));
    assertFalse(other.ok);
    if (!other.ok) assertEquals(other.code, "AUTH_REQUIRED");

    const updated = await updateGame(kv, "user1", id, textDraft({ title: "改訂版" }));
    assert(updated.ok);
    assertEquals(updated.value.id, id);
    assertEquals((await getGame(kv, id))?.title, "改訂版");

    const bad = await updateGame(kv, "user1", id, textDraft({ inputTimeSec: 1 }));
    assertFalse(bad.ok);
    const missing = await updateGame(kv, "user1", "no-such-id", textDraft());
    assertFalse(missing.ok);
    if (!missing.ok) assertEquals(missing.code, "ROOM_NOT_FOUND");
  });
});

Deno.test("deleteGame: 所有者のみ削除でき、一覧と共有コードも消える", async () => {
  await withKv(async (kv) => {
    const created = await createGame(kv, "user1", textDraft());
    assert(created.ok);
    const id = created.value.id;
    const share = await issueShareCode(kv, "user1", id);
    assert(share.ok);

    const other = await deleteGame(kv, "user2", id);
    assertFalse(other.ok);
    if (!other.ok) assertEquals(other.code, "AUTH_REQUIRED");

    const removed = await deleteGame(kv, "user1", id);
    assert(removed.ok);
    assertEquals(await getGame(kv, id), null);
    assertEquals(await listUserGameIds(kv, "user1"), []);
    assertEquals((await kv.get(shareCodeKey(share.value))).value, null);
    const resolved = await resolveShareCode(kv, share.value);
    assertFalse(resolved.ok);

    const again = await deleteGame(kv, "user1", id);
    assertFalse(again.ok);
    if (!again.ok) assertEquals(again.code, "ROOM_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// 共有コード
// ---------------------------------------------------------------------------

Deno.test("generateShareCode: 8桁の英数を返す", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateShareCode();
    assertEquals(code.length, SHARE_CODE_LENGTH);
    assert(isValidShareCode(code));
    assert(/^[A-Z0-9]{8}$/.test(code));
  }
});

Deno.test("normalizeShareCode / isValidShareCode", () => {
  assertEquals(normalizeShareCode("  ab cd23 45 "), "ABCD2345");
  assert(isValidShareCode("ABCD2345"));
  assertFalse(isValidShareCode("ABCD234"));
  assertFalse(isValidShareCode("ABCD23456"));
  // 紛らわしい文字（I / O / 0 / 1）は使わない
  assertFalse(isValidShareCode("ABCD2340"));
  assertFalse(isValidShareCode("ABCD234I"));
});

Deno.test("issueShareCode: 所有者のみ発行でき、2回目は同じコードを返す", async () => {
  await withKv(async (kv) => {
    const created = await createGame(kv, "user1", textDraft());
    assert(created.ok);
    const id = created.value.id;

    const other = await issueShareCode(kv, "user2", id);
    assertFalse(other.ok);
    if (!other.ok) assertEquals(other.code, "AUTH_REQUIRED");

    const first = await issueShareCode(kv, "user1", id);
    assert(first.ok);
    const second = await issueShareCode(kv, "user1", id);
    assert(second.ok);
    assertEquals(second.value, first.value);

    const missing = await issueShareCode(kv, "user1", "no-such-id");
    assertFalse(missing.ok);
    if (!missing.ok) assertEquals(missing.code, "ROOM_NOT_FOUND");
  });
});

Deno.test("resolveShareCode: コードから定義を取得できる（ゲスト可）", async () => {
  await withKv(async (kv) => {
    const created = await createGame(kv, "user1", textDraft({ title: "共有ゲーム" }));
    assert(created.ok);
    const share = await issueShareCode(kv, "user1", created.value.id);
    assert(share.ok);

    // 小文字・空白混じりでも解決できる
    const resolved = await resolveShareCode(kv, ` ${share.value.toLowerCase()} `);
    assert(resolved.ok);
    assertEquals(resolved.value.title, "共有ゲーム");

    const badFormat = await resolveShareCode(kv, "ABC");
    assertFalse(badFormat.ok);
    if (!badFormat.ok) assertEquals(badFormat.code, "INVALID_INPUT");

    const unknown = await resolveShareCode(kv, "ZZZZ2345");
    assertFalse(unknown.ok);
    if (!unknown.ok) assertEquals(unknown.code, "ROOM_NOT_FOUND");
  });
});
