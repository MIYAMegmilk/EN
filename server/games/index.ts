/**
 * ゲームカタログの正本（設計書 docs/design/games-unified.md §4）
 *
 * 新しいゲームを足す手順は「server/games/<id>.ts を書き、下の GAME_MODULES に1行足す」だけ
 * （設計書 §7）。一覧の正本をここ1か所に固定することで、
 * 「どの基盤で作るか」「どの一覧に登録するか」という分岐そのものを無くす。
 */

import { chickenModule } from "./chicken.ts";
import { drawModule } from "./draw.ts";
import { hayaoshiModule } from "./hayaoshi.ts";
import type { GameModule } from "./module.ts";
import { promptModule } from "./prompt.ts";
import { wordWolfModule } from "./wordwolf.ts";

/**
 * 収録しているゲームモジュール。
 * prompt は宣言的データ（Room.availableGames のゲーム定義）を進行させる特別枠で、
 * 一覧には prompt 自身ではなく個々のゲーム定義が並ぶ（設計書 §4）。
 */
export const GAME_MODULES: readonly GameModule[] = [
  promptModule,
  chickenModule,
  drawModule,
  wordWolfModule,
  hayaoshiModule,
];

/**
 * 専用モジュール型のゲーム（kind:"module"）だけを並べたもの。
 * ルーム層はこれを一覧（RoomSnapshot.availableGames）へ宣言的ゲームと並べて出し、
 * selectGame / startGame の宛先として引く（設計書 §4）
 */
export const MODULE_GAMES: readonly GameModule[] = GAME_MODULES.filter(
  (m) => m.kind === "module",
);

/** モジュールIDから引く。未知のIDは null */
export function findGameModule(id: string): GameModule | null {
  return GAME_MODULES.find((m) => m.id === id) ?? null;
}

/** 専用モジュール型のゲームをIDから引く。prompt・未知のIDは null */
export function findModuleGame(id: string): GameModule | null {
  return MODULE_GAMES.find((m) => m.id === id) ?? null;
}
