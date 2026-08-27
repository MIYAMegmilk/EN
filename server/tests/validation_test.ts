/**
 * validation.ts のユニットテスト
 * rooms.ts を経由せず直接インポートして、公開面が独立して成り立つことを確認する。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { hasControlChar, validateHobbyTags, validateNickname } from "../validation.ts";
import { HOBBY_TAGS_MAX } from "../hobby_tags.ts";

Deno.test("ニックネーム検証: 前後の空白を除去して受理する", () => {
  const res = validateNickname("  たろう  ");
  assert(res.ok);
  assertEquals(res.value, "たろう");
});

Deno.test("ニックネーム検証: 空・21文字以上・制御文字を拒否する", () => {
  assertFalse(validateNickname("   ").ok);
  assertFalse(validateNickname("あ".repeat(21)).ok);
  assertFalse(validateNickname("た\nろう").ok);
  assertFalse(validateNickname(123).ok);
  assert(validateNickname("あ".repeat(20)).ok);
});

Deno.test("hasControlChar: 制御文字の有無を判定する", () => {
  assertFalse(hasControlChar("たろう"));
  assert(hasControlChar("た\nろう"));
  assert(hasControlChar("た\x00ろう"));
  assert(hasControlChar("た\x7fろう"));
});

Deno.test("趣味タグ検証: プリセットのIDだけを受理し、重複は畳む（§3.11）", () => {
  const res = validateHobbyTags(["game", "alcohol", "game"]);
  assert(res.ok);
  assertEquals(res.value, ["game", "alcohol"]);
});

Deno.test("趣味タグ検証: 省略は「タグ無し」として空で受理する", () => {
  const res = validateHobbyTags(undefined);
  assert(res.ok);
  assertEquals(res.value, []);
});

Deno.test("趣味タグ検証: プリセット外・配列以外・上限超えを拒否する", () => {
  // 自由入力の混入を構造的に防ぐのが §3.11 の肝なので、1つでも混ざれば丸ごと弾く
  assertFalse(validateHobbyTags(["game", "sake"]).ok);
  assertFalse(validateHobbyTags(["<script>"]).ok);
  assertFalse(validateHobbyTags("game").ok);
  assertFalse(validateHobbyTags([1, 2]).ok);
  const six = ["game", "anime", "manga", "music", "movie", "sports"];
  assertEquals(six.length, HOBBY_TAGS_MAX + 1);
  assertFalse(validateHobbyTags(six).ok);
  assert(validateHobbyTags(six.slice(0, HOBBY_TAGS_MAX)).ok);
});
