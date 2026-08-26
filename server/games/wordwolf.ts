/**
 * ワードウルフ（設計書 docs/design/games-unified.md §8 #10 / §2.6 秘密配布）
 *
 * 参加者に「お題（単語）」を配る。1人だけ違う単語を持っており、その人が狼になる。
 * **狼は自分が狼だと知らない。** VC でそのお題について話し、誰が違う単語を持っているかを
 * 探り合い、議論のあと全員で投票して最多票の人を追放する。
 *
 * 勝敗条件はホストが開始時に選ぶ（config フェーズ）:
 *   simple   … 投票で狼を追放できれば市民の勝ち。外せば狼の勝ち
 *   reversal … 狼が追放されても、狼が「市民のお題」を言い当てられたら狼の勝ち（逆転あり）
 *
 * このゲームの肝は「自分の単語以外が絶対に view に載らない」ことにある（§2.6）。
 * 単語と狼の正体は state にだけ置き、view(state, viewerId) が
 *   - discuss / vote / result … 自分の単語だけ
 *   - guess                   … 狼の正体（追放済みなので既に卓に露見している）だけ
 *   - final                   … 全公開
 * を返す。改造クライアントでも他人の単語は見えない（そもそも受信していない）。
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
  randomInt,
  readInt,
  readKind,
  readString,
} from "./module.ts";
import { normalizeMatchValue } from "../engine.ts";
import type { ScoreEntry } from "../types.ts";

/** カタログ上のモジュールID */
export const WORDWOLF_MODULE_ID = "wordwolf";

/** 勝敗条件。ホストが config フェーズで選ぶ */
export type WordWolfMode = "simple" | "reversal";

/** 選べる議論時間（秒）。view にもそのまま出して選択肢を1か所に固定する */
export const WORDWOLF_DISCUSSION_CHOICES: readonly number[] = [180, 300, 420];

/** 既定の勝敗条件・議論時間（ホストが何も触らずに開始したときの値） */
const DEFAULT_MODE: WordWolfMode = "simple";
const DEFAULT_DISCUSSION_SEC = 300;

/** 狼の答え（言い当て）の最大文字数 */
export const WORDWOLF_GUESS_MAX = 40;

/** 設定フェーズの制限時間（ミリ秒）。ホストが放置しても卓が固まらないようにする */
const CONFIG_MS = 120_000;
/** 投票フェーズの制限時間（ミリ秒）。【暫定値】 */
const VOTE_MS = 60_000;
/** 投票結果（追放）の表示時間（ミリ秒）。【暫定値】 */
const RESULT_MS = 12_000;
/** 狼の言い当ての制限時間（ミリ秒）。【暫定値】 */
const GUESS_MS = 45_000;
/** 最終結果の表示時間（ミリ秒）。【暫定値】 */
const FINAL_MS = 20_000;

/**
 * お題ペア。「近すぎず遠すぎない」= 同じ話題で会話が成立するが、
 * 具体的な話をすると食い違いが出る距離を狙っている。
 * 差別的・性的な内容は入れない（CLAUDE.md の方針）。
 */
export const WORDWOLF_WORD_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["ラーメン", "うどん"],
  ["寿司", "刺身"],
  ["犬", "猫"],
  ["海", "川"],
  ["電車", "バス"],
  ["コンビニ", "スーパー"],
  ["焼肉", "しゃぶしゃぶ"],
  ["映画館", "遊園地"],
  ["コーヒー", "紅茶"],
  ["温泉", "銭湯"],
  ["夏祭り", "花火大会"],
  ["カラオケ", "ボウリング"],
  ["桜", "紅葉"],
  ["ピザ", "パスタ"],
  ["冷蔵庫", "洗濯機"],
  ["傘", "レインコート"],
  ["財布", "スマートフォン"],
  ["遠足", "修学旅行"],
  ["図書館", "本屋"],
  ["自転車", "オートバイ"],
  ["枕", "布団"],
  ["カレー", "シチュー"],
  ["卒業式", "入学式"],
  ["靴下", "手袋"],
  ["たこ焼き", "お好み焼き"],
  ["消しゴム", "修正テープ"],
  ["動物園", "水族館"],
  ["アイスクリーム", "かき氷"],
  ["目覚まし時計", "腕時計"],
  ["エレベーター", "エスカレーター"],
];

/**
 * 進行フェーズ。
 * config=設定（ホストが決める）/ discuss=議論 / vote=投票 / result=開票と追放 /
 * guess=狼の言い当て（reversal で狼が追放されたときだけ）/ final=最終結果
 */
export type WordWolfPhase = "config" | "discuss" | "vote" | "result" | "guess" | "final";

/** 勝敗。null は決着前・中断 */
export type WordWolfOutcome = "citizens" | "wolf";

/** 中断の理由。null なら中断していない */
export type WordWolfAbort = "wolfLeft";

/** 参加者1人の状態 */
type WordWolfPlayer = {
  id: string;
  nickname: string;
  /** 接続中か。切断中の人は「全員投票したか」の判定から外す */
  connected: boolean;
};

/** 開票結果の1行。誰が何票入れられたか（誰が入れたかは votedBy に入る） */
export type WordWolfTallyEntry = {
  playerId: string;
  nickname: string;
  /** 得票数 */
  votes: number;
  /** この人に投票した人の playerId（開票後は公開情報） */
  votedBy: string[];
};

/** 最終結果の1行 */
export type WordWolfResultEntry = {
  playerId: string;
  nickname: string;
  /** その人に配られていた単語 */
  word: string;
  /** 狼だったか */
  isWolf: boolean;
  /** 得票数 */
  votes: number;
  /** 勝った側か */
  won: boolean;
};

/** 順位表の1行 */
export type WordWolfStanding = {
  playerId: string;
  nickname: string;
  /** 獲得点（勝ち側1点・負け側0点） */
  points: number;
  /** 1 始まりの順位。同点は同順位 */
  rank: number;
};

/** ワードウルフの全状態。ルーム層はこの中身を知らない */
export type WordWolfState = {
  /** 乱数の種（§2.5）。狼の選出・お題の抽選はこれだけで決定的に決まる */
  seed: number;
  /** 進行中か。false なら終了後（最終結果を表示したまま） */
  running: boolean;
  phase: WordWolfPhase;
  /** 参加者の並び順（同点時の順位を安定させるために保持する） */
  order: string[];
  /** playerId → 参加者 */
  players: Record<string, WordWolfPlayer>;

  // --- 設定（config フェーズで決まる） ---
  /** 勝敗条件。config 中は「開始したら使う値」＝提案中の値 */
  mode: WordWolfMode;
  /** 議論時間（秒） */
  discussionSec: number;
  /** 設定を最後に変えた人の表示名。誰も触っていなければ null（透明性のため view に出す） */
  configuredBy: string | null;
  /** 設定が確定したか（ホストの skipPhase で true になり、以後 config は受け付けない） */
  configLocked: boolean;

  // --- 秘密（§2.6）。view には受信者に許された分しか載せない ---
  /** 狼の playerId。config 中は null */
  wolfId: string | null;
  /** 市民のお題。config 中は空文字 */
  citizenWord: string;
  /** 狼のお題。config 中は空文字 */
  wolfWord: string;
  /** 投票（voter → target）。**秘密**。開票（result）まで view に載せない */
  votes: Record<string, string>;

  // --- 開票以降の結果 ---
  /** 開票結果。result 以降に入る */
  tally: WordWolfTallyEntry[] | null;
  /** 追放された人。同票・無投票で追放なしなら null */
  exiledId: string | null;
  /** 追放者の表示名（キックされても結果が読めるように控えておく） */
  exiledNickname: string | null;
  /** 同票（または無投票）で追放なしになったか */
  voteTie: boolean;
  /** 狼の言い当て（reversal のみ）。未回答は null */
  guess: string | null;
  /** 言い当てが正解だったか。未判定は null */
  guessCorrect: boolean | null;
  /** 勝敗。決着前・中断は null */
  outcome: WordWolfOutcome | null;
  /** 中断の理由。中断していなければ null */
  abort: WordWolfAbort | null;

  /** 現フェーズの期限（epoch ms） */
  deadline: number | null;
};

/** 受信者へ配る表示データ。秘密（他人の単語・狼の正体）を含めないこと */
export type WordWolfView = {
  kind: "wordwolf";
  phase: WordWolfPhase;
  /** 勝敗条件（config 中は提案中の値） */
  mode: WordWolfMode;
  /** 議論時間（秒） */
  discussionSec: number;
  /** 選べる議論時間の一覧（クライアントに選択肢を焼き付けないため view に載せる） */
  discussionChoices: number[];
  /** 設定を最後に変えた人の表示名。誰も触っていなければ null */
  configuredBy: string | null;
  /** 設定が確定したか */
  configLocked: boolean;
  /** 参加者数 */
  playerCount: number;
  /** 自分がこの卓の参加者か（false は観戦者） */
  youArePlayer: boolean;
  /** 参加者ごとの状況。単語・投票先は載せない */
  players: Array<{
    playerId: string;
    nickname: string;
    connected: boolean;
    /** 投票を済ませたか（誰に入れたかは載せない） */
    voted: boolean;
  }>;
  /** 自分に配られた単語。config 中・観戦者は null（§2.6 の肝） */
  myWord: string | null;
  /** 自分の投票先。未投票は null */
  myVote: string | null;
  /** 投票を済ませた人数（誰が誰に入れたかは含めない） */
  votedCount: number;

  /** 開票結果。result 以降にだけ入る */
  tally?: WordWolfTallyEntry[];
  /** 追放された人。追放なしは null。result 以降にだけ入る */
  exiledId?: string | null;
  /** 追放者の表示名。result 以降にだけ入る */
  exiledNickname?: string | null;
  /** 同票（または無投票）で追放なしだったか。result 以降にだけ入る */
  voteTie?: boolean;

  /** 狼の playerId。guess / final にだけ入る（それ以前は絶対に載せない） */
  wolfId?: string;
  /** 自分が狼か。guess / final にだけ入る */
  youAreWolf?: boolean;
  /** 狼の言い当て。guess（回答後）/ final にだけ入る */
  guess?: string | null;
  /** 言い当てが正解だったか。final にだけ入る */
  guessCorrect?: boolean | null;

  /** 市民のお題。final にだけ入る */
  citizenWord?: string;
  /** 狼のお題。final にだけ入る */
  wolfWord?: string;
  /** 勝敗。final にだけ入る（中断なら null） */
  outcome?: WordWolfOutcome | null;
  /** 中断の理由。final で中断していたときだけ入る */
  abort?: WordWolfAbort;
  /** 最終結果の一覧。final にだけ入る */
  results?: WordWolfResultEntry[];
  /** 順位表。final にだけ入る */
  standings?: WordWolfStanding[];
};

/** 状態を浅く複製する（入力 state を変更しない） */
function clone(state: WordWolfState): WordWolfState {
  return {
    ...state,
    order: [...state.order],
    players: { ...state.players },
    votes: { ...state.votes },
    tally: state.tally === null
      ? null
      : state.tally.map((e) => ({ ...e, votedBy: [...e.votedBy] })),
  };
}

export const wordWolfModule: GameModule<WordWolfState, WordWolfView> = {
  id: WORDWOLF_MODULE_ID,
  kind: "module",
  meta: {
    title: "ワードウルフ",
    description: "1人だけ違うお題を持っている。話し合って、違う人を投票で見つけ出す",
    // 2人だと「相手が違う＝自分か相手が狼」で議論が成立しないため3人から
    minPlayers: 3,
    maxPlayers: 10,
  },

  init(input: ModuleInitInput): ModuleResult<WordWolfState> {
    const order: string[] = [];
    const players: Record<string, WordWolfPlayer> = {};
    for (const p of input.players) {
      if (players[p.id] !== undefined) continue;
      order.push(p.id);
      players[p.id] = { id: p.id, nickname: p.nickname, connected: p.connected };
    }
    const state: WordWolfState = {
      seed: nextSeed(input.seed),
      running: true,
      // 最初は設定フェーズ。ホストが skipPhase（「スキップ（ホスト）」ボタン）で開始する
      phase: "config",
      order,
      players,
      mode: DEFAULT_MODE,
      discussionSec: DEFAULT_DISCUSSION_SEC,
      configuredBy: null,
      configLocked: false,
      wolfId: null,
      citizenWord: "",
      wolfWord: "",
      votes: {},
      tally: null,
      exiledId: null,
      exiledNickname: null,
      voteTie: false,
      guess: null,
      guessCorrect: null,
      outcome: null,
      abort: null,
      deadline: input.now + CONFIG_MS,
    };
    return moduleOk(state, [
      { t: "viewChanged" },
      { t: "schedule", at: state.deadline },
    ]);
  },

  reduce(state: WordWolfState, event: ModuleEvent): ModuleResult<WordWolfState> {
    // 終了後に届いたイベントは黙って捨てる。ただし在籍から消える playerKicked だけは
    // 反映しておく（終了後の最終結果に、卓を去った人の名前を残さないため）
    if (!state.running && event.t !== "playerKicked") return moduleNoop(state);

    switch (event.t) {
      case "clientEvent":
        return handleClientEvent(state, event.playerId, event.payload, event.now);
      case "timeout": {
        // 期限に達していなければ何もしない（早すぎる発火への防御）
        if (state.deadline === null || event.now < state.deadline) return moduleNoop(state);
        return advance(state, event.now);
      }
      case "playerJoined":
        // 既定は観戦（§5）。単語は配布済みなので、途中から入れると
        // 「狼が1人」という前提そのものが崩れる
        return moduleNoop(state);
      case "playerLeft": {
        const player = state.players[event.playerId];
        if (player === undefined || !player.connected) return moduleNoop(state);
        const next = clone(state);
        next.players[event.playerId] = { ...player, connected: false };
        // 切断した人を待たずに済むよう、残り全員が投票済みならその場で開票する
        return advanceIfAllVoted(next, event.now) ?? moduleOk(next, [{ t: "viewChanged" }]);
      }
      case "playerRejoined": {
        const player = state.players[event.playerId];
        if (player === undefined || player.connected) return moduleNoop(state);
        const next = clone(state);
        next.players[event.playerId] = { ...player, connected: true };
        return moduleOk(next, [{ t: "viewChanged" }]);
      }
      case "playerKicked":
        return handleKicked(state, event.playerId, event.now);
      case "skipPhase":
        // ホストの操作で現フェーズを打ち切る。期限前でも進める。
        // config フェーズではこれが「この設定で開始する」の意味になる
        return advance(state, event.now);
      case "endGame":
        return finish(state, "hostEnded");
    }
  },

  view(state: WordWolfState, viewerId: string): WordWolfView {
    const isPlayer = state.players[viewerId] !== undefined;
    const view: WordWolfView = {
      kind: "wordwolf",
      phase: state.phase,
      mode: state.mode,
      discussionSec: state.discussionSec,
      discussionChoices: [...WORDWOLF_DISCUSSION_CHOICES],
      configuredBy: state.configuredBy,
      configLocked: state.configLocked,
      playerCount: state.order.length,
      youArePlayer: isPlayer,
      players: state.order.map((id) => {
        const player = state.players[id];
        return {
          playerId: id,
          nickname: player?.nickname ?? "",
          connected: player?.connected ?? false,
          // 「投票したか」だけ。投票先は開票まで state にしか無い（§2.6）
          voted: state.votes[id] !== undefined,
        };
      }),
      // 自分の単語だけを載せる。他人の単語は state にしか無い（§2.6 の肝）
      myWord: wordFor(state, viewerId),
      myVote: state.votes[viewerId] ?? null,
      votedCount: state.order.filter((id) => state.votes[id] !== undefined).length,
    };

    // 開票以降は投票の内訳が公開情報になる
    if (state.tally !== null && isAfterVote(state.phase)) {
      view.tally = state.tally.map((e) => ({ ...e, votedBy: [...e.votedBy] }));
      view.exiledId = state.exiledId;
      view.exiledNickname = state.exiledNickname;
      view.voteTie = state.voteTie;
    }

    // 狼の正体は guess / final でだけ公開する。
    // guess に入るのは「狼が追放された」ときだけなので、卓には既に露見している
    if ((state.phase === "guess" || state.phase === "final") && state.wolfId !== null) {
      view.wolfId = state.wolfId;
      view.youAreWolf = viewerId === state.wolfId;
    }
    if (state.phase === "guess") {
      // 回答済みなら本人にも卓にも見せる。市民のお題はまだ伏せたまま
      view.guess = state.guess;
    }

    if (state.phase === "final") {
      view.guess = state.guess;
      view.guessCorrect = state.guessCorrect;
      view.outcome = state.outcome;
      if (state.abort !== null) view.abort = state.abort;
      // 単語の全公開は最終結果でだけ。ここより手前で載せると即座に破綻する
      if (state.citizenWord !== "") {
        view.citizenWord = state.citizenWord;
        view.wolfWord = state.wolfWord;
        view.results = buildResults(state);
      }
      view.standings = buildStandings(state);
    }
    return view;
  },
};

// ---------------------------------------------------------------------------
// clientEvent（§9.1 payload は先頭で型検証する）
// ---------------------------------------------------------------------------

/**
 * 受理する payload は3種類だけ。
 *   { k: "config", mode: "simple"|"reversal", discussionSec: 180|300|420 }
 *   { k: "vote", targetId: string }
 *   { k: "guess", word: string }
 * 未知の k・形の違うものはすべて INVALID_INPUT で棄却する。
 */
function handleClientEvent(
  state: WordWolfState,
  playerId: string,
  payload: unknown,
  now: number,
): ModuleResult<WordWolfState> {
  if (!isRecord(payload)) {
    return moduleFail(state, "INVALID_INPUT", "ゲーム内イベントの形式が正しくありません");
  }
  switch (readKind(payload)) {
    case "config":
      return handleConfig(state, playerId, payload);
    case "vote":
      return handleVote(state, playerId, payload, now);
    case "guess":
      return handleGuess(state, playerId, payload, now);
    default:
      return moduleFail(state, "INVALID_INPUT", "未知のゲーム内イベントです");
  }
}

/**
 * 設定の変更。
 *
 * 【ホスト判別についての設計判断】
 * モジュールに渡る `init` の players（EnginePlayerInput）にも `clientEvent` にも
 * 「その人がホストか」を示す情報が無く、プロトコル（server/types.ts）は変更できない。
 * 参加順の先頭をホストとみなす方法は、ホスト移譲（rooms.ts のホスト継承）が起きた卓で
 * **本物のホストを締め出す**ため採らない。「最初に config を送った人をホストとみなす」も
 * 早い者勝ちで乗っ取られるため採らない。
 *
 * そこで安全側に倒し、次の2段構えにしている:
 *   1. 設定の変更（この関数）は参加者なら誰でも送れるが、**確定はしない**。
 *      あくまで「開始したらこの設定になる」という提案であり、
 *      誰が最後に変えたか（configuredBy）を view で全員に見せる。
 *   2. 実際に開始する（設定を確定してお題を配る）のは `skipPhase` だけ。
 *      `skipPhase` はルーム層が**ホストであることを検証してから**流すので、
 *      非ホストがゲームを始めることも、ホストの知らない設定で始まることも無い
 *      （ホストは開始直前の view で現在の設定を見てからボタンを押す）。
 * ビュー側（public/room/games/wordwolf.js）では `api.isHost` が false のときは
 * 設定 UI 自体を出さないので、通常の操作で非ホストが設定を触ることはない。
 */
function handleConfig(
  state: WordWolfState,
  playerId: string,
  payload: Record<string, unknown>,
): ModuleResult<WordWolfState> {
  const mode = readMode(payload);
  if (mode === null) {
    return moduleFail(state, "INVALID_INPUT", "勝敗条件の指定が正しくありません");
  }
  const discussionSec = readInt(payload, "discussionSec", 1, 3600);
  if (discussionSec === null || !WORDWOLF_DISCUSSION_CHOICES.includes(discussionSec)) {
    return moduleFail(state, "INVALID_INPUT", "議論時間の指定が正しくありません");
  }
  if (state.phase !== "config" || state.configLocked) {
    return moduleFail(state, "PHASE_MISMATCH", "設定を変更できない時間です");
  }
  const player = state.players[playerId];
  if (player === undefined) {
    return moduleFail(state, "PHASE_MISMATCH", "観戦中のため設定を変更できません");
  }
  if (state.mode === mode && state.discussionSec === discussionSec) {
    // 同じ設定を送り直しただけなら、configuredBy も含めて何も動かさない
    return moduleNoop(state);
  }
  const next = clone(state);
  next.mode = mode;
  next.discussionSec = discussionSec;
  next.configuredBy = player.nickname;
  return moduleOk(next, [{ t: "viewChanged" }]);
}

/** 勝敗条件を読む。列挙にない文字列は null */
function readMode(payload: Record<string, unknown>): WordWolfMode | null {
  const raw = payload.mode;
  if (raw === "simple" || raw === "reversal") return raw;
  return null;
}

/**
 * 投票。自分には投票できず、投票のやり直しもできない。
 * 投票先は開票まで view に載らないので、他人の票を見てから合わせることはできない。
 */
function handleVote(
  state: WordWolfState,
  playerId: string,
  payload: Record<string, unknown>,
  now: number,
): ModuleResult<WordWolfState> {
  // playerId は UUID（36文字）。長さの上限は余裕を持たせつつ有限にしておく
  const targetId = readString(payload, "targetId", 64);
  if (targetId === null) {
    return moduleFail(state, "INVALID_INPUT", "投票先の指定が正しくありません");
  }
  if (targetId === playerId) {
    return moduleFail(state, "INVALID_INPUT", "自分には投票できません");
  }
  if (state.phase !== "vote") {
    return moduleFail(state, "PHASE_MISMATCH", "投票を受け付けていない時間です");
  }
  if (state.players[playerId] === undefined) {
    return moduleFail(state, "PHASE_MISMATCH", "観戦中のため投票できません");
  }
  if (state.players[targetId] === undefined) {
    return moduleFail(state, "INVALID_INPUT", "その人には投票できません");
  }
  if (state.deadline !== null && now > state.deadline) {
    return moduleFail(state, "PHASE_MISMATCH", "投票の期限を過ぎています");
  }
  // 入れ直しを認めると、投票済み人数を見ながら最後に合わせられてしまう
  if (state.votes[playerId] !== undefined) {
    return moduleFail(state, "DUPLICATE", "すでに投票しています");
  }
  const next = clone(state);
  next.votes[playerId] = targetId;
  return advanceIfAllVoted(next, now) ?? moduleOk(next, [{ t: "viewChanged" }]);
}

/** 狼の言い当て（reversal で狼が追放されたときだけ）。狼本人しか送れない */
function handleGuess(
  state: WordWolfState,
  playerId: string,
  payload: Record<string, unknown>,
  now: number,
): ModuleResult<WordWolfState> {
  const word = readString(payload, "word", WORDWOLF_GUESS_MAX);
  if (word === null) {
    return moduleFail(state, "INVALID_INPUT", `${WORDWOLF_GUESS_MAX}文字以内で答えてください`);
  }
  if (state.phase !== "guess") {
    return moduleFail(state, "PHASE_MISMATCH", "言い当てを受け付けていない時間です");
  }
  if (playerId !== state.wolfId) {
    return moduleFail(state, "PHASE_MISMATCH", "あなたは言い当てできません");
  }
  if (state.guess !== null) {
    return moduleFail(state, "DUPLICATE", "すでに答えています");
  }
  if (state.deadline !== null && now > state.deadline) {
    return moduleFail(state, "PHASE_MISMATCH", "言い当ての期限を過ぎています");
  }
  const next = clone(state);
  next.guess = word;
  // 答えた時点で判定して最終結果へ。粘っても得が無いので待たせない
  return settleGuess(next, now);
}

// ---------------------------------------------------------------------------
// 進行
// ---------------------------------------------------------------------------

/** 現フェーズを終えて次へ進める */
function advance(state: WordWolfState, now: number): ModuleResult<WordWolfState> {
  switch (state.phase) {
    case "config":
      return startRound(state, now);
    case "discuss":
      return toVote(state, now);
    case "vote":
      return openVotes(state, now);
    case "result":
      return afterResult(state, now);
    case "guess":
      // 期限切れ・ホストの打ち切り。未回答なら不正解扱い
      return settleGuess(state, now);
    case "final":
      return finish(state, "completed");
  }
}

/**
 * 設定を確定し、お題と狼を決めて議論へ入る。
 * 乱数は state.seed からのみ進める（Math.random() 禁止・§2.5）
 */
function startRound(state: WordWolfState, now: number): ModuleResult<WordWolfState> {
  // 在籍が minPlayers を割っていたら始めない（config 中の離脱で起こりうる）
  if (state.order.length < wordWolfModule.meta.minPlayers) {
    return finish(state, "tooFewPlayers");
  }
  const next = clone(state);
  let seed = next.seed;

  const pair = randomInt(seed, 0, WORDWOLF_WORD_PAIRS.length);
  seed = pair.seed;
  const chosen = WORDWOLF_WORD_PAIRS[pair.value];

  // ペアのどちらを市民側にするかも毎回入れ替える（同じペアが出ても印象が変わる）
  const swap = randomInt(seed, 0, 2);
  seed = swap.seed;
  next.citizenWord = swap.value === 0 ? chosen[0] : chosen[1];
  next.wolfWord = swap.value === 0 ? chosen[1] : chosen[0];

  // 狼は**接続中の人**から選ぶ。order は playerLeft では縮まない（connected が false に
  // なるだけ）ため、そのまま抽選すると config 中に切断した人が狼になり、
  // 「違うお題を持つ1人」が卓に居ないまま議論が始まってしまう。
  // 1人も接続していない極端な場合だけ、従来どおり在籍者全員から選ぶ
  const connected = next.order.filter((id) => next.players[id]?.connected === true);
  const pool = connected.length > 0 ? connected : next.order;
  const pick = randomInt(seed, 0, pool.length);
  seed = pick.seed;
  next.wolfId = pool[pick.value];

  next.seed = seed;
  next.configLocked = true;
  next.phase = "discuss";
  next.deadline = now + next.discussionSec * 1000;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: next.deadline },
  ]);
}

/** 議論を終えて投票へ */
function toVote(state: WordWolfState, now: number): ModuleResult<WordWolfState> {
  const next = clone(state);
  next.phase = "vote";
  next.deadline = now + VOTE_MS;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: next.deadline },
  ]);
}

/**
 * 接続中の参加者が全員投票していれば開票へ進める。まだなら null。
 * 切断中の人を待たないのは、猶予いっぱい卓が止まるのを避けるため
 */
function advanceIfAllVoted(
  state: WordWolfState,
  now: number,
): ModuleResult<WordWolfState> | null {
  if (state.phase !== "vote") return null;
  const connected = state.order.filter((id) => state.players[id]?.connected === true);
  // 全員が切断している間は「待っている人が0人」になってしまうので、期限まで待つ。
  // ここで開票すると、通信が一斉に切れただけで 0 票のまま勝敗が決まってしまう
  if (connected.length === 0) return null;
  const waiting = connected.filter((id) => state.votes[id] === undefined);
  if (waiting.length > 0) return null;
  return openVotes(state, now);
}

/**
 * 開票して追放者を決める。
 *
 * 【同票の扱い（設計判断）】最多票が2人以上いる場合・誰も投票していない場合は
 * **追放なし**とし、「狼を追放できなかった」＝狼側の勝ちとして扱う。
 * 決選投票を入れると議論時間が読めなくなり、VC の飲み会という場に合わないため、
 * 「迷ったら狼が逃げ切る」というシンプルな側へ倒した。
 */
function openVotes(state: WordWolfState, now: number): ModuleResult<WordWolfState> {
  const next = clone(state);
  const counts = new Map<string, string[]>();
  for (const id of next.order) counts.set(id, []);
  for (const voter of next.order) {
    const target = next.votes[voter];
    if (target === undefined) continue;
    const list = counts.get(target);
    if (list === undefined) continue;
    list.push(voter);
  }
  const tally: WordWolfTallyEntry[] = next.order.map((id) => ({
    playerId: id,
    nickname: next.players[id]?.nickname ?? "",
    votes: counts.get(id)?.length ?? 0,
    votedBy: [...(counts.get(id) ?? [])],
  }));
  // 得票の多い順。同数は order の順（sort は安定なのでそのまま残る）
  tally.sort((a, b) => b.votes - a.votes);

  const top = tally.length === 0 ? 0 : tally[0].votes;
  const leaders = tally.filter((e) => e.votes === top && e.votes > 0);
  const decided = leaders.length === 1 ? leaders[0] : null;

  next.tally = tally;
  next.exiledId = decided?.playerId ?? null;
  next.exiledNickname = decided?.nickname ?? null;
  next.voteTie = decided === null;
  next.phase = "result";
  next.deadline = now + RESULT_MS;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: next.deadline },
  ]);
}

/**
 * 開票結果の表示を終えたあと。
 * reversal で狼を追放できたときだけ、狼に逆転のチャンス（言い当て）を与える。
 */
function afterResult(state: WordWolfState, now: number): ModuleResult<WordWolfState> {
  const caught = state.exiledId !== null && state.exiledId === state.wolfId;
  if (state.mode === "reversal" && caught) {
    const next = clone(state);
    next.phase = "guess";
    next.deadline = now + GUESS_MS;
    return moduleOk(next, [
      { t: "viewChanged" },
      { t: "schedule", at: next.deadline },
    ]);
  }
  const next = clone(state);
  // simple も、reversal で狼を捕まえられなかった場合も、ここで決着
  next.outcome = caught ? "citizens" : "wolf";
  return toFinal(next, now);
}

/**
 * 狼の言い当てを判定して最終結果へ。
 * 表記ゆれ（全角/半角・大小文字・カタカナ/ひらがな・空白）は engine.ts の
 * 正規化規則（§3.4）に合わせる。未回答は不正解扱い
 */
function settleGuess(state: WordWolfState, now: number): ModuleResult<WordWolfState> {
  const next = clone(state);
  const correct = next.guess !== null &&
    normalizeMatchValue(next.guess) === normalizeMatchValue(next.citizenWord);
  next.guessCorrect = correct;
  next.outcome = correct ? "wolf" : "citizens";
  return toFinal(next, now);
}

/** 最終結果の表示へ。FINAL_MS 後の timeout で終了する */
function toFinal(state: WordWolfState, now: number): ModuleResult<WordWolfState> {
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
  state: WordWolfState,
  reason: "completed" | "tooFewPlayers" | "hostEnded",
): ModuleResult<WordWolfState> {
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

/** キック（退室・キック・猶予切れ）。在籍から完全に消す */
function handleKicked(
  state: WordWolfState,
  playerId: string,
  now: number,
): ModuleResult<WordWolfState> {
  if (state.players[playerId] === undefined) return moduleNoop(state);
  const next = clone(state);
  next.order = next.order.filter((id) => id !== playerId);
  delete next.players[playerId];
  delete next.votes[playerId];
  // その人へ入っていた票も無効にする（卓を去った人を追放しても意味が無い）
  for (const voter of Object.keys(next.votes)) {
    if (next.votes[voter] === playerId) delete next.votes[voter];
  }
  if (next.tally !== null) {
    next.tally = next.tally
      .filter((e) => e.playerId !== playerId)
      .map((e) => ({ ...e, votedBy: e.votedBy.filter((v) => v !== playerId) }));
  }
  if (!next.running) return moduleOk(next, [{ t: "viewChanged" }]);

  // 在籍が minPlayers を割ったら中断する（§5）
  if (next.order.length < wordWolfModule.meta.minPlayers) {
    return finish(next, "tooFewPlayers");
  }
  // 狼が卓を去ったらゲームそのものが成立しない。勝敗を付けずに中断する。
  // ただし決着済み（final の表示中）なら、出た結果をそのまま残す
  if (next.wolfId !== null && next.wolfId === playerId && next.phase !== "final") {
    next.abort = "wolfLeft";
    next.outcome = null;
    return finish(next, "completed");
  }
  return advanceIfAllVoted(next, now) ?? moduleOk(next, [{ t: "viewChanged" }]);
}

// ---------------------------------------------------------------------------
// 表示・集計の小道具
// ---------------------------------------------------------------------------

/** 開票済みのフェーズか（投票の内訳を公開してよいか） */
function isAfterVote(phase: WordWolfPhase): boolean {
  return phase === "result" || phase === "guess" || phase === "final";
}

/**
 * 受信者に配ってよい単語。参加者でなければ（観戦者）null。
 * config 中はまだ配っていないので null
 */
function wordFor(state: WordWolfState, viewerId: string): string | null {
  if (state.wolfId === null || state.citizenWord === "") return null;
  if (state.players[viewerId] === undefined) return null;
  return viewerId === state.wolfId ? state.wolfWord : state.citizenWord;
}

/** その人が勝ち側か。決着していなければ全員 false */
function isWinner(state: WordWolfState, playerId: string): boolean {
  if (state.outcome === null) return false;
  const isWolf = playerId === state.wolfId;
  return state.outcome === "wolf" ? isWolf : !isWolf;
}

/** 最終結果の一覧（全公開）。単語・狼の正体をここで初めて明かす */
function buildResults(state: WordWolfState): WordWolfResultEntry[] {
  const votesOf = new Map<string, number>();
  for (const e of state.tally ?? []) votesOf.set(e.playerId, e.votes);
  return state.order.map((id) => ({
    playerId: id,
    nickname: state.players[id]?.nickname ?? "",
    word: id === state.wolfId ? state.wolfWord : state.citizenWord,
    isWolf: id === state.wolfId,
    votes: votesOf.get(id) ?? 0,
    won: isWinner(state, id),
  }));
}

/** 順位表。勝ち側1点・負け側0点。同点は同順位（engine.ts の順位付けと同じ規則） */
function buildStandings(state: WordWolfState): WordWolfStanding[] {
  const rows = state.order.map((id) => ({
    playerId: id,
    nickname: state.players[id]?.nickname ?? "",
    points: isWinner(state, id) ? 1 : 0,
    rank: 0,
  }));
  rows.sort((a, b) => b.points - a.points);
  let rank = 0;
  let previous: number | null = null;
  rows.forEach((row, index) => {
    if (previous === null || row.points !== previous) {
      rank = index + 1;
      previous = row.points;
    }
    row.rank = rank;
  });
  return rows;
}

/** 公式スコアへ渡す1ゲーム分の得点。勝ち側に1点 */
function buildScoreEntries(state: WordWolfState): ScoreEntry[] {
  return buildStandings(state).map((row) => ({
    playerId: row.playerId,
    nickname: row.nickname,
    roundScore: 0,
    totalScore: row.points,
    rank: row.rank,
  }));
}
