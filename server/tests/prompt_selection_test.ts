/**
 * お題の抽選（監査 M-1「毎回まったく同じお題になる」対策）のテスト
 *
 * 背景: `startRound` は `promptIndex = (round - 1) % runtimePrompts.length` を引くだけで、
 * `runtimePrompts` は `definition.prompts` を順番どおりに写していた。そのため
 * 大喜利（28問収録 / rounds 3）は何度遊んでも prompts[0..2] の同じ3問しか出ず、
 * 収録データの大半が日の目を見なかった。以心伝心（28問 / 3）・雑学クイズ（28問 / 5）も同じ。
 *
 * 対策として `buildRuntimePrompts` が**お題の並び自体をシャッフル**する。
 * 乱数は startGame に閉じたまま（reduce / buildPhaseView は純粋・決定的）で、
 * テストは startGame の shuffle 引数へ決定的な並べ替えを注入できる。
 *
 * ここで確かめるのは次の5つ。
 *   1. 抽選されていること（同じ定義を何度開始しても同じお題の組にならない）
 *   2. 1ゲーム内で同じお題が重複しないこと（rounds ≦ 収録数のとき）
 *   3. 収録データが全部使われうること（十分な回数を開始すれば28問すべてが出る）
 *   4. 決定的なシャッフルを注入すれば並びが確定すること（テストから前提を固定できる）
 *   5. 原本を壊さないこと・件数が増減しないこと・境界値（1問だけ / 収録数 < rounds）
 *
 * 選択肢の並べ替えと answer の振り直しは server/tests/quiz_answer_position_test.ts が見る。
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildPhaseView,
  DEFAULT_PHASE_DURATIONS,
  type EnginePlayerInput,
  reduce,
  type ShuffleFn,
  startGame,
} from "../engine.ts";
import { ISHIN_DENSHIN, OGIRI, QUIZ } from "../official_games.ts";
import type { GameDefinition, GameState } from "../types.ts";

const T0 = 1_700_000_000_000;

/** 並べ替えない（恒等）シャッフル */
const identityShuffle: ShuffleFn = <T>(items: readonly T[]): T[] => [...items];

/** 逆順に並べ替える決定的なシャッフル */
const reverseShuffle: ShuffleFn = <T>(items: readonly T[]): T[] => [...items].reverse();

/** テスト用の参加者を作る */
function players(...ids: string[]): EnginePlayerInput[] {
  return ids.map((id) => ({ id, nickname: `nick-${id}`, connected: true }));
}

/** startGame をエラーなしで実行する（shuffle を省略すると本番と同じ暗号乱数） */
function start(def: GameDefinition, shuffle?: ShuffleFn): GameState {
  const res = shuffle === undefined
    ? startGame(def, players("a", "b"), T0)
    : startGame(def, players("a", "b"), T0, DEFAULT_PHASE_DURATIONS, undefined, shuffle);
  assertEquals(res.error, undefined);
  return res.state;
}

/** ホストスキップでフェーズを1段進める */
function skip(state: GameState): GameState {
  const res = reduce(state, { t: "skipPhase", now: T0 });
  assertEquals(res.error, undefined);
  return res.state;
}

/**
 * 1ゲームを最後まで進めて、**実際に出題された**お題の本文を順に集める。
 * state.runtimePrompts の先頭を読むのではなく、prompt フェーズの view を読む。
 * こうすると「クライアントに実際に見えたお題」を検証できる。
 */
function playedPrompts(def: GameDefinition, shuffle?: ShuffleFn): string[] {
  const texts: string[] = [];
  let s = skip(start(def, shuffle)); // intro -> prompt（ラウンド1）
  for (let round = 1; round <= def.rounds; round++) {
    assertEquals(s.phase, "prompt");
    const view = buildPhaseView(s, "a");
    assert(view.phase === "prompt");
    texts.push(view.promptText);
    s = skip(s); // prompt -> input
    s = skip(s); // input -> reveal
    s = skip(s); // reveal -> judge
    s = skip(s); // judge -> roundResult
    s = skip(s); // roundResult -> 次ラウンドの prompt / finalResult
  }
  return texts;
}

/** テスト用のゲーム定義（open のお題を count 件持つ） */
function openDef(count: number, rounds: number): GameDefinition {
  return {
    id: "def-open",
    ownerId: "owner",
    title: "テスト",
    rounds,
    inputType: "text",
    inputTimeSec: 30,
    reveal: "anonymous",
    scoring: "vote",
    prompts: Array.from({ length: count }, (_, i) => ({
      kind: "open" as const,
      text: `お題${i + 1}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// 1. 抽選されている（M-1 の本体）
// ---------------------------------------------------------------------------

Deno.test("大喜利: 開始するたびに出題が変わる（毎回 prompts[0..2] にならない）", () => {
  const first = playedPrompts(OGIRI);
  assertEquals(first.length, OGIRI.rounds);
  // 収録28問から3問なので、同じ組・同じ順が続けて出る確率は 1/(28*27*26) ≈ 0.005%。
  // 30回試して1度も変わらなければ、抽選されていないと判断してよい
  let changed = false;
  for (let i = 0; i < 30; i++) {
    if (playedPrompts(OGIRI).join("\n") !== first.join("\n")) {
      changed = true;
      break;
    }
  }
  assert(changed, `毎回まったく同じお題が出ている: ${JSON.stringify(first)}`);
});

Deno.test("公式3本とも、先頭から順のお題に固定されない", () => {
  for (const def of [OGIRI, ISHIN_DENSHIN, QUIZ]) {
    const head = def.prompts.slice(0, def.rounds).map((p) => p.text);
    let differed = false;
    for (let i = 0; i < 30; i++) {
      if (playedPrompts(def).join("\n") !== head.join("\n")) {
        differed = true;
        break;
      }
    }
    assert(differed, `${def.id}: 定義の先頭 ${def.rounds} 問に固定されている`);
  }
});

// ---------------------------------------------------------------------------
// 2. 1ゲーム内で重複しない
// ---------------------------------------------------------------------------

Deno.test("1ゲームの中で同じお題は出ない（収録数がラウンド数以上のとき）", () => {
  for (const def of [OGIRI, ISHIN_DENSHIN, QUIZ]) {
    assert(def.prompts.length >= def.rounds, `${def.id}: 前提が崩れている`);
    for (let i = 0; i < 20; i++) {
      const texts = playedPrompts(def);
      assertEquals(
        new Set(texts).size,
        texts.length,
        `${def.id}: 同じお題が2度出ている: ${JSON.stringify(texts)}`,
      );
      // 出たお題はすべて収録データのどれか（別物が混ざらない）
      const known = new Set(def.prompts.map((p) => p.text));
      for (const text of texts) assert(known.has(text), `${def.id}: 収録に無いお題: ${text}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. 収録データが全部使われる
// ---------------------------------------------------------------------------

Deno.test("大喜利: 何度も遊べば収録28問すべてが出題されうる", () => {
  const seen = new Set<string>();
  // 1回3問。100回遊べば期待値は十分に大きく、28問すべてが出そろう
  for (let i = 0; i < 100; i++) {
    for (const text of playedPrompts(OGIRI)) seen.add(text);
  }
  assertEquals(seen.size, OGIRI.prompts.length, "収録されているのに出題されないお題がある");
});

// ---------------------------------------------------------------------------
// 4. 決定的なシャッフルの注入
// ---------------------------------------------------------------------------

Deno.test("決定的なシャッフルを注入すると出題順が確定する", () => {
  const def = openDef(4, 3);
  // 恒等シャッフル: 定義に書いたとおりの順
  assertEquals(playedPrompts(def, identityShuffle), ["お題1", "お題2", "お題3"]);
  // 逆順シャッフル: 末尾から
  assertEquals(playedPrompts(def, reverseShuffle), ["お題4", "お題3", "お題2"]);
});

Deno.test("runtimePrompts の並びがそのまま promptIndex の添字になる", () => {
  const def = openDef(4, 2);
  let s = start(def, reverseShuffle);
  assertEquals(s.runtimePrompts.map((p) => p.text), ["お題4", "お題3", "お題2", "お題1"]);
  s = skip(s); // intro -> prompt（ラウンド1）
  assertEquals(s.promptIndex, 0);
  const view = buildPhaseView(s, "a");
  assert(view.phase === "prompt");
  assertEquals(view.promptText, "お題4");
});

// ---------------------------------------------------------------------------
// 5. 件数・原本・境界値
// ---------------------------------------------------------------------------

Deno.test("お題は並べ替えるだけで、件数も集合も原本と一致する", () => {
  for (let i = 0; i < 20; i++) {
    const state = start(OGIRI);
    assertEquals(state.runtimePrompts.length, OGIRI.prompts.length);
    assertEquals(
      state.runtimePrompts.map((p) => p.text).sort(),
      OGIRI.prompts.map((p) => p.text).sort(),
    );
  }
});

Deno.test("抽選しても definition.prompts の並びは書き換わらない", () => {
  const before = JSON.stringify(OGIRI.prompts);
  for (let i = 0; i < 20; i++) start(OGIRI);
  assertEquals(JSON.stringify(OGIRI.prompts), before, "原本が並べ替えられている");
});

Deno.test("お題が1件だけならそれが出続ける（境界値）", () => {
  const def = openDef(1, 3);
  for (let i = 0; i < 10; i++) {
    assertEquals(playedPrompts(def), ["お題1", "お題1", "お題1"]);
  }
});

Deno.test("収録数よりラウンド数が多ければ、抽選後の並びを巡回する（境界値）", () => {
  const def = openDef(2, 3);
  for (let i = 0; i < 20; i++) {
    const texts = playedPrompts(def);
    assertEquals(texts.length, 3);
    // 2問しか無いので3ラウンド目は1ラウンド目の再放送になる
    assertEquals(texts[2], texts[0]);
    assertEquals(new Set(texts).size, 2);
  }
});

Deno.test("お題が0件なら従来どおり開始できない（異常系）", () => {
  const res = startGame(openDef(0, 3), players("a", "b"), T0);
  assertEquals(res.error, "INVALID_INPUT");
  assertEquals(res.changed, false);
});

Deno.test("件数を変えてしまうシャッフルを注入しても、出題は原本の件数を保つ（異常系）", () => {
  const broken: ShuffleFn = <T>(items: readonly T[]): T[] => [...items].slice(0, 1);
  const def = openDef(4, 2);
  const state = start(def, broken);
  // 壊れたシャッフルは無視して原本の並びで通す（お題が消えてしまわない）
  assertEquals(state.runtimePrompts.map((p) => p.text), [
    "お題1",
    "お題2",
    "お題3",
    "お題4",
  ]);
});
