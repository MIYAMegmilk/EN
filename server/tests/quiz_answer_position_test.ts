/**
 * 出題時の選択肢シャッフル（H-4「正解がいつも先頭」対策）のテスト
 *
 * 背景: promptIndex は (round - 1) の固定巡回なので、格付けクイズ（KAKUZUKE）は
 * 何回開始しても prompts[0..4] の同じ5問が出る。その5問の answer はいずれも 0 だったため、
 * 毎回いちばん上を選ぶだけで満点が取れていた。
 *
 * 対策として startGame が definition.prompts から runtimePrompts を作り、
 * choice のお題は options をシャッフルして answer を新しい位置へ振り直す。
 * ここではその不変条件（正解位置が散る / 正解の中身は変わらない / 原本を壊さない）と、
 * 採点・reveal がシャッフル後の空間で整合していることを検証する。
 *
 * なお **runtimePrompts はお題の並び自体もシャッフルされる**（M-1「毎回同じお題」対策）。
 * そのため「runtimePrompts[i] の原本は prompts[i]」とは限らない。このファイルでは
 * お題本文（text）で原本を引き直すか、決定的なシャッフルを注入して並びを確定させている。
 * お題の抽選そのものの検証は server/tests/prompt_selection_test.ts が行う。
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  buildPhaseView,
  CORRECT_BASE_POINT,
  CORRECT_SPEED_BONUS,
  DEFAULT_PHASE_DURATIONS,
  type EnginePlayerInput,
  reduce,
  type ShuffleFn,
  startGame,
} from "../engine.ts";
import { KAKUZUKE } from "../official_games.ts";
import type { GameDefinition, GameState, PhaseView, Prompt } from "../types.ts";

const T0 = 1_700_000_000_000;

/** 並べ替えない（恒等）シャッフル */
const identityShuffle: ShuffleFn = <T>(items: readonly T[]): T[] => [...items];

/** 逆順に並べ替える決定的なシャッフル。注入したときの期待値を計算しやすい */
const reverseShuffle: ShuffleFn = <T>(items: readonly T[]): T[] => [...items].reverse();

/** テスト用の参加者を作る */
function players(...ids: string[]): EnginePlayerInput[] {
  return ids.map((id) => ({ id, nickname: `nick-${id}`, connected: true }));
}

/** startGame をエラーなしで実行する（shuffle を省略すると本番と同じ乱数シャッフル） */
function start(def: GameDefinition, ids: string[], shuffle?: ShuffleFn): GameState {
  const res = shuffle === undefined
    ? startGame(def, players(...ids), T0)
    : startGame(def, players(...ids), T0, DEFAULT_PHASE_DURATIONS, undefined, shuffle);
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
 * 誰も回答しないままゲームを最後まで進め、各ラウンドの reveal ビューを集める。
 * ビューだけを見るので「クライアントに実際に見えている選択肢と正解位置」を検証できる。
 */
function revealViewsOfWholeGame(def: GameDefinition, ids: string[]): PhaseView[] {
  const views: PhaseView[] = [];
  let s = skip(start(def, ids)); // intro -> prompt（ラウンド1）
  for (let round = 1; round <= def.rounds; round++) {
    assertEquals(s.phase, "prompt");
    s = skip(s); // prompt -> input
    s = skip(s); // input -> reveal
    views.push(buildPhaseView(s, ids[0]));
    s = skip(s); // reveal -> judge
    s = skip(s); // judge -> roundResult
    s = skip(s); // roundResult -> 次ラウンドの prompt / finalResult
  }
  return views;
}

/** choice のお題として取り出す（型の絞り込み） */
function asChoice(prompt: Prompt): Extract<Prompt, { kind: "choice" }> {
  assert(prompt.kind === "choice", "choice のお題ではない");
  return prompt;
}

/**
 * 実行時のお題に対応する原本を、お題本文で引き当てる。
 * お題の並びはシャッフルされるので添字では引けない（KAKUZUKE の本文は全問異なる）
 */
function originalOf(prompt: Prompt): Extract<Prompt, { kind: "choice" }> {
  const found = KAKUZUKE.prompts.find((p) => p.text === prompt.text);
  assert(found !== undefined, `原本に無いお題: ${prompt.text}`);
  return asChoice(found);
}

/** 4択クイズの定義（scoring=correct） */
function quizDef(over: Partial<GameDefinition> = {}): GameDefinition {
  return {
    id: "def-quiz",
    ownerId: "owner",
    title: "テストクイズ",
    rounds: 1,
    inputType: "choice",
    inputTimeSec: 30,
    reveal: "anonymous",
    scoring: "correct",
    prompts: [{ kind: "choice", text: "Q", options: ["A", "B", "C", "D"], answer: 0 }],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. 正解位置が固定されない（H-4 の本体）
// ---------------------------------------------------------------------------

Deno.test("格付けクイズ: 何度開始しても正解が index 0 に固定されない", () => {
  const TRIALS = 200;
  // ラウンドごとに観測した正解位置
  const seen: Set<number>[] = Array.from({ length: KAKUZUKE.rounds }, () => new Set<number>());
  for (let i = 0; i < TRIALS; i++) {
    const views = revealViewsOfWholeGame(KAKUZUKE, ["a", "b"]);
    assertEquals(views.length, KAKUZUKE.rounds);
    views.forEach((view, index) => {
      assert(view.phase === "reveal");
      assertEquals(typeof view.answerIndex, "number");
      seen[index].add(view.answerIndex as number);
    });
  }
  // KAKUZUKE は2択。200回も開始すれば、どのラウンドでも 0 と 1 の両方が現れる
  seen.forEach((positions, index) => {
    assertEquals(
      [...positions].sort(),
      [0, 1],
      `ラウンド${index + 1}の正解位置が偏っている: ${[...positions]}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 2〜3. シャッフルしても中身は変わらない
// ---------------------------------------------------------------------------

Deno.test("シャッフルしても正解の選択肢テキストは変わらない", () => {
  for (let i = 0; i < 50; i++) {
    const state = start(KAKUZUKE, ["a", "b"]);
    state.runtimePrompts.forEach((runtime) => {
      const original = originalOf(runtime);
      const shuffled = asChoice(runtime);
      assertEquals(typeof shuffled.answer, "number");
      assertEquals(
        shuffled.options[shuffled.answer as number],
        original.options[original.answer as number],
        `お題「${runtime.text}」の正解テキストが変わっている`,
      );
    });
  }
});

Deno.test("シャッフルしても選択肢の集合は原本と一致する（増減・欠落・重複なし）", () => {
  for (let i = 0; i < 50; i++) {
    const state = start(KAKUZUKE, ["a", "b"]);
    // 並びは変わっても、出題されるお題の集合は原本と1対1のまま（間引きも重複も無い）
    assertEquals(state.runtimePrompts.length, KAKUZUKE.prompts.length);
    assertEquals(
      state.runtimePrompts.map((p) => p.text).sort(),
      KAKUZUKE.prompts.map((p) => p.text).sort(),
    );
    state.runtimePrompts.forEach((runtime) => {
      const original = originalOf(runtime);
      const shuffled = asChoice(runtime);
      assertEquals(shuffled.options.length, original.options.length);
      assertEquals([...shuffled.options].sort(), [...original.options].sort());
    });
  }
});

// ---------------------------------------------------------------------------
// 4. 決定的なシャッフルの注入
// ---------------------------------------------------------------------------

Deno.test("決定的なシャッフルを注入すると並びと answer が期待どおりになる", () => {
  const state = start(quizDef(), ["a", "b"], reverseShuffle);
  const prompt = asChoice(state.runtimePrompts[0]);
  assertEquals(prompt.options, ["D", "C", "B", "A"]);
  // 原本の answer=0（"A"）は逆順で末尾へ移る
  assertEquals(prompt.answer, 3);
  assertEquals(prompt.options[prompt.answer as number], "A");

  // 恒等シャッフルなら原本のまま
  const same = asChoice(start(quizDef(), ["a", "b"], identityShuffle).runtimePrompts[0]);
  assertEquals(same.options, ["A", "B", "C", "D"]);
  assertEquals(same.answer, 0);
});

// ---------------------------------------------------------------------------
// 5〜6. answer が無い / 壊れている場合
// ---------------------------------------------------------------------------

Deno.test("answer を持たない選択式のお題は並べ替えだけ行う", () => {
  const def = quizDef({
    scoring: "vote",
    prompts: [{ kind: "choice", text: "Q", options: ["A", "B", "C", "D"] }],
  });
  const prompt = asChoice(start(def, ["a", "b"], reverseShuffle).runtimePrompts[0]);
  assertEquals(prompt.options, ["D", "C", "B", "A"]);
  assertEquals(prompt.answer, undefined);
});

Deno.test("answer が範囲外の壊れたデータはシャッフルせず原本のまま通す", () => {
  const cases: number[] = [4, -1, 1.5];
  for (const answer of cases) {
    const def = quizDef({
      prompts: [{ kind: "choice", text: "Q", options: ["A", "B", "C", "D"], answer }],
    });
    const prompt = asChoice(start(def, ["a", "b"], reverseShuffle).runtimePrompts[0]);
    assertEquals(prompt.options, ["A", "B", "C", "D"], `answer=${answer} で並べ替えられている`);
    assertEquals(prompt.answer, answer);
  }
});

// ---------------------------------------------------------------------------
// 7. 原本の非破壊性
// ---------------------------------------------------------------------------

Deno.test("startGame を繰り返しても definition.prompts は書き換わらない", () => {
  const before = JSON.stringify(KAKUZUKE.prompts);
  const first = start(KAKUZUKE, ["a", "b"], reverseShuffle);
  const second = start(KAKUZUKE, ["a", "b"], reverseShuffle);
  assertEquals(JSON.stringify(KAKUZUKE.prompts), before);

  // お題オブジェクトも options 配列も、原本とは別の実体になっている（参照が違う）
  assert(
    first.runtimePrompts[0] !== KAKUZUKE.prompts[0],
    "お題オブジェクトが原本と共有されている",
  );
  assert(
    asChoice(first.runtimePrompts[0]).options !== asChoice(KAKUZUKE.prompts[0]).options,
    "options 配列が原本と共有されている",
  );
  assert(
    asChoice(first.runtimePrompts[0]).options !== asChoice(second.runtimePrompts[0]).options,
    "options 配列が開始間で共有されている",
  );

  // 実行時のお題を書き換えても原本には波及しない
  asChoice(first.runtimePrompts[0]).options[0] = "書き換え";
  assertEquals(JSON.stringify(KAKUZUKE.prompts), before);
  assertNotEquals(
    asChoice(second.runtimePrompts[0]).options[0],
    "書き換え",
  );
});

// ---------------------------------------------------------------------------
// 8〜9. 採点と reveal がシャッフル後の空間で整合する
// ---------------------------------------------------------------------------

Deno.test("correct 採点: シャッフル後の正解位置を選んだ人だけが得点する", () => {
  // 逆順シャッフルなので正解 "A"（原本 index 0）は index 3 へ移る
  let s = start(quizDef(), ["a", "b"], reverseShuffle);
  s = skip(skip(s)); // intro -> prompt -> input

  // 表示される選択肢もシャッフル後の並び
  const inputView = buildPhaseView(s, "a");
  assert(inputView.phase === "input");
  assertEquals(inputView.options, ["D", "C", "B", "A"]);

  s = reduce(s, { t: "submitInput", playerId: "a", value: 3, now: T0 + 1 }).state;
  s = reduce(s, { t: "submitInput", playerId: "b", value: 0, now: T0 + 2 }).state;
  assertEquals(s.phase, "reveal");

  // reveal の answerIndex はシャッフル後の位置を指す（テスト9）
  const revealView = buildPhaseView(s, "a");
  assert(revealView.phase === "reveal");
  assertEquals(revealView.answerIndex, 3);
  assertEquals(revealView.options, ["D", "C", "B", "A"]);
  // RevealEntry.value は表示された並びでの添字（提出値そのまま）
  const entries = revealView.entries ?? [];
  assertEquals([...entries].map((e) => e.value).sort(), [0, 3]);

  s = skip(s); // reveal -> judge
  const res = reduce(s, { t: "skipPhase", now: T0 });
  const scores = res.state.lastScores;
  assertEquals(
    scores.find((x) => x.playerId === "a")?.roundScore,
    CORRECT_BASE_POINT + CORRECT_SPEED_BONUS[0],
  );
  assertEquals(scores.find((x) => x.playerId === "a")?.detail?.correct, true);
  assertEquals(scores.find((x) => x.playerId === "b")?.roundScore, 0);
  assertEquals(scores.find((x) => x.playerId === "b")?.detail?.correct, false);
});

Deno.test("correct 採点: 原本の answer と同じ添字を選んでも得点しない", () => {
  let s = start(quizDef(), ["a", "b"], reverseShuffle);
  s = skip(skip(s));
  // 原本の answer は 0。シャッフル後の 0 は "D" なので不正解になる
  s = reduce(s, { t: "submitInput", playerId: "a", value: 0, now: T0 + 1 }).state;
  s = reduce(s, { t: "submitInput", playerId: "b", value: 1, now: T0 + 2 }).state;
  s = skip(s); // reveal -> judge
  const res = reduce(s, { t: "skipPhase", now: T0 });
  for (const entry of res.state.lastScores) assertEquals(entry.roundScore, 0);
});

// ---------------------------------------------------------------------------
// 10. choice 以外のお題
// ---------------------------------------------------------------------------

Deno.test("choice 以外（open）のお題はそのまま素通しされる", () => {
  const def = quizDef({
    inputType: "text",
    scoring: "vote",
    rounds: 2,
    prompts: [{ kind: "open", text: "お題1" }, { kind: "open", text: "お題2" }],
  });
  const state = start(def, ["a", "b"], reverseShuffle);
  // 中身は素通し（選択肢が無いので並べ替える対象も無い）。
  // ただし **お題の並びはシャッフルされる**ので、逆順シャッフルなら定義の逆順になる
  assertEquals(state.runtimePrompts, [...def.prompts].reverse());
  assertEquals(state.runtimePrompts.map((p) => p.kind), ["open", "open"]);

  // 出題は runtimePrompts の順に進む（逆順シャッフルなので「お題2」から）
  const promptView = buildPhaseView(skip(state), "a");
  assert(promptView.phase === "prompt");
  assertEquals(promptView.promptText, "お題2");
  assertEquals(promptView.options, undefined);

  // 恒等シャッフルなら定義どおりの順で出る（お題の抽選以外は挙動不変）
  const same = start(def, ["a", "b"], identityShuffle);
  assertEquals(same.runtimePrompts, def.prompts);
  const sameView = buildPhaseView(skip(same), "a");
  assert(sameView.phase === "prompt");
  assertEquals(sameView.promptText, "お題1");
});
