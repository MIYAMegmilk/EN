/**
 * 卓上の趣味タグ（§3.11 用途1・用途4）のテスト。
 *
 * 「人となりが少し見える」ためのタグなので、価値があるのは**卓に着いた瞬間**に
 * 相手の名前の横に出ていること。保存（PUT /api/profile）までは auth_test.ts が
 * 見ているので、ここは持ち込み（join / createRoom / joinQueue）から
 * 配信（roomState / playerJoined）までの経路と、その入力検証に絞る。
 *
 * 併せて、ぐっちーの話題カードが共通タグで選ばれること（用途4）も見る。
 * ここが効くかどうかは rooms.ts が bot に何を渡すかで決まるので、
 * bot 側の単体テスト（bot_test.ts）では拾えない。
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { type ClientLink, RoomManager } from "../rooms.ts";
import { SILENCE_MS } from "../bot.ts";
import {
  NAMING_TEXTS,
  NICKNAME_ADJECTIVES,
  NICKNAME_NOUNS,
  TAG_NICKNAME_WORDS,
} from "../bot_templates.ts";
import { HOBBY_TAGS_MAX, type HobbyTagId } from "../hobby_tags.ts";
import { MATCH_INTERVAL_MS } from "../types.ts";
import type { S2C } from "../types.ts";

const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// テスト用の時計・接続（rooms_bot_test.ts と同じ方式）
// ---------------------------------------------------------------------------

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
}

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

function last<T extends S2C["t"]>(link: MockLink, t: T): Extract<S2C, { t: T }> | undefined {
  for (let i = link.received.length - 1; i >= 0; i--) {
    const msg = link.received[i];
    if (msg.t === t) return msg as Extract<S2C, { t: T }>;
  }
  return undefined;
}

/** rng を固定して、話題カードの選択まで決定的にする（先頭が選ばれる） */
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

/** 招待制ルームを建てる。tags は建てた本人の趣味タグ */
function createRoom(manager: RoomManager, nickname = "ホスト", tags?: HobbyTagId[]) {
  const link = new MockLink();
  manager.handle(link, {
    t: "createRoom",
    nickname,
    visibility: "private",
    ...(tags === undefined ? {} : { tags }),
  });
  const state = last(link, "roomState");
  assertExists(state);
  return { link, code: state.snapshot.code, snapshot: state.snapshot };
}

/** 既存の卓へ、趣味タグを持って入る */
function join(manager: RoomManager, code: string, nickname: string, tags?: HobbyTagId[]) {
  const link = new MockLink();
  manager.handle(link, {
    t: "join",
    roomCode: code,
    nickname,
    ...(tags === undefined ? {} : { tags }),
  });
  return link;
}

/** スナップショットから、あだ名で参加者を引く */
function playerOf(link: MockLink, nickname: string) {
  const state = last(link, "roomState");
  assertExists(state);
  return state.snapshot.players.find((p) => p.nickname === nickname);
}

/** bot の発言だけを取り出す */
function botChats(link: MockLink): Extract<S2C, { t: "chat" }>["message"][] {
  return link.received
    .filter((m): m is Extract<S2C, { t: "chat" }> => m.t === "chat")
    .map((m) => m.message)
    .filter((m) => m.bot);
}

// ---------------------------------------------------------------------------
// 用途1: 卓上での表示
// ---------------------------------------------------------------------------

Deno.test("趣味タグ: 入室時に持ち込んだタグが、同席者の参加者一覧に載る（§3.11 用途1）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = join(manager, host.code, "ゲスト", ["game", "alcohol"]);

  // 本人のスナップショット
  assertEquals(playerOf(guest, "ゲスト")?.tags, ["game", "alcohol"]);
  // 先に居た人へは playerJoined で届く。ここが欠けると「後から来た人のタグだけ出ない」
  const joined = last(host.link, "playerJoined");
  assertExists(joined);
  assertEquals(joined.player.tags, ["game", "alcohol"]);
  manager.dispose();
});

Deno.test("趣味タグ: 卓を建てた本人のタグも配られる（§3.11 用途1）", () => {
  const { manager } = setup();
  const host = createRoom(manager, "ホスト", ["cooking"]);
  assertEquals(playerOf(host.link, "ホスト")?.tags, ["cooking"]);
  manager.dispose();
});

Deno.test("趣味タグ: 選んでいない人には tags を付けない（キーごと省く）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = join(manager, host.code, "ゲスト");

  assertEquals(playerOf(host.link, "ホスト")?.tags, undefined);
  assertEquals(playerOf(guest, "ゲスト")?.tags, undefined);
  manager.dispose();
});

Deno.test("趣味タグ: プリセットにない ID を送ってきた人は入室させない（自由入力を塞ぐ）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  // プリセット外の ID は型では作れないので、ここだけ型を外して手打ちの入力を再現する
  const guest = join(manager, host.code, "ゲスト", ["<script>"] as unknown as HobbyTagId[]);

  const error = last(guest, "error");
  assertExists(error);
  assertEquals(error.code, "INVALID_INPUT");
  // 入室そのものが起きていないこと（タグだけ黙って捨てて通さない）
  assertEquals(last(guest, "roomState"), undefined);
  assertEquals(last(host.link, "playerJoined"), undefined);
  manager.dispose();
});

Deno.test("趣味タグ: 上限を超える指定は弾き、重複は畳む", () => {
  const { manager } = setup();
  const host = createRoom(manager);

  const tooMany: HobbyTagId[] = ["game", "anime", "manga", "music", "movie", "sports"];
  assertEquals(tooMany.length, HOBBY_TAGS_MAX + 1);
  const greedy = join(manager, host.code, "欲張り", tooMany);
  assertEquals(last(greedy, "error")?.code, "INVALID_INPUT");
  assertEquals(last(greedy, "roomState"), undefined);

  // 重複は「上限超え」ではなく、畳んで受理する（同じタグを2回選べる UI ではないが、
  // 手で送られても素直に1つとして扱う）
  const twice = join(manager, host.code, "ふたつ", ["game", "game"]);
  assertEquals(playerOf(twice, "ふたつ")?.tags, ["game"]);
  manager.dispose();
});

Deno.test("趣味タグ: 卓を建てるときの不正なタグも弾く（卓ごと作らせない）", () => {
  const { manager } = setup();
  const link = new MockLink();
  manager.handle(link, {
    t: "createRoom",
    nickname: "ホスト",
    visibility: "private",
    tags: ["nope"] as unknown as HobbyTagId[],
  });
  assertEquals(last(link, "error")?.code, "INVALID_INPUT");
  assertEquals(last(link, "roomState"), undefined);
  manager.dispose();
});

Deno.test("趣味タグ: 再接続では卓が覚えているタグをそのまま使う（§3.2）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = join(manager, host.code, "ゲスト", ["game"]);
  const state = last(guest, "roomState");
  assertExists(state);
  const session = state.snapshot.session;
  assertExists(session);

  manager.disconnect(guest);
  const again = new MockLink();
  // 復帰時に別のタグを送ってきても、卓の中の顔ぶれは動かさない
  manager.handle(again, { t: "join", roomCode: host.code, session, tags: ["anime"] });
  assertEquals(playerOf(again, "ゲスト")?.tags, ["game"]);
  manager.dispose();
});

Deno.test("趣味タグ: 相席（ランダムマッチ）でも成立した卓へ持ち込まれる（§3.1.2）", () => {
  const { clock, manager } = setup();
  const a = new MockLink();
  const b = new MockLink();
  manager.handle(a, { t: "joinQueue", nickname: "あ", tags: ["travel"] });
  manager.handle(b, { t: "joinQueue", nickname: "い", tags: ["travel", "pet"] });

  clock.advance(MATCH_INTERVAL_MS);

  assertExists(last(a, "matched"));
  assertEquals(playerOf(a, "あ")?.tags, ["travel"]);
  assertEquals(playerOf(a, "い")?.tags, ["travel", "pet"]);
  manager.dispose();
});

Deno.test("趣味タグ: 相席の待機列でも不正なタグは弾く（並ばせない）", () => {
  const { manager } = setup();
  const link = new MockLink();
  manager.handle(link, {
    t: "joinQueue",
    nickname: "あ",
    tags: ["nope"] as unknown as HobbyTagId[],
  });

  assertEquals(last(link, "error")?.code, "INVALID_INPUT");
  // 列に並べていないので、抜ける通知（queueStatus）も来ない
  assertEquals(last(link, "queueStatus"), undefined);
  manager.dispose();
});

// ---------------------------------------------------------------------------
// 用途1の派生: あだ名の連想元（§3.10 しゅんぴ × §3.11）
//
// タグから連想したあだ名が付くこと自体は bot_test.ts が見ている。ここで見るのは
// 「本人のタグが しゅんぴ まで届いているか」という配線で、rooms.ts が
// あだ名を決めるより先にタグを検証していないと成立しない。
// ---------------------------------------------------------------------------

/** あだ名を省いて入る。しゅんぴが二つ名を付ける経路 */
function joinAnonymously(manager: RoomManager, code: string, tags?: HobbyTagId[]) {
  const link = new MockLink();
  manager.handle(link, {
    t: "join",
    roomCode: code,
    ...(tags === undefined ? {} : { tags }),
  });
  return link;
}

/** 卓にいる「ホスト以外の1人」のあだ名。しゅんぴが付けた名前を取り出す */
function assignedName(link: MockLink): string {
  const state = last(link, "roomState");
  assertExists(state);
  const guest = state.snapshot.players.find((p) => p.nickname !== "ホスト");
  assertExists(guest);
  return guest.nickname;
}

/** 形容 × 名詞の総当たり */
function combos(adjectives: readonly string[], nouns: readonly string[]): string[] {
  return adjectives.flatMap((a) => nouns.map((n) => `${a}${n}`));
}

Deno.test("趣味タグ: あだ名を省いた人には、タグから連想した二つ名が付く（§3.11 用途1）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = joinAnonymously(manager, host.code, ["reading"]);

  const words = TAG_NICKNAME_WORDS.reading;
  const name = assignedName(guest);
  assert(
    combos(words.adjectives, words.nouns).includes(name),
    `読書から連想した名前になっていない: ${name}`,
  );
  // しゅんぴが由来を明かす。あだ名が偶然でないと場に伝わらないと話題のフックにならない
  const naming = botChats(guest).find((m) => m.botKind === "naming");
  assertExists(naming);
  assert(naming.text.includes(name), naming.text);
  assert(naming.text.includes("読書"), naming.text);
  manager.dispose();
});

Deno.test("趣味タグ: タグを選ばなかった人には従来どおり汎用の二つ名が付く", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = joinAnonymously(manager, host.code);

  const name = assignedName(guest);
  assert(
    combos(NICKNAME_ADJECTIVES, NICKNAME_NOUNS).includes(name),
    `汎用プールの名前になっていない: ${name}`,
  );
  const naming = botChats(guest).find((m) => m.botKind === "naming");
  assertExists(naming);
  // 由来にするタグが無いので、タグ入りの文面は使わない
  assert(NAMING_TEXTS.some((t) => t.replace("{name}", name) === naming.text), naming.text);
  manager.dispose();
});

Deno.test("趣味タグ: 先客と同じタグを持つ人は、被っていない側のタグから名付ける", () => {
  const { manager } = setup();
  const host = createRoom(manager, "ホスト", ["reading"]);
  const guest = joinAnonymously(manager, host.code, ["reading", "camping"]);

  const camping = TAG_NICKNAME_WORDS.camping;
  const name = assignedName(guest);
  assert(
    combos(camping.adjectives, camping.nouns).includes(name),
    `キャンプから連想した名前になっていない: ${name}`,
  );
  manager.dispose();
});

Deno.test("趣味タグ: あだ名もタグも不正なときは、タグの検証で弾く", () => {
  // あだ名を決める材料にタグを使う都合で、検証の順序をタグ → あだ名に入れ替えた。
  // どちらも INVALID_INPUT なので、通してしまわないことだけ担保しておく
  const { manager } = setup();
  const host = createRoom(manager);
  const link = new MockLink();
  manager.handle(link, {
    t: "join",
    roomCode: host.code,
    nickname: "",
    tags: ["nope"] as unknown as HobbyTagId[],
  });

  assertEquals(last(link, "error")?.code, "INVALID_INPUT");
  assertEquals(last(link, "roomState"), undefined);
  manager.dispose();
});

// ---------------------------------------------------------------------------
// 用途4: bot の話題振り
// ---------------------------------------------------------------------------

Deno.test("趣味タグ: 2人が同じタグを持つと、ぐっちーがその話題カードを選ぶ（§3.11 用途4）", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager, "ホスト", ["game"]);
  join(manager, host.code, "ゲスト", ["game"]);

  clock.advance(SILENCE_MS + 60_000);

  const topic = botChats(host.link).find((m) => m.botKind === "topic");
  assertExists(topic);
  assertEquals(topic.text, "最近遊んで良かったゲームは？");
  manager.dispose();
});

Deno.test("趣味タグ: 誰とも重ならないタグは共通タグにしない（汎用カードに戻る）", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager, "ホスト", ["game"]);
  join(manager, host.code, "ゲスト", ["anime"]);

  clock.advance(SILENCE_MS + 60_000);

  const topic = botChats(host.link).find((m) => m.botKind === "topic");
  assertExists(topic);
  // rng を固定してあるので、タグで絞られなければ話題カードの先頭が出る
  assertEquals(topic.text, "最近いちばん笑ったことって何ですか？");
  manager.dispose();
});

Deno.test("趣味タグ: 一人の卓では、その人のタグをそのまま話題に使う", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager, "ホスト", ["game"]);

  clock.advance(SILENCE_MS + 60_000);

  const topic = botChats(host.link).find((m) => m.botKind === "topic");
  assertExists(topic);
  assertEquals(topic.text, "最近遊んで良かったゲームは？");
  manager.dispose();
});

Deno.test("趣味タグ: 切断中の人のタグは共通タグに数えない", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager, "ホスト", ["game"]);
  const a = join(manager, host.code, "あ", ["anime"]);
  const b = join(manager, host.code, "い", ["anime"]);

  // 3人揃っているあいだは、2人が持つ anime が共通タグになる
  clock.advance(SILENCE_MS + 60_000);
  const first = botChats(host.link).filter((m) => m.botKind === "topic");
  assertEquals(first.at(-1)?.text, "いま追いかけてるアニメってあります？");

  // anime の2人が落ちると、卓に残っているのは game のホストだけ。
  // 切断中の人を数え続けていれば、ここでも anime のカードが出てしまう
  manager.disconnect(a);
  manager.disconnect(b);
  clock.advance(SILENCE_MS + 60_000);
  const second = botChats(host.link).filter((m) => m.botKind === "topic");
  assert(second.length > first.length, "2枚目の話題カードが出ていること");
  assertEquals(second.at(-1)?.text, "最近遊んで良かったゲームは？");
  manager.dispose();
});
