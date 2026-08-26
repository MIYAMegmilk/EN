/**
 * クライアント専用ゲームの**配信量の実測**（設計書 docs/design/games-unified.md）
 *
 * なぜ測るか:
 * この経路は `clientEvent` を1件受けるたびに `viewChanged` を返し、ルーム層が
 * **接続数ぶんの `gameView`** を配る（rooms.ts `broadcastPhase`）。
 * つまり配信量は「view 1通の大きさ × 中継の件数 × 卓の人数」で効いてくる。
 * お絵かき（draw.ts）は同じ構造で 1ルーム 0.5MB/秒 前後に達しており、
 * 「毎フレーム送るゲーム」を書くと簡単に破綻することが分かっている。
 *
 * ここでは移植した2本（mogura / reflex）と画像サンプル（emoawase）について、
 * **実際の view を JSON 化して**バイト数を数え、上限を回帰テストとして固定する。
 * 数字が動いたらこのテストが落ちるので、そのとき設計書の記述も直す。
 *
 * 測り方は rooms.ts の配信そのままの式にした（**実測**: `broadcastPhase` は
 * 接続1本につき `{ t:"gameView", gameId, view, deadline }` を1通送る）。
 */

import { assert, assertEquals } from "@std/assert";
import type { EnginePlayerInput } from "../../engine.ts";
import type { ClientGameState } from "../../games/client.ts";
import { findModuleGame } from "../../games/index.ts";
import type { GameModule } from "../../games/module.ts";

const T0 = 1_700_000_000_000;
const SEED = 20260826;
/** 卓の定員いっぱい（§7 の上限）で測る。ここが最悪ケース */
const SEATS = 10;

/** ニックネームは日本語で長めのものを想定する（UTF-8 で1文字3バイト） */
function players(count: number): EnginePlayerInput[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `player-${String(i).padStart(4, "0")}`,
    nickname: `参加者${i}ばんめ`,
    connected: true,
  }));
}

function moduleOf(id: string): GameModule {
  const found = findModuleGame(id);
  assert(found !== null, `${id} がカタログに無い`);
  return found;
}

/** gameView 1通のバイト数（rooms.ts が実際に送る形をそのまま作る） */
function viewBytes(module: GameModule, state: unknown, viewerId: string): number {
  const msg = {
    t: "gameView",
    gameId: module.id,
    view: module.view(state, viewerId),
    deadline: null,
  };
  return new TextEncoder().encode(JSON.stringify(msg)).length;
}

/**
 * 中継イベントの列を順に流し、卓全体へ配られる総バイト数を積む。
 * 1件の clientEvent につき viewChanged が1回 → 接続数ぶんの gameView が飛ぶ
 */
function simulate(
  id: string,
  events: { from: number; payload: unknown }[],
  seats = SEATS,
): { totalBytes: number; peakViewBytes: number; sends: number } {
  const module = moduleOf(id);
  const roster = players(seats);
  let state = module.init({ players: roster, now: T0, seed: SEED }).state;
  let totalBytes = 0;
  let peakViewBytes = 0;
  let sends = 0;
  for (const event of events) {
    const result = module.reduce(state, {
      t: "clientEvent",
      playerId: roster[event.from].id,
      payload: event.payload,
      now: T0,
    });
    assertEquals(result.error, undefined);
    state = result.state;
    if (!result.effects.some((e) => e.t === "viewChanged")) continue;
    for (const viewer of roster) {
      const bytes = viewBytes(module, state, viewer.id);
      totalBytes += bytes;
      peakViewBytes = Math.max(peakViewBytes, bytes);
      sends += 1;
    }
  }
  return { totalBytes, peakViewBytes, sends };
}

/** 数字を読みやすく出す。テスト出力そのものが「実測値」の出どころになる */
function report(label: string, r: ReturnType<typeof simulate>, seconds: number): void {
  const kb = (n: number) => (n / 1024).toFixed(1);
  console.log(
    `  [実測] ${label}: 配信 ${r.sends}通 / 合計 ${kb(r.totalBytes)}KB / ` +
      `view 1通の最大 ${r.peakViewBytes}B / 平均 ${kb(r.totalBytes / seconds)}KB per 秒` +
      `（${seconds}秒のゲームとして換算）`,
  );
}

// ---------------------------------------------------------------------------

Deno.test("mogura の配信量（10人・1人1件の最終得点だけ）", () => {
  // 30秒のゲームで、終わったときに1人1件だけ送る
  const events = Array.from({ length: SEATS }, (_, i) => ({
    from: i,
    payload: { k: "final", s: 23 },
  }));
  const r = simulate("mogura", events);
  report("mogura", r, 30);
  // 中継が1人1件しか無いので、卓全体で 100 通・数十KB に収まる
  assertEquals(r.sends, SEATS * SEATS);
  assert(r.totalBytes < 120 * 1024, `mogura の配信量が想定より多い: ${r.totalBytes}B`);
  assert(r.peakViewBytes <= 1500, `view 1通が想定より大きい: ${r.peakViewBytes}B`);
});

Deno.test("reflex の配信量（10人・5ラウンド・1人1ラウンド1件）", () => {
  // 全員が毎ラウンド押す最悪ケース。合図の直後に10件が固まって飛ぶ
  const events: { from: number; payload: unknown }[] = [];
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < SEATS; i++) {
      events.push({ from: i, payload: { k: "t", r: round, rt: 210 + i * 7 } });
    }
  }
  const r = simulate("reflex", events);
  report("reflex", r, 50);
  assertEquals(r.sends, 5 * SEATS * SEATS);
  // relayLogMax: 24 に抑えてあるので view 1通は 2KB 台で頭打ちになる
  assert(r.peakViewBytes <= 2600, `view 1通が想定より大きい: ${r.peakViewBytes}B`);
  assert(r.totalBytes < 1_400_000, `reflex の配信量が想定より多い: ${r.totalBytes}B`);
});

Deno.test("emoawase の配信量（10人・1人1件のタイムだけ）", () => {
  const events = Array.from({ length: SEATS }, (_, i) => ({
    from: i,
    payload: { k: "done", ms: 48_000 + i * 1200 },
  }));
  const r = simulate("emoawase", events);
  report("emoawase", r, 90);
  assert(r.totalBytes < 120 * 1024, `emoawase の配信量が想定より多い: ${r.totalBytes}B`);
});

Deno.test("最悪ケース: ゲームごとの payload 上限がファンアウトを頭打ちにする", () => {
  // 改造クライアントは任意の payload を送れる。ルーム層の上限（4KB）だけだと
  // 「4KB × ログ件数 × 人数 × 30件/秒」まで1台で膨らませられるので、
  // ゲームごとの payloadMaxBytes でもう一段絞っている。ここはその抑止の確認
  const module = moduleOf("reflex");
  const roster = players(SEATS);
  const started = module.init({ players: roster, now: T0, seed: SEED }).state;

  // 上限を超える payload は棄却され、中継ログに入らない
  const blob = "あ".repeat(1000); // UTF-8 で 3KB
  const rejected = module.reduce(started, {
    t: "clientEvent",
    playerId: roster[0].id,
    payload: { k: "x", blob },
    now: T0,
  });
  assertEquals(rejected.error, "INVALID_INPUT");
  assertEquals((rejected.state as ClientGameState).events.length, 0);

  // 上限ぎりぎりの payload でログを埋めても、view 1通は小さいままになる
  const fill = "a".repeat(40); // {"k":"x","p":"…40文字…"} で 64B に収まる
  let state = started;
  for (let i = 0; i < 40; i++) {
    const r = module.reduce(state, {
      t: "clientEvent",
      playerId: roster[i % SEATS].id,
      payload: { k: "x", p: fill },
      now: T0,
    });
    assertEquals(r.error, undefined, "上限内の payload が弾かれている");
    state = r.state;
  }
  const bytes = viewBytes(module, state, roster[0].id);
  const log = (state as ClientGameState).events.length;
  console.log(
    `  [実測] 最悪ケース: 中継ログ ${log}件 / view 1通 ${(bytes / 1024).toFixed(1)}KB / ` +
      `1配信（10人）${((bytes * SEATS) / 1024).toFixed(1)}KB`,
  );
  // relayLogMax(24) × payloadMaxBytes(64B) が view の理論上限。1通 8KB を超えない
  assertEquals(log, 24);
  assert(bytes < 8 * 1024, `view 1通が想定より大きい: ${bytes}B`);
});
