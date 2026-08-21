/**
 * engine.ts のユニットテスト
 * 詳細仕様書 §3.3 / §3.4 / §8 の挙動を検証する。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  buildPhaseView,
  CORRECT_BASE_POINT,
  DEFAULT_PHASE_DURATIONS,
  type EnginePlayerInput,
  type EngineResult,
  MATCH_ALL_BONUS,
  normalizeMatchValue,
  reduce,
  startGame,
} from "../engine.ts";
import type { GameDefinition, GameState, Prompt } from "../types.ts";

const T0 = 1_700_000_000_000;

/** テスト用のゲーム定義を作る */
function makeDef(over: Partial<GameDefinition> = {}): GameDefinition {
  return {
    id: "def-1",
    ownerId: "owner",
    title: "テスト",
    rounds: 1,
    inputType: "text",
    inputTimeSec: 30,
    reveal: "anonymous",
    scoring: "vote",
    prompts: [{ kind: "open", text: "お題1" }, { kind: "open", text: "お題2" }],
    ...over,
  };
}

/** テスト用の参加者を作る */
function players(...ids: string[]): EnginePlayerInput[] {
  return ids.map((id) => ({ id, nickname: `nick-${id}`, connected: true }));
}

/** startGame をエラーなしで実行する */
function start(def: GameDefinition, ids: string[], now = T0): GameState {
  const res = startGame(def, players(...ids), now, DEFAULT_PHASE_DURATIONS);
  assertEquals(res.error, undefined);
  return res.state;
}

/** ホストスキップでフェーズを1段進める */
function skip(state: GameState, now: number): GameState {
  const res = reduce(state, { t: "skipPhase", now });
  assertEquals(res.error, undefined);
  return res.state;
}

/** input フェーズまで進める */
function toInput(state: GameState, now = T0): GameState {
  return skip(skip(state, now), now); // intro -> prompt -> input
}

/** エラーを検証する */
function expectError(res: EngineResult, code: string) {
  assertEquals(res.error, code);
  assertEquals(res.changed, false);
}

// ---------------------------------------------------------------------------
// §3.4 正規化規則
// ---------------------------------------------------------------------------

Deno.test("正規化①: 前後の空白を除去する", () => {
  assertEquals(normalizeMatchValue("  ねこ  "), "ねこ");
  assertEquals(normalizeMatchValue("\tねこ\n"), "ねこ");
});

Deno.test("正規化②: 連続する空白を1つに圧縮する", () => {
  assertEquals(normalizeMatchValue("あ    い"), "あ い");
  assertEquals(normalizeMatchValue("あ　　い"), "あ い");
});

Deno.test("正規化③: 英字を小文字化する", () => {
  assertEquals(normalizeMatchValue("Cat"), "cat");
  assertEquals(normalizeMatchValue("CAT"), "cat");
});

Deno.test("正規化④: 全角英数字・記号を半角化する", () => {
  assertEquals(normalizeMatchValue("ＣＡＴ１２３"), "cat123");
  assertEquals(normalizeMatchValue("！？＃"), "!?#");
  assertEquals(normalizeMatchValue("ａｂｃ"), "abc");
});

Deno.test("正規化⑤: カタカナをひらがな化する", () => {
  assertEquals(normalizeMatchValue("ネコ"), "ねこ");
  assertEquals(normalizeMatchValue("ヴァイオリン"), "ゔぁいおりん");
  // 長音記号はそのまま残す
  assertEquals(normalizeMatchValue("コーヒー"), "こーひー");
});

Deno.test("正規化: 漢字とかなの表記ゆれは同一視しない（v1の割り切り）", () => {
  assert(normalizeMatchValue("猫") !== normalizeMatchValue("ねこ"));
});

Deno.test("正規化: 規則の組み合わせ", () => {
  assertEquals(normalizeMatchValue("　ネ　コ　"), "ね こ");
  assertEquals(normalizeMatchValue("  Ｈｅｌｌｏ  ワールド "), "hello わーるど");
});

Deno.test("正規化: 空文字・空白のみは空文字になる", () => {
  assertEquals(normalizeMatchValue(""), "");
  assertEquals(normalizeMatchValue("　  "), "");
});

// ---------------------------------------------------------------------------
// ゲーム開始
// ---------------------------------------------------------------------------

Deno.test("startGame: 2人以上で intro へ遷移する", () => {
  const res = startGame(makeDef(), players("a", "b"), T0);
  assertEquals(res.error, undefined);
  assertEquals(res.state.phase, "intro");
  assertEquals(res.state.deadline, T0 + DEFAULT_PHASE_DURATIONS.introSec * 1000);
  assertEquals(res.effects[0], {
    t: "phaseChanged",
    phase: "intro",
    deadline: res.state.deadline,
  });
  assertEquals(res.state.totalScores, { a: 0, b: 0 });
});

Deno.test("startGame: 1人では開始できない（境界値）", () => {
  expectError(startGame(makeDef(), players("a"), T0), "INVALID_INPUT");
});

Deno.test("startGame: 切断中の参加者は人数に数えない", () => {
  const res = startGame(makeDef(), [
    { id: "a", nickname: "A", connected: true },
    { id: "b", nickname: "B", connected: false },
  ], T0);
  expectError(res, "INVALID_INPUT");
});

Deno.test("startGame: お題が0件なら開始できない", () => {
  expectError(startGame(makeDef({ prompts: [] }), players("a", "b"), T0), "INVALID_INPUT");
});

// ---------------------------------------------------------------------------
// フェーズ遷移
// ---------------------------------------------------------------------------

Deno.test("フェーズ遷移: 1ラウンドの全パスを通り lobby へ戻る", () => {
  let s = start(makeDef({ rounds: 1 }), ["a", "b"]);
  const seen: string[] = [s.phase];
  for (let i = 0; i < 6; i++) {
    s = skip(s, T0);
    seen.push(s.phase);
  }
  assertEquals(seen, [
    "intro",
    "prompt",
    "input",
    "reveal",
    "judge",
    "roundResult",
    "finalResult",
  ]);
  const res = reduce(s, { t: "skipPhase", now: T0 });
  assertEquals(res.state.phase, "lobby");
  assertEquals(res.state.deadline, null);
  assert(res.effects.some((e) => e.t === "ended" && e.reason === "completed"));
});

Deno.test("フェーズ遷移: 2ラウンド目は roundResult から prompt へ戻る", () => {
  let s = start(makeDef({ rounds: 2 }), ["a", "b"]);
  s = skip(skip(skip(skip(skip(s, T0), T0), T0), T0), T0); // intro..roundResult
  assertEquals(s.phase, "roundResult");
  assertEquals(s.round, 1);
  assertEquals(s.promptIndex, 0);
  s = skip(s, T0);
  assertEquals(s.phase, "prompt");
  assertEquals(s.round, 2);
  assertEquals(s.promptIndex, 1);
  // 2ラウンド目の roundResult の次は finalResult
  s = skip(skip(skip(skip(skip(s, T0), T0), T0), T0), T0);
  assertEquals(s.phase, "finalResult");
});

Deno.test("フェーズ遷移: お題数よりラウンド数が多い場合は出題を巡回する", () => {
  let s = start(makeDef({ rounds: 3 }), ["a", "b"]);
  s = skip(s, T0); // prompt round1
  assertEquals(s.promptIndex, 0);
  s = skip(skip(skip(skip(skip(s, T0), T0), T0), T0), T0); // -> prompt round2
  assertEquals(s.promptIndex, 1);
  s = skip(skip(skip(skip(skip(s, T0), T0), T0), T0), T0); // -> prompt round3
  assertEquals(s.round, 3);
  assertEquals(s.promptIndex, 0);
});

Deno.test("skipPhase: lobby では受理しない", () => {
  let s = start(makeDef({ rounds: 1 }), ["a", "b"]);
  for (let i = 0; i < 7; i++) s = skip(s, T0);
  assertEquals(s.phase, "lobby");
  expectError(reduce(s, { t: "skipPhase", now: T0 }), "PHASE_MISMATCH");
});

Deno.test("timeout: 期限前は何も起きない / 期限到達で進む", () => {
  const s = start(makeDef(), ["a", "b"]);
  const before = reduce(s, { t: "timeout", now: T0 + 1000 });
  assertEquals(before.changed, false);
  assertEquals(before.state.phase, "intro");
  const after = reduce(s, { t: "timeout", now: s.deadline as number });
  assertEquals(after.changed, true);
  assertEquals(after.state.phase, "prompt");
});

Deno.test("endGame: ホスト終了で lobby へ戻る", () => {
  const s = toInput(start(makeDef(), ["a", "b"]));
  const res = reduce(s, { t: "endGame", now: T0 });
  assertEquals(res.state.phase, "lobby");
  assert(res.effects.some((e) => e.t === "ended" && e.reason === "hostEnded"));
});

// ---------------------------------------------------------------------------
// 入力の受理
// ---------------------------------------------------------------------------

Deno.test("submitInput: input 以外のフェーズでは受理しない", () => {
  const s = start(makeDef(), ["a", "b"]);
  expectError(
    reduce(s, { t: "submitInput", playerId: "a", value: "x", now: T0 }),
    "PHASE_MISMATCH",
  );
});

Deno.test("submitInput: 期限後の提出は破棄して error（§8）", () => {
  const s = toInput(start(makeDef(), ["a", "b"]));
  const late = (s.deadline as number) + 1;
  expectError(
    reduce(s, { t: "submitInput", playerId: "a", value: "x", now: late }),
    "PHASE_MISMATCH",
  );
});

Deno.test("submitInput: 二重送信は DUPLICATE", () => {
  const s = toInput(start(makeDef(), ["a", "b", "c"]));
  const first = reduce(s, { t: "submitInput", playerId: "a", value: "回答", now: T0 });
  assertEquals(first.changed, true);
  expectError(
    reduce(first.state, { t: "submitInput", playerId: "a", value: "別の回答", now: T0 }),
    "DUPLICATE",
  );
});

Deno.test("submitInput: text の境界値（空・上限・上限超過）", () => {
  const s = toInput(start(makeDef(), ["a", "b", "c"]));
  expectError(
    reduce(s, { t: "submitInput", playerId: "a", value: "   ", now: T0 }),
    "INVALID_INPUT",
  );
  expectError(reduce(s, { t: "submitInput", playerId: "a", value: 3, now: T0 }), "INVALID_INPUT");
  const max = "あ".repeat(140);
  assertEquals(reduce(s, { t: "submitInput", playerId: "a", value: max, now: T0 }).changed, true);
  expectError(
    reduce(s, { t: "submitInput", playerId: "a", value: "あ".repeat(141), now: T0 }),
    "INVALID_INPUT",
  );
});

Deno.test("submitInput: text は前後の空白を除去して保存する", () => {
  const s = toInput(start(makeDef(), ["a", "b", "c"]));
  const res = reduce(s, { t: "submitInput", playerId: "a", value: "  ねこ  ", now: T0 });
  assertEquals(res.state.submissions["a"].value, "ねこ");
});

Deno.test("submitInput: choice の範囲外・非整数は INVALID_INPUT（境界値）", () => {
  const quiz = makeDef({
    inputType: "choice",
    scoring: "correct",
    prompts: [{ kind: "choice", text: "Q", options: ["A", "B", "C"], answer: 1 }],
  });
  const s = toInput(start(quiz, ["a", "b", "c"]));
  expectError(reduce(s, { t: "submitInput", playerId: "a", value: -1, now: T0 }), "INVALID_INPUT");
  expectError(reduce(s, { t: "submitInput", playerId: "a", value: 3, now: T0 }), "INVALID_INPUT");
  expectError(reduce(s, { t: "submitInput", playerId: "a", value: 1.5, now: T0 }), "INVALID_INPUT");
  expectError(reduce(s, { t: "submitInput", playerId: "a", value: "1", now: T0 }), "INVALID_INPUT");
  assertEquals(reduce(s, { t: "submitInput", playerId: "a", value: 0, now: T0 }).changed, true);
  assertEquals(reduce(s, { t: "submitInput", playerId: "a", value: 2, now: T0 }).changed, true);
});

Deno.test("submitInput: 全員提出で自動的に reveal へ進む", () => {
  let s = toInput(start(makeDef(), ["a", "b"]));
  s = reduce(s, { t: "submitInput", playerId: "a", value: "A", now: T0 }).state;
  assertEquals(s.phase, "input");
  const res = reduce(s, { t: "submitInput", playerId: "b", value: "B", now: T0 });
  assertEquals(res.state.phase, "reveal");
  assert(res.effects.some((e) => e.t === "phaseChanged" && e.phase === "reveal"));
});

// ---------------------------------------------------------------------------
// vote 採点
// ---------------------------------------------------------------------------

/** 全員が提出して judge フェーズまで進んだ状態を作る */
function toJudge(def: GameDefinition, ids: string[], values: (string | number)[]): GameState {
  let s = toInput(start(def, ids));
  ids.forEach((id, i) => {
    s = reduce(s, { t: "submitInput", playerId: id, value: values[i], now: T0 + i + 1 }).state;
  });
  assertEquals(s.phase, "reveal");
  return skip(s, T0);
}

Deno.test("vote: 投票数がそのまま得点になる", () => {
  let s = toJudge(makeDef(), ["a", "b", "c"], ["A", "B", "C"]);
  assertEquals(s.phase, "judge");
  s = reduce(s, { t: "submitVote", voterId: "a", targetPlayerId: "b", now: T0 }).state;
  s = reduce(s, { t: "submitVote", voterId: "b", targetPlayerId: "c", now: T0 }).state;
  const res = reduce(s, { t: "submitVote", voterId: "c", targetPlayerId: "b", now: T0 });
  assertEquals(res.state.phase, "roundResult");
  const scores = res.state.lastScores;
  assertEquals(scores.find((x) => x.playerId === "b")?.roundScore, 2);
  assertEquals(scores.find((x) => x.playerId === "c")?.roundScore, 1);
  assertEquals(scores.find((x) => x.playerId === "a")?.roundScore, 0);
  assertEquals(scores[0].playerId, "b");
  assertEquals(scores[0].rank, 1);
});

Deno.test("vote: 自分には投票できない", () => {
  const s = toJudge(makeDef(), ["a", "b", "c"], ["A", "B", "C"]);
  expectError(
    reduce(s, { t: "submitVote", voterId: "a", targetPlayerId: "a", now: T0 }),
    "INVALID_INPUT",
  );
});

Deno.test("vote: 未提出者・非参加者へは投票できない", () => {
  let s = toInput(start(makeDef(), ["a", "b", "c"]));
  s = reduce(s, { t: "submitInput", playerId: "a", value: "A", now: T0 }).state;
  s = reduce(s, { t: "submitInput", playerId: "b", value: "B", now: T0 }).state;
  s = skip(s, T0); // input -> reveal（c は未提出）
  s = skip(s, T0); // reveal -> judge
  expectError(
    reduce(s, { t: "submitVote", voterId: "a", targetPlayerId: "c", now: T0 }),
    "INVALID_INPUT",
  );
  expectError(
    reduce(s, { t: "submitVote", voterId: "a", targetPlayerId: "zzz", now: T0 }),
    "INVALID_INPUT",
  );
});

Deno.test("vote: 二重投票は DUPLICATE / 期限後は PHASE_MISMATCH", () => {
  const s = toJudge(makeDef(), ["a", "b", "c"], ["A", "B", "C"]);
  const voted = reduce(s, { t: "submitVote", voterId: "a", targetPlayerId: "b", now: T0 }).state;
  expectError(
    reduce(voted, { t: "submitVote", voterId: "a", targetPlayerId: "c", now: T0 }),
    "DUPLICATE",
  );
  expectError(
    reduce(s, {
      t: "submitVote",
      voterId: "a",
      targetPlayerId: "b",
      now: (s.deadline as number) + 1,
    }),
    "PHASE_MISMATCH",
  );
});

Deno.test("vote: 採点方式が vote 以外なら投票を受理しない", () => {
  const s = toJudge(makeDef({ scoring: "match" }), ["a", "b"], ["x", "y"]);
  expectError(
    reduce(s, { t: "submitVote", voterId: "a", targetPlayerId: "b", now: T0 }),
    "PHASE_MISMATCH",
  );
});

// ---------------------------------------------------------------------------
// match 採点
// ---------------------------------------------------------------------------

Deno.test("match: 正規化後に一致した人数が得点になる", () => {
  const s = toJudge(makeDef({ scoring: "match" }), ["a", "b", "c"], ["ネコ", " ねこ ", "犬"]);
  const res = reduce(s, { t: "skipPhase", now: T0 });
  const scores = res.state.lastScores;
  assertEquals(scores.find((x) => x.playerId === "a")?.roundScore, 1);
  assertEquals(scores.find((x) => x.playerId === "b")?.roundScore, 1);
  assertEquals(scores.find((x) => x.playerId === "c")?.roundScore, 0);
});

Deno.test("match: 全員一致でボーナスが付く", () => {
  const s = toJudge(makeDef({ scoring: "match" }), ["a", "b", "c"], ["ねこ", "ネコ", "　ねこ　"]);
  const res = reduce(s, { t: "skipPhase", now: T0 });
  for (const entry of res.state.lastScores) {
    assertEquals(entry.roundScore, 2 + MATCH_ALL_BONUS);
    assertEquals(entry.detail?.allMatchBonus, true);
  }
});

Deno.test("match: 未提出者がいると全員一致ボーナスは付かない", () => {
  let s = toInput(start(makeDef({ scoring: "match" }), ["a", "b", "c"]));
  s = reduce(s, { t: "submitInput", playerId: "a", value: "ねこ", now: T0 }).state;
  s = reduce(s, { t: "submitInput", playerId: "b", value: "ネコ", now: T0 }).state;
  s = skip(skip(s, T0), T0); // input -> reveal -> judge
  const res = reduce(s, { t: "skipPhase", now: T0 });
  assertEquals(res.state.lastScores.find((x) => x.playerId === "a")?.roundScore, 1);
  assertEquals(res.state.lastScores.find((x) => x.playerId === "a")?.detail?.allMatchBonus, false);
});

Deno.test("match: 全員が別々の答えなら全員0点", () => {
  const s = toJudge(makeDef({ scoring: "match" }), ["a", "b", "c"], ["ねこ", "いぬ", "とり"]);
  const res = reduce(s, { t: "skipPhase", now: T0 });
  for (const entry of res.state.lastScores) assertEquals(entry.roundScore, 0);
});

// ---------------------------------------------------------------------------
// correct 採点
// ---------------------------------------------------------------------------

/** クイズ用の定義 */
function quizDef(over: Partial<GameDefinition> = {}): GameDefinition {
  const prompt: Prompt = { kind: "choice", text: "Q", options: ["A", "B", "C"], answer: 2 };
  return makeDef({ inputType: "choice", scoring: "correct", prompts: [prompt], ...over });
}

Deno.test("correct: 正解に基礎点、早い順に 5/3/1 のボーナスが付く", () => {
  const s = toJudge(quizDef(), ["a", "b", "c"], [2, 2, 0]);
  const res = reduce(s, { t: "skipPhase", now: T0 });
  const scores = res.state.lastScores;
  assertEquals(scores.find((x) => x.playerId === "a")?.roundScore, CORRECT_BASE_POINT + 5);
  assertEquals(scores.find((x) => x.playerId === "b")?.roundScore, CORRECT_BASE_POINT + 3);
  assertEquals(scores.find((x) => x.playerId === "c")?.roundScore, 0);
  assertEquals(scores.find((x) => x.playerId === "c")?.detail?.correct, false);
});

Deno.test("correct: 4人目以降の正解はボーナス0（境界値）", () => {
  const s = toJudge(quizDef(), ["a", "b", "c", "d"], [2, 2, 2, 2]);
  const res = reduce(s, { t: "skipPhase", now: T0 });
  assertEquals(
    res.state.lastScores.find((x) => x.playerId === "d")?.roundScore,
    CORRECT_BASE_POINT,
  );
  assertEquals(res.state.lastScores.find((x) => x.playerId === "d")?.detail?.speedBonus, 0);
});

Deno.test("correct: 全員不正解なら全員0点", () => {
  const s = toJudge(quizDef(), ["a", "b"], [0, 1]);
  const res = reduce(s, { t: "skipPhase", now: T0 });
  for (const entry of res.state.lastScores) assertEquals(entry.roundScore, 0);
});

// ---------------------------------------------------------------------------
// 順位・累計
// ---------------------------------------------------------------------------

Deno.test("順位: 同点は同順位になり、次の順位は詰めない", () => {
  const s = toJudge(quizDef(), ["a", "b", "c"], [2, 2, 0]);
  // a=15, b=13, c=0 → 同点を作るため 2ラウンド目は使わず順位のみ確認
  const res = reduce(s, { t: "skipPhase", now: T0 });
  const scores = res.state.lastScores;
  assertEquals(scores.map((x) => x.rank), [1, 2, 3]);

  const tie = toJudge(makeDef({ scoring: "match" }), ["a", "b", "c"], ["ねこ", "ねこ", "いぬ"]);
  const tieRes = reduce(tie, { t: "skipPhase", now: T0 });
  assertEquals(tieRes.state.lastScores.map((x) => x.rank), [1, 1, 3]);
});

Deno.test("累計: ラウンドをまたいで加算される", () => {
  const def = makeDef({ scoring: "match", rounds: 2 });
  let s = toJudge(def, ["a", "b"], ["ねこ", "ねこ"]);
  s = reduce(s, { t: "skipPhase", now: T0 }).state; // roundResult
  assertEquals(s.totalScores["a"], 1 + MATCH_ALL_BONUS);
  s = skip(s, T0); // prompt round2
  s = skip(s, T0); // input
  s = reduce(s, { t: "submitInput", playerId: "a", value: "いぬ", now: T0 }).state;
  s = reduce(s, { t: "submitInput", playerId: "b", value: "とり", now: T0 }).state;
  s = skip(s, T0); // reveal -> judge
  const res = reduce(s, { t: "skipPhase", now: T0 });
  assertEquals(res.state.totalScores["a"], 1 + MATCH_ALL_BONUS);
  assertEquals(res.state.lastScores.find((x) => x.playerId === "a")?.roundScore, 0);
});

// ---------------------------------------------------------------------------
// §8 異常系
// ---------------------------------------------------------------------------

Deno.test("切断: 完了判定から除外され、残りの提出で進行する（§8）", () => {
  let s = toInput(start(makeDef(), ["a", "b", "c"]));
  s = reduce(s, { t: "submitInput", playerId: "a", value: "A", now: T0 }).state;
  s = reduce(s, { t: "submitInput", playerId: "b", value: "B", now: T0 }).state;
  assertEquals(s.phase, "input");
  const res = reduce(s, { t: "playerLeft", playerId: "c", now: T0 });
  assertEquals(res.state.phase, "reveal");
  assertEquals(res.state.participants["c"].connected, false);
});

Deno.test("再接続: 完了判定に復帰する（§8）", () => {
  let s = toInput(start(makeDef(), ["a", "b", "c"]));
  s = reduce(s, { t: "playerLeft", playerId: "c", now: T0 }).state;
  s = reduce(s, { t: "playerRejoined", playerId: "c", now: T0 }).state;
  assertEquals(s.participants["c"].connected, true);
  s = reduce(s, { t: "submitInput", playerId: "a", value: "A", now: T0 }).state;
  s = reduce(s, { t: "submitInput", playerId: "b", value: "B", now: T0 }).state;
  assertEquals(s.phase, "input");
});

Deno.test("途中参加: 進行中は観戦扱いで、次ラウンドから採点対象になる（§8）", () => {
  let s = toInput(start(makeDef({ rounds: 2 }), ["a", "b"]));
  s = reduce(s, { t: "playerJoined", playerId: "c", nickname: "C", now: T0 }).state;
  assertEquals(s.participants["c"].role, "spectator");
  expectError(
    reduce(s, { t: "submitInput", playerId: "c", value: "X", now: T0 }),
    "PHASE_MISMATCH",
  );
  // a と b の提出だけで進行する（観戦者は完了判定に含めない）
  s = reduce(s, { t: "submitInput", playerId: "a", value: "A", now: T0 }).state;
  s = reduce(s, { t: "submitInput", playerId: "b", value: "B", now: T0 }).state;
  assertEquals(s.phase, "reveal");
  s = skip(s, T0); // judge
  s = reduce(s, { t: "submitVote", voterId: "a", targetPlayerId: "b", now: T0 }).state;
  s = reduce(s, { t: "submitVote", voterId: "b", targetPlayerId: "a", now: T0 }).state;
  assertEquals(s.phase, "roundResult");
  assertFalse(s.lastScores.some((x) => x.playerId === "c"));
  s = skip(s, T0); // 次ラウンド
  assertEquals(s.participants["c"].role, "player");
  assertEquals(s.totalScores["c"], 0);
});

Deno.test("キック: スコアごと除外され、当人への票が無効化される（§8）", () => {
  let s = toJudge(makeDef(), ["a", "b", "c"], ["A", "B", "C"]);
  s = reduce(s, { t: "submitVote", voterId: "c", targetPlayerId: "a", now: T0 }).state;
  assertEquals(s.votes["c"], "a");
  const res = reduce(s, { t: "playerKicked", playerId: "a", now: T0 });
  s = res.state;
  assertEquals(s.participants["a"], undefined);
  assertEquals(s.totalScores["a"], undefined);
  assertEquals(s.submissions["a"], undefined);
  // 当人への票は無効化され、投票者は再投票できる
  assertEquals(s.votes["c"], undefined);
  assertEquals(s.phase, "judge");
  s = reduce(s, { t: "submitVote", voterId: "b", targetPlayerId: "c", now: T0 }).state;
  const done = reduce(s, { t: "submitVote", voterId: "c", targetPlayerId: "b", now: T0 });
  assertEquals(done.state.phase, "roundResult");
  assertFalse(done.state.lastScores.some((x) => x.playerId === "a"));
});

Deno.test("キック: 2人未満になったゲームは中断して lobby へ戻る（§8）", () => {
  const s = toInput(start(makeDef(), ["a", "b"]));
  const res = reduce(s, { t: "playerKicked", playerId: "b", now: T0 });
  assertEquals(res.state.phase, "lobby");
  assertEquals(res.state.deadline, null);
  assert(res.effects.some((e) => e.t === "ended" && e.reason === "tooFewPlayers"));
});

Deno.test("切断: 2人未満になったゲームは中断して lobby へ戻る（§8）", () => {
  const s = toInput(start(makeDef(), ["a", "b"]));
  const res = reduce(s, { t: "playerLeft", playerId: "b", now: T0 });
  assertEquals(res.state.phase, "lobby");
  assert(res.effects.some((e) => e.t === "ended" && e.reason === "tooFewPlayers"));
});

Deno.test("キック: lobby では中断イベントを起こさない", () => {
  let s = start(makeDef({ rounds: 1 }), ["a", "b"]);
  for (let i = 0; i < 7; i++) s = skip(s, T0);
  assertEquals(s.phase, "lobby");
  const res = reduce(s, { t: "playerKicked", playerId: "b", now: T0 });
  assertEquals(res.state.phase, "lobby");
  assertFalse(res.effects.some((e) => e.t === "ended"));
});

Deno.test("存在しない参加者へのイベントは無視される（冪等）", () => {
  const s = toInput(start(makeDef(), ["a", "b"]));
  assertEquals(reduce(s, { t: "playerKicked", playerId: "zzz", now: T0 }).changed, false);
  assertEquals(reduce(s, { t: "playerLeft", playerId: "zzz", now: T0 }).changed, false);
  assertEquals(reduce(s, { t: "playerRejoined", playerId: "zzz", now: T0 }).changed, false);
});

Deno.test("入力の不変性: 元の state は変更されない", () => {
  const s = toInput(start(makeDef(), ["a", "b"]));
  const snapshot = JSON.stringify(s);
  reduce(s, { t: "submitInput", playerId: "a", value: "A", now: T0 });
  reduce(s, { t: "playerKicked", playerId: "a", now: T0 });
  assertEquals(JSON.stringify(s), snapshot);
});

// ---------------------------------------------------------------------------
// PhaseView（§3.2 原則3: 受信者ごとに見えてよい情報のみ）
// ---------------------------------------------------------------------------

Deno.test("PhaseView: input では他人の回答内容を送らない", () => {
  let s = toInput(start(makeDef(), ["a", "b", "c"]));
  s = reduce(s, { t: "submitInput", playerId: "a", value: "秘密の回答", now: T0 }).state;
  const view = buildPhaseView(s, "b");
  assertEquals(view.phase, "input");
  assertEquals(JSON.stringify(view).includes("秘密の回答"), false);
  if (view.phase === "input") {
    assertEquals(view.submittedCount, 1);
    assertEquals(view.participantCount, 3);
    assertEquals(view.submitted, false);
    assertEquals(view.canSubmit, true);
  }
  const own = buildPhaseView(s, "a");
  if (own.phase === "input") {
    assertEquals(own.submitted, true);
    assertEquals(own.canSubmit, false);
  }
});

Deno.test("PhaseView: クイズの正解は reveal まで隠す", () => {
  const s = toJudge(quizDef(), ["a", "b"], [2, 0]);
  const inputState = toInput(start(quizDef(), ["a", "b"]));
  const inputView = buildPhaseView(inputState, "a");
  assertEquals(JSON.stringify(inputView).includes("answerIndex"), false);
  if (inputView.phase === "input") assertEquals(inputView.options, ["A", "B", "C"]);

  const promptView = buildPhaseView(skip(start(quizDef(), ["a", "b"]), T0), "a");
  assertEquals(JSON.stringify(promptView).includes("answerIndex"), false);

  // reveal では開示する
  let r = toInput(start(quizDef(), ["a", "b"]));
  r = reduce(r, { t: "submitInput", playerId: "a", value: 2, now: T0 }).state;
  r = reduce(r, { t: "submitInput", playerId: "b", value: 0, now: T0 }).state;
  assertEquals(r.phase, "reveal");
  const revealView = buildPhaseView(r, "a");
  if (revealView.phase === "reveal") assertEquals(revealView.answerIndex, 2);
  assertEquals(s.phase, "judge");
});

Deno.test("PhaseView: reveal が anonymous なら nickname を含めない", () => {
  const s = toJudge(makeDef({ reveal: "anonymous" }), ["a", "b"], ["A", "B"]);
  const view = buildPhaseView(s, "a");
  if (view.phase === "judge") {
    assertEquals(view.entries.length, 2);
    for (const e of view.entries) assertEquals(e.nickname, undefined);
  }
  const named = toJudge(makeDef({ reveal: "named" }), ["a", "b"], ["A", "B"]);
  const namedView = buildPhaseView(named, "a");
  if (namedView.phase === "judge") {
    for (const e of namedView.entries) assert(typeof e.nickname === "string");
  }
});

Deno.test("PhaseView: judge の canVote と投票数", () => {
  let s = toJudge(makeDef(), ["a", "b", "c"], ["A", "B", "C"]);
  const before = buildPhaseView(s, "a");
  if (before.phase === "judge") {
    assertEquals(before.canVote, true);
    assertEquals(before.votedCount, 0);
    assertEquals(before.myVoteTargetId, undefined);
  }
  s = reduce(s, { t: "submitVote", voterId: "a", targetPlayerId: "b", now: T0 }).state;
  const after = buildPhaseView(s, "a");
  if (after.phase === "judge") {
    assertEquals(after.canVote, false);
    assertEquals(after.myVoteTargetId, "b");
    assertEquals(after.votedCount, 1);
  }
  // match 方式では投票できない
  const m = toJudge(makeDef({ scoring: "match" }), ["a", "b"], ["x", "y"]);
  const mv = buildPhaseView(m, "a");
  if (mv.phase === "judge") assertEquals(mv.canVote, false);
});

Deno.test("PhaseView: 観戦者は提出できない表示になる", () => {
  let s = toInput(start(makeDef(), ["a", "b"]));
  s = reduce(s, { t: "playerJoined", playerId: "c", nickname: "C", now: T0 }).state;
  const view = buildPhaseView(s, "c");
  if (view.phase === "input") {
    assertEquals(view.canSubmit, false);
    assertEquals(view.participantCount, 2);
  }
});

Deno.test("PhaseView: 匿名 reveal の並び順は全員共通で、提出者を過不足なく含む", () => {
  const s = toJudge(makeDef(), ["a", "b", "c", "d", "e"], ["A", "B", "C", "D", "E"]);
  const v1 = buildPhaseView(s, "a");
  const v2 = buildPhaseView(s, "b");
  // 同一ラウンド内では全員に同じ順序で見える
  assertEquals(JSON.stringify(v1), JSON.stringify(v2));
  if (v1.phase === "judge") {
    assertEquals(
      [...v1.entries.map((e) => e.playerId)].sort(),
      ["a", "b", "c", "d", "e"],
    );
  }
});

Deno.test("PhaseView: lobby / intro / roundResult / finalResult の形", () => {
  const s = start(makeDef({ rounds: 1, description: "説明" }), ["a", "b"]);
  const intro = buildPhaseView(s, "a");
  assertEquals(intro.phase, "intro");
  if (intro.phase === "intro") {
    assertEquals(intro.title, "テスト");
    assertEquals(intro.description, "説明");
    assertEquals(intro.totalRounds, 1);
  }
  let t = toJudge(makeDef({ rounds: 1 }), ["a", "b"], ["A", "B"]);
  t = reduce(t, { t: "skipPhase", now: T0 }).state;
  const rr = buildPhaseView(t, "a");
  if (rr.phase === "roundResult") {
    assertEquals(rr.isFinalRound, true);
    assertEquals(rr.scores.length, 2);
  }
  t = skip(t, T0);
  const fr = buildPhaseView(t, "a");
  if (fr.phase === "finalResult") assertEquals(fr.scores.length, 2);
  t = skip(t, T0);
  assertEquals(buildPhaseView(t, "a").phase, "lobby");
});
