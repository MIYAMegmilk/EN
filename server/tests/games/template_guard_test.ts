/**
 * server/games/_template.ts（新しいゲームを作るときにコピーする雛形）のテスト。
 *
 * 雛形はカタログ（index.ts）に登録されないので卓では動かないが、設計書 §7 が
 * 「これをコピーして新ゲームを作る」と定めた**正本**である。ここが規約を破っていると、
 * 次に作られるゲームへそのまま伝播する。
 *
 * 眼目は監査 M-2 の「終了後ガード」。
 * ゲームが終わったあとにキックが起きると `reduce` 冒頭の早期 return は playerKicked だけ
 * 通すため、そのまま minPlayers 判定へ落とすと `finish()` が二度走り、
 * `{ t: "score" }` が2回出る。ルーム層は score を受けるたびに `Player.score` へ
 * 加算する（rooms.ts の applyEffects）ので、公式スコアが二重に入る。
 * 実装済みの4本（chicken / wordwolf / hayaoshi / draw）はいずれもこのガードを持つ。
 */

import { assertEquals } from "@std/assert";
import type { EnginePlayerInput } from "../../engine.ts";
import { templateModule } from "../../games/_template.ts";
import type { ModuleEffect, ModuleEvent, ModuleResult } from "../../games/module.ts";

const T0 = 1_700_000_000_000;
const SEED = 20260827;

/** テスト用の参加者を作る */
function players(...ids: string[]): EnginePlayerInput[] {
  return ids.map((id) => ({ id, nickname: `nick-${id}`, connected: true }));
}

// 雛形の state 型は export されていない（コピー元なので外から使わせない）。
// テストからは「モジュールが返した state をそのまま次へ渡す」だけなので、
// 中身を知る必要のないところは unknown のまま持ち回る
// deno-lint-ignore no-explicit-any
type State = any;

/** ゲームを開始する */
function start(ids: string[], now = T0): State {
  const result = templateModule.init({ players: players(...ids), now, seed: SEED });
  assertEquals(result.error, undefined);
  return result.state;
}

/** イベントを1件流す（結果ごと返す） */
function run(state: State, event: ModuleEvent): ModuleResult<State> {
  return templateModule.reduce(state, event);
}

/** 効果のうち種類が一致するものを数える */
function countEffect(effects: ModuleEffect[], t: ModuleEffect["t"]): number {
  return effects.filter((e) => e.t === t).length;
}

Deno.test("雛形: 終了時に score と ended を1回ずつ出し、予約を解除する（規約7・8）", () => {
  const state = start(["a", "b", "c"]);
  const ended = run(state, { t: "skipPhase", now: T0 + 1 });
  assertEquals(ended.error, undefined);
  assertEquals(ended.state.running, false);
  assertEquals(countEffect(ended.effects, "score"), 1);
  assertEquals(countEffect(ended.effects, "ended"), 1);
  const schedule = ended.effects.find((e) => e.t === "schedule");
  assertEquals(schedule?.t === "schedule" ? schedule.at : "なし", null);
});

Deno.test("雛形: 終了後のキックでは score を出さない（公式スコアの二重加算を防ぐ）", () => {
  // 3人で始めて終了 → そのあと1人キックされると在籍は2人。
  // minPlayers（2）は割らないが、ガードが無いと「終了後にもう一度 finish」の経路が開く
  const state = start(["a", "b", "c"]);
  const ended = run(state, { t: "skipPhase", now: T0 + 1 });
  assertEquals(countEffect(ended.effects, "score"), 1);

  const kicked = run(ended.state, { t: "playerKicked", playerId: "c", now: T0 + 2 });
  assertEquals(kicked.error, undefined);
  // 名簿からは消える（キックされた人の痕跡を残さない）
  assertEquals(kicked.state.order, ["a", "b"]);
  assertEquals(kicked.state.nicknames.c, undefined);
  // 終わったゲームは終わったまま。score も ended も二度目は出さない
  assertEquals(kicked.state.running, false);
  assertEquals(countEffect(kicked.effects, "score"), 0, "終了後の score が二重に出ている");
  assertEquals(countEffect(kicked.effects, "ended"), 0);
  assertEquals(countEffect(kicked.effects, "viewChanged"), 1);
});

Deno.test("雛形: 終了後に minPlayers を割るキックでも score を出さない（境界値）", () => {
  // 2人 → 1人。**在籍が minPlayers を割る**ので、ガードが無ければ必ず finish へ落ちる
  const state = start(["a", "b"]);
  const ended = run(state, { t: "endGame", now: T0 + 1 });
  assertEquals(countEffect(ended.effects, "score"), 1);

  const kicked = run(ended.state, { t: "playerKicked", playerId: "b", now: T0 + 2 });
  assertEquals(kicked.state.order, ["a"]);
  assertEquals(kicked.state.running, false);
  assertEquals(countEffect(kicked.effects, "score"), 0, "終了後の score が二重に出ている");
  assertEquals(countEffect(kicked.effects, "ended"), 0);
});

Deno.test("雛形: 進行中のキックは従来どおり。minPlayers を割ったら1回だけ終わる（正常系）", () => {
  const state = start(["a", "b"]);
  const kicked = run(state, { t: "playerKicked", playerId: "b", now: T0 + 1 });
  assertEquals(kicked.state.running, false);
  assertEquals(countEffect(kicked.effects, "score"), 1);
  const ended = kicked.effects.find((e) => e.t === "ended");
  assertEquals(ended?.t === "ended" ? ended.reason : null, "tooFewPlayers");

  // さらにもう1人キックされても、二度目の score は出ない
  const again = run(kicked.state, { t: "playerKicked", playerId: "a", now: T0 + 2 });
  assertEquals(countEffect(again.effects, "score"), 0, "終了後の score が二重に出ている");
});

Deno.test("雛形: 在籍していない人のキックは何もしない（異常系）", () => {
  const state = start(["a", "b", "c"]);
  const result = run(state, { t: "playerKicked", playerId: "zzz", now: T0 + 1 });
  assertEquals(result.changed, false);
  assertEquals(result.effects, []);
  assertEquals(result.state.order, ["a", "b", "c"]);
});
