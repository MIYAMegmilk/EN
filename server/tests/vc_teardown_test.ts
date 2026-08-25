/**
 * public/room/vc.js の後始末（leave / teardown）のテスト。
 *
 * 本題はマイク・カメラのトラックが確実に stop() されること。
 * 止め損ねるとカメラのランプが点いたままになり、プライバシーに関わる（§3.6）。
 *
 * サーバー再起動で卓が解散したときは、ピアへ bye を送ってはいけない。
 * 相手も同じ再起動で切れているので通知は届かず、繋ぎ直した先の新しいサーバーへ
 * 宛先不明の rtcSignal を投げるだけになるため（その拒否応答が、利用者に出している
 * 「サーバーが再起動したため…」の案内を上書きしてしまう）。
 *
 * vc.js が触るブラウザ API は DOM・getUserMedia・RTCPeerConnection・タイマーだけなので、
 * 偽物を渡せば Deno から素の JavaScript として動かせる。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createFakeDocument, FakeElement } from "./fake_dom.ts";

const VC_JS = fromFileUrl(new URL("../../public/room/vc.js", import.meta.url));
const source = await Deno.readTextFile(VC_JS);

// ---------------------------------------------------------------------------
// ブラウザ API の偽物
// ---------------------------------------------------------------------------

/** MediaStreamTrack の偽物。stop() が呼ばれたかを記録する（ここが本題） */
class FakeTrack {
  stopped = false;
  enabled = true;
  readyState = "live";
  muted = false;

  constructor(readonly kind: "audio" | "video") {}

  stop(): void {
    this.stopped = true;
    this.readyState = "ended";
  }

  addEventListener(): void {}

  getSettings(): Record<string, number> {
    return { frameRate: 30 };
  }
}

/** MediaStream の偽物 */
class FakeStream {
  constructor(readonly tracks: FakeTrack[] = []) {}

  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(track: FakeTrack): void {
    this.tracks.push(track);
  }
  removeTrack(track: FakeTrack): void {
    const at = this.tracks.indexOf(track);
    if (at >= 0) this.tracks.splice(at, 1);
  }
}

/** RTCPeerConnection の偽物。閉じられた回数を記録する */
class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  closeCount = 0;
  connectionState = "connected";
  localDescription = null;
  onnegotiationneeded: unknown = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  private readonly senders: Array<{ track: FakeTrack; replaceTrack: () => Promise<void> }> = [];

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTrack(track: FakeTrack) {
    const sender = { track, replaceTrack: () => Promise.resolve() };
    this.senders.push(sender);
    return sender;
  }

  getSenders() {
    return this.senders;
  }

  removeTrack(): void {}

  close(): void {
    this.closeCount++;
  }

  setLocalDescription(): Promise<void> {
    return Promise.resolve();
  }

  restartIce(): void {}

  getStats(): Promise<Map<string, unknown>> {
    return Promise.resolve(new Map());
  }
}

type Sent = { t: string; to?: string; payload?: { kind?: string } };

type Harness = {
  // deno-lint-ignore no-explicit-any
  vc: any;
  /** サーバーへ送られた rtcSignal */
  sent: Sent[];
  /** getUserMedia が返したストリーム（[0] がマイク、[1] がカメラ） */
  streams: FakeStream[];
  /** 生きているタイマーの本数。後始末の取りこぼし検出に使う */
  liveTimers(): number;
  notices: Array<{ kind: string; message: string }>;
};

/** vc.js を偽の環境で読み込む */
function load(): Harness {
  FakePeerConnection.instances = [];
  const sent: Sent[] = [];
  const streams: FakeStream[] = [];
  const notices: Array<{ kind: string; message: string }> = [];
  const timers = new Set<number>();
  let seq = 1;
  const { document } = createFakeDocument();

  const addTimer = () => {
    const id = seq++;
    timers.add(id);
    return id;
  };
  const dropTimer = (id: number) => {
    timers.delete(id);
  };

  // vc.js は品質監視のタイマーを global（window）経由で取る
  const win = {
    setInterval: addTimer,
    clearInterval: dropTimer,
    setTimeout: addTimer,
    clearTimeout: dropTimer,
    navigator: {
      mediaDevices: {
        getUserMedia: (constraints: { video?: unknown }) => {
          // join() は video:false で呼ぶ。カメラ ON はそれ以外
          const stream = new FakeStream([
            new FakeTrack(constraints.video === false ? "audio" : "video"),
          ]);
          streams.push(stream);
          return Promise.resolve(stream);
        },
      },
    },
    RTCPeerConnection: FakePeerConnection,
    MediaStream: FakeStream,
    crypto: { randomUUID: () => `id-${seq++}` },
  };

  const factory = new Function(
    "window",
    "document",
    "MediaStream",
    "setInterval",
    "clearInterval",
    "setTimeout",
    "clearTimeout",
    `${source}\n; return window.VC;`,
  );

  // 返るのは vc.js が組み立てた公開 API そのもの（型は Harness["vc"] 側で表明済み）
  const vc: Harness["vc"] = factory(
    win,
    document,
    FakeStream,
    addTimer,
    dropTimer,
    addTimer,
    dropTimer,
  );

  vc.init({
    send: (msg: Sent) => sent.push(msg),
    container: new FakeElement("div", "vc-media"),
    onStatus: (event: { kind: string; message: string }) => notices.push(event),
  });

  return { vc, sent, streams, liveTimers: () => timers.size, notices };
}

/** VC に参加し、ピアを1本張り、カメラも ON にした状態を作る */
async function joinWithPeerAndCamera(h: Harness): Promise<void> {
  h.vc.handleServerMessage({
    t: "roomState",
    snapshot: {
      youId: "me",
      players: [
        { id: "me", nickname: "わたし", vcEligible: true, connected: true },
        { id: "you", nickname: "あなた", vcEligible: true, connected: true },
      ],
    },
  });
  assert(await h.vc.join(), "VC に参加できていない");
  // 相手からの ready を受けてピアを作る
  h.vc.handleServerMessage({
    t: "rtcSignal",
    from: "you",
    payload: { kind: "ready", session: "s" },
  });
  assertEquals(FakePeerConnection.instances.length, 1, "ピアが張られていない");
  assert(await h.vc.setCamera(true), "カメラを ON にできていない");
  assertEquals(h.streams.length, 2, "マイクとカメラのストリームが揃っていない");
}

/** マイク・カメラのトラックがすべて止まっているか */
function allTracksStopped(h: Harness): boolean {
  return h.streams.every((s) => s.getTracks().every((t) => t.stopped));
}

// ---------------------------------------------------------------------------
// teardown: サーバーが落ちているときの後始末
// ---------------------------------------------------------------------------

Deno.test("VC.teardown: ピアへ signal を送らずにマイク・カメラを止める", async () => {
  const h = load();
  await joinWithPeerAndCamera(h);
  assertFalse(allTracksStopped(h), "参加中はまだ止まっていない");
  const sentBefore = h.sent.length;

  h.vc.teardown();

  // ここが本題。止め損ねるとカメラのランプが点いたままになる
  assert(allTracksStopped(h), "マイク・カメラのトラックが止まっていない");
  for (const stream of h.streams) {
    for (const track of stream.getTracks()) assertEquals(track.readyState, "ended");
  }
  // 相手も同じ再起動で切れているので、bye を送っても届かない
  assertEquals(
    h.sent.slice(sentBefore),
    [],
    "teardown で送信が発生した（繋ぎ直した先の新しいサーバーへ宛先不明の signal が飛ぶ）",
  );
  assertEquals(FakePeerConnection.instances[0].closeCount, 1, "ピアが閉じられていない");
  assertFalse(h.vc.getState().active);
  assertEquals(h.liveTimers(), 0, "品質監視のタイマーが残っている");
});

Deno.test("VC.teardown: 呼び出し側の案内を上書きしないよう、状態通知を出さない", async () => {
  const h = load();
  await joinWithPeerAndCamera(h);
  h.notices.length = 0;

  h.vc.teardown();

  const vcState = h.notices.filter((n) => n.kind === "vcState");
  assertEquals(vcState, [], `状態通知が出ている: ${JSON.stringify(vcState)}`);
});

Deno.test("VC.teardown: VC に参加していないときに呼んでも安全", () => {
  const h = load();
  // 再起動は VC に入っていないときにも起きる
  h.vc.teardown();
  h.vc.teardown();

  assertFalse(h.vc.getState().active);
  assertEquals(h.sent, []);
});

Deno.test("VC.teardown: 二重に呼んでも壊れない（ピアを二度閉じない）", async () => {
  const h = load();
  await joinWithPeerAndCamera(h);

  h.vc.teardown();
  h.vc.teardown();
  h.vc.leave(); // 後始末のあとに退室操作が来ても同じ

  assertEquals(FakePeerConnection.instances[0].closeCount, 1, "ピアを二度閉じている");
  assert(allTracksStopped(h));
  assertEquals(h.sent.filter((m) => m.payload?.kind === "bye"), []);
});

// ---------------------------------------------------------------------------
// leave: 通常の退室（サーバーは生きている）
// ---------------------------------------------------------------------------

Deno.test("VC.leave: 通常の退室では今までどおりピアへ bye を送る", async () => {
  const h = load();
  await joinWithPeerAndCamera(h);
  const sentBefore = h.sent.length;

  h.vc.leave();

  const byes = h.sent.slice(sentBefore).filter((m) => m.payload?.kind === "bye");
  assertEquals(byes.length, 1, "bye が送られていない");
  assertEquals(byes[0].to, "you");
  assertEquals(byes[0].t, "rtcSignal");
  // 後始末そのものは teardown と同じでなければならない
  assert(allTracksStopped(h), "退室でもマイク・カメラは止める");
  assertEquals(FakePeerConnection.instances[0].closeCount, 1);
  assertFalse(h.vc.getState().active);
  assertEquals(h.liveTimers(), 0);
});

Deno.test("VC.leave: 退室したことは今までどおり通知する", async () => {
  const h = load();
  await joinWithPeerAndCamera(h);
  h.notices.length = 0;

  h.vc.leave();

  assertEquals(h.notices.filter((n) => n.kind === "vcState").map((n) => n.message), [
    "VC から退出しました",
  ]);
});
