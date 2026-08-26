/**
 * ゲームカタログの正本（設計書 docs/design/games-unified.md §4）
 *
 * 新しいゲームを足す手順は「server/games/<id>.ts を書き、下の GAME_MODULES に1行足す」だけ
 * （設計書 §7）。一覧の正本をここ1か所に固定することで、
 * 「どの基盤で作るか」「どの一覧に登録するか」という分岐そのものを無くす。
 */

import type { GameModule } from "./module.ts";
import { promptModule } from "./prompt.ts";

/**
 * 収録しているゲームモジュール。
 * prompt は宣言的データ（Room.availableGames のゲーム定義）を進行させる特別枠で、
 * 一覧には prompt 自身ではなく個々のゲーム定義が並ぶ（設計書 §4）。
 */
export const GAME_MODULES: readonly GameModule[] = [
  promptModule,
];

/** モジュールIDから引く。未知のIDは null */
export function findGameModule(id: string): GameModule | null {
  return GAME_MODULES.find((m) => m.id === id) ?? null;
}
