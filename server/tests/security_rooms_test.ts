/**
 * rooms.ts のセキュリティ回帰テスト（監査 01 / 02 の Medium）。
 *
 * 対象:
 *   - ノックのレート制限が接続IDキーで、WS を張り直すだけで回避できた件
 *   - ホスト委譲が「切断中の参加者」を選びうる件
 *   - rtcSignal の payload にだけ大きさの上限が無く、同室者への増幅に使えた件
 *   - 仕様 §3.8「ルーム作成: 1アカウントにつき同時3ルームまで」が未実装だった件
 *
 * 時計とタイマーは rooms_test.ts と同じ手（FakeClock）で差し替える。
 */

import { assert, assertEquals, assertExists, assertFalse } from "@std/assert";
import { type ClientLink, RoomManager, rtcSignalPayloadExceedsLimit } from "../rooms.ts";
import {
  KNOCK_RATE_WINDOW_MS,
  ROOMS_PER_ACCOUNT_MAX,
  RTC_SIGNAL_PAYLOAD_MAX_BYTES,
  type S2C,
} from "../types.ts";

const T0 = 1_700_000_000_000;

/** 手動で進められる時計（rooms_test.ts と同じ構造） */
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

/**
 * 受信内容を貯めるだけの接続。
 * clientIp を渡せる点だけが rooms_test.ts の MockLink と違う（ノックのレート制限の
 * キーが「接続ごとに変わらない値」であることを確かめるために要る）。
 */
class MockLink implements ClientLink {
  readonly id = crypto.randomUUID();
  readonly received: S2C[] = [];
  closed = false;

  constructor(
    readonly userId: string | null = "testUser",
    readonly clientIp: string | undefined = undefined,
  ) {}

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

function setup() {
  const clock = new FakeClock();
  const manager = new RoomManager({
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, manager };
}

/** 承認制の公開ルームを立てる */
function createKnockRoom(manager: RoomManager) {
  const link = new MockLink();
  manager.handle(link, {
    t: "createRoom",
    nickname: "ホスト",
    visibility: "public",
    roomName: "承認卓",
    entryMode: "knock",
  });
  const state = last(link, "roomState");
  assertExists(state);
  return { link, code: state.snapshot.code };
}

// ---------------------------------------------------------------------------
// ノックのレート制限（監査 01 Medium）
// ---------------------------------------------------------------------------

Deno.test("ノック: 接続を張り直しても、同じIPからは間隔制限が効く（監査の回帰）", () => {
  const { manager } = setup();
  const host = createKnockRoom(manager);

  // 1回目: 通る
  const first = new MockLink("attacker", "203.0.113.9");
  manager.handle(first, { t: "knock", roomCode: host.code, nickname: "A" });
  assertEquals(last(first, "error"), undefined, "1回目のノックは通ること");

  // ホストが拒否 → 保留枠は空く
  const request = last(host.link, "knockRequest");
  assertExists(request);
  manager.handle(host.link, { t: "rejectKnock", knockId: request.knockId });
  manager.disconnect(first);

  // 別の接続（＝別の接続ID）だが同じIP。ここが監査で素通りしていたところ
  const second = new MockLink("attacker", "203.0.113.9");
  manager.handle(second, { t: "knock", roomCode: host.code, nickname: "A" });
  const err = last(second, "error");
  assertExists(err, "接続を張り直しても制限に当たること");
  assertEquals(err.code, "RATE_LIMITED");
});

Deno.test("ノック: IP が違えば独立して受け付ける（正常系）", () => {
  const { manager } = setup();
  const host = createKnockRoom(manager);

  const a = new MockLink("userA", "203.0.113.9");
  manager.handle(a, { t: "knock", roomCode: host.code, nickname: "A" });
  assertEquals(last(a, "error"), undefined);

  const b = new MockLink("userB", "198.51.100.2");
  manager.handle(b, { t: "knock", roomCode: host.code, nickname: "B" });
  assertEquals(last(b, "error"), undefined, "別IPは巻き添えにしないこと");
});

Deno.test("ノック: 判定窓を過ぎれば同じIPでもまた受け付ける（境界値）", () => {
  const { clock, manager } = setup();
  const host = createKnockRoom(manager);

  const first = new MockLink("attacker", "203.0.113.9");
  manager.handle(first, { t: "knock", roomCode: host.code, nickname: "A" });
  const request = last(host.link, "knockRequest");
  assertExists(request);
  manager.handle(host.link, { t: "rejectKnock", knockId: request.knockId });
  manager.disconnect(first);

  // 境界: 窓のちょうど手前はまだ弾かれる
  clock.advance(KNOCK_RATE_WINDOW_MS - 1);
  const during = new MockLink("attacker", "203.0.113.9");
  manager.handle(during, { t: "knock", roomCode: host.code, nickname: "A" });
  assertEquals(last(during, "error")?.code, "RATE_LIMITED");
  manager.disconnect(during);

  // 窓を跨げば通る
  clock.advance(2);
  const after = new MockLink("attacker", "203.0.113.9");
  manager.handle(after, { t: "knock", roomCode: host.code, nickname: "A" });
  assertEquals(last(after, "error"), undefined, "窓を過ぎたら受け付けること");
});

Deno.test("ノック: IP を持たない接続は従来どおり接続IDで制限する", () => {
  const { manager } = setup();
  const host = createKnockRoom(manager);

  const link = new MockLink("userA");
  manager.handle(link, { t: "knock", roomCode: host.code, nickname: "A" });
  const request = last(host.link, "knockRequest");
  assertExists(request);
  manager.handle(host.link, { t: "rejectKnock", knockId: request.knockId });
  link.received.length = 0;
  manager.handle(link, { t: "knock", roomCode: host.code, nickname: "A" });
  assertEquals(last(link, "error")?.code, "RATE_LIMITED");
});

// ---------------------------------------------------------------------------
// ホスト委譲（監査 01 Medium）
// ---------------------------------------------------------------------------

/** ホスト + 参加者2人の卓を作る */
function createTrio(manager: RoomManager) {
  const host = new MockLink();
  manager.handle(host, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  const hostState = last(host, "roomState");
  assertExists(hostState);
  const code = hostState.snapshot.code;

  const p1 = new MockLink();
  manager.handle(p1, { t: "join", roomCode: code, nickname: "P1" });
  const p2 = new MockLink();
  manager.handle(p2, { t: "join", roomCode: code, nickname: "P2" });
  const p1State = last(p1, "roomState");
  const p2State = last(p2, "roomState");
  assertExists(p1State);
  assertExists(p2State);
  return { host, code, p1, p1Id: p1State.snapshot.youId, p2, p2Id: p2State.snapshot.youId };
}

Deno.test("ホスト委譲: 最古の在籍者が切断中なら、接続中の人へ渡す（監査の回帰）", () => {
  const { manager } = setup();
  const room = createTrio(manager);

  // 最古の在籍者（p1）を再接続猶予中にする
  manager.disconnect(room.p1);
  room.p2.received.length = 0;
  manager.handle(room.host, { t: "leave" });

  const changed = last(room.p2, "hostChanged");
  assertExists(changed, "hostChanged が配られること");
  assertEquals(changed.playerId, room.p2Id, "接続中の p2 がホストになること");
  assertFalse(changed.playerId === room.p1Id, "切断中の p1 を選ばないこと");
});

Deno.test("ホスト委譲: 全員接続中なら従来どおり最古の在籍者へ渡す（正常系）", () => {
  const { manager } = setup();
  const room = createTrio(manager);

  room.p2.received.length = 0;
  manager.handle(room.host, { t: "leave" });

  const changed = last(room.p2, "hostChanged");
  assertExists(changed);
  assertEquals(changed.playerId, room.p1Id);
});

Deno.test("ホスト委譲: 残りが全員切断中なら最古の在籍者へ倒す（境界値）", () => {
  const { manager } = setup();
  const room = createTrio(manager);

  manager.disconnect(room.p1);
  manager.disconnect(room.p2);
  manager.handle(room.host, { t: "leave" });

  // 誰も接続していないので配信は届かないが、次に繋ぎ直した人が
  // ホストになっていることを roomState で確認する
  const back = new MockLink();
  manager.handle(back, {
    t: "join",
    roomCode: room.code,
    nickname: "P1",
    session: sessionOf(room.p1),
  });
  const state = last(back, "roomState");
  assertExists(state);
  assertEquals(state.snapshot.hostId, room.p1Id, "最古の在籍者がホストであること");
});

/** join 時に配られた sessionToken を取り出す（再接続に使う） */
function sessionOf(link: MockLink): string {
  const state = last(link, "roomState");
  assertExists(state);
  const session = state.snapshot.session;
  assertExists(session);
  return session;
}

// ---------------------------------------------------------------------------
// rtcSignal の payload サイズ（監査 01 Medium）
// ---------------------------------------------------------------------------

Deno.test("rtcSignalPayloadExceedsLimit: 上限ちょうどは通し、1バイト超は弾く（境界値）", () => {
  // {"v":"..."} の分だけ引いて、直列化がちょうど上限になる文字列を作る
  const overhead = new TextEncoder().encode(JSON.stringify({ v: "" })).length;
  const fit = "a".repeat(RTC_SIGNAL_PAYLOAD_MAX_BYTES - overhead);
  assertFalse(rtcSignalPayloadExceedsLimit({ v: fit }));
  assert(rtcSignalPayloadExceedsLimit({ v: `${fit}a` }));
  // 実際のシグナリング（SDP は実測 約6.4KB、ICE candidate は 235B 程度）は通ること
  assertFalse(
    rtcSignalPayloadExceedsLimit({
      kind: "desc",
      description: { type: "offer", sdp: "v=0\r\n".repeat(1200) },
    }),
  );
  assertFalse(
    rtcSignalPayloadExceedsLimit({ kind: "ice", candidate: { candidate: "a".repeat(200) } }),
  );
  assertFalse(rtcSignalPayloadExceedsLimit({ kind: "ready", session: "abc" }));
  // 異常系: 直列化できない値は超過扱い
  assert(rtcSignalPayloadExceedsLimit(undefined));
  assert(rtcSignalPayloadExceedsLimit(() => {}));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert(rtcSignalPayloadExceedsLimit(circular));
});

Deno.test("rtcSignal: 上限を超える payload は中継せず INVALID_INPUT を返す（監査の回帰）", () => {
  const { manager } = setup();
  const room = createTrio(manager);
  room.p1.received.length = 0;
  room.host.received.length = 0;

  // MAX_MESSAGE_BYTES(64KB) には収まるが rtcSignal の上限は超える大きさ
  const big = "x".repeat(60_000);
  manager.handle(room.host, {
    t: "rtcSignal",
    to: room.p1Id,
    payload: { kind: "desc", blob: big },
  });

  assertEquals(last(room.p1, "rtcSignal"), undefined, "相手へ中継されないこと");
  const err = last(room.host, "error");
  assertExists(err, "送信者にはエラーを返すこと");
  assertEquals(err.code, "INVALID_INPUT");
});

Deno.test("rtcSignal: 正当な大きさの payload は今までどおり中継する（正常系）", () => {
  const { manager } = setup();
  const room = createTrio(manager);
  room.p1.received.length = 0;
  room.host.received.length = 0;

  // 実測に近い SDP サイズ（約6.4KB）
  const payload = { kind: "desc", description: { type: "offer", sdp: "a".repeat(6_400) } };
  manager.handle(room.host, { t: "rtcSignal", to: room.p1Id, payload });

  const relayed = last(room.p1, "rtcSignal");
  assertExists(relayed, "中継されること");
  assertEquals(relayed.payload, payload);
  assertEquals(last(room.host, "error"), undefined, "エラーを返さないこと");
});

// ---------------------------------------------------------------------------
// 1アカウントあたりの同時ルーム数（仕様 §3.8・監査 02 Medium）
// ---------------------------------------------------------------------------

Deno.test("createRoom: 1アカウントは同時3ルームまで（上限ちょうど・超過）", () => {
  const { manager } = setup();
  const links: MockLink[] = [];
  for (let i = 0; i < ROOMS_PER_ACCOUNT_MAX; i++) {
    const link = new MockLink("sameUser");
    manager.handle(link, { t: "createRoom", nickname: "ホスト", visibility: "private" });
    assertExists(last(link, "roomState"), `${i + 1}件目までは作れること`);
    assertEquals(last(link, "error"), undefined);
    links.push(link);
  }
  const over = new MockLink("sameUser");
  manager.handle(over, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  assertEquals(last(over, "roomState"), undefined, "上限超過では卓が建たないこと");
  assertEquals(last(over, "error")?.code, "RATE_LIMITED");
});

Deno.test("createRoom: 別アカウントは巻き添えにしない（正常系）", () => {
  const { manager } = setup();
  for (let i = 0; i < ROOMS_PER_ACCOUNT_MAX; i++) {
    const link = new MockLink("sameUser");
    manager.handle(link, { t: "createRoom", nickname: "ホスト", visibility: "private" });
    assertExists(last(link, "roomState"));
  }
  const other = new MockLink("otherUser");
  manager.handle(other, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  assertExists(last(other, "roomState"), "別アカウントは作れること");
});

Deno.test("createRoom: 卓を閉じれば枠が戻る（境界値）", () => {
  const { manager } = setup();
  const links: MockLink[] = [];
  for (let i = 0; i < ROOMS_PER_ACCOUNT_MAX; i++) {
    const link = new MockLink("sameUser");
    manager.handle(link, { t: "createRoom", nickname: "ホスト", visibility: "private" });
    assertExists(last(link, "roomState"));
    links.push(link);
  }
  // 1つ目の卓から抜ける（最後の1人なので卓は消える）
  manager.handle(links[0], { t: "leave" });

  const again = new MockLink("sameUser");
  manager.handle(again, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  assertExists(last(again, "roomState"), "枠が空けばまた作れること");
});

Deno.test("createRoom: 上限に達していても、既にある卓への入室・再接続は妨げない", () => {
  const { manager } = setup();
  const owners: MockLink[] = [];
  const codes: string[] = [];
  for (let i = 0; i < ROOMS_PER_ACCOUNT_MAX; i++) {
    const link = new MockLink("sameUser");
    manager.handle(link, { t: "createRoom", nickname: "ホスト", visibility: "private" });
    const state = last(link, "roomState");
    assertExists(state);
    owners.push(link);
    codes.push(state.snapshot.code);
  }
  // 上限に達していることを確かめる
  const over = new MockLink("sameUser");
  manager.handle(over, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  assertEquals(last(over, "error")?.code, "RATE_LIMITED");

  // 同じアカウントの別接続でも、既にある卓には入れる（作成だけを塞ぐ）
  const joiner = new MockLink("sameUser");
  manager.handle(joiner, { t: "join", roomCode: codes[0], nickname: "べつ端末" });
  assertExists(last(joiner, "roomState"), "既存の卓へは入れること");
  assertEquals(last(joiner, "error"), undefined);

  // 他人も入れる
  const guest = new MockLink(null);
  manager.handle(guest, { t: "join", roomCode: codes[1], nickname: "ゲスト" });
  assertExists(last(guest, "roomState"), "ゲストも既存の卓へ入れること");

  // ホスト本人の再接続も通る
  const session = sessionOf(owners[2]);
  manager.disconnect(owners[2]);
  const back = new MockLink("sameUser");
  manager.handle(back, { t: "join", roomCode: codes[2], nickname: "ホスト", session });
  assertExists(last(back, "roomState"), "ホストが再接続できること");
  assertEquals(last(back, "error"), undefined);
});
