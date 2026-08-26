/**
 * server/games/chicken.ts のユニットテスト
 * 設計書 docs/design/games-unified.md §8 #5 / §7 のチェックリストに対応する。
 *
 * 眼目は3つ。
 *   1. 勝敗判定（誰とも被らなかった最大の数字が勝ち）の境界
 *   2. **秘密が漏れないこと**（提出中の view に他人の数字が一切載らない）
 *   3. 異常系（不正 payload・途中参加・切断・再接続・キック・人数不足）で壊れないこと
 */

import { assert, assertEquals, assertExists, assertNotEquals } from "@std/assert";
import type { EnginePlayerInput } from "../../engine.ts";
import { type ClientLink, RoomManager } from "../../rooms.ts";
import type { S2C } from "../../types.ts";
import { chickenModule, type ChickenState, type ChickenView } from "../../games/chicken.ts";
import type { ModuleEffect, ModuleEvent, ModuleResult } from "../../games/module.ts";

const T0 = 1_700_000_000_000;
const SEED = 20260826;

/** テスト用の参加者を作る */
function players(...ids: string[]): EnginePlayerInput[] {
  return ids.map((id) => ({ id, nickname: `nick-${id}`, connected: true }));
}

/** ゲームを開始する */
function start(ids: string[], now = T0): ChickenState {
  const result = chickenModule.init({ players: players(...ids), now, seed: SEED });
  assertEquals(result.error, undefined);
  return result.state;
}

/** 1件のイベントを流し、エラーが無いことを確かめて新しい state を返す */
function step(state: ChickenState, event: ModuleEvent): ChickenState {
  const result = chickenModule.reduce(state, event);
  assertEquals(result.error, undefined, `想定外のエラー: ${result.message}`);
  return result.state;
}

/** 数字を提出する */
function submit(state: ChickenState, playerId: string, value: number, now = T0): ChickenState {
  return step(state, { t: "clientEvent", playerId, payload: { k: "submit", value }, now });
}

/** 提出を試み、結果をそのまま返す（エラーの検査用） */
function trySubmit(
  state: ChickenState,
  playerId: string,
  payload: unknown,
  now = T0,
): ModuleResult<ChickenState> {
  return chickenModule.reduce(state, { t: "clientEvent", playerId, payload, now });
}

/** 期限に達した timeout を流す */
function timeout(state: ChickenState): ChickenState {
  const now = state.deadline ?? T0;
  return step(state, { t: "timeout", now });
}

/** 受信者向けの view */
function viewOf(state: ChickenState, viewerId: string): ChickenView {
  return chickenModule.view(state, viewerId);
}

/** 効果に指定の種類が含まれるか */
function hasEffect(effects: ModuleEffect[], t: ModuleEffect["t"]): boolean {
  return effects.some((e) => e.t === t);
}

// ---------------------------------------------------------------------------
// 正常進行
// ---------------------------------------------------------------------------

Deno.test("開始すると提出フェーズになり、期限が予約される", () => {
  const result = chickenModule.init({ players: players("a", "b"), now: T0, seed: SEED });
  assertEquals(result.error, undefined);
  assertEquals(result.state.phase, "submit");
  assertEquals(result.state.round, 1);
  assertEquals(result.state.totalRounds, 3);
  assert(hasEffect(result.effects, "viewChanged"));
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : null, result.state.deadline);
  assert((result.state.deadline ?? 0) > T0);
});

Deno.test("全員が提出した時点で一斉公開へ進む（期限を待たない）", () => {
  let state = start(["a", "b", "c"]);
  state = submit(state, "a", 10);
  assertEquals(state.phase, "submit");
  state = submit(state, "b", 20);
  assertEquals(state.phase, "submit");
  const result = chickenModule.reduce(state, {
    t: "clientEvent",
    playerId: "c",
    payload: { k: "submit", value: 30 },
    now: T0,
  });
  assertEquals(result.state.phase, "reveal");
  assert(hasEffect(result.effects, "viewChanged"));
  assertEquals(result.state.lastResult?.winnerId, "c");
});

Deno.test("3ラウンド進めると最終結果になり、終了時に score を1回だけ出す", () => {
  let state = start(["a", "b"]);
  for (let round = 1; round <= 3; round++) {
    assertEquals(state.round, round);
    state = submit(state, "a", 50);
    state = submit(state, "b", 40);
    assertEquals(state.phase, "reveal");
    state = timeout(state); // 公開の表示時間が終わる
  }
  assertEquals(state.phase, "final");
  assert(state.running);
  // 最終結果の表示時間が終わると終了する
  const result = chickenModule.reduce(state, { t: "timeout", now: state.deadline ?? T0 });
  assertEquals(result.state.running, false);
  assertEquals(result.effects.filter((e) => e.t === "score").length, 1);
  const score = result.effects.find((e) => e.t === "score");
  assert(score !== undefined && score.t === "score");
  // a が3ラウンドとも勝っている（50 > 40 でどちらも被っていない）
  assertEquals(score.totals.find((row) => row.playerId === "a")?.totalScore, 3);
  assertEquals(score.totals.find((row) => row.playerId === "a")?.rank, 1);
  assertEquals(score.totals.find((row) => row.playerId === "b")?.totalScore, 0);
  // 予約は必ず解除する
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : "なし", null);
  assert(hasEffect(result.effects, "ended"));
});

Deno.test("終了後に届いたイベントは無視する（schedule の取りこぼしでも壊れない）", () => {
  let state = start(["a", "b"]);
  state = step(state, { t: "endGame", now: T0 });
  assertEquals(state.running, false);
  const after = chickenModule.reduce(state, { t: "timeout", now: T0 + 999_999 });
  assertEquals(after.changed, false);
  assertEquals(after.effects.length, 0);
  const submitted = trySubmit(state, "a", { k: "submit", value: 1 });
  assertEquals(submitted.changed, false);
  assertEquals(submitted.error, undefined);
});

// ---------------------------------------------------------------------------
// 勝敗判定の境界
// ---------------------------------------------------------------------------

Deno.test("勝敗: 全員バラバラなら最大の数字を出した人が勝つ", () => {
  let state = start(["a", "b", "c"]);
  state = submit(state, "a", 0);
  state = submit(state, "b", 100);
  state = submit(state, "c", 50);
  assertEquals(state.lastResult?.winnerId, "b");
  assertEquals(state.wins["b"], 1);
  // 公開結果は数字の降順に並ぶ
  assertEquals(state.lastResult?.entries.map((e) => e.value), [100, 50, 0]);
  assert(state.lastResult?.entries.every((e) => e.unique));
});

Deno.test("勝敗: 全員が同じ数字なら勝者なし", () => {
  let state = start(["a", "b", "c"]);
  state = submit(state, "a", 77);
  state = submit(state, "b", 77);
  state = submit(state, "c", 77);
  assertEquals(state.lastResult?.winnerId, null);
  assertEquals(state.wins["a"], 0);
  assert(state.lastResult?.entries.every((e) => !e.unique && !e.won));
});

Deno.test("勝敗: 被った最大値は無効になり、その下の被らなかった数字が勝つ", () => {
  let state = start(["a", "b", "c", "d"]);
  state = submit(state, "a", 90);
  state = submit(state, "b", 90);
  state = submit(state, "c", 80);
  state = submit(state, "d", 10);
  assertEquals(state.lastResult?.winnerId, "c");
  const entries = state.lastResult?.entries ?? [];
  assertEquals(entries.find((e) => e.playerId === "a")?.unique, false);
  assertEquals(entries.find((e) => e.playerId === "b")?.unique, false);
  assertEquals(entries.find((e) => e.playerId === "c")?.won, true);
});

Deno.test("勝敗: 2人でも成立する（被れば勝者なし・違えば大きいほうが勝つ）", () => {
  let tie = start(["a", "b"]);
  tie = submit(tie, "a", 5);
  tie = submit(tie, "b", 5);
  assertEquals(tie.lastResult?.winnerId, null);

  let win = start(["a", "b"]);
  win = submit(win, "a", 5);
  win = submit(win, "b", 6);
  assertEquals(win.lastResult?.winnerId, "b");
});

Deno.test("勝敗: 未提出は無効。全員未提出なら勝者なし", () => {
  let state = start(["a", "b", "c"]);
  state = submit(state, "a", 3);
  // b と c は出さないまま期限切れ
  state = timeout(state);
  assertEquals(state.phase, "reveal");
  assertEquals(state.lastResult?.winnerId, "a");
  const entries = state.lastResult?.entries ?? [];
  assertEquals(entries.find((e) => e.playerId === "b")?.value, null);
  assertEquals(entries.find((e) => e.playerId === "b")?.unique, false);

  let none = start(["a", "b"]);
  none = timeout(none);
  assertEquals(none.lastResult?.winnerId, null);
  assertEquals(none.wins["a"], 0);
  assertEquals(none.wins["b"], 0);
});

Deno.test("順位: 勝利ラウンド数の同点は同順位になる", () => {
  let state = start(["a", "b", "c"]);
  // 1ラウンド目は a、2ラウンド目は b が勝ち、c は0勝で終える
  state = submit(state, "a", 100);
  state = submit(state, "b", 1);
  state = submit(state, "c", 2);
  state = timeout(state);
  state = submit(state, "a", 1);
  state = submit(state, "b", 100);
  state = submit(state, "c", 2);
  const standings = viewOf(state, "a").standings;
  assertEquals(standings.find((row) => row.playerId === "a")?.rank, 1);
  assertEquals(standings.find((row) => row.playerId === "b")?.rank, 1);
  assertEquals(standings.find((row) => row.playerId === "c")?.rank, 3);
});

// ---------------------------------------------------------------------------
// 秘密の保持（設計書 §2.6）— このゲームの肝
// ---------------------------------------------------------------------------

Deno.test("秘密: 提出中の view には自分の数字しか載らない", () => {
  let state = start(["a", "b", "c"]);
  state = submit(state, "a", 42);
  state = submit(state, "b", 7);

  const viewA = viewOf(state, "a");
  assertEquals(viewA.phase, "submit");
  assertEquals(viewA.mySubmission, 42);
  assertEquals(viewA.submittedCount, 2);
  assertEquals(viewA.result, undefined);
  // 他人の提出状況は分かるが、数字は載らない
  assertEquals(viewA.players.find((p) => p.playerId === "b")?.submitted, true);
  assertEquals(viewA.players.find((p) => p.playerId === "c")?.submitted, false);

  // 改造クライアントが view の隅々まで漁っても、他人の数字はどこにも入っていない。
  // 直列化した文字列ごと突き合わせる（フィールドを増やしたときの取りこぼしを防ぐ）
  const json = JSON.stringify(viewA);
  assert(!json.includes("7"), `他人の数字が view に混ざっている: ${json}`);
  const viewC = viewOf(state, "c");
  assertEquals(viewC.mySubmission, null);
  const jsonC = JSON.stringify(viewC);
  assert(!jsonC.includes("42"), `他人の数字が view に混ざっている: ${jsonC}`);
  assert(!jsonC.includes("7"), `他人の数字が view に混ざっている: ${jsonC}`);
});

Deno.test("秘密: 一斉公開まで結果は view に載らない。公開後は全員に同じ結果が見える", () => {
  let state = start(["a", "b"]);
  state = submit(state, "a", 60);
  assertEquals(viewOf(state, "b").result, undefined);
  state = submit(state, "b", 61);
  assertEquals(state.phase, "reveal");
  const resultA = viewOf(state, "a").result;
  const resultB = viewOf(state, "b").result;
  assertEquals(resultA, resultB);
  assertEquals(resultA?.entries.map((e) => e.value), [61, 60]);
});

Deno.test("秘密: 次のラウンドに入ると前ラウンドの提出は消える", () => {
  let state = start(["a", "b"]);
  state = submit(state, "a", 11);
  state = submit(state, "b", 22);
  state = timeout(state); // reveal の表示時間が終わる → 2ラウンド目
  assertEquals(state.phase, "submit");
  assertEquals(state.round, 2);
  assertEquals(viewOf(state, "a").mySubmission, null);
  assertEquals(viewOf(state, "a").submittedCount, 0);
});

// ---------------------------------------------------------------------------
// 不正 payload の棄却（設計書 §9.1）
// ---------------------------------------------------------------------------

Deno.test("不正 payload: 範囲外・小数・文字列・形なしはすべて INVALID_INPUT", () => {
  const state = start(["a", "b"]);
  const rejected: unknown[] = [
    { k: "submit", value: -1 },
    { k: "submit", value: 101 },
    { k: "submit", value: 1.5 },
    { k: "submit", value: "50" },
    { k: "submit", value: Number.NaN },
    { k: "submit" },
    { k: "tap", value: 1 },
    { value: 50 },
    "submit",
    42,
    null,
    [1, 2, 3],
  ];
  for (const payload of rejected) {
    const result = trySubmit(state, "a", payload);
    assertEquals(result.error, "INVALID_INPUT", `棄却されなかった: ${JSON.stringify(payload)}`);
    assertEquals(result.changed, false);
    assertEquals(result.effects.length, 0);
    // 状態は一切動かさない
    assertEquals(result.state, state);
  }
});

Deno.test("不正 payload: 二重提出は DUPLICATE。値は上書きされない", () => {
  let state = start(["a", "b"]);
  state = submit(state, "a", 30);
  const result = trySubmit(state, "a", { k: "submit", value: 90 });
  assertEquals(result.error, "DUPLICATE");
  assertEquals(result.state.submissions["a"], 30);
});

Deno.test("不正 payload: 提出フェーズ以外・期限後・観戦者の提出は PHASE_MISMATCH", () => {
  let state = start(["a", "b"]);
  // 期限を過ぎてからの提出
  const late = trySubmit(state, "a", { k: "submit", value: 1 }, (state.deadline ?? T0) + 1);
  assertEquals(late.error, "PHASE_MISMATCH");
  // 参加していない人の提出
  const outsider = trySubmit(state, "zzz", { k: "submit", value: 1 });
  assertEquals(outsider.error, "PHASE_MISMATCH");
  // 公開フェーズでの提出
  state = submit(state, "a", 1);
  state = submit(state, "b", 2);
  assertEquals(state.phase, "reveal");
  const revealed = trySubmit(state, "a", { k: "submit", value: 3 });
  assertEquals(revealed.error, "PHASE_MISMATCH");
});

// ---------------------------------------------------------------------------
// 途中参加・切断・再接続・キック・人数不足（設計書 §5）
// ---------------------------------------------------------------------------

Deno.test("途中参加は観戦扱い。提出人数の分母を動かさない", () => {
  let state = start(["a", "b"]);
  const result = chickenModule.reduce(state, {
    t: "playerJoined",
    playerId: "c",
    nickname: "nick-c",
    now: T0,
  });
  assertEquals(result.changed, false);
  state = result.state;
  assertEquals(state.order.length, 2);
  assertEquals(viewOf(state, "c").playerCount, 2);
  assertEquals(viewOf(state, "c").mySubmission, null);
  // 観戦者は提出できない
  assertEquals(trySubmit(state, "c", { k: "submit", value: 1 }).error, "PHASE_MISMATCH");
});

Deno.test("切断した人は待たない。残り全員が出せばその場で公開する", () => {
  let state = start(["a", "b", "c"]);
  state = submit(state, "a", 10);
  state = step(state, { t: "playerLeft", playerId: "c", now: T0 });
  assertEquals(state.phase, "submit");
  assertEquals(viewOf(state, "a").players.find((p) => p.playerId === "c")?.connected, false);
  state = submit(state, "b", 20);
  // 切断中の c を待たずに公開へ進む
  assertEquals(state.phase, "reveal");
  assertEquals(state.lastResult?.winnerId, "b");
});

Deno.test("再接続すると提出の待ち対象へ戻る", () => {
  let state = start(["a", "b"]);
  state = step(state, { t: "playerLeft", playerId: "b", now: T0 });
  state = step(state, { t: "playerRejoined", playerId: "b", now: T0 });
  assertEquals(viewOf(state, "b").players.find((p) => p.playerId === "b")?.connected, true);
  state = submit(state, "a", 10);
  // b が繋がっているので、まだ公開しない
  assertEquals(state.phase, "submit");
  state = submit(state, "b", 20);
  assertEquals(state.phase, "reveal");
});

Deno.test("キックされた人は在籍・提出・公開結果から消える", () => {
  let state = start(["a", "b", "c"]);
  state = submit(state, "a", 10);
  state = submit(state, "b", 20);
  state = submit(state, "c", 30);
  assertEquals(state.lastResult?.winnerId, "c");
  state = step(state, { t: "playerKicked", playerId: "c", now: T0 });
  assertEquals(state.order, ["a", "b"]);
  assertEquals(state.submissions["c"], undefined);
  assertEquals(state.lastResult?.entries.some((e) => e.playerId === "c"), false);
  assertEquals(state.lastResult?.winnerId, null);
  assertEquals(viewOf(state, "a").playerCount, 2);
});

Deno.test("在籍が minPlayers を割ったら tooFewPlayers で終わる", () => {
  let state = start(["a", "b"]);
  const result = chickenModule.reduce(state, { t: "playerKicked", playerId: "b", now: T0 });
  state = result.state;
  assertEquals(state.running, false);
  const ended = result.effects.find((e) => e.t === "ended");
  assertEquals(ended?.t === "ended" ? ended.reason : null, "tooFewPlayers");
  // 予約は解除され、score は1回だけ出る
  const schedule = result.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : "なし", null);
  assertEquals(result.effects.filter((e) => e.t === "score").length, 1);
});

Deno.test("ホストの skipPhase は現フェーズを打ち切って進める", () => {
  let state = start(["a", "b"]);
  state = submit(state, "a", 10);
  state = step(state, { t: "skipPhase", now: T0 });
  assertEquals(state.phase, "reveal");
  assertEquals(state.lastResult?.winnerId, "a");
  state = step(state, { t: "skipPhase", now: T0 });
  assertEquals(state.phase, "submit");
  assertEquals(state.round, 2);
});

Deno.test("ホストの endGame は即座に終了し、そこまでの勝利数を score にする", () => {
  let state = start(["a", "b"]);
  state = submit(state, "a", 10);
  state = submit(state, "b", 5);
  const result = chickenModule.reduce(state, { t: "endGame", now: T0 });
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
  const state = start(["a", "b", "c"]);
  const snapshot = JSON.stringify(state);

  const first = chickenModule.reduce(state, {
    t: "clientEvent",
    playerId: "a",
    payload: { k: "submit", value: 33 },
    now: T0,
  });
  const second = chickenModule.reduce(state, {
    t: "clientEvent",
    playerId: "a",
    payload: { k: "submit", value: 33 },
    now: T0,
  });
  assertEquals(JSON.stringify(first.state), JSON.stringify(second.state));
  assertEquals(JSON.stringify(first.effects), JSON.stringify(second.effects));
  // 入力 state は変わっていない
  assertEquals(JSON.stringify(state), snapshot);
  // 返ってきた state は入力とは別物（浅い複製ではなく中身も分かれている）
  assertNotEquals(first.state.submissions, state.submissions);

  assertEquals(
    JSON.stringify(chickenModule.view(state, "a")),
    JSON.stringify(chickenModule.view(state, "a")),
  );
});

Deno.test("view は受信者ごとに変わる（自分の提出値だけが入れ替わる）", () => {
  let state = start(["a", "b"]);
  state = submit(state, "a", 8);
  assertEquals(viewOf(state, "a").mySubmission, 8);
  assertEquals(viewOf(state, "b").mySubmission, null);
  assertNotEquals(
    JSON.stringify(viewOf(state, "a")),
    JSON.stringify(viewOf(state, "b")),
  );
});

// ---------------------------------------------------------------------------
// ルーム層との配線（設計書 §2.2 / §3.2 / §5）
//
// ここから下は「卓から実際に始められて、gameView が受信者ごとに届き、
// 途中参加・再接続で復元できる」ことを RoomManager 越しに確かめる。
// モジュール単体では、この配線の穴（カタログ登録漏れ・view の配り忘れ）が見つからない
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

/**
 * playerId を伏せた view を直列化する。
 * 「他人の数字が混ざっていないか」を文字列で突き合わせるとき、playerId（UUID）の
 * 16進の並びがたまたま数字と一致して誤検知するため、IDだけ落としてから比べる
 */
function withoutIds(view: ChickenView): string {
  return JSON.stringify(view, (key, value) => (key === "playerId" ? undefined : value));
}

/** 直近の gameView の中身を ChickenView として読む */
function lastChickenView(link: MockLink): ChickenView {
  const msg = last(link, "gameView");
  assertExists(msg, "gameView が届いていない");
  assertEquals(msg.gameId, "chicken");
  return msg.view as ChickenView;
}

/** ホストと客1人でチキンレースを開始した卓を作る */
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

  manager.handle(host, { t: "selectGame", gameId: "chicken" });
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
  const summary = snapshot.snapshot.availableGames.find((g) => g.id === "chicken");
  assertExists(summary, "チキンレースが一覧に無い");
  assertEquals(summary.kind, "module");
  assertEquals(summary.official, true);
  assertEquals(summary.minPlayers, 2);
  // 卓としてのフェーズは playing。中身は gameView で配る（設計書 §3.2）
  assertEquals(last(room.host, "phase")?.phase, "playing");
  assertEquals(last(room.host, "phase")?.view.phase, "playing");
  assertEquals(lastChickenView(room.host).phase, "submit");
  assertEquals(lastChickenView(room.guest).playerCount, 2);
  // 秒読み用の期限は、いま予約されているフェーズのもの（提出フェーズの30秒後）
  assertEquals(last(room.host, "gameView")?.deadline, T0 + 30_000);
  assertEquals(last(room.host, "phase")?.deadline, T0 + 30_000);
  room.manager.dispose();
});

Deno.test("卓: gameEvent で提出でき、他人の数字は自分の gameView に載らない", () => {
  const room = playingRoom();
  room.manager.handle(room.host, { t: "gameEvent", payload: { k: "submit", value: 88 } });
  assertEquals(lastChickenView(room.host).mySubmission, 88);
  // 客の側には数字が届いていない（提出済みという事実だけ）
  const guestView = lastChickenView(room.guest);
  assertEquals(guestView.mySubmission, null);
  assertEquals(guestView.submittedCount, 1);
  assert(!withoutIds(guestView).includes("88"), "他人の数字が配信されている");
  // 不正な payload は INVALID_INPUT で本人にだけ返る
  room.manager.handle(room.guest, { t: "gameEvent", payload: { k: "submit", value: 101 } });
  assertEquals(last(room.guest, "error")?.code, "INVALID_INPUT");
  room.manager.dispose();
});

Deno.test("卓: 再接続・途中参加は RoomSnapshot.game で復元できる", () => {
  const room = playingRoom();
  room.manager.handle(room.host, { t: "gameEvent", payload: { k: "submit", value: 12 } });
  const session = last(room.host, "roomState")?.snapshot.session;
  assertExists(session);
  room.manager.disconnect(room.host);

  const again = new MockLink();
  room.manager.handle(again, { t: "join", roomCode: room.code, nickname: "ホスト", session });
  const snapshot = last(again, "roomState")?.snapshot;
  assertExists(snapshot);
  assertEquals(snapshot.phase, "playing");
  assertExists(snapshot.game, "進行中のゲームがスナップショットに入っていない");
  assertEquals(snapshot.game.gameId, "chicken");
  // 自分の提出値は復元される
  assertEquals((snapshot.game.view as ChickenView).mySubmission, 12);

  // 途中参加は観戦。自分の数字は無く、他人の数字も見えない
  const late = new MockLink();
  room.manager.handle(late, { t: "join", roomCode: room.code, nickname: "遅れ客" });
  const lateSnapshot = last(late, "roomState")?.snapshot;
  assertExists(lateSnapshot);
  assertExists(lateSnapshot.game);
  const lateView = lateSnapshot.game.view as ChickenView;
  assertEquals(lateView.mySubmission, null);
  assertEquals(lateView.playerCount, 2);
  assert(!withoutIds(lateView).includes("12"), "他人の数字が復元で漏れている");
  room.manager.dispose();
});

Deno.test("卓: 進行中は別のゲームを選べない。終了で lobby へ戻り公式スコアに入る", () => {
  const room = playingRoom();
  room.manager.handle(room.host, { t: "selectGame", gameId: "official-ogiri" });
  assertEquals(last(room.host, "error")?.code, "PHASE_MISMATCH");

  // 3ラウンドとも同じ結果（ホストの勝ち）にして、最後まで進める
  for (let round = 1; round <= 3; round++) {
    room.manager.handle(room.host, { t: "gameEvent", payload: { k: "submit", value: 50 } });
    room.manager.handle(room.guest, { t: "gameEvent", payload: { k: "submit", value: 10 } });
    assertEquals(lastChickenView(room.host).phase, "reveal");
    room.clock.advance(8_000); // 公開の表示時間
  }
  room.clock.advance(10_000); // 最終結果の表示時間 → 終了
  assertEquals(last(room.host, "phase")?.phase, "lobby");
  assertEquals(last(room.host, "phase")?.view.phase, "lobby");
  // 1ラウンド勝ったホストに1点入る（勝利ラウンド数がそのまま点になる）
  const hostScore = room.manager.getRoom(room.code)?.players.get(room.hostId)?.score;
  assertEquals(hostScore, 3);
  // ロビーへ戻っているので次のゲームを選べる
  room.manager.handle(room.host, { t: "selectGame", gameId: "official-ogiri" });
  assertEquals(last(room.host, "phase")?.view.phase, "lobby");
  room.manager.dispose();
});

Deno.test("卓: 期限に達すると schedule で自動的に進む", () => {
  const room = playingRoom();
  room.manager.handle(room.host, { t: "gameEvent", payload: { k: "submit", value: 7 } });
  // 提出フェーズの期限（30秒）
  room.clock.advance(30_000);
  assertEquals(lastChickenView(room.host).phase, "reveal");
  assertEquals(lastChickenView(room.host).result?.winnerId, room.hostId);
  room.manager.dispose();
});
