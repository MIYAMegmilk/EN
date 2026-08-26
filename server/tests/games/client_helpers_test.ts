/**
 * public/room/games/_client.js の純粋ヘルパーの検証。
 *
 * 眼目は2つ。
 *   1. **他人から届く payload の検証**（kindOf / intField / readArray）が
 *      壊れた値・悪意ある値を確実にはねること。ここが漏れると、
 *      1人の細工で卓の全員の画面が壊れる（設計書 §9.3 / 雛形の規約7）
 *   2. **seed から作る乱数がサーバーの PRNG と一致すること**。
 *      「進行を通信で配らず、各自が seed から導く」という reflex / emoawase の
 *      土台なので、ここがずれると卓の全員でゲームの中身が食い違う
 *
 * DOM を触る関数（createShell / createCanvas / createLoop）は含めない。
 * それらは実ブラウザ2窓での手動確認に回す（設計書 §7.1 のチェックリスト）。
 */

import { assert, assertEquals } from "@std/assert";
import { randomFloat, randomInt, shuffle } from "../../games/module.ts";

const client = await import("../../../public/room/games/_client.js");

// ---------------------------------------------------------------------------
// 1. 他人から届く payload の検証
// ---------------------------------------------------------------------------

Deno.test("kindOf: オブジェクトで k が文字列のときだけ種別を返す", () => {
  assertEquals(client.kindOf({ k: "tap" }), "tap");
  for (const bad of [null, undefined, 0, "tap", true, ["tap"], { k: 1 }, { k: null }, {}]) {
    assertEquals(client.kindOf(bad), null, `${JSON.stringify(bad)} を通している`);
  }
});

Deno.test("intField: 整数かつ範囲内のときだけ値を返す", () => {
  assertEquals(client.intField({ v: 5 }, "v", 0, 10), 5);
  assertEquals(client.intField({ v: 0 }, "v", 0, 10), 0);
  assertEquals(client.intField({ v: 10 }, "v", 0, 10), 10);
  for (
    const bad of [
      { v: 11 },
      { v: -1 },
      { v: 1.5 },
      { v: "5" },
      { v: NaN },
      { v: Infinity },
      { v: null },
      {},
    ]
  ) {
    assertEquals(client.intField(bad, "v", 0, 10), null, `${JSON.stringify(bad)} を通している`);
  }
  assertEquals(client.intField(null, "v", 0, 10), null);
});

Deno.test("readArray / readNumber: 形が違えば安全な既定値に落ちる", () => {
  assertEquals(client.readArray({ events: [1, 2] }, "events"), [1, 2]);
  for (const bad of [null, 0, "x", { events: "x" }, { events: null }, {}]) {
    assertEquals(client.readArray(bad, "events"), []);
  }
  assertEquals(client.readNumber({ seed: 7 }, "seed", -1), 7);
  for (const bad of [{ seed: "7" }, { seed: NaN }, { seed: Infinity }, {}, null]) {
    assertEquals(client.readNumber(bad, "seed", -1), -1);
  }
});

Deno.test("nameOf: 未知のIDや壊れた名簿でも文字列を返す（表示が落ちない）", () => {
  const view = { players: [{ id: "a", name: "たろう" }, null, { id: "b" }, "x"] };
  assertEquals(client.nameOf(view, "a"), "たろう");
  assertEquals(client.nameOf(view, "b"), "誰か"); // name が無い
  assertEquals(client.nameOf(view, "zzz"), "誰か");
  assertEquals(client.nameOf(null, "a"), "誰か");
});

// ---------------------------------------------------------------------------
// 中継ログの差分読み出し
// ---------------------------------------------------------------------------

Deno.test("createRelayReader: 同じイベントを二度返さず、連番順に並べる", () => {
  const reader = client.createRelayReader();
  const first = reader.take({
    events: [{ n: 2, from: "b", payload: 2 }, { n: 1, from: "a", payload: 1 }],
  });
  assertEquals(first.map((e) => e.n), [1, 2]);
  // 同じ view をもう一度渡しても、処理済みなので何も返らない
  assertEquals(reader.take({ events: [{ n: 1, from: "a", payload: 1 }] }), []);
  // 新しいぶんだけ返る
  const next = reader.take({
    events: [{ n: 2, from: "b", payload: 2 }, { n: 5, from: "c", payload: 5 }],
  });
  assertEquals(next.map((e) => e.n), [5]);
});

Deno.test("createRelayReader: 壊れたイベントは黙って捨てる", () => {
  const reader = client.createRelayReader();
  const got = reader.take({
    events: [
      null,
      "x",
      { n: "1", from: "a" },
      { n: 1, from: 3 },
      { n: NaN, from: "a" },
      { n: 3, from: "a", payload: { ok: true } },
    ],
  });
  assertEquals(got.length, 1);
  assertEquals(got[0].n, 3);
  // events が無い view でも落ちない
  assertEquals(reader.take(null), []);
  assertEquals(reader.take({}), []);
});

// ---------------------------------------------------------------------------
// 2. seed PRNG がサーバーと一致する
// ---------------------------------------------------------------------------

Deno.test("createRng: サーバーの randomFloat と同じ列を返す（通信なしの同期の根拠）", () => {
  for (const seed of [0, 1, 20260826, 0xffff_ffff]) {
    const rng = client.createRng(seed);
    let s = seed;
    for (let i = 0; i < 20; i++) {
      const expected = randomFloat(s);
      s = expected.seed;
      assertEquals(rng.float(), expected.value, `seed=${seed} の ${i} 番目がずれている`);
    }
  }
});

Deno.test("createRng.shuffle: サーバーの shuffle と同じ並びになる", () => {
  const items = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
  for (const seed of [1, 20260826, 999_999]) {
    assertEquals(client.createRng(seed).shuffle(items), shuffle(seed, items).value);
  }
});

Deno.test("createRng.int: サーバーの randomInt と同じ値を同じ順に返す", () => {
  for (const seed of [1, 20260826, 0xffff_ffff]) {
    const rng = client.createRng(seed);
    let s = seed;
    for (let i = 0; i < 20; i++) {
      const expected = randomInt(s, 1200, 4001);
      s = expected.seed;
      assertEquals(rng.int(1200, 4001), expected.value, `seed=${seed} の ${i} 番目がずれている`);
    }
  }
});

Deno.test("createRng.int: 範囲内に収まる", () => {
  const rng = client.createRng(20260826);
  for (let i = 0; i < 500; i++) {
    const v = rng.int(1200, 4001);
    assert(Number.isInteger(v) && v >= 1200 && v <= 4000, `範囲外: ${v}`);
  }
});

Deno.test("createRng.int: 空の範囲でも min を返し、種はサーバーと同じだけ進む", () => {
  // サーバーの randomInt は空範囲でも nextSeed を1回進める。ここを揃えないと、
  // 空範囲を1回通しただけで以降の乱数列が卓の全員で食い違う
  assertEquals(client.createRng(1).int(5, 5), 5);
  assertEquals(client.createRng(1).int(5, 1), 5);
  for (const [min, max] of [[5, 5], [5, 1]] as const) {
    const rng = client.createRng(20260826);
    assertEquals(rng.int(min, max), min);
    // 空範囲を1回通したあとの続きが、サーバー側の続きと一致する
    const after = randomInt(20260826, min, max);
    assertEquals(rng.float(), randomFloat(after.seed).value, `[${min},${max}) の後がずれている`);
  }
});
