/**
 * validation.ts のユニットテスト
 * rooms.ts を経由せず直接インポートして、公開面が独立して成り立つことを確認する。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { hasControlChar, validateNickname } from "../validation.ts";

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
