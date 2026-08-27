/**
 * public/room/vc.js の在席表示（マイクマーク・話し中・自分の名前）のテスト。
 *
 * 本題は次の3つ。
 *   1. ミュート状態が rtcSignal の {kind:"mic"} で相手に届き、相手の枠の
 *      マイクマークがそれに追従すること。届かないと「黙っている人」と
 *      「マイクを切っている人」が卓上で見分けられない
 *   2. 後から入ってきた相手にも、その時点のミュート状態が飛ぶこと
 *      （これが無いと、自分がミュートした後に来た人にだけ札が出ない）
 *   3. 自分の枠にも他人と同じくニックネームが出て、「あなた」は別の札で示すこと
 *
 * 手口は vc_teardown_test.ts / vc_screenshare_test.ts と同じで、偽の DOM・偽の
 * RTCPeerConnection・偽の MediaStream の上に vc.js を new Function で読み込み、
 * Deno から素の JavaScript として動かす。
 *
 * 偽の環境には **AudioContext を置かない**。vc.js の発話検知は特徴検出で守って
 * あるので、ここでは丸ごと素通りするのが正しい（音量を測る経路が無い環境でも、
 * ミュートの札と名前の表示は従来どおり動く、という確認を兼ねている）。
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createFakeDocument, FakeElement } from "./fake_dom.ts";

const VC_JS = fromFileUrl(new URL("../../public/room/vc.js", import.meta.url));
const source = await Deno.readTextFile(VC_JS);

// ---------------------------------------------------------------------------
// ブラウザ API の偽物
// ---------------------------------------------------------------------------

/** MediaStreamTrack の偽物 */
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

/** RTCPeerConnection の偽物 */
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

type Sent = { t: string; to?: string; payload?: { kind?: string; muted?: boolean } };

type Harness = {
  // deno-lint-ignore no-explicit-any
  vc: any;
  /** サーバーへ送られた rtcSignal */
  sent: Sent[];
  /** 枠が差し込まれる先（index.html の #vc-people にあたる） */
  container: FakeElement;
  /** 生きているタイマーの本数。後始末の取りこぼし検出に使う */
  liveTimers(): number;
};

/** vc.js を偽の環境で読み込む */
function load(): Harness {
  FakePeerConnection.instances = [];
  const sent: Sent[] = [];
  const timers = new Set<number>();
  let seq = 1;
  const { document } = createFakeDocument();
  const container = new FakeElement("div", "vc-people");

  const addTimer = () => {
    const id = seq++;
    timers.add(id);
    return id;
  };
  const dropTimer = (id: number) => {
    timers.delete(id);
  };

  // AudioContext は **わざと置かない**（発話検知は特徴検出で素通りする）
  const win = {
    setInterval: addTimer,
    clearInterval: dropTimer,
    setTimeout: addTimer,
    clearTimeout: dropTimer,
    navigator: {
      mediaDevices: {
        getUserMedia: (constraints: { video?: unknown }) =>
          Promise.resolve(
            new FakeStream([new FakeTrack(constraints.video === false ? "audio" : "video")]),
          ),
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
    container,
    onStatus: () => {},
  });

  return { vc, sent, container, liveTimers: () => timers.size };
}

/** 自分（me・わたし）と相手（you・のみすけ）がいる卓に入り、ピアを1本張る */
async function joinWithPeer(h: Harness): Promise<void> {
  h.vc.handleServerMessage({
    t: "roomState",
    snapshot: {
      youId: "me",
      players: [
        { id: "me", nickname: "わたし", vcEligible: true, connected: true },
        { id: "you", nickname: "のみすけ", vcEligible: true, connected: true },
      ],
    },
  });
  assert(await h.vc.join(), "VC に参加できていない");
  h.vc.handleServerMessage({
    t: "rtcSignal",
    from: "you",
    payload: { kind: "ready", session: "s" },
  });
  assertEquals(FakePeerConnection.instances.length, 1, "ピアが張られていない");
}

/** playerId の枠。相手の枠には data-player-id が入っている */
function peerTile(h: Harness, playerId: string): FakeElement {
  const found = h.container.children.find((c) => c.dataset.playerId === playerId);
  assertExists(found, `${playerId} の枠が無い`);
  return found;
}

/** 自分の枠（.vc-self） */
function selfTile(h: Harness): FakeElement {
  const found = h.container.children.find((c) => c.className.split(" ").includes("vc-self"));
  assertExists(found, "自分の枠が無い");
  return found;
}

/** 枠のマイクマーク */
function micMark(tile: FakeElement): FakeElement {
  const found = tile.querySelector(".vc-mic-mark");
  assertExists(found, "マイクマークが無い");
  return found;
}

/** 相手へ送った {kind:"mic"} だけを拾う */
function micSignals(h: Harness, to: string): Sent[] {
  return h.sent.filter((m) => m.t === "rtcSignal" && m.to === to && m.payload?.kind === "mic");
}

// ---------------------------------------------------------------------------
// ミュート状態の告知
// ---------------------------------------------------------------------------

Deno.test("VC.setMuted: 全ピアへ {kind:'mic'} を告知する", async () => {
  const h = load();
  await joinWithPeer(h);
  h.sent.length = 0;

  h.vc.setMuted(true);
  assertEquals(
    micSignals(h, "you").map((m) => m.payload?.muted),
    [true],
    "ミュートが相手に伝わっていない",
  );

  h.sent.length = 0;
  h.vc.setMuted(false);
  assertEquals(
    micSignals(h, "you").map((m) => m.payload?.muted),
    [false],
    "ミュート解除が相手に伝わっていない",
  );
});

Deno.test("VC: ピアを受け入れた直後に、その相手だけへ今のミュート状態を送る", async () => {
  const h = load();
  await joinWithPeer(h);
  // 先にミュートしてから、後から来た人にも札が出るかを見る
  h.vc.setMuted(true);
  h.sent.length = 0;

  h.vc.handleServerMessage({
    t: "playerJoined",
    player: { id: "late", nickname: "おそば", vcEligible: true, connected: true },
  });

  assertEquals(
    micSignals(h, "late").map((m) => m.payload?.muted),
    [true],
    "後から入ってきた相手にミュート状態が飛んでいない",
  );
  // 既にいる相手へ重ねて送りはしない（告知は新しい相手にだけ）
  assertEquals(micSignals(h, "you"), [], "既存のピアへ余計な告知が飛んでいる");
});

Deno.test("VC: ready を受けてピアを作ったときも、その相手へミュート状態を送る", async () => {
  const h = load();
  h.vc.handleServerMessage({
    t: "roomState",
    snapshot: {
      youId: "me",
      players: [
        { id: "me", nickname: "わたし", vcEligible: true, connected: true },
        { id: "you", nickname: "のみすけ", vcEligible: true, connected: true },
      ],
    },
  });
  assert(await h.vc.join(), "VC に参加できていない");
  h.vc.setMuted(true);
  h.sent.length = 0;

  h.vc.handleServerMessage({
    t: "rtcSignal",
    from: "you",
    payload: { kind: "ready", session: "s" },
  });

  assertEquals(
    micSignals(h, "you").map((m) => m.payload?.muted),
    [true],
    "ready で作ったピアへミュート状態が飛んでいない",
  );
});

// ---------------------------------------------------------------------------
// マイクマークの表示
// ---------------------------------------------------------------------------

Deno.test("VC: 相手の {kind:'mic'} を受けると、その枠のマイクマークが切になる", async () => {
  const h = load();
  await joinWithPeer(h);
  const mark = micMark(peerTile(h, "you"));
  assertEquals(mark.dataset.state, "on", "告知前は声入りとして扱う");

  h.vc.handleServerMessage({
    t: "rtcSignal",
    from: "you",
    payload: { kind: "mic", muted: true },
  });
  assertEquals(mark.dataset.state, "off", "相手のミュートが枠に出ていない");
  assertEquals(mark.attributes.get("aria-label"), "ミュート中");

  h.vc.handleServerMessage({
    t: "rtcSignal",
    from: "you",
    payload: { kind: "mic", muted: false },
  });
  assertEquals(mark.dataset.state, "on", "ミュート解除が枠に出ていない");
  assertEquals(mark.attributes.get("aria-label"), "マイク入");
});

Deno.test("VC.setMuted: 自分の枠のマイクマークは告知の往復を待たずに切り替わる", async () => {
  const h = load();
  await joinWithPeer(h);
  const mark = micMark(selfTile(h));
  assertEquals(mark.dataset.state, "on");

  h.vc.setMuted(true);
  assertEquals(mark.dataset.state, "off", "自分の枠に自分のミュートが出ていない");

  h.vc.setMuted(false);
  assertEquals(mark.dataset.state, "on");
});

// ---------------------------------------------------------------------------
// 自分の枠の名前と「あなた」の札
// ---------------------------------------------------------------------------

Deno.test("VC: 自分の枠にも他人と同じくニックネームが出て、「あなた」は別の札になる", async () => {
  const h = load();
  await joinWithPeer(h);
  const tile = selfTile(h);

  const label = tile.querySelector(".vc-peer-label");
  assertExists(label, "自分の枠にラベルが無い");
  assertEquals(label.textContent, "わたし", "自分の枠に自分の名前が出ていない");

  const tag = tile.querySelector(".vc-self-tag");
  assertExists(tag, "「あなた」の札が無い");
  assertEquals(tag.textContent, "あなた");

  // 相手の枠は従来どおり名前だけ（「あなた」の札は付かない）
  const peer = peerTile(h, "you");
  assertEquals(peer.querySelector(".vc-peer-label")?.textContent, "のみすけ");
  assertEquals(peer.querySelector(".vc-self-tag"), null, "相手の枠に「あなた」が付いている");
});

Deno.test("VC: 自分の名前が変わったら、自分の枠のラベルも追いかける", async () => {
  const h = load();
  await joinWithPeer(h);
  const label = selfTile(h).querySelector(".vc-peer-label");
  assertExists(label);

  // playerJoined 経由（再接続・あだ名の付け直し）
  h.vc.handleServerMessage({
    t: "playerJoined",
    player: { id: "me", nickname: "ほろよい", vcEligible: true, connected: true },
  });
  assertEquals(label.textContent, "ほろよい", "playerJoined で名前が追従していない");

  // roomState 経由（再接続でスナップショットを取り直したとき）
  h.vc.handleServerMessage({
    t: "roomState",
    snapshot: {
      youId: "me",
      players: [{ id: "me", nickname: "べろべろ", vcEligible: true, connected: true }],
    },
  });
  assertEquals(label.textContent, "べろべろ", "roomState で名前が追従していない");
});

// ---------------------------------------------------------------------------
// 後始末
// ---------------------------------------------------------------------------

Deno.test("VC.leave: 卓上の枠もタイマーも残さない", async () => {
  const h = load();
  await joinWithPeer(h);
  // 出ていく前は、自分の枠と相手の枠が1つずつ出ている
  assertEquals(h.container.children.length, 2, "参加中に枠が揃っていない");

  h.vc.leave();

  // 発話検知は AudioContext が無い環境では回らないが、回る環境で止め損ねると
  // ここが増える。品質監視と同じ掛け金として置いておく
  assertEquals(h.liveTimers(), 0, "タイマーが残っている");
  // 相手の枠だけでなく **自分の枠も** 消える。残ると、VC を抜けた後も黒い枠と
  // 自分の名前が卓上に並んだままになり、まだ着席しているように見えてしまう
  assertEquals(h.container.children.length, 0, "VC を抜けた後も枠が残っている");
});

Deno.test("VC: VC に入り直すと、自分の枠がもう一度出る", async () => {
  const h = load();
  await joinWithPeer(h);
  h.vc.leave();
  assertEquals(h.container.children.length, 0);

  // 抜けた後に枠を消しているので、入り直したときに出し直せることまで見る
  assert(await h.vc.join(), "VC に入り直せていない");
  const tile = selfTile(h);
  assertEquals(tile.querySelector(".vc-peer-label")?.textContent, "わたし");
  assertEquals(micMark(tile).dataset.state, "on");
});

// ---------------------------------------------------------------------------
// 発話の判定（純粋関数）
// ---------------------------------------------------------------------------

const QUIET = { speaking: false, quietSince: null };

Deno.test("decideSpeaking: しきい値を超えたら話し中になる", () => {
  const h = load();
  assertEquals(h.vc.decideSpeaking(0.2, QUIET, 1000), { speaking: true, quietSince: null });
  assertEquals(h.vc.decideSpeaking(0.01, QUIET, 1000), { speaking: false, quietSince: null });
});

Deno.test("decideSpeaking: 入りと出でしきい値が違う（ヒステリシス）", () => {
  const h = load();
  const speaking = { speaking: true, quietSince: null };
  // 0.04 は「入る」しきい値（0.045）には届かないが、「出る」しきい値（0.03）は超える。
  // 話し中はそのまま続き、無言からは始まらない
  assertEquals(h.vc.decideSpeaking(0.04, speaking, 1000).speaking, true);
  assertEquals(h.vc.decideSpeaking(0.04, QUIET, 1000).speaking, false);
});

Deno.test("decideSpeaking: 静かになってもすぐには消さない（息継ぎで点滅させない）", () => {
  const h = load();
  // 静かになった瞬間はまだ話し中。時刻を覚えておく
  const first = h.vc.decideSpeaking(0, { speaking: true, quietSince: null }, 1000);
  assertEquals(first, { speaking: true, quietSince: 1000 });

  // 保持時間（400ms）の内側なら続いたまま、覚えた時刻も動かさない
  assertEquals(h.vc.decideSpeaking(0, first, 1300), { speaking: true, quietSince: 1000 });

  // 途中で声が戻れば忘れる
  assertEquals(h.vc.decideSpeaking(0.2, first, 1300), { speaking: true, quietSince: null });

  // 保持時間を過ぎたら消える
  assertEquals(h.vc.decideSpeaking(0, first, 1400), { speaking: false, quietSince: null });
});
