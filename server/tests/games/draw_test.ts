/**
 * server/games/draw.ts のユニットテスト
 * 設計書 docs/design/games-unified.md §2.7 / §8 #17 / §7 のチェックリストに対応する。
 *
 * 眼目は4つ。
 *   1. **お題が回答者に漏れないこと**（view の受信者絞り。漏れたら即破綻する）
 *   2. **描き手以外は描けないこと**と、ストローク payload の検証（範囲・点数・型・上限）
 *   3. チャットでの正解判定と、正解発言をチャットから消すこと（suppressChat）
 *   4. 異常系（出題者の切断・キック・途中参加・skipPhase・人数不足）で壊れないこと
 */

import { assert, assertEquals, assertExists, assertNotEquals } from "@std/assert";
import type { EnginePlayerInput } from "../../engine.ts";
import { type ClientLink, RoomManager } from "../../rooms.ts";
import type { S2C } from "../../types.ts";
import {
  DRAW_COORD_MAX,
  DRAW_MAX_CHUNK_POINTS,
  DRAW_MAX_POINTS,
  DRAW_TOPICS,
  drawModule,
  type DrawState,
  type DrawView,
  normalizeAnswer,
} from "../../games/draw.ts";
import type { ModuleEffect, ModuleEvent, ModuleResult } from "../../games/module.ts";

const T0 = 1_700_000_000_000;
const SEED = 20260826;

/** テスト用の参加者を作る */
function players(...ids: string[]): EnginePlayerInput[] {
  return ids.map((id) => ({ id, nickname: `nick-${id}`, connected: true }));
}

/** ゲームを開始する */
function start(ids: string[], now = T0): DrawState {
  const result = drawModule.init({ players: players(...ids), now, seed: SEED });
  assertEquals(result.error, undefined);
  return result.state;
}

/** 1件のイベントを流し、エラーが無いことを確かめて新しい state を返す */
function step(state: DrawState, event: ModuleEvent): DrawState {
  const result = drawModule.reduce(state, event);
  assertEquals(result.error, undefined, `想定外のエラー: ${result.message}`);
  return result.state;
}

/** いまの出題者 */
function drawerOf(state: DrawState): string {
  return state.turnOrder[state.turnIndex];
}

/** いま出題者ではない在籍者（回答者） */
function guessersOf(state: DrawState): string[] {
  return state.order.filter((id) => id !== drawerOf(state));
}

/** ストロークのチャンクを送る */
function drawChunk(
  state: DrawState,
  playerId: string,
  strokeId: number,
  points: number[],
  now = T0,
): ModuleResult<DrawState> {
  return drawModule.reduce(state, {
    t: "clientEvent",
    playerId,
    payload: { k: "draw", s: strokeId, c: 0, w: 1, p: points },
    now,
  });
}

/** チャット発言を流す */
function chat(state: DrawState, playerId: string, text: string, now = T0): ModuleResult<DrawState> {
  return drawModule.reduce(state, { t: "chatMessage", playerId, text, now });
}

/** 期限に達した timeout を流す */
function timeout(state: DrawState): DrawState {
  return step(state, { t: "timeout", now: state.deadline ?? T0 });
}

/** 受信者向けの view */
function viewOf(state: DrawState, viewerId: string): DrawView {
  return drawModule.view(state, viewerId);
}

/** 効果に指定の種類が含まれるか */
function hasEffect(effects: ModuleEffect[], t: ModuleEffect["t"]): boolean {
  return effects.some((e) => e.t === t);
}

// ---------------------------------------------------------------------------
// お題データ
// ---------------------------------------------------------------------------

Deno.test("お題は30語以上あり、重複せず、空でない", () => {
  assert(DRAW_TOPICS.length >= 30, `お題が少ない: ${DRAW_TOPICS.length}語`);
  const seen = new Set<string>();
  for (const topic of DRAW_TOPICS) {
    assert(topic.word.length > 0, "空のお題がある");
    const key = normalizeAnswer(topic.word);
    assert(key.length > 0, `正規化すると空になるお題: ${topic.word}`);
    assert(!seen.has(key), `重複したお題: ${topic.word}`);
    seen.add(key);
  }
});

Deno.test("正規化: カタカナ・全角半角・空白・記号の違いを吸収する", () => {
  assertEquals(normalizeAnswer("バナナ"), normalizeAnswer("ばなな"));
  assertEquals(normalizeAnswer("ﾊﾞﾅﾅ"), normalizeAnswer("ばなな"));
  assertEquals(normalizeAnswer(" ば な な "), normalizeAnswer("ばなな"));
  assertEquals(normalizeAnswer("ばなな！"), normalizeAnswer("ばなな"));
  assertEquals(normalizeAnswer("ラーメン"), normalizeAnswer("らあめん".replace("あ", "")));
  // 違うものは違うまま
  assertNotEquals(normalizeAnswer("ねこ"), normalizeAnswer("いぬ"));
});

// ---------------------------------------------------------------------------
// 正常進行
// ---------------------------------------------------------------------------

Deno.test("開始すると描画フェーズになり、出題者とお題が決まって期限が予約される", () => {
  const result = drawModule.init({ players: players("a", "b", "c"), now: T0, seed: SEED });
  assertEquals(result.error, undefined);
  const state = result.state;
  assertEquals(state.phase, "draw");
  assertEquals(state.turnIndex, 0);
  assertEquals([...state.turnOrder].sort(), ["a", "b", "c"]);
  assert(state.topic.length > 0, "お題が配られていない");
  assert(state.answers.length > 0, "正解の判定材料が無い");
  assert(hasEffect(result.effects, "viewChanged"));
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : null, state.deadline);
});

Deno.test("同じ seed なら出題順もお題も同じ（Math.random() を使っていない）", () => {
  const a = start(["a", "b", "c"]);
  const b = start(["a", "b", "c"]);
  assertEquals(a.turnOrder, b.turnOrder);
  assertEquals(a.topic, b.topic);
  // seed が違えば結果も変わりうる（少なくとも決定的に別の系列になる）
  const other = drawModule.init({ players: players("a", "b", "c"), now: T0, seed: 999 }).state;
  assertEquals(other.turnOrder.length, 3);
});

Deno.test("全員が1回ずつ描いたら最終結果になり、終了時に score を1回だけ出す", () => {
  let state = start(["a", "b"]);
  const seen: string[] = [];
  for (let turn = 0; turn < 2; turn++) {
    assertEquals(state.phase, "draw");
    const drawer = drawerOf(state);
    seen.push(drawer);
    const guesser = guessersOf(state)[0];
    state = step(state, { t: "chatMessage", playerId: guesser, text: state.topic, now: T0 });
    // 回答できる人が全員当てたので、期限を待たずに答え合わせへ進む
    assertEquals(state.phase, "reveal");
    state = timeout(state);
  }
  // 2人とも1回ずつ描いた
  assertEquals([...seen].sort(), ["a", "b"]);
  assertEquals(state.phase, "final");
  assert(state.running);

  const result = drawModule.reduce(state, { t: "timeout", now: state.deadline ?? T0 });
  assertEquals(result.state.running, false);
  assertEquals(result.effects.filter((e) => e.t === "score").length, 1);
  const score = result.effects.find((e) => e.t === "score");
  assert(score !== undefined && score.t === "score");
  // 各自「正解1回（3点）＋出題1回（正解者1人なので1点）」で 4点ずつ
  for (const row of score.totals) assertEquals(row.totalScore, 4);
  // 予約は必ず解除する
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : "なし", null);
  assert(hasEffect(result.effects, "ended"));
});

Deno.test("お題はゲーム中に重複しない（使い切るまで同じ語が出ない）", () => {
  let state = start(["a", "b", "c"]);
  const topics: string[] = [];
  for (let turn = 0; turn < 3; turn++) {
    topics.push(state.topic);
    state = step(state, { t: "skipPhase", now: T0 }); // draw を打ち切って reveal へ
    state = timeout(state); // reveal が終わって次のターンへ
  }
  assertEquals(new Set(topics).size, topics.length, `お題が重複した: ${topics.join(",")}`);
});

Deno.test("終了後に届いたイベントは無視する", () => {
  const state = start(["a", "b"]);
  const ended = drawModule.reduce(state, { t: "endGame", now: T0 }).state;
  assertEquals(ended.running, false);
  const after = drawModule.reduce(ended, { t: "timeout", now: T0 + 999_999 });
  assertEquals(after.changed, false);
  assertEquals(after.effects.length, 0);
});

// ---------------------------------------------------------------------------
// 秘密（お題）— このゲームの生命線
// ---------------------------------------------------------------------------

Deno.test("秘密: 描画中のお題は出題者の view にしか載らない", () => {
  const state = start(["a", "b", "c"]);
  const drawer = drawerOf(state);
  const topic = state.topic;

  assertEquals(viewOf(state, drawer).topic, topic);
  for (const guesser of guessersOf(state)) {
    const view = viewOf(state, guesser);
    assertEquals(view.topic, null, "回答者の view にお題が載っている");
    assertEquals(view.youAreDrawer, false);
    // 直列化した文字列にもお題が現れないこと（別フィールドからの漏洩を潰す）
    assert(!withoutIds(view).includes(topic), "回答者へ配る view にお題が混ざっている");
  }
  // 観戦者（在籍していない受信者）にも載らない
  assertEquals(viewOf(state, "spectator").topic, null);
});

Deno.test("秘密: 答え合わせでは全員にお題が見える", () => {
  let state = start(["a", "b"]);
  const topic = state.topic;
  state = step(state, { t: "skipPhase", now: T0 });
  assertEquals(state.phase, "reveal");
  for (const id of state.order) {
    assertEquals(viewOf(state, id).topic, topic);
    assertEquals(viewOf(state, id).result?.topic, topic);
  }
});

Deno.test("秘密: 次のターンに入ると前のお題と描画は消える", () => {
  let state = start(["a", "b"]);
  const firstTopic = state.topic;
  state = drawChunk(state, drawerOf(state), 0, [10, 10, 20, 20]).state;
  assert(state.strokes.length > 0);
  state = step(state, { t: "skipPhase", now: T0 });
  state = timeout(state);
  assertEquals(state.phase, "draw");
  assertEquals(state.strokes.length, 0);
  assertEquals(state.pointCount, 0);
  assertEquals(state.correct.length, 0);
  assertNotEquals(state.topic, firstTopic);
});

// ---------------------------------------------------------------------------
// ヒント（お題の文字数）
// ---------------------------------------------------------------------------

/**
 * お題を指定の語に差し替えた state を作る。抽選は seed 任せなので、
 * 特定のお題（長音符を含む語など）を狙って検証するために使う。
 * 正解の判定材料（answers）も本体と同じ作り方で揃える
 */
function withTopic(state: DrawState, word: string): DrawState {
  const topic = DRAW_TOPICS.find((t) => t.word === word);
  assertExists(topic, `お題一覧に無い語: ${word}`);
  const answers = [topic.word, ...(topic.alts ?? [])]
    .map(normalizeAnswer)
    .filter((f) => f.length > 0);
  return { ...state, topic: topic.word, answers };
}

Deno.test("ヒント: topicLength は長音符を落とさず、見たままの文字数になる", () => {
  const base = start(["a", "b", "c"]);
  // [お題, 期待する文字数]。照合用の正規化を通すと「けき」「らめん」のように縮む語が眼目
  const cases: Array<[string, number]> = [
    ["ケーキ", 3],
    ["ラーメン", 4],
    ["アイスクリーム", 7],
    // 長音符も記号も含まない語は従来どおりの値のまま
    ["ふじさん", 4],
    ["おにぎり", 4],
    ["ねこ", 2],
  ];
  for (const [word, expected] of cases) {
    const state = withTopic(base, word);
    assertEquals(viewOf(state, drawerOf(state)).topicLength, expected, `出題者の view: ${word}`);
    for (const guesser of guessersOf(state)) {
      assertEquals(viewOf(state, guesser).topicLength, expected, `回答者の view: ${word}`);
    }
  }
});

Deno.test("ヒント: 出題者に見えるお題の文字数と topicLength が全お題で一致する", () => {
  const base = start(["a", "b", "c"]);
  for (const entry of DRAW_TOPICS) {
    const state = withTopic(base, entry.word);
    const drawerView = viewOf(state, drawerOf(state));
    assertExists(drawerView.topic, `出題者にお題が載っていない: ${entry.word}`);
    // コードポイントで数える（サロゲートペアのお題が増えても壊れないように）
    assertEquals(drawerView.topicLength, [...drawerView.topic].length, `お題: ${entry.word}`);
    for (const guesser of guessersOf(state)) {
      const guesserView = viewOf(state, guesser);
      // 回答者にお題そのものは載らないが、ヒントの数は出題者と同じでなければならない
      assertEquals(guesserView.topic, null);
      assertEquals(guesserView.topicLength, drawerView.topicLength, `お題: ${entry.word}`);
    }
  }
});

Deno.test("ヒント: topicLength は draw / reveal / final で食い違わない", () => {
  let state = withTopic(start(["a", "b"]), "ケーキ");
  assertEquals(state.phase, "draw");
  for (const id of state.order) {
    assertEquals(viewOf(state, id).topicLength, 3, `draw 中: ${id}`);
  }

  state = step(state, { t: "skipPhase", now: T0 });
  assertEquals(state.phase, "reveal");
  for (const id of state.order) {
    const view = viewOf(state, id);
    assertEquals(view.topicLength, 3, `reveal 中: ${id}`);
    // reveal ではお題そのものが見えるので、見えている文字数と一致すること
    assertExists(view.topic);
    assertEquals(view.topicLength, [...view.topic].length);
  }

  // 最終結果まで進める（お題は次ターンの語に変わるが、ずれてはいけない）
  for (let guard = 0; guard < 20 && state.phase !== "final"; guard++) {
    state = state.phase === "draw" ? step(state, { t: "skipPhase", now: T0 }) : timeout(state);
  }
  assertEquals(state.phase, "final");
  for (const id of state.order) {
    const view = viewOf(state, id);
    assertExists(view.topic, `final でお題が見えない: ${id}`);
    assertEquals(view.topicLength, [...view.topic].length, `final: ${id}`);
  }
});

Deno.test("ヒント: 文字数の修正で正解判定は変わらない（ラーメン の表記ゆれ）", () => {
  for (const answer of ["らめん", "ラーメン", "らーめん", "ラーメン！", " ら ー め ん "]) {
    const state = withTopic(start(["a", "b", "c"]), "ラーメン");
    const guesser = guessersOf(state)[0];
    const result = chat(state, guesser, answer);
    assertEquals(result.state.correct.length, 1, `正解として受理されなかった: ${answer}`);
    assert(hasEffect(result.effects, "suppressChat"), `正解がチャットから消えない: ${answer}`);
  }
});

// ---------------------------------------------------------------------------
// 描画中継（§2.7）
// ---------------------------------------------------------------------------

Deno.test("描画: 出題者のチャンクは履歴に積まれ、同じIDへの追記で1本に繋がる", () => {
  let state = start(["a", "b"]);
  const drawer = drawerOf(state);
  state = drawChunk(state, drawer, 0, [0, 0, 10, 10]).state;
  assertEquals(state.strokes.length, 1);
  assertEquals(state.pointCount, 2);
  // 同じストロークIDへの追記（間引きに掛からないよう時刻を進める）
  state = drawChunk(state, drawer, 0, [20, 20], T0 + 500).state;
  assertEquals(state.strokes.length, 1);
  assertEquals(state.strokes[0].points, [0, 0, 10, 10, 20, 20]);
  assertEquals(state.pointCount, 3);
  // 新しいIDなら別のストローク
  state = drawChunk(state, drawer, 1, [30, 30], T0 + 1_000).state;
  assertEquals(state.strokes.length, 2);
});

Deno.test("描画: 描き手以外は描けない（undo / clear も含む）", () => {
  const state = start(["a", "b", "c"]);
  const other = guessersOf(state)[0];
  for (
    const payload of [
      { k: "draw", s: 0, c: 0, w: 0, p: [1, 1] },
      { k: "undo" },
      { k: "clear" },
      { k: "end" },
    ]
  ) {
    const result = drawModule.reduce(state, {
      t: "clientEvent",
      playerId: other,
      payload,
      now: T0,
    });
    assertEquals(result.error, "PHASE_MISMATCH", `${JSON.stringify(payload)} が通ってしまった`);
    assertEquals(result.state.strokes.length, 0);
  }
});

Deno.test("描画: 不正なストローク payload はすべて INVALID_INPUT で棄却する", () => {
  const state = start(["a", "b"]);
  const drawer = drawerOf(state);
  const bad: unknown[] = [
    // 形が違う
    null,
    "draw",
    { k: "unknown" },
    { s: 0, c: 0, w: 0, p: [1, 1] }, // k が無い
    // 座標の範囲外
    { k: "draw", s: 0, c: 0, w: 0, p: [-1, 0] },
    { k: "draw", s: 0, c: 0, w: 0, p: [0, DRAW_COORD_MAX + 1] },
    // 座標の型違い
    { k: "draw", s: 0, c: 0, w: 0, p: [1.5, 2] },
    { k: "draw", s: 0, c: 0, w: 0, p: ["1", "2"] },
    { k: "draw", s: 0, c: 0, w: 0, p: [1, 2, Number.NaN, 4] },
    // 点列の形
    { k: "draw", s: 0, c: 0, w: 0, p: [] },
    { k: "draw", s: 0, c: 0, w: 0, p: [1, 2, 3] }, // 奇数
    { k: "draw", s: 0, c: 0, w: 0, p: "1,2" },
    // 1チャンクの点数超過
    {
      k: "draw",
      s: 0,
      c: 0,
      w: 0,
      p: new Array((DRAW_MAX_CHUNK_POINTS + 1) * 2).fill(1),
    },
    // 色・太さ・ストロークID の範囲外
    { k: "draw", s: 0, c: 99, w: 0, p: [1, 1] },
    { k: "draw", s: 0, c: 0, w: 99, p: [1, 1] },
    { k: "draw", s: -1, c: 0, w: 0, p: [1, 1] },
    { k: "draw", s: 1.5, c: 0, w: 0, p: [1, 1] },
  ];
  for (const payload of bad) {
    const result = drawModule.reduce(state, {
      t: "clientEvent",
      playerId: drawer,
      payload,
      now: T0,
    });
    assertEquals(
      result.error,
      "INVALID_INPUT",
      `棄却されなかった payload: ${JSON.stringify(payload)}`,
    );
    assertEquals(result.state.strokes.length, 0);
  }
});

Deno.test("描画: 過去のストロークIDへ戻る payload は棄却する（履歴の書き換え防止）", () => {
  let state = start(["a", "b"]);
  const drawer = drawerOf(state);
  state = drawChunk(state, drawer, 5, [1, 1], T0).state;
  const result = drawChunk(state, drawer, 3, [2, 2], T0 + 500);
  assertEquals(result.error, "INVALID_INPUT");
  assertEquals(result.state.strokes.length, 1);
});

Deno.test("描画: 履歴の点数上限を超えるチャンクは受理しない", () => {
  let state = start(["a", "b"]);
  const drawer = drawerOf(state);
  // 上限ぴったりまで積む（1チャンク64点ずつ）
  let strokeId = 0;
  let now = T0;
  while (state.pointCount + DRAW_MAX_CHUNK_POINTS <= DRAW_MAX_POINTS) {
    const points = new Array(DRAW_MAX_CHUNK_POINTS * 2).fill(1);
    const result = drawChunk(state, drawer, strokeId, points, now);
    assertEquals(result.error, undefined);
    state = result.state;
    strokeId += 1;
    now += 200;
  }
  const remaining = DRAW_MAX_POINTS - state.pointCount;
  assert(remaining < DRAW_MAX_CHUNK_POINTS);
  // 残り枠を超える分は拒否される（間引きではなく拒否。state は変わらない）
  const over = drawChunk(state, drawer, strokeId, new Array((remaining + 1) * 2).fill(2), now);
  assertEquals(over.error, "INVALID_INPUT");
  assertEquals(over.state.pointCount, state.pointCount);
  // ぴったりなら通る
  const fit = drawChunk(state, drawer, strokeId, new Array(remaining * 2).fill(2), now);
  assertEquals(fit.error, undefined);
  assertEquals(fit.state.pointCount, DRAW_MAX_POINTS);
  // これ以上は1点も足せない
  const more = drawChunk(fit.state, drawer, strokeId + 1, [3, 3], now + 200);
  assertEquals(more.error, "INVALID_INPUT");
});

Deno.test("描画: undo は直近の1本を、clear は全部を消し、点数も戻る", () => {
  let state = start(["a", "b"]);
  const drawer = drawerOf(state);
  state = drawChunk(state, drawer, 0, [1, 1, 2, 2], T0).state;
  state = drawChunk(state, drawer, 1, [3, 3], T0 + 500).state;
  assertEquals(state.pointCount, 3);
  state = step(state, {
    t: "clientEvent",
    playerId: drawer,
    payload: { k: "undo" },
    now: T0 + 600,
  });
  assertEquals(state.strokes.length, 1);
  assertEquals(state.pointCount, 2);
  state = step(state, {
    t: "clientEvent",
    playerId: drawer,
    payload: { k: "clear" },
    now: T0 + 700,
  });
  assertEquals(state.strokes.length, 0);
  assertEquals(state.pointCount, 0);
});

Deno.test("描画: 配信は間引くが、点は取りこぼさず end で必ず配信される", () => {
  let state = start(["a", "b"]);
  const drawer = drawerOf(state);
  const first = drawChunk(state, drawer, 0, [1, 1], T0);
  assert(hasEffect(first.effects, "viewChanged"), "最初のチャンクは配信される");
  state = first.state;
  // すぐ次のチャンク（間引きの窓の中）は state に積まれるが配信されない
  const quiet = drawChunk(state, drawer, 0, [2, 2], T0 + 10);
  assertEquals(quiet.changed, false, "間引きの窓で配信してしまっている");
  assertEquals(quiet.state.pointCount, 2, "間引いた分の点が失われている");
  state = quiet.state;
  // end で必ず配信する（描き終わりが欠けたまま止まらない）
  const flushed = drawModule.reduce(state, {
    t: "clientEvent",
    playerId: drawer,
    payload: { k: "end" },
    now: T0 + 20,
  });
  assert(hasEffect(flushed.effects, "viewChanged"), "end で配信されていない");
  assertEquals(flushed.state.pointCount, 2);
});

Deno.test("描画: 描画中はお題以外のフェーズでは描けない", () => {
  let state = start(["a", "b"]);
  const drawer = drawerOf(state);
  state = step(state, { t: "skipPhase", now: T0 });
  assertEquals(state.phase, "reveal");
  const result = drawChunk(state, drawer, 0, [1, 1], T0);
  assertEquals(result.error, "PHASE_MISMATCH");
});

// ---------------------------------------------------------------------------
// チャットでの回答（ユーザー決定の回答方式）
// ---------------------------------------------------------------------------

Deno.test("回答: 正解するとチャットから消え、得点が入り、本人にだけ順番が返る", () => {
  const state = start(["a", "b", "c"]);
  const guesser = guessersOf(state)[0];
  const result = chat(state, guesser, state.topic);
  assert(hasEffect(result.effects, "suppressChat"), "正解の発言がチャットに出てしまう");
  const next = result.state;
  assertEquals(next.correct.length, 1);
  assertEquals(next.correct[0].playerId, guesser);
  assertEquals(next.correct[0].order, 1);
  assertEquals(next.scores[guesser], 3);
  // 本人には「何番目に正解したか」が返る（発言が消えるので、これが唯一のフィードバック）
  assertEquals(viewOf(next, guesser).myCorrectOrder, 1);
  assertEquals(viewOf(next, guesser).myTurnPoints, 3);
  // 他の人からは「誰が当てたか」は見えるが、お題は見えないまま
  const otherView = viewOf(next, guessersOf(next)[1]);
  assertEquals(otherView.myCorrectOrder, null);
  assertEquals(otherView.correct.length, 1);
  assertEquals(otherView.topic, null);
});

Deno.test("回答: ハズレの発言はチャットに出る（伏せない）", () => {
  const state = start(["a", "b", "c"]);
  const guesser = guessersOf(state)[0];
  const result = chat(state, guesser, "ぜんぜんちがうことば");
  assert(!hasEffect(result.effects, "suppressChat"), "ハズレまで伏せている");
  assertEquals(result.changed, false);
  assertEquals(result.state.correct.length, 0);
});

Deno.test("回答: 表記ゆれ（カタカナ・空白・記号）でも正解になる", () => {
  const state = start(["a", "b", "c"]);
  const guesser = guessersOf(state)[0];
  // ひらがな⇄カタカナを入れ替えても通ること
  const swapped = state.topic.replace(
    /[ぁ-ゖ]/g,
    (c) => String.fromCharCode(c.charCodeAt(0) + 0x60),
  );
  const result = chat(state, guesser, ` ${swapped}！`);
  assertEquals(result.state.correct.length, 1, `表記ゆれが通らなかった: ${swapped}`);
});

Deno.test("回答: 文の中に答えが混ざっているだけでは正解にしない（完全一致のみ）", () => {
  const state = start(["a", "b", "c"]);
  const guesser = guessersOf(state)[0];
  const result = chat(state, guesser, `もしかして${state.topic}かな？`);
  assertEquals(result.state.correct.length, 0);
  assert(!hasEffect(result.effects, "suppressChat"));
});

Deno.test("回答: 早い順に 3 / 2 / 1 点。2回目以降の正解は数えない", () => {
  let state = start(["a", "b", "c", "d"]);
  const [g1, g2, g3] = guessersOf(state);
  state = chat(state, g1, state.topic).state;
  state = chat(state, g2, state.topic).state;
  assertEquals(state.scores[g1], 3);
  assertEquals(state.scores[g2], 2);
  // 同じ人がもう一度当てても増えない
  const again = chat(state, g1, state.topic);
  assertEquals(again.changed, false);
  assertEquals(again.state.scores[g1], 3);
  // 3人目が当てると全員正解なので答え合わせへ進む
  const last = chat(state, g3, state.topic);
  assertEquals(last.state.phase, "reveal");
  assertEquals(last.state.scores[g3], 1);
  assert(hasEffect(last.effects, "suppressChat"), "最後の正解も伏せる");
  // 出題者には正解者3人ぶん（上限3点）が入る
  assertEquals(last.state.scores[drawerOf(state)], 3);
});

Deno.test("回答: 出題者がお題を書いたらその発言を伏せる（得点は動かない）", () => {
  const state = start(["a", "b", "c"]);
  const drawer = drawerOf(state);
  const leak = chat(state, drawer, `こたえは${state.topic}だよ`);
  assert(hasEffect(leak.effects, "suppressChat"), "出題者のお題漏らしが卓に出てしまう");
  assertEquals(leak.state.correct.length, 0);
  // お題を含まない発言はそのまま流す
  const safe = chat(state, drawer, "むずかしいなあ");
  assert(!hasEffect(safe.effects, "suppressChat"));
});

Deno.test("回答: 観戦者（途中参加）は正解者にならない", () => {
  let state = start(["a", "b"]);
  state = step(state, { t: "playerJoined", playerId: "z", nickname: "遅れ客", now: T0 });
  const result = chat(state, "z", state.topic);
  assertEquals(result.state.correct.length, 0);
  assert(!hasEffect(result.effects, "suppressChat"));
});

Deno.test("回答: 描画フェーズ以外の発言は判定しない", () => {
  let state = start(["a", "b", "c"]);
  const topic = state.topic;
  state = step(state, { t: "skipPhase", now: T0 });
  assertEquals(state.phase, "reveal");
  const result = chat(state, guessersOf(state)[0], topic);
  assertEquals(result.changed, false);
  assert(!hasEffect(result.effects, "suppressChat"));
});

// ---------------------------------------------------------------------------
// 異常系
// ---------------------------------------------------------------------------

Deno.test("出題者が切断したらそのターンを打ち切り、次の人へ回す", () => {
  let state = start(["a", "b", "c"]);
  const drawer = drawerOf(state);
  state = drawChunk(state, drawer, 0, [1, 1], T0).state;
  const result = drawModule.reduce(state, { t: "playerLeft", playerId: drawer, now: T0 + 1_000 });
  assertEquals(result.state.phase, "reveal");
  assertEquals(result.state.lastResult?.aborted, "drawerLeft");
  assertEquals(result.state.lastResult?.drawerId, drawer);
  // 打ち切りなので出題者に点は入らない
  assertEquals(result.state.lastResult?.drawerPoints, 0);
  assertEquals(result.state.scores[drawer], 0);
  assert(hasEffect(result.effects, "schedule"));
  // 次のターンでは切断した人を飛ばして、別の人が出題者になる
  const next = timeout(result.state);
  assertEquals(next.phase, "draw");
  assertNotEquals(drawerOf(next), drawer);
  assert(next.players[drawerOf(next)].connected);
});

Deno.test("回答者が切断しても卓は止まらない（残り全員が当てれば進む）", () => {
  let state = start(["a", "b", "c"]);
  const [g1, g2] = guessersOf(state);
  state = step(state, { t: "playerLeft", playerId: g2, now: T0 });
  assertEquals(state.phase, "draw");
  // 接続している回答者が全員当てたので進む
  const result = chat(state, g1, state.topic);
  assertEquals(result.state.phase, "reveal");
});

Deno.test("出題者がキックされたらターンを打ち切り、名前も結果に残る", () => {
  const state = start(["a", "b", "c"]);
  const drawer = drawerOf(state);
  const drawerName = state.players[drawer].nickname;
  const result = drawModule.reduce(state, { t: "playerKicked", playerId: drawer, now: T0 });
  assertEquals(result.state.phase, "reveal");
  assertEquals(result.state.lastResult?.aborted, "drawerKicked");
  assertEquals(result.state.lastResult?.drawerName, drawerName);
  // 在籍からは消えている
  assertEquals(result.state.players[drawer], undefined);
  assert(!result.state.order.includes(drawer));
  // view でも名前が引ける（players から消えていても結果側に残している）
  assertEquals(viewOf(result.state, "a").drawerName, drawerName);
  // 次のターンでは飛ばされる
  const next = timeout(result.state);
  assertNotEquals(drawerOf(next), drawer);
});

Deno.test("キックされた人は正解者一覧と得点表から消える", () => {
  let state = start(["a", "b", "c"]);
  const [g1, g2] = guessersOf(state);
  state = chat(state, g1, state.topic).state;
  state = chat(state, g2, state.topic).state;
  assertEquals(state.correct.length, 2);
  state = step(state, { t: "playerKicked", playerId: g1, now: T0 });
  assertEquals(state.correct.length, 1);
  assertEquals(state.correct[0].playerId, g2);
  // 順番は振り直される
  assertEquals(state.correct[0].order, 1);
  assertEquals(state.scores[g1], undefined);
  assert(!viewOf(state, "a").standings.some((row) => row.playerId === g1));
});

Deno.test("在籍が minPlayers を割ったら tooFewPlayers で終わる", () => {
  const state = start(["a", "b"]);
  const result = drawModule.reduce(state, { t: "playerKicked", playerId: "a", now: T0 });
  assertEquals(result.state.running, false);
  const ended = result.effects.find((e) => e.t === "ended");
  assertEquals(ended?.t === "ended" ? ended.reason : "", "tooFewPlayers");
  assert(hasEffect(result.effects, "score"));
});

Deno.test("再接続すると次のターンの出題者になれる", () => {
  let state = start(["a", "b", "c"]);
  const later = state.turnOrder[1];
  state = step(state, { t: "playerLeft", playerId: later, now: T0 });
  state = step(state, { t: "playerRejoined", playerId: later, now: T0 + 100 });
  assert(state.players[later].connected);
  state = step(state, { t: "skipPhase", now: T0 + 200 });
  state = timeout(state);
  assertEquals(drawerOf(state), later);
});

Deno.test("途中参加は観戦。出題順にも入らない", () => {
  let state = start(["a", "b"]);
  state = step(state, { t: "playerJoined", playerId: "z", nickname: "遅れ客", now: T0 });
  assert(!state.turnOrder.includes("z"));
  assert(!state.order.includes("z"));
  assertEquals(state.turnOrder.length, 2);
});

Deno.test("ホストの skipPhase は現フェーズを打ち切って進める", () => {
  let state = start(["a", "b"]);
  assertEquals(state.phase, "draw");
  state = step(state, { t: "skipPhase", now: T0 });
  assertEquals(state.phase, "reveal");
  state = step(state, { t: "skipPhase", now: T0 });
  assertEquals(state.phase, "draw");
  assertEquals(state.turnIndex, 1);
});

Deno.test("ホストの endGame は即座に終了し、そこまでの得点を score にする", () => {
  let state = start(["a", "b", "c"]);
  const guesser = guessersOf(state)[0];
  state = chat(state, guesser, state.topic).state;
  const result = drawModule.reduce(state, { t: "endGame", now: T0 });
  assertEquals(result.state.running, false);
  const ended = result.effects.find((e) => e.t === "ended");
  assertEquals(ended?.t === "ended" ? ended.reason : "", "hostEnded");
  const score = result.effects.find((e) => e.t === "score");
  assert(score !== undefined && score.t === "score");
  assertEquals(score.totals.find((row) => row.playerId === guesser)?.totalScore, 3);
});

// ---------------------------------------------------------------------------
// 純粋性（設計書 §3.2 規約2）
// ---------------------------------------------------------------------------

Deno.test("reduce / view は純粋。同じ入力なら同じ出力で、入力 state を変更しない", () => {
  const state = start(["a", "b", "c"]);
  const drawer = drawerOf(state);
  const snapshot = JSON.stringify(state);

  const first = drawChunk(state, drawer, 0, [1, 2, 3, 4], T0 + 500);
  const second = drawChunk(state, drawer, 0, [1, 2, 3, 4], T0 + 500);
  assertEquals(JSON.stringify(first.state), JSON.stringify(second.state));
  assertEquals(JSON.stringify(first.effects), JSON.stringify(second.effects));
  assertEquals(JSON.stringify(state), snapshot, "入力 state が書き換えられている");
  assertNotEquals(first.state.strokes, state.strokes);

  // 追記でも元の points 配列を壊さない
  const appended = drawChunk(first.state, drawer, 0, [5, 6], T0 + 1_000);
  assertEquals(first.state.strokes[0].points, [1, 2, 3, 4]);
  assertEquals(appended.state.strokes[0].points, [1, 2, 3, 4, 5, 6]);

  assertEquals(
    JSON.stringify(drawModule.view(state, "a")),
    JSON.stringify(drawModule.view(state, "a")),
  );
});

// ---------------------------------------------------------------------------
// ルーム層との配線（設計書 §2.2 / §2.7 / §5）
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

/** 受け取ったチャット発言の本文 */
function chatTexts(link: MockLink): string[] {
  return link.received.filter((m) => m.t === "chat").map((m) =>
    (m as { message: { text: string } }).message.text
  );
}

/**
 * playerId を伏せた view を直列化する（chicken_test.ts と同じ手法）。
 * playerId（UUID）の16進の並びがお題やニックネームと偶然一致して誤検知するのを防ぐ
 */
function withoutIds(view: DrawView): string {
  return JSON.stringify(view, (key, value) => (key === "playerId" ? undefined : value));
}

/** 直近の gameView の中身を DrawView として読む */
function lastDrawView(link: MockLink): DrawView {
  const msg = last(link, "gameView");
  assertExists(msg, "gameView が届いていない");
  assertEquals(msg.gameId, "draw");
  return msg.view as DrawView;
}

/** ホストと客1人でお絵かき当てを開始した卓を作る */
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

  manager.handle(host, { t: "selectGame", gameId: "draw" });
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

/** その卓で描いている側／当てる側の接続を返す */
function roles(room: ReturnType<typeof playingRoom>) {
  const hostIsDrawer = lastDrawView(room.host).youAreDrawer;
  return {
    drawer: hostIsDrawer ? room.host : room.guest,
    guesser: hostIsDrawer ? room.guest : room.host,
  };
}

Deno.test("卓: 一覧に専用モジュール型として並び、selectGame → startGame で始まる", () => {
  const room = playingRoom();
  const snapshot = last(room.host, "roomState");
  assertExists(snapshot);
  const summary = snapshot.snapshot.availableGames.find((g) => g.id === "draw");
  assertExists(summary, "お絵かき当てが一覧に無い");
  assertEquals(summary.kind, "module");
  assertEquals(summary.official, true);
  assertEquals(last(room.host, "phase")?.phase, "playing");
  assertEquals(lastDrawView(room.host).phase, "draw");
  assertEquals(lastDrawView(room.host).totalTurns, 2);
  assertEquals(last(room.host, "gameView")?.deadline, T0 + 90_000);
  room.manager.dispose();
});

Deno.test("卓: gameEvent で描け、描き手以外の gameEvent は拒否される", () => {
  const room = playingRoom();
  const { drawer, guesser } = roles(room);
  room.manager.handle(drawer, {
    t: "gameEvent",
    payload: { k: "draw", s: 0, c: 1, w: 2, p: [10, 20, 30, 40] },
  });
  const view = lastDrawView(guesser);
  assertEquals(view.strokes.length, 1);
  assertEquals(view.strokes[0].points, [10, 20, 30, 40]);
  assertEquals(view.pointCount, 2);

  // 描き手以外は描けない。エラーは本人にだけ返る
  room.manager.handle(guesser, {
    t: "gameEvent",
    payload: { k: "draw", s: 1, c: 0, w: 0, p: [1, 1] },
  });
  assertEquals(last(guesser, "error")?.code, "PHASE_MISMATCH");
  assertEquals(lastDrawView(drawer).strokes.length, 1);
  room.manager.dispose();
});

Deno.test("卓: お題は出題者にしか配信されない", () => {
  const room = playingRoom();
  const { drawer, guesser } = roles(room);
  const topic = lastDrawView(drawer).topic;
  assertExists(topic, "出題者にお題が届いていない");
  const guesserView = lastDrawView(guesser);
  assertEquals(guesserView.topic, null);
  assert(!withoutIds(guesserView).includes(topic), "回答者へお題が配信されている");
  // phase メッセージ（ゲーム外の表示）にも漏れていない
  const phase = last(guesser, "phase");
  assertExists(phase);
  assert(!JSON.stringify(phase).includes(topic), "phase にお題が混ざっている");
  room.manager.dispose();
});

Deno.test("卓: チャットで正解するとその発言は配信されず、得点だけが入る", () => {
  const room = playingRoom();
  const { drawer, guesser } = roles(room);
  const topic = lastDrawView(drawer).topic;
  assertExists(topic);

  // ハズレはチャットに出る
  room.manager.handle(guesser, { t: "chat", text: "うーん" });
  assert(chatTexts(drawer).includes("うーん"));

  // 正解は出ない
  room.manager.handle(guesser, { t: "chat", text: topic });
  assert(!chatTexts(drawer).includes(topic), "正解の発言が卓に配信されている");
  assert(!chatTexts(guesser).includes(topic), "正解の発言が本人にも配信されている");
  // 履歴にも積まれていない（途中参加者に見えてしまうため）
  const late = new MockLink();
  room.manager.handle(late, { t: "join", roomCode: room.code, nickname: "遅れ客" });
  const snapshot = last(late, "roomState")?.snapshot;
  assertExists(snapshot);
  assert(!snapshot.chat.some((m) => m.text === topic), "正解がチャット履歴に残っている");

  // 本人には view でフィードバックが返る
  assertEquals(lastDrawView(guesser).myCorrectOrder, 1);
  room.manager.dispose();
});

Deno.test("卓: 途中参加・再接続は RoomSnapshot.game の履歴から全再描画できる", () => {
  const room = playingRoom();
  const { drawer } = roles(room);
  room.manager.handle(drawer, {
    t: "gameEvent",
    payload: { k: "draw", s: 0, c: 3, w: 1, p: [5, 6, 7, 8] },
  });
  room.manager.handle(drawer, { t: "gameEvent", payload: { k: "end" } });

  // 途中参加は観戦。描画履歴は全量届き、お題は届かない
  const late = new MockLink();
  room.manager.handle(late, { t: "join", roomCode: room.code, nickname: "遅れ客" });
  const lateSnapshot = last(late, "roomState")?.snapshot;
  assertExists(lateSnapshot);
  assertExists(lateSnapshot.game);
  assertEquals(lateSnapshot.game.gameId, "draw");
  const lateView = lateSnapshot.game.view as DrawView;
  assertEquals(lateView.strokes.length, 1);
  assertEquals(lateView.strokes[0].points, [5, 6, 7, 8]);
  assertEquals(lateView.strokes[0].color, 3);
  assertEquals(lateView.topic, null);

  // 再接続でも同じ履歴が戻る
  const session = last(drawer, "roomState")?.snapshot.session;
  assertExists(session);
  const nickname = drawer === room.host ? "ホスト" : "客";
  room.manager.disconnect(drawer);
  const again = new MockLink();
  room.manager.handle(again, { t: "join", roomCode: room.code, nickname, session });
  const back = last(again, "roomState")?.snapshot;
  assertExists(back);
  assertExists(back.game);
  assertEquals((back.game.view as DrawView).strokes[0].points, [5, 6, 7, 8]);
  room.manager.dispose();
});

Deno.test("卓: 期限に達すると schedule で自動的に進み、最後は lobby へ戻って公式スコアに入る", () => {
  const room = playingRoom();
  room.clock.advance(90_000); // 1ターン目の描画時間
  assertEquals(lastDrawView(room.host).phase, "reveal");
  room.clock.advance(8_000); // 答え合わせ → 2ターン目
  assertEquals(lastDrawView(room.host).phase, "draw");
  assertEquals(lastDrawView(room.host).turn, 2);
  room.clock.advance(90_000 + 8_000); // 2ターン目 → 答え合わせ → 最終結果
  assertEquals(lastDrawView(room.host).phase, "final");
  room.clock.advance(10_000); // 最終結果の表示時間 → 終了
  assertEquals(last(room.host, "phase")?.phase, "lobby");
  // 誰も当てていないので0点。score 効果自体は流れている（Player.score は増えない）
  assertEquals(room.manager.getRoom(room.code)?.players.get(room.hostId)?.score, 0);
  room.manager.dispose();
});

Deno.test("卓: 正解して加点があっても、終了後に配信される roomState に反映される（バグ回帰）", () => {
  // server/games/chicken.ts の finish() で実機確認されたバグ（viewChanged → schedule → score
  // → ended の順で効果が来ると、score が加算される前に配信されてしまい、しかも score 自体は
  // 誰にも再配信されない）は、同じ効果順序を返す draw.ts の finish() にも起こりうる。
  // 2ターンとも正解させて score を0点でなくし、実際に届いた roomState で確かめる
  const room = playingRoom();
  for (let turn = 1; turn <= 2; turn++) {
    const { drawer, guesser } = roles(room);
    const topic = lastDrawView(drawer).topic;
    assertExists(topic, "出題者にお題が届いていない");
    room.manager.handle(guesser, { t: "chat", text: topic });
    assertEquals(lastDrawView(room.host).phase, "reveal");
    room.clock.advance(8_000); // 答え合わせの表示時間
  }
  room.clock.advance(10_000); // 最終結果の表示時間 → 終了
  assertEquals(last(room.host, "phase")?.phase, "lobby");

  const internalTotal = [...(room.manager.getRoom(room.code)?.players.values() ?? [])]
    .reduce((sum, p) => sum + p.score, 0);
  assert(internalTotal > 0, "テストの前提が崩れている（誰も加点されていない）");

  const delivered = last(room.host, "roomState")?.snapshot;
  assertExists(delivered, "終了後に roomState が届いていない");
  const deliveredTotal = delivered.players.reduce((sum, p) => sum + p.score, 0);
  assertEquals(deliveredTotal, internalTotal, "配信された roomState の得点が内部状態と一致しない");
  room.manager.dispose();
});

Deno.test("卓: ゲーム外（ロビー）のチャットは今までどおり配信される", () => {
  const clock = new FakeClock();
  const manager = new RoomManager({
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const host = new MockLink();
  manager.handle(host, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  manager.handle(host, { t: "chat", text: "こんばんは" });
  assert(chatTexts(host).includes("こんばんは"));
  manager.dispose();
});
