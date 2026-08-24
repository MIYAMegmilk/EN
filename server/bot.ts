/**
 * bot の判断ロジック（しゅんぴ / せり / ぐっちー）
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
 *   - 「bot はルームに1体まで」→ 役割の違う3体にする
 *   - 「10分あたり最大5発話」→ ぐっちーにのみ適用。せり（川柳）は無制限
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
  TOPIC_CARDS,
  type TopicCard,
} from "./bot_templates.ts";
import { SENRYU_PATTERN, type SenryuMatch } from "./senryu.ts";
import type { BotCard, BotKind, ErrorCode, Phase } from "./types.ts";
import { NICKNAME_MAX } from "./types.ts";

export { BOT_IDS, type BotId, BOTS } from "./bot_templates.ts";

// ---------------------------------------------------------------------------
// 定数（§3.10）
// ---------------------------------------------------------------------------

/** ぐっちーの発話頻度を見る窓（ミリ秒） */
export const GUCCHI_RATE_WINDOW_MS = 10 * 60_000;
/** 窓のなかで許すぐっちーの発話数 */
export const GUCCHI_RATE_MAX = 5;
/** 沈黙とみなすまでの無操作時間（ミリ秒） */
export const SILENCE_MS = 3 * 60_000;
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
 * 発話の優先度。ぐっちーの発話枠（10分5発話）の食い合いを調停する。
 *
 *   essential … 枠を確認せず必ず出す（アンケートの締め。開いたまま放置しない）
 *   normal    … 枠がある限り出す（沈黙話題・ゲーム提案）
 *   optional  … 枠に余裕があるときだけ出す（挨拶・相槌）
 *
 * 相槌（reaction）だけを optional にしている。挨拶を optional にすると
 * 大人数が一度に入室したとき4人目以降が無視されるため normal に置く。
 */
const PRIORITY: Readonly<Record<BotKind, "essential" | "normal" | "optional">> = {
  naming: "essential", // しゅんぴの発話。枠の対象外
  senryu: "essential", // せりの発話。枠の対象外
  greeting: "normal", // 入室者を無視するのは場回しとして最悪なので枠を使ってでも出す
  topic: "normal",
  gameSuggest: "normal",
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

/** bot 3体分の状態。ルームごとに1つ持つ */
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
  };
  /** ぐっちーの状態 */
  gucchi: {
    /** 直近の発話時刻。GUCCHI_RATE_WINDOW_MS の窓で数える */
    utteranceTimes: number[];
    /** 話題カードを続けて投げた回数 */
    silenceStreak: number;
    /** 提案済みのゲームID */
    suggestedGameIds: string[];
    /** 最後にゲームを提案した時刻。候補を戻す判定に使う */
    lastGameSuggestAt: number | null;
    /** 使った話題カードID */
    usedTopicIds: string[];
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
    enabled: { shunpi: true, seri: true, gucchi: true },
    startedAt: now,
    lastHumanAt: now,
    lastActivityAt: now,
    lobbySince: now,
    seri: { recentYomi: [] },
    gucchi: {
      utteranceTimes: [],
      silenceStreak: 0,
      suggestedGameIds: [],
      lastGameSuggestAt: null,
      usedTopicIds: [],
      poll: null,
      pollsHeld: 0,
      lastPollAt: null,
    },
  };
}

// ---------------------------------------------------------------------------
// 入出力
// ---------------------------------------------------------------------------

/** 発言がどこから来たか。voice は VC の文字起こし（v1 は未使用、差し込み口のみ） */
export type MessageSource = "chat" | "voice";

/** bot に伝えるルームの出来事 */
export type BotEvent =
  | { t: "playerJoined"; playerId: string; nickname: string; assignedNickname?: string }
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
  /** 参加者に共通する趣味タグID（§3.11）。未実装のうちは空配列 */
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
// 発話枠（ぐっちーのみ）
// ---------------------------------------------------------------------------

/** 窓から外れた発話時刻を捨てる */
function recentTimes(times: readonly number[], now: number): number[] {
  return times.filter((at) => now - at < GUCCHI_RATE_WINDOW_MS);
}

/** ぐっちーがこの種類の発話をしてよいか（§3.10 の 10分5発話） */
function canGucchiSpeak(state: BotState, kind: BotKind, now: number): boolean {
  const used = recentTimes(state.gucchi.utteranceTimes, now).length;
  const remaining = GUCCHI_RATE_MAX - used;
  if (remaining <= 0) return false;
  return PRIORITY[kind] !== "optional" || remaining > OPTIONAL_RESERVE;
}

/** ぐっちーの発話を1件記録する */
function spend(state: BotState, now: number): BotState["gucchi"] {
  return {
    ...state.gucchi,
    utteranceTimes: [...recentTimes(state.gucchi.utteranceTimes, now), now],
  };
}

// ---------------------------------------------------------------------------
// しゅんぴ（あだ名bot）
// ---------------------------------------------------------------------------

/**
 * あだ名未入力の参加者に付ける二つ名を選ぶ（§3.0 のあだ名は上書きしない運用）。
 * すでにルームで使われている名前は避け、20文字（NICKNAME_MAX）に収める。
 */
export function pickNickname(taken: ReadonlySet<string>, rng: () => number): string {
  const candidates: string[] = [];
  for (const adjective of NICKNAME_ADJECTIVES) {
    for (const noun of NICKNAME_NOUNS) {
      const name = `${adjective}${noun}`;
      if (name.length <= NICKNAME_MAX) candidates.push(name);
    }
  }
  const free = candidates.filter((name) => !taken.has(name));
  if (free.length > 0) return pick(free, rng);
  // 全部埋まったときの保険。番号を足して一意にする
  for (let suffix = 2; suffix < 1000; suffix++) {
    for (const base of candidates) {
      const name = `${base}${suffix}`;
      if (name.length <= NICKNAME_MAX && !taken.has(name)) return name;
    }
  }
  return "名無し";
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

/** 川柳を拾ったときの発話を作る。拾わないときは null */
function senryuUtterance(
  state: BotState,
  event: Extract<BotEvent, { t: "message" }>,
  ctx: BotContext,
): { utterance: BotUtterance; yomi: string } | null {
  if (!state.enabled.seri) return null;
  const match = ctx.senryu(event.text);
  if (match === null) return null;
  const yomi = match.yomi.join("");
  // 直近に拾ったものと同じ川柳なら黙る（コピペ連投の洪水だけ防ぐ。回数制限はしない）
  if (state.seri.recentYomi.includes(yomi)) return null;
  const text = match.exactPattern
    ? pick(SENRYU_EXACT_TEXTS, ctx.rng)
    : fill(pick(SENRYU_LOOSE_TEXTS, ctx.rng), { shape: shapeLabel(match.morae) });
  return {
    yomi,
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
// ぐっちー（場回しbot）
// ---------------------------------------------------------------------------

/** まだ使っていない話題カードを選ぶ。共通タグに対応するカードを優先する */
function chooseTopic(state: BotState, ctx: BotContext): TopicCard | null {
  const unused = TOPIC_CARDS.filter((card) => !state.gucchi.usedTopicIds.includes(card.id));
  const pool = unused.length > 0 ? unused : TOPIC_CARDS;
  const tagged = pool.filter((card) => card.tags.some((tag) => ctx.commonTags.includes(tag)));
  return pick(tagged.length > 0 ? tagged : pool, ctx.rng);
}

/**
 * まだ提案していないゲームを選ぶ。
 * 全部出し切っていても、前回の提案から十分に間が空いていれば誘い直す
 * （3本しかないので、序盤で撃ち尽くすと以後永久に提案できなくなる）。
 */
function chooseGame(state: BotState, ctx: BotContext): { id: string; title: string } | null {
  const { suggestedGameIds, lastGameSuggestAt } = state.gucchi;
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
 * 終了アンケートを出せる状況か。
 * 1ルームで END_POLL_MAX 回まで、かつ前回から END_POLL_COOLDOWN_MS 空ける。
 * 訊き続けると誰も反応しない部屋で永久ループになるうえ、単純にしつこい。
 * 「お開き」で締めた場合は closePoll が回数を上限まで進めて打ち止めにする。
 */
function canStartPoll(state: BotState, now: number): boolean {
  if (state.gucchi.poll !== null) return false;
  if (state.gucchi.silenceStreak < SILENCE_MAX_STREAK) return false;
  if (state.gucchi.pollsHeld >= END_POLL_MAX) return false;
  if (now - state.startedAt < END_POLL_MIN_AGE_MS) return false;
  const last = state.gucchi.lastPollAt;
  return last === null || now - last >= END_POLL_COOLDOWN_MS;
}

/**
 * 終了アンケートを締める。過半数が賛成なら締めの一言、届かなければ続行の一言。
 *
 * ここだけは発話枠（GUCCHI_RATE_MAX）を確認せずに必ず発話する。開いたアンケートを
 * 結果不明のまま放置するほうが害が大きいため。枠は1つ超過しうる。
 */
function closePoll(state: BotState, ctx: BotContext): BotResult {
  const poll = state.gucchi.poll;
  if (poll === null) return { state, utterances: [], effects: [] };
  // 誰もいない部屋、または OFF のあいだは黙って閉じる（§3.10「無人の場で喋り続けない」）。
  // 発話しなくてもアンケート自体は必ず片付ける。開いたまま放置すると
  // クライアントが締切のないアンケートを表示し続けてしまう
  const total = poll.eligibleIds.length;
  const { agreed } = countVotes(poll);
  const majority = total > 0 && agreed * 2 > total;
  if (!state.enabled.gucchi || total === 0 || ctx.connectedPlayerIds.length === 0) {
    // 発話は控えるが、集計結果は捨てない。参加者が過半数でお開きに賛成したのに
    // ルーム層へ「合意なし」と伝えてしまうと部屋が閉じられなくなる
    return {
      state: { ...state, gucchi: { ...state.gucchi, poll: null } },
      utterances: [],
      effects: [{ t: "pollClosed", pollId: poll.id, agreed: majority }],
    };
  }
  const kind: BotKind = majority ? "closing" : "pollContinue";
  const text = majority ? pick(CLOSING_TEXTS, ctx.rng) : pick(CONTINUE_TEXTS, ctx.rng);
  // silenceStreak は戻さない。戻すと話題カードの「連続2回まで」が復活し、
  // 誰も反応しない場で永久に喋り続けてしまう（§3.10）。
  // 「お開き」で締めたあとは訊き直す意味がないので打ち止めにする
  const gucchi = {
    ...spend(state, ctx.now),
    poll: null,
    pollsHeld: majority ? END_POLL_MAX : state.gucchi.pollsHeld,
  };
  return {
    state: { ...state, gucchi, lastActivityAt: ctx.now },
    utterances: [{ botId: "gucchi", kind, text }],
    effects: [{ t: "pollClosed", pollId: poll.id, agreed: majority }],
  };
}

/**
 * 沈黙・経過時間で発火するぐっちーの発話を決める。
 * 優先順は「集計中アンケートの締め > 話題カード > ゲーム提案 > 終了アンケート」。
 * 終了を切り出すのは、話題もゲーム提案も出しきってなお沈黙しているときだけ。
 */
function tickGucchi(state: BotState, ctx: BotContext): BotResult {
  // 集計中のアンケートは、ぐっちーが OFF でも締切が来たら必ず片付ける
  const poll = state.gucchi.poll;
  if (poll !== null) {
    return ctx.now - poll.startedAt >= END_POLL_MS
      ? closePoll(state, ctx)
      : { state, utterances: [], effects: [] };
  }
  if (!state.enabled.gucchi) return { state, utterances: [], effects: [] };
  // 全員が切断しているルームでは何も喋らない（§3.10「無人の場で喋り続けない」）
  if (ctx.connectedPlayerIds.length === 0) return { state, utterances: [], effects: [] };
  const silent = ctx.now - state.lastActivityAt >= SILENCE_MS;

  // 話題カード: 沈黙 3 分ごと、連続 2 回まで（§3.10）
  if (silent && state.gucchi.silenceStreak < SILENCE_MAX_STREAK) {
    const card = chooseTopic(state, ctx);
    if (card !== null && canGucchiSpeak(state, "topic", ctx.now)) {
      // 全カードを使い切ったら履歴を捨てて数え直す（無制限に伸ばさない）
      const used = state.gucchi.usedTopicIds.length + 1 >= TOPIC_CARDS.length
        ? [card.id]
        : [...state.gucchi.usedTopicIds, card.id];
      const gucchi = {
        ...spend(state, ctx.now),
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

  // ゲーム提案: ロビーで 5 分経過（§3.10）、または話題カードが打ち止めのとき。
  // 終了を切り出す前に、まず場を立て直す手を出す。
  // ロビー起点の提案は「会話が一段落したところ」を狙う。盛り上がっている最中に
  // 5分ごとに割り込むとうるさいので、直近 LOBBY_QUIET_MS は発言がないことを条件にする
  const lobbyStale = state.lobbySince !== null &&
    ctx.now - state.lobbySince >= LOBBY_SUGGEST_MS &&
    ctx.now - state.lastActivityAt >= LOBBY_QUIET_MS;
  const stuck = silent && state.gucchi.silenceStreak >= SILENCE_MAX_STREAK;
  const game = lobbyStale || stuck ? chooseGame(state, ctx) : null;
  if (game !== null && canGucchiSpeak(state, "gameSuggest", ctx.now)) {
    // 一巡して候補が戻ったときは、履歴を畳んでから積み直す
    const cycled = ctx.games.every((g) => state.gucchi.suggestedGameIds.includes(g.id));
    const gucchi = {
      ...spend(state, ctx.now),
      suggestedGameIds: cycled ? [game.id] : [...state.gucchi.suggestedGameIds, game.id],
      lastGameSuggestAt: ctx.now,
    };
    return {
      state: {
        ...state,
        gucchi,
        // ゲーム中（lobbySince === null）にロビータイマーを復活させない
        lobbySince: state.lobbySince === null ? null : ctx.now,
        lastActivityAt: ctx.now,
      },
      utterances: [{
        botId: "gucchi",
        kind: "gameSuggest",
        text: fill(pick(GAME_SUGGEST_TEXTS, ctx.rng), { title: game.title }),
        card: { c: "gameSuggest", gameId: game.id, gameTitle: game.title },
      }],
      effects: [],
    };
  }

  // 終了アンケート: 話題カードもゲーム提案も打ち止めで、まだ沈黙しているとき
  if (stuck && canStartPoll(state, ctx.now) && canGucchiSpeak(state, "endPoll", ctx.now)) {
    const id = ctx.newPollId();
    const gucchi = {
      ...spend(state, ctx.now),
      poll: { id, startedAt: ctx.now, votes: {}, eligibleIds: [...ctx.connectedPlayerIds] },
      pollsHeld: state.gucchi.pollsHeld + 1,
      lastPollAt: ctx.now,
    };
    return {
      state: { ...state, gucchi },
      utterances: [{
        botId: "gucchi",
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
        utterances.push({
          botId: "shunpi",
          kind: "naming",
          text: fill(pick(NAMING_TEXTS, ctx.rng), { name: event.assignedNickname }),
        });
      }
      let next = state;
      if (state.enabled.gucchi && canGucchiSpeak(state, "greeting", ctx.now)) {
        utterances.push({
          botId: "gucchi",
          kind: "greeting",
          text: fill(pick(GREETING_TEXTS, ctx.rng), {
            name: event.assignedNickname ?? event.nickname,
          }),
        });
        next = { ...next, gucchi: spend(next, ctx.now) };
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
      if (state.gucchi.poll === null) return { state, utterances: [], effects: [] };
      // 退室が確定した人の票は無効にする（§8 の「当人への票は無効化」と同じ考え方）
      const votes = { ...state.gucchi.poll.votes };
      delete votes[event.playerId];
      const poll: EndPoll = {
        ...state.gucchi.poll,
        votes,
        eligibleIds: state.gucchi.poll.eligibleIds.filter((id) => id !== event.playerId),
      };
      const next: BotState = { ...state, gucchi: { ...state.gucchi, poll } };
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
      const next: BotState = {
        ...state,
        lastActivityAt: ctx.now,
        lastHumanAt: ctx.now,
        seri: { recentYomi },
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
          gucchi: {
            ...state.gucchi,
            silenceStreak: 0,
            // 1本遊び終えたら提案の弾を補充する。そうしないと収録ゲームの
            // 本数ぶんで打ち止めになり、終盤に立て直す手がなくなる。
            // ただし直前に提案したものは残し、遊んだ直後の再提案を避ける
            suggestedGameIds: backToLobby
              ? state.gucchi.suggestedGameIds.slice(-1)
              : state.gucchi.suggestedGameIds,
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
      if (!state.enabled.gucchi || !canGucchiSpeak(state, kind, ctx.now)) {
        return { state: base, utterances: [], effects: [] };
      }
      const texts = event.t === "roundResult" ? ROUND_REACTION_TEXTS : FINAL_REACTION_TEXTS;
      return {
        state: { ...base, gucchi: spend(base, ctx.now) },
        effects: [],
        utterances: [{
          botId: "gucchi",
          kind,
          text: fill(pick(texts, ctx.rng), { name: event.topNickname ?? "みなさん" }),
        }],
      };
    }

    case "endPollVote": {
      const poll = state.gucchi.poll;
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
        gucchi: { ...state.gucchi, poll: voted },
      };
      // 全員が投票し終えたとき、または賛成が過半数に達して結果が決まったときは
      // 締め切りを待たずに締める
      return isPollDecided(voted)
        ? closePoll(next, ctx)
        : { state: next, utterances: [], effects: [] };
    }

    case "tick":
      return tickGucchi(state, ctx);
  }
}

/** engine.ts の reduce と名前が衝突しないための別名 */
export { reduce as botReduce };
