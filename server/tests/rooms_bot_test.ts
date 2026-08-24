/**
 * rooms.ts ⇄ bot.ts の配線テスト（§3.10）
 *
 * bot の判断ロジックそのものは bot_test.ts が見ている。ここで確かめるのは
 * 「ルームの出来事が BotEvent に変換され、発話がチャットとして配信されるか」
 * だけに絞る。時刻・タイマー・乱数はすべて差し替えて決定的にする。
 */

import { assert, assertEquals, assertExists, assertFalse } from "@std/assert";
import { type ClientLink, RoomManager } from "../rooms.ts";
import { BOTS, SILENCE_MS } from "../bot.ts";
import type { S2C } from "../types.ts";

const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// テスト用の時計・接続
// ---------------------------------------------------------------------------

/** 手動で進められる時計。rooms_test.ts と同じ方式 */
class FakeClock {
  now = T0;
  private seq = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  setTimer = (fn: () => void, ms: number): number => {
    const id = this.seq++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimer = (handle: number): void => {
    this.timers.delete(handle);
  };

  /** 指定ミリ秒だけ進め、期限の来たタイマーを順に発火する */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let pickId = -1;
      let pickAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < pickAt) {
          pickAt = timer.at;
          pickId = id;
        }
      }
      if (pickId < 0) break;
      const timer = this.timers.get(pickId);
      if (timer === undefined) break;
      this.timers.delete(pickId);
      this.now = Math.max(this.now, timer.at);
      timer.fn();
    }
    this.now = target;
  }

  get pending(): number {
    return this.timers.size;
  }
}

/** 受信内容を貯めるだけの接続 */
class MockLink implements ClientLink {
  readonly id = crypto.randomUUID();
  readonly received: S2C[] = [];
  closed = false;

  constructor(readonly userId: string | null = "testUser") {}

  send(msg: S2C): void {
    this.received.push(msg);
  }

  close(): void {
    this.closed = true;
  }
}

/** bot の発言だけを取り出す */
function botChats(link: MockLink): Extract<S2C, { t: "chat" }>["message"][] {
  return link.received
    .filter((m): m is Extract<S2C, { t: "chat" }> => m.t === "chat")
    .map((m) => m.message)
    .filter((m) => m.bot);
}

/** 直近に受け取った指定種別のメッセージ */
function last<T extends S2C["t"]>(link: MockLink, t: T): Extract<S2C, { t: T }> | undefined {
  for (let i = link.received.length - 1; i >= 0; i--) {
    const msg = link.received[i];
    if (msg.t === t) return msg as Extract<S2C, { t: T }>;
  }
  return undefined;
}

/**
 * テスト環境。rng は常に 0 を返すので、定型文はどの配列も先頭が選ばれる。
 * これで発話内容まで固定して比較できる。
 */
function setup() {
  const clock = new FakeClock();
  const manager = new RoomManager({
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    rng: () => 0,
  });
  return { clock, manager };
}

/** ルームを作り、ホストの接続とルームコードを返す */
function createRoom(manager: RoomManager, nickname = "ホスト") {
  const link = new MockLink();
  manager.handle(link, { t: "createRoom", nickname, visibility: "private" });
  const state = last(link, "roomState");
  assertExists(state);
  return { link, code: state.snapshot.code, snapshot: state.snapshot };
}

// ---------------------------------------------------------------------------
// 入室
// ---------------------------------------------------------------------------

Deno.test("配線: 入室するとぐっちーが挨拶し、bot の識別子が付いて届く（§3.10）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: host.code, nickname: "ゲスト" });

  const greeting = botChats(host.link).find((m) => m.botKind === "greeting");
  assertExists(greeting);
  assertEquals(greeting.bot, true);
  assertEquals(greeting.playerId, null);
  assertEquals(greeting.botId, "gucchi");
  assertEquals(greeting.nickname, BOTS.gucchi.name);
  assertEquals(greeting.text, "ゲストさん、いらっしゃい。まずは一杯どうぞ");
  manager.dispose();
});

Deno.test("配線: 挨拶は入室者本人にも届く（スナップショットの後に配信する）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: host.code, nickname: "ゲスト" });

  // 本人のスナップショットには自分への挨拶がまだ載っていない
  const snapshot = last(guest, "roomState");
  assertExists(snapshot);
  assertFalse(snapshot.snapshot.chat.some((m) => m.botKind === "greeting"));
  // が、直後の chat で本人にも届く
  assertExists(botChats(guest).find((m) => m.botKind === "greeting"));
  manager.dispose();
});

Deno.test("配線: あだ名を省略するとしゅんぴが二つ名を付ける（§3.0 / §3.10）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: host.code });

  const snapshot = last(guest, "roomState");
  assertExists(snapshot);
  const me = snapshot.snapshot.players.find((p) => p.id === snapshot.snapshot.youId);
  assertExists(me);
  assert(me.nickname.length > 0);

  const naming = botChats(host.link).find((m) => m.botKind === "naming");
  assertExists(naming);
  assertEquals(naming.botId, "shunpi");
  assert(naming.text.includes(me.nickname), `命名の告知にあだ名が入ること: ${naming.text}`);
  manager.dispose();
});

Deno.test("配線: 空のあだ名は従来どおりエラー（省略と区別する）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: host.code, nickname: "   " });

  assertEquals(last(guest, "error")?.code, "INVALID_INPUT");
  assertEquals(last(guest, "roomState"), undefined);
  manager.dispose();
});

Deno.test("配線: 再接続では挨拶しない（§3.2）", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: host.code, nickname: "ゲスト" });
  const session = last(guest, "roomState")?.snapshot.session;
  assertExists(session);

  const before = botChats(host.link).filter((m) => m.botKind === "greeting").length;
  manager.disconnect(guest);
  clock.advance(1_000);
  const back = new MockLink();
  manager.handle(back, { t: "join", roomCode: host.code, nickname: "ゲスト", session });

  assertEquals(botChats(host.link).filter((m) => m.botKind === "greeting").length, before);
  manager.dispose();
});

// ---------------------------------------------------------------------------
// せり（川柳）
// ---------------------------------------------------------------------------

Deno.test("配線: かなの 5-7-5 を投稿するとせりが反応し、テロップ用の card が付く", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "chat", text: "ふるいけやかわずとびこむみずのおと" });

  const senryu = botChats(host.link).find((m) => m.botKind === "senryu");
  assertExists(senryu);
  assertEquals(senryu.botId, "seri");
  assertExists(senryu.card);
  assert(senryu.card.c === "senryu");
  assertEquals(senryu.card.morae, [5, 7, 5]);
  assertEquals(senryu.card.exact, true);
  assertEquals(senryu.card.author, "ホスト");
  manager.dispose();
});

Deno.test("配線: 川柳でない発言にせりは反応しない", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "chat", text: "おつかれさま" });

  assertEquals(botChats(host.link).filter((m) => m.botKind === "senryu").length, 0);
  manager.dispose();
});

Deno.test("配線: せりの発言は人の発言より後に配信される", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "chat", text: "ふるいけやかわずとびこむみずのおと" });

  const chats = host.link.received.filter((m): m is Extract<S2C, { t: "chat" }> => m.t === "chat");
  const human = chats.findIndex((m) => !m.message.bot);
  const bot = chats.findIndex((m) => m.message.botKind === "senryu");
  assert(human >= 0 && bot > human, "人の発言のあとに川柳返しが来ること");
  manager.dispose();
});

// ---------------------------------------------------------------------------
// 沈黙検知
// ---------------------------------------------------------------------------

Deno.test("配線: 沈黙が続くと tick で話題カードが投下される（§3.10）", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  assertEquals(botChats(host.link).filter((m) => m.botKind === "topic").length, 0);

  clock.advance(SILENCE_MS + 60_000);

  const topic = botChats(host.link).find((m) => m.botKind === "topic");
  assertExists(topic);
  assertEquals(topic.botId, "gucchi");
  manager.dispose();
});

Deno.test("配線: 全員切断中の部屋では話題カードを投げない（§3.10）", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: host.code, nickname: "ゲスト" });
  manager.disconnect(host.link);
  manager.disconnect(guest);

  const before = botChats(guest).length;
  clock.advance(SILENCE_MS + 60_000);
  assertEquals(botChats(guest).length, before);
  manager.dispose();
});

// ---------------------------------------------------------------------------
// ON/OFF
// ---------------------------------------------------------------------------

Deno.test("配線: ホストが bot を OFF にすると botState が配信され、以後は喋らない", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "setBot", enabled: false });

  const state = last(host.link, "botState");
  assertExists(state);
  assertEquals(state.bots, { shunpi: false, seri: false, gucchi: false });

  const before = botChats(host.link).length;
  manager.handle(host.link, { t: "chat", text: "ふるいけやかわずとびこむみずのおと" });
  clock.advance(SILENCE_MS + 60_000);
  assertEquals(botChats(host.link).length, before);
  manager.dispose();
});

Deno.test("配線: botId を指定すると1体だけ切り替わる", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "setBot", botId: "seri", enabled: false });

  assertEquals(last(host.link, "botState")?.bots, {
    shunpi: true,
    seri: false,
    gucchi: true,
  });
  // せりは黙るが、ぐっちーの挨拶は出る
  manager.handle(host.link, { t: "chat", text: "ふるいけやかわずとびこむみずのおと" });
  assertEquals(botChats(host.link).filter((m) => m.botKind === "senryu").length, 0);
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: host.code, nickname: "ゲスト" });
  assertExists(botChats(host.link).find((m) => m.botKind === "greeting"));
  manager.dispose();
});

Deno.test("配線: 非ホストの setBot は NOT_HOST で拒否される", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: host.code, nickname: "ゲスト" });
  manager.handle(guest, { t: "setBot", enabled: false });

  assertEquals(last(guest, "error")?.code, "NOT_HOST");
  assertEquals(last(guest, "botState"), undefined);
  manager.dispose();
});

Deno.test("配線: 知らない botId は INVALID_INPUT", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, {
    t: "setBot",
    botId: "unknown" as unknown as "seri",
    enabled: false,
  });

  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  manager.dispose();
});

// ---------------------------------------------------------------------------
// スナップショット・後始末
// ---------------------------------------------------------------------------

Deno.test("配線: スナップショットに bot の ON/OFF が入る", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  assertEquals(host.snapshot.bots, { shunpi: true, seri: true, gucchi: true });
  assertEquals(host.snapshot.botPoll, undefined);
  manager.dispose();
});

Deno.test("配線: 集計中でないアンケートへの投票は PHASE_MISMATCH", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "endPollVote", pollId: "nope", agree: true });

  assertEquals(last(host.link, "error")?.code, "PHASE_MISMATCH");
  manager.dispose();
});

Deno.test("配線: 投票の形式が不正なら INVALID_INPUT", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, {
    t: "endPollVote",
    pollId: 1 as unknown as string,
    agree: true,
  });

  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  manager.dispose();
});

Deno.test("配線: ルームが消えると bot の tick タイマーも残らない", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  assert(clock.pending > 0, "tick タイマーが張られていること");

  manager.handle(host.link, { t: "leave" });
  assertEquals(manager.roomCount, 0);
  assertEquals(clock.pending, 0);
  manager.dispose();
});

Deno.test("配線: 終了アンケートは過半数の賛成で締切前に締まり、botPollClosed が届く", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: host.code, nickname: "ゲスト" });

  // 沈黙が続くと「話題カード → ゲーム提案 → 終了アンケート」の順に手を出す（§3.10）。
  // 最初のアンケートが出た時点で止める（放っておくと締切で勝手に閉じる）
  let poll: ReturnType<typeof botChats>[number] | undefined;
  for (let i = 0; i < 120 && poll === undefined; i++) {
    clock.advance(60_000);
    poll = botChats(host.link).find((m) => m.card?.c === "endPoll");
  }
  assertExists(poll, "沈黙を続ければ終了アンケートまで到達すること");
  assert(poll.card?.c === "endPoll");
  const pollId = poll.card.pollId;
  assertEquals(poll.botId, "gucchi");

  // 集計中は再接続者のスナップショットにも載る
  const late = new MockLink();
  manager.handle(late, { t: "join", roomCode: host.code, nickname: "あとから" });
  assertEquals(last(late, "roomState")?.snapshot.botPoll?.pollId, pollId);

  manager.handle(host.link, { t: "endPollVote", pollId, agree: true });
  manager.handle(guest, { t: "endPollVote", pollId, agree: true });

  const closed = last(host.link, "botPollClosed");
  assertExists(closed);
  assertEquals(closed.pollId, pollId);
  assertEquals(closed.agreed, true);
  assertExists(botChats(host.link).find((m) => m.botKind === "closing"));
  // 締まったので締切タイマーも残らない
  assertEquals(last(host.link, "roomState")?.snapshot.botPoll, undefined);
  manager.dispose();
});

Deno.test("配線: 締め切ったアンケートへの遅れた投票は PHASE_MISMATCH", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: host.code, nickname: "ゲスト" });

  let poll: ReturnType<typeof botChats>[number] | undefined;
  for (let i = 0; i < 120 && poll === undefined; i++) {
    clock.advance(60_000);
    poll = botChats(host.link).find((m) => m.card?.c === "endPoll");
  }
  assertExists(poll);
  assert(poll.card?.c === "endPoll");
  const pollId = poll.card.pollId;

  manager.handle(host.link, { t: "endPollVote", pollId, agree: true });
  manager.handle(guest, { t: "endPollVote", pollId, agree: true });
  manager.handle(guest, { t: "endPollVote", pollId, agree: false });

  assertEquals(last(guest, "error")?.code, "PHASE_MISMATCH");
  manager.dispose();
});
