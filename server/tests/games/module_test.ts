/**
 * server/games/module.ts のユニットテスト
 * 設計書 docs/design/games-unified.md §2.1 / §2.5 / §9.1 に対応する。
 */

import { assert, assertEquals, assertFalse, assertNotEquals } from "@std/assert";
import {
  gameEventPayloadExceedsLimit,
  isRecord,
  moduleFail,
  moduleNoop,
  moduleOk,
  nextSeed,
  randomFloat,
  randomInt,
  readBoolean,
  readInt,
  readKind,
  readString,
  shuffle,
} from "../../games/module.ts";
import { findGameModule, GAME_MODULES } from "../../games/index.ts";
import { PROMPT_MODULE_ID } from "../../games/prompt.ts";
import { GAME_EVENT_PAYLOAD_MAX_BYTES } from "../../types.ts";

// ---------------------------------------------------------------------------
// カタログ（§4）
// ---------------------------------------------------------------------------

Deno.test("カタログ: prompt モジュールが収録されている", () => {
  const found = findGameModule(PROMPT_MODULE_ID);
  assert(found !== null);
  assertEquals(found.kind, "prompt");
});

Deno.test("カタログ: 未知のIDは null を返す", () => {
  assertEquals(findGameModule("no-such-module"), null);
});

Deno.test("カタログ: モジュールIDは重複しない", () => {
  const ids = GAME_MODULES.map((m) => m.id);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("カタログ: meta の人数は 1..10 で minPlayers <= maxPlayers（§2.1）", () => {
  for (const m of GAME_MODULES) {
    assert(m.meta.minPlayers >= 1, `${m.id}: minPlayers が 1 未満`);
    assert(m.meta.maxPlayers <= 10, `${m.id}: maxPlayers が 10 超`);
    assert(m.meta.minPlayers <= m.meta.maxPlayers, `${m.id}: min > max`);
    assert(m.meta.title.length > 0 && [...m.meta.title].length <= 20, `${m.id}: title の長さ`);
    assert([...m.meta.description].length <= 100, `${m.id}: description の長さ`);
  }
});

// ---------------------------------------------------------------------------
// 結果の組み立て
// ---------------------------------------------------------------------------

Deno.test("結果: moduleOk / moduleNoop / moduleFail の changed と error", () => {
  assertEquals(moduleOk({ a: 1 }, [{ t: "viewChanged" }]), {
    state: { a: 1 },
    changed: true,
    effects: [{ t: "viewChanged" }],
  });
  assertEquals(moduleNoop("s"), { state: "s", changed: false, effects: [] });
  const failed = moduleFail("s", "INVALID_INPUT", "だめ");
  assertEquals(failed.changed, false);
  assertEquals(failed.error, "INVALID_INPUT");
  assertEquals(failed.effects, []);
});

// ---------------------------------------------------------------------------
// seed PRNG（§2.5）
// ---------------------------------------------------------------------------

Deno.test("PRNG: 同じ種からは必ず同じ列が出る（決定的）", () => {
  const runOnce = (seed: number) => {
    let s = seed;
    const out: number[] = [];
    for (let i = 0; i < 32; i++) {
      const r = randomInt(s, 0, 100);
      s = r.seed;
      out.push(r.value);
    }
    return out;
  };
  assertEquals(runOnce(12345), runOnce(12345));
  assertNotEquals(runOnce(12345), runOnce(12346));
});

Deno.test("PRNG: 種が 0 でも止まらない（xorshift の自己ループを避ける）", () => {
  const first = nextSeed(0);
  assertNotEquals(first, 0);
  assertNotEquals(nextSeed(first), first);
});

Deno.test("PRNG: 値は 32bit 符号なしの範囲に収まり、同じ値が続かない", () => {
  let s = 1;
  let previous = -1;
  for (let i = 0; i < 1000; i++) {
    s = nextSeed(s);
    assert(Number.isInteger(s));
    assert(s >= 0 && s <= 0xffff_ffff, `範囲外: ${s}`);
    assertNotEquals(s, previous);
    previous = s;
  }
});

Deno.test("PRNG: randomFloat は 0 以上 1 未満", () => {
  let s = 987654;
  for (let i = 0; i < 1000; i++) {
    const r = randomFloat(s);
    s = r.seed;
    assert(r.value >= 0 && r.value < 1, `範囲外: ${r.value}`);
  }
});

Deno.test("PRNG: randomInt は min 以上 max 未満に収まる", () => {
  let s = 42;
  for (let i = 0; i < 2000; i++) {
    const r = randomInt(s, 3, 7);
    s = r.seed;
    assert(r.value >= 3 && r.value < 7, `範囲外: ${r.value}`);
  }
});

Deno.test("PRNG: randomInt の範囲が空なら min をそのまま返す", () => {
  assertEquals(randomInt(1, 5, 5).value, 5);
  assertEquals(randomInt(1, 5, 2).value, 5);
});

Deno.test("PRNG: shuffle は決定的で、元の要素を過不足なく含む", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const a = shuffle(2024, items);
  const b = shuffle(2024, items);
  assertEquals(a.value, b.value);
  assertEquals([...a.value].sort((x, y) => x - y), items);
  // 入力の配列は変更しない（規約2）
  assertEquals(items, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // 種が違えば並びも変わる（10要素なら偶然の一致はまず起きない）
  assertNotEquals(shuffle(2025, items).value, a.value);
});

// ---------------------------------------------------------------------------
// payload の型検証（§9.1）
// ---------------------------------------------------------------------------

Deno.test("検証: isRecord は素のオブジェクトだけを通す", () => {
  assert(isRecord({}));
  assertFalse(isRecord(null));
  assertFalse(isRecord([1, 2]));
  assertFalse(isRecord("s"));
  assertFalse(isRecord(1));
  assertFalse(isRecord(undefined));
});

Deno.test("検証: readKind は文字列の k だけを返す", () => {
  assertEquals(readKind({ k: "tap" }), "tap");
  assertEquals(readKind({ k: 1 }), null);
  assertEquals(readKind({}), null);
  assertEquals(readKind([{ k: "tap" }]), null);
  assertEquals(readKind(null), null);
});

Deno.test("検証: readString は型・空・長さ超過を弾く", () => {
  assertEquals(readString({ v: "abc" }, "v", 3), "abc");
  assertEquals(readString({ v: "abcd" }, "v", 3), null);
  assertEquals(readString({ v: "" }, "v", 3), null);
  assertEquals(readString({ v: 1 }, "v", 3), null);
  assertEquals(readString({}, "v", 3), null);
  assertEquals(readString("x", "v", 3), null);
});

Deno.test("検証: readInt は非整数・範囲外を弾く（min / max とも含む）", () => {
  assertEquals(readInt({ v: 3 }, "v", 0, 3), 3);
  assertEquals(readInt({ v: 0 }, "v", 0, 3), 0);
  assertEquals(readInt({ v: 4 }, "v", 0, 3), null);
  assertEquals(readInt({ v: -1 }, "v", 0, 3), null);
  assertEquals(readInt({ v: 1.5 }, "v", 0, 3), null);
  assertEquals(readInt({ v: Number.NaN }, "v", 0, 3), null);
  assertEquals(readInt({ v: "1" }, "v", 0, 3), null);
});

Deno.test("検証: readBoolean は真偽値だけを通す", () => {
  assertEquals(readBoolean({ v: false }, "v"), false);
  assertEquals(readBoolean({ v: true }, "v"), true);
  assertEquals(readBoolean({ v: "true" }, "v"), null);
  assertEquals(readBoolean({}, "v"), null);
});

Deno.test("検証: payload の直列化サイズ上限（§9.3）", () => {
  assertFalse(gameEventPayloadExceedsLimit({ k: "tap", cell: 3 }));
  // 上限ちょうどは通し、1バイト超えたら弾く
  const overhead = JSON.stringify({ v: "" }).length;
  const fit = "a".repeat(GAME_EVENT_PAYLOAD_MAX_BYTES - overhead);
  assertFalse(gameEventPayloadExceedsLimit({ v: fit }));
  assert(gameEventPayloadExceedsLimit({ v: `${fit}a` }));
});

Deno.test("検証: 直列化できない payload は上限超過と同じ扱いにする", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert(gameEventPayloadExceedsLimit(circular));
  assert(gameEventPayloadExceedsLimit(undefined));
  assert(gameEventPayloadExceedsLimit(() => {}));
});
