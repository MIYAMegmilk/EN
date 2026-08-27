/**
 * チキンレース（設計書 docs/design/games-unified.md §8 #5）
 *
 * 全員が 0〜100 の整数を1つ**他人に見えない状態で**提出し、全員の提出後に一斉公開する。
 * 他の誰とも被らなかった数字のうち最大を出した人がそのラウンドの勝者で、
 * 被った数字は全員無効になる。既定3ラウンドを行い、勝利ラウンド数で最終順位を決める。
 *
 * このゲームの肝は「提出中は他人の数字が絶対に view に載らない」ことにある（§2.6）。
 * 数字は state にだけ置き、view(state, viewerId) が自分の分しか返さないので、
 * 改造クライアントでも他人の数字は見えない（そもそも受信していない）。
 *
 * 規約は _template.ts の冒頭にまとめてある（純粋関数・Math.random() 禁止・
 * Date.now() 禁止・payload は先頭で型検証・schedule の後始末・score は1ゲーム1回）。
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
  readInt,
  readKind,
} from "./module.ts";
import type { ScoreEntry } from "../types.ts";

/** カタログ上のモジュールID */
export const CHICKEN_MODULE_ID = "chicken";

/** 提出できる数字の下限・上限（ルール上の定数） */
export const CHICKEN_MIN_VALUE = 0;
export const CHICKEN_MAX_VALUE = 100;

/** 既定のラウンド数。【暫定値】実プレイで調整する */
const TOTAL_ROUNDS = 3;

/** 提出フェーズの制限時間（ミリ秒）。【暫定値】 */
const SUBMIT_MS = 30_000;

/** 一斉公開の表示時間（ミリ秒）。【暫定値】engine.ts の roundResultSec と同じ狙い */
const REVEAL_MS = 8_000;

/** 最終結果の表示時間（ミリ秒）。【暫定値】 */
const FINAL_MS = 10_000;

/** 進行フェーズ。submit=提出中（秘密）/ reveal=一斉公開 / final=最終結果 */
type ChickenPhase = "submit" | "reveal" | "final";

/** 参加者1人の状態 */
type ChickenPlayer = {
  id: string;
  nickname: string;
  /** 接続中か。切断中の人は「全員提出したか」の判定から外す（§8 の完了判定と同じ扱い） */
  connected: boolean;
};

/** 公開後の1人分の結果 */
export type ChickenResultEntry = {
  playerId: string;
  nickname: string;
  /** 提出した数字。未提出は null */
  value: number | null;
  /** 他の誰とも被らなかったか。未提出は false */
  unique: boolean;
  /** そのラウンドの勝者か */
  won: boolean;
};

/** 1ラウンドの公開結果 */
export type ChickenRoundResult = {
  round: number;
  /** 勝者。全員被り・全員未提出なら null */
  winnerId: string | null;
  /** 数字の降順（未提出は末尾）。同値は order の順 */
  entries: ChickenResultEntry[];
};

/** 順位表の1行 */
export type ChickenStanding = {
  playerId: string;
  nickname: string;
  /** 勝利ラウンド数 */
  wins: number;
  /** 1 始まりの順位。同点は同順位 */
  rank: number;
};

/** チキンレースの全状態。ルーム層はこの中身を知らない */
export type ChickenState = {
  /** 乱数の種。現状このゲームは乱数を使わないが、規約どおり init で進めて持つ（§2.5） */
  seed: number;
  /** 進行中か。false なら終了後（最終結果を表示したまま） */
  running: boolean;
  phase: ChickenPhase;
  /** 現在のラウンド。1..totalRounds */
  round: number;
  totalRounds: number;
  /** 参加者の並び順（同点時の順位を安定させるために保持する） */
  order: string[];
  /** playerId → 参加者 */
  players: Record<string, ChickenPlayer>;
  /**
   * 当ラウンドの提出（playerId → 0..100）。**秘密**。
   * view は自分の分しか返さない（§2.6）
   */
  submissions: Record<string, number>;
  /** 勝利ラウンド数（playerId → 回数） */
  wins: Record<string, number>;
  /** 直近に公開したラウンドの結果。submit 中は null */
  lastResult: ChickenRoundResult | null;
  /** 現フェーズの期限（epoch ms） */
  deadline: number | null;
};

/** 受信者へ配る表示データ。秘密（他人の数字）を含めないこと */
export type ChickenView = {
  kind: "chicken";
  phase: ChickenPhase;
  round: number;
  totalRounds: number;
  /** 参加者数 */
  playerCount: number;
  /** 提出済み人数（誰が何を出したかは含めない） */
  submittedCount: number;
  /** 自分の提出値。未提出は null */
  mySubmission: number | null;
  /** 参加者ごとの提出状況。数字は載せない */
  players: Array<{
    playerId: string;
    nickname: string;
    submitted: boolean;
    connected: boolean;
  }>;
  /** 直近ラウンドの公開結果。reveal / final のときだけ入る */
  result?: ChickenRoundResult;
  /** 勝利ラウンド数の順位表 */
  standings: ChickenStanding[];
};

/** 状態を浅く複製する（入力 state を変更しない） */
function clone(state: ChickenState): ChickenState {
  return {
    ...state,
    order: [...state.order],
    players: { ...state.players },
    submissions: { ...state.submissions },
    wins: { ...state.wins },
  };
}

export const chickenModule: GameModule<ChickenState, ChickenView> = {
  id: CHICKEN_MODULE_ID,
  kind: "module",
  meta: {
    title: "チキンレース",
    description: "0〜100の数字を1つずつ内緒で出し、誰とも被らなかった中で一番大きい人が勝ち",
    minPlayers: 2,
    maxPlayers: 10,
  },

  init(input: ModuleInitInput): ModuleResult<ChickenState> {
    const order: string[] = [];
    const players: Record<string, ChickenPlayer> = {};
    const wins: Record<string, number> = {};
    for (const p of input.players) {
      if (players[p.id] !== undefined) continue;
      order.push(p.id);
      players[p.id] = { id: p.id, nickname: p.nickname, connected: p.connected };
      wins[p.id] = 0;
    }
    const state: ChickenState = {
      seed: nextSeed(input.seed),
      running: true,
      phase: "submit",
      round: 1,
      totalRounds: TOTAL_ROUNDS,
      order,
      players,
      submissions: {},
      wins,
      lastResult: null,
      deadline: input.now + SUBMIT_MS,
    };
    return moduleOk(state, [
      { t: "viewChanged" },
      { t: "schedule", at: state.deadline },
    ]);
  },

  reduce(state: ChickenState, event: ModuleEvent): ModuleResult<ChickenState> {
    // 終了後に届いたイベントは黙って捨てる。ただし在籍から消える playerKicked だけは
    // 反映しておく（終了後の最終結果に、卓を去った人の名前を残さないため）
    if (!state.running && event.t !== "playerKicked") return moduleNoop(state);

    switch (event.t) {
      case "clientEvent":
        return handleSubmit(state, event.playerId, event.payload, event.now);
      // このゲームはチャットを使わない（提出は gameEvent のみ）
      case "chatMessage":
        return moduleNoop(state);
      case "timeout": {
        // 期限に達していなければ何もしない（早すぎる発火への防御）
        if (state.deadline === null || event.now < state.deadline) return moduleNoop(state);
        return advance(state, event.now);
      }
      case "playerJoined":
        // 既定は観戦（§5）。進行中のゲームに割り込ませると、そのラウンドだけ
        // 提出人数の分母が変わって「全員提出」の判定がぶれる
        return moduleNoop(state);
      case "playerLeft": {
        const player = state.players[event.playerId];
        if (player === undefined || !player.connected) return moduleNoop(state);
        const next = clone(state);
        next.players[event.playerId] = { ...player, connected: false };
        // 切断した人を待たずに済むよう、残り全員が提出済みならその場で公開する
        return advanceIfAllSubmitted(next, event.now) ??
          moduleOk(next, [{ t: "viewChanged" }]);
      }
      case "playerRejoined": {
        const player = state.players[event.playerId];
        if (player === undefined || player.connected) return moduleNoop(state);
        const next = clone(state);
        next.players[event.playerId] = { ...player, connected: true };
        return moduleOk(next, [{ t: "viewChanged" }]);
      }
      case "playerKicked": {
        if (state.players[event.playerId] === undefined) return moduleNoop(state);
        const next = clone(state);
        next.order = next.order.filter((id) => id !== event.playerId);
        delete next.players[event.playerId];
        delete next.submissions[event.playerId];
        delete next.wins[event.playerId];
        // 公開済みの結果からも当人の行を消す（当人の数字を卓に残さない）
        if (next.lastResult !== null) {
          const entries = next.lastResult.entries.filter((e) => e.playerId !== event.playerId);
          const winnerId = next.lastResult.winnerId === event.playerId
            ? null
            : next.lastResult.winnerId;
          next.lastResult = { ...next.lastResult, entries, winnerId };
        }
        if (!next.running) return moduleOk(next, [{ t: "viewChanged" }]);
        // 在籍が minPlayers を割ったら中断する（§5）
        if (next.order.length < chickenModule.meta.minPlayers) {
          return finish(next, "tooFewPlayers");
        }
        return advanceIfAllSubmitted(next, event.now) ??
          moduleOk(next, [{ t: "viewChanged" }]);
      }
      case "skipPhase":
        // ホストの操作で現フェーズを打ち切る。期限前でも進める
        return advance(state, event.now);
      case "endGame":
        return finish(state, "hostEnded");
    }
  },

  view(state: ChickenState, viewerId: string): ChickenView {
    const view: ChickenView = {
      kind: "chicken",
      phase: state.phase,
      round: state.round,
      totalRounds: state.totalRounds,
      playerCount: state.order.length,
      submittedCount: state.order.filter((id) => state.submissions[id] !== undefined).length,
      // 自分の数字だけを載せる。他人の数字は state にしか無い（§2.6）
      mySubmission: state.submissions[viewerId] ?? null,
      players: state.order.map((id) => {
        const player = state.players[id];
        return {
          playerId: id,
          nickname: player?.nickname ?? "",
          submitted: state.submissions[id] !== undefined,
          connected: player?.connected ?? false,
        };
      }),
      standings: buildStandings(state),
    };
    // 公開結果は reveal 以降にだけ載せる。submit 中に前ラウンドの結果を
    // 載せ続けても害は無いが、「提出中の view には結果が無い」を型でも守る
    if (state.phase !== "submit" && state.lastResult !== null) {
      view.result = state.lastResult;
    }
    return view;
  },
};

/**
 * 提出（clientEvent）を処理する。受理する payload は
 * `{ k: "submit", value: 0..100 の整数 }` の1種類だけ（§9.1）。
 */
function handleSubmit(
  state: ChickenState,
  playerId: string,
  payload: unknown,
  now: number,
): ModuleResult<ChickenState> {
  if (!isRecord(payload)) {
    return moduleFail(state, "INVALID_INPUT", "ゲーム内イベントの形式が正しくありません");
  }
  if (readKind(payload) !== "submit") {
    return moduleFail(state, "INVALID_INPUT", "未知のゲーム内イベントです");
  }
  const value = readInt(payload, "value", CHICKEN_MIN_VALUE, CHICKEN_MAX_VALUE);
  if (value === null) {
    return moduleFail(
      state,
      "INVALID_INPUT",
      `${CHICKEN_MIN_VALUE}〜${CHICKEN_MAX_VALUE}の整数を出してください`,
    );
  }
  if (state.phase !== "submit") {
    return moduleFail(state, "PHASE_MISMATCH", "提出を受け付けていない時間です");
  }
  if (state.players[playerId] === undefined) {
    return moduleFail(state, "PHASE_MISMATCH", "観戦中のため提出できません");
  }
  if (state.deadline !== null && now > state.deadline) {
    return moduleFail(state, "PHASE_MISMATCH", "提出の期限を過ぎています");
  }
  // 出し直しを認めると、他人の提出状況を見ながら粘れてしまう（早く出す動機が消える）
  if (state.submissions[playerId] !== undefined) {
    return moduleFail(state, "DUPLICATE", "すでに提出しています");
  }
  const next = clone(state);
  next.submissions[playerId] = value;
  return advanceIfAllSubmitted(next, now) ?? moduleOk(next, [{ t: "viewChanged" }]);
}

/**
 * 接続中の参加者が全員提出していれば公開へ進める。まだなら null。
 * 切断中の人を待たないのは、60秒の猶予いっぱい卓が止まるのを避けるため
 * （engine.ts の advanceIfComplete と同じ考え方）。
 * ただし**接続者が0人のときだけは期限まで待つ**（下のコメントを参照。
 * wordwolf.ts の advanceIfAllVoted / engine.ts の advanceIfComplete と揃えてある）
 */
function advanceIfAllSubmitted(
  state: ChickenState,
  now: number,
): ModuleResult<ChickenState> | null {
  if (state.phase !== "submit") return null;
  const connected = state.order.filter((id) => state.players[id]?.connected === true);
  // 全員が切断している間は「待っている人が0人」になってしまうので、期限まで待つ。
  // ここで開票すると、通信が一斉に切れただけで 0 提出のままラウンドが消化される
  // （切断には60秒の猶予がある。§3.2）
  if (connected.length === 0) return null;
  const waiting = connected.filter((id) => state.submissions[id] === undefined);
  if (waiting.length > 0) return null;
  return advance(state, now);
}

/** 現フェーズを終えて次へ進める。submit→reveal→（次ラウンド or final）→終了 */
function advance(state: ChickenState, now: number): ModuleResult<ChickenState> {
  switch (state.phase) {
    case "submit":
      return reveal(state, now);
    case "reveal":
      if (state.round >= state.totalRounds) return toFinal(state, now);
      return nextRound(state, now);
    case "final":
      return finish(state, "completed");
  }
}

/** 一斉公開。勝敗を確定し、勝者に1勝を付ける */
function reveal(state: ChickenState, now: number): ModuleResult<ChickenState> {
  const next = clone(state);
  const result = judgeRound(next);
  next.lastResult = result;
  if (result.winnerId !== null) {
    next.wins[result.winnerId] = (next.wins[result.winnerId] ?? 0) + 1;
  }
  next.phase = "reveal";
  next.deadline = now + REVEAL_MS;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: next.deadline },
  ]);
}

/**
 * ラウンドの勝敗を決める。
 * 同じ数字を2人以上が出したらその数字は全員無効。未提出も無効。
 * 残った数字のうち最大を出した人が勝者。誰も残らなければ勝者なし
 */
function judgeRound(state: ChickenState): ChickenRoundResult {
  // 数字ごとの提出人数を数える
  const counts = new Map<number, number>();
  for (const id of state.order) {
    const value = state.submissions[id];
    if (value === undefined) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let winnerId: string | null = null;
  let best = -1;
  for (const id of state.order) {
    const value = state.submissions[id];
    if (value === undefined) continue;
    if (counts.get(value) !== 1) continue;
    if (value > best) {
      best = value;
      winnerId = id;
    }
  }
  const entries: ChickenResultEntry[] = state.order.map((id) => {
    const value = state.submissions[id];
    const submitted = value !== undefined;
    return {
      playerId: id,
      nickname: state.players[id]?.nickname ?? "",
      value: submitted ? value : null,
      unique: submitted && counts.get(value) === 1,
      won: id === winnerId,
    };
  });
  // 数字の降順（未提出は末尾）。同値は order の順（sort は安定なのでそのまま残る）
  entries.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  return { round: state.round, winnerId, entries };
}

/** 次のラウンドの提出フェーズへ */
function nextRound(state: ChickenState, now: number): ModuleResult<ChickenState> {
  const next = clone(state);
  next.round += 1;
  next.phase = "submit";
  next.submissions = {};
  next.deadline = now + SUBMIT_MS;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: next.deadline },
  ]);
}

/** 最終結果の表示へ。FINAL_MS 後の timeout で終了する */
function toFinal(state: ChickenState, now: number): ModuleResult<ChickenState> {
  const next = clone(state);
  next.phase = "final";
  next.deadline = now + FINAL_MS;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: next.deadline },
  ]);
}

/**
 * ゲームを終える。score は1ゲーム1回、schedule は必ず解除する。
 * 終了後も state は捨てず、最終結果を表示したままにする（running のみ false）
 */
function finish(
  state: ChickenState,
  reason: "completed" | "tooFewPlayers" | "hostEnded",
): ModuleResult<ChickenState> {
  const next = clone(state);
  next.running = false;
  next.phase = "final";
  next.deadline = null;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: null },
    { t: "score", totals: buildScoreEntries(next) },
    { t: "ended", reason },
  ]);
}

/** 勝利ラウンド数の順位表。同点は同順位（engine.ts の順位付けと同じ規則） */
function buildStandings(state: ChickenState): ChickenStanding[] {
  const rows = state.order.map((id) => ({
    playerId: id,
    nickname: state.players[id]?.nickname ?? "",
    wins: state.wins[id] ?? 0,
    rank: 0,
  }));
  rows.sort((a, b) => b.wins - a.wins);
  let rank = 0;
  let previous: number | null = null;
  rows.forEach((row, index) => {
    if (previous === null || row.wins !== previous) {
      rank = index + 1;
      previous = row.wins;
    }
    row.rank = rank;
  });
  return rows;
}

/** 公式スコアへ渡す1ゲーム分の得点。勝利ラウンド数をそのまま点にする */
function buildScoreEntries(state: ChickenState): ScoreEntry[] {
  return buildStandings(state).map((row) => ({
    playerId: row.playerId,
    nickname: row.nickname,
    roundScore: 0,
    totalScore: row.wins,
    rank: row.rank,
  }));
}
