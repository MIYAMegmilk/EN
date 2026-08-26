/**
 * クライアント専用ゲームを **RoomManager 越しに**動かす結合テスト。
 *
 * `server/games/client.ts` の単体テストは reduce/view の形を見ているだけなので、
 * 「本当に卓で始まって、中継が全員に届いて、ちゃんとロビーへ戻れるか」は
 * ここで確かめる。設計の売りが「rooms.ts / types.ts / main.ts を変更せずに
 * 既存のライフサイクルがそのまま効く」ことなので、その主張の裏取りでもある。
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { type ClientLink, RoomManager } from "../../rooms.ts";
import type { S2C } from "../../types.ts";
import type { ClientGameView } from "../../games/client.ts";

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

function all<T extends S2C["t"]>(link: MockLink, t: T): Extract<S2C, { t: T }>[] {
  return link.received.filter((m) => m.t === t) as Extract<S2C, { t: T }>[];
}

/** 直近の gameView の中身を ClientGameView として読む */
function view(link: MockLink, gameId: string): ClientGameView {
  const msg = last(link, "gameView");
  assertExists(msg, "gameView が届いていない");
  assertEquals(msg.gameId, gameId);
  return msg.view as ClientGameView;
}

/** ホストと客1人で指定のクライアント専用ゲームを始めた卓を作る */
function playingRoom(gameId: string) {
  const manager = new RoomManager();
  const host = new MockLink();
  manager.handle(host, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  const created = last(host, "roomState");
  assertExists(created);
  const code = created.snapshot.code;
  const guest = new MockLink();
  manager.handle(guest, { t: "join", roomCode: code, nickname: "きゃく" });
  const joined = last(guest, "roomState");
  assertExists(joined);
  manager.handle(host, { t: "selectGame", gameId });
  manager.handle(host, { t: "startGame" });
  return {
    manager,
    host,
    guest,
    code,
    hostId: created.snapshot.youId,
    guestId: joined.snapshot.youId,
  };
}

Deno.test("卓: クライアント専用ゲームが一覧に並び、selectGame → startGame で始まる", () => {
  const room = playingRoom("reflex");
  const snapshot = last(room.host, "roomState");
  assertExists(snapshot);
  const summary = snapshot.snapshot.availableGames.find((g) => g.id === "reflex");
  assertExists(summary, "reflex が一覧に無い");
  assertEquals(summary.kind, "module");
  assertEquals(summary.minPlayers, 2);
  assertEquals(last(room.host, "phase")?.phase, "playing");
  // seed と startedAt は卓の全員に同じ値が届く（通信なしの同期の土台）
  const forHost = view(room.host, "reflex");
  const forGuest = view(room.guest, "reflex");
  assertEquals(forHost.seed, forGuest.seed);
  assertEquals(forHost.startedAt, forGuest.startedAt);
  assertEquals(forHost.players.map((p) => p.name), ["ホスト", "きゃく"]);
  room.manager.dispose();
});

Deno.test("卓: gameEvent が全員へ中継され、送信者本人にも届く", () => {
  const room = playingRoom("reflex");
  room.manager.handle(room.host, { t: "gameEvent", payload: { k: "t", r: 0, rt: 210 } });
  for (const link of [room.host, room.guest]) {
    const v = view(link, "reflex");
    assertEquals(v.events.length, 1);
    assertEquals(v.events[0].n, 1);
    assertEquals(v.events[0].from, room.hostId);
    assertEquals(v.events[0].payload, { k: "t", r: 0, rt: 210 });
  }
  // 秘密は持てない＝ホストの view と客の view が完全に同じであることを確認する
  assertEquals(
    JSON.stringify(view(room.host, "reflex")),
    JSON.stringify(view(room.guest, "reflex")),
  );
  room.manager.dispose();
});

Deno.test("卓: 途中参加した人にも RoomSnapshot.game で現状が届く", () => {
  const room = playingRoom("reflex");
  room.manager.handle(room.guest, { t: "gameEvent", payload: { k: "t", r: 0, rt: 300 } });
  const late = new MockLink();
  room.manager.handle(late, { t: "join", roomCode: room.code, nickname: "あとから" });
  const snapshot = last(late, "roomState");
  assertExists(snapshot);
  assertExists(snapshot.snapshot.game, "途中参加者に game が入っていない");
  assertEquals(snapshot.snapshot.game.gameId, "reflex");
  const v = snapshot.snapshot.game.view as ClientGameView;
  assertEquals(v.events.length, 1);
  // 名簿にも載る
  assert(v.players.some((p) => p.name === "あとから"), "途中参加者が名簿に無い");
  room.manager.dispose();
});

Deno.test("卓: ホストの skipPhase でゲームが終わり、ロビーへ戻って次を選べる", () => {
  const room = playingRoom("reflex");
  assertEquals(last(room.host, "phase")?.phase, "playing");
  room.manager.handle(room.host, { t: "skipPhase" });
  assertEquals(last(room.host, "phase")?.phase, "lobby");
  assertEquals(last(room.guest, "phase")?.phase, "lobby");
  // ロビーへ戻ったので次のゲームを選べる（進行中だと PHASE_MISMATCH になる）
  room.manager.handle(room.host, { t: "selectGame", gameId: "mogura" });
  assertEquals(all(room.host, "error").length, 0);
  assertEquals(last(room.host, "roomState")?.snapshot.selectedGameId ?? "mogura", "mogura");
  room.manager.dispose();
});

Deno.test("卓: クライアント専用ゲームは公式スコア（参加者一覧の得点）を動かさない", () => {
  const room = playingRoom("reflex");
  room.manager.handle(room.host, { t: "gameEvent", payload: { k: "t", r: 0, rt: 100 } });
  room.manager.handle(room.guest, { t: "gameEvent", payload: { k: "t", r: 0, rt: 400 } });
  room.manager.handle(room.host, { t: "skipPhase" });
  const snapshot = last(room.host, "roomState");
  assertExists(snapshot);
  for (const p of snapshot.snapshot.players) {
    assertEquals(p.score, 0, `${p.nickname} に得点が入っている`);
  }
  room.manager.dispose();
});

Deno.test("卓: minPlayers を満たさないと開始できない（reflex は2人から）", () => {
  const manager = new RoomManager();
  const host = new MockLink();
  manager.handle(host, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  manager.handle(host, { t: "selectGame", gameId: "reflex" });
  manager.handle(host, { t: "startGame" });
  assertEquals(last(host, "error")?.code, "PHASE_MISMATCH");
  assertEquals(last(host, "phase")?.phase ?? "lobby", "lobby");
  // minPlayers: 1 の mogura は1人でも始まる
  manager.handle(host, { t: "selectGame", gameId: "mogura" });
  manager.handle(host, { t: "startGame" });
  assertEquals(last(host, "phase")?.phase, "playing");
  manager.dispose();
});

Deno.test("卓: 退出で minPlayers を割ると中断され、ロビーへ戻る", () => {
  const room = playingRoom("reflex");
  room.manager.handle(room.guest, { t: "leave" });
  assertEquals(last(room.host, "phase")?.phase, "lobby");
  room.manager.dispose();
});

Deno.test("卓: 画像を使うゲーム（emoawase）も同じ経路で始まり、終われる", () => {
  const room = playingRoom("emoawase");
  assertEquals(last(room.host, "phase")?.phase, "playing");
  room.manager.handle(room.guest, { t: "gameEvent", payload: { k: "done", ms: 48_000 } });
  assertEquals(view(room.host, "emoawase").events[0].payload, { k: "done", ms: 48_000 });
  room.manager.handle(room.host, { t: "skipPhase" });
  assertEquals(last(room.host, "phase")?.phase, "lobby");
  room.manager.dispose();
});
