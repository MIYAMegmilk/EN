/**
 * ゲームカタログの正本（設計書 docs/design/games-unified.md §4）
 *
 * 新しいゲームを足す手順は、どちらの作り方でも「**下の GAME_MODULES に1行足す**」だけ
 * （設計書 §7）。一覧の正本をここ1か所に固定することで、
 * 「どの一覧に登録するか」という分岐そのものを無くす。
 *
 * - **クライアント専用ゲーム**（既定）: `public/room/games/<id>.js` を書き、
 *   ここに `clientGame({ id, title, ... })` を1行足す。サーバーのコードは書かない
 * - **専用サーバーモジュール**: 秘密配布・公式スコア・状態の完全復元が要るときだけ。
 *   `server/games/<id>.ts` に GameModule を実装し、ここにその module を1行足す
 */

import { chickenModule } from "./chicken.ts";
import { clientGame } from "./client.ts";
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
  // --- ここから下はクライアント専用ゲーム（サーバー側の実装は無い。設計書 §7.1）---
  // relayLogMax は「同時に飛び交いうるイベント件数」、payloadMaxBytes は「1件の大きさ」。
  // **この2つの積が view 1通の上限**になり、そのまま配信量（fan-out）に効くので、
  // どちらもゲームが実際に必要とする分だけに絞る（設計書 §2.8.2 の実測を参照）
  clientGame({
    id: "mogura",
    title: "もぐらたたき",
    description: "3×3のマスに出るもぐらを叩く。30秒で得点を競う（点は付かない）",
    minPlayers: 1,
    maxPlayers: 10,
    // 送るのは1人1回の最終得点 { k:"final", s } だけ。10人ぶん入れば足りる
    relayLogMax: 12,
    payloadMaxBytes: 64,
  }),
  clientGame({
    id: "reflex",
    title: "反射神経バトル",
    description: "緑になったら押す。全5ラウンドで反応速度を競う（点は付かない）",
    minPlayers: 2,
    maxPlayers: 10,
    // 1ラウンドに1人1件 { k:"t", r, rt }。10人が同時に押しても1ラウンドぶんは収まる
    relayLogMax: 24,
    payloadMaxBytes: 64,
  }),
  clientGame({
    id: "emoawase",
    title: "絵合わせ",
    description: "同じ絵の札を2枚めくって取る。全員同じ盤で速さを競う（点は付かない）",
    minPlayers: 1,
    maxPlayers: 10,
    // 送るのは1人1回のタイム { k:"done", ms } だけ
    relayLogMax: 12,
    payloadMaxBytes: 64,
  }),
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
