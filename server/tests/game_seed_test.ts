/**
 * ゲーム開始時の乱数の種（設計書 §2.5）が **推測不能である**ことのテスト。
 *
 * かつて種は `FNV-1a(roomCode + ":" + startedAt)` だった。ルームコードは全参加者が知っており、
 * 開始時刻も最初の `gameView` の `deadline`（wordwolf なら `deadline - 120000`）や
 * クライアント専用ゲームの `startedAt` から分かるので、改造クライアントは
 * 議論が始まる前に狼・お題・クイズの正解を算出できた。
 * ここでは「公開値からは種が求まらない」ことと、「テストからは決定的な種を注入できる」ことの
 * 両方を、RoomManager 越し（＝実際に配信される値だけ）で確かめる。
 *
 * 種を観測する経路にクライアント専用ゲーム（reflex）を使うのは、この経路だけが
 * 種を view に載せるためで、これは仕様どおり（サーバーが秘密を持たない経路。games/client.ts）。
 * 秘密を持つモジュール（wordwolf ほか）は種を view に出さないので、
 * そちらの決定性は「配られたお題」を突き合わせて確かめる。
 */

import { assert, assertEquals, assertExists, assertNotEquals } from "@std/assert";
import { type ClientLink, RoomManager, type RoomManagerOptions } from "../rooms.ts";
import type { S2C } from "../types.ts";
import type { ClientGameView } from "../games/client.ts";
import type { WordWolfView } from "../games/wordwolf.ts";

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

function last<T extends S2C["t"]>(link: MockLink, t: T): Extract<S2C, { t: T }> | undefined {
  for (let i = link.received.length - 1; i >= 0; i--) {
    if (link.received[i].t === t) return link.received[i] as Extract<S2C, { t: T }>;
  }
  return undefined;
}

/** 攻撃者の再現式。削除した旧 gameSeed と同じ計算をテスト側に持っておく */
function legacyGameSeed(roomCode: string, startedAt: number): number {
  let h = 0x811c9dc5;
  const source = `${roomCode}:${startedAt}`;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 時刻を止めた時計。開始時刻まで同じでも種が変わることを見るために使う */
const T0 = 1_700_000_000_000;
function frozenClock(): RoomManagerOptions {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  return {
    now: () => T0,
    setTimer: (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id as unknown as ReturnType<NonNullable<RoomManagerOptions["setTimer"]>>;
    },
    clearTimer: (handle) => {
      timers.delete(handle as unknown as number);
    },
  };
}

/** ホスト＋客1人で reflex（クライアント専用ゲーム）を始めた卓を作る */
function reflexRoom(options: RoomManagerOptions) {
  const manager = new RoomManager(options);
  const host = new MockLink();
  manager.handle(host, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  const created = last(host, "roomState");
  assertExists(created);
  const code = created.snapshot.code;
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: code, nickname: "きゃく" });
  const joined = last(guest, "roomState");
  assertExists(joined);
  manager.handle(host, { t: "selectGame", gameId: "reflex" });
  manager.handle(host, { t: "startGame" });
  return { manager, host, guest, code, guestId: joined.snapshot.youId };
}

/** 直近の gameView を ClientGameView として読む */
function clientView(link: MockLink): ClientGameView {
  const msg = last(link, "gameView");
  assertExists(msg, "gameView が届いていない");
  assertEquals(msg.gameId, "reflex");
  return msg.view as ClientGameView;
}

// ---------------------------------------------------------------------------
// 1. 推測不能であること
// ---------------------------------------------------------------------------

Deno.test("seed: 同じ卓・同じ開始時刻でも、ゲームを始めるたびに種が変わる", () => {
  // 時計を止めているので、旧実装なら roomCode も startedAt も同じ＝毎回まったく同じ種になった
  const room = reflexRoom(frozenClock());
  const seeds: number[] = [clientView(room.host).seed];

  let guestId = room.guestId;
  for (let i = 0; i < 4; i++) {
    // 2人を割ると reflex は終了し、卓はロビーへ戻る（選択中のゲームはそのまま）
    room.manager.handle(room.host, { t: "kick", playerId: guestId });
    const guest = new MockLink();
    room.manager.handle(guest, { t: "join", roomCode: room.code, nickname: `きゃく${i}` });
    const joined = last(guest, "roomState");
    assertExists(joined);
    guestId = joined.snapshot.youId;
    room.manager.handle(room.host, { t: "startGame" });
    seeds.push(clientView(room.host).seed);
  }

  assertEquals(seeds.length, 5);
  assertEquals(new Set(seeds).size, seeds.length, `種が重複した: ${seeds.join(", ")}`);
  room.manager.dispose();
});

Deno.test("seed: 配信済みの roomCode と startedAt からは種を再現できない（旧 FNV-1a の式）", () => {
  // 5卓ぶん試す。1件でも一致したら「公開値から逆算できる」ということ
  for (let i = 0; i < 5; i++) {
    const room = reflexRoom(frozenClock());
    const view = clientView(room.host);
    // 攻撃者が知っている値（どちらも実際に全員へ配信されている）
    assertEquals(view.startedAt, T0, "startedAt は view に載っている＝攻撃者に既知");
    assertNotEquals(
      view.seed,
      legacyGameSeed(room.code, view.startedAt),
      "公開値だけから種が求まってしまっている",
    );
    room.manager.dispose();
  }
});

Deno.test("seed: 32bit 符号なし整数の範囲に収まる（PRNG が期待する形）", () => {
  for (let i = 0; i < 20; i++) {
    const room = reflexRoom(frozenClock());
    const seed = clientView(room.host).seed;
    assert(Number.isInteger(seed), `整数でない: ${seed}`);
    assert(seed >= 0 && seed <= 0xffff_ffff, `範囲外: ${seed}`);
    room.manager.dispose();
  }
});

// ---------------------------------------------------------------------------
// 2. テストからは決定的な種を注入できること
// ---------------------------------------------------------------------------

Deno.test("seed: options.gameSeed で固定した種がそのままモジュールへ渡る", () => {
  const room = reflexRoom({ ...frozenClock(), gameSeed: () => 20260826 });
  assertEquals(clientView(room.host).seed, 20260826);
  assertEquals(clientView(room.guest).seed, 20260826, "卓の全員に同じ種が届く");
  room.manager.dispose();
});

Deno.test("seed: 同じ卓で始め直しても、注入した種なら毎回同じになる（再現性の担保）", () => {
  const room = reflexRoom({ ...frozenClock(), gameSeed: () => 4242 });
  assertEquals(clientView(room.host).seed, 4242);
  room.manager.handle(room.host, { t: "kick", playerId: room.guestId });
  const guest = new MockLink();
  room.manager.handle(guest, { t: "join", roomCode: room.code, nickname: "きゃく2" });
  room.manager.handle(room.host, { t: "startGame" });
  assertEquals(clientView(room.host).seed, 4242);
  room.manager.dispose();
});

/** ホスト＋客2人でワードウルフを議論フェーズまで進め、席順のお題を返す */
function wordWolfWords(options: RoomManagerOptions): Array<string | null> {
  const manager = new RoomManager(options);
  const links = [new MockLink(), new MockLink(), new MockLink()];
  manager.handle(links[0], { t: "createRoom", nickname: "ホスト", visibility: "private" });
  const created = last(links[0], "roomState");
  assertExists(created);
  for (let i = 1; i < links.length; i++) {
    manager.handle(links[i], { t: "join", roomCode: created.snapshot.code, nickname: `客${i}` });
  }
  manager.handle(links[0], { t: "selectGame", gameId: "wordwolf" });
  manager.handle(links[0], { t: "startGame" });
  manager.handle(links[0], { t: "skipPhase" }); // config → discuss
  const words = links.map((link) => {
    const msg = last(link, "gameView");
    assertExists(msg, "gameView が届いていない");
    assertEquals(msg.gameId, "wordwolf");
    return (msg.view as WordWolfView).myWord;
  });
  manager.dispose();
  return words;
}

Deno.test("seed: 同じ種を注入すれば、ワードウルフのお題の配り方まで再現できる", () => {
  const a = wordWolfWords({ ...frozenClock(), gameSeed: () => 20260826 });
  const b = wordWolfWords({ ...frozenClock(), gameSeed: () => 20260826 });
  assertEquals(a, b, "同じ種なのに配られたお題が違う（決定的でない）");
  assertEquals(a.filter((w) => typeof w === "string" && w.length > 0).length, 3);
  assertEquals(new Set(a).size, 2, "お題が2種類になっていない");
});

Deno.test("seed: 種を注入せずにワードウルフを始めると、狼とお題が毎回同じにはならない", () => {
  // 時計を止めた同条件で20回。旧実装は roomCode しか変わらないハッシュだったが、
  // ここで見たいのは「開始のたびに独立に引き直している」こと
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    seen.add(JSON.stringify(wordWolfWords(frozenClock())));
  }
  assert(seen.size > 1, `20回とも同じ配り方だった（乱数が効いていない）: ${[...seen][0]}`);
});
