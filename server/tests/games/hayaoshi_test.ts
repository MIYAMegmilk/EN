/**
 * server/games/hayaoshi.ts のユニットテスト
 * 設計書 docs/design/games-unified.md §7 のチェックリストに対応する。
 *
 * 眼目は4つ。
 *   1. **正解が発表まで漏れないこと**（view が questions[].answer に一切依存しない）
 *   2. 押し順（同時押しの決着・二重押しの拒否・フライングの棄却）
 *   3. 誤答後に回答権が正しく空き、残った人で早押しが再開すること
 *   4. 異常系（不正 payload・回答権保持者の切断・キック・人数不足・skipPhase）で壊れないこと
 */

import { assert, assertEquals, assertExists, assertNotEquals } from "@std/assert";
import type { EnginePlayerInput } from "../../engine.ts";
import { type ClientLink, RoomManager } from "../../rooms.ts";
import type { S2C } from "../../types.ts";
import {
  HAYAOSHI_OPTION_COUNT,
  HAYAOSHI_QUESTIONS,
  hayaoshiModule,
  type HayaoshiState,
  type HayaoshiView,
} from "../../games/hayaoshi.ts";
import type { ModuleEffect, ModuleEvent, ModuleResult } from "../../games/module.ts";

const T0 = 1_700_000_000_000;
const SEED = 20260826;

/** テスト用の参加者を作る */
function players(...ids: string[]): EnginePlayerInput[] {
  return ids.map((id) => ({ id, nickname: `nick-${id}`, connected: true }));
}

/** ゲームを開始する（ready フェーズ） */
function start(ids: string[], now = T0): HayaoshiState {
  const result = hayaoshiModule.init({ players: players(...ids), now, seed: SEED });
  assertEquals(result.error, undefined);
  return result.state;
}

/** 1件のイベントを流し、エラーが無いことを確かめて新しい state を返す */
function step(state: HayaoshiState, event: ModuleEvent): HayaoshiState {
  const result = hayaoshiModule.reduce(state, event);
  assertEquals(result.error, undefined, `想定外のエラー: ${result.message}`);
  return result.state;
}

/** 期限に達した timeout を流す */
function timeout(state: HayaoshiState): HayaoshiState {
  return step(state, { t: "timeout", now: state.deadline ?? T0 });
}

/** 開始して早押し受付（buzz）まで進める */
function startBuzzing(ids: string[]): HayaoshiState {
  const state = start(ids);
  assertEquals(state.phase, "ready");
  return timeout(state);
}

/** クライアントイベントをそのまま流す（エラーの検査用） */
function tryEvent(
  state: HayaoshiState,
  playerId: string,
  payload: unknown,
  now?: number,
): ModuleResult<HayaoshiState> {
  return hayaoshiModule.reduce(state, {
    t: "clientEvent",
    playerId,
    payload,
    now: now ?? state.deadline ?? T0,
  });
}

/** 早押しする */
function buzz(state: HayaoshiState, playerId: string): HayaoshiState {
  const result = tryEvent(state, playerId, { k: "buzz" }, T0);
  assertEquals(result.error, undefined, `早押しが弾かれた: ${result.message}`);
  return result.state;
}

/** いま出題中の問題の正解番号 */
function correctOf(state: HayaoshiState): number {
  const q = state.questions[state.questionNo - 1];
  assertExists(q);
  return q.answer;
}

/** 正解番号以外の選択肢番号（誤答用） */
function wrongOf(state: HayaoshiState): number {
  return (correctOf(state) + 1) % HAYAOSHI_OPTION_COUNT;
}

/** 回答する */
function answer(state: HayaoshiState, playerId: string, choice: number): HayaoshiState {
  const result = tryEvent(state, playerId, { k: "answer", choice }, T0);
  assertEquals(result.error, undefined, `回答が弾かれた: ${result.message}`);
  return result.state;
}

/** 受信者向けの view */
function viewOf(state: HayaoshiState, viewerId: string): HayaoshiView {
  return hayaoshiModule.view(state, viewerId);
}

/** 効果に指定の種類が含まれるか */
function hasEffect(effects: ModuleEffect[], t: ModuleEffect["t"]): boolean {
  return effects.some((e) => e.t === t);
}

// ---------------------------------------------------------------------------
// 正常進行
// ---------------------------------------------------------------------------

Deno.test("開始すると読み時間（ready）になり、期限が予約される", () => {
  const result = hayaoshiModule.init({ players: players("a", "b"), now: T0, seed: SEED });
  assertEquals(result.error, undefined);
  assertEquals(result.state.phase, "ready");
  assertEquals(result.state.questionNo, 1);
  assertEquals(result.state.totalQuestions, 5);
  assertEquals(result.state.questions.length, 5);
  assertEquals(result.state.answererId, null);
  assertEquals(result.state.blocked, []);
  assert(hasEffect(result.effects, "viewChanged"));
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : null, result.state.deadline);
  assert((result.state.deadline ?? 0) > T0);
  // 選択肢は必ず4つで、正解番号は範囲内
  for (const q of result.state.questions) {
    assertEquals(q.options.length, HAYAOSHI_OPTION_COUNT);
    assert(q.answer >= 0 && q.answer < HAYAOSHI_OPTION_COUNT);
  }
});

Deno.test("同じ seed なら同じ出題になる（Math.random() を使っていない）", () => {
  const a = hayaoshiModule.init({ players: players("a", "b"), now: T0, seed: SEED });
  const b = hayaoshiModule.init({ players: players("a", "b"), now: T0, seed: SEED });
  assertEquals(JSON.stringify(a.state.questions), JSON.stringify(b.state.questions));
  const other = hayaoshiModule.init({ players: players("a", "b"), now: T0, seed: SEED + 1 });
  assertNotEquals(
    JSON.stringify(a.state.questions),
    JSON.stringify(other.state.questions),
    "seed を変えても出題が同じ（乱数が効いていない）",
  );
});

Deno.test("読み時間が終わると早押し受付になり、正解すると1点入って正解発表へ進む", () => {
  let state = startBuzzing(["a", "b"]);
  assertEquals(state.phase, "buzz");
  state = buzz(state, "a");
  assertEquals(state.phase, "answer");
  assertEquals(state.answererId, "a");
  state = answer(state, "a", correctOf(state));
  assertEquals(state.phase, "reveal");
  assertEquals(state.scores["a"], 1);
  assertEquals(state.scores["b"], 0);
  assertEquals(state.lastReveal?.winnerId, "a");
  assertEquals(state.answererId, null);
});

Deno.test("最後の問題まで進めると最終結果になり、終了時に score を1回だけ出す", () => {
  let state = start(["a", "b"]);
  for (let no = 1; no <= 5; no++) {
    assertEquals(state.questionNo, no);
    state = timeout(state); // ready → buzz
    state = buzz(state, "a");
    state = answer(state, "a", correctOf(state));
    assertEquals(state.phase, "reveal");
    state = timeout(state); // reveal の表示時間が終わる
  }
  assertEquals(state.phase, "final");
  assert(state.running);
  const result = hayaoshiModule.reduce(state, { t: "timeout", now: state.deadline ?? T0 });
  assertEquals(result.state.running, false);
  assertEquals(result.effects.filter((e) => e.t === "score").length, 1);
  const score = result.effects.find((e) => e.t === "score");
  assert(score !== undefined && score.t === "score");
  assertEquals(score.totals.find((row) => row.playerId === "a")?.totalScore, 5);
  assertEquals(score.totals.find((row) => row.playerId === "a")?.rank, 1);
  assertEquals(score.totals.find((row) => row.playerId === "b")?.totalScore, 0);
  assertEquals(score.totals.find((row) => row.playerId === "b")?.rank, 2);
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : "なし", null);
  assert(hasEffect(result.effects, "ended"));
});

Deno.test("終了後に届いたイベントは無視する（schedule の取りこぼしでも壊れない）", () => {
  let state = startBuzzing(["a", "b"]);
  state = step(state, { t: "endGame", now: T0 });
  assertEquals(state.running, false);
  const after = hayaoshiModule.reduce(state, { t: "timeout", now: T0 + 999_999 });
  assertEquals(after.changed, false);
  assertEquals(after.effects.length, 0);
  const buzzed = tryEvent(state, "a", { k: "buzz" });
  assertEquals(buzzed.changed, false);
  assertEquals(buzzed.error, undefined);
});

// ---------------------------------------------------------------------------
// 押し順・フライング防止
// ---------------------------------------------------------------------------

Deno.test("フライング: 読み時間（ready）の早押しは PHASE_MISMATCH で棄却され、罰も無い", () => {
  const state = startFlying();
  const result = tryEvent(state, "a", { k: "buzz" }, T0);
  assertEquals(result.error, "PHASE_MISMATCH");
  assertEquals(result.changed, false);
  assertEquals(result.effects.length, 0);
  // 状態は一切動かない（ペナルティで回答不可になったりしない）
  assertEquals(result.state, state);
  assertEquals(result.state.blocked, []);
});

/** ready フェーズの state（フライング用） */
function startFlying(): HayaoshiState {
  const state = start(["a", "b"]);
  assertEquals(state.phase, "ready");
  return state;
}

Deno.test("押し順: 先にサーバーへ届いた1人だけが回答権を得る（同時押しの決着）", () => {
  const state = startBuzzing(["a", "b", "c"]);
  // a が先に届く
  const first = hayaoshiModule.reduce(state, {
    t: "clientEvent",
    playerId: "a",
    payload: { k: "buzz" },
    now: T0,
  });
  assertEquals(first.error, undefined);
  assertEquals(first.state.answererId, "a");
  // 同じ瞬間に b が押していても、届くのが後なら弾かれる
  const second = hayaoshiModule.reduce(first.state, {
    t: "clientEvent",
    playerId: "b",
    payload: { k: "buzz" },
    now: T0,
  });
  assertEquals(second.error, "PHASE_MISMATCH");
  assertEquals(second.changed, false);
  assertEquals(second.state.answererId, "a");
  // 逆順に届けば b が取る（クライアントの自己申告時刻は見ていない）
  const reversed = hayaoshiModule.reduce(state, {
    t: "clientEvent",
    playerId: "b",
    payload: { k: "buzz" },
    now: T0 - 5_000,
  });
  assertEquals(reversed.state.answererId, "b");
});

Deno.test("押し順: 回答権を持った本人の二重押しも拒否する", () => {
  const state = buzz(startBuzzing(["a", "b"]), "a");
  const again = tryEvent(state, "a", { k: "buzz" }, T0);
  assertEquals(again.error, "PHASE_MISMATCH");
  assertEquals(again.changed, false);
  assertEquals(again.state.answererId, "a");
});

Deno.test("押し順: 誤答して回答不可になった人の再押しは DUPLICATE", () => {
  let state = startBuzzing(["a", "b"]);
  state = buzz(state, "a");
  state = answer(state, "a", wrongOf(state));
  assertEquals(state.phase, "buzz");
  const again = tryEvent(state, "a", { k: "buzz" }, T0);
  assertEquals(again.error, "DUPLICATE");
  assertEquals(again.changed, false);
});

// ---------------------------------------------------------------------------
// 誤答後の回答権の再開放
// ---------------------------------------------------------------------------

Deno.test("誤答したらその問だけ回答不可になり、残りの人で早押しが再開する（減点なし）", () => {
  let state = startBuzzing(["a", "b", "c"]);
  state = buzz(state, "a");
  const wrong = wrongOf(state);
  const result = hayaoshiModule.reduce(state, {
    t: "clientEvent",
    playerId: "a",
    payload: { k: "answer", choice: wrong },
    now: T0,
  });
  assertEquals(result.error, undefined);
  state = result.state;
  // 早押しが再開し、期限が引き直される（schedule 効果が出ている）
  assertEquals(state.phase, "buzz");
  assertEquals(state.answererId, null);
  assertEquals(state.blocked, ["a"]);
  assert(hasEffect(result.effects, "schedule"));
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : null, state.deadline);
  // 減点はしない
  assertEquals(state.scores["a"], 0);
  // a はもう押せないが、b は押せる
  assertEquals(viewOf(state, "a").canBuzz, false);
  assertEquals(viewOf(state, "a").amBlocked, true);
  assertEquals(viewOf(state, "b").canBuzz, true);
  state = buzz(state, "b");
  assertEquals(state.answererId, "b");
  state = answer(state, "b", correctOf(state));
  assertEquals(state.scores["b"], 1);
  assertEquals(state.lastReveal?.winnerId, "b");
});

Deno.test("誤答した人も次の問題では普通に参加できる", () => {
  let state = startBuzzing(["a", "b"]);
  state = buzz(state, "a");
  state = answer(state, "a", wrongOf(state));
  state = buzz(state, "b");
  state = answer(state, "b", correctOf(state));
  assertEquals(state.phase, "reveal");
  state = timeout(state); // 次の問題へ
  assertEquals(state.phase, "ready");
  assertEquals(state.questionNo, 2);
  assertEquals(state.blocked, []);
  state = timeout(state);
  assertEquals(viewOf(state, "a").canBuzz, true);
  state = buzz(state, "a");
  assertEquals(state.answererId, "a");
});

Deno.test("全員が誤答したら正解を見せて次の問へ（正解者なし）", () => {
  let state = startBuzzing(["a", "b"]);
  state = buzz(state, "a");
  state = answer(state, "a", wrongOf(state));
  state = buzz(state, "b");
  state = answer(state, "b", wrongOf(state));
  assertEquals(state.phase, "reveal");
  assertEquals(state.lastReveal?.winnerId, null);
  assertEquals(state.lastReveal?.correct, correctOf(state));
  assertEquals(state.lastReveal?.missedIds.slice().sort(), ["a", "b"]);
  assertEquals(state.scores["a"], 0);
  assertEquals(state.scores["b"], 0);
});

// ---------------------------------------------------------------------------
// 時間切れ
// ---------------------------------------------------------------------------

Deno.test("時間切れ: 誰も押さなければ正解を見せて次の問へ", () => {
  let state = startBuzzing(["a", "b"]);
  state = timeout(state);
  assertEquals(state.phase, "reveal");
  assertEquals(state.lastReveal?.winnerId, null);
  assertEquals(state.lastReveal?.missedIds, []);
  state = timeout(state);
  assertEquals(state.phase, "ready");
  assertEquals(state.questionNo, 2);
});

Deno.test("時間切れ: 回答権を持ったまま答えなければ、誤答と同じ扱いで権利が空く", () => {
  let state = startBuzzing(["a", "b"]);
  state = buzz(state, "a");
  assertEquals(state.phase, "answer");
  state = timeout(state);
  assertEquals(state.phase, "buzz");
  assertEquals(state.answererId, null);
  assertEquals(state.blocked, ["a"]);
  assertEquals(state.scores["a"], 0);
});

Deno.test("時間切れ: 期限前の timeout は無視する（早すぎる発火への防御）", () => {
  const state = startBuzzing(["a", "b"]);
  const result = hayaoshiModule.reduce(state, { t: "timeout", now: (state.deadline ?? T0) - 1 });
  assertEquals(result.changed, false);
  assertEquals(result.effects.length, 0);
});

// ---------------------------------------------------------------------------
// 正解が事前に漏れないこと（設計書 §2.6）— このゲームの肝
// ---------------------------------------------------------------------------

Deno.test("秘密: 正解番号を変えても、発表前の view は1バイトも変わらない", () => {
  const base = startBuzzing(["a", "b"]);
  // 出題中の問題の正解だけをずらした state を作る
  const shifted: HayaoshiState = {
    ...base,
    questions: base.questions.map((q, i) =>
      i === 0 ? { ...q, answer: (q.answer + 1) % HAYAOSHI_OPTION_COUNT } : q
    ),
  };
  for (const viewer of ["a", "b", "観戦者"]) {
    assertEquals(
      JSON.stringify(viewOf(shifted, viewer)),
      JSON.stringify(viewOf(base, viewer)),
      "view が正解番号に依存している（改造クライアントに正解が漏れる）",
    );
  }
  // ready / answer フェーズでも同じ
  const ready = start(["a", "b"]);
  const readyShifted: HayaoshiState = {
    ...ready,
    questions: ready.questions.map((q, i) =>
      i === 0 ? { ...q, answer: (q.answer + 1) % HAYAOSHI_OPTION_COUNT } : q
    ),
  };
  assertEquals(JSON.stringify(viewOf(readyShifted, "a")), JSON.stringify(viewOf(ready, "a")));
  const answering = buzz(base, "a");
  const answeringShifted: HayaoshiState = {
    ...answering,
    questions: answering.questions.map((q, i) =>
      i === 0 ? { ...q, answer: (q.answer + 1) % HAYAOSHI_OPTION_COUNT } : q
    ),
  };
  assertEquals(
    JSON.stringify(viewOf(answeringShifted, "a")),
    JSON.stringify(viewOf(answering, "a")),
  );
});

Deno.test("秘密: 発表フェーズになると正解が view に載る（テストが空振りでないことの確認）", () => {
  let state = startBuzzing(["a", "b"]);
  assertEquals(viewOf(state, "a").reveal, undefined);
  state = buzz(state, "a");
  assertEquals(viewOf(state, "a").reveal, undefined);
  state = answer(state, "a", correctOf(state));
  assertEquals(state.phase, "reveal");
  const reveal = viewOf(state, "a").reveal;
  assertExists(reveal, "正解発表が view に載っていない");
  assertEquals(reveal.correct, correctOf(state));
  assertEquals(reveal.correctText, state.questions[0].options[reveal.correct]);
  // 発表の中身をずらすと view も変わる（view が本当に正解を運んでいる証拠。
  // 上の「発表前は変わらない」テストが空振りでないことの裏返し）
  const shifted: HayaoshiState = {
    ...state,
    lastReveal: state.lastReveal === null ? null : {
      ...state.lastReveal,
      correct: (state.lastReveal.correct + 1) % HAYAOSHI_OPTION_COUNT,
    },
  };
  assertNotEquals(JSON.stringify(viewOf(shifted, "a")), JSON.stringify(viewOf(state, "a")));
});

Deno.test("秘密: まだ出していない問題は view に載らない", () => {
  const state = startBuzzing(["a", "b"]);
  const json = JSON.stringify(viewOf(state, "a"));
  assertEquals(json.includes(state.questions[0].text), true);
  for (let i = 1; i < state.questions.length; i++) {
    assert(!json.includes(state.questions[i].text), "未出題の問題が view に混ざっている");
    for (const option of state.questions[i].options) {
      // 選択肢の文言がたまたま他の問と一致することはこの問題バンクでは無い
      assert(!json.includes(option), `未出題の選択肢が view に混ざっている: ${option}`);
    }
  }
});

Deno.test("秘密: 最終結果には問題も正解も残らない", () => {
  let state = startBuzzing(["a", "b"]);
  state = buzz(state, "a");
  state = answer(state, "a", correctOf(state));
  const ended = hayaoshiModule.reduce(state, { t: "endGame", now: T0 });
  const view = viewOf(ended.state, "a");
  assertEquals(view.phase, "final");
  assertEquals(view.question, null);
  assertEquals(view.reveal, undefined);
});

// ---------------------------------------------------------------------------
// 不正 payload の棄却（設計書 §9.1）
// ---------------------------------------------------------------------------

Deno.test("不正 payload: 範囲外・小数・文字列・形なしはすべて INVALID_INPUT", () => {
  const state = startBuzzing(["a", "b"]);
  const rejected: unknown[] = [
    { k: "answer", choice: -1 },
    { k: "answer", choice: 4 },
    { k: "answer", choice: 1.5 },
    { k: "answer", choice: "1" },
    { k: "answer", choice: Number.NaN },
    { k: "answer" },
    { k: "press" },
    { k: 1 },
    { choice: 0 },
    "buzz",
    42,
    null,
    [1, 2, 3],
  ];
  for (const payload of rejected) {
    const result = tryEvent(state, "a", payload, T0);
    assertEquals(result.error, "INVALID_INPUT", `棄却されなかった: ${JSON.stringify(payload)}`);
    assertEquals(result.changed, false);
    assertEquals(result.effects.length, 0);
    assertEquals(result.state, state);
  }
});

Deno.test("不正 payload: 回答権が無い人の回答・フェーズ違いの回答は PHASE_MISMATCH", () => {
  let state = startBuzzing(["a", "b"]);
  // 早押し前の回答
  assertEquals(tryEvent(state, "a", { k: "answer", choice: 0 }, T0).error, "PHASE_MISMATCH");
  state = buzz(state, "a");
  // 回答権を持たない人の回答
  assertEquals(tryEvent(state, "b", { k: "answer", choice: 0 }, T0).error, "PHASE_MISMATCH");
  // 期限を過ぎた回答
  const late = tryEvent(state, "a", { k: "answer", choice: 0 }, (state.deadline ?? T0) + 1);
  assertEquals(late.error, "PHASE_MISMATCH");
  // 期限を過ぎた早押し
  const buzzing = startBuzzing(["a", "b"]);
  const lateBuzz = tryEvent(buzzing, "a", { k: "buzz" }, (buzzing.deadline ?? T0) + 1);
  assertEquals(lateBuzz.error, "PHASE_MISMATCH");
});

// ---------------------------------------------------------------------------
// 途中参加・切断・再接続・キック・人数不足（設計書 §5）
// ---------------------------------------------------------------------------

Deno.test("途中参加は観戦扱い。早押しも回答もできない", () => {
  let state = startBuzzing(["a", "b"]);
  const result = hayaoshiModule.reduce(state, {
    t: "playerJoined",
    playerId: "c",
    nickname: "nick-c",
    now: T0,
  });
  assertEquals(result.changed, false);
  state = result.state;
  assertEquals(state.order.length, 2);
  assertEquals(viewOf(state, "c").canBuzz, false);
  assertEquals(viewOf(state, "c").players.length, 2);
  assertEquals(tryEvent(state, "c", { k: "buzz" }, T0).error, "PHASE_MISMATCH");
  assertEquals(tryEvent(state, "c", { k: "answer", choice: 0 }, T0).error, "PHASE_MISMATCH");
});

Deno.test("切断: 回答権を持った人が切断したら、すぐ権利が空いて残りで再開する", () => {
  let state = startBuzzing(["a", "b", "c"]);
  state = buzz(state, "a");
  assertEquals(state.phase, "answer");
  const result = hayaoshiModule.reduce(state, { t: "playerLeft", playerId: "a", now: T0 });
  assertEquals(result.error, undefined);
  state = result.state;
  // 卓が止まらないよう、その場で早押しが再開する
  assertEquals(state.phase, "buzz");
  assertEquals(state.answererId, null);
  assertEquals(state.blocked, ["a"]);
  assertEquals(state.players["a"]?.connected, false);
  assert(hasEffect(result.effects, "schedule"));
  state = buzz(state, "b");
  assertEquals(state.answererId, "b");
});

Deno.test("切断: 回答権を持った最後の1人が切断したら正解発表へ進む", () => {
  let state = startBuzzing(["a", "b"]);
  state = buzz(state, "a");
  // b は先に切断していて押せない
  state = step(state, { t: "playerLeft", playerId: "b", now: T0 });
  assertEquals(state.phase, "answer");
  state = step(state, { t: "playerLeft", playerId: "a", now: T0 });
  assertEquals(state.phase, "reveal");
  assertEquals(state.lastReveal?.winnerId, null);
});

Deno.test("切断: 早押し受付中の切断は進行を変えない", () => {
  const state = startBuzzing(["a", "b", "c"]);
  const result = hayaoshiModule.reduce(state, { t: "playerLeft", playerId: "c", now: T0 });
  assertEquals(result.error, undefined);
  assertEquals(result.state.phase, "buzz");
  assertEquals(result.state.blocked, []);
  assertEquals(result.state.players["c"]?.connected, false);
});

Deno.test("再接続すると早押しに戻れる", () => {
  let state = startBuzzing(["a", "b"]);
  state = step(state, { t: "playerLeft", playerId: "b", now: T0 });
  state = step(state, { t: "playerRejoined", playerId: "b", now: T0 });
  assertEquals(state.players["b"]?.connected, true);
  assertEquals(viewOf(state, "b").canBuzz, true);
  state = buzz(state, "b");
  assertEquals(state.answererId, "b");
});

Deno.test("キック: 在籍・得点・正解発表から消え、回答権を持っていたら再開する", () => {
  let state = startBuzzing(["a", "b", "c"]);
  state = buzz(state, "c");
  const result = hayaoshiModule.reduce(state, { t: "playerKicked", playerId: "c", now: T0 });
  assertEquals(result.error, undefined);
  state = result.state;
  assertEquals(state.order, ["a", "b"]);
  assertEquals(state.players["c"], undefined);
  assertEquals(state.scores["c"], undefined);
  assertEquals(state.phase, "buzz");
  assertEquals(state.answererId, null);
  assertEquals(viewOf(state, "a").players.length, 2);
});

Deno.test("キック: 在籍が minPlayers を割ったら tooFewPlayers で終わる", () => {
  const state = startBuzzing(["a", "b"]);
  const result = hayaoshiModule.reduce(state, { t: "playerKicked", playerId: "b", now: T0 });
  assertEquals(result.state.running, false);
  const ended = result.effects.find((e) => e.t === "ended");
  assertEquals(ended?.t === "ended" ? ended.reason : null, "tooFewPlayers");
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : "なし", null);
  assertEquals(result.effects.filter((e) => e.t === "score").length, 1);
});

Deno.test("キック: 正解者がキックされたら発表から名前が消える", () => {
  let state = startBuzzing(["a", "b", "c"]);
  state = buzz(state, "a");
  state = answer(state, "a", correctOf(state));
  assertEquals(state.lastReveal?.winnerId, "a");
  state = step(state, { t: "playerKicked", playerId: "a", now: T0 });
  assertEquals(state.lastReveal?.winnerId, null);
  assertEquals(state.lastReveal?.winnerNickname, null);
});

// ---------------------------------------------------------------------------
// ホスト操作（skipPhase / endGame）
// ---------------------------------------------------------------------------

Deno.test("skipPhase: 読み時間を飛ばして早押し受付にできる", () => {
  const state = start(["a", "b"]);
  const skipped = step(state, { t: "skipPhase", now: T0 });
  assertEquals(skipped.phase, "buzz");
  assertNotEquals(skipped.deadline, state.deadline);
});

Deno.test("skipPhase: 早押し受付を打ち切ると正解発表へ、発表を打ち切ると次の問へ", () => {
  let state = startBuzzing(["a", "b"]);
  state = step(state, { t: "skipPhase", now: T0 });
  assertEquals(state.phase, "reveal");
  state = step(state, { t: "skipPhase", now: T0 });
  assertEquals(state.phase, "ready");
  assertEquals(state.questionNo, 2);
});

Deno.test("skipPhase: 回答中を打ち切ると回答権が空く。最終結果を打ち切ると終了する", () => {
  let state = startBuzzing(["a", "b"]);
  state = buzz(state, "a");
  state = step(state, { t: "skipPhase", now: T0 });
  assertEquals(state.phase, "buzz");
  assertEquals(state.blocked, ["a"]);

  // 最後の問題の発表を飛ばすと最終結果、そこも飛ばすと終了
  let last = start(["a", "b"]);
  for (let no = 1; no <= 5; no++) {
    last = step(last, { t: "skipPhase", now: T0 }); // ready → buzz
    last = step(last, { t: "skipPhase", now: T0 }); // buzz → reveal
    if (no < 5) last = step(last, { t: "skipPhase", now: T0 }); // reveal → 次の問
  }
  last = step(last, { t: "skipPhase", now: T0 }); // reveal → final
  assertEquals(last.phase, "final");
  const result = hayaoshiModule.reduce(last, { t: "skipPhase", now: T0 });
  assertEquals(result.state.running, false);
  assert(hasEffect(result.effects, "ended"));
});

Deno.test("endGame: 即座に終了し、そこまでの正解数を score にする", () => {
  let state = startBuzzing(["a", "b"]);
  state = buzz(state, "a");
  state = answer(state, "a", correctOf(state));
  const result = hayaoshiModule.reduce(state, { t: "endGame", now: T0 });
  assertEquals(result.state.running, false);
  const ended = result.effects.find((e) => e.t === "ended");
  assertEquals(ended?.t === "ended" ? ended.reason : null, "hostEnded");
  const score = result.effects.find((e) => e.t === "score");
  assert(score !== undefined && score.t === "score");
  assertEquals(score.totals.find((row) => row.playerId === "a")?.totalScore, 1);
});

// ---------------------------------------------------------------------------
// 純粋性（設計書 §3.2 規約2）
// ---------------------------------------------------------------------------

Deno.test("reduce / view は純粋。同じ入力なら同じ出力で、入力 state を変更しない", () => {
  const state = startBuzzing(["a", "b", "c"]);
  const snapshot = JSON.stringify(state);

  const first = hayaoshiModule.reduce(state, {
    t: "clientEvent",
    playerId: "a",
    payload: { k: "buzz" },
    now: T0,
  });
  const second = hayaoshiModule.reduce(state, {
    t: "clientEvent",
    playerId: "a",
    payload: { k: "buzz" },
    now: T0,
  });
  assertEquals(JSON.stringify(first.state), JSON.stringify(second.state));
  assertEquals(JSON.stringify(first.effects), JSON.stringify(second.effects));
  assertEquals(JSON.stringify(state), snapshot);
  // 返ってきた state は入力とは別物（浅い複製ではなく中身も分かれている）
  assert(first.state !== state, "入力 state をそのまま返している");
  assert(first.state.players !== state.players, "players を共有している");
  assert(first.state.questions !== state.questions, "questions を共有している");

  // 誤答で state を大きく動かしても、入力 state は無傷
  const answered = hayaoshiModule.reduce(first.state, {
    t: "clientEvent",
    playerId: "a",
    payload: { k: "answer", choice: wrongOf(first.state) },
    now: T0,
  });
  assertEquals(answered.state.blocked, ["a"]);
  assertEquals(first.state.blocked, []);
  assertEquals(JSON.stringify(state), snapshot);

  assertEquals(
    JSON.stringify(hayaoshiModule.view(state, "a")),
    JSON.stringify(hayaoshiModule.view(state, "a")),
  );
});

Deno.test("view は受信者ごとに変わる（回答権・回答不可が入れ替わる）", () => {
  let state = startBuzzing(["a", "b"]);
  state = buzz(state, "a");
  assertEquals(viewOf(state, "a").iAmAnswerer, true);
  assertEquals(viewOf(state, "b").iAmAnswerer, false);
  assertNotEquals(JSON.stringify(viewOf(state, "a")), JSON.stringify(viewOf(state, "b")));
});

// ---------------------------------------------------------------------------
// 問題バンクの健全性（gamedef_test.ts の偏り検出と同じ考え方）
// ---------------------------------------------------------------------------

Deno.test("問題バンク: 25問以上あり、選択肢は4つで重複が無い", () => {
  assert(
    HAYAOSHI_QUESTIONS.length >= 25,
    `問題が少なすぎる: ${HAYAOSHI_QUESTIONS.length}問`,
  );
  const texts = new Set<string>();
  for (const q of HAYAOSHI_QUESTIONS) {
    assert(q.text.length > 0, "問題文が空");
    assert(!texts.has(q.text), `問題文が重複している: ${q.text}`);
    texts.add(q.text);
    assertEquals(q.options.length, HAYAOSHI_OPTION_COUNT, `選択肢が4つでない: ${q.text}`);
    assertEquals(
      new Set(q.options).size,
      HAYAOSHI_OPTION_COUNT,
      `選択肢が重複している: ${q.text}`,
    );
    for (const option of q.options) assert(option.length > 0, `空の選択肢がある: ${q.text}`);
    assert(
      Number.isInteger(q.answer) && q.answer >= 0 && q.answer < HAYAOSHI_OPTION_COUNT,
      `正解番号が範囲外: ${q.text}`,
    );
  }
});

Deno.test("問題バンク: 正解位置が特定の選択肢に偏っていない", () => {
  // 均等（1/4）から ±10 パーセントポイントまでの偏りは許容する。
  // 「1番目を選べば当たる」状態を防ぐための検査（gamedef_test.ts と同じ考え方）
  const TOLERANCE = 0.1;
  const counts = new Array(HAYAOSHI_OPTION_COUNT).fill(0);
  for (const q of HAYAOSHI_QUESTIONS) counts[q.answer]++;
  const expected = 1 / HAYAOSHI_OPTION_COUNT;
  counts.forEach((count, index) => {
    const ratio = count / HAYAOSHI_QUESTIONS.length;
    assert(
      Math.abs(ratio - expected) <= TOLERANCE,
      `選択肢${index + 1}が正解の割合 ${Math.round(ratio * 100)}% が許容範囲` +
        `（${Math.round(expected * 100)}%±${TOLERANCE * 100}pt）に収まっていません`,
    );
  });
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

/** 直近の gameView の中身を HayaoshiView として読む */
function lastView(link: MockLink): HayaoshiView {
  const msg = last(link, "gameView");
  assertExists(msg, "gameView が届いていない");
  assertEquals(msg.gameId, "hayaoshi");
  return msg.view as HayaoshiView;
}

/** ホストと客1人で早押しクイズを開始した卓を作る */
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
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: code, nickname: "客" });
  const joined = last(guest, "roomState");
  assertExists(joined);

  manager.handle(host, { t: "selectGame", gameId: "hayaoshi" });
  manager.handle(host, { t: "startGame" });
  return {
    clock,
    manager,
    host,
    guest,
    code,
    hostId: created.snapshot.youId,
    guestId: joined.snapshot.youId,
  };
}

Deno.test("卓: 一覧に専用モジュール型として並び、selectGame → startGame で始まる", () => {
  const room = playingRoom();
  const snapshot = last(room.host, "roomState");
  assertExists(snapshot);
  const summary = snapshot.snapshot.availableGames.find((g) => g.id === "hayaoshi");
  assertExists(summary, "早押しクイズが一覧に無い");
  assertEquals(summary.kind, "module");
  assertEquals(summary.official, true);
  assertEquals(summary.minPlayers, 2);
  assertEquals(last(room.host, "phase")?.phase, "playing");
  assertEquals(lastView(room.host).phase, "ready");
  // 読み時間（3秒）の期限が秒読みとして届く
  assertEquals(last(room.host, "gameView")?.deadline, T0 + 3_000);
  room.manager.dispose();
});

Deno.test("卓: gameEvent で早押しでき、正解は発表まで配信されない", () => {
  const room = playingRoom();
  // 読み時間の間は押せない
  room.manager.handle(room.host, { t: "gameEvent", payload: { k: "buzz" } });
  assertEquals(last(room.host, "error")?.code, "PHASE_MISMATCH");

  room.clock.advance(3_000); // ready → buzz
  assertEquals(lastView(room.host).phase, "buzz");
  assertEquals(lastView(room.host).reveal, undefined);
  assertEquals(lastView(room.guest).reveal, undefined);

  room.manager.handle(room.host, { t: "gameEvent", payload: { k: "buzz" } });
  assertEquals(lastView(room.host).phase, "answer");
  assertEquals(lastView(room.host).iAmAnswerer, true);
  assertEquals(lastView(room.guest).iAmAnswerer, false);
  // まだ正解は誰にも届いていない
  assertEquals(lastView(room.guest).reveal, undefined);
  // 遅れて押した客は弾かれる
  room.manager.handle(room.guest, { t: "gameEvent", payload: { k: "buzz" } });
  assertEquals(last(room.guest, "error")?.code, "PHASE_MISMATCH");
  // 不正な payload も本人にだけ返る
  room.manager.handle(room.host, { t: "gameEvent", payload: { k: "answer", choice: 9 } });
  assertEquals(last(room.host, "error")?.code, "INVALID_INPUT");
  room.manager.dispose();
});

Deno.test("卓: 期限に達すると schedule で自動的に進み、正解発表が全員に届く", () => {
  const room = playingRoom();
  room.clock.advance(3_000); // ready → buzz
  room.clock.advance(12_000); // 誰も押さず時間切れ → reveal
  const view = lastView(room.guest);
  assertEquals(view.phase, "reveal");
  assertExists(view.reveal);
  assertEquals(view.reveal.winnerId, null);
  room.manager.dispose();
});

Deno.test("卓: 再接続・途中参加は RoomSnapshot.game で復元できる", () => {
  const room = playingRoom();
  room.clock.advance(3_000);
  room.manager.handle(room.host, { t: "gameEvent", payload: { k: "buzz" } });
  const session = last(room.host, "roomState")?.snapshot.session;
  assertExists(session);
  room.manager.disconnect(room.host);

  const again = new MockLink();
  room.manager.handle(again, { t: "join", roomCode: room.code, nickname: "ホスト", session });
  const snapshot = last(again, "roomState")?.snapshot;
  assertExists(snapshot);
  assertEquals(snapshot.phase, "playing");
  assertExists(snapshot.game, "進行中のゲームがスナップショットに入っていない");
  assertEquals(snapshot.game.gameId, "hayaoshi");

  // 途中参加は観戦。押せないし、正解も見えない
  const late = new MockLink();
  room.manager.handle(late, { t: "join", roomCode: room.code, nickname: "遅れ客" });
  const lateSnapshot = last(late, "roomState")?.snapshot;
  assertExists(lateSnapshot);
  assertExists(lateSnapshot.game);
  const lateView = lateSnapshot.game.view as HayaoshiView;
  assertEquals(lateView.canBuzz, false);
  assertEquals(lateView.reveal, undefined);
  assertEquals(lateView.players.length, 2);
  room.manager.dispose();
});
