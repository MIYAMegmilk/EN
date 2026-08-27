/**
 * bot の判断ロジック（しゅんぴ / せり / ぐっちー / なべ）
 * 詳細仕様書 §3.10 に対応する。ひろし担当。
 *
 * 責務:
 *   - ルームで起きた出来事を受け取り、bot が何を発話するかだけを決める
 *   - 発話の配信・タイマー設置は行わない（rooms.ts の役目）
 *
 * 規約（engine.ts と同じ）: reduce は純粋関数。時刻・乱数・川柳判定は
 * BotContext から注入する。このファイルに await と副作用を書かない。
 *
 * 仕様書との差分（§3.10 の改訂をチームに要請中）:
 *   - 「bot はルームに1体まで」→ 役割の違う4体にする
 *     （しゅんぴ=命名 / せり=川柳 / ぐっちー=場を温める / なべ=進行を仕切る）
 *   - 「10分あたり最大5発話」→ 発話枠は bot ごとに独立して数える。
 *     ぐっちー 10分5発話・なべ 10分2発話。しゅんぴとせりは枠を持たない
 *     （どちらも人の行動に1対1で応じる発話で、自発的に喋らないため）
 *   - 「チャット・ゲーム操作が3分ない場合に沈黙」→ VC の文字起こしも活動に数える
 *   - 沈黙とみなすまでの時間を3分→30秒に詰める（SILENCE_MS）。3分の間は
 *     呑み会には長すぎて、場が冷えきってから話題が飛んでくる
 *
 * ぐっちーとなべを分けた理由（中間レビューの「ぐっちー過労問題」）:
 *   10種類ある発話のうち6種類が1体に集まっていて、1つの枠を役割どうしで
 *   食い合っていた。とくに挨拶が話題カード・ゲーム提案・アンケートに枠を奪われ、
 *   大人数が同時入室すると4人目以降が無視される。役割を割って枠も分けたので、
 *   ぐっちーが枠を使い切ってもなべは進行でき、その逆も同じ。
 *
 * 通話対応（docs/design/bot-voice.md）:
 *   各参加者のブラウザが自分のマイクを文字起こしして送ってくる発言を
 *   source: "voice" として受け取り、そこから川柳を拾う。**bot が喋るのは
 *   あくまでチャットのみ**（§3.10 / 設計書§3）。音声合成は使わない。
 */

import {
  BOT_IDS,
  type BotId,
  CLOSING_TEXTS,
  CONTINUE_TEXTS,
  END_POLL_TEXTS,
  fill,
  FINAL_REACTION_TEXTS,
  GAME_SUGGEST_TEXTS,
  GREETING_TEXTS,
  NAMING_TEXTS,
  NICKNAME_ADJECTIVES,
  NICKNAME_NOUNS,
  pick,
  ROUND_REACTION_TEXTS,
  SENRYU_EXACT_TEXTS,
  SENRYU_LOOSE_TEXTS,
  SENRYU_VOICE_TEXTS,
  TAG_NICKNAME_WORDS,
  TAGGED_NAMING_TEXTS,
  TOPIC_CARDS,
  type TopicCard,
} from "./bot_templates.ts";
import { type HobbyTagId, hobbyTagLabel } from "./hobby_tags.ts";
import { SENRYU_PATTERN, type SenryuMatch } from "./senryu.ts";
import type { BotCard, BotKind, ErrorCode, Phase } from "./types.ts";
import { NICKNAME_MAX } from "./types.ts";

export { BOT_IDS, type BotId, BOTS } from "./bot_templates.ts";

// ---------------------------------------------------------------------------
// 定数（§3.10）
// ---------------------------------------------------------------------------

/** 自発的に喋る bot の発話頻度を見る窓（ミリ秒）。窓の長さは全 bot 共通 */
export const BOT_RATE_WINDOW_MS = 10 * 60_000;
/** 窓のなかで許すぐっちー（挨拶・話題カード・相槌）の発話数 */
export const GUCCHI_RATE_MAX = 5;
/**
 * 窓のなかで許すなべ（ゲーム提案・終了アンケート・締め）の発話数。
 *
 * ぐっちーより小さいのは、bot 全体のうるささを分割前より増やさないため。
 * なべの発話はもともと GAME_SUGGEST_RESET_MS（30分）・END_POLL_COOLDOWN_MS（60分）・
 * END_POLL_MAX（2回）で強く制限されているので、10分に2発話あれば足りる。
 */
export const NABE_RATE_MAX = 2;
/**
 * 沈黙とみなすまでの無操作時間（ミリ秒）。
 *
 * 仕様書 §3.10 は3分だが、呑み会の間としては長すぎる（会話が途切れてから
 * 3分黙っていると、場が温まる前に落ちてしまう）ので30秒に詰めた。
 * ぐっちーの話題カードと、なべの stuck 判定（ゲーム提案・終了アンケート）が
 * まとめてこの値を起点にする。
 *
 * 注意: 実際の発火間隔は rooms.ts の BOT_TICK_MS（tick の周期）で丸められる。
 * この値を BOT_TICK_MS より短くしても、tick が来るまで判定は走らない。
 */
export const SILENCE_MS = 30_000;
/** 話題カードを続けて投げる上限。無人の場で喋り続けないため */
export const SILENCE_MAX_STREAK = 2;
/** ロビーでゲームを提案するまでの経過時間（ミリ秒） */
export const LOBBY_SUGGEST_MS = 5 * 60_000;
/** ロビー起点のゲーム提案に必要な「会話の切れ目」の長さ（ミリ秒） */
export const LOBBY_QUIET_MS = 60_000;
/**
 * 提案済みゲームを再び候補に戻すまでの間隔（ミリ秒）。
 * 収録ゲームは3本しかないので、序盤に出し切ると以後まったく提案できなくなる。
 * 一巡したら時間をおいて誘い直す。
 */
export const GAME_SUGGEST_RESET_MS = 30 * 60_000;
/** 終了アンケートの集計時間（ミリ秒） */
export const END_POLL_MS = 60_000;
/**
 * 終了アンケートを出し直せるようになるまでの間隔（ミリ秒）。
 * 「続行」で終わったあとに使う。断られた直後に訊き直すとしつこいので長めにとる。
 */
export const END_POLL_COOLDOWN_MS = 60 * 60_000;
/** 1ルームで終了アンケートを出せる回数の上限 */
export const END_POLL_MAX = 2;
/**
 * 終了アンケートを切り出せるようになるまでの、ルーム開始からの経過時間（ミリ秒）。
 * 話題カード2回とゲーム提案を出し切るだけなら15分弱で到達してしまうため、
 * 「始まってまもない部屋で、ちょっと席を外しただけでお開きを提案する」のを防ぐ。
 */
export const END_POLL_MIN_AGE_MS = 45 * 60_000;
/** せりが「同じ川柳」と見なして黙る、直近の記憶件数 */
export const SENRYU_MEMORY = 5;
/**
 * 声で拾った句のあと、せりが次に声へ反応するまで空ける間隔（ミリ秒）。
 *
 * チャットのせりは無制限でよい。人が 5-7-5 を打ち込むのは意図的な行為で、
 * 数もたかが知れているためである。声はそうではない。呑み会の会話は
 * 止まらないので、文字起こしは1人あたり数秒に1件のペースで流れ込む。
 * 偶然の 5-7-5 を全部拾うと、せりが会話に割り込み続けることになる。
 */
export const SERI_VOICE_COOLDOWN_MS = 90_000;
/** チャットに引用する1句の最大文字数。ユーザー入力を流し戻すための保険（§3.8） */
export const QUOTE_LINE_MAX = 40;

// ---------------------------------------------------------------------------
// 発話
// ---------------------------------------------------------------------------

/**
 * 発話の種類・テロップ演出データの正本は types.ts（§4.3）。
 * S2C の ChatMessage にそのまま載るワイヤ型なので、型の正本側に置いてある。
 */
export type { BotCard, BotKind };

/** bot 1発話 */
export type BotUtterance = {
  /** どの bot が喋ったか */
  botId: BotId;
  /** 発話の種類 */
  kind: BotKind;
  /** チャットに流す本文 */
  text: string;
  /** テロップ演出用の付加情報 */
  card?: BotCard;
};

/**
 * 発話の優先度。同じ bot が持つ発話どうしの、枠の食い合いを調停する。
 *
 *   essential … 枠を確認せず必ず出す（アンケートの締め。開いたまま放置しない）
 *   normal    … 枠がある限り出す（沈黙話題・ゲーム提案）
 *   optional  … 枠に余裕があるときだけ出す（相槌）
 *
 * 相槌（reaction）だけを optional にしている。挨拶を optional にすると
 * 大人数が一度に入室したとき4人目以降が無視されるため normal に置く。
 *
 * ぐっちーとなべに役割を割ったので、この表が調停するのは
 * 「ぐっちーの挨拶・話題カード・相槌」のあいだだけになった。
 * なべ側は optional を持たないため、この表は実質ぐっちー用である。
 */
const PRIORITY: Readonly<Record<BotKind, "essential" | "normal" | "optional">> = {
  naming: "essential", // しゅんぴの発話。枠の対象外
  senryu: "essential", // せりの発話。枠の対象外
  greeting: "normal", // 入室者を無視するのは場回しとして最悪なので枠を使ってでも出す
  topic: "normal",
  gameSuggest: "normal", // ここから下の4種類はなべの発話
  endPoll: "normal",
  closing: "essential", // closePoll が枠を見ずに発話する（テーブルは参照されない）
  pollContinue: "essential", // 同上
  reaction: "optional", // ラウンド途中の相槌
  finalReaction: "normal", // 優勝の瞬間。ここで黙るのが一番おかしい
};

/** optional の発話に進むために残しておく枠。これを下回ると出さない */
const OPTIONAL_RESERVE = 2;

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

/** 終了アンケート1件 */
export type EndPoll = {
  /** 投票を紐づけるID */
  id: string;
  /** 開始時刻（epoch ms） */
  startedAt: number;
  /** playerId → 「やめる」に賛成か */
  votes: Record<string, boolean>;
  /**
   * 投票権のある参加者。過半数の母数はこれで固定する。
   *
   * ctx.connectedPlayerIds を母数にすると、未投票の人が一瞬切断しただけで
   * 分母が縮み「お開き」が成立してしまう（§8 は60秒猶予内の一時切断で
   * 進行を止めないと定めている）。退室が確定したときだけここから外す。
   */
  eligibleIds: string[];
};

/** bot 4体分の状態。ルームごとに1つ持つ */
export type BotState = {
  /** bot ごとの ON/OFF（既定は全 ON、§3.10） */
  enabled: Record<BotId, boolean>;
  /** ルームで bot が動きはじめた時刻。終了アンケートの下限判定に使う */
  startedAt: number;
  /**
   * 最後に「人間の」活動があった時刻。lastActivityAt は bot 自身の発話でも
   * 進むので、誰も反応していないことを判定するにはこちらを見る。
   */
  lastHumanAt: number;
  /** 最後にチャットかゲーム操作があった時刻（沈黙検知の起点） */
  lastActivityAt: number;
  /** ロビーに入った時刻。ゲーム中は null */
  lobbySince: number | null;
  /** せりの状態 */
  seri: {
    /** 直近に拾った川柳の読み（新しい順）。同じものを拾い直したら黙る */
    recentYomi: string[];
    /**
     * 最後に「声の句」を拾った時刻。SERI_VOICE_COOLDOWN_MS の起点。
     * チャットの句では進めない（打った句と喋った句で別枠に数える）。
     */
    lastVoiceAt: number | null;
  };
  /** ぐっちー（場を温める）の状態 */
  gucchi: {
    /** 直近の発話時刻。BOT_RATE_WINDOW_MS の窓で数える。なべとは別枠 */
    utteranceTimes: number[];
    /**
     * 話題カードを続けて投げた回数。
     *
     * ぐっちーの持ち物だが、なべの判定（isWarmupExhausted）もこれを**読む**
     * （書き換えるのはぐっちー側だけ）。「話題カードを出し切ってなお沈黙して
     * いる」という条件そのものなので、なべ側に複製すると意味が壊れるため。
     */
    silenceStreak: number;
    /** 使った話題カードID */
    usedTopicIds: string[];
  };
  /** なべ（進行を仕切る）の状態 */
  nabe: {
    /** 直近の発話時刻。BOT_RATE_WINDOW_MS の窓で数える。ぐっちーとは別枠 */
    utteranceTimes: number[];
    /** 提案済みのゲームID */
    suggestedGameIds: string[];
    /** 最後にゲームを提案した時刻。候補を戻す判定に使う */
    lastGameSuggestAt: number | null;
    /** 集計中の終了アンケート */
    poll: EndPoll | null;
    /** 終了アンケートを出した回数。END_POLL_MAX まで */
    pollsHeld: number;
    /** 最後に終了アンケートを出した時刻。クールダウンの起点 */
    lastPollAt: number | null;
  };
};

/** 初期状態を作る */
export function createBotState(now: number): BotState {
  return {
    enabled: { shunpi: true, seri: true, gucchi: true, nabe: true },
    startedAt: now,
    lastHumanAt: now,
    lastActivityAt: now,
    lobbySince: now,
    seri: { recentYomi: [], lastVoiceAt: null },
    gucchi: {
      utteranceTimes: [],
      silenceStreak: 0,
      usedTopicIds: [],
    },
    nabe: {
      utteranceTimes: [],
      suggestedGameIds: [],
      lastGameSuggestAt: null,
      poll: null,
      pollsHeld: 0,
      lastPollAt: null,
    },
  };
}

// ---------------------------------------------------------------------------
// 入出力
// ---------------------------------------------------------------------------

/**
 * 発言がどこから来たか。
 *
 *   chat  … テキストチャット（§3.9）。本人が打った文字なので額面どおり信じてよい
 *   voice … VC の文字起こし（§3.6 + docs/design/bot-voice.md）。各参加者の
 *           ブラウザが自分のマイクだけを認識した結果で、聞き違いが混ざる
 *
 * どちらも「人間の活動」なので沈黙タイマー（§3.10）は同じように進める。
 * 違いが出るのはせりの拾い方だけ（senryuUtterance を参照）。
 */
export type MessageSource = "chat" | "voice";

/** bot に伝えるルームの出来事 */
export type BotEvent =
  | {
    t: "playerJoined";
    playerId: string;
    nickname: string;
    assignedNickname?: string;
    /** assignedNickname を連想した趣味タグ（§3.11）。しゅんぴが由来を明かすのに使う */
    namingTagId?: HobbyTagId;
  }
  /** 60秒猶予内の再接続（§3.2）。挨拶はしない */
  | { t: "playerRejoined"; playerId: string; nickname: string }
  /** 一時的な切断。まだ退室していないので投票は保持する（§8） */
  | { t: "playerDisconnected"; playerId: string }
  /** 退室の確定（猶予切れ・自主退室・キック）。投票を無効にする */
  | { t: "playerLeft"; playerId: string }
  | { t: "message"; playerId: string; nickname: string; text: string; source: MessageSource }
  | { t: "gameAction" }
  | { t: "phaseChanged"; phase: Phase }
  | { t: "roundResult"; topNickname?: string }
  | { t: "finalResult"; topNickname?: string }
  | { t: "endPollVote"; pollId: string; playerId: string; agree: boolean }
  | { t: "setBot"; botId?: BotId; enabled: boolean }
  /** 定期呼び出し。rooms.ts から 60 秒ごとに送る前提で沈黙判定の粒度を決めている */
  | { t: "tick" };

/** reduce に渡す外部依存。テストでは固定値を渡す */
export type BotContext = {
  /** 現在時刻（epoch ms） */
  now: number;
  /** 接続中の参加者ID（bot は含まない）。投票の有効判定と過半数の母数に使う */
  connectedPlayerIds: readonly string[];
  /** 参加者に共通する趣味タグID（§3.11）。共通タグが無ければ空配列 */
  commonTags: readonly string[];
  /** 0 以上 1 未満の乱数 */
  rng: () => number;
  /**
   * 川柳判定。せりが使う。
   * 必須にしてあるのは、渡し忘れるとせりがエラーも出さず永久に無言になるため。
   * 判定を止めたいときは常に null を返す関数を渡す。
   */
  senryu: (text: string) => SenryuMatch | null;
  /** 提案できるゲーム */
  games: ReadonlyArray<{ id: string; title: string }>;
  /** 終了アンケートのIDを作る */
  newPollId: () => string;
};

/**
 * ルーム層が実行すべき副作用。engine.ts の EngineEffect と同じ役割。
 * 発話（BotUtterance）は表示用データなので、制御はこちらに分ける。
 */
export type BotEffect =
  /** 終了アンケートを開始した。deadline に締切タイマーを仕掛ける */
  | { t: "pollStarted"; pollId: string; deadline: number }
  /** 終了アンケートが締まった。agreed が true ならお開きの合意が取れている */
  | { t: "pollClosed"; pollId: string; agreed: boolean };

/** reduce の結果。engine.ts の EngineResult と形をそろえる */
export type BotResult = {
  /** 更新後の状態 */
  state: BotState;
  /** この出来事で発生した発話（順に配信する） */
  utterances: BotUtterance[];
  /** ルーム層が実行すべき副作用。無ければ空配列 */
  effects: BotEffect[];
  /** 受理できなかった場合のエラーコード（不正な投票など） */
  error?: ErrorCode;
  /** エラーの説明 */
  message?: string;
};

// ---------------------------------------------------------------------------
// 発話枠（ぐっちー / なべ。bot ごとに独立して数える）
// ---------------------------------------------------------------------------

/**
 * 発話枠を持つ bot。
 * しゅんぴ（命名）とせり（川柳）は人の行動に1対1で応じるだけで自発的に
 * 喋らないので、枠を持たない（§3.10 の頻度上限は自発的な発話への制限）。
 */
type RateLimitedBotId = "gucchi" | "nabe";

/** bot ごとの、窓のなかで許す発話数 */
const RATE_MAX: Readonly<Record<RateLimitedBotId, number>> = {
  gucchi: GUCCHI_RATE_MAX,
  nabe: NABE_RATE_MAX,
};

/** 窓から外れた発話時刻を捨てる */
function recentTimes(times: readonly number[], now: number): number[] {
  return times.filter((at) => now - at < BOT_RATE_WINDOW_MS);
}

/**
 * その bot がこの種類の発話をしてよいか（§3.10 の頻度上限）。
 * 枠は bot ごとに独立しているので、ぐっちーが使い切ってもなべは喋れる。
 */
function canSpeak(
  state: BotState,
  botId: RateLimitedBotId,
  kind: BotKind,
  now: number,
): boolean {
  const used = recentTimes(state[botId].utteranceTimes, now).length;
  const remaining = RATE_MAX[botId] - used;
  if (remaining <= 0) return false;
  return PRIORITY[kind] !== "optional" || remaining > OPTIONAL_RESERVE;
}

/**
 * 発話を1件記録した utteranceTimes を返す。
 * bot の状態ごと差し替えないのは、gucchi と nabe で中身が違うため
 * （呼び出し側で `{ ...state.nabe, utteranceTimes: spend(...) }` と綴る）。
 */
function spend(times: readonly number[], now: number): number[] {
  return [...recentTimes(times, now), now];
}

// ---------------------------------------------------------------------------
// しゅんぴ（あだ名bot）
// ---------------------------------------------------------------------------

/** あだ名を組み立てる材料。しゅんぴは rooms.ts から直接この関数を呼ぶ */
export type NicknameRequest = {
  /** 入室者本人の趣味タグ（§3.11）。未選択なら空配列 */
  tags: readonly HobbyTagId[];
  /** すでにこの卓で使われているあだ名 */
  taken: ReadonlySet<string>;
  /**
   * 卓の他の人が持っているタグ（重複可）。
   * 「ゲーム好きが3人いる卓で3人ともゲーム由来の名前になる」のを避けるために見る
   */
  othersTags: readonly HobbyTagId[];
};

/** 割り当てたあだ名と、連想元にしたタグ（汎用プールから引いたときは undefined） */
export type NicknameChoice = { name: string; tagId?: HobbyTagId };

/**
 * 連想元にするタグを1つ選ぶ。卓の他の人と被っていないタグを優先する。
 * タグを1つも持たない人には連想元が無いので null を返す。
 */
function chooseNicknameTag(req: NicknameRequest, rng: () => number): HobbyTagId | null {
  if (req.tags.length === 0) return null;
  const unique = req.tags.filter((tag) => !req.othersTags.includes(tag));
  return pick(unique.length > 0 ? unique : req.tags, rng);
}

/** 形容 × 名詞の総当たりのうち、NICKNAME_MAX に収まるものを返す */
function combine(adjectives: readonly string[], nouns: readonly string[]): string[] {
  const names: string[] = [];
  for (const adjective of adjectives) {
    for (const noun of nouns) {
      const name = `${adjective}${noun}`;
      if (name.length <= NICKNAME_MAX) names.push(name);
    }
  }
  return names;
}

/**
 * あだ名未入力の参加者に付ける二つ名を選ぶ（§3.0 のあだ名は上書きしない運用）。
 * すでにルームで使われている名前は避け、20文字（NICKNAME_MAX）に収める。
 *
 * 本人の趣味タグ（§3.11）があれば、そこから連想した語で組み立てる。あだ名を
 * 名札兼・話題のフックにするのが狙い（§3.11 用途1「初対面の話題のきっかけ」）。
 * 例: reading →「よふかしフクロウ」、alcohol + camping →「ほろよいとっくり」。
 *
 * 候補は上から順に濃い連想の段を試し、名前が空いている最初の段で決める。
 * 下の段ほど組み合わせ数が増えるので、同じタグの人が続いても枯れない。
 */
export function pickNickname(req: NicknameRequest, rng: () => number): NicknameChoice {
  const free = (names: readonly string[]): string[] => names.filter((n) => !req.taken.has(n));
  const tagId = chooseNicknameTag(req, rng);
  if (tagId !== null) {
    const words = TAG_NICKNAME_WORDS[tagId];
    // 本人が持つ「連想元以外」のタグ。1段目が埋まったときに形容だけを借りる
    const others = req.tags.filter((tag) => tag !== tagId).map((tag) => TAG_NICKNAME_WORDS[tag]);
    const ladder: string[][] = [
      // 1段目: 連想元タグだけで組む（いちばん由来が分かりやすい）
      free(combine(words.adjectives, words.nouns)),
      // 2段目: 本人の他タグの形容 × 連想元タグの名詞（タグ2個以上のときだけ中身が入る）
      free(combine(others.flatMap((w) => w.adjectives), words.nouns)),
      // 3段目: 片側だけ汎用プールに落とす。まだタグの語が残るので由来は伝わる
      [
        ...free(combine(NICKNAME_ADJECTIVES, words.nouns)),
        ...free(combine(words.adjectives, NICKNAME_NOUNS)),
      ],
    ];
    for (const step of ladder) {
      if (step.length > 0) return { name: pick(step, rng), tagId };
    }
  }
  // 4段目: タグを選ばなかった人と、タグ由来が全部埋まったとき
  const candidates = combine(NICKNAME_ADJECTIVES, NICKNAME_NOUNS);
  const generic = free(candidates);
  if (generic.length > 0) return { name: pick(generic, rng) };
  // 5段目: 全部埋まったときの保険。番号を足して一意にする
  for (let suffix = 2; suffix < 1000; suffix++) {
    for (const base of candidates) {
      const name = `${base}${suffix}`;
      if (name.length <= NICKNAME_MAX && !req.taken.has(name)) return { name };
    }
  }
  return { name: "名無し" };
}

// ---------------------------------------------------------------------------
// せり（川柳bot）
// ---------------------------------------------------------------------------

/** 字余り・字足らずの呼び名を決める。句ごとの過不足で判定する */
function shapeLabel(morae: readonly [number, number, number]): string {
  const over = morae.some((mora, index) => mora > SENRYU_PATTERN[index]);
  const under = morae.some((mora, index) => mora < SENRYU_PATTERN[index]);
  if (over && under) return "字余り字足らず";
  if (over) return "字余り";
  if (under) return "字足らず";
  return "五七五";
}

/**
 * チャットに流し戻すユーザー入力を安全な長さに切り詰める（§3.8）。
 * rooms.ts の validateNickname と同じくコードポイント単位で数える。
 * String.length（UTF-16 単位）で切ると絵文字が割れて孤立サロゲートが残る。
 */
function clamp(text: string, max: number): string {
  const chars = [...text];
  // 省略記号ぶんを含めて max に収める
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * 川柳を拾ったときの発話を作る。拾わないときは null。
 *
 * 声（source: "voice"）はチャットより厳しく絞る。理由は2つある:
 *
 *   1. 文字起こしは聞き違いを含む。読点も改行もない喋り言葉が長い1本の
 *      文字列で届くので、字余り・字足らずまで許すと「たまたま 4-8-6 に
 *      割れただけの雑談」を毎回拾ってしまう。声はぴったり 5-7-5 だけにする。
 *   2. 会話は止まらない。1件ずつは正しくても、拾うたびに割り込まれると
 *      場が壊れる。SERI_VOICE_COOLDOWN_MS のあいだは声の句を見送る。
 *
 * クールダウンは川柳判定より先に見る。判定（形態素解析）が解析コストの大半で、
 * 文字起こしは1人あたり数秒に1件のペースで流れ込むためである。
 */
function senryuUtterance(
  state: BotState,
  event: Extract<BotEvent, { t: "message" }>,
  ctx: BotContext,
): { utterance: BotUtterance; yomi: string; voice: boolean } | null {
  if (!state.enabled.seri) return null;
  const voice = event.source === "voice";
  if (
    voice && state.seri.lastVoiceAt !== null &&
    ctx.now - state.seri.lastVoiceAt < SERI_VOICE_COOLDOWN_MS
  ) {
    return null;
  }
  const match = ctx.senryu(event.text);
  if (match === null) return null;
  // 声の字余り・字足らずは聞き違いと区別できないので拾わない
  if (voice && !match.exactPattern) return null;
  const yomi = match.yomi.join("");
  // 直近に拾ったものと同じ川柳なら黙る（コピペ連投の洪水だけ防ぐ。回数制限はしない）
  if (state.seri.recentYomi.includes(yomi)) return null;
  let text: string;
  if (voice) {
    text = pick(SENRYU_VOICE_TEXTS, ctx.rng);
  } else if (match.exactPattern) {
    text = pick(SENRYU_EXACT_TEXTS, ctx.rng);
  } else {
    text = fill(pick(SENRYU_LOOSE_TEXTS, ctx.rng), { shape: shapeLabel(match.morae) });
  }
  return {
    yomi,
    voice,
    utterance: {
      botId: "seri",
      kind: "senryu",
      text,
      card: {
        c: "senryu",
        lines: [
          clamp(match.lines[0], QUOTE_LINE_MAX),
          clamp(match.lines[1], QUOTE_LINE_MAX),
          clamp(match.lines[2], QUOTE_LINE_MAX),
        ],
        morae: match.morae,
        exact: match.exactPattern,
        author: clamp(event.nickname, NICKNAME_MAX),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// ぐっちー（場を温めるbot）: 挨拶・話題カード・相槌
// ---------------------------------------------------------------------------

/** まだ使っていない話題カードを選ぶ。共通タグに対応するカードを優先する */
function chooseTopic(state: BotState, ctx: BotContext): TopicCard | null {
  const unused = TOPIC_CARDS.filter((card) => !state.gucchi.usedTopicIds.includes(card.id));
  const pool = unused.length > 0 ? unused : TOPIC_CARDS;
  const tagged = pool.filter((card) => card.tags.some((tag) => ctx.commonTags.includes(tag)));
  return pick(tagged.length > 0 ? tagged : pool, ctx.rng);
}

// ---------------------------------------------------------------------------
// なべ（進行bot）: ゲーム提案・終了アンケート・締め
// ---------------------------------------------------------------------------

/**
 * まだ提案していないゲームを選ぶ。
 * 全部出し切っていても、前回の提案から十分に間が空いていれば誘い直す
 * （3本しかないので、序盤で撃ち尽くすと以後永久に提案できなくなる）。
 */
function chooseGame(state: BotState, ctx: BotContext): { id: string; title: string } | null {
  const { suggestedGameIds, lastGameSuggestAt } = state.nabe;
  const unused = ctx.games.filter((game) => !suggestedGameIds.includes(game.id));
  if (unused.length > 0) return pick(unused, ctx.rng);
  if (lastGameSuggestAt === null || ctx.now - lastGameSuggestAt < GAME_SUGGEST_RESET_MS) {
    return null;
  }
  // 前回の提案以降、誰も反応していない部屋では誘い直さない。
  // 反応のない場で提案を繰り返すのは §3.10 の「無人の場で喋り続けない」に反する
  if (state.lastHumanAt <= lastGameSuggestAt) return null;
  // 一巡したので候補を戻す。直前に提案した1本だけは続けて出さない
  const revived = ctx.games.filter((game) => game.id !== suggestedGameIds.at(-1));
  return revived.length === 0 ? null : pick(revived, ctx.rng);
}

/** 投票権のある参加者が投じた票だけを数える。幽霊IDの票は無視する */
function countVotes(poll: EndPoll): { agreed: number; voted: number } {
  let agreed = 0;
  let voted = 0;
  for (const playerId of poll.eligibleIds) {
    const vote = poll.votes[playerId];
    if (vote === undefined) continue;
    voted++;
    if (vote) agreed++;
  }
  return { agreed, voted };
}

/** 投票がそろった、または賛成が過半数に達して結果が決まったか */
function isPollDecided(poll: EndPoll): boolean {
  const total = poll.eligibleIds.length;
  if (total === 0) return true;
  const { agreed, voted } = countVotes(poll);
  return voted >= total || agreed * 2 > total;
}

/**
 * 「場を温める手」が尽きているか。なべが動き出してよい前提条件。
 *
 * ふだんはぐっちーの silenceStreak を読む（書き換えはぐっちー側だけが行う）。
 * 「話題カードを出し切ってなお沈黙している」という条件そのものなので、
 * なべ側に別カウンタを持たせると意味が変わるためである。
 *
 * ぐっちーが OFF のときは最初から尽きている扱いにする。話題カード自体が
 * 出ないので silenceStreak が 0 のまま増えず、これがないと
 * 「ぐっちーを切るとなべまで動けない」＝2体を分けた意味がなくなる。
 *
 * ゲーム提案（stuck）と終了アンケート（canStartPoll）の両方がこれを使う。
 * 片方だけ条件を変えると「誘いは来るのにお開きは訊かれない」とちぐはぐになる。
 */
function isWarmupExhausted(state: BotState): boolean {
  return !state.enabled.gucchi || state.gucchi.silenceStreak >= SILENCE_MAX_STREAK;
}

/**
 * 終了アンケートを出せる状況か。
 * 1ルームで END_POLL_MAX 回まで、かつ前回から END_POLL_COOLDOWN_MS 空ける。
 * 訊き続けると誰も反応しない部屋で永久ループになるうえ、単純にしつこい。
 * 「お開き」で締めた場合は closePoll が回数を上限まで進めて打ち止めにする。
 */
function canStartPoll(state: BotState, now: number): boolean {
  if (state.nabe.poll !== null) return false;
  if (!isWarmupExhausted(state)) return false;
  if (state.nabe.pollsHeld >= END_POLL_MAX) return false;
  if (now - state.startedAt < END_POLL_MIN_AGE_MS) return false;
  const last = state.nabe.lastPollAt;
  return last === null || now - last >= END_POLL_COOLDOWN_MS;
}

/**
 * 終了アンケートを締める。過半数が賛成なら締めの一言、届かなければ続行の一言。
 *
 * ここだけは発話枠（NABE_RATE_MAX）を確認せずに必ず発話する。開いたアンケートを
 * 結果不明のまま放置するほうが害が大きいため。枠は1つ超過しうる。
 */
function closePoll(state: BotState, ctx: BotContext): BotResult {
  const poll = state.nabe.poll;
  if (poll === null) return { state, utterances: [], effects: [] };
  // 誰もいない部屋、または OFF のあいだは黙って閉じる（§3.10「無人の場で喋り続けない」）。
  // 発話しなくてもアンケート自体は必ず片付ける。開いたまま放置すると
  // クライアントが締切のないアンケートを表示し続けてしまう
  const total = poll.eligibleIds.length;
  const { agreed } = countVotes(poll);
  const majority = total > 0 && agreed * 2 > total;
  // 見るのは enabled.nabe。締めの一言はなべの発話なので、ぐっちーの ON/OFF とは無関係
  if (!state.enabled.nabe || total === 0 || ctx.connectedPlayerIds.length === 0) {
    // 発話は控えるが、集計結果は捨てない。参加者が過半数でお開きに賛成したのに
    // ルーム層へ「合意なし」と伝えてしまうと部屋が閉じられなくなる
    return {
      state: { ...state, nabe: { ...state.nabe, poll: null } },
      utterances: [],
      effects: [{ t: "pollClosed", pollId: poll.id, agreed: majority }],
    };
  }
  const kind: BotKind = majority ? "closing" : "pollContinue";
  const text = majority ? pick(CLOSING_TEXTS, ctx.rng) : pick(CONTINUE_TEXTS, ctx.rng);
  // ぐっちーの silenceStreak は戻さない。戻すと話題カードの「連続2回まで」が復活し、
  // 誰も反応しない場で永久に喋り続けてしまう（§3.10）。
  // 「お開き」で締めたあとは訊き直す意味がないので打ち止めにする
  const nabe = {
    ...state.nabe,
    utteranceTimes: spend(state.nabe.utteranceTimes, ctx.now),
    poll: null,
    pollsHeld: majority ? END_POLL_MAX : state.nabe.pollsHeld,
  };
  return {
    state: { ...state, nabe, lastActivityAt: ctx.now },
    utterances: [{ botId: "nabe", kind, text }],
    effects: [{ t: "pollClosed", pollId: poll.id, agreed: majority }],
  };
}

/**
 * 沈黙・経過時間で発火する発話を決める（ぐっちーとなべの両方）。
 * 優先順は「集計中アンケートの締め > 話題カード > ゲーム提案 > 終了アンケート」。
 * 終了を切り出すのは、話題もゲーム提案も出しきってなお沈黙しているときだけ。
 *
 * ON/OFF は bot ごとに見る。ぐっちーを切っても、なべはゲームに誘えるし
 * お開きも切り出せる（その逆も同じ）。
 */
function tickBots(state: BotState, ctx: BotContext): BotResult {
  // 集計中のアンケートは、なべが OFF でも締切が来たら必ず片付ける
  const poll = state.nabe.poll;
  if (poll !== null) {
    return ctx.now - poll.startedAt >= END_POLL_MS
      ? closePoll(state, ctx)
      : { state, utterances: [], effects: [] };
  }
  // 全員が切断しているルームでは何も喋らない（§3.10「無人の場で喋り続けない」）
  if (ctx.connectedPlayerIds.length === 0) return { state, utterances: [], effects: [] };
  const silent = ctx.now - state.lastActivityAt >= SILENCE_MS;

  // --- ぐっちー ---
  // 話題カード: 沈黙 3 分ごと、連続 2 回まで（§3.10）
  if (state.enabled.gucchi && silent && state.gucchi.silenceStreak < SILENCE_MAX_STREAK) {
    const card = chooseTopic(state, ctx);
    if (card !== null && canSpeak(state, "gucchi", "topic", ctx.now)) {
      // 全カードを使い切ったら履歴を捨てて数え直す（無制限に伸ばさない）
      const used = state.gucchi.usedTopicIds.length + 1 >= TOPIC_CARDS.length
        ? [card.id]
        : [...state.gucchi.usedTopicIds, card.id];
      const gucchi = {
        ...state.gucchi,
        utteranceTimes: spend(state.gucchi.utteranceTimes, ctx.now),
        silenceStreak: state.gucchi.silenceStreak + 1,
        usedTopicIds: used,
      };
      return {
        // lastActivityAt を進めて、次の沈黙判定までまた SILENCE_MS 待つ
        state: { ...state, gucchi, lastActivityAt: ctx.now },
        utterances: [{ botId: "gucchi", kind: "topic", text: card.text }],
        effects: [],
      };
    }
  }

  // --- なべ ---
  if (!state.enabled.nabe) return { state, utterances: [], effects: [] };

  // ゲーム提案: ロビーで 5 分経過（§3.10）、または話題カードが打ち止めのとき。
  // 終了を切り出す前に、まず場を立て直す手を出す。
  // ロビー起点の提案は「会話が一段落したところ」を狙う。盛り上がっている最中に
  // 5分ごとに割り込むとうるさいので、直近 LOBBY_QUIET_MS は発言がないことを条件にする
  const lobbyStale = state.lobbySince !== null &&
    ctx.now - state.lobbySince >= LOBBY_SUGGEST_MS &&
    ctx.now - state.lastActivityAt >= LOBBY_QUIET_MS;
  // 場を温める手が尽きてなお沈黙しているか（ぐっちー OFF なら最初から尽きている）
  const stuck = silent && isWarmupExhausted(state);
  const game = lobbyStale || stuck ? chooseGame(state, ctx) : null;
  if (game !== null && canSpeak(state, "nabe", "gameSuggest", ctx.now)) {
    // 一巡して候補が戻ったときは、履歴を畳んでから積み直す
    const cycled = ctx.games.every((g) => state.nabe.suggestedGameIds.includes(g.id));
    const nabe = {
      ...state.nabe,
      utteranceTimes: spend(state.nabe.utteranceTimes, ctx.now),
      suggestedGameIds: cycled ? [game.id] : [...state.nabe.suggestedGameIds, game.id],
      lastGameSuggestAt: ctx.now,
    };
    return {
      state: {
        ...state,
        nabe,
        // ゲーム中（lobbySince === null）にロビータイマーを復活させない
        lobbySince: state.lobbySince === null ? null : ctx.now,
        lastActivityAt: ctx.now,
      },
      utterances: [{
        botId: "nabe",
        kind: "gameSuggest",
        text: fill(pick(GAME_SUGGEST_TEXTS, ctx.rng), { title: game.title }),
        card: { c: "gameSuggest", gameId: game.id, gameTitle: game.title },
      }],
      effects: [],
    };
  }

  // 終了アンケート: 話題カードもゲーム提案も打ち止めで、まだ沈黙しているとき
  if (stuck && canStartPoll(state, ctx.now) && canSpeak(state, "nabe", "endPoll", ctx.now)) {
    const id = ctx.newPollId();
    const nabe = {
      ...state.nabe,
      utteranceTimes: spend(state.nabe.utteranceTimes, ctx.now),
      poll: { id, startedAt: ctx.now, votes: {}, eligibleIds: [...ctx.connectedPlayerIds] },
      pollsHeld: state.nabe.pollsHeld + 1,
      lastPollAt: ctx.now,
    };
    return {
      state: { ...state, nabe },
      utterances: [{
        botId: "nabe",
        kind: "endPoll",
        text: pick(END_POLL_TEXTS, ctx.rng),
        card: { c: "endPoll", pollId: id, deadline: ctx.now + END_POLL_MS },
      }],
      effects: [{ t: "pollStarted", pollId: id, deadline: ctx.now + END_POLL_MS }],
    };
  }

  return { state, utterances: [], effects: [] };
}

// ---------------------------------------------------------------------------
// reduce
// ---------------------------------------------------------------------------

/**
 * ルームの出来事を1件受け取り、状態と発話を返す。純粋関数。
 * rooms.ts は engine.ts の reduce も import するので、
 * 配線側では `botReduce` の別名を使うこと。
 */
export function reduce(state: BotState, event: BotEvent, ctx: BotContext): BotResult {
  switch (event.t) {
    case "setBot": {
      const enabled = { ...state.enabled };
      for (const id of event.botId === undefined ? BOT_IDS : [event.botId]) {
        enabled[id] = event.enabled;
      }
      return { state: { ...state, enabled }, utterances: [], effects: [] };
    }

    case "playerJoined": {
      const utterances: BotUtterance[] = [];
      if (state.enabled.shunpi && event.assignedNickname !== undefined) {
        // タグから連想して名付けたときは由来も明かす。「よふかしフクロウ」だけでは
        // 偶然に見えるが、「読書から連想して」と添えると話しかけるとっかかりになる
        const tagId = event.namingTagId;
        utterances.push({
          botId: "shunpi",
          kind: "naming",
          text: tagId === undefined
            ? fill(pick(NAMING_TEXTS, ctx.rng), { name: event.assignedNickname })
            : fill(pick(TAGGED_NAMING_TEXTS, ctx.rng), {
              name: event.assignedNickname,
              tag: hobbyTagLabel(tagId),
            }),
        });
      }
      let next = state;
      if (state.enabled.gucchi && canSpeak(state, "gucchi", "greeting", ctx.now)) {
        utterances.push({
          botId: "gucchi",
          kind: "greeting",
          text: fill(pick(GREETING_TEXTS, ctx.rng), {
            name: event.assignedNickname ?? event.nickname,
          }),
        });
        next = {
          ...next,
          gucchi: {
            ...next.gucchi,
            utteranceTimes: spend(next.gucchi.utteranceTimes, ctx.now),
          },
        };
      }
      return {
        state: {
          ...next,
          lastActivityAt: ctx.now,
          lastHumanAt: ctx.now,
          gucchi: { ...next.gucchi, silenceStreak: 0 },
        },
        utterances,
        effects: [],
      };
    }

    case "playerRejoined": {
      // 再接続では挨拶しない。回線が不安定な人が戻るたびに「いらっしゃい」が
      // 出るのを避ける（rooms.ts は再接続時も S2C playerJoined を配信するため、
      // 呼び分けは rooms.ts 側の責務）。
      //
      // silenceStreak も戻さない。再接続は人間の発言ではないので、これを活動と
      // 数えると「話題カードは連続2回まで」が何度でもリセットされ、
      // 誰も喋っていない部屋でぐっちーが延々と話題を投げ続ける。
      return { state, utterances: [], effects: [] };
    }

    case "playerDisconnected": {
      // 一時切断では票を触らない。60秒の猶予内に戻ってくるかもしれないので、
      // 未投票者が消えたことで過半数が成立してしまう事故を防ぐ（§8）
      return { state, utterances: [], effects: [] };
    }

    case "playerLeft": {
      if (state.nabe.poll === null) return { state, utterances: [], effects: [] };
      // 退室が確定した人の票は無効にする（§8 の「当人への票は無効化」と同じ考え方）
      const votes = { ...state.nabe.poll.votes };
      delete votes[event.playerId];
      const poll: EndPoll = {
        ...state.nabe.poll,
        votes,
        eligibleIds: state.nabe.poll.eligibleIds.filter((id) => id !== event.playerId),
      };
      const next: BotState = { ...state, nabe: { ...state.nabe, poll } };
      // 人数が減った結果、残りの票だけで結論が出ることがある。締切を待たずに締める
      return isPollDecided(poll)
        ? closePoll(next, ctx)
        : { state: next, utterances: [], effects: [] };
    }

    case "message": {
      const senryu = senryuUtterance(state, event, ctx);
      const recentYomi = senryu === null
        ? state.seri.recentYomi
        : [senryu.yomi, ...state.seri.recentYomi].slice(0, SENRYU_MEMORY);
      // 声のクールダウンは「声で拾えたとき」だけ進める。チャットの句や
      // 見送った声で進めると、実際には黙っているのに次の句まで待たせてしまう
      const lastVoiceAt = senryu !== null && senryu.voice ? ctx.now : state.seri.lastVoiceAt;
      const next: BotState = {
        ...state,
        // 文字起こしの発言も人間の活動として数える。ここが voice 対応の要で、
        // これがないと「全員が声で盛り上がっている部屋」をぐっちーが沈黙と
        // 誤判定し、話題カード→ゲーム提案→お開きの打診まで進んでしまう（§3.10）
        lastActivityAt: ctx.now,
        lastHumanAt: ctx.now,
        seri: { recentYomi, lastVoiceAt },
        gucchi: { ...state.gucchi, silenceStreak: 0 },
      };
      // せりは発話枠を消費しない（回数無制限）
      return { state: next, utterances: senryu === null ? [] : [senryu.utterance], effects: [] };
    }

    case "gameAction": {
      return {
        state: {
          ...state,
          lastActivityAt: ctx.now,
          lastHumanAt: ctx.now,
          gucchi: { ...state.gucchi, silenceStreak: 0 },
        },
        utterances: [],
        effects: [],
      };
    }

    case "phaseChanged": {
      const backToLobby = event.phase === "lobby";
      return {
        state: {
          ...state,
          lobbySince: backToLobby ? ctx.now : null,
          lastActivityAt: ctx.now,
          gucchi: { ...state.gucchi, silenceStreak: 0 },
          nabe: {
            ...state.nabe,
            // 1本遊び終えたら提案の弾を補充する。そうしないと収録ゲームの
            // 本数ぶんで打ち止めになり、終盤に立て直す手がなくなる。
            // ただし直前に提案したものは残し、遊んだ直後の再提案を避ける
            suggestedGameIds: backToLobby
              ? state.nabe.suggestedGameIds.slice(-1)
              : state.nabe.suggestedGameIds,
          },
        },
        utterances: [],
        effects: [],
      };
    }

    case "roundResult":
    case "finalResult": {
      const base: BotState = {
        ...state,
        lastActivityAt: ctx.now,
        gucchi: { ...state.gucchi, silenceStreak: 0 },
      };
      const kind: BotKind = event.t === "roundResult" ? "reaction" : "finalReaction";
      if (!state.enabled.gucchi || !canSpeak(state, "gucchi", kind, ctx.now)) {
        return { state: base, utterances: [], effects: [] };
      }
      const texts = event.t === "roundResult" ? ROUND_REACTION_TEXTS : FINAL_REACTION_TEXTS;
      return {
        state: {
          ...base,
          gucchi: {
            ...base.gucchi,
            utteranceTimes: spend(base.gucchi.utteranceTimes, ctx.now),
          },
        },
        effects: [],
        utterances: [{
          botId: "gucchi",
          kind,
          text: fill(pick(texts, ctx.rng), { name: event.topNickname ?? "みなさん" }),
        }],
      };
    }

    case "endPollVote": {
      const poll = state.nabe.poll;
      if (poll === null) {
        return {
          state,
          utterances: [],
          effects: [],
          error: "PHASE_MISMATCH",
          message: "集計中のアンケートがありません",
        };
      }
      // 締め切り後に届いた遅延投票が次のアンケートに混ざらないよう ID を照合する
      if (poll.id !== event.pollId) {
        return {
          state,
          utterances: [],
          effects: [],
          error: "PHASE_MISMATCH",
          message: "このアンケートはすでに締め切られています",
        };
      }
      // 投票権のない相手（未参加・退室済み）からの票は受け付けない
      if (!poll.eligibleIds.includes(event.playerId)) {
        return {
          state,
          utterances: [],
          effects: [],
          error: "INVALID_INPUT",
          message: "このアンケートに投票できません",
        };
      }
      const voted: EndPoll = { ...poll, votes: { ...poll.votes, [event.playerId]: event.agree } };
      // 投票も明確な活動なので沈黙タイマーを進めない
      const next: BotState = {
        ...state,
        lastActivityAt: ctx.now,
        lastHumanAt: ctx.now,
        nabe: { ...state.nabe, poll: voted },
      };
      // 全員が投票し終えたとき、または賛成が過半数に達して結果が決まったときは
      // 締め切りを待たずに締める
      return isPollDecided(voted)
        ? closePoll(next, ctx)
        : { state: next, utterances: [], effects: [] };
    }

    case "tick":
      return tickBots(state, ctx);
  }
}

/** engine.ts の reduce と名前が衝突しないための別名 */
export { reduce as botReduce };
