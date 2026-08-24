/**
 * rooms.ts のユニットテスト
 * 詳細仕様書 §3.1 / §3.2 / §3.9 / §8 の挙動を検証する。
 * 時刻とタイマーは差し替え可能なため、待機せずに猶予超過を再現できる。
 */

import { assert, assertEquals, assertExists, assertFalse } from "@std/assert";
import {
  type ClientLink,
  NON_VOTE_JUDGE_SEC,
  normalizeRoomCode,
  NOT_IMPLEMENTED_MESSAGE,
  phaseDurationsFor,
  RoomManager,
  validateChatText,
  validateNickname,
  validateRoomDescription,
  validateRoomName,
  VOICE_RATE_MAX,
  VOICE_RATE_WINDOW_MS,
} from "../rooms.ts";
import { DEFAULT_PHASE_DURATIONS } from "../engine.ts";
import type { S2C } from "../types.ts";
import {
  CHAT_HISTORY_MAX,
  CHAT_RATE_MAX,
  CHAT_RATE_WINDOW_MS,
  CHAT_TEXT_MAX,
  DISCONNECT_GRACE_MS,
  ROOM_CAPACITY,
  ROOM_NAME_MAX,
  SANDBOX_PAYLOAD_MAX_BYTES,
  VC_CAPACITY,
} from "../types.ts";

const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// テスト用の時計・タイマー・接続
// ---------------------------------------------------------------------------

/** 手動で進められる時計。setTimeout の代わりに使う */
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

  /** 残っているタイマーの数 */
  get pending(): number {
    return this.timers.size;
  }
}

/** 受信内容を貯めるだけの接続。デフォルトはログイン済み扱い（未ログインのテストは明示的に null を渡す） */
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

/** 直近に受け取った指定種別のメッセージ */
function last<T extends S2C["t"]>(link: MockLink, t: T): Extract<S2C, { t: T }> | undefined {
  for (let i = link.received.length - 1; i >= 0; i--) {
    const msg = link.received[i];
    if (msg.t === t) return msg as Extract<S2C, { t: T }>;
  }
  return undefined;
}

/** 指定種別のメッセージをすべて取り出す */
function all<T extends S2C["t"]>(link: MockLink, t: T): Extract<S2C, { t: T }>[] {
  return link.received.filter((m) => m.t === t) as Extract<S2C, { t: T }>[];
}

/** bot の発言（§3.10）を除いた chat。人の発言だけを数えたいときに使う */
function humanChats(link: MockLink): Extract<S2C, { t: "chat" }>[] {
  return all(link, "chat").filter((m) => !m.message.bot);
}

/** テスト用の環境を作る。sandboxGameIds を渡すとサンドボックスの開始を許可する gameId を指定できる */
function setup(options: { sandboxGameIds?: ReadonlySet<string> } = {}) {
  const clock = new FakeClock();
  const manager = new RoomManager({
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sandboxGameIds: options.sandboxGameIds,
  });
  return { clock, manager };
}

/** ルームを作り、ホストの接続とスナップショットを返す */
function createRoom(manager: RoomManager, nickname = "ホスト") {
  const link = new MockLink();
  manager.handle(link, { t: "createRoom", nickname, visibility: "private" });
  const state = last(link, "roomState");
  assertExists(state);
  return { link, snapshot: state.snapshot };
}

/** 公開ルームを作り、ホストの接続とスナップショットを返す */
function createPublicRoom(manager: RoomManager, roomName: string, nickname = "ホスト") {
  const link = new MockLink();
  manager.handle(link, { t: "createRoom", nickname, visibility: "public", roomName });
  const state = last(link, "roomState");
  assertExists(state);
  return { link, snapshot: state.snapshot };
}

/** 既存ルームに参加させる */
function joinRoom(manager: RoomManager, code: string, nickname: string) {
  const link = new MockLink();
  manager.handle(link, { t: "join", roomCode: code, nickname });
  return { link, state: last(link, "roomState") };
}

// ---------------------------------------------------------------------------
// 入力検証
// ---------------------------------------------------------------------------

Deno.test("ニックネーム検証: 前後の空白を除去して受理する", () => {
  const res = validateNickname("  たろう  ");
  assert(res.ok);
  assertEquals(res.value, "たろう");
});

Deno.test("ニックネーム検証: 空・21文字以上・制御文字を拒否する", () => {
  assertFalse(validateNickname("   ").ok);
  assertFalse(validateNickname("あ".repeat(21)).ok);
  assertFalse(validateNickname("たろう").ok);
  assertFalse(validateNickname("た\nろう").ok);
  assertFalse(validateNickname(123).ok);
  assert(validateNickname("あ".repeat(20)).ok);
});

Deno.test("チャット検証: 前後の空白を除去して受理する", () => {
  const res = validateChatText("  こんばんは  ");
  assert(res.ok);
  assertEquals(res.value, "こんばんは");
});

Deno.test("チャット検証: 200文字ちょうどは受理し、201文字は拒否する", () => {
  assert(validateChatText("あ".repeat(CHAT_TEXT_MAX)).ok);
  assertFalse(validateChatText("あ".repeat(CHAT_TEXT_MAX + 1)).ok);
});

Deno.test("チャット検証: 空・空白のみ・文字列以外を拒否する", () => {
  assertFalse(validateChatText("").ok);
  assertFalse(validateChatText("   ").ok);
  assertFalse(validateChatText(123).ok);
  assertFalse(validateChatText(undefined).ok);
});

Deno.test("チャット検証: 制御文字（改行・タブ・NUL 等）を拒否する", () => {
  assertFalse(validateChatText("こん\nばんは").ok);
  assertFalse(validateChatText("こん\tばんは").ok);
  assertFalse(validateChatText("こん\u0000ばんは").ok);
  assertFalse(validateChatText("こん\u007fばんは").ok);
});

Deno.test("ルームコード正規化: 6桁の数字のみ受理する", () => {
  assertEquals(normalizeRoomCode(" 012345 "), "012345");
  assertEquals(normalizeRoomCode("12345"), null);
  assertEquals(normalizeRoomCode("12345a"), null);
  assertEquals(normalizeRoomCode(123456), null);
});

Deno.test("フェーズ秒数: vote 以外は judge を短くする", () => {
  assertEquals(phaseDurationsFor("vote"), DEFAULT_PHASE_DURATIONS);
  assertEquals(phaseDurationsFor("correct").judgeSec, NON_VOTE_JUDGE_SEC);
  assertEquals(phaseDurationsFor("match").judgeSec, NON_VOTE_JUDGE_SEC);
  assertEquals(phaseDurationsFor("correct").introSec, DEFAULT_PHASE_DURATIONS.introSec);
});

// ---------------------------------------------------------------------------
// ルーム作成・参加
// ---------------------------------------------------------------------------

Deno.test("ルーム作成: 作成者がホストとして入室し、6桁コードが採番される", () => {
  const { manager } = setup();
  const { snapshot } = createRoom(manager);
  assertEquals(snapshot.code.length, 6);
  assert(/^[0-9]{6}$/.test(snapshot.code));
  assertEquals(snapshot.visibility, "private");
  assertEquals(snapshot.players.length, 1);
  assertEquals(snapshot.youAreHost, true);
  assertEquals(snapshot.hostId, snapshot.youId);
  assertEquals(snapshot.phase, "lobby");
  assertEquals(snapshot.availableGames.length, 3);
  assertExists(snapshot.session);
  assertEquals(manager.roomCount, 1);
  manager.dispose();
});

Deno.test("ルーム作成: 公開ルームはルーム名付きで作成できる（§3.1）", () => {
  const { manager } = setup();
  const link = new MockLink();
  manager.handle(link, {
    t: "createRoom",
    nickname: "ホスト",
    visibility: "public",
    roomName: "  金曜の反省会  ",
  });
  const state = last(link, "roomState");
  assertExists(state);
  assertEquals(state.snapshot.visibility, "public");
  // 前後の空白は落として保存する
  assertEquals(state.snapshot.roomName, "金曜の反省会");
  assertEquals(manager.roomCount, 1);
  manager.dispose();
});

Deno.test("ルーム作成: 公開ルームにルーム名が無ければ INVALID_INPUT（§3.1）", () => {
  const { manager } = setup();
  const link = new MockLink();
  manager.handle(link, { t: "createRoom", nickname: "ホスト", visibility: "public" });
  assertEquals(last(link, "error")?.code, "INVALID_INPUT");
  assertEquals(manager.roomCount, 0);
  manager.dispose();
});

Deno.test("ルーム作成: ルーム名が20文字を超えたら INVALID_INPUT（§3.1）", () => {
  const { manager } = setup();
  const link = new MockLink();
  manager.handle(link, {
    t: "createRoom",
    nickname: "ホスト",
    visibility: "public",
    roomName: "あ".repeat(ROOM_NAME_MAX + 1),
  });
  assertEquals(last(link, "error")?.code, "INVALID_INPUT");
  assertEquals(manager.roomCount, 0);
  manager.dispose();
});

Deno.test("ルーム作成: 未知の公開設定は INVALID_INPUT", () => {
  const { manager } = setup();
  const link = new MockLink();
  manager.handle(link, {
    t: "createRoom",
    nickname: "ホスト",
    visibility: "secret" as "public",
    roomName: "卓",
  });
  assertEquals(last(link, "error")?.code, "INVALID_INPUT");
  assertEquals(manager.roomCount, 0);
  manager.dispose();
});

Deno.test("ルーム名検証: 前後の空白を除去して受理する", () => {
  const res = validateRoomName("  金曜の反省会  ");
  assert(res.ok);
  assertEquals(res.value, "金曜の反省会");
});

Deno.test("ルーム名検証: 空・制御文字・文字列以外は拒否する（§3.8）", () => {
  assertFalse(validateRoomName("金曜の\u0007反省会").ok);
  assertFalse(validateRoomName("   ").ok);
  assertFalse(validateRoomName(42).ok);
});

// ---------------------------------------------------------------------------
// 公開ルーム一覧（§2 / §4.0 GET /api/rooms）
// ---------------------------------------------------------------------------

Deno.test("公開ルーム一覧: 公開ルームだけを返し、招待制は載せない（§3.1）", () => {
  const { manager } = setup();
  createRoom(manager); // 招待制
  createPublicRoom(manager, "とりあえず生");
  const list = manager.listPublicRooms();
  assertEquals(list.length, 1);
  assertEquals(list[0].roomName, "とりあえず生");
  assertEquals(list[0].playerCount, 1);
  assertEquals(list[0].capacity, ROOM_CAPACITY);
  assertEquals(list[0].playing, false);
  assertEquals(list[0].gameTitle, undefined);
  manager.dispose();
});

Deno.test("公開ルーム一覧: 新しく立った卓が先頭に来る", () => {
  const { clock, manager } = setup();
  createPublicRoom(manager, "先に立った卓");
  clock.advance(1000);
  createPublicRoom(manager, "あとに立った卓");
  const list = manager.listPublicRooms();
  assertEquals(list.map((r) => r.roomName), ["あとに立った卓", "先に立った卓"]);
  manager.dispose();
});

Deno.test("公開ルーム一覧: 在室人数と選択中のゲームを反映する", () => {
  const { manager } = setup();
  const host = createPublicRoom(manager, "深夜のラーメン談議");
  joinRoom(manager, host.snapshot.code, "ゆい");
  manager.handle(host.link, { t: "selectGame", gameId: host.snapshot.availableGames[0].id });
  const list = manager.listPublicRooms();
  assertEquals(list[0].playerCount, 2);
  assertEquals(list[0].gameTitle, host.snapshot.availableGames[0].title);
  assertEquals(list[0].playing, false);
  manager.dispose();
});

Deno.test("公開ルーム一覧: 一覧に回答・チャット・あだ名は含めない（§3.2 原則3）", () => {
  const { manager } = setup();
  const host = createPublicRoom(manager, "無言で呑む卓");
  joinRoom(manager, host.snapshot.code, "ないしょのあだ名");
  const serialized = JSON.stringify(manager.listPublicRooms());
  assertFalse(serialized.includes("ないしょのあだ名"));
  assertFalse(serialized.includes("ホスト"));
  manager.dispose();
});

Deno.test("参加: 公開ルームはコードだけで入室できる（オープン入室 §3.1）", () => {
  const { manager } = setup();
  const host = createPublicRoom(manager, "はじめてのホッピー");
  const guest = joinRoom(manager, host.snapshot.code, "ゆい");
  assertExists(guest.state);
  assertEquals(guest.state.snapshot.visibility, "public");
  assertEquals(guest.state.snapshot.roomName, "はじめてのホッピー");
  assertEquals(guest.state.snapshot.players.length, 2);
  manager.dispose();
});

Deno.test("参加: 公開ルームも満員なら ROOM_FULL（§3.1）", () => {
  const { manager } = setup();
  const host = createPublicRoom(manager, "満席の卓");
  for (let i = 1; i < ROOM_CAPACITY; i++) {
    joinRoom(manager, host.snapshot.code, `客${i}`);
  }
  const overflow = joinRoom(manager, host.snapshot.code, "あふれた人");
  assertEquals(last(overflow.link, "error")?.code, "ROOM_FULL");
  manager.dispose();
});

Deno.test("ルーム作成: 未ログインは AUTH_REQUIRED", () => {
  const { manager } = setup();
  const link = new MockLink(null);
  manager.handle(link, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  assertEquals(last(link, "error")?.code, "AUTH_REQUIRED");
  assertEquals(manager.roomCount, 0);
  manager.dispose();
});

Deno.test("ルーム作成: 作成者の userId が ownerUserId に記録される", () => {
  const { manager } = setup();
  const link = new MockLink("owner1");
  manager.handle(link, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  const state = last(link, "roomState");
  assertExists(state);
  const room = manager.getRoom(state.snapshot.code);
  assertExists(room);
  assertEquals(room.ownerUserId, "owner1");
  assertEquals(room.players.get(room.hostId)?.userId, "owner1");
  manager.dispose();
});

Deno.test("ルーム作成: ニックネームが不正なら INVALID_INPUT", () => {
  const { manager } = setup();
  const link = new MockLink();
  manager.handle(link, { t: "createRoom", nickname: "", visibility: "private" });
  assertEquals(last(link, "error")?.code, "INVALID_INPUT");
  assertEquals(manager.roomCount, 0);
  manager.dispose();
});

Deno.test("参加: 招待制ルームにコードとニックネームで入室できる", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  assertEquals(guest.state.snapshot.players.length, 2);
  assertEquals(guest.state.snapshot.youAreHost, false);
  // ホストには playerJoined が届く
  const joined = last(host.link, "playerJoined");
  assertExists(joined);
  assertEquals(joined.player.nickname, "ゲスト");
  manager.dispose();
});

Deno.test("参加: 存在しないコードは ROOM_NOT_FOUND", () => {
  const { manager } = setup();
  createRoom(manager);
  const link = new MockLink();
  manager.handle(link, { t: "join", roomCode: "999999", nickname: "ゲスト" });
  assertEquals(last(link, "error")?.code, "ROOM_NOT_FOUND");
  manager.handle(link, { t: "join", roomCode: "abc", nickname: "ゲスト" });
  assertEquals(last(link, "error")?.code, "ROOM_NOT_FOUND");
  manager.dispose();
});

Deno.test("参加: 定員10人を超えると ROOM_FULL", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  for (let i = 2; i <= ROOM_CAPACITY; i++) {
    const guest = joinRoom(manager, host.snapshot.code, `ゲスト${i}`);
    assertExists(guest.state);
  }
  const over = joinRoom(manager, host.snapshot.code, "あふれた人");
  assertEquals(over.state, undefined);
  assertEquals(last(over.link, "error")?.code, "ROOM_FULL");
  assertEquals(manager.getRoom(host.snapshot.code)?.players.size, ROOM_CAPACITY);
  manager.dispose();
});

Deno.test("参加: ニックネームが不正なら入室できない", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "あ".repeat(21));
  assertEquals(guest.state, undefined);
  assertEquals(last(guest.link, "error")?.code, "INVALID_INPUT");
  assertEquals(manager.getRoom(host.snapshot.code)?.players.size, 1);
  manager.dispose();
});

// ---------------------------------------------------------------------------
// 切断・再接続・ホスト委譲（§3.2 / §8）
// ---------------------------------------------------------------------------

Deno.test("再接続: 60秒以内なら同じ sessionToken で復帰できる（§3.2）", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  const session = guest.state.snapshot.session;
  assertExists(session);

  manager.disconnect(guest.link);
  const room = manager.getRoom(host.snapshot.code);
  assertExists(room);
  assertEquals(room.players.size, 2);
  assertEquals([...room.players.values()][1].connected, false);

  clock.advance(30_000);
  const back = new MockLink();
  manager.handle(back, {
    t: "join",
    roomCode: host.snapshot.code,
    nickname: "ゲスト",
    session,
  });
  const restored = last(back, "roomState");
  assertExists(restored);
  assertEquals(restored.snapshot.players.length, 2);
  assertEquals([...room.players.values()][1].connected, true);
  // 猶予タイマーは解除されているので、その後の経過で退室化しない
  clock.advance(DISCONNECT_GRACE_MS * 2);
  assertEquals(room.players.size, 2);
  manager.dispose();
});

Deno.test("切断: 60秒を超えると退室化してルームから消える（§3.2）", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  const guestId = guest.state.snapshot.youId;

  manager.disconnect(guest.link);
  clock.advance(DISCONNECT_GRACE_MS - 1);
  assertEquals(manager.getRoom(host.snapshot.code)?.players.size, 2);
  clock.advance(2);
  assertEquals(manager.getRoom(host.snapshot.code)?.players.size, 1);
  const leftEvents = all(host.link, "playerLeft");
  assert(leftEvents.some((e) => e.player.id === guestId));
  manager.dispose();
});

Deno.test("再接続: 退室化した後のセッションは新規参加として扱う", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  const session = guest.state.snapshot.session;
  assertExists(session);

  manager.disconnect(guest.link);
  clock.advance(DISCONNECT_GRACE_MS + 1);
  const back = new MockLink();
  manager.handle(back, {
    t: "join",
    roomCode: host.snapshot.code,
    nickname: "ゲスト",
    session,
  });
  const restored = last(back, "roomState");
  assertExists(restored);
  // 別人（新しい playerId / 新しい session）として入室する
  assert(restored.snapshot.youId !== guest.state.snapshot.youId);
  assertEquals(manager.getRoom(host.snapshot.code)?.players.size, 2);
  manager.dispose();
});

Deno.test("ホスト委譲: ホストが猶予を超えると最古参加者に移る（§3.1）", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const a = joinRoom(manager, host.snapshot.code, "Aさん");
  const b = joinRoom(manager, host.snapshot.code, "Bさん");
  assertExists(a.state);
  assertExists(b.state);

  manager.disconnect(host.link);
  clock.advance(DISCONNECT_GRACE_MS + 1);
  const changed = last(a.link, "hostChanged");
  assertExists(changed);
  assertEquals(changed.playerId, a.state.snapshot.youId);
  assertEquals(manager.getRoom(host.snapshot.code)?.hostId, a.state.snapshot.youId);
  assertExists(last(b.link, "hostChanged"));
  manager.dispose();
});

Deno.test("退室: 全員が退室するとルームが削除される", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(guest.link, { t: "leave" });
  assertEquals(manager.getRoom(host.snapshot.code)?.players.size, 1);
  assert(guest.link.closed);
  manager.handle(host.link, { t: "leave" });
  assertEquals(manager.roomCount, 0);
  manager.dispose();
});

// ---------------------------------------------------------------------------
// ゲーム進行
// ---------------------------------------------------------------------------

Deno.test("ゲーム選択: lobby の view はルーム層の selectedGameId で埋める", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  assertEquals(guest.state.snapshot.view, { phase: "lobby", selectedGameId: null });

  manager.handle(host.link, { t: "selectGame", gameId: "official-ogiri" });
  const phase = last(guest.link, "phase");
  assertExists(phase);
  assertEquals(phase.phase, "lobby");
  assertEquals(phase.view, { phase: "lobby", selectedGameId: "official-ogiri" });

  // 後から参加した人のスナップショットにも反映される
  const late = joinRoom(manager, host.snapshot.code, "あとから");
  assertExists(late.state);
  assertEquals(late.state.snapshot.selectedGameId, "official-ogiri");
  assertEquals(late.state.snapshot.view, { phase: "lobby", selectedGameId: "official-ogiri" });
  manager.dispose();
});

Deno.test("ゲーム選択・開始: ホスト以外は NOT_HOST", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(guest.link, { t: "selectGame", gameId: "official-ogiri" });
  assertEquals(last(guest.link, "error")?.code, "NOT_HOST");
  manager.handle(guest.link, { t: "startGame" });
  assertEquals(last(guest.link, "error")?.code, "NOT_HOST");
  manager.handle(guest.link, { t: "skipPhase" });
  assertEquals(last(guest.link, "error")?.code, "NOT_HOST");
  manager.dispose();
});

Deno.test("ゲーム開始: 未選択なら INVALID_INPUT、存在しない ID も INVALID_INPUT", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  joinRoom(manager, host.snapshot.code, "ゲスト");
  manager.handle(host.link, { t: "startGame" });
  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  manager.handle(host.link, { t: "selectGame", gameId: "not-exist" });
  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  manager.dispose();
});

Deno.test("ゲーム開始: 全員に intro が配信され、フェーズタイマーが張られる", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(host.link, { t: "selectGame", gameId: "official-ogiri" });
  manager.handle(host.link, { t: "startGame" });

  const phase = last(guest.link, "phase");
  assertExists(phase);
  assertEquals(phase.phase, "intro");
  assertEquals(phase.deadline, clock.now + DEFAULT_PHASE_DURATIONS.introSec * 1000);
  // タイマー発火で prompt に進む
  clock.advance(DEFAULT_PHASE_DURATIONS.introSec * 1000);
  assertEquals(last(guest.link, "phase")?.phase, "prompt");
  manager.dispose();
  assertEquals(clock.pending, 0);
});

Deno.test("回答: 全員の提出で reveal に進み、view は受信者ごとに作られる", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(host.link, { t: "selectGame", gameId: "official-ogiri" });
  manager.handle(host.link, { t: "startGame" });
  manager.handle(host.link, { t: "skipPhase" }); // intro -> prompt
  manager.handle(host.link, { t: "skipPhase" }); // prompt -> input

  manager.handle(host.link, { t: "submitInput", value: "ホストの回答" });
  const hostView = last(host.link, "phase")?.view;
  assertExists(hostView);
  assertEquals(hostView.phase, "input");
  assert(hostView.phase === "input" && hostView.submitted);
  const guestView = last(guest.link, "phase")?.view;
  assert(guestView !== undefined && guestView.phase === "input" && !guestView.submitted);

  manager.handle(guest.link, { t: "submitInput", value: "ゲストの回答" });
  assertEquals(last(host.link, "phase")?.phase, "reveal");
  manager.dispose();
});

Deno.test("回答: 不正な形式は INVALID_INPUT", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  joinRoom(manager, host.snapshot.code, "ゲスト");
  manager.handle(host.link, { t: "selectGame", gameId: "official-ogiri" });
  manager.handle(host.link, { t: "startGame" });
  manager.handle(host.link, { t: "skipPhase" });
  manager.handle(host.link, { t: "skipPhase" });
  manager.handle(host.link, { t: "submitInput", value: { bad: true } as unknown as string });
  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  manager.dispose();
});

Deno.test("退室化: ゲーム中に在籍が2人未満になると中断して lobby へ戻る（§8）", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(host.link, { t: "selectGame", gameId: "official-ogiri" });
  manager.handle(host.link, { t: "startGame" });
  assertEquals(last(host.link, "phase")?.phase, "intro");

  manager.disconnect(guest.link);
  // 切断しただけでは中断しない
  clock.advance(1_000);
  assert(last(host.link, "phase")?.phase !== "lobby");

  clock.advance(DISCONNECT_GRACE_MS);
  assertEquals(last(host.link, "phase")?.phase, "lobby");
  assertEquals(manager.getRoom(host.snapshot.code)?.game?.phase, "lobby");
  assertEquals(manager.getRoom(host.snapshot.code)?.players.size, 1);
  manager.dispose();
});

Deno.test("進行中の参加は観戦扱いになる（§8）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  joinRoom(manager, host.snapshot.code, "ゲスト");
  manager.handle(host.link, { t: "selectGame", gameId: "official-ogiri" });
  manager.handle(host.link, { t: "startGame" });
  const late = joinRoom(manager, host.snapshot.code, "あとから");
  assertExists(late.state);
  assertEquals(late.state.snapshot.youAreSpectator, true);
  manager.dispose();
});

// ---------------------------------------------------------------------------
// VC シグナリングの中継（§3.6 / §3.8）
// ---------------------------------------------------------------------------

Deno.test("rtcSignal: 同一ルームの接続中メンバーへ from を付けて中継する", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  const guestId = guest.state.snapshot.youId;

  manager.handle(host.link, {
    t: "rtcSignal",
    to: guestId,
    payload: { kind: "desc", description: { type: "offer", sdp: "v=0" } },
  });
  const signal = last(guest.link, "rtcSignal");
  assertExists(signal);
  assertEquals(signal.from, host.snapshot.youId);
  assertEquals(signal.payload, { kind: "desc", description: { type: "offer", sdp: "v=0" } });
  // 送信者にはエラーも中継も返さない
  assertEquals(last(host.link, "error"), undefined);
  assertEquals(all(host.link, "rtcSignal").length, 0);
  manager.dispose();
});

Deno.test("rtcSignal: 自分宛・不在・型不正は黙って破棄する", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);

  const before = guest.link.received.length;
  manager.handle(host.link, { t: "rtcSignal", to: host.snapshot.youId, payload: {} });
  manager.handle(host.link, { t: "rtcSignal", to: "no-such-player", payload: {} });
  manager.handle(host.link, { t: "rtcSignal", to: 123 as unknown as string, payload: {} });
  assertEquals(all(host.link, "rtcSignal").length, 0);
  assertEquals(last(host.link, "error"), undefined);
  assertEquals(guest.link.received.length, before);
  manager.dispose();
});

Deno.test("rtcSignal: 別ルームの参加者宛は中継しない", () => {
  const { manager } = setup();
  const roomA = createRoom(manager, "Aホスト");
  const roomB = createRoom(manager, "Bホスト");
  const other = joinRoom(manager, roomB.snapshot.code, "Bゲスト");
  assertExists(other.state);

  const before = other.link.received.length;
  manager.handle(roomA.link, { t: "rtcSignal", to: other.state.snapshot.youId, payload: {} });
  assertEquals(other.link.received.length, before);
  assertEquals(last(roomA.link, "error"), undefined);
  manager.dispose();
});

Deno.test("rtcSignal: 切断中の相手宛は中継しない（再接続後は届く）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  const guestId = guest.state.snapshot.youId;
  const session = guest.state.snapshot.session;
  assertExists(session);

  manager.disconnect(guest.link);
  const before = guest.link.received.length;
  manager.handle(host.link, { t: "rtcSignal", to: guestId, payload: { kind: "ready" } });
  assertEquals(guest.link.received.length, before);
  assertEquals(last(host.link, "error"), undefined);

  const back = new MockLink();
  manager.handle(back, {
    t: "join",
    roomCode: host.snapshot.code,
    nickname: "ゲスト",
    session,
  });
  manager.handle(host.link, { t: "rtcSignal", to: guestId, payload: { kind: "ready" } });
  assertExists(last(back, "rtcSignal"));
  manager.dispose();
});

Deno.test("rtcSignal: VC 枠外（7人目）が絡む中継は破棄する（§3.1 / §3.6）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const members = [];
  for (let i = 2; i <= VC_CAPACITY + 1; i++) {
    const guest = joinRoom(manager, host.snapshot.code, `ゲスト${i}`);
    assertExists(guest.state);
    members.push({ link: guest.link, id: guest.state.snapshot.youId });
  }
  const inVc = members[0];
  const outOfVc = members[members.length - 1];
  assertEquals(members.length, VC_CAPACITY);
  // 7人目は vcEligible=false として配信されている
  const players = last(outOfVc.link, "roomState")?.snapshot.players;
  assertExists(players);
  assertEquals(players.find((p) => p.id === outOfVc.id)?.vcEligible, false);
  assertEquals(players.find((p) => p.id === inVc.id)?.vcEligible, true);

  // 枠内 → 枠外
  const beforeOut = outOfVc.link.received.length;
  manager.handle(host.link, { t: "rtcSignal", to: outOfVc.id, payload: {} });
  assertEquals(outOfVc.link.received.length, beforeOut);
  // 枠外 → 枠内
  const beforeHost = host.link.received.length;
  manager.handle(outOfVc.link, { t: "rtcSignal", to: host.snapshot.youId, payload: {} });
  assertEquals(host.link.received.length, beforeHost);
  assertEquals(last(outOfVc.link, "error"), undefined);
  // 枠内同士は中継される
  manager.handle(host.link, { t: "rtcSignal", to: inVc.id, payload: { kind: "ready" } });
  assertEquals(last(inVc.link, "rtcSignal")?.from, host.snapshot.youId);
  manager.dispose();
});

// ---------------------------------------------------------------------------
// チャット（§3.9）
// ---------------------------------------------------------------------------

Deno.test("チャット: 発言者本人を含む全員に届き、nickname と playerId が入る", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(guest.link, { t: "chat", text: "  こんばんは  " });
  for (const link of [host.link, guest.link]) {
    const msg = last(link, "chat");
    assertExists(msg);
    // 前後の空白は trim され、発言時点の表示名と発言者IDが入る
    assertEquals(msg.message.text, "こんばんは");
    assertEquals(msg.message.nickname, "ゲスト");
    assertEquals(msg.message.playerId, guest.state.snapshot.youId);
    assertEquals(msg.message.bot, false);
    assertEquals(msg.message.at, clock.now);
    assertExists(msg.message.id);
  }
  manager.dispose();
});

Deno.test("チャット: 他のルームには届かない", () => {
  const { manager } = setup();
  const roomA = createRoom(manager, "Aホスト");
  const roomB = createRoom(manager, "Bホスト");
  manager.handle(roomA.link, { t: "chat", text: "Aルームの発言" });
  assertEquals(all(roomA.link, "chat").length, 1);
  assertEquals(all(roomB.link, "chat").length, 0);
  manager.dispose();
});

Deno.test("チャット: 不正な本文は INVALID_INPUT で履歴にも残らない", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "chat", text: "あ".repeat(CHAT_TEXT_MAX + 1) });
  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  manager.handle(host.link, { t: "chat", text: "改\n行" });
  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  assertEquals(all(host.link, "chat").length, 0);
  assertEquals(manager.getRoom(host.snapshot.code)?.chatHistory.length, 0);
  manager.dispose();
});

Deno.test("チャット: 10秒に5件を超えると RATE_LIMITED、窓が過ぎればまた送れる（§3.9）", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  for (let i = 1; i <= CHAT_RATE_MAX; i++) {
    manager.handle(host.link, { t: "chat", text: `発言${i}` });
  }
  assertEquals(humanChats(host.link).length, CHAT_RATE_MAX);
  // 6件目は拒否され、誰にもブロードキャストされない
  manager.handle(host.link, { t: "chat", text: "超過分" });
  assertEquals(last(host.link, "error")?.code, "RATE_LIMITED");
  assertEquals(humanChats(host.link).length, CHAT_RATE_MAX);
  assertEquals(humanChats(guest.link).length, CHAT_RATE_MAX);
  // レート制限は参加者ごと。他の参加者は制限されない
  manager.handle(guest.link, { t: "chat", text: "ゲストは送れる" });
  assertEquals(humanChats(host.link).length, CHAT_RATE_MAX + 1);
  // 窓が過ぎればまた送れる
  clock.advance(CHAT_RATE_WINDOW_MS);
  manager.handle(host.link, { t: "chat", text: "窓明けの発言" });
  assertEquals(last(host.link, "chat")?.message.text, "窓明けの発言");
  manager.dispose();
});

Deno.test("チャット: 履歴は直近100件のみ・古い順に保持される（§3.9）", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const total = CHAT_HISTORY_MAX + 5;
  for (let i = 0; i < total; i++) {
    manager.handle(host.link, { t: "chat", text: `メッセージ${i}` });
    assertEquals(last(host.link, "chat")?.message.text, `メッセージ${i}`);
    // レート制限に掛からないよう窓の 1/CHAT_RATE_MAX ずつ時間を進める
    clock.advance(CHAT_RATE_WINDOW_MS / CHAT_RATE_MAX);
  }
  const history = manager.getRoom(host.snapshot.code)?.chatHistory;
  assertExists(history);
  assertEquals(history.length, CHAT_HISTORY_MAX);
  assertEquals(history[0].text, `メッセージ${total - CHAT_HISTORY_MAX}`);
  assertEquals(history[history.length - 1].text, `メッセージ${total - 1}`);
  manager.dispose();
});

Deno.test("チャット: 途中入室者のスナップショットに履歴が入る（古い順）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "chat", text: "1件目" });
  manager.handle(host.link, { t: "chat", text: "2件目" });
  const late = joinRoom(manager, host.snapshot.code, "あとから");
  assertExists(late.state);
  assertEquals(late.state.snapshot.chat.map((m) => m.text), ["1件目", "2件目"]);
  manager.dispose();
});

Deno.test("チャット: 再接続時のスナップショットに履歴が入る（§3.2 / §3.9）", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  const session = guest.state.snapshot.session;
  assertExists(session);
  manager.handle(host.link, { t: "chat", text: "切断前の発言" });
  manager.disconnect(guest.link);
  manager.handle(host.link, { t: "chat", text: "切断中の発言" });
  clock.advance(1_000);
  const back = new MockLink();
  manager.handle(back, {
    t: "join",
    roomCode: host.snapshot.code,
    nickname: "ゲスト",
    session,
  });
  const restored = last(back, "roomState");
  assertExists(restored);
  assertEquals(
    restored.snapshot.chat.filter((m) => !m.bot).map((m) => m.text),
    ["切断前の発言", "切断中の発言"],
  );
  manager.dispose();
});

Deno.test("チャット: ゲーム進行中も観戦者も発言できる（§3.9）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  joinRoom(manager, host.snapshot.code, "ゲスト");
  manager.handle(host.link, { t: "selectGame", gameId: "official-ogiri" });
  manager.handle(host.link, { t: "startGame" });
  const late = joinRoom(manager, host.snapshot.code, "観戦者");
  assertExists(late.state);
  assertEquals(late.state.snapshot.youAreSpectator, true);
  manager.handle(late.link, { t: "chat", text: "観戦席から失礼します" });
  assertEquals(last(host.link, "chat")?.message.text, "観戦席から失礼します");
  assertEquals(last(late.link, "chat")?.message.nickname, "観戦者");
  manager.dispose();
});

Deno.test("チャット: ルーム未参加の接続からは ROOM_NOT_FOUND", () => {
  const { manager } = setup();
  createRoom(manager);
  const link = new MockLink();
  manager.handle(link, { t: "chat", text: "どこにも属していない" });
  assertEquals(last(link, "error")?.code, "ROOM_NOT_FOUND");
  manager.dispose();
});

// ---------------------------------------------------------------------------
// 通話の文字起こし（voice、docs/design/bot-voice.md）
// ---------------------------------------------------------------------------

Deno.test('voice: VC 枠内の発言者本人を含む全員に {t:"voice", line} として届く', () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(guest.link, { t: "voice", text: "  こんばんは  " });
  for (const link of [host.link, guest.link]) {
    const msg = last(link, "voice");
    assertExists(msg);
    assertEquals(msg.line.text, "こんばんは");
  }
  manager.dispose();
});

Deno.test("voice: line の中身が正しい（playerId / nickname / text / at / id）", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(guest.link, { t: "voice", text: "今日は飲みすぎた" });
  const msg = last(host.link, "voice");
  assertExists(msg);
  assertEquals(msg.line.playerId, guest.state.snapshot.youId);
  assertEquals(msg.line.nickname, "ゲスト");
  assertEquals(msg.line.text, "今日は飲みすぎた");
  assertEquals(msg.line.at, clock.now);
  assertExists(msg.line.id);
  manager.dispose();
});

Deno.test("voice: chatHistory には積まれない（docs/design/bot-voice.md）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "voice", text: "喋り言葉はチャット履歴に積まない" });
  assertExists(last(host.link, "voice"));
  assertEquals(manager.getRoom(host.snapshot.code)?.chatHistory.length, 0);
  assertEquals(all(host.link, "chat").length, 0);
  manager.dispose();
});

Deno.test("voice: スナップショットに文字起こしが入らない", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "voice", text: "スナップショットには残らないはず" });
  const late = joinRoom(manager, host.snapshot.code, "あとから");
  assertExists(late.state);
  assertEquals(late.state.snapshot.chat.length, 0);
  manager.dispose();
});

Deno.test("voice: 200文字ちょうどは受理し、201文字は INVALID_INPUT", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "voice", text: "あ".repeat(CHAT_TEXT_MAX) });
  assertEquals(last(host.link, "voice")?.line.text.length, CHAT_TEXT_MAX);
  assertEquals(last(host.link, "error"), undefined);
  manager.handle(host.link, { t: "voice", text: "あ".repeat(CHAT_TEXT_MAX + 1) });
  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  manager.dispose();
});

Deno.test("voice: 制御文字・空文字は INVALID_INPUT", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "voice", text: "改\n行" });
  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  manager.handle(host.link, { t: "voice", text: "" });
  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  manager.handle(host.link, { t: "voice", text: "   " });
  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  assertEquals(all(host.link, "voice").length, 0);
  manager.dispose();
});

Deno.test(
  `voice: ${
    VOICE_RATE_WINDOW_MS / 1000
  }秒に${VOICE_RATE_MAX}件を超えると黙って破棄され、窓が過ぎればまた送れる`,
  () => {
    const { clock, manager } = setup();
    const host = createRoom(manager);
    for (let i = 1; i <= VOICE_RATE_MAX; i++) {
      manager.handle(host.link, { t: "voice", text: `発言${i}` });
    }
    assertEquals(all(host.link, "voice").length, VOICE_RATE_MAX);
    // 13件目はエラーを返さず、配信もされず、黙って破棄される
    manager.handle(host.link, { t: "voice", text: "超過分" });
    assertEquals(last(host.link, "error"), undefined);
    assertEquals(all(host.link, "voice").length, VOICE_RATE_MAX);
    // 窓が過ぎればまた送れる
    clock.advance(VOICE_RATE_WINDOW_MS);
    manager.handle(host.link, { t: "voice", text: "窓明けの発言" });
    assertEquals(last(host.link, "voice")?.line.text, "窓明けの発言");
    manager.dispose();
  },
);

Deno.test("voice: VC 枠外（7人目以降）からの発言は黙って破棄する（§3.1 / docs/design/bot-voice.md）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const members: { link: MockLink; id: string }[] = [];
  for (let i = 2; i <= VC_CAPACITY + 1; i++) {
    const guest = joinRoom(manager, host.snapshot.code, `ゲスト${i}`);
    assertExists(guest.state);
    members.push({ link: guest.link, id: guest.state.snapshot.youId });
  }
  assertEquals(members.length, VC_CAPACITY);
  const outOfVc = members[members.length - 1];
  const players = last(outOfVc.link, "roomState")?.snapshot.players;
  assertExists(players);
  assertEquals(players.find((p) => p.id === outOfVc.id)?.vcEligible, false);

  const beforeHost = host.link.received.length;
  manager.handle(outOfVc.link, { t: "voice", text: "枠外からの発言" });
  assertEquals(all(host.link, "voice").length, 0);
  assertEquals(last(outOfVc.link, "error"), undefined);
  assertEquals(host.link.received.length, beforeHost);

  // 枠内は通常どおり受理される
  manager.handle(host.link, { t: "voice", text: "枠内からの発言" });
  assertEquals(last(host.link, "voice")?.line.text, "枠内からの発言");
  manager.dispose();
});

Deno.test("voice: ルーム未参加の接続からは ROOM_NOT_FOUND", () => {
  const { manager } = setup();
  createRoom(manager);
  const link = new MockLink();
  manager.handle(link, { t: "voice", text: "どこにも属していない" });
  assertEquals(last(link, "error")?.code, "ROOM_NOT_FOUND");
  manager.dispose();
});

Deno.test("voice: 退室すると voiceTimes が掃除される（メモリリーク防止の回帰）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  const guestId = guest.state.snapshot.youId;
  manager.handle(guest.link, { t: "voice", text: "退室前の発言" });

  // voiceTimes は rooms.ts 内の private フィールド（TS 上の型のみの private）なので、
  // メモリリークの回帰確認のためだけにここで直接覗く
  type RoomsInternal = { rooms: Map<string, { voiceTimes: Map<string, number[]> }> };
  const internalEntry = (manager as unknown as RoomsInternal).rooms.get(host.snapshot.code);
  assertExists(internalEntry);
  assert(internalEntry.voiceTimes.has(guestId));

  manager.handle(guest.link, { t: "leave" });
  assert(!internalEntry.voiceTimes.has(guestId));
  manager.dispose();
});

// ---------------------------------------------------------------------------
// 未実装メッセージ
// ---------------------------------------------------------------------------

Deno.test("未実装の C2S は INVALID_INPUT で拒否する", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  const unsupported = [
    { t: "knock", roomCode: host.snapshot.code, nickname: "x" },
    { t: "approveKnock", knockId: "x" },
    { t: "rejectKnock", knockId: "x" },
    { t: "kick", playerId: "x" },
    { t: "importGame", shareCode: "ABCDEFGH" },
  ] as const;
  for (const msg of unsupported) {
    manager.handle(host.link, msg);
    const error = last(host.link, "error");
    assertExists(error);
    assertEquals(error.code, "INVALID_INPUT");
    assertEquals(error.message, NOT_IMPLEMENTED_MESSAGE);
  }
  manager.dispose();
});

Deno.test("ルーム未参加の接続からのメッセージは ROOM_NOT_FOUND", () => {
  const { manager } = setup();
  const link = new MockLink();
  manager.handle(link, { t: "startGame" });
  assertEquals(last(link, "error")?.code, "ROOM_NOT_FOUND");
  manager.dispose();
});

Deno.test("二重の createRoom / join は拒否する", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  manager.handle(host.link, { t: "join", roomCode: host.snapshot.code, nickname: "ホスト" });
  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  assertEquals(manager.roomCount, 1);
  manager.dispose();
});

Deno.test("dispose: 残っているタイマーをすべて解除する", () => {
  const { clock, manager } = setup();
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(host.link, { t: "selectGame", gameId: "official-ogiri" });
  manager.handle(host.link, { t: "startGame" });
  manager.disconnect(guest.link);
  assert(clock.pending > 0);
  manager.dispose();
  assertEquals(clock.pending, 0);
  assertEquals(manager.roomCount, 0);
});

// ---------------------------------------------------------------------------
// サンドボックスゲーム（docs/design/game-sandbox.md §4 / §5）
// ---------------------------------------------------------------------------

Deno.test("sandboxStart: ホスト以外は NOT_HOST", () => {
  const { manager } = setup({ sandboxGameIds: new Set(["reflex"]) });
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(guest.link, { t: "sandboxStart", gameId: "reflex" });
  assertEquals(last(guest.link, "error")?.code, "NOT_HOST");
  manager.handle(guest.link, { t: "sandboxEnd" });
  assertEquals(last(guest.link, "error")?.code, "NOT_HOST");
  manager.dispose();
});

Deno.test("sandboxStart: 未知の gameId は INVALID_INPUT（ホワイトリストに無い・dev 除外を含む）", () => {
  const { manager } = setup({ sandboxGameIds: new Set(["reflex"]) });
  const host = createRoom(manager);
  manager.handle(host.link, { t: "sandboxStart", gameId: "not-in-manifest" });
  assertEquals(last(host.link, "error")?.code, "INVALID_INPUT");
  assertEquals(manager.getRoom(host.snapshot.code)?.sandbox, null);
  manager.dispose();
});

Deno.test("sandboxStart: 既存エンジンのゲームが進行中は PHASE_MISMATCH", () => {
  const { manager } = setup({ sandboxGameIds: new Set(["reflex"]) });
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(host.link, { t: "selectGame", gameId: "official-ogiri" });
  manager.handle(host.link, { t: "startGame" });
  assertEquals(last(host.link, "phase")?.phase, "intro");

  manager.handle(host.link, { t: "sandboxStart", gameId: "reflex" });
  assertEquals(last(host.link, "error")?.code, "PHASE_MISMATCH");
  assertEquals(manager.getRoom(host.snapshot.code)?.sandbox, null);
  manager.dispose();
});

Deno.test("sandboxStart: 二重開始は DUPLICATE（同じ gameId でも状態は変わらない）", () => {
  const { clock, manager } = setup({ sandboxGameIds: new Set(["reflex"]) });
  const host = createRoom(manager);
  manager.handle(host.link, { t: "sandboxStart", gameId: "reflex" });
  const first = manager.getRoom(host.snapshot.code)?.sandbox;
  assertExists(first);

  clock.advance(1_000);
  manager.handle(host.link, { t: "sandboxStart", gameId: "reflex" });
  assertEquals(last(host.link, "error")?.code, "DUPLICATE");
  // 状態（startedAt を含む）は再開始で変わらない（冪等）
  assertEquals(manager.getRoom(host.snapshot.code)?.sandbox, first);
  // 2回目の sandboxState は配信されない
  assertEquals(all(host.link, "sandboxState").length, 1);
  manager.dispose();
});

Deno.test("sandboxStart/sandboxEnd: 全員に sandboxState として届く", () => {
  const { manager } = setup({ sandboxGameIds: new Set(["reflex"]) });
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);

  manager.handle(host.link, { t: "sandboxStart", gameId: "reflex" });
  const started = last(guest.link, "sandboxState");
  assertExists(started);
  assertEquals(started.game?.gameId, "reflex");
  assertEquals(started.game?.startedBy, host.snapshot.youId);

  manager.handle(host.link, { t: "sandboxEnd" });
  assertEquals(last(guest.link, "sandboxState")?.game, null);
  manager.dispose();
});

Deno.test("sandboxEnd: 稼働していないときは何もしない（冪等）", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  manager.handle(host.link, { t: "sandboxEnd" });
  assertEquals(last(host.link, "error"), undefined);
  assertEquals(all(host.link, "sandboxState").length, 0);
  manager.dispose();
});

Deno.test("スナップショット: 途中参加者が稼働中のサンドボックス状態を復元できる", () => {
  const { clock, manager } = setup({ sandboxGameIds: new Set(["reflex"]) });
  const host = createRoom(manager);
  manager.handle(host.link, { t: "sandboxStart", gameId: "reflex" });
  clock.advance(5_000);

  const late = joinRoom(manager, host.snapshot.code, "あとから");
  assertExists(late.state);
  assertEquals(late.state.snapshot.sandbox?.gameId, "reflex");
  assertEquals(late.state.snapshot.sandbox?.startedBy, host.snapshot.youId);
  manager.dispose();
});

Deno.test("スナップショット: サンドボックス未稼働なら sandbox は null", () => {
  const { manager } = setup();
  const host = createRoom(manager);
  assertEquals(host.snapshot.sandbox, null);
  manager.dispose();
});

Deno.test("サンドボックス稼働中は既存エンジンの selectGame / startGame が PHASE_MISMATCH", () => {
  const { manager } = setup({ sandboxGameIds: new Set(["reflex"]) });
  const host = createRoom(manager);
  manager.handle(host.link, { t: "sandboxStart", gameId: "reflex" });

  manager.handle(host.link, { t: "selectGame", gameId: "official-ogiri" });
  assertEquals(last(host.link, "error")?.code, "PHASE_MISMATCH");
  manager.handle(host.link, { t: "startGame" });
  assertEquals(last(host.link, "error")?.code, "PHASE_MISMATCH");
  assertEquals(manager.getRoom(host.snapshot.code)?.game, null);
  manager.dispose();
});

Deno.test("sandboxSignal: 稼働中は送信者以外の全員へ無改変で中継される（送信者には返らない）", () => {
  const { manager } = setup({ sandboxGameIds: new Set(["reflex"]) });
  const host = createRoom(manager);
  const guestA = joinRoom(manager, host.snapshot.code, "ゲストA");
  const guestB = joinRoom(manager, host.snapshot.code, "ゲストB");
  assertExists(guestA.state);
  assertExists(guestB.state);
  manager.handle(host.link, { t: "sandboxStart", gameId: "reflex" });

  const payload = { k: "tap", round: 1 };
  manager.handle(host.link, { t: "sandboxSignal", payload });
  const toA = last(guestA.link, "sandboxSignal");
  const toB = last(guestB.link, "sandboxSignal");
  assertExists(toA);
  assertExists(toB);
  assertEquals(toA.from, host.snapshot.youId);
  assertEquals(toA.payload, payload);
  assertEquals(toB.from, host.snapshot.youId);
  // 送信者本人には返らない
  assertEquals(all(host.link, "sandboxSignal").length, 0);
  manager.dispose();
});

Deno.test("sandboxSignal: サンドボックス未稼働なら黙って破棄される", () => {
  const { manager } = setup({ sandboxGameIds: new Set(["reflex"]) });
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  const before = guest.link.received.length;

  manager.handle(host.link, { t: "sandboxSignal", payload: { k: "x" } });
  assertEquals(guest.link.received.length, before);
  assertEquals(last(host.link, "error"), undefined);
  manager.dispose();
});

Deno.test("sandboxSignal: payload が上限（4KB）を超えると黙って破棄される", () => {
  const { manager } = setup({ sandboxGameIds: new Set(["reflex"]) });
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(host.link, { t: "sandboxStart", gameId: "reflex" });

  const before = guest.link.received.length;
  // JSON 直列化後のバイト数が上限を超えるよう、十分大きな文字列を1フィールドに積む
  const huge = "a".repeat(SANDBOX_PAYLOAD_MAX_BYTES + 100);
  manager.handle(host.link, { t: "sandboxSignal", payload: { big: huge } });
  assertEquals(guest.link.received.length, before);
  assertEquals(last(host.link, "error"), undefined);

  // 上限以内なら通常どおり中継される
  manager.handle(host.link, { t: "sandboxSignal", payload: { small: "ok" } });
  assertEquals(last(guest.link, "sandboxSignal")?.payload, { small: "ok" });
  manager.dispose();
});

Deno.test("sandboxSignal: ルーム未参加の接続からは ROOM_NOT_FOUND", () => {
  const { manager } = setup({ sandboxGameIds: new Set(["reflex"]) });
  createRoom(manager);
  const link = new MockLink();
  manager.handle(link, { t: "sandboxSignal", payload: {} });
  assertEquals(last(link, "error")?.code, "ROOM_NOT_FOUND");
  manager.dispose();
});

Deno.test("ホスト退出: サンドボックス稼働中でもホスト交代が起き、サンドボックスは継続する（§5.1）", () => {
  const { clock, manager } = setup({ sandboxGameIds: new Set(["reflex"]) });
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(host.link, { t: "sandboxStart", gameId: "reflex" });
  const sandboxBefore = manager.getRoom(host.snapshot.code)?.sandbox;
  assertExists(sandboxBefore);

  manager.disconnect(host.link);
  clock.advance(DISCONNECT_GRACE_MS + 1);
  assertExists(last(guest.link, "hostChanged"));
  assertEquals(manager.getRoom(host.snapshot.code)?.hostId, guest.state.snapshot.youId);
  // サンドボックスの状態はホスト交代の影響を受けない
  assertEquals(manager.getRoom(host.snapshot.code)?.sandbox, sandboxBefore);
  manager.dispose();
});

Deno.test("退室: 全員が退室するとサンドボックス稼働中でもルームが削除される", () => {
  const { manager } = setup({ sandboxGameIds: new Set(["reflex"]) });
  const host = createRoom(manager);
  const guest = joinRoom(manager, host.snapshot.code, "ゲスト");
  assertExists(guest.state);
  manager.handle(host.link, { t: "sandboxStart", gameId: "reflex" });

  manager.handle(guest.link, { t: "leave" });
  manager.handle(host.link, { t: "leave" });
  assertEquals(manager.roomCount, 0);
  manager.dispose();
});

// ---------------------------------------------------------------------------
// 卓の説明文・タグ（一覧表示用）
// ---------------------------------------------------------------------------

Deno.test("説明文検証: 前後の空白を除去して受理し、空文字も許可する", () => {
  const trimmed = validateRoomDescription("  今夜は焼酎の会です  ");
  assert(trimmed.ok);
  assertEquals(trimmed.value, "今夜は焼酎の会です");

  const empty = validateRoomDescription("");
  assert(empty.ok);
  assertEquals(empty.value, "");
});

Deno.test("説明文検証: 101文字以上・制御文字・文字列以外を拒否する", () => {
  assertFalse(validateRoomDescription("あ".repeat(101)).ok);
  assertFalse(validateRoomDescription("あ\nい").ok);
  assertFalse(validateRoomDescription(123).ok);
  assert(validateRoomDescription("あ".repeat(100)).ok);
});

Deno.test("setRoomMeta: オーナーが説明文・タグを設定すると一覧に反映される", () => {
  const { manager } = setup();
  const { snapshot } = createPublicRoom(manager, "金曜の反省会");

  const result = manager.setRoomMeta(snapshot.code, "testUser", {
    description: "ゆるく飲みます",
    tags: ["casual_chat", "light_drinking"],
  });
  assert(result.ok);

  const [summary] = manager.listPublicRooms();
  assertEquals(summary.description, "ゆるく飲みます");
  assertEquals(summary.tags, ["casual_chat", "light_drinking"]);
});

Deno.test("setRoomMeta: 空文字・空配列で説明文とタグをクリアできる", () => {
  const { manager } = setup();
  const { snapshot } = createPublicRoom(manager, "金曜の反省会");
  manager.setRoomMeta(snapshot.code, "testUser", {
    description: "ゆるく飲みます",
    tags: ["casual_chat"],
  });

  const cleared = manager.setRoomMeta(snapshot.code, "testUser", { description: "", tags: [] });
  assert(cleared.ok);

  const [summary] = manager.listPublicRooms();
  assertEquals(summary.description, undefined);
  assertEquals(summary.tags, undefined);
});

Deno.test("setRoomMeta: 存在しないコードは404相当を返す", () => {
  const { manager } = setup();
  const result = manager.setRoomMeta("000000", "testUser", { description: "", tags: [] });
  assert(!result.ok);
  assertEquals(result.status, 404);
});

Deno.test("setRoomMeta: オーナー以外は403相当を返す", () => {
  const { manager } = setup();
  const { snapshot } = createPublicRoom(manager, "金曜の反省会");
  const result = manager.setRoomMeta(snapshot.code, "otherUser", {
    description: "乗っ取り",
    tags: [],
  });
  assert(!result.ok);
  assertEquals(result.status, 403);
});
