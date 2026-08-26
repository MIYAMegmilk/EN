/**
 * server/games/client.ts のユニットテスト
 * 設計書 docs/design/games-unified.md（クライアント専用ゲーム）のチェックリストに対応する。
 *
 * 眼目は4つ。
 *   1. **秘密を持てないこと**（view が受信者によって変わらない。この経路の定義そのもの）
 *   2. **公式スコアに入らないこと**（score 効果を一度も出さない）
 *   3. 中継が連番・上限つきで動くこと（取りこぼしても壊れない形になっているか）
 *   4. 異常系（途中参加・切断・再接続・キック・人数不足・終了後）で壊れないこと
 */

import { assert, assertEquals } from "@std/assert";
import type { EnginePlayerInput } from "../../engine.ts";
import {
  CLIENT_RELAY_LOG_DEFAULT,
  CLIENT_RELAY_LOG_MAX,
  clientGame,
  type ClientGameState,
  type ClientGameView,
} from "../../games/client.ts";
import type { ModuleEffect, ModuleResult } from "../../games/module.ts";
import { findModuleGame, GAME_MODULES } from "../../games/index.ts";

const T0 = 1_700_000_000_000;
const SEED = 20260826;

const game = clientGame({
  id: "testgame",
  title: "テスト",
  description: "テスト用",
  minPlayers: 2,
  maxPlayers: 4,
  relayLogMax: 3,
});

function players(...ids: string[]): EnginePlayerInput[] {
  return ids.map((id) => ({ id, nickname: `nick-${id}`, connected: true }));
}

function start(ids: string[], mod = game): ClientGameState {
  const result = mod.init({ players: players(...ids), now: T0, seed: SEED });
  assertEquals(result.error, undefined);
  return result.state as ClientGameState;
}

function kinds(result: ModuleResult<ClientGameState>): ModuleEffect["t"][] {
  return result.effects.map((e) => e.t);
}

function viewOf(state: ClientGameState, viewer: string, mod = game): ClientGameView {
  return mod.view(state, viewer) as ClientGameView;
}

// ---------------------------------------------------------------------------
// 1. 秘密を持てない（定義そのもの）
// ---------------------------------------------------------------------------

Deno.test("view は受信者によって変わらない（＝秘密を持てない）", () => {
  let state = start(["a", "b"]);
  const sent = game.reduce(state, {
    t: "clientEvent",
    playerId: "a",
    payload: { k: "secret", v: 42 },
    now: T0 + 10,
  });
  state = sent.state as ClientGameState;
  const forA = viewOf(state, "a");
  const forB = viewOf(state, "b");
  assertEquals(JSON.stringify(forA), JSON.stringify(forB));
  // a が送った中身は b の view にもそのまま載る（隠せない）
  assertEquals(forB.events[0].payload, { k: "secret", v: 42 });
});

// ---------------------------------------------------------------------------
// 2. 公式スコアに入らない
// ---------------------------------------------------------------------------

Deno.test("score 効果を一度も出さない（公式スコア非算入）", () => {
  let state = start(["a", "b"]);
  const seen: ModuleEffect["t"][] = [];
  const push = (r: ModuleResult<ClientGameState>) => {
    seen.push(...kinds(r));
    state = r.state as ClientGameState;
  };
  push(game.reduce(state, { t: "clientEvent", playerId: "a", payload: { k: "x" }, now: T0 + 1 }));
  push(game.reduce(state, { t: "playerJoined", playerId: "c", nickname: "c", now: T0 + 2 }));
  push(game.reduce(state, { t: "playerLeft", playerId: "c", now: T0 + 3 }));
  push(game.reduce(state, { t: "playerRejoined", playerId: "c", now: T0 + 4 }));
  push(game.reduce(state, { t: "skipPhase", now: T0 + 5 }));
  push(game.reduce(state, { t: "endGame", now: T0 + 6 }));
  assert(!seen.includes("score"), `score 効果が出ている: ${seen.join(",")}`);
});

// ---------------------------------------------------------------------------
// 3. 中継
// ---------------------------------------------------------------------------

Deno.test("中継は連番が増え、上限を超えたぶんは古い順に消える", () => {
  let state = start(["a", "b"]);
  for (let i = 1; i <= 5; i++) {
    const r = game.reduce(state, {
      t: "clientEvent",
      playerId: "a",
      payload: { k: "n", i },
      now: T0 + i,
    });
    assertEquals(kinds(r), ["viewChanged"]);
    state = r.state as ClientGameState;
  }
  // relayLogMax: 3 なので直近3件だけ残る
  assertEquals(state.events.length, 3);
  assertEquals(state.events.map((e) => e.n), [3, 4, 5]);
  // 連番は消えたぶんも含めて単調増加（クライアントの差分判定の前提）
  assertEquals(state.seq, 5);
});

Deno.test("relayLogMax: 0 は中継そのものを断る", () => {
  const solo = clientGame({
    id: "solo",
    title: "ひとり",
    description: "中継なし",
    minPlayers: 1,
    maxPlayers: 1,
    relayLogMax: 0,
  });
  const state = start(["a"], solo);
  const r = solo.reduce(state, { t: "clientEvent", playerId: "a", payload: { k: "x" }, now: T0 });
  assertEquals(r.error, "INVALID_INPUT");
  assertEquals(r.effects.length, 0);
});

Deno.test("在籍していない人からの中継は受け付けない", () => {
  const state = start(["a", "b"]);
  const r = game.reduce(state, {
    t: "clientEvent",
    playerId: "zzz",
    payload: { k: "x" },
    now: T0,
  });
  assertEquals(r.error, "PHASE_MISMATCH");
  assertEquals((r.state as ClientGameState).events.length, 0);
});

Deno.test("relayLogMax は 0..CLIENT_RELAY_LOG_MAX に丸められる", () => {
  const huge = clientGame({
    id: "huge",
    title: "でかい",
    description: "上限超え",
    minPlayers: 1,
    maxPlayers: 10,
    relayLogMax: 100_000,
  });
  assertEquals(start(["a"], huge).relayLogMax, CLIENT_RELAY_LOG_MAX);
  const bad = clientGame({
    id: "bad",
    title: "こわれ",
    description: "負の値",
    minPlayers: 1,
    maxPlayers: 10,
    relayLogMax: -5,
  });
  assertEquals(start(["a"], bad).relayLogMax, CLIENT_RELAY_LOG_DEFAULT);
});

Deno.test("payload の中身は一切解釈しない（どんな形でもそのまま中継する）", () => {
  let state = start(["a", "b"]);
  for (const payload of [null, 0, "文字列", [1, 2, 3], { 深い: { 入れ子: true } }]) {
    const r = game.reduce(state, { t: "clientEvent", playerId: "a", payload, now: T0 });
    assertEquals(r.error, undefined);
    state = r.state as ClientGameState;
  }
  assertEquals(state.events[state.events.length - 1].payload, { 深い: { 入れ子: true } });
});

// ---------------------------------------------------------------------------
// 4. 異常系
// ---------------------------------------------------------------------------

Deno.test("途中参加は名簿に載り、view に出る", () => {
  const state = start(["a", "b"]);
  const r = game.reduce(state, { t: "playerJoined", playerId: "c", nickname: "しい", now: T0 });
  assertEquals(kinds(r), ["viewChanged"]);
  const view = viewOf(r.state as ClientGameState, "a");
  assertEquals(view.players.map((p) => p.id), ["a", "b", "c"]);
  assertEquals(view.players[2].name, "しい");
});

Deno.test("同じ人の二重参加・定員超過は名簿を増やさない", () => {
  let state = start(["a", "b"]);
  state = game.reduce(state, { t: "playerJoined", playerId: "a", nickname: "a", now: T0 })
    .state as ClientGameState;
  assertEquals(state.players.length, 2);
  // maxPlayers: 4 なので c, d までは載り、e は載らない
  for (const id of ["c", "d", "e"]) {
    state = game.reduce(state, { t: "playerJoined", playerId: id, nickname: id, now: T0 })
      .state as ClientGameState;
  }
  assertEquals(state.players.map((p) => p.id), ["a", "b", "c", "d"]);
});

Deno.test("切断は在籍を残して connected だけ倒し、再接続で戻る", () => {
  let state = start(["a", "b"]);
  const left = game.reduce(state, { t: "playerLeft", playerId: "b", now: T0 + 1 });
  assertEquals(kinds(left), ["viewChanged"]);
  state = left.state as ClientGameState;
  assertEquals(state.players.length, 2);
  assertEquals(state.players[1].connected, false);
  // 2度目の playerLeft は何も起こさない
  assertEquals(game.reduce(state, { t: "playerLeft", playerId: "b", now: T0 + 2 }).changed, false);
  const back = game.reduce(state, { t: "playerRejoined", playerId: "b", now: T0 + 3 });
  assertEquals(kinds(back), ["viewChanged"]);
  assertEquals((back.state as ClientGameState).players[1].connected, true);
  // 切断だけでは終わらない（60秒の猶予があるため）
  assert(!(back.state as ClientGameState).ended);
});

Deno.test("キックで名簿と当人の中継が消え、minPlayers を割れば終了する", () => {
  let state = start(["a", "b", "c"]);
  state = game.reduce(state, {
    t: "clientEvent",
    playerId: "c",
    payload: { k: "x" },
    now: T0 + 1,
  }).state as ClientGameState;
  assertEquals(state.events.length, 1);
  // 3人 → 2人。minPlayers: 2 なのでまだ続く
  const kick1 = game.reduce(state, { t: "playerKicked", playerId: "c", now: T0 + 2 });
  assertEquals(kinds(kick1), ["viewChanged"]);
  state = kick1.state as ClientGameState;
  assertEquals(state.players.map((p) => p.id), ["a", "b"]);
  // キックされた人が残した中継も消える（卓に痕跡を残さない）
  assertEquals(state.events.length, 0);
  // 2人 → 1人。minPlayers を割ったので終了する
  const kick2 = game.reduce(state, { t: "playerKicked", playerId: "b", now: T0 + 3 });
  assertEquals(kinds(kick2), ["viewChanged", "ended"]);
  const ended = kick2.effects.find((e) => e.t === "ended");
  assert(ended !== undefined && ended.t === "ended" && ended.reason === "tooFewPlayers");
  assert((kick2.state as ClientGameState).ended);
});

Deno.test("ホストの終了で ended になり、以後のイベントは受け付けない", () => {
  let state = start(["a", "b"]);
  const end = game.reduce(state, { t: "endGame", now: T0 + 1 });
  assertEquals(kinds(end), ["viewChanged", "ended"]);
  const ended = end.effects.find((e) => e.t === "ended");
  assert(ended !== undefined && ended.t === "ended" && ended.reason === "hostEnded");
  state = end.state as ClientGameState;
  assert(viewOf(state, "a").ended);
  const after = game.reduce(state, {
    t: "clientEvent",
    playerId: "a",
    payload: { k: "x" },
    now: T0 + 2,
  });
  assertEquals(after.changed, false);
  assertEquals((after.state as ClientGameState).events.length, 0);
  // 終了後もキックだけは通す（在籍から消えるため）
  const kicked = game.reduce(state, { t: "playerKicked", playerId: "b", now: T0 + 3 });
  assertEquals((kicked.state as ClientGameState).players.map((p) => p.id), ["a"]);
});

Deno.test("skipPhase / timeout / chatMessage は何もしない", () => {
  const state = start(["a", "b"]);
  for (
    const event of [
      { t: "skipPhase", now: T0 } as const,
      { t: "timeout", now: T0 } as const,
      { t: "chatMessage", playerId: "a", text: "こんばんは", now: T0 } as const,
    ]
  ) {
    const r = game.reduce(state, event);
    assertEquals(r.changed, false, `${event.t} が状態を変えている`);
    assertEquals(r.effects.length, 0);
  }
});

Deno.test("init は seed と startedAt を全員へ同じ値で配る（通信なしの同期の土台）", () => {
  const state = start(["a", "b"]);
  assertEquals(state.seed, SEED);
  assertEquals(state.startedAt, T0);
  assertEquals(viewOf(state, "a").seed, viewOf(state, "b").seed);
  assertEquals(viewOf(state, "a").startedAt, viewOf(state, "b").startedAt);
});

// ---------------------------------------------------------------------------
// カタログ登録（1か所に1行で足りているか）
// ---------------------------------------------------------------------------

Deno.test("移植した2本と画像サンプルがカタログに載っている", () => {
  for (const id of ["mogura", "reflex", "emoawase"]) {
    const found = findModuleGame(id);
    assert(found !== null, `${id} がカタログに無い`);
    assertEquals(found.kind, "module");
    assert(found.meta.title.length > 0 && found.meta.title.length <= 20);
    assert(found.meta.description.length <= 100);
    assert(found.meta.minPlayers >= 1 && found.meta.minPlayers <= found.meta.maxPlayers);
    assert(found.meta.maxPlayers <= 10);
  }
});

Deno.test("カタログのIDは重複しない", () => {
  const ids = GAME_MODULES.map((m) => m.id);
  assertEquals(ids.length, new Set(ids).size, `重複がある: ${ids.join(",")}`);
});
