/**
 * ゲームエンジン（フェーズ状態機械）
 * 詳細仕様書 §3.3 / §3.4 / §8 に対応する。
 *
 * 規約（§3.2 規約2）: このファイルの関数はすべて純粋関数であり、
 * I/O を持たず内部で await を使わない。タイマー発火・参加者の増減などの
 * 外部要因はすべて EngineEvent として引数で受け取る。
 * 入力の GameState は変更せず、新しい GameState を返す。
 *
 * 例外は startGame だけで、選択肢のシャッフル（cryptoShuffle）に乱数を使う。
 * 乱数はここに閉じており、reduce / buildPhaseView は従来どおり純粋・決定的。
 * テストは startGame の shuffleOptions 引数へ決定的な並べ替えを注入できる。
 */

import type {
  ErrorCode,
  GameDefinition,
  GameParticipant,
  GameState,
  JudgePhaseView,
  Phase,
  PhaseDurations,
  PhaseView,
  Prompt,
  RevealEntry,
  ScoreDetail,
  ScoreEntry,
  Submission,
} from "./types.ts";
import { ROOM_CAPACITY } from "./types.ts";

// ---------------------------------------------------------------------------
// エンジン定数
// ---------------------------------------------------------------------------

/** 各フェーズの既定秒数。input のみゲーム定義の inputTimeSec を使う */
export const DEFAULT_PHASE_DURATIONS: PhaseDurations = {
  introSec: 8,
  promptSec: 5,
  revealSec: 12,
  judgeSec: 30,
  roundResultSec: 12,
  finalResultSec: 20,
};

/** ゲーム開始に必要な最少人数（§8: 2人未満は中断） */
export const MIN_PLAYERS = 2;

/** text 入力の最大文字数 */
export const SUBMIT_TEXT_MAX = 140;

/** match: 全員一致したときに各自へ加算するボーナス点 */
export const MATCH_ALL_BONUS = 3;

/** correct: 正解の基礎点 */
export const CORRECT_BASE_POINT = 10;

/** correct: 正解者を提出の早い順に並べたときの追加点（4位以降は 0） */
export const CORRECT_SPEED_BONUS = [5, 3, 1];

/** 匿名 reveal 用トークンの長さ（16進16文字 = 64bit） */
export const REVEAL_TOKEN_HEX_LENGTH = 16;

/**
 * トークンを用意するラウンド数の上限。
 * ゲーム定義の rounds は gamedef.ts が 1..ROUNDS_MAX(=10) に検証済みなので通常は届かない。
 * 検証を経ない呼び出しで過大な rounds が来ても生成量が発散しないようにするための保険。
 */
const REVEAL_TOKEN_MAX_ROUNDS = 64;

// ---------------------------------------------------------------------------
// イベントと結果
// ---------------------------------------------------------------------------

/** エンジンへの入力イベント。すべて外部（ルーム層）が確定させて渡す */
export type EngineEvent =
  | { t: "submitInput"; playerId: string; value: string | number; now: number }
  | { t: "submitVote"; voterId: string; targetPlayerId: string; now: number }
  /** ホストによるスキップ。現フェーズを即座に終了させる */
  | { t: "skipPhase"; now: number }
  /** タイマー発火。deadline に達していなければ何もしない */
  | { t: "timeout"; now: number }
  /** 途中参加。進行中はそのゲームの観戦者として扱う（§8） */
  | { t: "playerJoined"; playerId: string; nickname: string; now: number }
  /** 切断・退室。得点は残すが完了判定から外す（§8） */
  | { t: "playerLeft"; playerId: string; now: number }
  /** 再接続。完了判定に復帰させる */
  | { t: "playerRejoined"; playerId: string; now: number }
  /** キック。得点ごと除外し、当人への票も無効化する（§8） */
  | { t: "playerKicked"; playerId: string; now: number }
  /** ホストによるゲーム終了 */
  | { t: "endGame"; now: number };

/** エンジンが返す副作用の指示。実際の送信はルーム層が行う */
export type EngineEffect =
  | { t: "phaseChanged"; phase: Phase; deadline: number | null }
  | { t: "roundResult"; scores: ScoreEntry[] }
  | { t: "finalResult"; scores: ScoreEntry[] }
  | { t: "ended"; reason: "completed" | "tooFewPlayers" | "hostEnded" };

/** エンジン呼び出しの結果 */
export type EngineResult = {
  /** 更新後の状態。エラー時は入力と同じ状態を返す */
  state: GameState;
  /** 状態が変化したか */
  changed: boolean;
  /** 受理できなかった場合のエラーコード */
  error?: ErrorCode;
  /** エラーの説明 */
  message?: string;
  /** ルーム層が実行すべき副作用 */
  effects: EngineEffect[];
};

/** ゲーム開始時に渡す参加者情報 */
export type EnginePlayerInput = {
  /** playerId */
  id: string;
  /** 表示名 */
  nickname: string;
  /** 接続中か */
  connected: boolean;
};

// ---------------------------------------------------------------------------
// §3.4 match の正規化規則（①〜⑤）
// ---------------------------------------------------------------------------

/**
 * match 採点用の正規化。
 * ①前後空白除去 ②連続空白を1つに圧縮 ③英字は小文字化
 * ④全角英数字・記号は半角化 ⑤カタカナはひらがな化
 * 漢字/かなの表記ゆれは同一視しない（v1 の割り切り）。
 * ④→③の順に適用しないと全角英字が小文字化されないため、内部の適用順は
 * 「全角→半角 → 小文字化 → カタカナ→ひらがな → 空白圧縮 → trim」とする。
 */
export function normalizeMatchValue(input: string): string {
  let s = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x3000) {
      // 全角スペース → 半角スペース
      s += " ";
    } else if (cp >= 0xff01 && cp <= 0xff5e) {
      // 全角英数字・記号 → 半角
      s += String.fromCodePoint(cp - 0xfee0);
    } else if (cp >= 0x30a1 && cp <= 0x30f6) {
      // カタカナ → ひらがな（ヷ〜ヺ は対応するひらがなが無いため除く）
      s += String.fromCodePoint(cp - 0x60);
    } else {
      s += ch;
    }
  }
  s = s.toLowerCase();
  s = s.replace(/\s+/g, " ");
  return s.trim();
}

// ---------------------------------------------------------------------------
// 出題の実行時生成（選択肢シャッフル）
// ---------------------------------------------------------------------------

/**
 * 配列を並べ替えて新しい配列を返す関数。
 * 既定は乱数（crypto）だが、テストは決定的な実装を startGame へ注入できる。
 */
export type ShuffleFn = <T>(items: readonly T[]) => T[];

/**
 * 0 以上 bound 未満の一様乱数。
 * 単純な剰余は 2^32 が bound の倍数でないときに偏るため、余りに当たる範囲は引き直す。
 */
function randomBelow(bound: number): number {
  const limit = Math.floor(0x1_0000_0000 / bound) * bound;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % bound;
  }
}

/**
 * crypto 由来の乱数による Fisher-Yates シャッフル（偏りなし）。
 * 純粋関数の規約（このファイル冒頭）の唯一の例外で、呼び出しは startGame に閉じている。
 * reduce / buildPhaseView は乱数へ触れないため、状態遷移は従来どおり決定的。
 */
export const cryptoShuffle: ShuffleFn = <T>(items: readonly T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
};

/**
 * 出題の原本から「実際に出題するお題」を作る。
 *
 * choice のお題は選択肢を並べ替え、answer を並べ替え後の位置へ振り直す。
 * 正解位置がデータの書き方に依存しなくなるため、「毎回いちばん上が正解」になる事故を防ぐ。
 * - answer が undefined（正解を持たない選択式）は並べ替えだけ行う
 * - answer が範囲外・非整数の壊れたデータは並べ替えず原本のまま通す（正解が別物に化けないように）
 * - choice 以外（open）はそのまま写す
 *
 * 原本（prompts と各 options）は読むだけで、返す値はすべて新しい配列・新しいオブジェクト。
 */
export function buildRuntimePrompts(
  prompts: readonly Prompt[],
  shuffleOptions: ShuffleFn,
): Prompt[] {
  return prompts.map((prompt) => {
    if (prompt.kind !== "choice") return { ...prompt };
    const options = prompt.options;
    const answer = prompt.answer;
    const answerBroken = answer !== undefined &&
      (!Number.isInteger(answer) || answer < 0 || answer >= options.length);
    if (answerBroken || options.length < 2) return { ...prompt, options: [...options] };
    // 添字を並べ替えてから引き当てる。こうすると正解の移動先が indexOf で求まり、
    // 同じ文字列の選択肢があっても取り違えない
    const order = shuffleOptions(options.map((_, index) => index));
    const moved = answer === undefined ? 0 : order.indexOf(answer);
    if (order.length !== options.length || (answer !== undefined && moved < 0)) {
      // 注入されたシャッフルが壊れている場合の保険。原本のまま通す
      return { ...prompt, options: [...options] };
    }
    const shuffled = order.map((index) => options[index]);
    if (answer === undefined) return { ...prompt, options: shuffled };
    return { ...prompt, options: shuffled, answer: moved };
  });
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/** 参加者のうち採点対象かつ接続中の playerId を並び順で返す */
function activePlayerIds(state: GameState): string[] {
  return state.order.filter((id) => {
    const p = state.participants[id];
    return p !== undefined && p.role === "player" && p.connected;
  });
}

/** 参加者のうち採点対象（切断中を含む）の playerId を並び順で返す */
function scoredPlayerIds(state: GameState): string[] {
  return state.order.filter((id) => {
    const p = state.participants[id];
    return p !== undefined && p.role === "player";
  });
}

/** 現在のラウンドの出題を返す。ラウンド数が出題数を超える場合は巡回する */
export function currentPrompt(state: GameState): Prompt | null {
  const prompts = state.runtimePrompts;
  if (prompts.length === 0 || state.round < 1) return null;
  return prompts[state.promptIndex] ?? null;
}

/** フェーズの表示秒数を返す。期限を持たないフェーズは null */
function durationMs(state: GameState, phase: Phase): number | null {
  const d = state.durations;
  switch (phase) {
    case "lobby":
      return null;
    case "intro":
      return d.introSec * 1000;
    case "prompt":
      return d.promptSec * 1000;
    case "input":
      return state.definition.inputTimeSec * 1000;
    case "reveal":
      return d.revealSec * 1000;
    case "judge":
      return d.judgeSec * 1000;
    case "roundResult":
      return d.roundResultSec * 1000;
    case "finalResult":
      return d.finalResultSec * 1000;
  }
}

// ---------------------------------------------------------------------------
// 匿名 reveal 用トークン（§3.2 原則3）
// ---------------------------------------------------------------------------

/**
 * トークン1個を作る関数。既定は暗号乱数で、テストからは決定的な値を注入できる。
 * ハッシュ導出（playerId や startedAt からの計算）は使わない。攻撃者は自分の回答から
 * 「自分の playerId ↔ 自分のトークン」を1組必ず得られるため、鍵の無い導出では
 * 他人のトークンまで再現されてしまう。
 */
export type RevealTokenSource = () => string;

/** 暗号乱数から16進16文字（64bit）のトークンを作る */
function randomRevealToken(): string {
  const bytes = new Uint8Array(REVEAL_TOKEN_HEX_LENGTH / 2);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * ラウンドごとのトークン束を作る（添字 = round-1、各ラウンド ROOM_CAPACITY 個）。
 * ゲーム全体で値が重複しないことを保証する。重複すると投票先の解決が別人に化けるため、
 * 生成器が重複を返した場合は作り直し、それでも解消しないときは連番を付けて一意にする。
 */
function buildRevealTokenPool(rounds: number, source: RevealTokenSource): string[][] {
  const roundCount = Math.min(Math.max(1, Math.floor(rounds)), REVEAL_TOKEN_MAX_ROUNDS);
  const used = new Set<string>();
  let serial = 0;
  const nextToken = (): string => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const token = source();
      if (token !== "" && !used.has(token)) {
        used.add(token);
        return token;
      }
    }
    // 生成器が重複ばかり返す場合の最終手段。無限ループを避けつつ一意性だけは守る
    let fallback = "";
    do {
      serial++;
      fallback = `dup${serial}`;
    } while (used.has(fallback));
    used.add(fallback);
    return fallback;
  };
  const pool: string[][] = [];
  for (let r = 0; r < roundCount; r++) {
    const row: string[] = [];
    for (let i = 0; i < ROOM_CAPACITY; i++) row.push(nextToken());
    pool.push(row);
  }
  return pool;
}

/**
 * 現ラウンドのトークンを配り直す（startRound からのみ呼ぶ）。
 * 1ラウンドで同時にトークンを要するのは在室中の採点対象者だけで、ルーム定員
 * （ROOM_CAPACITY）を超えられないため、通常この配布で不足は起こらない。
 */
function assignRevealTokens(state: GameState): void {
  const row = state.revealTokenPool[state.round - 1] ?? [];
  const tokens: Record<string, string> = {};
  scoredPlayerIds(state).forEach((id, index) => {
    const token = row[index];
    if (token !== undefined) tokens[id] = token;
  });
  state.revealTokens = tokens;
}

/** 匿名時のトークンを引く。割り当てが無ければ null */
function revealTokenOf(state: GameState, playerId: string): string | null {
  return state.revealTokens[playerId] ?? null;
}

/**
 * トークンが引けなかったときの代替ID。1ラウンドで同時にトークンを要する人数は
 * ルーム定員を超えられないため、設計上ここは使われない想定。
 * それでも回答を隠したり投票不能にしたりすると当人が一方的に不利になるので、
 * 実在の playerId とは決して一致しない形式でラウンド内一意の値を割り当て、表示と投票は成立させる。
 */
function fallbackRevealId(round: number, index: number): string {
  return `anon#${round}#${index}`;
}

/** 匿名時に entry へ載せる公開IDと、本物の playerId の対応（現ラウンド分） */
type AnonymousRevealId = { id: string; publicId: string; fallback: boolean };

/** 現ラウンドの匿名IDを表示順に作る。トークンが無い分だけ代替IDで埋める */
function anonymousRevealIds(state: GameState): AnonymousRevealId[] {
  return revealOrder(state).map((id, index) => {
    const token = revealTokenOf(state, id);
    if (token !== null) return { id, publicId: token, fallback: false };
    return { id, publicId: fallbackRevealId(state.round, index), fallback: true };
  });
}

/**
 * 状態を浅くコピーする（各コレクションは新しいオブジェクトにする）。
 *
 * runtimePrompts は配列だけ作り直し、要素のお題オブジェクトは共有したままにする。
 * お題は startGame で1度組み立てたあと誰も書き換えない読み取り専用の値であり
 * （書き換える箇所が無いことは engine.ts / games / rooms.ts を grep して確認済み。
 * 外へ出す promptOptions も options を複製して返す）、cloneState は提出・投票・
 * フェーズ遷移のたびに呼ばれるため、毎回お題と選択肢まで複製すると
 * イベント1件あたり O(お題数 × 選択肢数) の複製が無駄に走る。
 */
function cloneState(state: GameState): GameState {
  return {
    ...state,
    runtimePrompts: [...state.runtimePrompts],
    participants: { ...state.participants },
    order: [...state.order],
    submissions: { ...state.submissions },
    votes: { ...state.votes },
    roundScores: { ...state.roundScores },
    totalScores: { ...state.totalScores },
    lastScores: [...state.lastScores],
    revealTokens: { ...state.revealTokens },
    // 各ラウンドの束は作った後に書き換えないが、共有参照を残さないよう行ごとに複製する
    revealTokenPool: state.revealTokenPool.map((row) => [...row]),
  };
}

/** エラー結果を作る */
function fail(state: GameState, code: ErrorCode, message: string): EngineResult {
  return { state, changed: false, error: code, message, effects: [] };
}

/** 変化なしの結果を作る */
function noop(state: GameState): EngineResult {
  return { state, changed: false, effects: [] };
}

// ---------------------------------------------------------------------------
// 採点（§3.4）
// ---------------------------------------------------------------------------

/** 1人分の採点結果 */
type Scored = { score: number; detail: ScoreDetail };

/** vote: 得た票数がそのまま得点になる */
function scoreVote(state: GameState): Record<string, Scored> {
  const result: Record<string, Scored> = {};
  for (const id of scoredPlayerIds(state)) {
    result[id] = { score: 0, detail: { votes: 0 } };
  }
  for (const voterId of Object.keys(state.votes)) {
    const targetId = state.votes[voterId];
    const entry = result[targetId];
    if (entry === undefined) continue;
    entry.score += 1;
    entry.detail.votes = (entry.detail.votes ?? 0) + 1;
  }
  return result;
}

/** match: 正規化後に一致した「自分以外の人数」が得点。全員一致でボーナス */
function scoreMatch(state: GameState): Record<string, Scored> {
  const result: Record<string, Scored> = {};
  const players = scoredPlayerIds(state);
  const groups = new Map<string, string[]>();
  for (const id of players) {
    result[id] = { score: 0, detail: { matchCount: 0, allMatchBonus: false } };
    const sub = state.submissions[id];
    if (sub === undefined) continue;
    const key = normalizeMatchValue(String(sub.value));
    if (key === "") continue;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [id]);
    else list.push(id);
  }
  for (const ids of groups.values()) {
    const matchCount = ids.length - 1;
    if (matchCount <= 0) continue;
    for (const id of ids) {
      result[id].score = matchCount;
      result[id].detail.matchCount = matchCount;
    }
  }
  // 全員一致: 採点対象が2人以上、全員が提出済み、正規化後の値が1種類
  const allSubmitted = players.length >= MIN_PLAYERS &&
    players.every((id) => state.submissions[id] !== undefined);
  if (allSubmitted && groups.size === 1) {
    const only = [...groups.values()][0];
    if (only.length === players.length) {
      for (const id of players) {
        result[id].score += MATCH_ALL_BONUS;
        result[id].detail.allMatchBonus = true;
      }
    }
  }
  return result;
}

/** correct: 正解の基礎点に、提出が早い順の追加点を加える */
function scoreCorrect(state: GameState): Record<string, Scored> {
  const result: Record<string, Scored> = {};
  const players = scoredPlayerIds(state);
  for (const id of players) {
    result[id] = { score: 0, detail: { correct: false, speedBonus: 0 } };
  }
  const prompt = currentPrompt(state);
  if (prompt === null || prompt.kind !== "choice" || prompt.answer === undefined) {
    return result;
  }
  const correctSubs: Submission[] = [];
  for (const id of players) {
    const sub = state.submissions[id];
    if (sub === undefined) continue;
    if (typeof sub.value === "number" && sub.value === prompt.answer) {
      correctSubs.push(sub);
    }
  }
  // 提出時刻の昇順。同時刻は参加順で安定させる
  correctSubs.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    return state.order.indexOf(a.playerId) - state.order.indexOf(b.playerId);
  });
  correctSubs.forEach((sub, index) => {
    const bonus = CORRECT_SPEED_BONUS[index] ?? 0;
    result[sub.playerId] = {
      score: CORRECT_BASE_POINT + bonus,
      detail: { correct: true, speedBonus: bonus },
    };
  });
  return result;
}

/** 採点方式に応じてラウンド得点を計算する */
export function computeRoundScores(state: GameState): Record<string, Scored> {
  switch (state.definition.scoring) {
    case "vote":
      return scoreVote(state);
    case "match":
      return scoreMatch(state);
    case "correct":
      return scoreCorrect(state);
  }
}

/** 累計得点から順位表を作る。同点は同順位、並びは累計→参加順 */
export function buildScoreEntries(
  state: GameState,
  details?: Record<string, ScoreDetail>,
): ScoreEntry[] {
  const ids = scoredPlayerIds(state);
  const rows = ids.map((id) => ({
    playerId: id,
    nickname: state.participants[id].nickname,
    roundScore: state.roundScores[id] ?? 0,
    totalScore: state.totalScores[id] ?? 0,
    rank: 0,
    detail: details?.[id],
  }));
  rows.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return ids.indexOf(a.playerId) - ids.indexOf(b.playerId);
  });
  let rank = 0;
  let prev: number | null = null;
  rows.forEach((row, index) => {
    if (prev === null || row.totalScore !== prev) {
      rank = index + 1;
      prev = row.totalScore;
    }
    row.rank = rank;
  });
  return rows;
}

// ---------------------------------------------------------------------------
// フェーズ遷移
// ---------------------------------------------------------------------------

/** 指定フェーズへ遷移した状態を作る（期限も設定する） */
function enterPhase(state: GameState, phase: Phase, now: number): GameState {
  const next = cloneState(state);
  next.phase = phase;
  const ms = durationMs(next, phase);
  next.deadline = ms === null ? null : now + ms;
  return next;
}

/** 新しいラウンドを開始する（観戦者を採点対象へ昇格させる） */
function startRound(state: GameState, round: number, now: number): GameState {
  let next = cloneState(state);
  next.round = round;
  next.promptIndex = (round - 1) % Math.max(1, next.runtimePrompts.length);
  next.submissions = {};
  next.votes = {};
  next.roundScores = {};
  // 途中参加者は次ラウンドから採点対象になる（§8）
  for (const id of next.order) {
    const p = next.participants[id];
    if (p !== undefined && p.role === "spectator") {
      next.participants[id] = { ...p, role: "player" };
      if (next.totalScores[id] === undefined) next.totalScores[id] = 0;
    }
  }
  // 昇格が済んでから配る。ラウンドが変わればトークンも変わるので、
  // 前ラウンドのトークンで投票しても解決できず弾かれる
  assignRevealTokens(next);
  next = enterPhase(next, "prompt", now);
  return next;
}

/** ゲームを終了して lobby へ戻す */
function toLobby(state: GameState, now: number): GameState {
  const next = enterPhase(state, "lobby", now);
  next.round = 0;
  next.submissions = {};
  next.votes = {};
  next.revealTokens = {};
  next.deadline = null;
  return next;
}

/** 現フェーズを終了して次フェーズへ進める（1段のみ） */
function advance(state: GameState, now: number): EngineResult {
  switch (state.phase) {
    case "lobby":
      return noop(state);
    case "intro": {
      const next = startRound(state, 1, now);
      return {
        state: next,
        changed: true,
        effects: [{ t: "phaseChanged", phase: next.phase, deadline: next.deadline }],
      };
    }
    case "prompt":
    case "reveal": {
      const target: Phase = state.phase === "prompt" ? "input" : "judge";
      const next = enterPhase(state, target, now);
      return {
        state: next,
        changed: true,
        effects: [{ t: "phaseChanged", phase: next.phase, deadline: next.deadline }],
      };
    }
    case "input": {
      const next = enterPhase(state, "reveal", now);
      return {
        state: next,
        changed: true,
        effects: [{ t: "phaseChanged", phase: next.phase, deadline: next.deadline }],
      };
    }
    case "judge": {
      // 採点はこの遷移でのみ行う（§3.3: judge は scoring 方式に従いサーバーが計算）
      const scored = computeRoundScores(state);
      let next = cloneState(state);
      const details: Record<string, ScoreDetail> = {};
      for (const id of scoredPlayerIds(next)) {
        const s = scored[id] ?? { score: 0, detail: {} };
        next.roundScores[id] = s.score;
        next.totalScores[id] = (next.totalScores[id] ?? 0) + s.score;
        details[id] = s.detail;
      }
      const scores = buildScoreEntries(next, details);
      next.lastScores = scores;
      next = enterPhase(next, "roundResult", now);
      return {
        state: next,
        changed: true,
        effects: [
          { t: "phaseChanged", phase: next.phase, deadline: next.deadline },
          { t: "roundResult", scores },
        ],
      };
    }
    case "roundResult": {
      if (state.round < state.definition.rounds) {
        const next = startRound(state, state.round + 1, now);
        return {
          state: next,
          changed: true,
          effects: [{ t: "phaseChanged", phase: next.phase, deadline: next.deadline }],
        };
      }
      const next = enterPhase(state, "finalResult", now);
      next.lastScores = buildScoreEntries(next);
      return {
        state: next,
        changed: true,
        effects: [
          { t: "phaseChanged", phase: next.phase, deadline: next.deadline },
          { t: "finalResult", scores: next.lastScores },
        ],
      };
    }
    case "finalResult": {
      const next = toLobby(state, now);
      return {
        state: next,
        changed: true,
        effects: [
          { t: "phaseChanged", phase: "lobby", deadline: null },
          { t: "ended", reason: "completed" },
        ],
      };
    }
  }
}

/**
 * 人数不足なら中断して lobby へ戻す。中断した場合のみ結果を返す。
 * 数えるのは在籍する採点対象者（scoredPlayerIds）であり、一時的な切断では中断しない。
 * 切断は60秒の猶予中に復帰できるため（§3.2 / §8）、中断はキック・退室で
 * 在籍が2人未満になったときだけ起こる。
 */
function abortIfTooFewPlayers(state: GameState, now: number): EngineResult | null {
  if (state.phase === "lobby") return null;
  if (scoredPlayerIds(state).length >= MIN_PLAYERS) return null;
  const next = toLobby(state, now);
  return {
    state: next,
    changed: true,
    effects: [
      { t: "phaseChanged", phase: "lobby", deadline: null },
      { t: "ended", reason: "tooFewPlayers" },
    ],
  };
}

/** 全員完了していれば次フェーズへ進める。進めない場合は null */
function advanceIfComplete(state: GameState, now: number): EngineResult | null {
  const active = activePlayerIds(state);
  if (active.length === 0) return null;
  if (state.phase === "input") {
    if (active.every((id) => state.submissions[id] !== undefined)) {
      return advance(state, now);
    }
    return null;
  }
  if (state.phase === "judge" && state.definition.scoring === "vote") {
    const voters = active.filter((id) => eligibleVoteTargets(state, id).length > 0);
    if (voters.length > 0 && voters.every((id) => state.votes[id] !== undefined)) {
      return advance(state, now);
    }
    return null;
  }
  return null;
}

/** 指定の投票者が投票できる相手（自分以外で当ラウンドに提出した採点対象者） */
function eligibleVoteTargets(state: GameState, voterId: string): string[] {
  return scoredPlayerIds(state).filter(
    (id) => id !== voterId && state.submissions[id] !== undefined,
  );
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * ゲームを開始して intro フェーズの状態を作る。
 *
 * 乱数を使うのはこの関数だけで、reduce / buildPhaseView は純粋なまま。ここで2つ作る。
 *   - 匿名 reveal 用のトークン（全ラウンド分をまとめて）
 *   - definition.prompts から runtimePrompts（選択肢をシャッフルし answer を振り直す）
 *
 * tokenSource / shuffleOptions はテストが決定的な値を注入するための口で、
 * 省略時は必ず暗号乱数を使う（省略時に固定値・固定の並びにはしない）。
 */
export function startGame(
  definition: GameDefinition,
  players: EnginePlayerInput[],
  now: number,
  durations: PhaseDurations = DEFAULT_PHASE_DURATIONS,
  tokenSource: RevealTokenSource = randomRevealToken,
  shuffleOptions: ShuffleFn = cryptoShuffle,
): EngineResult {
  const participants: Record<string, GameParticipant> = {};
  const order: string[] = [];
  const totalScores: Record<string, number> = {};
  for (const p of players) {
    if (participants[p.id] !== undefined) continue;
    participants[p.id] = {
      id: p.id,
      nickname: p.nickname,
      role: "player",
      connected: p.connected,
    };
    order.push(p.id);
    totalScores[p.id] = 0;
  }
  const base: GameState = {
    definition,
    runtimePrompts: buildRuntimePrompts(definition.prompts, shuffleOptions),
    phase: "lobby",
    round: 0,
    promptIndex: 0,
    deadline: null,
    durations,
    participants,
    order,
    submissions: {},
    votes: {},
    roundScores: {},
    totalScores,
    lastScores: [],
    startedAt: now,
    revealTokens: {},
    revealTokenPool: buildRevealTokenPool(definition.rounds, tokenSource),
  };
  const connectedCount = order.filter((id) => participants[id].connected).length;
  if (connectedCount < MIN_PLAYERS) {
    return fail(base, "INVALID_INPUT", "ゲーム開始には2人以上の参加者が必要です");
  }
  // 出題は runtimePrompts から引くので、空判定もそちらで行う。
  // 現状は definition.prompts の 1 対 1 写像なので件数は必ず一致する
  if (base.runtimePrompts.length === 0) {
    return fail(base, "INVALID_INPUT", "お題が1件もありません");
  }
  const next = enterPhase(base, "intro", now);
  return {
    state: next,
    changed: true,
    effects: [{ t: "phaseChanged", phase: "intro", deadline: next.deadline }],
  };
}

/** イベントを1件処理して次の状態を返す（純粋関数） */
export function reduce(state: GameState, event: EngineEvent): EngineResult {
  switch (event.t) {
    case "submitInput":
      return handleSubmitInput(state, event);
    case "submitVote":
      return handleSubmitVote(state, event);
    case "skipPhase": {
      if (state.phase === "lobby") {
        return fail(state, "PHASE_MISMATCH", "ゲームが進行していません");
      }
      return advance(state, event.now);
    }
    case "timeout": {
      if (state.deadline === null || event.now < state.deadline) return noop(state);
      return advance(state, event.now);
    }
    case "playerJoined":
      return handlePlayerJoined(state, event);
    case "playerLeft":
      return handlePlayerLeft(state, event);
    case "playerRejoined":
      return handlePlayerRejoined(state, event);
    case "playerKicked":
      return handlePlayerKicked(state, event);
    case "endGame": {
      if (state.phase === "lobby") return noop(state);
      const next = toLobby(state, event.now);
      return {
        state: next,
        changed: true,
        effects: [
          { t: "phaseChanged", phase: "lobby", deadline: null },
          { t: "ended", reason: "hostEnded" },
        ],
      };
    }
  }
}

/** submitInput の処理（§8: 期限後の submit は破棄して error） */
function handleSubmitInput(
  state: GameState,
  event: Extract<EngineEvent, { t: "submitInput" }>,
): EngineResult {
  if (state.phase !== "input") {
    return fail(state, "PHASE_MISMATCH", "入力を受け付けていないフェーズです");
  }
  if (state.deadline !== null && event.now > state.deadline) {
    return fail(state, "PHASE_MISMATCH", "入力の期限を過ぎています");
  }
  const p = state.participants[event.playerId];
  if (p === undefined || p.role !== "player") {
    return fail(state, "PHASE_MISMATCH", "観戦中のため入力できません");
  }
  if (state.submissions[event.playerId] !== undefined) {
    return fail(state, "DUPLICATE", "すでに回答を提出しています");
  }
  const prompt = currentPrompt(state);
  if (prompt === null) {
    return fail(state, "PHASE_MISMATCH", "出題がありません");
  }
  const validated = validateSubmissionValue(state, prompt, event.value);
  if (validated === null) {
    return fail(state, "INVALID_INPUT", "回答の形式が正しくありません");
  }
  let next = cloneState(state);
  next.submissions[event.playerId] = {
    playerId: event.playerId,
    value: validated,
    at: event.now,
  };
  const effects: EngineEffect[] = [];
  const advanced = advanceIfComplete(next, event.now);
  if (advanced !== null) {
    next = advanced.state;
    effects.push(...advanced.effects);
  }
  return { state: next, changed: true, effects };
}

/** 提出値を検証して正規化する。不正なら null */
function validateSubmissionValue(
  state: GameState,
  prompt: Prompt,
  value: string | number,
): string | number | null {
  if (state.definition.inputType === "text") {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > SUBMIT_TEXT_MAX) return null;
    return trimmed;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (prompt.kind !== "choice") return null;
  if (value < 0 || value >= prompt.options.length) return null;
  return value;
}

/** submitVote の処理（自票禁止・二重投票は冪等に弾く） */
function handleSubmitVote(
  state: GameState,
  event: Extract<EngineEvent, { t: "submitVote" }>,
): EngineResult {
  if (state.definition.scoring !== "vote") {
    return fail(state, "PHASE_MISMATCH", "投票を行わないゲームです");
  }
  if (state.phase !== "judge") {
    return fail(state, "PHASE_MISMATCH", "投票を受け付けていないフェーズです");
  }
  if (state.deadline !== null && event.now > state.deadline) {
    return fail(state, "PHASE_MISMATCH", "投票の期限を過ぎています");
  }
  const voter = state.participants[event.voterId];
  if (voter === undefined || voter.role !== "player") {
    return fail(state, "PHASE_MISMATCH", "観戦中のため投票できません");
  }
  if (state.votes[event.voterId] !== undefined) {
    return fail(state, "DUPLICATE", "すでに投票しています");
  }
  // 匿名時にクライアントが持っているのは当ラウンドのトークンだけ。ここで本物の
  // playerId へ解決してから検証する（state.votes には本物の playerId を入れる）
  const targetId = resolveVoteTarget(state, event.targetPlayerId);
  if (targetId === null) {
    return fail(state, "INVALID_INPUT", "投票先が正しくありません");
  }
  if (targetId === event.voterId) {
    return fail(state, "INVALID_INPUT", "自分には投票できません");
  }
  if (!eligibleVoteTargets(state, event.voterId).includes(targetId)) {
    return fail(state, "INVALID_INPUT", "投票先が正しくありません");
  }
  let next = cloneState(state);
  next.votes[event.voterId] = targetId;
  const effects: EngineEffect[] = [];
  const advanced = advanceIfComplete(next, event.now);
  if (advanced !== null) {
    next = advanced.state;
    effects.push(...advanced.effects);
  }
  return { state: next, changed: true, effects };
}

/**
 * クライアントが送ってきた投票先を本物の playerId へ解決する。
 * reveal:"named" はそのまま本物の playerId を受ける。匿名時は**現ラウンドの**
 * トークンだけを引くので、本物の playerId や前ラウンドのトークンは解決できず弾かれる。
 */
function resolveVoteTarget(state: GameState, target: string): string | null {
  if (state.definition.reveal === "named") return target;
  if (target === "") return null;
  for (const id of Object.keys(state.revealTokens)) {
    if (state.revealTokens[id] === target) return id;
  }
  // トークンが足りずに代替IDを配った場合だけ、その代替IDも受け付ける（buildRevealEntries と対）
  const fallbackEntry = anonymousRevealIds(state).find(
    (e) => e.fallback && e.publicId === target,
  );
  return fallbackEntry?.id ?? null;
}

/** 途中参加。lobby 以外では観戦者として登録する（§8） */
function handlePlayerJoined(
  state: GameState,
  event: Extract<EngineEvent, { t: "playerJoined" }>,
): EngineResult {
  if (state.participants[event.playerId] !== undefined) {
    return handlePlayerRejoined(state, {
      t: "playerRejoined",
      playerId: event.playerId,
      now: event.now,
    });
  }
  const next = cloneState(state);
  const role = state.phase === "lobby" ? "player" : "spectator";
  next.participants[event.playerId] = {
    id: event.playerId,
    nickname: event.nickname,
    role,
    connected: true,
  };
  next.order.push(event.playerId);
  if (role === "player") next.totalScores[event.playerId] = 0;
  return { state: next, changed: true, effects: [] };
}

/** 切断・退室。得点は残し完了判定から外す（§8） */
function handlePlayerLeft(
  state: GameState,
  event: Extract<EngineEvent, { t: "playerLeft" }>,
): EngineResult {
  const p = state.participants[event.playerId];
  if (p === undefined || !p.connected) return noop(state);
  let next = cloneState(state);
  next.participants[event.playerId] = { ...p, connected: false };
  const aborted = abortIfTooFewPlayers(next, event.now);
  if (aborted !== null) return aborted;
  const effects: EngineEffect[] = [];
  const advanced = advanceIfComplete(next, event.now);
  if (advanced !== null) {
    next = advanced.state;
    effects.push(...advanced.effects);
  }
  return { state: next, changed: true, effects };
}

/** 再接続。完了判定に復帰させる */
function handlePlayerRejoined(
  state: GameState,
  event: Extract<EngineEvent, { t: "playerRejoined" }>,
): EngineResult {
  const p = state.participants[event.playerId];
  if (p === undefined) return noop(state);
  if (p.connected) return noop(state);
  const next = cloneState(state);
  next.participants[event.playerId] = { ...p, connected: true };
  return { state: next, changed: true, effects: [] };
}

/** キック。得点ごと除外し、当人への票と当人の票を無効化する（§8） */
function handlePlayerKicked(
  state: GameState,
  event: Extract<EngineEvent, { t: "playerKicked" }>,
): EngineResult {
  if (state.participants[event.playerId] === undefined) return noop(state);
  let next = cloneState(state);
  delete next.participants[event.playerId];
  next.order = next.order.filter((id) => id !== event.playerId);
  delete next.submissions[event.playerId];
  delete next.roundScores[event.playerId];
  delete next.totalScores[event.playerId];
  delete next.votes[event.playerId];
  for (const voterId of Object.keys(next.votes)) {
    if (next.votes[voterId] === event.playerId) delete next.votes[voterId];
  }
  next.lastScores = next.lastScores.filter((s) => s.playerId !== event.playerId);
  const aborted = abortIfTooFewPlayers(next, event.now);
  if (aborted !== null) return aborted;
  const effects: EngineEffect[] = [];
  const advanced = advanceIfComplete(next, event.now);
  if (advanced !== null) {
    next = advanced.state;
    effects.push(...advanced.effects);
  }
  return { state: next, changed: true, effects };
}

// ---------------------------------------------------------------------------
// 受信者ごとの表示データ（§3.2 原則3）
// ---------------------------------------------------------------------------

/**
 * 表示順を決める。
 * 匿名時は**そのラウンドのトークンの昇順**に並べる。トークンは毎ラウンド作り直す乱数なので、
 * クライアントが知っている値（playerId・round・startedAt）からは並び順を再現できない。
 * 以前は公開ハッシュ順だったため、並びから回答者を特定できてしまっていた。
 */
function revealOrder(state: GameState): string[] {
  const ids = scoredPlayerIds(state).filter((id) => state.submissions[id] !== undefined);
  if (state.definition.reveal === "named") return ids;
  return [...ids].sort((a, b) => {
    // トークンが無い場合は playerId で代替せず、末尾へ寄せて順序だけ安定させる
    const ta = revealTokenOf(state, a);
    const tb = revealTokenOf(state, b);
    if (ta === null || tb === null) {
      if (ta === tb) return 0;
      return ta === null ? 1 : -1;
    }
    if (ta === tb) return 0;
    return ta < tb ? -1 : 1;
  });
}

/**
 * reveal / judge に載せる回答一覧を作る。
 * reveal:"named" は本物の playerId と nickname を載せ、匿名時は playerId の代わりに
 * そのラウンドのトークンだけを載せる（nickname は載せない）。
 */
function buildRevealEntries(state: GameState): RevealEntry[] {
  if (state.definition.reveal === "named") {
    return revealOrder(state).map((id) => ({
      playerId: id,
      value: state.submissions[id].value,
      nickname: state.participants[id].nickname,
    }));
  }
  const anonymous = anonymousRevealIds(state);
  const missing = anonymous.filter((e) => e.fallback).length;
  if (missing > 0) {
    // 設計上起こらないはずの経路。playerId は出さず、規模だけを記録する
    console.warn(
      `[engine] 匿名トークンが不足しました: round=${state.round} 不足=${missing}件 表示=${anonymous.length}件`,
    );
  }
  return anonymous.map((e) => ({ playerId: e.publicId, value: state.submissions[e.id].value }));
}

/** 現在のお題の選択肢（choice のみ）。正解は含めない */
function promptOptions(state: GameState): string[] | undefined {
  const prompt = currentPrompt(state);
  if (prompt === null || prompt.kind !== "choice") return undefined;
  return [...prompt.options];
}

/** 現在のお題の本文 */
function promptText(state: GameState): string {
  return currentPrompt(state)?.text ?? "";
}

/**
 * 受信者ごとの PhaseView を組み立てる。
 * 他人の回答内容は reveal 以降にのみ載せ、クイズの正解は reveal まで隠す。
 */
export function buildPhaseView(state: GameState, viewerId: string): PhaseView {
  const def = state.definition;
  const viewer = state.participants[viewerId];
  const totalRounds = def.rounds;
  switch (state.phase) {
    case "lobby":
      return { phase: "lobby", selectedGameId: null };
    case "intro":
      return {
        phase: "intro",
        title: def.title,
        description: def.description,
        totalRounds,
        inputType: def.inputType,
        scoring: def.scoring,
        reveal: def.reveal,
        inputTimeSec: def.inputTimeSec,
      };
    case "prompt":
      return {
        phase: "prompt",
        round: state.round,
        totalRounds,
        promptText: promptText(state),
        options: promptOptions(state),
      };
    case "input": {
      const active = activePlayerIds(state);
      return {
        phase: "input",
        round: state.round,
        totalRounds,
        promptText: promptText(state),
        inputType: def.inputType,
        options: promptOptions(state),
        submitted: state.submissions[viewerId] !== undefined,
        canSubmit: viewer !== undefined && viewer.role === "player" &&
          state.submissions[viewerId] === undefined,
        submittedCount: active.filter((id) => state.submissions[id] !== undefined).length,
        participantCount: active.length,
      };
    }
    case "reveal": {
      const prompt = currentPrompt(state);
      const view: PhaseView = {
        phase: "reveal",
        round: state.round,
        totalRounds,
        promptText: promptText(state),
        inputType: def.inputType,
        options: promptOptions(state),
        reveal: def.reveal,
        entries: buildRevealEntries(state),
      };
      if (def.scoring === "correct" && prompt?.kind === "choice" && prompt.answer !== undefined) {
        view.answerIndex = prompt.answer;
      }
      return view;
    }
    case "judge": {
      const active = activePlayerIds(state);
      const view: JudgePhaseView = {
        phase: "judge",
        round: state.round,
        totalRounds,
        scoring: def.scoring,
        reveal: def.reveal,
        entries: buildRevealEntries(state),
        canVote: def.scoring === "vote" && viewer !== undefined && viewer.role === "player" &&
          state.votes[viewerId] === undefined &&
          eligibleVoteTargets(state, viewerId).length > 0,
        votedCount: active.filter((id) => state.votes[id] !== undefined).length,
        participantCount: active.length,
      };
      // 匿名時は本物の playerId を返さない。投票者は自分が押した entry のIDを知っているので、
      // ここに本物の playerId を載せると1ラウンドにつき1人の身元が確実に割れる
      const myVote = state.votes[viewerId];
      if (myVote !== undefined) {
        if (def.reveal === "named") {
          view.myVoteTargetId = myVote;
        } else {
          const publicId = revealTokenOf(state, myVote) ??
            anonymousRevealIds(state).find((e) => e.id === myVote)?.publicId ?? null;
          if (publicId !== null) view.myVoteTargetId = publicId;
        }
      }
      return view;
    }
    case "roundResult":
      return {
        phase: "roundResult",
        round: state.round,
        totalRounds,
        scores: state.lastScores,
        isFinalRound: state.round >= totalRounds,
      };
    case "finalResult":
      return { phase: "finalResult", totalRounds, scores: state.lastScores };
  }
}
