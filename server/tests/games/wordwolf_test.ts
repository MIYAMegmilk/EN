/**
 * server/games/wordwolf.ts のユニットテスト
 * 設計書 docs/design/games-unified.md §8 #10 / §2.6（秘密配布）/ §7 のチェックリストに対応する。
 *
 * 眼目は4つ。
 *   1. **秘密が漏れないこと**（自分の単語以外・狼の正体が view に一切載らない）
 *   2. 設定フェーズ（勝敗条件・議論時間）と、開始がホスト（skipPhase）に限られること
 *   3. 投票の境界（自票拒否・二重投票・同票・観戦者・不正な投票先）
 *   4. 異常系（不正 payload・途中参加・切断・再接続・キック・人数不足・狼の離脱）で壊れないこと
 */

import { assert, assertEquals, assertExists, assertNotEquals } from "@std/assert";
import type { EnginePlayerInput } from "../../engine.ts";
import { type ClientLink, RoomManager } from "../../rooms.ts";
import type { S2C } from "../../types.ts";
import {
  WORDWOLF_WORD_PAIRS,
  wordWolfModule,
  type WordWolfState,
  type WordWolfView,
} from "../../games/wordwolf.ts";
import type { ModuleEffect, ModuleEvent, ModuleResult } from "../../games/module.ts";

const T0 = 1_700_000_000_000;
const SEED = 20260826;

/** テスト用の参加者を作る */
function players(...ids: string[]): EnginePlayerInput[] {
  return ids.map((id) => ({ id, nickname: `nick-${id}`, connected: true }));
}

/** ゲームを開始する（config フェーズに入る） */
function start(ids: string[], now = T0, seed = SEED): WordWolfState {
  const result = wordWolfModule.init({ players: players(...ids), now, seed });
  assertEquals(result.error, undefined);
  return result.state;
}

/** 1件のイベントを流し、エラーが無いことを確かめて新しい state を返す */
function step(state: WordWolfState, event: ModuleEvent): WordWolfState {
  const result = wordWolfModule.reduce(state, event);
  assertEquals(result.error, undefined, `想定外のエラー: ${result.message}`);
  return result.state;
}

/** clientEvent を流し、結果をそのまま返す（エラーの検査用） */
function send(
  state: WordWolfState,
  playerId: string,
  payload: unknown,
  now = T0,
): ModuleResult<WordWolfState> {
  return wordWolfModule.reduce(state, { t: "clientEvent", playerId, payload, now });
}

/** ホストの skipPhase（ルーム層がホストを検証してから流す） */
function skip(state: WordWolfState, now = T0): WordWolfState {
  return step(state, { t: "skipPhase", now });
}

/** 期限に達した timeout を流す */
function timeout(state: WordWolfState): WordWolfState {
  return step(state, { t: "timeout", now: state.deadline ?? T0 });
}

/** 受信者向けの view */
function viewOf(state: WordWolfState, viewerId: string): WordWolfView {
  return wordWolfModule.view(state, viewerId);
}

/** 効果に指定の種類が含まれるか */
function hasEffect(effects: ModuleEffect[], t: ModuleEffect["t"]): boolean {
  return effects.some((e) => e.t === t);
}

/** 設定を送る（config フェーズ中のみ有効） */
function config(
  state: WordWolfState,
  playerId: string,
  mode: "simple" | "reversal",
  discussionSec: number,
): WordWolfState {
  return step(state, {
    t: "clientEvent",
    playerId,
    payload: { k: "config", mode, discussionSec },
    now: T0,
  });
}

/** config → discuss → vote まで一気に進める */
function toVotePhase(ids: string[], mode: "simple" | "reversal" = "simple"): WordWolfState {
  let state = start(ids);
  state = config(state, ids[0], mode, 180);
  state = skip(state); // ホストが開始 → discuss
  assertEquals(state.phase, "discuss");
  state = skip(state); // 議論の打ち切り → vote
  assertEquals(state.phase, "vote");
  return state;
}

/** 1票入れる */
function vote(state: WordWolfState, voter: string, target: string): WordWolfState {
  return step(state, {
    t: "clientEvent",
    playerId: voter,
    payload: { k: "vote", targetId: target },
    now: T0,
  });
}

/**
 * target へ全員（target 以外）の票を集める。target は別の誰かへ入れる。
 * 参加者3人以上なら target が必ず最多得票になる
 */
function voteAll(state: WordWolfState, target: string): WordWolfState {
  let next = state;
  for (const id of state.order) {
    if (id === target) continue;
    next = vote(next, id, target);
  }
  // target 自身の票（自分には入れられないので他の誰かへ）
  const other = state.order.find((id) => id !== target);
  assertExists(other);
  if (next.phase === "vote") next = vote(next, target, other);
  return next;
}

/** 狼ではない参加者を1人返す */
function someCitizen(state: WordWolfState): string {
  const id = state.order.find((p) => p !== state.wolfId);
  assertExists(id, "市民が見つからない");
  return id;
}

/**
 * playerId を伏せた view を直列化する。
 * 「他人の情報が混ざっていないか」を文字列で突き合わせるとき、playerId（UUID）の
 * 並びがたまたま値と一致して誤検知するため、ID 系のキーだけ落としてから比べる
 * （chicken_test.ts の withoutIds と同じ狙い）
 */
function withoutIds(view: WordWolfView): string {
  const idKeys = new Set(["playerId", "myVote", "votedBy", "exiledId", "wolfId"]);
  return JSON.stringify(view, (key, value) => (idKeys.has(key) ? undefined : value));
}

// ---------------------------------------------------------------------------
// 設定フェーズ（勝敗条件・議論時間）
// ---------------------------------------------------------------------------

Deno.test("開始すると設定フェーズになり、期限が予約される。お題はまだ配られない", () => {
  const result = wordWolfModule.init({ players: players("a", "b", "c"), now: T0, seed: SEED });
  assertEquals(result.error, undefined);
  const state = result.state;
  assertEquals(state.phase, "config");
  assertEquals(state.mode, "simple");
  assertEquals(state.discussionSec, 300);
  assertEquals(state.configLocked, false);
  // 設定中は狼もお題も決まっていない
  assertEquals(state.wolfId, null);
  assertEquals(state.citizenWord, "");
  assertEquals(state.wolfWord, "");
  assert(hasEffect(result.effects, "viewChanged"));
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : null, state.deadline);
  assert((state.deadline ?? 0) > T0);
  // view にも単語は載らない
  assertEquals(viewOf(state, "a").myWord, null);
  assertEquals(viewOf(state, "a").wolfId, undefined);
});

Deno.test("設定: 勝敗条件と議論時間を変えると view に反映され、変えた人の名前が出る", () => {
  let state = start(["a", "b", "c"]);
  state = config(state, "a", "reversal", 420);
  assertEquals(state.mode, "reversal");
  assertEquals(state.discussionSec, 420);
  assertEquals(state.configuredBy, "nick-a");
  const view = viewOf(state, "b");
  assertEquals(view.mode, "reversal");
  assertEquals(view.discussionSec, 420);
  assertEquals(view.configuredBy, "nick-a");
  assertEquals(view.configLocked, false);
  // 選べる議論時間は view に載る（クライアントに選択肢を焼き付けない）
  assertEquals(view.discussionChoices, [180, 300, 420]);
});

Deno.test("設定: 同じ設定を送り直しても何も動かない", () => {
  const state = start(["a", "b", "c"]);
  const result = send(state, "a", { k: "config", mode: "simple", discussionSec: 300 });
  assertEquals(result.error, undefined);
  assertEquals(result.changed, false);
  assertEquals(result.effects.length, 0);
  assertEquals(result.state.configuredBy, null);
});

Deno.test("設定: 不正な勝敗条件・議論時間は INVALID_INPUT で棄却する", () => {
  const state = start(["a", "b", "c"]);
  const rejected: unknown[] = [
    { k: "config", mode: "wolf", discussionSec: 300 },
    { k: "config", mode: 1, discussionSec: 300 },
    { k: "config", discussionSec: 300 },
    { k: "config", mode: "simple", discussionSec: 200 }, // 選択肢にない
    { k: "config", mode: "simple", discussionSec: 0 },
    { k: "config", mode: "simple", discussionSec: 300.5 },
    { k: "config", mode: "simple", discussionSec: "300" },
    { k: "config", mode: "simple" },
  ];
  for (const payload of rejected) {
    const result = send(state, "a", payload);
    assertEquals(result.error, "INVALID_INPUT", `棄却されなかった: ${JSON.stringify(payload)}`);
    assertEquals(result.changed, false);
    assertEquals(result.effects.length, 0);
    assertEquals(result.state, state);
  }
});

Deno.test("設定: 観戦者は設定を変更できない。確定後も変更できない", () => {
  let state = start(["a", "b", "c"]);
  assertEquals(
    send(state, "zzz", { k: "config", mode: "reversal", discussionSec: 180 }).error,
    "PHASE_MISMATCH",
  );
  state = skip(state); // ホストが開始 → 設定確定
  assertEquals(state.configLocked, true);
  assertEquals(
    send(state, "a", { k: "config", mode: "reversal", discussionSec: 180 }).error,
    "PHASE_MISMATCH",
  );
});

Deno.test("設定: ホストの skipPhase で確定し、お題が配られて議論に入る", () => {
  let state = start(["a", "b", "c"]);
  state = config(state, "a", "reversal", 180);
  const result = wordWolfModule.reduce(state, { t: "skipPhase", now: T0 });
  state = result.state;
  assertEquals(state.phase, "discuss");
  assertEquals(state.configLocked, true);
  assertEquals(state.mode, "reversal");
  // 議論時間が期限に反映され、schedule も出ている
  assertEquals(state.deadline, T0 + 180_000);
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : null, T0 + 180_000);
  // お題が配られている
  assertExists(state.wolfId);
  assert(state.order.includes(state.wolfId));
  assertNotEquals(state.citizenWord, "");
  assertNotEquals(state.wolfWord, "");
  assertNotEquals(state.citizenWord, state.wolfWord);
  const pair = WORDWOLF_WORD_PAIRS.find((p) =>
    p.includes(state.citizenWord) && p.includes(state.wolfWord)
  );
  assertExists(pair, "同じお題ペアから配られていない");
});

Deno.test("設定: 期限切れでも既定の設定で自動的に始まる（卓が固まらない）", () => {
  let state = start(["a", "b", "c"]);
  state = timeout(state);
  assertEquals(state.phase, "discuss");
  assertEquals(state.mode, "simple");
  assertEquals(state.deadline, T0 + 120_000 + 300_000);
});

// ---------------------------------------------------------------------------
// 秘密の保持（設計書 §2.6）— このゲームの肝
// ---------------------------------------------------------------------------

Deno.test("秘密: お題は1人だけ違う。狼は自分が狼だと分からない", () => {
  let state = start(["a", "b", "c", "d"]);
  state = skip(state);
  const wolfId = state.wolfId;
  assertExists(wolfId);
  const words = state.order.map((id) => viewOf(state, id).myWord);
  const distinct = new Set(words);
  assertEquals(distinct.size, 2, "お題が2種類になっていない");
  const wolfWords = words.filter((w) => w === state.wolfWord);
  assertEquals(wolfWords.length, 1, "違うお題を持つ人が1人になっていない");
  assertEquals(viewOf(state, wolfId).myWord, state.wolfWord);
  // 狼だという情報は view のどこにも無い
  for (const id of state.order) {
    const view = viewOf(state, id);
    assertEquals(view.wolfId, undefined);
    assertEquals(view.youAreWolf, undefined);
    assertEquals(view.citizenWord, undefined);
    assertEquals(view.wolfWord, undefined);
  }
});

Deno.test("秘密: 議論中の view には自分の単語しか載らない", () => {
  let state = start(["a", "b", "c", "d"]);
  state = skip(state);
  const wolfId = state.wolfId ?? "";
  const citizenId = someCitizen(state);

  // 狼の view に市民のお題は入っていない
  const wolfView = viewOf(state, wolfId);
  assertEquals(wolfView.myWord, state.wolfWord);
  const wolfJson = withoutIds(wolfView);
  assert(
    !wolfJson.includes(state.citizenWord),
    `市民のお題が狼の view に混ざっている: ${wolfJson}`,
  );

  // 市民の view に狼のお題は入っていない
  const citizenView = viewOf(state, citizenId);
  assertEquals(citizenView.myWord, state.citizenWord);
  const citizenJson = withoutIds(citizenView);
  assert(
    !citizenJson.includes(state.wolfWord),
    `狼のお題が市民の view に混ざっている: ${citizenJson}`,
  );
  // 狼の正体を示すキーそのものが無い
  assert(!citizenJson.includes("wolfId"));
  assert(!citizenJson.includes("youAreWolf"));
});

Deno.test("秘密: 観戦者にはお題が配られない", () => {
  let state = start(["a", "b", "c"]);
  state = skip(state);
  const view = viewOf(state, "zzz");
  assertEquals(view.myWord, null);
  assertEquals(view.youArePlayer, false);
  const json = withoutIds(view);
  assert(!json.includes(state.citizenWord));
  assert(!json.includes(state.wolfWord));
});

Deno.test("秘密: 投票中は他人の投票先が view に載らない（投票済みかどうかだけ）", () => {
  let state = toVotePhase(["a", "b", "c", "d"]);
  state = vote(state, "a", "b");
  state = vote(state, "b", "c");
  assertEquals(state.phase, "vote");

  const viewC = viewOf(state, "c");
  assertEquals(viewC.myVote, null);
  assertEquals(viewC.votedCount, 2);
  assertEquals(viewC.players.find((p) => p.playerId === "a")?.voted, true);
  assertEquals(viewC.players.find((p) => p.playerId === "d")?.voted, false);
  // 開票前は内訳が一切載らない
  assertEquals(viewC.tally, undefined);
  assertEquals(viewC.exiledId, undefined);
  // 自分の票は自分にだけ見える
  assertEquals(viewOf(state, "a").myVote, "b");
});

Deno.test("秘密: 最終結果で初めて全員のお題と狼が公開される", () => {
  let state = toVotePhase(["a", "b", "c"]);
  const wolfId = state.wolfId ?? "";
  state = voteAll(state, wolfId);
  assertEquals(state.phase, "result");
  // 開票の時点ではまだ狼もお題も伏せたまま
  assertEquals(viewOf(state, "a").wolfId, undefined);
  assertEquals(viewOf(state, "a").citizenWord, undefined);

  state = timeout(state); // result → final（simple なのでここで決着）
  assertEquals(state.phase, "final");
  const view = viewOf(state, "a");
  assertEquals(view.wolfId, wolfId);
  assertEquals(view.citizenWord, state.citizenWord);
  assertEquals(view.wolfWord, state.wolfWord);
  assertEquals(view.outcome, "citizens");
  const results = view.results ?? [];
  assertEquals(results.length, 3);
  assertEquals(results.filter((r) => r.isWolf).length, 1);
  assertEquals(results.find((r) => r.isWolf)?.word, state.wolfWord);
});

// ---------------------------------------------------------------------------
// 投票の境界
// ---------------------------------------------------------------------------

Deno.test("投票: 自分には投票できない", () => {
  const state = toVotePhase(["a", "b", "c"]);
  const result = send(state, "a", { k: "vote", targetId: "a" });
  assertEquals(result.error, "INVALID_INPUT");
  assertEquals(result.changed, false);
});

Deno.test("投票: 二重投票は DUPLICATE。最初の票は上書きされない", () => {
  let state = toVotePhase(["a", "b", "c"]);
  state = vote(state, "a", "b");
  const result = send(state, "a", { k: "vote", targetId: "c" });
  assertEquals(result.error, "DUPLICATE");
  assertEquals(result.state.votes["a"], "b");
});

Deno.test("投票: 参加していない人への投票・観戦者の投票は棄却する", () => {
  const state = toVotePhase(["a", "b", "c"]);
  assertEquals(send(state, "a", { k: "vote", targetId: "zzz" }).error, "INVALID_INPUT");
  assertEquals(send(state, "zzz", { k: "vote", targetId: "a" }).error, "PHASE_MISMATCH");
});

Deno.test("投票: 投票フェーズ以外・期限後は PHASE_MISMATCH", () => {
  let state = start(["a", "b", "c"]);
  // 設定中の投票
  assertEquals(send(state, "a", { k: "vote", targetId: "b" }).error, "PHASE_MISMATCH");
  state = skip(state);
  // 議論中の投票
  assertEquals(send(state, "a", { k: "vote", targetId: "b" }).error, "PHASE_MISMATCH");
  state = skip(state);
  assertEquals(state.phase, "vote");
  // 期限を過ぎてからの投票
  const late = send(state, "a", { k: "vote", targetId: "b" }, (state.deadline ?? T0) + 1);
  assertEquals(late.error, "PHASE_MISMATCH");
});

Deno.test("投票: 不正な payload はすべて INVALID_INPUT", () => {
  const state = toVotePhase(["a", "b", "c"]);
  const rejected: unknown[] = [
    { k: "vote" },
    { k: "vote", targetId: "" },
    { k: "vote", targetId: 1 },
    { k: "vote", targetId: "x".repeat(65) },
    { k: "unknown", targetId: "b" },
    { targetId: "b" },
    "vote",
    42,
    null,
    [1, 2, 3],
  ];
  for (const payload of rejected) {
    const result = send(state, "a", payload);
    assertEquals(result.error, "INVALID_INPUT", `棄却されなかった: ${JSON.stringify(payload)}`);
    assertEquals(result.changed, false);
    assertEquals(result.effects.length, 0);
    assertEquals(result.state, state);
  }
});

Deno.test("投票: 全員が投票した時点で開票へ進む（期限を待たない）", () => {
  let state = toVotePhase(["a", "b", "c"]);
  state = vote(state, "a", "b");
  state = vote(state, "b", "c");
  assertEquals(state.phase, "vote");
  state = vote(state, "c", "b");
  assertEquals(state.phase, "result");
  assertEquals(state.exiledId, "b");
  assertEquals(state.voteTie, false);
  const tally = viewOf(state, "a").tally ?? [];
  assertEquals(tally[0].playerId, "b");
  assertEquals(tally[0].votes, 2);
  assertEquals(tally[0].votedBy.sort(), ["a", "c"]);
});

Deno.test("投票: 同票なら追放なし（狼の逃げ切り）", () => {
  let state = toVotePhase(["a", "b", "c"]);
  state = vote(state, "a", "b");
  state = vote(state, "b", "c");
  state = vote(state, "c", "a");
  assertEquals(state.phase, "result");
  assertEquals(state.exiledId, null);
  assertEquals(state.voteTie, true);
  state = timeout(state);
  assertEquals(state.phase, "final");
  // 追放できていないので狼の勝ち
  assertEquals(state.outcome, "wolf");
});

Deno.test("投票: 誰も投票しないまま期限が来ても追放なしで進む", () => {
  let state = toVotePhase(["a", "b", "c"]);
  state = timeout(state);
  assertEquals(state.phase, "result");
  assertEquals(state.exiledId, null);
  assertEquals(state.voteTie, true);
  assertEquals((viewOf(state, "a").tally ?? []).every((e) => e.votes === 0), true);
});

// ---------------------------------------------------------------------------
// 勝敗（simple / reversal）
// ---------------------------------------------------------------------------

Deno.test("simple: 狼を追放できれば市民の勝ち。市民全員に1点入る", () => {
  let state = toVotePhase(["a", "b", "c"], "simple");
  const wolfId = state.wolfId ?? "";
  state = voteAll(state, wolfId);
  assertEquals(state.exiledId, wolfId);
  state = timeout(state); // result → final
  assertEquals(state.phase, "final");
  assertEquals(state.outcome, "citizens");
  // guess フェーズは挟まない
  assertEquals(state.guess, null);

  const result = wordWolfModule.reduce(state, { t: "timeout", now: state.deadline ?? T0 });
  assertEquals(result.state.running, false);
  assertEquals(result.effects.filter((e) => e.t === "score").length, 1);
  const score = result.effects.find((e) => e.t === "score");
  assert(score !== undefined && score.t === "score");
  assertEquals(score.totals.find((r) => r.playerId === wolfId)?.totalScore, 0);
  for (const id of state.order) {
    if (id === wolfId) continue;
    assertEquals(score.totals.find((r) => r.playerId === id)?.totalScore, 1);
    assertEquals(score.totals.find((r) => r.playerId === id)?.rank, 1);
  }
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : "なし", null);
  assert(hasEffect(result.effects, "ended"));
});

Deno.test("simple: 市民を追放してしまえば狼の勝ち", () => {
  let state = toVotePhase(["a", "b", "c"], "simple");
  const citizenId = someCitizen(state);
  state = voteAll(state, citizenId);
  assertEquals(state.exiledId, citizenId);
  state = timeout(state);
  assertEquals(state.outcome, "wolf");
  assertEquals(viewOf(state, "a").results?.find((r) => r.isWolf)?.won, true);
});

Deno.test("reversal: 狼を追放すると狼に言い当てのチャンスが回る", () => {
  let state = toVotePhase(["a", "b", "c"], "reversal");
  const wolfId = state.wolfId ?? "";
  state = voteAll(state, wolfId);
  state = timeout(state); // result → guess
  assertEquals(state.phase, "guess");
  // 追放済みなので狼の正体は卓に露見している。ただし市民のお題はまだ伏せたまま
  const view = viewOf(state, wolfId);
  assertEquals(view.wolfId, wolfId);
  assertEquals(view.youAreWolf, true);
  assertEquals(view.citizenWord, undefined);
  assert(!withoutIds(view).includes(state.citizenWord), "市民のお題が言い当て前に漏れている");
  assertEquals(viewOf(state, someCitizen(state)).youAreWolf, false);
});

Deno.test("reversal: 狼が市民のお題を言い当てれば逆転で狼の勝ち", () => {
  let state = toVotePhase(["a", "b", "c"], "reversal");
  const wolfId = state.wolfId ?? "";
  state = voteAll(state, wolfId);
  state = timeout(state);
  assertEquals(state.phase, "guess");
  state = step(state, {
    t: "clientEvent",
    playerId: wolfId,
    payload: { k: "guess", word: state.citizenWord },
    now: T0,
  });
  assertEquals(state.phase, "final");
  assertEquals(state.guessCorrect, true);
  assertEquals(state.outcome, "wolf");
  assertEquals(viewOf(state, "a").guess, state.citizenWord);
});

Deno.test("reversal: 言い当てを外す・答えないなら市民の勝ち", () => {
  const base = toVotePhase(["a", "b", "c"], "reversal");
  const wolfId = base.wolfId ?? "";
  let wrong = timeout(voteAll(base, wolfId));
  wrong = step(wrong, {
    t: "clientEvent",
    playerId: wolfId,
    payload: { k: "guess", word: "ぜったいちがうことば" },
    now: T0,
  });
  assertEquals(wrong.guessCorrect, false);
  assertEquals(wrong.outcome, "citizens");

  // 期限切れ（未回答）も不正解扱い
  let silent = timeout(voteAll(base, wolfId));
  assertEquals(silent.phase, "guess");
  silent = timeout(silent);
  assertEquals(silent.phase, "final");
  assertEquals(silent.guess, null);
  assertEquals(silent.guessCorrect, false);
  assertEquals(silent.outcome, "citizens");
});

Deno.test("reversal: 表記ゆれ（カタカナ/ひらがな・全角/半角・空白）は正解にする", () => {
  // 「ラーメン」ペアが出るまで seed を変えて探す（正規化の対象になる語で確かめたい）
  let state: WordWolfState | null = null;
  for (let seed = 1; seed < 400; seed++) {
    let s = start(["a", "b", "c"], T0, seed);
    s = config(s, "a", "reversal", 180);
    s = skip(s);
    if (s.citizenWord === "ラーメン") {
      state = s;
      break;
    }
  }
  assertExists(state, "ラーメンが市民のお題になる seed が見つからない");
  state = skip(state); // discuss → vote
  const wolfId = state.wolfId ?? "";
  state = timeout(voteAll(state, wolfId));
  assertEquals(state.phase, "guess");
  const answered = step(state, {
    t: "clientEvent",
    playerId: wolfId,
    payload: { k: "guess", word: "  らーめん  " },
    now: T0,
  });
  assertEquals(answered.guessCorrect, true);
  assertEquals(answered.outcome, "wolf");
});

Deno.test("reversal: 狼を追放できなければ言い当てを挟まず狼の勝ち", () => {
  let state = toVotePhase(["a", "b", "c"], "reversal");
  const citizenId = someCitizen(state);
  state = voteAll(state, citizenId);
  state = timeout(state);
  assertEquals(state.phase, "final");
  assertEquals(state.guess, null);
  assertEquals(state.guessCorrect, null);
  assertEquals(state.outcome, "wolf");
});

Deno.test("言い当ては狼しか送れない。二重回答・不正な形は棄却する", () => {
  let state = toVotePhase(["a", "b", "c"], "reversal");
  const wolfId = state.wolfId ?? "";
  // guess フェーズより前は誰も送れない
  assertEquals(send(state, wolfId, { k: "guess", word: "あ" }).error, "PHASE_MISMATCH");
  state = timeout(voteAll(state, wolfId));
  assertEquals(state.phase, "guess");
  // 市民は送れない
  assertEquals(send(state, someCitizen(state), { k: "guess", word: "あ" }).error, "PHASE_MISMATCH");
  // 形の不正
  assertEquals(send(state, wolfId, { k: "guess" }).error, "INVALID_INPUT");
  assertEquals(send(state, wolfId, { k: "guess", word: "" }).error, "INVALID_INPUT");
  assertEquals(send(state, wolfId, { k: "guess", word: "あ".repeat(41) }).error, "INVALID_INPUT");
  // 期限後
  const late = send(state, wolfId, { k: "guess", word: "あ" }, (state.deadline ?? T0) + 1);
  assertEquals(late.error, "PHASE_MISMATCH");
  // 回答後は二重回答できない（回答すると final へ進むので PHASE_MISMATCH になる）
  const answered = step(state, {
    t: "clientEvent",
    playerId: wolfId,
    payload: { k: "guess", word: "あ" },
    now: T0,
  });
  assertEquals(send(answered, wolfId, { k: "guess", word: "い" }).error, "PHASE_MISMATCH");
});

// ---------------------------------------------------------------------------
// skipPhase（ホストの打ち切り）
// ---------------------------------------------------------------------------

Deno.test("skipPhase はどのフェーズでも現フェーズを打ち切って進める", () => {
  let state = start(["a", "b", "c"]);
  state = config(state, "a", "reversal", 420);
  assertEquals(state.phase, "config");
  state = skip(state);
  assertEquals(state.phase, "discuss");
  const wolfId = state.wolfId ?? "";
  state = skip(state); // 議論を早めに切り上げる
  assertEquals(state.phase, "vote");
  state = voteAll(state, wolfId);
  assertEquals(state.phase, "result");
  state = skip(state); // 開票表示を飛ばす
  assertEquals(state.phase, "guess");
  state = skip(state); // 言い当てを打ち切る（未回答 = 不正解）
  assertEquals(state.phase, "final");
  assertEquals(state.outcome, "citizens");
  const result = wordWolfModule.reduce(state, { t: "skipPhase", now: T0 });
  assertEquals(result.state.running, false);
  assert(hasEffect(result.effects, "ended"));
});

Deno.test("ホストの endGame は即座に終了する", () => {
  const state = toVotePhase(["a", "b", "c"]);
  const result = wordWolfModule.reduce(state, { t: "endGame", now: T0 });
  assertEquals(result.state.running, false);
  const ended = result.effects.find((e) => e.t === "ended");
  assertEquals(ended?.t === "ended" ? ended.reason : null, "hostEnded");
  assertEquals(result.effects.filter((e) => e.t === "score").length, 1);
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : "なし", null);
});

Deno.test("終了後に届いたイベントは無視する（schedule の取りこぼしでも壊れない）", () => {
  let state = start(["a", "b", "c"]);
  state = step(state, { t: "endGame", now: T0 });
  const after = wordWolfModule.reduce(state, { t: "timeout", now: T0 + 999_999 });
  assertEquals(after.changed, false);
  assertEquals(after.effects.length, 0);
  const voted = send(state, "a", { k: "vote", targetId: "b" });
  assertEquals(voted.changed, false);
  assertEquals(voted.error, undefined);
});

// ---------------------------------------------------------------------------
// 途中参加・切断・再接続・キック・人数不足（設計書 §5）
// ---------------------------------------------------------------------------

Deno.test("途中参加は観戦扱い。参加人数を動かさない", () => {
  let state = toVotePhase(["a", "b", "c"]);
  const result = wordWolfModule.reduce(state, {
    t: "playerJoined",
    playerId: "d",
    nickname: "nick-d",
    now: T0,
  });
  assertEquals(result.changed, false);
  state = result.state;
  assertEquals(state.order.length, 3);
  assertEquals(viewOf(state, "d").playerCount, 3);
  assertEquals(viewOf(state, "d").myWord, null);
  assertEquals(send(state, "d", { k: "vote", targetId: "a" }).error, "PHASE_MISMATCH");
});

Deno.test("切断した人は待たない。残り全員が投票すればその場で開票する", () => {
  let state = toVotePhase(["a", "b", "c"]);
  state = vote(state, "a", "b");
  state = step(state, { t: "playerLeft", playerId: "c", now: T0 });
  assertEquals(state.phase, "vote");
  assertEquals(viewOf(state, "a").players.find((p) => p.playerId === "c")?.connected, false);
  state = vote(state, "b", "a");
  // 切断中の c を待たずに開票へ進む（1票ずつなので同票 = 追放なし）
  assertEquals(state.phase, "result");
  assertEquals(state.voteTie, true);
});

Deno.test("再接続すると投票の待ち対象へ戻る", () => {
  let state = toVotePhase(["a", "b", "c"]);
  state = step(state, { t: "playerLeft", playerId: "c", now: T0 });
  state = step(state, { t: "playerRejoined", playerId: "c", now: T0 });
  assertEquals(viewOf(state, "c").players.find((p) => p.playerId === "c")?.connected, true);
  state = vote(state, "a", "b");
  state = vote(state, "b", "a");
  // c がつながっているので、まだ開票しない
  assertEquals(state.phase, "vote");
  state = vote(state, "c", "a");
  assertEquals(state.phase, "result");
  assertEquals(state.exiledId, "a");
});

Deno.test("キックされた人は在籍・投票・開票結果から消える", () => {
  let state = toVotePhase(["a", "b", "c", "d"]);
  const wolfId = state.wolfId ?? "";
  const target = state.order.find((id) => id !== wolfId && id !== state.order[0]) ?? "";
  state = vote(state, state.order[0], target);
  state = step(state, { t: "playerKicked", playerId: target, now: T0 });
  assertEquals(state.order.includes(target), false);
  // その人へ入っていた票も消える
  assertEquals(state.votes[state.order[0]], undefined);
  assertEquals(viewOf(state, "a").playerCount, 3);
  assertEquals(viewOf(state, "a").players.some((p) => p.playerId === target), false);
});

Deno.test("在籍が minPlayers（3人）を割ったら tooFewPlayers で終わる", () => {
  const state = toVotePhase(["a", "b", "c"]);
  const result = wordWolfModule.reduce(state, { t: "playerKicked", playerId: "c", now: T0 });
  assertEquals(result.state.running, false);
  const ended = result.effects.find((e) => e.t === "ended");
  assertEquals(ended?.t === "ended" ? ended.reason : null, "tooFewPlayers");
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : "なし", null);
  assertEquals(result.effects.filter((e) => e.t === "score").length, 1);
});

Deno.test("狼が卓を去ったらゲームは成立しない。勝敗を付けずに中断する", () => {
  const state = toVotePhase(["a", "b", "c", "d"]);
  const wolfId = state.wolfId ?? "";
  const result = wordWolfModule.reduce(state, { t: "playerKicked", playerId: wolfId, now: T0 });
  assertEquals(result.state.running, false);
  assertEquals(result.state.abort, "wolfLeft");
  assertEquals(result.state.outcome, null);
  const view = wordWolfModule.view(result.state, "a");
  assertEquals(view.abort, "wolfLeft");
  assertEquals(view.outcome, null);
  // 誰も勝っていないので全員0点
  const score = result.effects.find((e) => e.t === "score");
  assert(score !== undefined && score.t === "score");
  assertEquals(score.totals.every((r) => r.totalScore === 0), true);
});

Deno.test("決着後に狼が卓を去っても、出た結果はそのまま残る", () => {
  let state = toVotePhase(["a", "b", "c", "d"]);
  const wolfId = state.wolfId ?? "";
  state = timeout(voteAll(state, wolfId)); // simple なのでここで決着
  assertEquals(state.phase, "final");
  assertEquals(state.outcome, "citizens");
  state = step(state, { t: "playerKicked", playerId: wolfId, now: T0 });
  // 中断扱いにはせず、市民の勝ちを保つ
  assertEquals(state.abort, null);
  assertEquals(state.outcome, "citizens");
  assertEquals(state.running, true);
  assertEquals(viewOf(state, "a").results?.some((r) => r.playerId === wolfId), false);
});

Deno.test("設定中に人数が minPlayers を割ったら開始せずに終わる", () => {
  let state = start(["a", "b", "c"]);
  state = step(state, { t: "playerKicked", playerId: "c", now: T0 });
  assertEquals(state.running, false);
  assertEquals(state.phase, "final");
  // お題は配られないまま
  assertEquals(state.wolfId, null);
  assertEquals(viewOf(state, "a").results, undefined);
});

Deno.test("狼は接続中の人から選ばれる（設定中に切断した人を狼にしない）", () => {
  // order は playerLeft では縮まないので、素朴に抽選すると切断者が狼になりうる。
  // 多めの seed で回して、切断中の人が1度も狼にならないことを確かめる
  for (let seed = 1; seed <= 200; seed++) {
    let state = start(["a", "b", "c", "d"], T0, seed);
    state = step(state, { t: "playerLeft", playerId: "a", now: T0 });
    state = skip(state);
    assertEquals(state.phase, "discuss");
    assertNotEquals(state.wolfId, "a", `切断中の人が狼になった (seed=${seed})`);
  }
});

Deno.test("投票中に接続者が0人になっても開票しない（期限まで待つ）", () => {
  let state = toVotePhase(["a", "b", "c"]);
  state = step(state, { t: "playerLeft", playerId: "a", now: T0 });
  state = step(state, { t: "playerLeft", playerId: "b", now: T0 });
  assertEquals(state.phase, "vote");
  const result = wordWolfModule.reduce(state, { t: "playerLeft", playerId: "c", now: T0 });
  // 全員が落ちただけで 0 票のまま勝敗が決まってしまわないこと
  assertEquals(result.state.phase, "vote");
  // 期限が来れば通常どおり開票する
  const opened = step(result.state, { t: "timeout", now: result.state.deadline ?? T0 });
  assertEquals(opened.phase, "result");
});

Deno.test("キックで票を無効にされた人は投票し直せる", () => {
  let state = toVotePhase(["a", "b", "c", "d"]);
  state = vote(state, "a", "d");
  assertEquals(state.votes["a"], "d");
  state = step(state, { t: "playerKicked", playerId: "d", now: T0 });
  // d への票は消えるので、a は入れ直せる
  assertEquals(state.votes["a"], undefined);
  state = vote(state, "a", "b");
  assertEquals(state.votes["a"], "b");
});

Deno.test("中断（狼の離脱）でも view には単語と狼が公開され、勝敗だけが空になる", () => {
  const state = toVotePhase(["a", "b", "c", "d"]);
  const wolfId = state.wolfId ?? "";
  const ended = wordWolfModule.reduce(state, { t: "playerKicked", playerId: wolfId, now: T0 });
  const view = wordWolfModule.view(ended.state, "a");
  assertEquals(view.phase, "final");
  assertEquals(view.abort, "wolfLeft");
  assertEquals(view.outcome, null);
  // 何のお題だったかは明かす（明かさないと卓がもやもやしたまま終わる）
  assertEquals(view.citizenWord, state.citizenWord);
  assertEquals(view.wolfWord, state.wolfWord);
  assertEquals(view.wolfId, wolfId);
  // 去った本人は一覧から消えている
  assertEquals(view.results?.some((r) => r.playerId === wolfId), false);
});

Deno.test("議論中の endGame でも、最終結果として単語と狼が全公開される", () => {
  let state = start(["a", "b", "c"]);
  state = skip(state);
  assertEquals(state.phase, "discuss");
  const ended = wordWolfModule.reduce(state, { t: "endGame", now: T0 });
  const view = wordWolfModule.view(ended.state, "a");
  assertEquals(view.phase, "final");
  assertEquals(view.wolfId, state.wolfId);
  assertEquals(view.citizenWord, state.citizenWord);
  assertEquals(view.wolfWord, state.wolfWord);
  assertEquals(view.results?.length, 3);
});

Deno.test("どのフェーズでも minPlayers を割れば tooFewPlayers で終わる", () => {
  // discuss / vote / result / guess の各フェーズで確かめる
  const base = () => {
    let s = start(["a", "b", "c"]);
    s = config(s, "a", "reversal", 180);
    return skip(s); // discuss
  };
  const discuss = base();
  const voteState = skip(discuss);
  const resultState = voteAll(voteState, voteState.wolfId ?? "");
  const guessState = timeout(resultState);
  assertEquals(guessState.phase, "guess");

  for (const [name, state] of Object.entries({ discuss, voteState, resultState, guessState })) {
    const result = wordWolfModule.reduce(state, { t: "playerKicked", playerId: "c", now: T0 });
    assertEquals(result.state.running, false, `${name} で終了しなかった`);
    const ended = result.effects.find((e) => e.t === "ended");
    // 狼が抜けた場合は「中断」、それ以外は人数不足。どちらでも終了はする
    assert(
      ended?.t === "ended" &&
        (ended.reason === "tooFewPlayers" || ended.reason === "completed"),
      `${name} の終了理由が不正`,
    );
    assertEquals(result.effects.filter((e) => e.t === "score").length, 1, `${name} の score`);
    const schedule = result.effects.find((e) => e.t === "schedule");
    assertEquals(schedule?.t === "schedule" ? schedule.at : "なし", null, `${name} の schedule`);
  }
});

// ---------------------------------------------------------------------------
// 純粋性（設計書 §3.2 規約2）
// ---------------------------------------------------------------------------

Deno.test("reduce / view は純粋。同じ入力なら同じ出力で、入力 state を変更しない", () => {
  const state = toVotePhase(["a", "b", "c"]);
  const snapshot = JSON.stringify(state);

  const first = send(state, "a", { k: "vote", targetId: "b" });
  const second = send(state, "a", { k: "vote", targetId: "b" });
  assertEquals(JSON.stringify(first.state), JSON.stringify(second.state));
  assertEquals(JSON.stringify(first.effects), JSON.stringify(second.effects));
  assertEquals(JSON.stringify(state), snapshot);
  assertNotEquals(first.state.votes, state.votes);

  assertEquals(
    JSON.stringify(wordWolfModule.view(state, "a")),
    JSON.stringify(wordWolfModule.view(state, "a")),
  );
});

Deno.test("同じ seed なら狼とお題は毎回同じ（Math.random() を使っていない）", () => {
  const a = skip(start(["a", "b", "c", "d"]));
  const b = skip(start(["a", "b", "c", "d"]));
  assertEquals(a.wolfId, b.wolfId);
  assertEquals(a.citizenWord, b.citizenWord);
  assertEquals(a.wolfWord, b.wolfWord);
});

Deno.test("お題ペアは20組以上あり、重複・空・同語ペアが無い", () => {
  assert(WORDWOLF_WORD_PAIRS.length >= 20, `お題ペアが少ない: ${WORDWOLF_WORD_PAIRS.length}`);
  const seen = new Set<string>();
  for (const [x, y] of WORDWOLF_WORD_PAIRS) {
    assert(x.length > 0 && y.length > 0, "空のお題がある");
    assertNotEquals(x, y, `同じ語のペアがある: ${x}`);
    for (const word of [x, y]) {
      assert(!seen.has(word), `同じ語が複数のペアに出ている: ${word}`);
      seen.add(word);
    }
  }
});

/** 入れ子まで凍らせる。strict mode なので、書き換えようとすると例外になる */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** 代表的な6フェーズの state を1つずつ作る */
function statesByPhase(): Record<string, WordWolfState> {
  const configState = start(["a", "b", "c", "d"]);
  const discuss = skip(config(configState, "a", "reversal", 180));
  const voteState = skip(discuss);
  const resultState = voteAll(voteState, voteState.wolfId ?? "");
  const guessState = timeout(resultState);
  const finalState = timeout(guessState);
  return {
    config: configState,
    discuss,
    vote: voteState,
    result: resultState,
    guess: guessState,
    final: finalState,
  };
}

Deno.test("純粋性: 全フェーズ × 全イベントで入力 state を書き換えない", () => {
  const events: ModuleEvent[] = [
    {
      t: "clientEvent",
      playerId: "a",
      payload: { k: "config", mode: "reversal", discussionSec: 420 },
      now: T0,
    },
    { t: "clientEvent", playerId: "a", payload: { k: "vote", targetId: "b" }, now: T0 },
    { t: "clientEvent", playerId: "a", payload: { k: "guess", word: "ラーメン" }, now: T0 },
    { t: "clientEvent", playerId: "a", payload: { k: "zzz" }, now: T0 },
    { t: "timeout", now: T0 + 10_000_000 },
    { t: "playerJoined", playerId: "e", nickname: "nick-e", now: T0 },
    { t: "playerLeft", playerId: "b", now: T0 },
    { t: "playerRejoined", playerId: "b", now: T0 },
    { t: "playerKicked", playerId: "b", now: T0 },
    { t: "skipPhase", now: T0 },
    { t: "endGame", now: T0 },
  ];
  for (const [phase, original] of Object.entries(statesByPhase())) {
    for (const event of events) {
      const frozen = deepFreeze(structuredClone(original));
      const snapshot = JSON.stringify(frozen);
      // 凍った state を書き換えようとすれば、ここで例外になる
      const first = wordWolfModule.reduce(frozen, event);
      const second = wordWolfModule.reduce(frozen, event);
      assertEquals(JSON.stringify(frozen), snapshot, `${phase} / ${event.t} で入力が変わった`);
      assertEquals(
        JSON.stringify(first.state),
        JSON.stringify(second.state),
        `${phase} / ${event.t} が決定的でない`,
      );
      assertEquals(JSON.stringify(first.effects), JSON.stringify(second.effects));
      // view も凍った state を触らない
      for (const viewer of ["a", "b", "zzz"]) {
        assertEquals(
          JSON.stringify(wordWolfModule.view(frozen, viewer)),
          JSON.stringify(wordWolfModule.view(frozen, viewer)),
        );
      }
      assertEquals(
        JSON.stringify(frozen),
        snapshot,
        `${phase} / ${event.t} で view が入力を変えた`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// ルーム層との配線（設計書 §2.2 / §3.2 / §5）
// ---------------------------------------------------------------------------

/** 手動で進められる時計（rooms_test.ts の FakeClock と同じ作り） */
class FakeClock {
  now = T0;
  private seq = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  setTimer = (fn: () => void, ms: number): number => {
    const id = this.seq++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimer = (handle: number): void => {
    this.timers.delete(handle);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let pickId = -1;
      let pickAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < pickAt) {
          pickAt = timer.at;
          pickId = id;
        }
      }
      if (pickId < 0) break;
      const timer = this.timers.get(pickId);
      if (timer === undefined) break;
      this.timers.delete(pickId);
      this.now = Math.max(this.now, timer.at);
      timer.fn();
    }
    this.now = target;
  }
}

/** 受信内容を貯めるだけの接続 */
class MockLink implements ClientLink {
  readonly id = crypto.randomUUID();
  readonly received: S2C[] = [];
  closed = false;

  constructor(readonly userId: string | null = "testUser") {}

  send(msg: S2C): void {
    this.received.push(msg);
  }

  close(): void {
    this.closed = true;
  }
}

/** 直近に受け取った指定種別のメッセージ */
function last<T extends S2C["t"]>(link: MockLink, t: T): Extract<S2C, { t: T }> | undefined {
  for (let i = link.received.length - 1; i >= 0; i--) {
    const msg = link.received[i];
    if (msg.t === t) return msg as Extract<S2C, { t: T }>;
  }
  return undefined;
}

/** 直近の gameView の中身を WordWolfView として読む */
function lastView(link: MockLink): WordWolfView {
  const msg = last(link, "gameView");
  assertExists(msg, "gameView が届いていない");
  assertEquals(msg.gameId, "wordwolf");
  return msg.view as WordWolfView;
}

/** ホストと客2人でワードウルフを開始した卓を作る */
function playingRoom() {
  const clock = new FakeClock();
  const manager = new RoomManager({
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const host = new MockLink();
  manager.handle(host, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  const created = last(host, "roomState");
  assertExists(created);
  const code = created.snapshot.code;
  const guest1 = new MockLink();
  manager.handle(guest1, { t: "join", roomCode: code, nickname: "客1" });
  const joined1 = last(guest1, "roomState");
  assertExists(joined1);
  const guest2 = new MockLink();
  manager.handle(guest2, { t: "join", roomCode: code, nickname: "客2" });
  const joined2 = last(guest2, "roomState");
  assertExists(joined2);

  manager.handle(host, { t: "selectGame", gameId: "wordwolf" });
  manager.handle(host, { t: "startGame" });
  return {
    clock,
    manager,
    host,
    guest1,
    guest2,
    code,
    hostId: created.snapshot.youId,
    guest1Id: joined1.snapshot.youId,
    guest2Id: joined2.snapshot.youId,
  };
}

Deno.test("卓: 一覧に専用モジュール型として並び、3人から始められる", () => {
  const room = playingRoom();
  const snapshot = last(room.host, "roomState");
  assertExists(snapshot);
  const summary = snapshot.snapshot.availableGames.find((g) => g.id === "wordwolf");
  assertExists(summary, "ワードウルフが一覧に無い");
  assertEquals(summary.kind, "module");
  assertEquals(summary.minPlayers, 3);
  assertEquals(last(room.host, "phase")?.phase, "playing");
  assertEquals(lastView(room.host).phase, "config");
  // 設定フェーズの期限が秒読み用に配られている
  assertEquals(last(room.host, "gameView")?.deadline, T0 + 120_000);
  room.manager.dispose();
});

Deno.test("卓: 2人では始められない（minPlayers 未満）", () => {
  const clock = new FakeClock();
  const manager = new RoomManager({
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const host = new MockLink();
  manager.handle(host, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  const created = last(host, "roomState");
  assertExists(created);
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: created.snapshot.code, nickname: "客" });
  manager.handle(host, { t: "selectGame", gameId: "wordwolf" });
  manager.handle(host, { t: "startGame" });
  assertEquals(last(host, "error")?.code, "PHASE_MISMATCH");
  assertEquals(last(host, "gameView"), undefined);
  manager.dispose();
});

Deno.test("卓: 非ホストは skipPhase できないので、勝手にゲームを始められない", () => {
  const room = playingRoom();
  room.manager.handle(room.guest1, { t: "skipPhase" });
  assertEquals(last(room.guest1, "error")?.code, "NOT_HOST");
  assertEquals(lastView(room.host).phase, "config");
  // ホストが押すと始まる
  room.manager.handle(room.host, { t: "skipPhase" });
  assertEquals(lastView(room.host).phase, "discuss");
  room.manager.dispose();
});

Deno.test("卓: gameEvent で設定を変えられ、開始後は自分の単語だけが配られる", () => {
  const room = playingRoom();
  room.manager.handle(room.host, {
    t: "gameEvent",
    payload: { k: "config", mode: "reversal", discussionSec: 180 },
  });
  assertEquals(lastView(room.guest1).mode, "reversal");
  assertEquals(lastView(room.guest1).configuredBy, "ホスト");
  // 不正な設定は本人にだけ INVALID_INPUT が返る
  room.manager.handle(room.guest1, {
    t: "gameEvent",
    payload: { k: "config", mode: "zzz", discussionSec: 180 },
  });
  assertEquals(last(room.guest1, "error")?.code, "INVALID_INPUT");

  room.manager.handle(room.host, { t: "skipPhase" });
  const words = [
    lastView(room.host).myWord,
    lastView(room.guest1).myWord,
    lastView(room.guest2).myWord,
  ];
  assertEquals(words.filter((w) => typeof w === "string" && w.length > 0).length, 3);
  assertEquals(new Set(words).size, 2, "お題が2種類になっていない");
  // 他人の単語は届いていない
  for (const link of [room.host, room.guest1, room.guest2]) {
    const view = lastView(link);
    const mine = view.myWord ?? "";
    const others = words.filter((w) => w !== mine);
    const json = withoutIds(view);
    for (const other of others) {
      assert(!json.includes(other ?? ""), `他人の単語が配信されている: ${json}`);
    }
    assertEquals(view.wolfId, undefined);
  }
  room.manager.dispose();
});

Deno.test("卓: 再接続・途中参加は RoomSnapshot.game で復元できる", () => {
  const room = playingRoom();
  room.manager.handle(room.host, { t: "skipPhase" });
  const myWord = lastView(room.host).myWord;
  assertExists(myWord);
  const session = last(room.host, "roomState")?.snapshot.session;
  assertExists(session);
  room.manager.disconnect(room.host);

  const again = new MockLink();
  room.manager.handle(again, { t: "join", roomCode: room.code, nickname: "ホスト", session });
  const snapshot = last(again, "roomState")?.snapshot;
  assertExists(snapshot);
  assertEquals(snapshot.phase, "playing");
  assertExists(snapshot.game);
  assertEquals(snapshot.game.gameId, "wordwolf");
  assertEquals((snapshot.game.view as WordWolfView).myWord, myWord);

  // 途中参加は観戦。単語は配られない
  const late = new MockLink();
  room.manager.handle(late, { t: "join", roomCode: room.code, nickname: "遅れ客" });
  const lateSnapshot = last(late, "roomState")?.snapshot;
  assertExists(lateSnapshot);
  assertExists(lateSnapshot.game);
  const lateView = lateSnapshot.game.view as WordWolfView;
  assertEquals(lateView.myWord, null);
  assertEquals(lateView.youArePlayer, false);
  assertEquals(lateView.playerCount, 3);
  room.manager.dispose();
});

Deno.test("卓: 期限に達すると schedule で自動的に進み、最後は lobby へ戻って加点される", () => {
  const room = playingRoom();
  room.manager.handle(room.host, {
    t: "gameEvent",
    payload: { k: "config", mode: "simple", discussionSec: 180 },
  });
  room.clock.advance(120_000); // 設定フェーズの期限 → discuss
  assertEquals(lastView(room.host).phase, "discuss");
  room.clock.advance(180_000); // 議論 → vote
  assertEquals(lastView(room.host).phase, "vote");

  // 全員がホストへ投票する（ホストが狼なら市民の勝ち、そうでなければ狼の勝ち）
  room.manager.handle(room.guest1, {
    t: "gameEvent",
    payload: { k: "vote", targetId: room.hostId },
  });
  room.manager.handle(room.guest2, {
    t: "gameEvent",
    payload: { k: "vote", targetId: room.hostId },
  });
  room.manager.handle(room.host, {
    t: "gameEvent",
    payload: { k: "vote", targetId: room.guest1Id },
  });
  assertEquals(lastView(room.host).phase, "result");
  assertEquals(lastView(room.host).exiledId, room.hostId);

  room.clock.advance(12_000); // 開票表示 → final
  const finalView = lastView(room.host);
  assertEquals(finalView.phase, "final");
  assertExists(finalView.wolfId);
  assertExists(finalView.citizenWord);
  assertExists(finalView.results);

  room.clock.advance(20_000); // 最終結果の表示 → 終了
  assertEquals(last(room.host, "phase")?.phase, "lobby");
  // 勝った側の人数分だけ点が入っている（合計は勝者の人数）
  const roomState = room.manager.getRoom(room.code);
  assertExists(roomState);
  const total = [...roomState.players.values()].reduce((sum, p) => sum + p.score, 0);
  assertEquals(total, finalView.wolfId === room.hostId ? 2 : 1);
  // バグ回帰: rooms.ts の score/viewChanged/ended の処理順によっては、内部の Player.score は
  // 正しくても実際に配信される roomState（参加者一覧）には加点が乗らないことがあった
  // （server/games/chicken.ts で実機確認されたバグと同じ効果順序を wordwolf も使っている）。
  // getRoom（内部状態）だけでなく、実際に届いた S2C "roomState" でも同じ値になることを確かめる
  const delivered = last(room.host, "roomState")?.snapshot;
  assertExists(delivered, "終了後に roomState が届いていない");
  const deliveredTotal = delivered.players.reduce((sum, p) => sum + p.score, 0);
  assertEquals(deliveredTotal, total, "配信された roomState の得点が内部状態と一致しない");
  room.manager.dispose();
});
