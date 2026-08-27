/**
 * プリセット趣味タグ（§3.11）の単体テスト。
 * 自由入力は受け付けず、プリセットIDのみを許可することを確認する。
 */

import { assert, assertEquals, assertExists, assertFalse } from "@std/assert";
import { TAG_NICKNAME_WORDS, TOPIC_CARDS } from "../bot_templates.ts";
import { HOBBY_TAGS, hobbyTagLabel, isValidHobbyTagId } from "../hobby_tags.ts";
import { NICKNAME_MAX } from "../types.ts";

Deno.test("HOBBY_TAGS: 20件のプリセットが id・label を持つ", () => {
  assertEquals(HOBBY_TAGS.length, 20);
  for (const tag of HOBBY_TAGS) {
    assert(tag.id.length > 0);
    assert(tag.label.length > 0);
  }
});

Deno.test("HOBBY_TAGS: id は重複しない", () => {
  const ids = HOBBY_TAGS.map((t) => t.id);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("isValidHobbyTagId: プリセットのIDは true", () => {
  assert(isValidHobbyTagId("game"));
  assert(isValidHobbyTagId("pet"));
});

Deno.test("isValidHobbyTagId: プリセットにないIDや自由入力文字列は false", () => {
  assertFalse(isValidHobbyTagId("gaming"));
  assertFalse(isValidHobbyTagId("不適切な自由入力"));
  assertFalse(isValidHobbyTagId(""));
  assertFalse(isValidHobbyTagId(123));
  assertFalse(isValidHobbyTagId(undefined));
});

// ---------------------------------------------------------------------------
// 話題カードとの照合（§3.10 ぐっちー × §3.11）
//
// TOPIC_CARDS.tags はこのファイルの HobbyTagId が正本。過去に "sake" / "oshikatsu" と
// 書かれていて（正しくは "alcohol" / "oshi"）、共通タグに一致しないカードになっていた。
// commonTags が未実装（rooms.ts の TODO）で常に空だったため誰も気づけなかった。
// いまは TopicCard.tags を HobbyTagId で縛ったので型で落ちるが、string に緩められても
// 気づけるよう実行時にも突き合わせておく。
// ---------------------------------------------------------------------------

Deno.test("TOPIC_CARDS: tags はすべてプリセットのタグIDである", () => {
  for (const card of TOPIC_CARDS) {
    for (const tag of card.tags) {
      assert(
        isValidHobbyTagId(tag),
        `話題カード ${card.id} のタグ "${tag}" が hobby_tags.ts に存在しない`,
      );
    }
  }
});

Deno.test("TOPIC_CARDS: タグ付きカードと汎用カードが両方ある", () => {
  // 全部タグ付きだと共通タグのない場（＝いまの既定）で話題が尽き、
  // 全部汎用だとタグを見る意味がなくなる
  assert(TOPIC_CARDS.some((c) => c.tags.length > 0), "タグ付きの話題カードが1枚もない");
  assert(TOPIC_CARDS.some((c) => c.tags.length === 0), "汎用の話題カードが1枚もない");
});

// ---------------------------------------------------------------------------
// あだ名の連想語との照合（§3.10 しゅんぴ × §3.11）
//
// タグを選んだ人には、そのタグから連想した二つ名が付く（bot.ts の pickNickname）。
// 連想語が1タグでも欠けると、そのタグを選んだ人だけ汎用の名前に落ちて
// 「タグを選んだのに関係ない名前」が復活する。型では埋め忘れしか防げないので、
// 中身が空でないことと、組み合わせが名前の長さ上限に収まることをここで見る。
// ---------------------------------------------------------------------------

Deno.test("TAG_NICKNAME_WORDS: 全プリセットタグに連想語がある", () => {
  for (const tag of HOBBY_TAGS) {
    const words = TAG_NICKNAME_WORDS[tag.id];
    assertExists(words, `タグ ${tag.id} の連想語が無い`);
    assert(words.adjectives.length > 0, `タグ ${tag.id} の形容が空`);
    assert(words.nouns.length > 0, `タグ ${tag.id} の名詞が空`);
  }
  assertEquals(Object.keys(TAG_NICKNAME_WORDS).length, HOBBY_TAGS.length);
});

Deno.test("TAG_NICKNAME_WORDS: 最長どうしを繋いでもあだ名の上限に収まる", () => {
  // pickNickname は上限を超える組み合わせを候補から落とす。最長どうしが収まっていれば
  // そのタグの候補が丸ごと消えることはない（＝1段目が構造的に空にならない）
  for (const tag of HOBBY_TAGS) {
    const words = TAG_NICKNAME_WORDS[tag.id];
    const longest = (items: readonly string[]) =>
      items.reduce((a, b) => (b.length > a.length ? b : a));
    const name = `${longest(words.adjectives)}${longest(words.nouns)}`;
    assert(name.length <= NICKNAME_MAX, `タグ ${tag.id} の最長の組み合わせが長すぎる: ${name}`);
  }
});

Deno.test("hobbyTagLabel: タグIDを表示名に直す", () => {
  assertEquals(hobbyTagLabel("reading"), "読書");
  for (const tag of HOBBY_TAGS) {
    assertEquals(hobbyTagLabel(tag.id), tag.label);
  }
});
