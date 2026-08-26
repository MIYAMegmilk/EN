/**
 * クライアント専用ゲームの受け皿（設計書 docs/design/games-unified.md）
 *
 * 「画像を置いて、普通のブラウザゲームを書いたら動く」ための経路。
 * ゲーム作者はサーバーのコードを **一切書かない**。書くのは
 * `public/room/games/<id>.js`（表示と進行）だけで、登録は
 * `server/games/index.ts` の `GAME_MODULES` に `clientGame({ ... })` を1行足すだけ。
 *
 * ここが返すのは、既存の `GameModule`（kind: "module"）そのものである。
 * つまり ルーム層（rooms.ts）・プロトコル（types.ts）・配信（main.ts）には
 * 一切手を入れずに、既存のライフサイクルがそのまま効く:
 *   selectGame → startGame → gameView 配信 → 途中参加 / 切断 / 再接続 /
 *   ホスト交代 / キック / minPlayers 割れでの中断 / ホストによる終了
 *
 * ---- この経路の定義（守れないものは書き換えではなく別の経路を使う）----
 *
 * 1. **秘密は持てない。** 中継したイベントは同じ卓の全員へそのまま配られる。
 *    「正解を隠す」「役職を配る」「他人に見えない情報を持つ」は **構造的に不可能**。
 *    そう思った時点で `server/games/<id>.ts`（専用モジュール）が要る。
 * 2. **得点はサーバーが関与しない。** `score` 効果を一切出さないので、
 *    ここで作るゲームの点は自己申告であり、公式スコア（Player.score）に載らない。
 * 3. **履歴の完全復元は保証しない。** 中継ログは直近 `relayLogMax` 件だけ。
 *    途中参加・再接続した人は、それ以前のイベントを受け取れない。
 * 4. **サーバーは payload を解釈しない。** 検証するのはサイズ・件数・レートだけ。
 *    改造クライアントは任意の値を送れるので、**受け取る側のゲームコードが
 *    形を確かめてから使う**こと（public/room/games/_template.js の規約）。
 *
 * 進行の同期が要るゲームは、まず **seed から各自で導けないか**を考える。
 * view の `seed` と `startedAt` は卓の全員で同じ値なので、
 * 「何秒後に合図を出すか」「どの順で出題するか」は通信なしで一致させられる。
 * 中継は「人に見せたい結果」（自分のスコア・自分の反応時間）だけに使うと軽い。
 */

import type { EnginePlayerInput } from "../engine.ts";
import { GAME_EVENT_PAYLOAD_MAX_BYTES } from "../types.ts";
import type { GameModule, ModuleEvent, ModuleResult } from "./module.ts";
import { moduleFail, moduleNoop, moduleOk } from "./module.ts";

/** 中継ログに残すイベント件数の既定値。【暫定値】: view 1通の大きさを抑えるための上限 */
export const CLIENT_RELAY_LOG_DEFAULT = 32;

/** 中継ログの上限として指定できる最大件数。【暫定値】 */
export const CLIENT_RELAY_LOG_MAX = 128;

/**
 * 中継 payload 1件の直列化サイズの既定上限（バイト）。【暫定値】
 *
 * ルーム層の `GAME_EVENT_PAYLOAD_MAX_BYTES`（4KB）より **ずっと小さくしてある**。
 * この経路は `clientEvent` 1件ごとに接続数ぶんの `gameView` を配り、その1通に
 * 中継ログ全件が載る（§2.8.2 の配信量）。4KB を許すと
 * 「4KB × ログ件数 × 人数 × 30件/秒」まで**改造クライアント1台で**膨らませられる。
 * 正規のクライアント専用ゲームが送るのは「自分の得点」「自分の反応時間」程度なので、
 * 既定を 256B に絞り、必要なゲームだけ spec で明示的に広げる
 */
export const CLIENT_PAYLOAD_MAX_BYTES_DEFAULT = 256;

/** クライアント専用ゲーム1本の宣言。index.ts に書くのはこれだけ */
export type ClientGameSpec = {
  /** ゲームID。`public/room/games/<id>.js` のファイル名と一致させる（英小文字・数字・_・-） */
  id: string;
  /** タイトル。20文字以内 */
  title: string;
  /** 説明。100文字以内 */
  description: string;
  /** 開始に必要な最少人数。1..10 */
  minPlayers: number;
  /** 参加できる最大人数。minPlayers..10 */
  maxPlayers: number;
  /**
   * 参加者間の中継に使うログの件数。
   * 0 を渡すと中継そのものを断る（1人で完結するゲーム向け。gameEvent は INVALID_INPUT）。
   * 省略時は CLIENT_RELAY_LOG_DEFAULT
   */
  relayLogMax?: number;
  /**
   * 中継 payload 1件の直列化サイズ上限（バイト）。
   * 省略時は CLIENT_PAYLOAD_MAX_BYTES_DEFAULT（256B）。
   * 上限は共通の GAME_EVENT_PAYLOAD_MAX_BYTES（4KB）で、それより大きい値は丸める。
   *
   * **「view 1通の最大 ≒ relayLogMax × payloadMaxBytes」** になるので、
   * この2つの積がそのままファンアウトの上限になる。必要な分だけ広げること
   */
  payloadMaxBytes?: number;
};

/** 中継された1件。payload の中身はサーバーにとって不透明 */
export type RelayEvent = {
  /** 連番（1 始まり）。クライアントは「前回より大きいもの」だけを処理する */
  n: number;
  /** 送信者の playerId */
  from: string;
  /** 送信者が送った payload そのまま（サーバーは解釈しない） */
  payload: unknown;
};

/** 卓の名簿の1件。ニックネームはユーザー由来なので、表示側は必ず textContent で描く */
export type RelayPlayer = {
  id: string;
  name: string;
  connected: boolean;
};

/** クライアント専用ゲームの state。中身の意味はすべてこのファイルに閉じている */
export type ClientGameState = {
  /** 卓の全員で同じ乱数の種。決定的な進行をクライアント側で一致させるために配る */
  seed: number;
  /** 開始時刻（epoch ms）。経過時間の基準 */
  startedAt: number;
  /** 名簿 */
  players: RelayPlayer[];
  /** 次に振る連番 */
  seq: number;
  /** 中継ログ（古い順）。長さは relayLogMax 以下 */
  events: RelayEvent[];
  /** 終了したか。終了後に届いたイベントは受け付けない */
  ended: boolean;
  /** このゲームの中継ログ上限（spec のコピー。reduce を純粋関数のままにするため） */
  relayLogMax: number;
  /** このゲームの中継 payload の上限（バイト。spec のコピー） */
  payloadMaxBytes: number;
};

/** 表示側（public/room/games/<id>.js）へ配る view */
export type ClientGameView = {
  seed: number;
  startedAt: number;
  players: RelayPlayer[];
  events: RelayEvent[];
  ended: boolean;
};

/** 名簿の1件を作る */
function toRelayPlayer(p: EnginePlayerInput): RelayPlayer {
  return { id: p.id, name: p.nickname, connected: p.connected };
}

/**
 * 在籍者数。**切断中（connected: false）の人も数える。**
 *
 * 切断には60秒の猶予があり（§3.2）、その間は席が残っている。
 * 猶予が切れればルーム層が `playerKicked` を流してくるので、そのとき在籍から外れて
 * minPlayers 割れの判定に掛かる。chicken.ts の `next.order.length` と同じ数え方
 */
function enrolledCount(players: readonly RelayPlayer[]): number {
  return players.length;
}

/** payload の直列化サイズが上限を超えるか。直列化できない値は超過と同じ扱いにする */
function payloadExceedsLimit(payload: unknown, maxBytes: number): boolean {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    return true;
  }
  // undefined は JSON.stringify が undefined を返す。中継しても意味が無いので棄却する
  if (typeof json !== "string") return true;
  return new TextEncoder().encode(json).length > maxBytes;
}

/**
 * クライアント専用ゲームを1本、GameModule として組み立てる。
 *
 * 返るのは普通の GameModule なので、`server/games/index.ts` の GAME_MODULES に
 * 並べればカタログ・開始経路・配信がそのまま通る（設計書 §4）。
 */
export function clientGame(spec: ClientGameSpec): GameModule<ClientGameState, ClientGameView> {
  const relayLogMax = clampRelayLogMax(spec.relayLogMax);
  const payloadMaxBytes = clampPayloadMaxBytes(spec.payloadMaxBytes);

  /** minPlayers を割ったら中断する（設計書 §5） */
  function endIfTooFew(state: ClientGameState): ModuleResult<ClientGameState> | null {
    if (enrolledCount(state.players) >= spec.minPlayers) return null;
    const next: ClientGameState = { ...state, ended: true };
    return moduleOk(next, [
      { t: "viewChanged" },
      { t: "ended", reason: "tooFewPlayers" },
    ]);
  }

  return {
    id: spec.id,
    kind: "module",
    meta: {
      title: spec.title,
      description: spec.description,
      minPlayers: spec.minPlayers,
      maxPlayers: spec.maxPlayers,
    },

    init(input) {
      return moduleOk(
        {
          seed: input.seed,
          startedAt: input.now,
          players: input.players.map(toRelayPlayer),
          seq: 0,
          events: [],
          ended: false,
          relayLogMax,
          payloadMaxBytes,
        },
        [{ t: "viewChanged" }],
      );
    },

    reduce(state, event) {
      // 終了後に届いたものは黙って捨てる。ただし在籍から消える playerKicked だけは
      // 名簿を直すために通す（chicken.ts と同じ扱い）
      if (state.ended && event.t !== "playerKicked") return moduleNoop(state);
      return reduceClientGame(state, event, spec, endIfTooFew);
    },

    view(state) {
      // 受信者ごとの絞り込みは無い（＝秘密を持てない。この経路の定義そのもの）。
      // relayLogMax を view から外しているのは、表示に使わない内部値だから
      return {
        seed: state.seed,
        startedAt: state.startedAt,
        players: state.players,
        events: state.events,
        ended: state.ended,
      };
    },
  };
}

/** relayLogMax を 0..CLIENT_RELAY_LOG_MAX に収める */
function clampRelayLogMax(value: number | undefined): number {
  if (value === undefined) return CLIENT_RELAY_LOG_DEFAULT;
  if (!Number.isInteger(value) || value < 0) return CLIENT_RELAY_LOG_DEFAULT;
  return Math.min(value, CLIENT_RELAY_LOG_MAX);
}

/** payloadMaxBytes を 1..GAME_EVENT_PAYLOAD_MAX_BYTES に収める */
function clampPayloadMaxBytes(value: number | undefined): number {
  if (value === undefined) return CLIENT_PAYLOAD_MAX_BYTES_DEFAULT;
  if (!Number.isInteger(value) || value < 1) return CLIENT_PAYLOAD_MAX_BYTES_DEFAULT;
  return Math.min(value, GAME_EVENT_PAYLOAD_MAX_BYTES);
}

/**
 * イベントを1件処理する。clientGame の中に書くと入れ子が深くなるので外に出した。
 * spec / endIfTooFew を引数で受け取るだけで、外部の状態には触らない（純粋関数）
 */
function reduceClientGame(
  state: ClientGameState,
  event: ModuleEvent,
  spec: ClientGameSpec,
  endIfTooFew: (s: ClientGameState) => ModuleResult<ClientGameState> | null,
): ModuleResult<ClientGameState> {
  switch (event.t) {
    case "clientEvent": {
      if (state.relayLogMax === 0) {
        return moduleFail(state, "INVALID_INPUT", "このあそびは中継を使いません");
      }
      // 在籍していない人からのイベントは中継しない（キック直後の取りこぼし対策）
      if (!state.players.some((p) => p.id === event.playerId)) {
        return moduleFail(state, "PHASE_MISMATCH", "この卓の参加者ではありません");
      }
      // ログ全件が view 1通に載るので、payload の大きさがそのままファンアウトに効く。
      // ルーム層の 4KB とは別に、ゲームごとの上限でもう一段絞る
      if (payloadExceedsLimit(event.payload, state.payloadMaxBytes)) {
        return moduleFail(state, "INVALID_INPUT", "ゲーム内イベントが大きすぎます");
      }
      const n = state.seq + 1;
      const events = [...state.events, { n, from: event.playerId, payload: event.payload }];
      // 上限を超えたぶんは古い順に捨てる。捨てた分は復元されない（この経路の定義3）
      const trimmed = events.length > state.relayLogMax
        ? events.slice(events.length - state.relayLogMax)
        : events;
      return moduleOk({ ...state, seq: n, events: trimmed }, [{ t: "viewChanged" }]);
    }

    case "chatMessage":
      // チャットはゲームに関係しない。伏せずにそのまま卓へ流す
      return moduleNoop(state);

    case "timeout":
      // schedule を一度も返さないので、ここには来ない想定。来ても何もしない
      return moduleNoop(state);

    case "playerJoined": {
      if (state.players.some((p) => p.id === event.playerId)) return moduleNoop(state);
      // 定員を超える参加は名簿に載せない（卓の定員はルーム層が別に見ている）
      if (state.players.length >= spec.maxPlayers) return moduleNoop(state);
      const players = [
        ...state.players,
        { id: event.playerId, name: event.nickname, connected: true },
      ];
      return moduleOk({ ...state, players }, [{ t: "viewChanged" }]);
    }

    case "playerLeft": {
      // 切断は60秒の猶予がある（§3.2）。在籍は残したまま connected だけ倒す。
      // 在籍から本当に消えるときは、ルーム層が続けて playerKicked を流してくる
      const target = state.players.find((p) => p.id === event.playerId);
      if (target === undefined || !target.connected) return moduleNoop(state);
      const players = state.players.map((p) =>
        p.id === event.playerId ? { ...p, connected: false } : p
      );
      return moduleOk({ ...state, players }, [{ t: "viewChanged" }]);
    }

    case "playerRejoined": {
      const target = state.players.find((p) => p.id === event.playerId);
      if (target === undefined || target.connected) return moduleNoop(state);
      const players = state.players.map((p) =>
        p.id === event.playerId ? { ...p, connected: true } : p
      );
      return moduleOk({ ...state, players }, [{ t: "viewChanged" }]);
    }

    case "playerKicked": {
      const players = state.players.filter((p) => p.id !== event.playerId);
      if (players.length === state.players.length) return moduleNoop(state);
      // キックされた人が残したイベントも消す（卓から痕跡を消す。§5）
      const events = state.events.filter((e) => e.from !== event.playerId);
      const next: ClientGameState = { ...state, players, events };
      if (next.ended) return moduleOk(next, [{ t: "viewChanged" }]);
      const ending = endIfTooFew(next);
      if (ending !== null) return ending;
      return moduleOk(next, [{ t: "viewChanged" }]);
    }

    // ホストの「すすめる」と「終了」はどちらもゲームを終わらせる。
    //
    // クライアント専用ゲームはフェーズを持たないので、skipPhase に「飛ばす先」が無い。
    // ここを何もしない扱いにすると、**卓が playing のまま二度とロビーへ戻れなくなる**
    // （**実測**: rooms.ts が C2S から流すホスト操作は skipPhase だけで、endGame を
    // 流す経路が無い。`grep -n '"endGame"' server/rooms.ts` は0件）。
    // したがって skipPhase を「このあそびを終わる」と読み替える
    case "skipPhase":
    case "endGame":
      return moduleOk({ ...state, ended: true }, [
        { t: "viewChanged" },
        { t: "ended", reason: "hostEnded" },
      ]);
  }
}
