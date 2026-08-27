/**
 * ゲームモジュールの雛形（設計書 docs/design/games-unified.md §7 手順2）
 *
 * 新しいゲームを作るときは、このファイルを `server/games/<id>.ts` にコピーして
 * `TemplateState` / `templateModule` を書き換える。
 * このファイル自体はカタログ（index.ts）に登録しない（雛形なので動かさない）。
 *
 * ---------------------------------------------------------------------------
 * 規約（守れていないと PR レビューで差し戻す。§7 のチェックリストと対応する）
 * ---------------------------------------------------------------------------
 * 1. **純粋関数**: init / reduce / view は I/O を持たず、内部で await を使わない。
 *    外部要因（時刻・参加者の増減・タイマー発火）はすべて引数の ModuleEvent で受け取る。
 * 2. **入力 state を変更しない**: 必ず新しいオブジェクトを作って返す（スプレッドで浅く複製）。
 * 3. **`Math.random()` 禁止**: 乱数は init で受け取った seed を state に持ち、
 *    module.ts の nextSeed / randomInt / shuffle で決定的に進める（§2.5）。
 *    テストの再現性のためであり、例外は認めない。
 * 3-a. **秘密を持つモジュールは seed を view に出さない**: seed を state に持つのは正しいが、
 *    view へ載せてはならない。乱数の消費順序はソースに書いてあるので、seed が1つ漏れれば
 *    狼・お題・正解・出題順はすべて決定的に計算できる（`view(state, viewerId)` で
 *    誰に何を見せるか絞っても、seed が載っていれば意味が無い）。
 *    `deadline` や参加者の並びなど、view に載る値から seed を逆算できる作りにもしないこと
 *    （ルーム層は seed を暗号論的乱数で作る。`rooms.ts` の `randomGameSeed` を参照）。
 *    **例外はクライアント専用ゲーム（`games/client.ts` 経路）だけ**で、そちらは
 *    「サーバーが秘密を持たない・全員が同じ seed から同じ進行を各自で導く」ことが
 *    経路の定義そのものなので、seed と startedAt を全員へ配るのが正しい。
 *    この雛形（秘密を持ちうる専用モジュール）はその例外に当たらない。
 * 4. **`Date.now()` 禁止**: 時刻は event.now / input.now を使う。
 * 5. **payload は先頭で型検証**: clientEvent.payload は unknown。readKind / readInt /
 *    readString などで検証し、少しでも形が違えば INVALID_INPUT で棄却する（§9.1）。
 * 6. **秘密は view で絞る**: 正解・役職・他人の入力中の値は state にだけ置き、
 *    view(state, viewerId) が受信者ごとに出し分ける（§2.6）。
 *    「クライアントが表示しなければよい」は秘密の保持にならない。
 *    **seed もこの「秘密」に含まれる**（規約3-a）。
 * 7. **schedule の後始末**: 終了時に `{ t: "schedule", at: null }` を出して予約を解除する。
 *    解除し忘れても timeout で壊れないように reduce を書く（終了後の timeout は無視する）。
 * 8. **score は1ゲーム1回**: 公式スコアへの加算はゲーム終了時にまとめて1回だけ出す。
 *    そのために **`playerKicked` は終了後にも届く**ことを忘れないこと（reduce 冒頭の
 *    早期 return は playerKicked だけ通す）。名簿から抜いたあとの minPlayers 判定へ
 *    そのまま落とすと、終了済みのゲームで `finish()` がもう一度走り、`{ t: "score" }` が
 *    2回出て `Player.score` が二重に加算される。**minPlayers を見る前に
 *    `if (!next.running) return moduleOk(next, [{ t: "viewChanged" }]);` を必ず置く**
 *    （実装済みの4本 chicken / wordwolf / hayaoshi / draw はいずれもこの形）。
 */

import {
  type GameModule,
  isRecord,
  type ModuleEvent,
  moduleFail,
  type ModuleInitInput,
  moduleNoop,
  moduleOk,
  type ModuleResult,
  nextSeed,
  readKind,
} from "./module.ts";

/** このゲームの全状態。ルーム層はこの中身を知らない */
type TemplateState = {
  /** 乱数の種。使うたびに nextSeed で進める（§2.5） */
  seed: number;
  /** 進行中か。終了後のイベントを無視するために持つ */
  running: boolean;
  /** 参加者の playerId（並び順は同点時の安定化に使う） */
  order: string[];
  /** playerId → 表示名 */
  nicknames: Record<string, string>;
  /** playerId → 得点 */
  scores: Record<string, number>;
  /** 現フェーズの期限（epoch ms）。期限なしは null */
  deadline: number | null;
};

/** 受信者へ配る表示データ。秘密を含めないこと（seed も載せない。規約3-a） */
type TemplateView = {
  running: boolean;
  /** 自分の得点だけを載せる例。他人の得点を見せたいなら明示的に足す */
  myScore: number;
};

/** 1ラウンドの制限時間（ミリ秒）。【暫定値】実プレイで調整する */
const ROUND_MS = 30_000;

/** 状態を浅く複製する（規約2） */
function clone(state: TemplateState): TemplateState {
  return {
    ...state,
    order: [...state.order],
    nicknames: { ...state.nicknames },
    scores: { ...state.scores },
  };
}

export const templateModule: GameModule<TemplateState> = {
  /** ファイル名と同じID。カタログ（index.ts）へ登録するときのキーになる */
  id: "_template",
  /** 専用のビューモジュール（public/room/games/<id>.js）を持つなら "module" */
  kind: "module",
  meta: {
    title: "雛形",
    description: "新しいゲームを作るときにコピーする雛形。カタログには登録しない",
    minPlayers: 2,
    maxPlayers: 10,
  },

  init(input: ModuleInitInput): ModuleResult<TemplateState> {
    const order: string[] = [];
    const nicknames: Record<string, string> = {};
    const scores: Record<string, number> = {};
    for (const p of input.players) {
      if (nicknames[p.id] !== undefined) continue;
      order.push(p.id);
      nicknames[p.id] = p.nickname;
      scores[p.id] = 0;
    }
    const state: TemplateState = {
      seed: nextSeed(input.seed),
      running: true,
      order,
      nicknames,
      scores,
      deadline: input.now + ROUND_MS,
    };
    return moduleOk(state, [
      { t: "viewChanged" },
      { t: "schedule", at: state.deadline },
    ]);
  },

  reduce(state: TemplateState, event: ModuleEvent): ModuleResult<TemplateState> {
    // 終了後に届いたイベントは黙って捨てる（規約7）
    if (!state.running && event.t !== "playerKicked") return moduleNoop(state);

    switch (event.t) {
      case "clientEvent": {
        // 規約5: payload は必ずここで型検証する
        if (!isRecord(event.payload)) {
          return moduleFail(state, "INVALID_INPUT", "ゲーム内イベントの形式が正しくありません");
        }
        switch (readKind(event.payload)) {
          case "tap": {
            const next = clone(state);
            next.scores[event.playerId] = (next.scores[event.playerId] ?? 0) + 1;
            return moduleOk(next, [{ t: "viewChanged" }]);
          }
          default:
            return moduleFail(state, "INVALID_INPUT", "未知のゲーム内イベントです");
        }
      }
      case "chatMessage": {
        // チャット発言。ゲームが進行している間だけ届く。
        // 「回答をチャットに書く」ゲーム（お絵かき当てなど）だけが使う入口で、
        // 使わないなら無視してよい。答えを卓から隠したいときは
        // effects に { t: "suppressChat" } を返すと、その発言は配信されない
        return moduleNoop(state);
      }
      case "timeout": {
        // 期限に達していなければ何もしない（早すぎる発火への防御）
        if (state.deadline === null || event.now < state.deadline) return moduleNoop(state);
        return finish(state, "completed");
      }
      case "playerJoined": {
        // 既定は観戦（得点表に入れない）。途中参加を認めるならここで足す
        return moduleNoop(state);
      }
      case "playerLeft":
      case "playerRejoined":
        return moduleNoop(state);
      case "playerKicked": {
        if (state.nicknames[event.playerId] === undefined) return moduleNoop(state);
        const next = clone(state);
        next.order = next.order.filter((id) => id !== event.playerId);
        delete next.nicknames[event.playerId];
        delete next.scores[event.playerId];
        // 終了後のキックは名簿を直すだけ（規約8）。ここを抜けて minPlayers 判定へ落とすと
        // finish() が二度走り、score が二重に加算される
        if (!next.running) return moduleOk(next, [{ t: "viewChanged" }]);
        // minPlayers を割ったら終了する（§5）
        if (next.order.length < templateModule.meta.minPlayers) {
          return finish(next, "tooFewPlayers");
        }
        return moduleOk(next, [{ t: "viewChanged" }]);
      }
      case "skipPhase":
        return finish(state, "completed");
      case "endGame":
        return finish(state, "hostEnded");
    }
  },

  view(state: TemplateState, viewerId: string): TemplateView {
    return {
      running: state.running,
      myScore: state.scores[viewerId] ?? 0,
    };
  },
};

/** ゲームを終える。score は1回だけ、schedule は必ず解除する（規約7・8） */
function finish(
  state: TemplateState,
  reason: "completed" | "tooFewPlayers" | "hostEnded",
): ModuleResult<TemplateState> {
  const next = clone(state);
  next.running = false;
  next.deadline = null;
  const totals = next.order.map((id) => ({
    playerId: id,
    nickname: next.nicknames[id] ?? "",
    roundScore: next.scores[id] ?? 0,
    totalScore: next.scores[id] ?? 0,
    rank: 0,
  }));
  // 得点の降順に並べ、同点は同順位にする（engine.ts の buildScoreEntries と同じ規則）
  totals.sort((a, b) => b.totalScore - a.totalScore);
  let rank = 0;
  let prev: number | null = null;
  totals.forEach((row, index) => {
    if (prev === null || row.totalScore !== prev) {
      rank = index + 1;
      prev = row.totalScore;
    }
    row.rank = rank;
  });
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: null },
    { t: "score", totals },
    { t: "ended", reason },
  ]);
}
