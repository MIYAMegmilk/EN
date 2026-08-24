/**
 * プリセット趣味タグ（§3.11）の単体テスト。
 * 自由入力は受け付けず、プリセットIDのみを許可することを確認する。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
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
