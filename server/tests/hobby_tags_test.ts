/**
 * プリセット趣味タグ（§3.11）の単体テスト。
 * 自由入力は受け付けず、プリセットIDのみを許可することを確認する。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { TOPIC_CARDS } from "../bot_templates.ts";
import { HOBBY_TAGS, isValidHobbyTagId } from "../hobby_tags.ts";

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
