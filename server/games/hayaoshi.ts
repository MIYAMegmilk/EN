/**
 * 早押しクイズ（設計書 docs/design/games-unified.md §2 / §3 / §7）
 *
 * 4択問題を1問ずつ出し、**最初に早押しボタンを押した人だけ**に回答権を渡す。
 * 正解なら1点。誤答した人は**その問だけ回答不可**（減点はしない。次の問には普通に参加できる）。
 * 誰かが誤答したら回答権が空くので、残った人で早押しを再開する。
 * 全員が回答不可になるか時間切れになったら正解を見せて次の問へ進む。
 *
 * このゲームの肝は「正解が発表まで view に一切載らない」ことにある（§2.6）。
 * 正解の選択肢番号は state（questions[].answer）にだけ置き、view は
 * 出題フェーズでは問題文と選択肢しか返さない。改造クライアントが view を隅々まで
 * 漁っても、reveal 前に正解を知る手段は無い（そもそも受信していない）。
 *
 * ---------------------------------------------------------------------------
 * 進行（フェーズ）
 * ---------------------------------------------------------------------------
 *   ready  … 問題文と選択肢を出すが**まだ押せない**。フライング防止の読み時間（§下記）
 *   buzz   … 早押し受付。最初にサーバーへ届いた buzz を受理して answer へ
 *   answer … 回答権を持つ1人だけが選択肢を選べる
 *   reveal … 正解発表。次の問 or final へ
 *   final  … 最終結果。表示時間のあと ended
 *
 * ---------------------------------------------------------------------------
 * 設計判断
 * ---------------------------------------------------------------------------
 * - **フライング防止**: 出題直後は `ready` フェーズにして READY_MS の間 buzz を
 *   受理しない（PHASE_MISMATCH で棄却するだけで、ペナルティは科さない。飲み会なので
 *   フライングで詰まないほうがよい）。全員が同じ瞬間に押せるようになるので、
 *   「問題文が出た瞬間に連打していた人が勝つ」状態を避けられる。
 * - **同時押しの決着**: サーバーへの到着順のみで決める。reduce はルーム層から
 *   逐次呼ばれるので、先に reduce へ入った buzz が answererId を取り、以降は
 *   phase が answer に変わっているため PHASE_MISMATCH で弾かれる。
 *   クライアントの自己申告時刻は一切見ない（改竄できるため）。
 *   ただし **RTT の個人差は順位に影響する**（§9.2）。この限界はビュー側に注記を出す。
 * - **回答権を持った人の切断**: `playerLeft`（切断）でも `playerKicked`（在籍除外）でも、
 *   即座に回答権を解放してその人をその問の回答不可に入れ、残った人で早押しを再開する。
 *   卓が ANSWER_MS 分止まるのを避けるため。
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
  shuffle,
} from "./module.ts";
import type { ScoreEntry } from "../types.ts";

/** カタログ上のモジュールID */
export const HAYAOSHI_MODULE_ID = "hayaoshi";

/** 選択肢の数（4択固定） */
export const HAYAOSHI_OPTION_COUNT = 4;

/** 1ゲームの出題数。【暫定値】実プレイで調整する */
const TOTAL_QUESTIONS = 5;

/** 出題してから押せるようになるまでの読み時間（ミリ秒）。フライング防止。【暫定値】 */
const READY_MS = 3_000;

/** 早押し受付の制限時間（ミリ秒）。【暫定値】 */
const BUZZ_MS = 12_000;

/** 誤答で回答権が空いたあとの早押し再開時間（ミリ秒）。【暫定値】 */
const BUZZ_RESUME_MS = 8_000;

/** 回答権を得てから答えるまでの制限時間（ミリ秒）。【暫定値】 */
const ANSWER_MS = 7_000;

/** 正解発表の表示時間（ミリ秒）。【暫定値】 */
const REVEAL_MS = 5_000;

/** 最終結果の表示時間（ミリ秒）。【暫定値】 */
const FINAL_MS = 10_000;

/** 進行フェーズ */
export type HayaoshiPhase = "ready" | "buzz" | "answer" | "reveal" | "final";

/** 問題バンクの1問 */
export type HayaoshiQuestion = {
  text: string;
  /** 選択肢。必ず HAYAOSHI_OPTION_COUNT 個 */
  options: readonly string[];
  /** 正解の選択肢番号（0 始まり） */
  answer: number;
};

/**
 * 出題用に確定した1問（選択肢の並びを seed で入れ替えたあとの形）。
 * **answer は秘密**。view には reveal フェーズ以降しか載せない
 */
export type HayaoshiRoundQuestion = {
  text: string;
  options: string[];
  answer: number;
};

/** 参加者1人の状態 */
type HayaoshiPlayer = {
  id: string;
  nickname: string;
  /** 接続中か。切断中の人は早押しの待ち対象から外す */
  connected: boolean;
};

/** 正解発表の内容。reveal フェーズになって初めて view へ載る */
export type HayaoshiReveal = {
  questionNo: number;
  /** 正解の選択肢番号 */
  correct: number;
  /** 正解の選択肢の文言 */
  correctText: string;
  /** 正解した人。誰も正解できなければ null */
  winnerId: string | null;
  winnerNickname: string | null;
  /** 誤答・時間切れ・切断で回答権を失った人（この問だけ回答不可になった人） */
  missedIds: string[];
};

/** 順位表の1行 */
export type HayaoshiStanding = {
  playerId: string;
  nickname: string;
  score: number;
  /** 1 始まりの順位。同点は同順位 */
  rank: number;
};

/** 早押しクイズの全状態。ルーム層はこの中身を知らない */
export type HayaoshiState = {
  /** 乱数の種。出題順・選択肢の並べ替えに使い、使うたびに進める（§2.5） */
  seed: number;
  /** 進行中か。false なら終了後（最終結果を表示したまま） */
  running: boolean;
  phase: HayaoshiPhase;
  /** 現在の問題番号。1..totalQuestions */
  questionNo: number;
  totalQuestions: number;
  /** 出題する問題（**answer を含む秘密**）。init で決定的に選ぶ */
  questions: HayaoshiRoundQuestion[];
  /** 参加者の並び順（同点時の順位を安定させるために保持する） */
  order: string[];
  /** playerId → 参加者 */
  players: Record<string, HayaoshiPlayer>;
  /** playerId → 正解数（そのまま得点） */
  scores: Record<string, number>;
  /** いま回答権を持っている人。誰も持っていなければ null */
  answererId: string | null;
  /** この問でもう回答できない人（誤答・時間切れ・回答中の切断）。次の問で空に戻す */
  blocked: string[];
  /** 直近の正解発表。ready / buzz / answer では null */
  lastReveal: HayaoshiReveal | null;
  /** 現フェーズの期限（epoch ms）。表示の秒読みも兼ねる */
  deadline: number | null;
};

/** 受信者へ配る表示データ。**正解（answer）を含めないこと** */
export type HayaoshiView = {
  kind: "hayaoshi";
  phase: HayaoshiPhase;
  questionNo: number;
  totalQuestions: number;
  /** 出題中の問題。正解番号は入らない。final では null */
  question: { text: string; options: string[] } | null;
  /** 回答権を持っている人。いなければ null */
  answererId: string | null;
  answererNickname: string | null;
  /** 自分が回答権を持っているか */
  iAmAnswerer: boolean;
  /** 自分がいま早押しできるか（クライアントのボタン制御用） */
  canBuzz: boolean;
  /** 自分がこの問で回答不可になっているか */
  amBlocked: boolean;
  /** 参加者一覧 */
  players: Array<{
    playerId: string;
    nickname: string;
    connected: boolean;
    score: number;
    /** この問で回答不可か */
    blocked: boolean;
    /** いま回答権を持っているか */
    answering: boolean;
  }>;
  /** 正解発表。reveal フェーズのときだけ入る */
  reveal?: HayaoshiReveal;
  /** 得点の順位表。常に入る */
  standings: HayaoshiStanding[];
};

// ---------------------------------------------------------------------------
// 問題バンク
// ---------------------------------------------------------------------------

/**
 * 出題する4択問題。
 *
 * `server/official_games.ts` の `QUIZ` は import せず、このモジュール専用に持つ。
 * 理由は2つ。
 *   1. `QUIZ` は別担当が管理する宣言的ゲーム定義（`GameDefinition`）で、
 *      問題の増減・並び替えが自由に行われる。専用モジュールの出題数・正解位置の
 *      前提がそこに引きずられると、他人の編集でこちらのテストが壊れる。
 *   2. `GameDefinition` は prompt モジュール側の型で、kind:"module" のゲームが
 *      それに依存すると層をまたぐ結合になる（設計書 §4 の切り分けに反する）。
 *
 * 収録は事実として確実に定まるものだけに限る（年で変わる記録・諸説あるもの・
 * 主観が入るものは入れない）。正解位置は0〜3に均等（各7問）に散らしてあり、
 * さらに init で選択肢の並びを seed で入れ替えるので、位置で当てることはできない。
 */
export const HAYAOSHI_QUESTIONS: readonly HayaoshiQuestion[] = [
  // --- 1〜4（正解位置 2, 0, 3, 1） ---
  { text: "1ダースは何個？", options: ["6個", "10個", "12個", "24個"], answer: 2 },
  { text: "水の化学式は？", options: ["H2O", "CO2", "O2", "NaCl"], answer: 0 },
  { text: "1時間は何秒？", options: ["360秒", "600秒", "6000秒", "3600秒"], answer: 3 },
  {
    text: "太陽系でいちばん大きい惑星は？",
    options: ["土星", "木星", "天王星", "海王星"],
    answer: 1,
  },

  // --- 5〜8（正解位置 0, 3, 1, 2） ---
  {
    text: "アルファベット（英語）は全部で何文字？",
    options: ["26文字", "24文字", "25文字", "27文字"],
    answer: 0,
  },
  {
    text: "イタリアの首都は？",
    options: ["ミラノ", "ナポリ", "トリノ", "ローマ"],
    answer: 3,
  },
  {
    text: "オーストラリアの首都は？",
    options: ["シドニー", "キャンベラ", "メルボルン", "パース"],
    answer: 1,
  },
  {
    text: "元素記号「Fe」が表す金属は？",
    options: ["金", "銀", "鉄", "銅"],
    answer: 2,
  },

  // --- 9〜12（正解位置 3, 1, 2, 0） ---
  {
    text: "1年でいちばん昼が短くなる日を何という？",
    options: ["夏至", "春分", "秋分", "冬至"],
    answer: 3,
  },
  {
    text: "オリンピックのシンボルマークの輪はいくつ？",
    options: ["4つ", "5つ", "6つ", "7つ"],
    answer: 1,
  },
  {
    text: "ジョーカーを除いたトランプ1組の枚数は？",
    options: ["48枚", "50枚", "52枚", "54枚"],
    answer: 2,
  },
  {
    text: "サッカーで1チームがフィールドに出す人数は？",
    options: ["11人", "9人", "10人", "12人"],
    answer: 0,
  },

  // --- 13〜16（正解位置 1, 2, 0, 3） ---
  {
    text: "野球で1チームが守備につく人数は？",
    options: ["8人", "9人", "10人", "11人"],
    answer: 1,
  },
  {
    text: "画家として知られるピカソの本業は？",
    options: ["作曲家", "建築家", "画家", "詩人"],
    answer: 2,
  },
  {
    text: "太陽系で太陽にいちばん近い惑星は？",
    options: ["水星", "金星", "地球", "火星"],
    answer: 0,
  },
  {
    text: "日本の国会を構成するのは衆議院と何院？",
    options: ["貴族院", "元老院", "枢密院", "参議院"],
    answer: 3,
  },

  // --- 17〜20（正解位置 0, 2, 1, 3） ---
  { text: "1kmは何m？", options: ["1000m", "10m", "100m", "10000m"], answer: 0 },
  {
    text: "チェス盤のマス目はいくつ？",
    options: ["36マス", "49マス", "64マス", "81マス"],
    answer: 2,
  },
  {
    text: "三角形の内角の和は？",
    options: ["90度", "180度", "270度", "360度"],
    answer: 1,
  },
  {
    text: "元素記号「Au」が表す金属は？",
    options: ["銀", "銅", "鉄", "金"],
    answer: 3,
  },

  // --- 21〜24（正解位置 3, 0, 2, 1） ---
  {
    text: "地球のまわりを回っている衛星「月」はいくつ？",
    options: ["0個", "2個", "4個", "1個"],
    answer: 3,
  },
  {
    text: "日本の元号で「平成」の次は？",
    options: ["令和", "昭和", "大正", "明治"],
    answer: 0,
  },
  {
    text: "二酸化炭素の化学式は？",
    options: ["CO", "O3", "CO2", "H2O"],
    answer: 2,
  },
  {
    text: "将棋で対局開始時に片方が並べる駒の数は？",
    options: ["16枚", "20枚", "18枚", "22枚"],
    answer: 1,
  },

  // --- 25〜28（正解位置 1, 3, 0, 2） ---
  {
    text: "光の三原色は「赤」「緑」とあと1つは？",
    options: ["黄", "青", "白", "紫"],
    answer: 1,
  },
  {
    text: "ABO式血液型に含まれないのは？",
    options: ["A型", "B型", "O型", "C型"],
    answer: 3,
  },
  {
    text: "日本の硬貨で穴が空いているのは5円玉と何円玉？",
    options: ["50円玉", "1円玉", "10円玉", "100円玉"],
    answer: 0,
  },
  {
    text: "1辺が1cmの正方形の面積は？",
    options: ["4平方cm", "2平方cm", "1平方cm", "0.5平方cm"],
    answer: 2,
  },
];

// ---------------------------------------------------------------------------
// モジュール
// ---------------------------------------------------------------------------

/** 状態を浅く複製する（入力 state を変更しない） */
function clone(state: HayaoshiState): HayaoshiState {
  return {
    ...state,
    questions: state.questions.map((q) => ({ ...q, options: [...q.options] })),
    order: [...state.order],
    players: { ...state.players },
    scores: { ...state.scores },
    blocked: [...state.blocked],
  };
}

/**
 * 出題する問題を seed から決定的に選ぶ。
 * 問題の順番と、各問の選択肢の並びの両方を入れ替える（位置で当てられないように）
 */
function pickQuestions(
  seed: number,
  count: number,
): { seed: number; value: HayaoshiRoundQuestion[] } {
  const picked = shuffle(seed, HAYAOSHI_QUESTIONS);
  let s = picked.seed;
  const value: HayaoshiRoundQuestion[] = [];
  for (const q of picked.value.slice(0, count)) {
    const indexes = q.options.map((_, i) => i);
    const mixed = shuffle(s, indexes);
    s = mixed.seed;
    value.push({
      text: q.text,
      options: mixed.value.map((i) => q.options[i]),
      answer: mixed.value.indexOf(q.answer),
    });
  }
  return { seed: s, value };
}

/** 現在の問題。範囲外なら null（防御的。通常は起きない） */
function currentQuestion(state: HayaoshiState): HayaoshiRoundQuestion | null {
  return state.questions[state.questionNo - 1] ?? null;
}

export const hayaoshiModule: GameModule<HayaoshiState, HayaoshiView> = {
  id: HAYAOSHI_MODULE_ID,
  kind: "module",
  meta: {
    title: "早押しクイズ",
    description: "4択クイズを早押しで。最初に押した人だけが答えられる。誤答するとその問はお休み",
    minPlayers: 2,
    maxPlayers: 10,
  },

  init(input: ModuleInitInput): ModuleResult<HayaoshiState> {
    const order: string[] = [];
    const players: Record<string, HayaoshiPlayer> = {};
    const scores: Record<string, number> = {};
    for (const p of input.players) {
      if (players[p.id] !== undefined) continue;
      order.push(p.id);
      players[p.id] = { id: p.id, nickname: p.nickname, connected: p.connected };
      scores[p.id] = 0;
    }
    const picked = pickQuestions(nextSeed(input.seed), TOTAL_QUESTIONS);
    const state: HayaoshiState = {
      seed: picked.seed,
      running: true,
      phase: "ready",
      questionNo: 1,
      totalQuestions: picked.value.length,
      questions: picked.value,
      order,
      players,
      scores,
      answererId: null,
      blocked: [],
      lastReveal: null,
      deadline: input.now + READY_MS,
    };
    return moduleOk(state, [
      { t: "viewChanged" },
      { t: "schedule", at: state.deadline },
    ]);
  },

  reduce(state: HayaoshiState, event: ModuleEvent): ModuleResult<HayaoshiState> {
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
        // 既定は観戦（§5）。進行中の問題に割り込ませると、その問だけ
        // 「まだ押していない人」の数が変わって早押しの前提がぶれる
        return moduleNoop(state);
      case "playerLeft": {
        const player = state.players[event.playerId];
        if (player === undefined || !player.connected) return moduleNoop(state);
        const next = clone(state);
        next.players[event.playerId] = { ...player, connected: false };
        // 回答権を持ったまま切断されると卓が ANSWER_MS 分止まる。すぐ権利を解放する
        if (next.answererId === event.playerId && next.phase === "answer") {
          return releaseAnswerer(next, event.now);
        }
        return moduleOk(next, [{ t: "viewChanged" }]);
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
        next.blocked = next.blocked.filter((id) => id !== event.playerId);
        delete next.players[event.playerId];
        delete next.scores[event.playerId];
        // 正解発表からも当人の行を消す（卓を去った人の記録を残さない）
        if (next.lastReveal !== null) {
          next.lastReveal = {
            ...next.lastReveal,
            winnerId: next.lastReveal.winnerId === event.playerId ? null : next.lastReveal.winnerId,
            winnerNickname: next.lastReveal.winnerId === event.playerId
              ? null
              : next.lastReveal.winnerNickname,
            missedIds: next.lastReveal.missedIds.filter((id) => id !== event.playerId),
          };
        }
        if (!next.running) return moduleOk(next, [{ t: "viewChanged" }]);
        // 在籍が minPlayers を割ったら中断する（§5）
        if (next.order.length < hayaoshiModule.meta.minPlayers) {
          return finish(next, "tooFewPlayers");
        }
        // 回答権を持ったまま除外されたら、残った人で早押しを再開する
        if (next.answererId === event.playerId && next.phase === "answer") {
          next.answererId = null;
          return resumeOrReveal(next, event.now, null);
        }
        return moduleOk(next, [{ t: "viewChanged" }]);
      }
      case "skipPhase":
        // ホストの操作で現フェーズを打ち切る。期限前でも進める
        return advance(state, event.now);
      case "endGame":
        return finish(state, "hostEnded");
    }
  },

  /**
   * 受信者ごとの表示データ。
   * **正解（questions[].answer）は reveal フェーズになるまで一切載せない**（§2.6）。
   * 未出題の問題も載せない（先読みできてしまうため）
   */
  view(state: HayaoshiState, viewerId: string): HayaoshiView {
    const question = currentQuestion(state);
    const isBlocked = state.blocked.includes(viewerId);
    const joined = state.players[viewerId] !== undefined;
    const view: HayaoshiView = {
      kind: "hayaoshi",
      phase: state.phase,
      questionNo: state.questionNo,
      totalQuestions: state.totalQuestions,
      // final では問題を出さない。それ以外でも answer は決して含めない
      question: state.phase === "final" || question === null
        ? null
        : { text: question.text, options: [...question.options] },
      answererId: state.answererId,
      answererNickname: state.answererId === null
        ? null
        : state.players[state.answererId]?.nickname ?? null,
      iAmAnswerer: state.answererId === viewerId,
      canBuzz: state.phase === "buzz" && joined && !isBlocked,
      amBlocked: isBlocked,
      players: state.order.map((id) => {
        const player = state.players[id];
        return {
          playerId: id,
          nickname: player?.nickname ?? "",
          connected: player?.connected ?? false,
          score: state.scores[id] ?? 0,
          blocked: state.blocked.includes(id),
          answering: state.answererId === id,
        };
      }),
      standings: buildStandings(state),
    };
    // 正解が view に載るのはここだけ。reveal フェーズに入って初めて公開する
    if (state.phase === "reveal" && state.lastReveal !== null) {
      view.reveal = state.lastReveal;
    }
    return view;
  },
};

// ---------------------------------------------------------------------------
// クライアントイベント（§9.1）
// ---------------------------------------------------------------------------

/**
 * 受理する payload は次の2種類だけ。
 *   `{ k: "buzz" }`                       … 早押し
 *   `{ k: "answer", choice: 0..3 の整数 }` … 回答
 * 形が少しでも違えば INVALID_INPUT で棄却する
 */
function handleClientEvent(
  state: HayaoshiState,
  playerId: string,
  payload: unknown,
  now: number,
): ModuleResult<HayaoshiState> {
  if (!isRecord(payload)) {
    return moduleFail(state, "INVALID_INPUT", "ゲーム内イベントの形式が正しくありません");
  }
  switch (readKind(payload)) {
    case "buzz":
      return handleBuzz(state, playerId, now);
    case "answer": {
      const choice = readInt(payload, "choice", 0, HAYAOSHI_OPTION_COUNT - 1);
      if (choice === null) {
        return moduleFail(state, "INVALID_INPUT", "選択肢の番号が正しくありません");
      }
      return handleAnswer(state, playerId, choice, now);
    }
    default:
      return moduleFail(state, "INVALID_INPUT", "未知のゲーム内イベントです");
  }
}

/**
 * 早押し。**サーバーへ先に届いた1件だけ**を受理する。
 * reduce はルーム層から逐次呼ばれるので、勝者は「先に reduce へ入ったほう」で決まる
 */
function handleBuzz(
  state: HayaoshiState,
  playerId: string,
  now: number,
): ModuleResult<HayaoshiState> {
  if (state.players[playerId] === undefined) {
    return moduleFail(state, "PHASE_MISMATCH", "観戦中のため回答できません");
  }
  if (state.phase === "ready") {
    return moduleFail(state, "PHASE_MISMATCH", "まだ押せません（問題を読む時間です）");
  }
  if (state.phase === "answer") {
    // 同時押しで負けた側はここに来る。状態は一切動かさない
    return moduleFail(state, "PHASE_MISMATCH", "ほかの人が先に押しました");
  }
  if (state.phase !== "buzz") {
    return moduleFail(state, "PHASE_MISMATCH", "早押しを受け付けていない時間です");
  }
  if (state.blocked.includes(playerId)) {
    return moduleFail(state, "DUPLICATE", "この問題ではもう回答できません");
  }
  if (state.deadline !== null && now > state.deadline) {
    return moduleFail(state, "PHASE_MISMATCH", "早押しの期限を過ぎています");
  }
  const next = clone(state);
  next.answererId = playerId;
  next.phase = "answer";
  next.deadline = now + ANSWER_MS;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: next.deadline },
  ]);
}

/** 回答。回答権を持っている本人だけが answer フェーズ中に送れる */
function handleAnswer(
  state: HayaoshiState,
  playerId: string,
  choice: number,
  now: number,
): ModuleResult<HayaoshiState> {
  if (state.phase !== "answer") {
    return moduleFail(state, "PHASE_MISMATCH", "回答を受け付けていない時間です");
  }
  if (state.answererId !== playerId) {
    return moduleFail(state, "PHASE_MISMATCH", "回答権がありません");
  }
  if (state.deadline !== null && now > state.deadline) {
    return moduleFail(state, "PHASE_MISMATCH", "回答の期限を過ぎています");
  }
  const question = currentQuestion(state);
  if (question === null) {
    return moduleFail(state, "PHASE_MISMATCH", "出題中の問題がありません");
  }
  if (choice === question.answer) {
    const next = clone(state);
    next.scores[playerId] = (next.scores[playerId] ?? 0) + 1;
    next.answererId = null;
    return toReveal(next, now, playerId);
  }
  // 誤答。減点はせず、この問だけ回答不可にして残りの人で早押しを再開する
  return releaseAnswerer(clone(state), now);
}

// ---------------------------------------------------------------------------
// 進行
// ---------------------------------------------------------------------------

/**
 * 回答権を持っている人をこの問の回答不可にして権利を解放する。
 * 誤答・回答の時間切れ・回答権を持ったままの切断で呼ぶ（いずれも減点はしない）。
 *
 * **引数は clone() 済みの下書き（draft）を渡すこと。** この関数は draft をその場で
 * 書き換える。呼び出し側が生の入力 state を渡すと規約2（入力 state を変更しない）に反する
 */
function releaseAnswerer(draft: HayaoshiState, now: number): ModuleResult<HayaoshiState> {
  const answererId = draft.answererId;
  if (answererId !== null && !draft.blocked.includes(answererId)) {
    draft.blocked = [...draft.blocked, answererId];
  }
  draft.answererId = null;
  return resumeOrReveal(draft, now, null);
}

/**
 * まだ押せる人が残っていれば早押しを再開し、いなければ正解発表へ進む。
 * 切断中の人は「押せる人」に数えない（誰も押せないまま期限まで卓が止まるのを避ける）。
 *
 * **引数は clone() 済みの下書き（draft）を渡すこと**（releaseAnswerer と同じ）
 */
function resumeOrReveal(
  draft: HayaoshiState,
  now: number,
  winnerId: string | null,
): ModuleResult<HayaoshiState> {
  const remaining = draft.order.filter((id) =>
    !draft.blocked.includes(id) && draft.players[id]?.connected === true
  );
  if (remaining.length === 0) return toReveal(draft, now, winnerId);
  draft.phase = "buzz";
  draft.deadline = now + BUZZ_RESUME_MS;
  return moduleOk(draft, [
    { t: "viewChanged" },
    { t: "schedule", at: draft.deadline },
  ]);
}

/**
 * 正解発表へ。ここで初めて正解が view に載る。
 *
 * **引数は clone() 済みの下書き（draft）を渡すこと**（releaseAnswerer と同じ）
 */
function toReveal(
  draft: HayaoshiState,
  now: number,
  winnerId: string | null,
): ModuleResult<HayaoshiState> {
  const next = draft;
  const question = currentQuestion(next);
  next.phase = "reveal";
  next.answererId = null;
  next.lastReveal = {
    questionNo: next.questionNo,
    correct: question?.answer ?? -1,
    correctText: question === null ? "" : question.options[question.answer] ?? "",
    winnerId,
    winnerNickname: winnerId === null ? null : next.players[winnerId]?.nickname ?? null,
    missedIds: [...next.blocked],
  };
  next.deadline = now + REVEAL_MS;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: next.deadline },
  ]);
}

/** 次の問題へ。回答不可の記録は問ごとに空へ戻す */
function nextQuestion(state: HayaoshiState, now: number): ModuleResult<HayaoshiState> {
  const next = clone(state);
  next.questionNo += 1;
  next.phase = "ready";
  next.answererId = null;
  next.blocked = [];
  next.lastReveal = null;
  next.deadline = now + READY_MS;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: next.deadline },
  ]);
}

/** 最終結果の表示へ。FINAL_MS 後の timeout で終了する */
function toFinal(state: HayaoshiState, now: number): ModuleResult<HayaoshiState> {
  const next = clone(state);
  next.phase = "final";
  next.answererId = null;
  next.lastReveal = null;
  next.deadline = now + FINAL_MS;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: next.deadline },
  ]);
}

/**
 * 現フェーズを終えて次へ進める（timeout と、ホストの skipPhase の共通処理）。
 * ready→buzz / buzz→正解発表 / answer→回答権を手放して再開 or 正解発表 /
 * reveal→次の問 or 最終結果 / final→終了
 */
function advance(state: HayaoshiState, now: number): ModuleResult<HayaoshiState> {
  switch (state.phase) {
    case "ready": {
      const next = clone(state);
      next.phase = "buzz";
      next.deadline = now + BUZZ_MS;
      return moduleOk(next, [
        { t: "viewChanged" },
        { t: "schedule", at: next.deadline },
      ]);
    }
    case "buzz":
      // 誰も押さないまま時間切れ。正解を見せて次へ
      return toReveal(clone(state), now, null);
    case "answer":
      // 時間内に答えられなかった。誤答と同じ扱い（減点なし・この問だけ回答不可）
      return releaseAnswerer(clone(state), now);
    case "reveal":
      if (state.questionNo >= state.totalQuestions) return toFinal(state, now);
      return nextQuestion(state, now);
    case "final":
      return finish(state, "completed");
  }
}

/**
 * ゲームを終える。score は1ゲーム1回、schedule は必ず解除する。
 * 終了後も state は捨てず、最終結果を表示したままにする（running のみ false）
 */
function finish(
  state: HayaoshiState,
  reason: "completed" | "tooFewPlayers" | "hostEnded",
): ModuleResult<HayaoshiState> {
  const next = clone(state);
  next.running = false;
  next.phase = "final";
  next.answererId = null;
  next.lastReveal = null;
  next.deadline = null;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: null },
    { t: "score", totals: buildScoreEntries(next) },
    { t: "ended", reason },
  ]);
}

/** 正解数の順位表。同点は同順位（engine.ts の順位付けと同じ規則） */
function buildStandings(state: HayaoshiState): HayaoshiStanding[] {
  const rows = state.order.map((id) => ({
    playerId: id,
    nickname: state.players[id]?.nickname ?? "",
    score: state.scores[id] ?? 0,
    rank: 0,
  }));
  rows.sort((a, b) => b.score - a.score);
  let rank = 0;
  let previous: number | null = null;
  rows.forEach((row, index) => {
    if (previous === null || row.score !== previous) {
      rank = index + 1;
      previous = row.score;
    }
    row.rank = rank;
  });
  return rows;
}

/** 公式スコアへ渡す1ゲーム分の得点。正解数をそのまま点にする */
function buildScoreEntries(state: HayaoshiState): ScoreEntry[] {
  return buildStandings(state).map((row) => ({
    playerId: row.playerId,
    nickname: row.nickname,
    roundScore: 0,
    totalScore: row.score,
    rank: row.rank,
  }));
}
