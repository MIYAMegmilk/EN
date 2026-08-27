/**
 * bot.ts のユニットテスト
 * 詳細仕様書 §9-1「bot 発話トリガー（沈黙検知・頻度上限）」に対応する。ひろし担当。
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  BOT_RATE_WINDOW_MS,
  type BotContext,
  type BotEvent,
  type BotId,
  type BotResult,
  type BotState,
  createBotState,
  END_POLL_MAX,
  END_POLL_MIN_AGE_MS,
  END_POLL_MS,
  GUCCHI_RATE_MAX,
  LOBBY_QUIET_MS,
  LOBBY_SUGGEST_MS,
  NABE_RATE_MAX,
  pickNickname,
  QUOTE_LINE_MAX,
  reduce,
  SENRYU_MEMORY,
  SERI_VOICE_COOLDOWN_MS,
  SILENCE_MAX_STREAK,
  SILENCE_MS,
} from "../bot.ts";
import {
  BOT_IDS,
  BOTS,
  CLOSING_TEXTS,
  CONTINUE_TEXTS,
  FINAL_REACTION_TEXTS,
  NICKNAME_ADJECTIVES,
  NICKNAME_NOUNS,
  ROUND_REACTION_TEXTS,
  SENRYU_EXACT_TEXTS,
  SENRYU_VOICE_TEXTS,
  TOPIC_CARDS,
} from "../bot_templates.ts";
import { createKanaProvider, detectSenryu, SENRYU_TOLERANCE } from "../senryu.ts";
import { NICKNAME_MAX } from "../types.ts";

const T0 = 1_700_000_000_000;
/**
 * tick を1回ぶん進めるときの刻み。「沈黙が確定するだけの間隔」という意味で使う。
 *
 * SILENCE_MS を直接掛け算に使うと、しきい値を縮めたときにテストの時間軸まで
 * 一緒に縮んでしまう（30秒 × 20回では BOT_RATE_WINDOW_MS の10分窓も
 * END_POLL_MIN_AGE_MS の45分も跨げず、なべがそもそも動かない）。
 * しきい値の境界そのものを見るテストだけが SILENCE_MS を使う。
 */
const SILENT_STEP = 3 * 60_000;
const kana = createKanaProvider();

/** 常に先頭候補を選ぶ乱数。テストを決定的にする */
const firstRng = () => 0;

/** アンケートIDを発行する。ファイル全体で一意になるので ID 照合を検証できる */
let pollSeq = 0;
const newPollId = () => `poll-${++pollSeq}`;

/** テスト用の context を作る */
function ctx(now: number, overrides: Partial<BotContext> = {}): BotContext {
  return {
    now,
    connectedPlayerIds: ["p1", "p2", "p3"],
    commonTags: [],
    rng: firstRng,
    senryu: (text) => detectSenryu(text, kana, { tolerance: SENRYU_TOLERANCE }),
    games: [
      { id: "official-ogiri", title: "大喜利" },
      { id: "official-ishindenshin", title: "以心伝心" },
      { id: "official-quiz", title: "雑学クイズ" },
    ],
    newPollId,
    ...overrides,
  };
}

/** イベントを順に流す小さなヘルパー */
function run(
  state: BotState,
  steps: ReadonlyArray<{ at: number; event: BotEvent; ctx?: Partial<BotContext> }>,
): { state: BotState; all: BotResult["utterances"] } {
  let current = state;
  const all: BotResult["utterances"] = [];
  for (const step of steps) {
    const result = reduce(current, step.event, ctx(step.at, step.ctx));
    current = result.state;
    all.push(...result.utterances);
  }
  return { state: current, all };
}

/** 沈黙を重ねて終了アンケートが出る状態まで進める */
function advanceToPoll(overrides: Partial<BotContext> = {}): { state: BotState; pollId: string } {
  let state = createBotState(T0);
  let pollId: string | null = null;
  // 話題カード2回 → ゲーム提案3本 → それでも沈黙、の順に進む
  for (let i = 1; i <= 20 && pollId === null; i++) {
    const result = reduce(state, { t: "tick" }, ctx(T0 + SILENT_STEP * i, overrides));
    state = result.state;
    for (const utterance of result.utterances) {
      if (utterance.card?.c === "endPoll") pollId = utterance.card.pollId;
    }
  }
  assert(pollId !== null, "終了アンケートが出なかった");
  return { state, pollId };
}

// ---------------------------------------------------------------------------
// しゅんぴ（あだ名bot）
// ---------------------------------------------------------------------------

Deno.test("pickNickname: プリセットの組み合わせから20文字以内で選ぶ", () => {
  const name = pickNickname(new Set(), firstRng);
  assertEquals(name, `${NICKNAME_ADJECTIVES[0]}${NICKNAME_NOUNS[0]}`);
  assert(name.length <= NICKNAME_MAX);
});

Deno.test("pickNickname: すでに使われている名前は避ける", () => {
  const taken = new Set([`${NICKNAME_ADJECTIVES[0]}${NICKNAME_NOUNS[0]}`]);
  const name = pickNickname(taken, firstRng);
  assert(!taken.has(name));
  assert(name.length <= NICKNAME_MAX);
});

Deno.test("pickNickname: 100人ぶん引いても重複しない", () => {
  const taken = new Set<string>();
  let seed = 0;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 100; i++) {
    const name = pickNickname(taken, rng);
    assert(!taken.has(name), `重複: ${name}`);
    assert(name.length <= NICKNAME_MAX);
    taken.add(name);
  }
});

Deno.test("しゅんぴ: あだ名未入力のときだけ命名を告知する", () => {
  const withAssigned = reduce(
    createBotState(T0),
    { t: "playerJoined", playerId: "p1", nickname: "", assignedNickname: "ほろよいペンギン" },
    ctx(T0),
  );
  const naming = withAssigned.utterances.filter((u) => u.botId === "shunpi");
  assertEquals(naming.length, 1);
  assert(naming[0].text.includes("ほろよいペンギン"));

  const withOwnName = reduce(
    createBotState(T0),
    { t: "playerJoined", playerId: "p2", nickname: "たろう" },
    ctx(T0),
  );
  assertEquals(withOwnName.utterances.filter((u) => u.botId === "shunpi").length, 0);
});

// ---------------------------------------------------------------------------
// せり（川柳bot）
// ---------------------------------------------------------------------------

Deno.test("せり: 川柳を拾うとカード付きで反応する", () => {
  const result = reduce(
    createBotState(T0),
    {
      t: "message",
      playerId: "p1",
      nickname: "たろう",
      text: "ふるいけやかわずとびこむみずのおと",
      source: "chat",
    },
    ctx(T0),
  );
  assertEquals(result.utterances.length, 1);
  const [utterance] = result.utterances;
  assertEquals(utterance.botId, "seri");
  assertEquals(utterance.kind, "senryu");
  assert(utterance.card?.c === "senryu");
  assertEquals(utterance.card.exact, true);
  assertEquals(utterance.card.morae, [5, 7, 5]);
  assertEquals(utterance.card.author, "たろう");
  // テロップに載る実データ。ここを見ないと空文字でも通ってしまう
  assertEquals(utterance.card.lines, ["ふるいけや", "かわずとびこむ", "みずのおと"]);
});

Deno.test("せり: 字余り・字足らずは別の文面で反応する", () => {
  const result = reduce(
    createBotState(T0),
    {
      t: "message",
      playerId: "p1",
      nickname: "たろう",
      text: "あいうえおかきくけこさしすせそた",
      source: "chat",
    },
    ctx(T0),
  );
  assertEquals(result.utterances.length, 1);
  assert(result.utterances[0].card?.c === "senryu");
  assertEquals(result.utterances[0].card.exact, false);
  assert(result.utterances[0].text.includes("字足らず"));
});

Deno.test("せり: 発話回数の上限に縛られない（10分5発話を超えて反応する）", () => {
  // 末尾1文字だけ違う句を並べ、すべて別の川柳として扱わせる
  const tails = [..."あいうえおかきくけこさし"];
  let state = createBotState(T0);
  let count = 0;
  for (const [i, tail] of tails.entries()) {
    const result = reduce(
      state,
      {
        t: "message",
        playerId: "p1",
        nickname: "たろう",
        text: `あいうえおかきくけこさしすせそた${tail}`,
        source: "chat",
      },
      ctx(T0 + i * 1_000),
    );
    state = result.state;
    count += result.utterances.filter((u) => u.botId === "seri").length;
  }
  assertEquals(count, tails.length);
  assert(count > GUCCHI_RATE_MAX, "ぐっちーの発話枠を超えて反応できていない");
  assertEquals(state.gucchi.utteranceTimes.length, 0, "せりはぐっちーの発話枠を消費しない");
});

Deno.test("せり: 直前とまったく同じ川柳は黙る（コピペ連投対策）", () => {
  const text = "ふるいけやかわずとびこむみずのおと";
  const first = reduce(
    createBotState(T0),
    { t: "message", playerId: "p1", nickname: "たろう", text, source: "chat" },
    ctx(T0),
  );
  assertEquals(first.utterances.length, 1);
  const second = reduce(
    first.state,
    { t: "message", playerId: "p1", nickname: "たろう", text, source: "chat" },
    ctx(T0 + 1_000),
  );
  assertEquals(second.utterances.length, 0);
});

Deno.test("せり: 川柳判定が常に null を返すなら何もしない", () => {
  const result = reduce(
    createBotState(T0),
    {
      t: "message",
      playerId: "p1",
      nickname: "たろう",
      text: "ふるいけやかわずとびこむみずのおと",
      source: "chat",
    },
    ctx(T0, { senryu: () => null }),
  );
  assertEquals(result.utterances.length, 0);
});

// ---------------------------------------------------------------------------
// せり: 通話の文字起こし（source: "voice"、docs/design/bot-voice.md）
// ---------------------------------------------------------------------------

/** 文字起こし1件（source: "voice"）を作る */
function voice(text: string): Extract<BotEvent, { t: "message" }> {
  return { t: "message", playerId: "p1", nickname: "たろう", text, source: "voice" };
}

Deno.test("せり: voice 由来の発言も同じ経路で判定する", () => {
  const result = reduce(
    createBotState(T0),
    {
      t: "message",
      playerId: "p1",
      nickname: "たろう",
      text: "ふるいけやかわずとびこむみずのおと",
      source: "voice",
    },
    ctx(T0),
  );
  assertEquals(result.utterances.length, 1);
  assertEquals(result.utterances[0].botId, "seri");
});

Deno.test("せり: 声で拾った句もチャットに流す（発話面はチャットのみ）", () => {
  const result = reduce(createBotState(T0), voice("ふるいけやかわずとびこむみずのおと"), ctx(T0));
  assertEquals(result.utterances.length, 1);
  const [utterance] = result.utterances;
  assertEquals(utterance.kind, "senryu");
  assert(utterance.card?.c === "senryu");
  // テロップは打った句と同じ形。詠み手のあだ名もそのまま載る
  assertEquals(utterance.card.lines, ["ふるいけや", "かわずとびこむ", "みずのおと"]);
  assertEquals(utterance.card.author, "たろう");
  // 文面はチャット用と分ける（「書いた」ではなく「言った」句のため）
  assert(SENRYU_VOICE_TEXTS.includes(utterance.text), "声用の文面が使われていない");
  assert(!SENRYU_EXACT_TEXTS.includes(utterance.text));
});

Deno.test("せり: 声の字余り・字足らずは拾わない（聞き違いと区別できない）", () => {
  // チャットなら「字足らず」で拾う句（bot_test 冒頭の loose テストと同じ入力）
  const text = "あいうえおかきくけこさしすせそた";
  const chat = reduce(
    createBotState(T0),
    { t: "message", playerId: "p1", nickname: "たろう", text, source: "chat" },
    ctx(T0),
  );
  assertEquals(chat.utterances.length, 1, "前提: チャットでは字足らずでも拾う");

  const spoken = reduce(createBotState(T0), voice(text), ctx(T0));
  assertEquals(spoken.utterances.length, 0);
});

Deno.test("せり: 声の句はクールダウン中は見送る", () => {
  const first = reduce(
    createBotState(T0),
    voice("ふるいけやかわずとびこむみずのおと"),
    ctx(T0),
  );
  assertEquals(first.utterances.length, 1);
  assertEquals(first.state.seri.lastVoiceAt, T0);

  // 別の句でも、クールダウンが明けるまでは拾わない
  const during = reduce(
    first.state,
    voice("あきののにさくはなたちのなをしらず"),
    ctx(T0 + SERI_VOICE_COOLDOWN_MS - 1),
  );
  assertEquals(during.utterances.length, 0);
  assertEquals(during.state.seri.lastVoiceAt, T0, "見送った声でクールダウンを延長しない");

  const after = reduce(
    during.state,
    voice("あきののにさくはなたちのなをしらず"),
    ctx(T0 + SERI_VOICE_COOLDOWN_MS),
  );
  assertEquals(after.utterances.length, 1);
  assertEquals(after.state.seri.lastVoiceAt, T0 + SERI_VOICE_COOLDOWN_MS);
});

Deno.test("せり: 声のクールダウン中でもチャットの句は拾う（枠は別）", () => {
  const first = reduce(
    createBotState(T0),
    voice("ふるいけやかわずとびこむみずのおと"),
    ctx(T0),
  );
  assertEquals(first.utterances.length, 1);

  const typed = reduce(
    first.state,
    {
      t: "message",
      playerId: "p2",
      nickname: "はなこ",
      text: "あきののにさくはなたちのなをしらず",
      source: "chat",
    },
    ctx(T0 + 1_000),
  );
  assertEquals(typed.utterances.length, 1);
  assertEquals(typed.state.seri.lastVoiceAt, T0, "チャットの句で声のクールダウンを進めない");
});

Deno.test("せり: OFF なら声からも拾わない", () => {
  const off = reduce(
    createBotState(T0),
    { t: "setBot", botId: "seri", enabled: false },
    ctx(T0),
  ).state;
  const result = reduce(off, voice("ふるいけやかわずとびこむみずのおと"), ctx(T0));
  assertEquals(result.utterances.length, 0);
});

Deno.test("ぐっちー: 声で会話が続いている部屋を沈黙と判定しない", () => {
  let state = createBotState(T0);
  // 2分ごとに文字起こしが届く＝声で喋り続けている部屋。川柳ではない発言を使う
  for (let i = 1; i <= 5; i++) {
    const at = T0 + i * 2 * 60_000;
    state = reduce(state, voice("かんぱーい"), ctx(at)).state;
    const tick = reduce(state, { t: "tick" }, ctx(at + 1_000));
    state = tick.state;
    assertEquals(tick.utterances.length, 0, `${i}回目: 声を無視して話題カードを投げている`);
  }
  assertEquals(state.gucchi.silenceStreak, 0);

  // 声も止まって SILENCE_MS 経てば、これまでどおり話題カードを投げる
  const silent = reduce(state, { t: "tick" }, ctx(state.lastActivityAt + SILENCE_MS));
  assertEquals(silent.utterances.length, 1);
  assertEquals(silent.utterances[0].kind, "topic");
});

// ---------------------------------------------------------------------------
// ぐっちー（場を温めるbot）: 沈黙検知
// ---------------------------------------------------------------------------

Deno.test("ぐっちー: 沈黙30秒で話題カードを投げる", () => {
  const before = reduce(createBotState(T0), { t: "tick" }, ctx(T0 + SILENCE_MS - 1));
  assertEquals(before.utterances.length, 0, "30秒未満では投げない");

  const after = reduce(createBotState(T0), { t: "tick" }, ctx(T0 + SILENCE_MS));
  assertEquals(after.utterances.length, 1);
  assertEquals(after.utterances[0].botId, "gucchi");
  assertEquals(after.utterances[0].kind, "topic");
});

Deno.test("ぐっちー: 話題カードの連続投下は2回まで（§3.10）", () => {
  let state = createBotState(T0);
  const topics: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const result = reduce(state, { t: "tick" }, ctx(T0 + SILENCE_MS * i));
    state = result.state;
    for (const utterance of result.utterances) {
      if (utterance.kind === "topic") topics.push(utterance.text);
    }
  }
  assertEquals(topics.length, SILENCE_MAX_STREAK);
  assertNotEquals(topics[0], topics[1], "同じ話題カードを繰り返さない");
});

Deno.test("ぐっちー: 誰かが喋ると沈黙カウントがリセットされる", () => {
  let state = createBotState(T0);
  state = reduce(state, { t: "tick" }, ctx(T0 + SILENCE_MS)).state;
  assertEquals(state.gucchi.silenceStreak, 1);
  state = reduce(
    state,
    { t: "message", playerId: "p1", nickname: "たろう", text: "おつかれ", source: "chat" },
    ctx(T0 + SILENCE_MS + 1_000),
  ).state;
  assertEquals(state.gucchi.silenceStreak, 0);
});

Deno.test("ぐっちー: 共通タグがあれば対応する話題カードを優先する", () => {
  const result = reduce(
    createBotState(T0),
    { t: "tick" },
    ctx(T0 + SILENCE_MS, { commonTags: ["game"] }),
  );
  assertEquals(result.utterances.length, 1);
  assert(result.utterances[0].text.includes("ゲーム"));
});

// ---------------------------------------------------------------------------
// なべ（進行bot）: ゲーム提案
// ---------------------------------------------------------------------------

Deno.test("なべ: 静かなロビーが5分続くとゲームを提案する", () => {
  // 会話が続いているあいだは lobbySince が進むので提案しない
  let chatty = createBotState(T0);
  for (let minute = 1; minute <= 5; minute++) {
    chatty = reduce(
      chatty,
      { t: "message", playerId: "p1", nickname: "たろう", text: "はい", source: "chat" },
      ctx(T0 + minute * 60_000),
    ).state;
  }
  const during = reduce(chatty, { t: "tick" }, ctx(T0 + LOBBY_SUGGEST_MS));
  assertEquals(
    during.utterances.filter((u) => u.kind === "gameSuggest").length,
    0,
    "会話が続いているロビーに割り込んでいる",
  );

  // 会話が一段落したところで提案する。
  //
  // ここでぐっちーの発話枠を埋めておくのは、SILENCE_MS（30秒）が
  // LOBBY_QUIET_MS（60秒）より短いため。「直近60秒は無言」を満たす時点で
  // 沈黙判定（30秒）はとっくに成立していて、ふつうは tickBots が
  // ぐっちーの話題カードで早期 return してしまい、なべまで届かない。
  // 枠を使い切ったぐっちーは黙るが silenceStreak は 0 のままなので、
  // stuck が false のまま lobbyStale だけが真になる経路をここで確かめられる。
  const base = createBotState(T0);
  let quiet: BotState = {
    ...base,
    gucchi: { ...base.gucchi, utteranceTimes: Array(GUCCHI_RATE_MAX).fill(T0) },
  };
  quiet = reduce(quiet, { t: "gameAction" }, ctx(T0 + LOBBY_SUGGEST_MS - LOBBY_QUIET_MS)).state;
  const result = reduce(quiet, { t: "tick" }, ctx(T0 + LOBBY_SUGGEST_MS));
  assertEquals(result.state.gucchi.silenceStreak, 0, "stuck 経由になっている");
  const suggest = result.utterances.find((u) => u.kind === "gameSuggest");
  assert(suggest !== undefined, "会話が一段落したロビーで提案が出ない");
  assert(suggest.card?.c === "gameSuggest");
  assertEquals(suggest.card.gameId, "official-ogiri");
  assert(suggest.text.includes("大喜利"));
});

Deno.test("なべ: ゲームを1本遊び終えたら提案の弾を補充する", () => {
  let state = createBotState(T0);
  // 3本すべて提案して弾切れにする
  for (let i = 1; i <= 8; i++) {
    state = reduce(state, { t: "tick" }, ctx(T0 + SILENT_STEP * i)).state;
  }
  assertEquals(state.nabe.suggestedGameIds.length, 3);
  // ゲームを始めて終える
  state = reduce(state, { t: "phaseChanged", phase: "input" }, ctx(T0 + 60 * 60_000)).state;
  state = reduce(state, { t: "phaseChanged", phase: "lobby" }, ctx(T0 + 70 * 60_000)).state;
  assertEquals(
    state.nabe.suggestedGameIds.length,
    1,
    "遊び終えても弾が補充されない（直前の1本だけ残す）",
  );
});

Deno.test("なべ: 同じゲームを二度提案しない", () => {
  let state = createBotState(T0);
  const suggested: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const result = reduce(state, { t: "tick" }, ctx(T0 + SILENT_STEP * i));
    state = result.state;
    for (const utterance of result.utterances) {
      if (utterance.card?.c === "gameSuggest") suggested.push(utterance.card.gameId);
    }
  }
  assertEquals(suggested.length, 3, "登録した3本すべてを提案するはず");
  assertEquals(new Set(suggested).size, suggested.length, "同じゲームを二度提案している");
});

// ---------------------------------------------------------------------------
// なべ: 終了アンケート
// ---------------------------------------------------------------------------

Deno.test("なべ: 沈黙が続くと終了アンケートを出す", () => {
  const { state, pollId } = advanceToPoll();
  assertEquals(state.nabe.poll?.id, pollId);
});

Deno.test("なべ: 過半数が賛成したら締めの一言を出す", () => {
  const { state, pollId } = advanceToPoll();
  const at = (state.nabe.poll?.startedAt ?? T0) + 1_000;
  const voted = run(state, [
    { at, event: { t: "endPollVote", pollId, playerId: "p1", agree: true } },
    { at: at + 1, event: { t: "endPollVote", pollId, playerId: "p2", agree: true } },
  ]);
  // 接続中3人のうち2人が賛成 → 過半数
  const closing = voted.all.find((u) => u.kind === "closing");
  assert(closing !== undefined);
  assert(CLOSING_TEXTS.includes(closing.text), `締めの文面ではない: ${closing.text}`);
  assertEquals(voted.state.nabe.poll, null);
});

Deno.test("なべ: 過半数に届かなければ続行の一言を出す", () => {
  const { state, pollId } = advanceToPoll();
  const at = (state.nabe.poll?.startedAt ?? T0) + 1_000;
  const result = run(state, [
    { at, event: { t: "endPollVote", pollId, playerId: "p1", agree: true } },
    { at: at + 1, event: { t: "endPollVote", pollId, playerId: "p2", agree: false } },
    { at: at + 2, event: { t: "endPollVote", pollId, playerId: "p3", agree: false } },
  ]);
  assertEquals(result.all.length, 1);
  assertEquals(result.all[0].kind, "pollContinue");
  assert(
    CONTINUE_TEXTS.includes(result.all[0].text),
    `続行の文面ではない: ${result.all[0].text}`,
  );
  assertEquals(result.state.nabe.poll, null);
});

Deno.test("なべ: 締め切り時刻を過ぎたら tick で集計する", () => {
  const { state, pollId } = advanceToPoll();
  const startedAt = state.nabe.poll?.startedAt ?? T0;
  const voted = reduce(
    state,
    { t: "endPollVote", pollId, playerId: "p1", agree: true },
    ctx(startedAt + 1),
  );
  assertEquals(voted.utterances.length, 0, "全員そろうまでは締めない");
  const closed = reduce(voted.state, { t: "tick" }, ctx(startedAt + END_POLL_MS));
  assertEquals(closed.utterances.length, 1);
  assertEquals(closed.state.nabe.poll, null);
});

Deno.test("なべ: 別のアンケートID宛の遅延投票は無視する", () => {
  const { state, pollId } = advanceToPoll();
  const at = (state.nabe.poll?.startedAt ?? T0) + 1_000;
  const stale = run(state, [
    { at, event: { t: "endPollVote", pollId: `${pollId}-old`, playerId: "p1", agree: true } },
    {
      at: at + 1,
      event: { t: "endPollVote", pollId: `${pollId}-old`, playerId: "p2", agree: true },
    },
  ]);
  assertEquals(stale.all.length, 0);
  assertEquals(stale.state.nabe.poll?.votes, {});
});

Deno.test("なべ: 接続していないIDからの投票は数えない", () => {
  const { state, pollId } = advanceToPoll();
  const at = (state.nabe.poll?.startedAt ?? T0) + 1_000;
  const ghosts = run(state, [
    { at, event: { t: "endPollVote", pollId, playerId: "x1", agree: true } },
    { at: at + 1, event: { t: "endPollVote", pollId, playerId: "x2", agree: true } },
    { at: at + 2, event: { t: "endPollVote", pollId, playerId: "x3", agree: true } },
  ]);
  assertEquals(ghosts.all.length, 0, "幽霊票だけでは締まらない");
  assertEquals(ghosts.state.nabe.poll?.votes, {});
});

Deno.test("なべ: 退室で人数が減ったら残りの票だけで締める", () => {
  const { state, pollId } = advanceToPoll();
  const at = (state.nabe.poll?.startedAt ?? T0) + 1_000;
  // p1・p2 が投票済みで未決 → p3 が退室すると 2人中2人投票済みになり決着する
  const voted = run(state, [
    { at, event: { t: "endPollVote", pollId, playerId: "p1", agree: true } },
    { at: at + 1, event: { t: "endPollVote", pollId, playerId: "p2", agree: false } },
  ]);
  assertEquals(voted.all.length, 0, "3人中2票では未決");
  const left = reduce(
    voted.state,
    { t: "playerLeft", playerId: "p3" },
    ctx(at + 2, { connectedPlayerIds: ["p1", "p2"] }),
  );
  assertEquals(left.utterances.length, 1);
  assertEquals(left.state.nabe.poll, null);
});

Deno.test("なべ: 退室した人の票は無効になる", () => {
  const { state, pollId } = advanceToPoll();
  const at = (state.nabe.poll?.startedAt ?? T0) + 1_000;
  const voted =
    reduce(state, { t: "endPollVote", pollId, playerId: "p1", agree: true }, ctx(at)).state;
  const left = reduce(
    voted,
    { t: "playerLeft", playerId: "p1" },
    ctx(at + 1, { connectedPlayerIds: ["p2", "p3"] }),
  ).state;
  assertEquals(left.nabe.poll?.votes, {});
});

Deno.test("なべ: 終了アンケートは1ルームにつき1回しか出さない", () => {
  const { state, pollId } = advanceToPoll();
  const startedAt = state.nabe.poll?.startedAt ?? T0;
  const closed = run(state, [
    { at: startedAt + 1, event: { t: "endPollVote", pollId, playerId: "p1", agree: false } },
    { at: startedAt + 2, event: { t: "endPollVote", pollId, playerId: "p2", agree: false } },
    { at: startedAt + 3, event: { t: "endPollVote", pollId, playerId: "p3", agree: false } },
  ]);
  assertEquals(closed.state.nabe.poll, null);
  assertEquals(closed.state.nabe.pollsHeld, 1);
  // クールダウン中（60分）は訊き直さない
  let s = closed.state;
  let askedDuringCooldown = 0;
  for (let i = 1; i <= 50; i++) {
    const result = reduce(s, { t: "tick" }, ctx(startedAt + 60_000 * i));
    s = result.state;
    askedDuringCooldown += result.utterances.filter((u) => u.kind === "endPoll").length;
  }
  assertEquals(askedDuringCooldown, 0, "クールダウン中に訊き直している");
  // クールダウン明けなら1回だけ訊き直す
  let asked = 0;
  for (let i = 51; i <= 300; i++) {
    const result = reduce(s, { t: "tick" }, ctx(startedAt + 60_000 * i));
    s = result.state;
    asked += result.utterances.filter((u) => u.kind === "endPoll").length;
  }
  assertEquals(asked, 1, "上限2回を超えて訊いている / まったく訊かない");
  assertEquals(s.nabe.pollsHeld, END_POLL_MAX);
});

Deno.test("なべ: お開きで締めたあとは二度と訊かない", () => {
  const { state, pollId } = advanceToPoll();
  const startedAt = state.nabe.poll?.startedAt ?? T0;
  // 過半数賛成で締める
  const closed = run(state, [
    { at: startedAt + 1, event: { t: "endPollVote", pollId, playerId: "p1", agree: true } },
    { at: startedAt + 2, event: { t: "endPollVote", pollId, playerId: "p2", agree: true } },
  ]);
  assertEquals(closed.all[0].kind, "closing");
  assertEquals(closed.state.nabe.pollsHeld, END_POLL_MAX, "締めたら打ち止めのはず");
  let s = closed.state;
  let asked = 0;
  for (let i = 1; i <= 300; i++) {
    const result = reduce(s, { t: "tick" }, ctx(startedAt + 60_000 * i));
    s = result.state;
    asked += result.utterances.filter((u) => u.kind === "endPoll").length;
  }
  assertEquals(asked, 0, "お開き後に訊き直している");
});

// ---------------------------------------------------------------------------
// 発話枠と ON/OFF
// ---------------------------------------------------------------------------

Deno.test("枠: どの10分窓を切っても bot ごとの上限を超えない（§3.10）", () => {
  let state = createBotState(T0);
  const spoken: Array<{ at: number; botId: BotId }> = [];
  // 1分ごとに2時間ぶん回し、発話時刻を bot ごとに全部記録する
  for (let i = 1; i <= 120; i++) {
    const at = T0 + 60_000 * i;
    const result = reduce(state, { t: "tick" }, ctx(at));
    state = result.state;
    for (const utterance of result.utterances) spoken.push({ at, botId: utterance.botId });
  }
  assert(spoken.length > 0, "そもそも発話が起きていない");
  // 枠は bot ごとに独立しているので、窓も bot ごとに切って数える
  const max: Record<string, number> = { gucchi: GUCCHI_RATE_MAX, nabe: NABE_RATE_MAX };
  for (const [botId, limit] of Object.entries(max)) {
    const times = spoken.filter((s) => s.botId === botId).map((s) => s.at);
    for (const start of times) {
      const inWindow = times.filter((at) => at >= start && at - start < BOT_RATE_WINDOW_MS);
      assert(inWindow.length <= limit, `${botId} の10分窓に ${inWindow.length} 発話`);
    }
  }
});

Deno.test("ぐっちー: 続けて入室した人を無視しない", () => {
  // 挨拶は normal。大人数が一度に入っても4人目以降を黙殺しない
  let state = createBotState(T0);
  let greeted = 0;
  for (let i = 0; i < 5; i++) {
    const result = reduce(
      state,
      { t: "playerJoined", playerId: `p${i}`, nickname: `ゲスト${i}` },
      ctx(T0 + i * 10_000),
    );
    state = result.state;
    greeted += result.utterances.filter((u) => u.kind === "greeting").length;
  }
  assertEquals(greeted, GUCCHI_RATE_MAX, "枠のぶんは挨拶するはず");
});

Deno.test("ぐっちー: 枠が残り少ないと optional の相槌は出さない", () => {
  const at = T0 + 1_000;
  const base = createBotState(T0);
  // 残り2（3件使用済み）では出さない
  const tight: BotState = {
    ...base,
    gucchi: { ...base.gucchi, utteranceTimes: [T0, T0, T0] },
  };
  assertEquals(
    reduce(tight, { t: "roundResult", topNickname: "たろう" }, ctx(at)).utterances.length,
    0,
  );
  // 残り3（2件使用済み）なら出る
  const roomier: BotState = {
    ...base,
    gucchi: { ...base.gucchi, utteranceTimes: [T0, T0] },
  };
  const ok = reduce(roomier, { t: "roundResult", topNickname: "たろう" }, ctx(at));
  assertEquals(ok.utterances.length, 1);
  assertEquals(ok.utterances[0].kind, "reaction");
  assert(ok.utterances[0].text.includes("たろう"));
});

Deno.test("ぐっちー: 10分の窓から外れた発話は数えなおす", () => {
  const base = createBotState(T0);
  const state: BotState = {
    ...base,
    gucchi: { ...base.gucchi, utteranceTimes: [T0, T0, T0, T0, T0] },
  };
  const stillFull = reduce(state, { t: "tick" }, ctx(T0 + SILENCE_MS));
  assertEquals(stillFull.utterances.length, 0);

  const later = reduce(state, { t: "tick" }, ctx(T0 + BOT_RATE_WINDOW_MS));
  assertEquals(later.utterances.length, 1);
});

Deno.test("setBot: bot ごとに ON/OFF できる", () => {
  const off = reduce(createBotState(T0), { t: "setBot", botId: "seri", enabled: false }, ctx(T0));
  assertEquals(off.state.enabled.seri, false);
  assertEquals(off.state.enabled.gucchi, true);
  const silent = reduce(
    off.state,
    {
      t: "message",
      playerId: "p1",
      nickname: "たろう",
      text: "ふるいけやかわずとびこむみずのおと",
      source: "chat",
    },
    ctx(T0 + 1_000),
  );
  assertEquals(silent.utterances.length, 0);
});

Deno.test("setBot: しゅんぴ単体・ぐっちー単体でも切り替わる", () => {
  const noShunpi = reduce(
    createBotState(T0),
    { t: "setBot", botId: "shunpi", enabled: false },
    ctx(T0),
  );
  const joined = reduce(
    noShunpi.state,
    { t: "playerJoined", playerId: "p1", nickname: "", assignedNickname: "名無しさん" },
    ctx(T0 + 1),
  );
  assertEquals(joined.utterances.filter((u) => u.botId === "shunpi").length, 0);
  assertEquals(joined.utterances.filter((u) => u.botId === "gucchi").length, 1);

  const noGucchi = reduce(
    createBotState(T0),
    { t: "setBot", botId: "gucchi", enabled: false },
    ctx(T0),
  );
  // ぐっちーが黙ること（＝話題カードが出ないこと）を見る。
  // なべは独立して動くので「発話が0件」ではなく「ぐっちーの発話が0件」で判定する
  const silent = reduce(noGucchi.state, { t: "tick" }, ctx(T0 + SILENCE_MS));
  assertEquals(silent.utterances.filter((u) => u.botId === "gucchi").length, 0);
  assertEquals(silent.utterances.filter((u) => u.kind === "topic").length, 0);
});

Deno.test("setBot: botId 省略で4体まとめて切り替わる", () => {
  const off = reduce(createBotState(T0), { t: "setBot", enabled: false }, ctx(T0));
  assertEquals(off.state.enabled, {
    shunpi: false,
    seri: false,
    gucchi: false,
    nabe: false,
  });
  // ON も同様にまとめて戻る
  const on = reduce(off.state, { t: "setBot", enabled: true }, ctx(T0 + 1));
  assertEquals(on.state.enabled, { shunpi: true, seri: true, gucchi: true, nabe: true });
  const nothing = run(off.state, [
    {
      at: T0 + 1,
      event: { t: "playerJoined", playerId: "p1", nickname: "", assignedNickname: "名無しさん" },
    },
    { at: T0 + SILENCE_MS + 2, event: { t: "tick" } },
  ]);
  assertEquals(nothing.all.length, 0);
});

Deno.test("BOTS: 4体の表示名と役割が定義されている", () => {
  assertEquals(BOTS.shunpi.name, "しゅんぴ");
  assertEquals(BOTS.seri.name, "せり");
  assertEquals(BOTS.gucchi.name, "ぐっちー");
  assertEquals(BOTS.nabe.name, "なべ");
  assertEquals(Object.keys(BOTS).length, 4);
  // 役割は UI のトグルに出るので、ぐっちーとなべの違いが分かる文言にしておく
  assertEquals(BOTS.gucchi.role, "場を温める");
  assertEquals(BOTS.nabe.role, "進行を仕切る");
  // BOT_IDS と BOTS の顔ぶれがずれていないこと
  assertEquals([...BOT_IDS].sort(), Object.keys(BOTS).sort());
});

// ---------------------------------------------------------------------------
// 仕様の数値そのものを固定する（§3.10）
//
// 他のテストは SILENCE_MS 等の定数を参照しているため、定数を変えると挙動が
// 変わってもテストは通ってしまう。仕様書の数値はここでリテラルとして押さえる。
// ---------------------------------------------------------------------------

Deno.test("§3.10 の数値が仕様どおりであること", () => {
  assertEquals(SILENCE_MS, 30_000, "沈黙検知は30秒");
  assertEquals(SILENCE_MAX_STREAK, 2, "話題カードの連続投下は2回まで");
  assertEquals(GUCCHI_RATE_MAX, 5, "ぐっちーは10分あたり5発話まで");
  assertEquals(NABE_RATE_MAX, 2, "なべは10分あたり2発話まで");
  assertEquals(BOT_RATE_WINDOW_MS, 10 * 60_000, "発話枠の窓は10分");
  assertEquals(LOBBY_SUGGEST_MS, 5 * 60_000, "ロビー5分でゲーム提案");
  assertEquals(END_POLL_MS, 60_000, "終了アンケートの集計は60秒");
  assertEquals(SENRYU_MEMORY, 5, "せりが覚えている川柳は5件");
});

// ---------------------------------------------------------------------------
// 回帰: 1巡目のレビューで見つかった不具合
// ---------------------------------------------------------------------------

Deno.test("回帰: 誰も反応しなくても永久に喋り続けない", () => {
  let state = createBotState(T0);
  const kinds: string[] = [];
  for (let i = 1; i <= 120; i++) {
    const result = reduce(state, { t: "tick" }, ctx(T0 + 60_000 * i));
    state = result.state;
    for (const utterance of result.utterances) kinds.push(utterance.kind);
  }
  assertEquals(kinds.filter((k) => k === "topic").length, SILENCE_MAX_STREAK);
  assert(
    kinds.filter((k) => k === "endPoll").length <= END_POLL_MAX,
    "アンケートが上限を超えている",
  );
  assert(kinds.length <= 12, `2時間で ${kinds.length} 発話は多すぎる`);
});

Deno.test("回帰: 全員切断中のルームでは何も喋らない", () => {
  let state = createBotState(T0);
  const spoken: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const result = reduce(
      state,
      { t: "tick" },
      ctx(T0 + SILENT_STEP * i, { connectedPlayerIds: [] }),
    );
    state = result.state;
    for (const utterance of result.utterances) spoken.push(utterance.kind);
  }
  assertEquals(spoken, []);
});

Deno.test("回帰: ゲーム中はロビー起点のゲーム提案が発火しない", () => {
  let state = reduce(createBotState(T0), { t: "phaseChanged", phase: "input" }, ctx(T0)).state;
  assertEquals(state.lobbySince, null);
  for (let i = 1; i <= 8; i++) {
    const result = reduce(state, { t: "tick" }, ctx(T0 + SILENT_STEP * i));
    state = result.state;
    assertEquals(state.lobbySince, null, "ゲーム中に lobbySince が復活している");
  }
});

Deno.test("回帰: なべ OFF でもアンケートは締切で必ず閉じる", () => {
  const { state, pollId } = advanceToPoll();
  const off = reduce(state, { t: "setBot", botId: "nabe", enabled: false }, ctx(T0)).state;
  assert(off.nabe.poll !== null);
  const voted = reduce(off, { t: "endPollVote", pollId, playerId: "p1", agree: true }, ctx(T0 + 1));
  assertEquals(voted.utterances.length, 0, "OFF のなべが喋っている");
  const startedAt = state.nabe.poll?.startedAt ?? T0;
  const closed = reduce(voted.state, { t: "tick" }, ctx(startedAt + END_POLL_MS));
  assertEquals(closed.utterances.length, 0);
  assertEquals(closed.state.nabe.poll, null, "OFF だとアンケートが閉じない");
});

Deno.test("回帰: A/B 交互のコピペ連投は弾く", () => {
  const a = "ふるいけやかわずとびこむみずのおと";
  const b = "かきくえばかねがなるなりほうりゅうじ";
  let state = createBotState(T0);
  let count = 0;
  for (let i = 0; i < 10; i++) {
    const result = reduce(
      state,
      {
        t: "message",
        playerId: "p1",
        nickname: "たろう",
        text: i % 2 === 0 ? a : b,
        source: "chat",
      },
      ctx(T0 + i * 1_000),
    );
    state = result.state;
    count += result.utterances.length;
  }
  assertEquals(count, 2, "A と B を1回ずつ拾ったあとは黙るはず");
});

// ---------------------------------------------------------------------------
// 回帰: 2巡目のレビューで見つかった不具合
// ---------------------------------------------------------------------------

Deno.test("回帰: 未投票者が一時切断しても結論を出さない（§8）", () => {
  const four = ["a", "b", "c", "d"];
  const { state, pollId } = advanceToPoll({ connectedPlayerIds: four });
  const at = (state.nabe.poll?.startedAt ?? T0) + 1_000;
  const voted = run(state, [
    {
      at,
      event: { t: "endPollVote", pollId, playerId: "a", agree: true },
      ctx: { connectedPlayerIds: four },
    },
    {
      at: at + 1,
      event: { t: "endPollVote", pollId, playerId: "b", agree: true },
      ctx: { connectedPlayerIds: four },
    },
  ]);
  assertEquals(voted.all.length, 0, "4人中2票では未決のはず");
  // 未投票の d が一時切断（60秒猶予内）→ 票も結論も動かさない
  const dropped = reduce(
    voted.state,
    { t: "playerDisconnected", playerId: "d" },
    ctx(at + 2, { connectedPlayerIds: ["a", "b", "c"] }),
  );
  assertEquals(dropped.utterances.length, 0, "一時切断だけで締めてしまっている");
  assert(dropped.state.nabe.poll !== null);
});

Deno.test("回帰: 再接続では挨拶しない", () => {
  const joined = reduce(
    createBotState(T0),
    { t: "playerJoined", playerId: "p1", nickname: "たろう" },
    ctx(T0),
  );
  assertEquals(joined.utterances.filter((u) => u.kind === "greeting").length, 1);
  // 回線が不安定で切断・再接続を繰り返しても挨拶は増えない
  let state = joined.state;
  for (let i = 1; i <= 4; i++) {
    state = reduce(state, { t: "playerDisconnected", playerId: "p1" }, ctx(T0 + i * 1_000)).state;
    const back = reduce(
      state,
      { t: "playerRejoined", playerId: "p1", nickname: "たろう" },
      ctx(T0 + i * 1_000 + 500),
    );
    state = back.state;
    assertEquals(back.utterances.length, 0, "再接続で挨拶している");
  }
});

Deno.test("回帰: 無人の部屋ではアンケートも黙って閉じる", () => {
  const { state } = advanceToPoll();
  const startedAt = state.nabe.poll?.startedAt ?? T0;
  // 集計中に全員切断 → 締切が来ても発話しない
  const closed = reduce(
    state,
    { t: "tick" },
    ctx(startedAt + END_POLL_MS, { connectedPlayerIds: [] }),
  );
  assertEquals(closed.utterances.length, 0, "無人の部屋で喋っている");
  assertEquals(closed.state.nabe.poll, null, "アンケートが閉じていない");

  // playerLeft 経路でも同じ: 全員が順に退室しても発話しない
  const emptied = run(state, [
    {
      at: startedAt + 1,
      event: { t: "playerLeft", playerId: "p1" },
      ctx: { connectedPlayerIds: ["p2", "p3"] },
    },
    {
      at: startedAt + 2,
      event: { t: "playerLeft", playerId: "p2" },
      ctx: { connectedPlayerIds: ["p3"] },
    },
    {
      at: startedAt + 3,
      event: { t: "playerLeft", playerId: "p3" },
      ctx: { connectedPlayerIds: [] },
    },
  ]);
  assertEquals(emptied.all.length, 0, "無人になった部屋で喋っている");
  assertEquals(emptied.state.nabe.poll, null, "全員退室でアンケートが閉じていない");
});

Deno.test("回帰: clamp はコードポイント単位（絵文字を割らない）", () => {
  // 20コードポイント = rooms.ts の validateNickname を通る正当なあだ名
  const nickname = "あ" + "\u{1F363}".repeat(19);
  assertEquals([...nickname].length, NICKNAME_MAX);
  const result = reduce(
    createBotState(T0),
    {
      t: "message",
      playerId: "p1",
      nickname,
      text: "ふるいけやかわずとびこむみずのおと",
      source: "chat",
    },
    ctx(T0),
  );
  assert(result.utterances[0].card?.c === "senryu");
  const author = result.utterances[0].card.author;
  assertEquals(author, nickname, "20コードポイントは切り詰めなくてよい");
  // 孤立サロゲート（絵文字が割れた跡）が残っていないこと
  assertEquals(JSON.stringify(author).includes("\\ud"), false, "孤立サロゲートが残っている");
});

Deno.test("回帰: usedTopicIds は無制限に伸びない", () => {
  let state = createBotState(T0);
  // 沈黙と会話を繰り返して話題カードを大量に消費する
  for (let i = 1; i <= 200; i++) {
    state = reduce(state, { t: "tick" }, ctx(T0 + 60_000 * i)).state;
    if (i % 4 === 0) {
      state = reduce(
        state,
        { t: "message", playerId: "p1", nickname: "たろう", text: "はい", source: "chat" },
        ctx(T0 + 60_000 * i + 1),
      ).state;
    }
  }
  assert(state.gucchi.usedTopicIds.length > 0, "話題カードを消費していない");
  assert(
    state.gucchi.usedTopicIds.length <= TOPIC_CARDS.length,
    `usedTopicIds が伸び続けている: ${state.gucchi.usedTopicIds.length}`,
  );
});

Deno.test("回帰: 投票は活動とみなして沈黙タイマーを進めない", () => {
  const { state, pollId } = advanceToPoll();
  const before = state.lastActivityAt;
  const voted = reduce(
    state,
    { t: "endPollVote", pollId, playerId: "p1", agree: false },
    ctx(before + 30_000),
  );
  assertEquals(voted.state.lastActivityAt, before + 30_000);
});

Deno.test("回帰: せりは直近5件を超えた川柳なら再び反応する", () => {
  const senryu = [
    "あいうえおかきくけこさしすせそたち",
    "かきくけこさしすせそたちつてとなに",
    "さしすせそたちつてとなにぬねのはひ",
    "たちつてとなにぬねのはひふへほまみ",
    "なにぬねのはひふへほまみむめもやゆ",
    "はひふへほまみむめもやゆよらりるれ",
  ];
  let state = createBotState(T0);
  let count = 0;
  for (const [i, text] of senryu.entries()) {
    const result = reduce(
      state,
      { t: "message", playerId: "p1", nickname: "たろう", text, source: "chat" },
      ctx(T0 + i * 1_000),
    );
    state = result.state;
    count += result.utterances.length;
  }
  assertEquals(count, senryu.length, "別々の川柳はすべて拾うはず");
  assertEquals(state.seri.recentYomi.length, SENRYU_MEMORY, "記憶は5件で頭打ち");
  // 6句を挟んだので最初の句はもう覚えていない → 再び反応する
  const again = reduce(
    state,
    { t: "message", playerId: "p1", nickname: "たろう", text: senryu[0], source: "chat" },
    ctx(T0 + 100_000),
  );
  assertEquals(again.utterances.length, 1);
});

// ---------------------------------------------------------------------------
// 通しシナリオ
// ---------------------------------------------------------------------------

Deno.test("シナリオ: 入室 → 川柳 → 沈黙2回 → ゲーム提案まで通す", () => {
  const senryu = "ふるいけやかわずとびこむみずのおと";
  const { all } = run(createBotState(T0), [
    {
      at: T0,
      event: {
        t: "playerJoined",
        playerId: "p1",
        nickname: "",
        assignedNickname: "ほろよいペンギン",
      },
    },
    {
      at: T0 + 10_000,
      event: {
        t: "message",
        playerId: "p1",
        nickname: "ほろよいペンギン",
        text: senryu,
        source: "chat",
      },
    },
    { at: T0 + 10_000 + SILENT_STEP, event: { t: "tick" } },
    { at: T0 + 10_000 + SILENT_STEP * 2, event: { t: "tick" } },
    { at: T0 + 10_000 + SILENT_STEP * 3, event: { t: "tick" } },
  ]);
  const kinds = all.map((u) => `${u.botId}:${u.kind}`);
  assertEquals(kinds, [
    "shunpi:naming",
    "gucchi:greeting",
    "seri:senryu",
    "gucchi:topic",
    "gucchi:topic",
    "nabe:gameSuggest",
  ]);
});

// ---------------------------------------------------------------------------
// 3巡目のレビューで「テストが無い」と指摘された経路
// ---------------------------------------------------------------------------

Deno.test("gameAction: 沈黙タイマーをリセットする", () => {
  let state = createBotState(T0);
  state = reduce(state, { t: "tick" }, ctx(T0 + SILENCE_MS)).state;
  assertEquals(state.gucchi.silenceStreak, 1);
  const at = T0 + SILENCE_MS + 10_000;
  const acted = reduce(state, { t: "gameAction" }, ctx(at));
  assertEquals(acted.state.gucchi.silenceStreak, 0);
  assertEquals(acted.state.lastActivityAt, at);
  // 直後は沈黙判定にならない
  assertEquals(reduce(acted.state, { t: "tick" }, ctx(at + SILENCE_MS - 1)).utterances, []);
});

Deno.test("finalResult: 最終結果には専用の文面で反応する", () => {
  const result = reduce(
    createBotState(T0),
    { t: "finalResult", topNickname: "たろう" },
    ctx(T0 + 1_000),
  );
  assertEquals(result.utterances.length, 1);
  assertEquals(result.utterances[0].kind, "finalReaction");
  const text = result.utterances[0].text;
  assert(
    FINAL_REACTION_TEXTS.some((t) => t.replace("{name}", "たろう") === text),
    `最終結果の文面ではない: ${text}`,
  );
  assert(
    !ROUND_REACTION_TEXTS.some((t) => t.replace("{name}", "たろう") === text),
    "ラウンド結果の文面が使われている",
  );
});

Deno.test("roundResult: ラウンド結果は専用の文面を使う", () => {
  const result = reduce(
    createBotState(T0),
    { t: "roundResult", topNickname: "たろう" },
    ctx(T0 + 1_000),
  );
  const text = result.utterances[0].text;
  assert(
    ROUND_REACTION_TEXTS.some((t) => t.replace("{name}", "たろう") === text),
    `ラウンド結果の文面ではない: ${text}`,
  );
});

Deno.test("phaseChanged: lobby に戻るとロビータイマーが再開する", () => {
  const playing = reduce(createBotState(T0), { t: "phaseChanged", phase: "input" }, ctx(T0)).state;
  assertEquals(playing.lobbySince, null);
  const back = reduce(playing, { t: "phaseChanged", phase: "lobby" }, ctx(T0 + 60_000)).state;
  assertEquals(back.lobbySince, T0 + 60_000, "ロビーに戻ってもタイマーが動かない");
});

Deno.test("せり: 長すぎる句は QUOTE_LINE_MAX で切り詰める", () => {
  // 区切り記号は 0 モーラなので、句のなかに詰めると表層形だけ伸ばせる
  const padded = "あ" + "・".repeat(25) + "いうえ かきくけこさし たちつてと";
  const result = reduce(
    createBotState(T0),
    { t: "message", playerId: "p1", nickname: "たろう", text: padded, source: "chat" },
    ctx(T0),
  );
  if (result.utterances.length === 0) return; // 長すぎる句を弾いた場合はそれでよい
  assert(result.utterances[0].card?.c === "senryu");
  for (const line of result.utterances[0].card.lines) {
    assert(
      [...line].length <= QUOTE_LINE_MAX,
      `句が上限を超えている: ${[...line].length}字`,
    );
  }
});

Deno.test("clamp: 上限を超えるあだ名は省略記号込みで上限内に収める", () => {
  const long = "な".repeat(40);
  const result = reduce(
    createBotState(T0),
    {
      t: "message",
      playerId: "p1",
      nickname: long,
      text: "ふるいけやかわずとびこむみずのおと",
      source: "chat",
    },
    ctx(T0),
  );
  assert(result.utterances[0].card?.c === "senryu");
  const author = result.utterances[0].card.author;
  assertEquals([...author].length, NICKNAME_MAX, "省略記号を含めて上限ちょうどに収める");
  assert(author.endsWith("…"), "切り詰めたのに省略記号がない");
});

Deno.test("なべ: 偶数人数の同数タイは「続行」にする", () => {
  const four = ["p1", "p2", "p3", "p4"];
  const { state, pollId } = advanceToPoll({ connectedPlayerIds: four });
  const at = (state.nabe.poll?.startedAt ?? T0) + 1_000;
  // 4人中2人賛成・2人反対 = 同数。過半数ではないので続行
  const result = run(state, [
    {
      at,
      event: { t: "endPollVote", pollId, playerId: "p1", agree: true },
      ctx: { connectedPlayerIds: four },
    },
    {
      at: at + 1,
      event: { t: "endPollVote", pollId, playerId: "p2", agree: true },
      ctx: { connectedPlayerIds: four },
    },
    {
      at: at + 2,
      event: { t: "endPollVote", pollId, playerId: "p3", agree: false },
      ctx: { connectedPlayerIds: four },
    },
    {
      at: at + 3,
      event: { t: "endPollVote", pollId, playerId: "p4", agree: false },
      ctx: { connectedPlayerIds: four },
    },
  ]);
  assertEquals(result.all.length, 1);
  assertEquals(result.all[0].kind, "pollContinue", "同数タイでお開きにしている");
});

Deno.test("なべ: 発話枠を使い切っていても締めの一言は必ず出す", () => {
  const { state, pollId } = advanceToPoll();
  // 枠を使い切った状態にする
  const startedAt = state.nabe.poll?.startedAt ?? T0;
  const full: BotState = {
    ...state,
    nabe: {
      ...state.nabe,
      utteranceTimes: Array.from({ length: NABE_RATE_MAX }, () => startedAt),
    },
  };
  const closed = run(full, [
    { at: startedAt + 1, event: { t: "endPollVote", pollId, playerId: "p1", agree: true } },
    { at: startedAt + 2, event: { t: "endPollVote", pollId, playerId: "p2", agree: true } },
  ]);
  assertEquals(closed.all.length, 1, "枠切れでアンケートが結果不明のまま放置されている");
  assertEquals(closed.all[0].kind, "closing");
  assertEquals(closed.state.nabe.poll, null);
});

Deno.test("せり: 字余りと字足らずで呼び名を出し分ける", () => {
  // 6-7-5 = 字余り（合計18）
  const over = reduce(
    createBotState(T0),
    {
      t: "message",
      playerId: "p1",
      nickname: "た",
      text: "あいうえおかきくけこさしすせそたちつて",
      source: "chat",
    },
    ctx(T0),
  );
  assert(over.utterances[0]?.card?.c === "senryu");
  assertEquals(over.utterances[0].card.exact, false);
  assert(
    over.utterances[0].text.includes("字余り") || over.utterances[0].text.includes("字足らず"),
    `呼び名が入っていない: ${over.utterances[0].text}`,
  );
});

// ---------------------------------------------------------------------------
// 回帰: 実運用シミュレーションで見つかった体験上の問題
// ---------------------------------------------------------------------------

Deno.test("回帰: 始まったばかりの部屋でお開きを切り出さない", () => {
  // 話題2回＋ゲーム提案は15分弱で走り切るが、そこでお開きを提案されると
  // 「ちょっと席を外しただけ」で追い出された感じになる
  let state = createBotState(T0);
  let askedEarly = 0;
  for (let i = 1; i <= 30; i++) {
    const result = reduce(state, { t: "tick" }, ctx(T0 + 60_000 * i));
    state = result.state;
    askedEarly += result.utterances.filter((u) => u.kind === "endPoll").length;
  }
  assertEquals(askedEarly, 0, `開始30分でお開きを提案している`);
  // 十分に時間が経てば提案する
  let later = 0;
  for (let i = 31; i <= 90; i++) {
    const result = reduce(state, { t: "tick" }, ctx(T0 + 60_000 * i));
    state = result.state;
    later += result.utterances.filter((u) => u.kind === "endPoll").length;
  }
  assertEquals(later, 1, "時間が経ってもお開きを切り出さない");
});

Deno.test("回帰: OFF 中でも過半数の賛成を握りつぶさない", () => {
  const { state, pollId } = advanceToPoll();
  const voted =
    reduce(state, { t: "endPollVote", pollId, playerId: "p1", agree: true }, ctx(T0 + 1)).state;
  const off = reduce(voted, { t: "setBot", botId: "nabe", enabled: false }, ctx(T0 + 2)).state;
  // 2/3 が賛成 = 過半数。発話はしないが結果は正しく伝える
  const closed = reduce(
    off,
    { t: "endPollVote", pollId, playerId: "p2", agree: true },
    ctx(T0 + 3),
  );
  assertEquals(closed.utterances.length, 0, "OFF なのに喋っている");
  assertEquals(closed.effects, [{ t: "pollClosed", pollId, agreed: true }]);
});

Deno.test("回帰: 遊び終えても直前のゲームはすぐ再提案しない", () => {
  let state = createBotState(T0);
  for (let i = 1; i <= 8; i++) {
    state = reduce(state, { t: "tick" }, ctx(T0 + SILENT_STEP * i)).state;
  }
  const last = state.nabe.suggestedGameIds.at(-1);
  assert(last !== undefined);
  state = reduce(state, { t: "phaseChanged", phase: "input" }, ctx(T0 + 60 * 60_000)).state;
  state = reduce(state, { t: "phaseChanged", phase: "lobby" }, ctx(T0 + 70 * 60_000)).state;
  assertEquals(state.nabe.suggestedGameIds, [last], "直前のゲームが候補に戻っている");
});

Deno.test("回帰: 誰も反応しない部屋ではなべがゲーム提案を蒸し返さない", () => {
  // 提案の候補は時間が経てば戻るが、反応がないまま繰り返すのは §3.10 に反する
  let state = createBotState(T0);
  let suggests = 0;
  for (let i = 1; i <= 240; i++) {
    const result = reduce(state, { t: "tick" }, ctx(T0 + 60_000 * i));
    state = result.state;
    suggests += result.utterances.filter((u) => u.kind === "gameSuggest").length;
  }
  assertEquals(suggests, 3, `4時間の完全沈黙で ${suggests} 回提案している`);
});

Deno.test("回帰: 人が反応していればゲーム提案の候補は戻る", () => {
  let state = createBotState(T0);
  // 3本出し切る
  for (let i = 1; i <= 8; i++) {
    state = reduce(state, { t: "tick" }, ctx(T0 + SILENT_STEP * i)).state;
  }
  assertEquals(state.nabe.suggestedGameIds.length, 3);
  // 誰かが喋る
  const at = T0 + 40 * 60_000;
  state = reduce(
    state,
    { t: "message", playerId: "p1", nickname: "たろう", text: "はーい", source: "chat" },
    ctx(at),
  ).state;
  // 間が空けばまた誘える
  let revived = 0;
  for (let i = 1; i <= 30; i++) {
    const result = reduce(state, { t: "tick" }, ctx(at + 60_000 * i));
    state = result.state;
    revived += result.utterances.filter((u) => u.kind === "gameSuggest").length;
  }
  assert(revived > 0, "反応があっても誘い直さない");
});

// ---------------------------------------------------------------------------
// ぐっちー / なべの分割（中間レビューの「ぐっちー過労問題」）
//
// 分割前は10種類の発話のうち6種類がぐっちー1体に集まっていて、10分5発話の
// 枠を役割どうしで食い合っていた。ここで守るのは「枠と ON/OFF が bot ごとに
// 独立していること」で、これが崩れると過労問題がそのまま再発する。
// ---------------------------------------------------------------------------

Deno.test("分割: ぐっちーが枠を使い切ってもなべはゲーム提案と終了アンケートを出せる", () => {
  const base = createBotState(T0);
  // ぐっちーが10分枠を使い切り、話題カードも打ち止め（＝場を温める手が尽きた）状態
  const exhausted: BotState = {
    ...base,
    gucchi: {
      ...base.gucchi,
      utteranceTimes: Array.from({ length: GUCCHI_RATE_MAX }, () => T0),
      silenceStreak: SILENCE_MAX_STREAK,
    },
  };
  const at = T0 + SILENCE_MS;
  // 前提: このときぐっちーは枠切れで挨拶すらできない
  const greeted = reduce(
    exhausted,
    { t: "playerJoined", playerId: "p9", nickname: "ゲスト" },
    ctx(at),
  );
  assertEquals(
    greeted.utterances.filter((u) => u.botId === "gucchi").length,
    0,
    "前提が崩れている: ぐっちーの枠が空いている",
  );

  // 本題1: それでもなべはゲームに誘える
  const suggest = reduce(exhausted, { t: "tick" }, ctx(at));
  assertEquals(suggest.utterances.length, 1, "ぐっちーの枠切れがなべを巻き添えにしている");
  assertEquals(suggest.utterances[0].botId, "nabe");
  assertEquals(suggest.utterances[0].kind, "gameSuggest");

  // 本題2: ゲームも出し切ったあと、お開きも切り出せる
  const pollAt = T0 + END_POLL_MIN_AGE_MS;
  const stuck: BotState = {
    ...exhausted,
    // 判定時刻でもぐっちーの枠が埋まっているようにする
    gucchi: {
      ...exhausted.gucchi,
      utteranceTimes: Array.from({ length: GUCCHI_RATE_MAX }, () => pollAt - 1_000),
    },
    nabe: {
      ...exhausted.nabe,
      suggestedGameIds: ["official-ogiri", "official-ishindenshin", "official-quiz"],
      lastGameSuggestAt: T0,
    },
  };
  const poll = reduce(stuck, { t: "tick" }, ctx(pollAt));
  assertEquals(poll.utterances.length, 1, "ぐっちーの枠切れでアンケートまで止まっている");
  assertEquals(poll.utterances[0].botId, "nabe");
  assertEquals(poll.utterances[0].kind, "endPoll");
  assertEquals(poll.effects.length, 1);
});

Deno.test("分割: なべが枠を使い切ってもぐっちーは挨拶できる", () => {
  const base = createBotState(T0);
  const nabeFull: BotState = {
    ...base,
    nabe: {
      ...base.nabe,
      utteranceTimes: Array.from({ length: NABE_RATE_MAX }, () => T0),
    },
    // ゲーム提案の条件（話題カード打ち止め＋沈黙）を満たしておく
    gucchi: { ...base.gucchi, silenceStreak: SILENCE_MAX_STREAK },
  };
  // 前提: なべは枠切れでゲーム提案が出ない
  const blocked = reduce(nabeFull, { t: "tick" }, ctx(T0 + SILENCE_MS));
  assertEquals(blocked.utterances.length, 0, "前提が崩れている: なべの枠が空いている");

  // 本題: ぐっちーの挨拶は影響を受けない
  const joined = reduce(
    nabeFull,
    { t: "playerJoined", playerId: "p1", nickname: "ゲスト" },
    ctx(T0 + SILENCE_MS),
  );
  const greeting = joined.utterances.filter((u) => u.kind === "greeting");
  assertEquals(greeting.length, 1, "なべの枠切れでぐっちーが黙っている");
  assertEquals(greeting[0].botId, "gucchi");
});

Deno.test("分割: なべだけ OFF にするとぐっちーは喋り続けるが進行の発話は止まる", () => {
  const off = reduce(
    createBotState(T0),
    { t: "setBot", botId: "nabe", enabled: false },
    ctx(T0),
  ).state;
  assertEquals(off.enabled, { shunpi: true, seri: true, gucchi: true, nabe: false });

  // ぐっちーの挨拶は出る
  const joined = reduce(
    off,
    { t: "playerJoined", playerId: "p1", nickname: "ゲスト" },
    ctx(T0 + 1),
  );
  assertEquals(joined.utterances.filter((u) => u.kind === "greeting").length, 1);

  // 2時間ぶん回しても、なべの発話だけが出ない
  let state = off;
  const kinds: string[] = [];
  for (let i = 1; i <= 120; i++) {
    const result = reduce(state, { t: "tick" }, ctx(T0 + 60_000 * i));
    state = result.state;
    for (const utterance of result.utterances) kinds.push(utterance.kind);
  }
  assertEquals(
    kinds.filter((k) => k === "topic").length,
    SILENCE_MAX_STREAK,
    "なべを切るとぐっちーまで黙っている",
  );
  assertEquals(kinds.filter((k) => k === "gameSuggest").length, 0, "OFF のなべが誘っている");
  assertEquals(kinds.filter((k) => k === "endPoll").length, 0, "OFF のなべが訊いている");
});

Deno.test("分割: なべ OFF でも集計中アンケートは発話なしで必ず片付く", () => {
  const { state, pollId } = advanceToPoll();
  const startedAt = state.nabe.poll?.startedAt ?? T0;
  const off = reduce(
    state,
    { t: "setBot", botId: "nabe", enabled: false },
    ctx(startedAt + 1),
  ).state;
  assert(off.nabe.poll !== null, "前提: 集計中のアンケートがある");

  const closed = reduce(off, { t: "tick" }, ctx(startedAt + END_POLL_MS));
  assertEquals(closed.utterances, [], "OFF のなべが喋っている");
  assertEquals(closed.state.nabe.poll, null, "アンケートが開いたまま残っている");
  // 発話しなくても、ルーム層への通知は必ず出す（締切のないアンケートを表示させない）
  assertEquals(closed.effects, [{ t: "pollClosed", pollId, agreed: false }]);
});

Deno.test("分割: ぐっちー OFF でもロビー起点のゲーム提案は出る", () => {
  const off = reduce(
    createBotState(T0),
    { t: "setBot", botId: "gucchi", enabled: false },
    ctx(T0),
  ).state;
  // ロビーが静かなまま5分経てば、ぐっちー抜きでもなべがゲームに誘う
  const quiet = reduce(off, { t: "gameAction" }, ctx(T0 + LOBBY_SUGGEST_MS - LOBBY_QUIET_MS)).state;
  const result = reduce(quiet, { t: "tick" }, ctx(T0 + LOBBY_SUGGEST_MS));
  assertEquals(result.utterances.length, 1, "ぐっちーを切るとなべまで黙っている");
  assertEquals(result.utterances[0].botId, "nabe");
  assertEquals(result.utterances[0].kind, "gameSuggest");
});

Deno.test("分割: ぐっちー OFF でも沈黙起点でゲーム提案と終了アンケートが出る", () => {
  // ぐっちーが OFF だと話題カードが出ないので silenceStreak が増えない。
  // 「話題カードを出し切ったか」だけを見ていると、なべが永久に動けなくなる
  const off = reduce(
    createBotState(T0),
    { t: "setBot", botId: "gucchi", enabled: false },
    ctx(T0),
  ).state;

  // 沈黙3分で、話題カードを飛ばしていきなりゲームに誘う
  const suggest = reduce(off, { t: "tick" }, ctx(T0 + SILENCE_MS));
  assertEquals(suggest.utterances.length, 1, "ぐっちー OFF でなべまで止まっている");
  assertEquals(suggest.utterances[0].botId, "nabe");
  assertEquals(suggest.utterances[0].kind, "gameSuggest");

  // 時間が経てばお開きも切り出す（ゲーム提案だけ出てアンケートが出ない、を防ぐ）
  let state = off;
  const kinds: string[] = [];
  for (let i = 1; i <= 120; i++) {
    const result = reduce(state, { t: "tick" }, ctx(T0 + 60_000 * i));
    state = result.state;
    for (const utterance of result.utterances) {
      assertEquals(utterance.botId, "nabe", "OFF のぐっちーが喋っている");
      kinds.push(utterance.kind);
    }
  }
  assertEquals(kinds.filter((k) => k === "topic").length, 0, "OFF のぐっちーが話題を投げている");
  assert(kinds.includes("gameSuggest"), "ぐっちー OFF だとゲームに誘えない");
  assert(kinds.includes("endPoll"), "ぐっちー OFF だとお開きを切り出せない");
});

Deno.test("回帰: ぐっちー OFF の部屋でもなべは喋りすぎない", () => {
  // 話題カードの打ち止めを待たずに動き出すぶん、なべが饒舌になっていないか。
  // 抑えているのは3重（なべの枠 / 収録ゲームの本数 / アンケートの回数と間隔）
  const off = reduce(
    createBotState(T0),
    { t: "setBot", botId: "gucchi", enabled: false },
    ctx(T0),
  ).state;
  let state = off;
  const spokenAt: number[] = [];
  const kinds: string[] = [];
  for (let i = 1; i <= 120; i++) {
    const at = T0 + 60_000 * i;
    const result = reduce(state, { t: "tick" }, ctx(at));
    state = result.state;
    for (const utterance of result.utterances) {
      spokenAt.push(at);
      kinds.push(utterance.kind);
    }
  }
  // 1) なべ自身の枠。closePoll だけは枠を見ずに必ず発話するので1件の超過を許す
  for (const start of spokenAt) {
    const inWindow = spokenAt.filter((at) => at >= start && at - start < BOT_RATE_WINDOW_MS);
    assert(inWindow.length <= NABE_RATE_MAX + 1, `なべの10分窓に ${inWindow.length} 発話`);
  }
  // 2) ゲーム提案は収録本数どまり（反応のない部屋では蒸し返さない）
  assertEquals(
    kinds.filter((k) => k === "gameSuggest").length,
    3,
    "3分沈黙ごとにゲーム提案が湧いている",
  );
  // 3) 終了アンケートは上限まで
  assert(
    kinds.filter((k) => k === "endPoll").length <= END_POLL_MAX,
    "アンケートが上限を超えている",
  );
  // ぐっちー ON の部屋（「誰も反応しなくても永久に喋り続けない」）と同じ水準に収める
  assert(kinds.length <= 12, `2時間で ${kinds.length} 発話は多すぎる`);
});

Deno.test("分割: 発話の種類ごとに担当 bot が正しい", () => {
  /** 発話の種類 → 担当 bot。この表が分割の結果そのもの */
  const owner: Readonly<Record<string, BotId>> = {
    naming: "shunpi",
    senryu: "seri",
    greeting: "gucchi",
    topic: "gucchi",
    reaction: "gucchi",
    finalReaction: "gucchi",
    gameSuggest: "nabe",
    endPoll: "nabe",
    closing: "nabe",
    pollContinue: "nabe",
  };
  const seen = new Set<string>();
  const check = (utterances: BotResult["utterances"]) => {
    for (const utterance of utterances) {
      assertEquals(utterance.botId, owner[utterance.kind], `${utterance.kind} の担当が違う`);
      seen.add(utterance.kind);
    }
  };

  // 入室（naming / greeting）・川柳（senryu）・結果（reaction / finalReaction）
  check(
    run(createBotState(T0), [
      {
        at: T0,
        event: {
          t: "playerJoined",
          playerId: "p1",
          nickname: "",
          assignedNickname: "ほろよいペンギン",
        },
      },
      {
        at: T0 + 1_000,
        event: {
          t: "message",
          playerId: "p1",
          nickname: "たろう",
          text: "ふるいけやかわずとびこむみずのおと",
          source: "chat",
        },
      },
      { at: T0 + 2_000, event: { t: "roundResult", topNickname: "たろう" } },
      { at: T0 + 3_000, event: { t: "finalResult", topNickname: "たろう" } },
    ]).all,
  );

  // 沈黙（topic / gameSuggest / endPoll / pollContinue）
  let state = createBotState(T0);
  for (let i = 1; i <= 60; i++) {
    const result = reduce(state, { t: "tick" }, ctx(T0 + 60_000 * i));
    state = result.state;
    check(result.utterances);
  }

  // 過半数賛成での締め（closing）
  const agreed = advanceToPoll();
  const at = (agreed.state.nabe.poll?.startedAt ?? T0) + 1_000;
  check(
    run(agreed.state, [
      { at, event: { t: "endPollVote", pollId: agreed.pollId, playerId: "p1", agree: true } },
      {
        at: at + 1,
        event: { t: "endPollVote", pollId: agreed.pollId, playerId: "p2", agree: true },
      },
    ]).all,
  );

  const missing = Object.keys(owner).filter((kind) => !seen.has(kind));
  assertEquals(missing, [], `検証できていない発話の種類がある: ${missing.join(", ")}`);
});
