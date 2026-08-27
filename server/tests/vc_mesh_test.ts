/**
 * public/room/vc.js のメッシュ維持と ICE candidate の取りこぼしのテスト。
 *
 * 本題は2つ。
 *
 *   1. `roomState` は入室・再接続だけでなく**得点の確定やノック**でも配られる
 *      （server/rooms.ts が score 適用後に全員へ配り直す）。以前はこれを受ける
 *      たびにメッシュ全体を張り直していたので、あそんでいる最中に何度も卓
 *      全員の通話が途切れていた。張り直しは「顔ぶれ（eligiblePeerIds）が実際に
 *      変わったとき」だけに絞る。
 *
 *   2. `addIceCandidate()` は remote description が入る前に呼ぶと必ず失敗する。
 *      ready → desc → ice の順に送っても、相手の candidate は setRemoteDescription()
 *      が終わる前に届き得る。捨てると経路の候補がそのぶん減り、繋がるまでが
 *      遅くなる・繋がらないことがある。入るまで溜めて、入ったら流し込む。
 *
 * 手口は vc_presence_test.ts / vc_teardown_test.ts と同じで、偽の DOM・偽の
 * RTCPeerConnection・偽の MediaStream の上に vc.js を new Function で読み込み、
 * Deno から素の JavaScript として動かす。
 *
 * 偽の RTCPeerConnection は、本物と同じく **remote description が入る前の
 * addIceCandidate() を失敗させる**。ここを甘くすると 2. の検証が素通りする。
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

type Description = { type: string; sdp: string };

/**
 * RTCPeerConnection の偽物。
 * addIceCandidate は本物と同じく remote description の有無で成否が変わる。
 */
class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState = "connected";
  signalingState = "stable";
  localDescription: Description | null = null;
  remoteDescription: Description | null = null;
  closeCount = 0;
  /** 実際に受け付けた candidate（null は収集完了） */
  readonly candidates: unknown[] = [];
  /** remote description が無い状態で呼ばれた回数（取りこぼしの検出用） */
  rejectedCandidates = 0;
  /** 呼ばれると必ず例外を投げる candidate の値（異常系） */
  static poison: unknown = Symbol("none");
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

  restartIce(): void {}

  setLocalDescription(): Promise<void> {
    this.localDescription = { type: "answer", sdp: "v=0" };
    return Promise.resolve();
  }

  setRemoteDescription(description: Description): Promise<void> {
    this.remoteDescription = description;
    return Promise.resolve();
  }

  addIceCandidate(candidate: unknown): Promise<void> {
    if (this.remoteDescription === null) {
      this.rejectedCandidates++;
      // 本物と同じ振る舞い。remote description の前は必ず失敗する
      return Promise.reject(new Error("InvalidStateError"));
    }
    if (candidate === FakePeerConnection.poison) {
      return Promise.reject(new Error("OperationError: 壊れた candidate"));
    }
    this.candidates.push(candidate);
    return Promise.resolve();
  }

  getStats(): Promise<Map<string, unknown>> {
    return Promise.resolve(new Map());
  }
}

type Payload = {
  kind?: string;
  session?: string;
  candidate?: unknown;
  description?: Description;
};
type Sent = { t: string; to?: string; payload?: Payload };

type Player = { id: string; nickname: string; vcEligible: boolean; connected: boolean };

type Harness = {
  // deno-lint-ignore no-explicit-any
  vc: any;
  /** サーバーへ送られた rtcSignal */
  sent: Sent[];
  container: FakeElement;
};

/** vc.js を偽の環境で読み込む */
function load(): Harness {
  FakePeerConnection.instances = [];
  FakePeerConnection.poison = Symbol("none");
  const sent: Sent[] = [];
  let seq = 1;
  const { document } = createFakeDocument();
  const container = new FakeElement("div", "vc-people");

  const addTimer = () => seq++;
  const dropTimer = () => {};

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

  vc.init({ send: (msg: Sent) => sent.push(msg), container, onStatus: () => {} });

  return { vc, sent, container };
}

/** 「わたし」を含む参加者一覧をそのまま roomState として流し込む */
function roomState(h: Harness, players: Player[]): void {
  h.vc.handleServerMessage({ t: "roomState", snapshot: { youId: "me", players } });
}

function player(id: string, opts: Partial<Player> = {}): Player {
  return {
    id,
    nickname: id,
    vcEligible: opts.vcEligible ?? true,
    connected: opts.connected ?? true,
  };
}

/** 相手から ready を受けてピアを1本張る */
function acceptReady(h: Harness, from: string, session = `s-${from}`): void {
  h.vc.handleServerMessage({ t: "rtcSignal", from, payload: { kind: "ready", session } });
}

/** 相手から ICE candidate を1件受ける */
function receiveCandidate(h: Harness, from: string, candidate: unknown): void {
  h.vc.handleServerMessage({ t: "rtcSignal", from, payload: { kind: "ice", candidate } });
}

/** 相手から offer を受ける（ここで setRemoteDescription が走る） */
function receiveOffer(h: Harness, from: string, sdp = "v=0"): void {
  h.vc.handleServerMessage({
    t: "rtcSignal",
    from,
    payload: { kind: "desc", description: { type: "offer", sdp } },
  });
}

/** マイクロタスクを吐き切らせる（vc.js の非同期処理は await されずに走る） */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** いま張っているピアの playerId（vc.js の getState は作った順で返す） */
function orderedPeerIds(h: Harness): string[] {
  return h.vc.getState().peers.map((p: { id: string }) => p.id);
}

/**
 * 相手の ready を受けてピアを1本張り、その RTCPeerConnection を返す。
 * 偽物は生成順に instances へ積まれるので、張った直後の末尾がその相手のもの。
 */
function connect(h: Harness, from: string, session = `s-${from}`): FakePeerConnection {
  const before = FakePeerConnection.instances.length;
  acceptReady(h, from, session);
  assertEquals(FakePeerConnection.instances.length, before + 1, `${from} のピアが張られていない`);
  const pc = FakePeerConnection.instances[before];
  assertExists(pc, `${from} の RTCPeerConnection が無い`);
  return pc;
}

/** 相手へ送った ready だけを拾う */
function readySignals(h: Harness, to?: string): Sent[] {
  return h.sent.filter((m) =>
    m.t === "rtcSignal" && m.payload?.kind === "ready" && (to === undefined || m.to === to)
  );
}

/** 「わたし」が VC に参加し、指定した相手とピアを張った状態を作る */
async function joinWith(h: Harness, players: Player[]): Promise<void> {
  roomState(h, [player("me"), ...players]);
  assert(await h.vc.join(), "VC に参加できていない");
}

// ===========================================================================
// H-15: roomState でメッシュ全体を張り直さない
// ===========================================================================

Deno.test("VC: 顔ぶれが変わらない roomState（得点確定・ノック）ではピアを張り直さない", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  const pc = connect(h, "you");
  h.sent.length = 0;

  // 得点が確定した後の配り直し。参加者の顔ぶれは同じで score だけが動く
  roomState(h, [player("me"), player("you")]);

  assertEquals(pc.closeCount, 0, "通話と無関係な roomState でピアが閉じられた");
  assertEquals(orderedPeerIds(h), ["you"], "ピアが消えている（張り直しが起きた）");
  assertEquals(readySignals(h), [], "張り直しの ready が飛んでいる");
  assertEquals(h.sent, [], "顔ぶれが同じなのに何かを送っている");

  // 何度受けても同じ（ノックのたびに配られても増えない）
  roomState(h, [player("me"), player("you")]);
  roomState(h, [player("me"), player("you")]);
  assertEquals(pc.closeCount, 0, "繰り返しの roomState でピアが閉じられた");
  assertEquals(h.sent, [], "繰り返しの roomState で何かを送っている");
});

Deno.test("VC: 顔ぶれに人が増えた roomState では、その人にだけ ready を送る", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  const pc = connect(h, "you");
  h.sent.length = 0;

  roomState(h, [player("me"), player("you"), player("new")]);

  assertEquals(pc.closeCount, 0, "増えたのは別人なのに既存のピアが閉じられた");
  assertEquals(orderedPeerIds(h), ["you"], "既存のピアが消えている");
  assertEquals(readySignals(h).map((m) => m.to), ["new"], "新しい相手にだけ ready が飛んでいない");
  assertEquals(
    h.sent.filter((m) => m.to === "you"),
    [],
    "既にいる相手へ余計な signal が飛んでいる",
  );
});

Deno.test("VC: 顔ぶれから消えた人のピアだけを畳む（残りの通話は切らない）", async () => {
  const h = load();
  await joinWith(h, [player("you"), player("him")]);
  const youPc = connect(h, "you");
  const himPc = connect(h, "him");
  h.sent.length = 0;

  // him だけが卓から消えた roomState（playerLeft を取りこぼした場合の保険経路）
  roomState(h, [player("me"), player("you")]);

  assertEquals(himPc.closeCount, 1, "消えた相手のピアが畳まれていない");
  assertEquals(youPc.closeCount, 0, "残っている相手の通話まで切れている");
  assertEquals(orderedPeerIds(h), ["you"], "残るべきピアが残っていない");
  assertEquals(readySignals(h), [], "畳んだだけなのに ready が飛んでいる");
});

Deno.test("VC: 相手が切断中（connected:false）になった roomState でも、その人だけを畳む", async () => {
  const h = load();
  await joinWith(h, [player("you"), player("him")]);
  const youPc = connect(h, "you");
  const himPc = connect(h, "him");
  h.sent.length = 0;

  roomState(h, [player("me"), player("you"), player("him", { connected: false })]);

  assertEquals(himPc.closeCount, 1, "切断中になった相手のピアが畳まれていない");
  assertEquals(youPc.closeCount, 0, "無関係な相手の通話まで切れている");
  assertEquals(orderedPeerIds(h), ["you"], "残るべきピアが残っていない");
});

Deno.test("VC: VC に参加していないあいだの roomState では何も起きない", () => {
  const h = load();
  // join していないので state.active は false のまま
  roomState(h, [player("me"), player("you")]);
  roomState(h, [player("me"), player("you"), player("new")]);

  assertEquals(FakePeerConnection.instances.length, 0, "参加前にピアが張られた");
  assertEquals(h.sent, [], "参加前に signal を送っている");
});

Deno.test("VC: 抜けた人が戻ってきたら、新しい session の ready を送って張り直させる", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  const pc = connect(h, "you");
  const first = readySignals(h, "you")[0];
  assertExists(first, "参加時の ready が飛んでいない");
  const firstSession = first.payload?.session;
  assertExists(firstSession, "ready に session が入っていない");

  // 相手が切断した。こちらはピアを畳む
  h.vc.handleServerMessage({
    t: "playerLeft",
    player: player("you", { connected: false }),
  });
  assertEquals(pc.closeCount, 1, "抜けた相手のピアが畳まれていない");
  h.sent.length = 0;

  // 猶予内に復帰。相手はこちらの死んだピアを抱えたままなので、session を
  // 変えて「前の接続は捨てた」と伝えないと、相手側で張り直しが起きない
  h.vc.handleServerMessage({ t: "playerJoined", player: player("you") });
  const again = readySignals(h, "you")[0];
  assertExists(again, "復帰した相手へ ready が飛んでいない");
  assert(
    again.payload?.session !== firstSession,
    "抜ける前と同じ session を送っている（相手の死んだピアが張り直らない）",
  );
});

Deno.test("VC: 相手の切断を取りこぼしていても、復帰の playerJoined で session を新しくする", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  const pc = connect(h, "you");
  const firstSession = readySignals(h, "you")[0]?.payload?.session;
  assertExists(firstSession, "参加時の ready に session が入っていない");
  h.sent.length = 0;

  // playerLeft を受け取らないまま復帰の playerJoined だけが届く経路
  // （双方がほぼ同時に切れて、こちらが先に戻ったとき）。ピアは生きたまま残っている
  h.vc.handleServerMessage({ t: "playerJoined", player: player("you") });

  assertEquals(pc.closeCount, 1, "古いピアが畳まれていない");
  const again = readySignals(h, "you")[0];
  assertExists(again, "復帰した相手へ ready が飛んでいない");
  assert(
    again.payload?.session !== firstSession,
    "同じ session を送っている（相手の死んだピアが張り直らない）",
  );
});

Deno.test("VC: VC 枠の繰り上がり（H-1）では、繰り上がった人にだけ ready を送る", async () => {
  const h = load();
  // 7人目の「late」は枠の外。この時点では顔ぶれに入らない
  await joinWith(h, [player("you"), player("late", { vcEligible: false })]);
  const youPc = connect(h, "you");
  h.sent.length = 0;

  // サーバーは繰り上がった本人ぶんだけを playerJoined で配る（server/rooms.ts
  // の broadcastVcEligibilityChanges）。ここで卓全体が張り直ってはいけない
  h.vc.handleServerMessage({ t: "playerJoined", player: player("late") });

  assertEquals(youPc.closeCount, 0, "繰り上がりで既存の通話が切れている");
  assertEquals(orderedPeerIds(h), ["you"], "既存のピアが消えている");
  assertEquals(readySignals(h).map((m) => m.to), ["late"], "繰り上がった人にだけ ready が飛ばない");
});

Deno.test("VC: 繰り上がりの直後に得点確定の roomState が来ても、通話は張り直らない", async () => {
  const h = load();
  await joinWith(h, [player("you"), player("late", { vcEligible: false })]);
  const youPc = connect(h, "you");
  h.vc.handleServerMessage({ t: "playerJoined", player: player("late") });
  const latePc = connect(h, "late");
  h.sent.length = 0;

  // 繰り上がりを織り込んだ roomState が後から届く。顔ぶれは既に一致している
  roomState(h, [player("me"), player("you"), player("late")]);

  assertEquals(youPc.closeCount, 0, "得点確定でピアが閉じられた");
  assertEquals(latePc.closeCount, 0, "得点確定で繰り上がった人のピアが閉じられた");
  assertEquals(orderedPeerIds(h), ["you", "late"], "ピアが消えている");
  assertEquals(h.sent, [], "顔ぶれが同じなのに何かを送っている");
});

// ===========================================================================
// H-16: remote description 前の ICE candidate を捨てない
// ===========================================================================

Deno.test("VC: remote description 前に届いた candidate は捨てず、設定後にまとめて流す", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  const pc = connect(h, "you");

  // まだ offer / answer が来ていない。本物ならここで addIceCandidate は失敗する
  receiveCandidate(h, "you", { candidate: "a" });
  receiveCandidate(h, "you", { candidate: "b" });
  await settle();
  assertEquals(pc.candidates, [], "remote description の前に入ってしまっている");
  assertEquals(pc.rejectedCandidates, 0, "溜めずに addIceCandidate を呼んでいる");

  receiveOffer(h, "you");
  await settle();

  assertEquals(
    pc.candidates,
    [{ candidate: "a" }, { candidate: "b" }],
    "溜めた candidate が届いた順に流し込まれていない",
  );
});

Deno.test("VC: 収集完了（candidate: null）も溜めて、順番どおりに流す", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  const pc = connect(h, "you");

  receiveCandidate(h, "you", { candidate: "a" });
  receiveCandidate(h, "you", null);
  await settle();
  receiveOffer(h, "you");
  await settle();

  // null は「収集完了」の合図。addIceCandidate(undefined) として渡る
  assertEquals(pc.candidates, [{ candidate: "a" }, undefined], "収集完了の合図が落ちている");
});

Deno.test("VC: remote description が入った後の candidate は溜めずにそのまま入れる", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  const pc = connect(h, "you");

  receiveOffer(h, "you");
  await settle();
  receiveCandidate(h, "you", { candidate: "late" });
  await settle();

  assertEquals(pc.candidates, [{ candidate: "late" }], "設定後の candidate が入っていない");
  assertEquals(pc.rejectedCandidates, 0, "設定後なのに失敗している");
});

Deno.test("VC: 壊れた candidate が混じっても落ちず、残りは流し込まれる", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  const pc = connect(h, "you");

  // この値を渡されたときだけ偽の addIceCandidate が投げる（壊れた candidate）
  const poison = { candidate: 12345 };
  FakePeerConnection.poison = poison;

  receiveCandidate(h, "you", { candidate: "a" });
  receiveCandidate(h, "you", poison);
  receiveCandidate(h, "you", { candidate: "b" });
  // 型が違うもの・null 以外の非オブジェクトを混ぜても素通りできること
  receiveCandidate(h, "you", "壊れた文字列");
  await settle();

  receiveOffer(h, "you");
  await settle();

  assertEquals(
    pc.candidates,
    [{ candidate: "a" }, { candidate: "b" }, "壊れた文字列"],
    "1件の失敗で残りの candidate まで捨てている",
  );
  assertEquals(orderedPeerIds(h), ["you"], "壊れた candidate でピアが落ちている");
});

Deno.test("VC: ピアを畳んだら溜めた candidate も捨てる（張り直しに前の分が混ざらない）", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  const first = connect(h, "you");

  receiveCandidate(h, "you", { candidate: "old-1" });
  receiveCandidate(h, "you", { candidate: "old-2" });
  await settle();

  // 相手が切断。ピアは畳まれ、溜めていた candidate も一緒に捨てられる
  h.vc.handleServerMessage({ t: "playerLeft", player: player("you", { connected: false }) });
  assertEquals(first.closeCount, 1, "ピアが畳まれていない");
  await settle();

  // 復帰して張り直す。新しいピアには古い candidate が一切流れてはいけない
  h.vc.handleServerMessage({ t: "playerJoined", player: player("you") });
  const second = connect(h, "you", "s-you-2");
  assert(second !== first, "同じ RTCPeerConnection を使い回している");

  receiveCandidate(h, "you", { candidate: "new-1" });
  await settle();
  receiveOffer(h, "you");
  await settle();

  assertEquals(second.candidates, [{ candidate: "new-1" }], "前の接続の candidate が混ざっている");
  assertEquals(first.candidates, [], "畳んだピアに candidate が流し込まれている");
});

Deno.test("VC: 溜め込みには上限があり、溢れたら古い順に捨てる", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  const pc = connect(h, "you");

  // vc.js の MAX_PENDING_CANDIDATES と同じ本数
  const limit = 64;
  const overflow = 10;
  for (let i = 0; i < limit + overflow; i++) receiveCandidate(h, "you", { candidate: `c-${i}` });
  await settle();
  assertEquals(pc.candidates, [], "溜めずに流し込んでいる");

  receiveOffer(h, "you");
  await settle();

  assertEquals(pc.candidates.length, limit, "上限を超えて溜め込んでいる（際限なく増える）");
  assertEquals(
    pc.candidates[0],
    { candidate: `c-${overflow}` },
    "溢れたときに捨てるのが古い順になっていない",
  );
  assertEquals(
    pc.candidates[limit - 1],
    { candidate: `c-${limit + overflow - 1}` },
    "いちばん新しい candidate が残っていない",
  );
});
