/**
 * room_tags.ts のユニットテスト
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { isValidRoomTagId, ROOM_TAGS } from "../room_tags.ts";

Deno.test("ROOM_TAGS: 各タグにidとlabelがある", () => {
  assert(ROOM_TAGS.length > 0);
  for (const tag of ROOM_TAGS) {
    assert(typeof tag.id === "string" && tag.id.length > 0);
    assert(typeof tag.label === "string" && tag.label.length > 0);
  }
});

Deno.test("isValidRoomTagId: プリセットのidのみ受理する", () => {
  assert(isValidRoomTagId(ROOM_TAGS[0].id));
  assertFalse(isValidRoomTagId("no-such-tag"));
  assertFalse(isValidRoomTagId(123));
  assertFalse(isValidRoomTagId(undefined));
});

Deno.test("ROOM_TAGS: idに重複がない", () => {
  const ids = ROOM_TAGS.map((t) => t.id);
  assertEquals(new Set(ids).size, ids.length);
});
