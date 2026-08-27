/**
 * server/games/prompt.ts のユニットテスト
 * 設計書 docs/design/games-unified.md §2.1 に対応する。
 *
 * 眼目は「既存エンジン（engine.ts）と結果が一致すること」。PR2 は挙動不変の
 * リファクタなので、prompt モジュール経由の state が engine 直呼びの state と
 * 1バイトも違わないことを、正常系のひと通りの進行で突き合わせる。
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  buildPhaseView,
  DEFAULT_PHASE_DURATIONS,
  type EngineEvent,
  type EnginePlayerInput,
  reduce as engineReduce,
  startGame as engineStartGame,
} from "../../engine.ts";
import type { GameDefinition, GameState } from "../../types.ts";
import type { ModuleEvent, ModuleResult } from "../../games/module.ts";
import { promptModule, toEngineEvent } from "../../games/prompt.ts";

const T0 = 1_700_000_000_000;
const SEED = 20260826;

/** テスト用のゲーム定義を作る（engine_test.ts と同じ形） */
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

/** prompt モジュールでゲームを開始する */
function initPrompt(def: GameDefinition, ids: string[], now = T0): ModuleResult<GameState> {
  return promptModule.init({
    players: players(...ids),
    now,
    seed: SEED,
    config: { definition: def, durations: DEFAULT_PHASE_DURATIONS },
  });
}

/** エラーなしで開始する */
function start(def: GameDefinition, ids: string[], now = T0): GameState {
  const res = initPrompt(def, ids, now);
  assertEquals(res.error, undefined);
  return res.state;
}

/** モジュールにイベントを1件流す（エラーなしを期待する） */
function step(state: GameState, event: ModuleEvent): GameState {
  const res = promptModule.reduce(state, event);
  assertEquals(res.error, undefined);
  return res.state;
}

/** 回答の clientEvent を作る */
function submit(playerId: string, value: string | number, now: number): ModuleEvent {
  return { t: "clientEvent", playerId, payload: { k: "submitInput", value }, now };
}

/** 投票の clientEvent を作る */
function vote(playerId: string, targetPlayerId: string, now: number): ModuleEvent {
  return { t: "clientEvent", playerId, payload: { k: "submitVote", targetPlayerId }, now };
}

/**
 * 匿名 reveal 用のトークン（revealTokens / revealTokenPool）は、ゲーム開始ごとに
 * 暗号乱数で作り直す（H-3 の修正）。別々に開始した2つの state では必ず値が食い違うため、
 * 「モジュール経由とエンジン直呼びの進行が一致するか」を見るこのファイルでは、
 * トークンの**中身**だけを伏せ字にして突き合わせる（キー集合と個数は保ったまま比較する）。
 * トークン自体の性質は server/tests/reveal_anonymity_test.ts が検証する。
 */
function maskTokens(state: GameState): GameState {
  const revealTokens: Record<string, string> = {};
  for (const id of Object.keys(state.revealTokens).sort()) revealTokens[id] = "<token>";
  return {
    ...state,
    revealTokens,
    revealTokenPool: state.revealTokenPool.map((row) => row.map(() => "<token>")),
  };
}

/** ModuleResult ごとトークンを伏せる */
function maskResultTokens(result: ModuleResult<GameState>): ModuleResult<GameState> {
  return { ...result, state: maskTokens(result.state) };
}

/** 匿名ゲームの投票先はラウンドごとのトークン。実IDを直前の state で引き直す */
function resolveModuleVote(event: ModuleEvent, state: GameState): ModuleEvent {
  if (event.t !== "clientEvent") return event;
  const payload = event.payload;
  if (payload === null || typeof payload !== "object") return event;
  const record = payload as Record<string, unknown>;
  if (record.k !== "submitVote" || typeof record.targetPlayerId !== "string") return event;
  const token = state.revealTokens[record.targetPlayerId];
  if (token === undefined) return event;
  return { ...event, payload: { k: "submitVote", targetPlayerId: token } };
}

/** 上と同じことを EngineEvent に対して行う */
function resolveEngineVote(event: EngineEvent, state: GameState): EngineEvent {
  if (event.t !== "submitVote") return event;
  const token = state.revealTokens[event.targetPlayerId];
  if (token === undefined) return event;
  return { ...event, targetPlayerId: token };
}

// ---------------------------------------------------------------------------
// 開始
// ---------------------------------------------------------------------------

Deno.test("prompt: init は engine.startGame と同じ state を作る", () => {
  const def = makeDef();
  const mine = initPrompt(def, ["a", "b"]);
  const theirs = engineStartGame(def, players("a", "b"), T0, DEFAULT_PHASE_DURATIONS);
  assertEquals(maskTokens(mine.state), maskTokens(theirs.state));
  assertEquals(mine.changed, true);
  // 匿名トークンだけは開始ごとの乱数なので一致しない（一致したら乱数になっていない）
  assertNotEquals(mine.state.revealTokenPool, theirs.state.revealTokenPool);
});

Deno.test("prompt: init の効果は phaseChanged → viewChanged + schedule に写像される", () => {
  const res = initPrompt(makeDef(), ["a", "b"]);
  assertEquals(res.effects, [
    { t: "viewChanged" },
    { t: "schedule", at: res.state.deadline },
  ]);
});

Deno.test("prompt: 人数不足の開始はエンジンと同じエラーになる", () => {
  const res = initPrompt(makeDef(), ["a"]);
  assertEquals(res.error, "INVALID_INPUT");
  assertEquals(res.changed, false);
  assertEquals(res.effects, []);
});

Deno.test("prompt: config が無い init は INVALID_INPUT（ルーム層の呼び出し誤り）", () => {
  const res = promptModule.init({ players: players("a", "b"), now: T0, seed: SEED });
  assertEquals(res.error, "INVALID_INPUT");
  assertEquals(res.changed, false);
});

Deno.test("prompt: seed は宣言的フローの進行に影響しない（乱数を使わないため）", () => {
  const def = makeDef();
  const a = promptModule.init({
    players: players("a", "b"),
    now: T0,
    seed: 1,
    config: { definition: def },
  });
  const b = promptModule.init({
    players: players("a", "b"),
    now: T0,
    seed: 999_999,
    config: { definition: def },
  });
  assertEquals(maskTokens(a.state), maskTokens(b.state));
});

// ---------------------------------------------------------------------------
// エンジンとの一致（挙動不変の確認）
// ---------------------------------------------------------------------------

Deno.test("prompt: vote 1ラウンドの進行が engine 直呼びと完全に一致する", () => {
  const def = makeDef({ scoring: "vote", rounds: 1 });
  // モジュール経由
  let mine = start(def, ["a", "b"]);
  // エンジン直呼び
  const startRes = engineStartGame(def, players("a", "b"), T0, DEFAULT_PHASE_DURATIONS);
  let theirs = startRes.state;

  const moduleEvents: ModuleEvent[] = [
    { t: "skipPhase", now: T0 + 1 }, // intro -> prompt
    { t: "skipPhase", now: T0 + 2 }, // prompt -> input
    submit("a", "ねこ", T0 + 3),
    submit("b", "いぬ", T0 + 4), // 全員提出 -> reveal
    { t: "skipPhase", now: T0 + 5 }, // reveal -> judge
    vote("a", "b", T0 + 6),
    vote("b", "a", T0 + 7), // 全員投票 -> roundResult
    { t: "skipPhase", now: T0 + 8 }, // roundResult -> finalResult
  ];
  const engineEvents: EngineEvent[] = [
    { t: "skipPhase", now: T0 + 1 },
    { t: "skipPhase", now: T0 + 2 },
    { t: "submitInput", playerId: "a", value: "ねこ", now: T0 + 3 },
    { t: "submitInput", playerId: "b", value: "いぬ", now: T0 + 4 },
    { t: "skipPhase", now: T0 + 5 },
    { t: "submitVote", voterId: "a", targetPlayerId: "b", now: T0 + 6 },
    { t: "submitVote", voterId: "b", targetPlayerId: "a", now: T0 + 7 },
    { t: "skipPhase", now: T0 + 8 },
  ];

  for (let i = 0; i < moduleEvents.length; i++) {
    // 投票先は state ごとに違うトークンなので、それぞれの state で引き直してから流す
    mine = step(mine, resolveModuleVote(moduleEvents[i], mine));
    theirs = engineReduce(theirs, resolveEngineVote(engineEvents[i], theirs)).state;
    assertEquals(maskTokens(mine), maskTokens(theirs), `${i} 件目のイベントで state が食い違った`);
  }
  assertEquals(mine.phase, "finalResult");
});

Deno.test("prompt: 参加者の増減イベントも engine 直呼びと一致する", () => {
  const def = makeDef();
  let mine = start(def, ["a", "b", "c"]);
  let theirs = engineStartGame(def, players("a", "b", "c"), T0, DEFAULT_PHASE_DURATIONS).state;
  const pairs: Array<[ModuleEvent, EngineEvent]> = [
    [
      { t: "playerJoined", playerId: "d", nickname: "nick-d", now: T0 + 1 },
      { t: "playerJoined", playerId: "d", nickname: "nick-d", now: T0 + 1 },
    ],
    [
      { t: "playerLeft", playerId: "c", now: T0 + 2 },
      { t: "playerLeft", playerId: "c", now: T0 + 2 },
    ],
    [
      { t: "playerRejoined", playerId: "c", now: T0 + 3 },
      { t: "playerRejoined", playerId: "c", now: T0 + 3 },
    ],
    [
      { t: "playerKicked", playerId: "c", now: T0 + 4 },
      { t: "playerKicked", playerId: "c", now: T0 + 4 },
    ],
    [{ t: "timeout", now: T0 - 1 }, { t: "timeout", now: T0 - 1 }],
    [{ t: "endGame", now: T0 + 5 }, { t: "endGame", now: T0 + 5 }],
  ];
  for (const [moduleEvent, engineEvent] of pairs) {
    mine = promptModule.reduce(mine, moduleEvent).state;
    theirs = engineReduce(theirs, engineEvent).state;
    assertEquals(maskTokens(mine), maskTokens(theirs), `${moduleEvent.t} で state が食い違った`);
  }
});

Deno.test("prompt: view は buildPhaseView と一致する（受信者ごとの絞りも同じ）", () => {
  const def = makeDef();
  let state = start(def, ["a", "b"]);
  state = step(state, { t: "skipPhase", now: T0 + 1 });
  state = step(state, { t: "skipPhase", now: T0 + 2 });
  state = step(state, submit("a", "ねこ", T0 + 3));
  for (const viewer of ["a", "b", "unknown"]) {
    assertEquals(promptModule.view(state, viewer), buildPhaseView(state, viewer));
  }
  // 受信者ごとに内容が変わっている（絞りが効いている）ことも確かめる
  assertNotEquals(promptModule.view(state, "a"), promptModule.view(state, "b"));
});

// ---------------------------------------------------------------------------
// 効果の写像
// ---------------------------------------------------------------------------

Deno.test("prompt: 採点の遷移は viewChanged → roundResult → schedule の順に出る", () => {
  const def = makeDef({ scoring: "match", rounds: 1 });
  let state = start(def, ["a", "b"]);
  state = step(state, { t: "skipPhase", now: T0 + 1 });
  state = step(state, { t: "skipPhase", now: T0 + 2 });
  state = step(state, submit("a", "ねこ", T0 + 3));
  state = step(state, submit("b", "ねこ", T0 + 4)); // -> reveal
  state = step(state, { t: "skipPhase", now: T0 + 5 }); // -> judge
  const res = promptModule.reduce(state, { t: "skipPhase", now: T0 + 6 }); // judge -> roundResult
  assertEquals(res.error, undefined);
  assertEquals(res.effects.map((e) => e.t), ["viewChanged", "roundResult", "schedule"]);
  assertEquals(res.state.phase, "roundResult");
});

Deno.test("prompt: 最終結果は score → finalResult の順に出る（公式スコアは1回だけ）", () => {
  const def = makeDef({ scoring: "match", rounds: 1 });
  let state = start(def, ["a", "b"]);
  state = step(state, { t: "skipPhase", now: T0 + 1 });
  state = step(state, { t: "skipPhase", now: T0 + 2 });
  state = step(state, submit("a", "ねこ", T0 + 3));
  state = step(state, submit("b", "ねこ", T0 + 4));
  state = step(state, { t: "skipPhase", now: T0 + 5 });
  state = step(state, { t: "skipPhase", now: T0 + 6 }); // -> roundResult
  const res = promptModule.reduce(state, { t: "skipPhase", now: T0 + 7 }); // -> finalResult
  assertEquals(res.effects.map((e) => e.t), ["viewChanged", "score", "finalResult", "schedule"]);
  const score = res.effects.find((e) => e.t === "score");
  assert(score !== undefined && score.t === "score");
  assertEquals(score.totals.length, 2);
  // finalResult は1回のゲームで1度きり。ここから先へ進んでも score は出ない
  const toLobby = promptModule.reduce(res.state, { t: "skipPhase", now: T0 + 8 });
  assertEquals(toLobby.effects.map((e) => e.t), ["viewChanged", "ended", "schedule"]);
  assertEquals(toLobby.state.phase, "lobby");
});

Deno.test("prompt: 変化なし（changed:false）のときは効果を出さない", () => {
  const state = start(makeDef(), ["a", "b"]);
  // 期限前の timeout はエンジンが noop にする
  const res = promptModule.reduce(state, { t: "timeout", now: T0 });
  assertEquals(res.changed, false);
  assertEquals(res.error, undefined);
  assertEquals(res.effects, []);
});

// ---------------------------------------------------------------------------
// payload の型検証（§9.1）
// ---------------------------------------------------------------------------

Deno.test("prompt: 不正な payload は INVALID_INPUT で棄却し、state を変えない", () => {
  let state = start(makeDef(), ["a", "b"]);
  state = step(state, { t: "skipPhase", now: T0 + 1 });
  state = step(state, { t: "skipPhase", now: T0 + 2 }); // input フェーズ
  const bad: unknown[] = [
    null,
    "submitInput",
    123,
    [],
    {},
    { k: "unknown" },
    { k: 1, value: "ねこ" },
    { k: "submitInput" }, // value が無い
    { k: "submitInput", value: null },
    { k: "submitInput", value: { nested: true } },
    { k: "submitVote" }, // targetPlayerId が無い
    { k: "submitVote", targetPlayerId: 1 },
  ];
  for (const payload of bad) {
    const res = promptModule.reduce(state, { t: "clientEvent", playerId: "a", payload, now: T0 });
    assertEquals(res.error, "INVALID_INPUT", `棄却されなかった: ${JSON.stringify(payload)}`);
    assertEquals(res.changed, false);
    assertEquals(res.effects, []);
    assertEquals(res.state, state);
  }
});

Deno.test("prompt: toEngineEvent は受理する2種だけを写像する", () => {
  assertEquals(toEngineEvent("a", { k: "submitInput", value: "ねこ" }, T0), {
    t: "submitInput",
    playerId: "a",
    value: "ねこ",
    now: T0,
  });
  assertEquals(toEngineEvent("a", { k: "submitInput", value: 2 }, T0), {
    t: "submitInput",
    playerId: "a",
    value: 2,
    now: T0,
  });
  assertEquals(toEngineEvent("a", { k: "submitVote", targetPlayerId: "b" }, T0), {
    t: "submitVote",
    voterId: "a",
    targetPlayerId: "b",
    now: T0,
  });
  assertEquals(toEngineEvent("a", { k: "skipPhase" }, T0), null);
});

Deno.test("prompt: 値の妥当性判定はエンジンに任せる（エラー文言が既存経路と揃う）", () => {
  let state = start(makeDef(), ["a", "b"]);
  state = step(state, { t: "skipPhase", now: T0 + 1 });
  state = step(state, { t: "skipPhase", now: T0 + 2 });
  // 空文字は型としては正しいので写像は通り、エンジンが INVALID_INPUT にする
  const res = promptModule.reduce(state, submit("a", "   ", T0 + 3));
  assertEquals(res.error, "INVALID_INPUT");
  assertEquals(res.message, "回答の形式が正しくありません");
});

// ---------------------------------------------------------------------------
// 純粋関数性（§3.2 規約2）
// ---------------------------------------------------------------------------

Deno.test("prompt: reduce は入力の state を変更しない", () => {
  let state = start(makeDef(), ["a", "b"]);
  state = step(state, { t: "skipPhase", now: T0 + 1 });
  state = step(state, { t: "skipPhase", now: T0 + 2 });
  const before = structuredClone(state);
  promptModule.reduce(state, submit("a", "ねこ", T0 + 3));
  promptModule.reduce(state, { t: "playerKicked", playerId: "b", now: T0 + 4 });
  promptModule.reduce(state, { t: "clientEvent", playerId: "a", payload: null, now: T0 + 5 });
  assertEquals(state, before);
});

Deno.test("prompt: 同じ入力からは何度呼んでも同じ結果になる", () => {
  const def = makeDef();
  const a = initPrompt(def, ["a", "b"]);
  const b = initPrompt(def, ["a", "b"]);
  // 匿名トークンは開始のたびに引き直す乱数なので、そこだけ伏せて比べる（H-3）。
  // reduce 自体は乱数を使わないため、同じ state からは何度でも同じ結果になる
  assertEquals(maskResultTokens(a), maskResultTokens(b));
  assertEquals(
    promptModule.reduce(a.state, { t: "skipPhase", now: T0 + 1 }),
    promptModule.reduce(a.state, { t: "skipPhase", now: T0 + 1 }),
  );
  assertEquals(
    maskResultTokens(promptModule.reduce(a.state, { t: "skipPhase", now: T0 + 1 })),
    maskResultTokens(promptModule.reduce(b.state, { t: "skipPhase", now: T0 + 1 })),
  );
});
