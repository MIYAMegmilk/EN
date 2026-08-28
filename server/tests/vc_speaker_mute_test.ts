/**
 * public/room/vc.js のスピーカーミュート（他の人の VC 音声だけを手元で消す）と、
 * マイクのミュートを文字起こしへ伝える口（init の onMicMute）のテスト。
 *
 * 本題は次の4つ。
 *
 *   1. 消したら相手の声が実際に止まること。鳴らしているのはピアごとの
 *      <audio> なので、そこが muted になっているかを見る
 *   2. **相手に伝わらない**こと。誰が自分の声を消しているかは相手に知らせる
 *      情報ではないので、押しても rtcSignal は1件も飛ばない（受信トラックを
 *      止める・direction を変える手を採ると、ここが崩れる）
 *   3. マイクのミュートとは独立であること。押しても自分の声は止まらないし、
 *      逆にマイクをミュートしても相手の声は聞こえたままになる
 *   4. マイクのミュートが onMicMute で外へ流れること。これが無いと
 *      文字起こし（voice.js）がミュート中も動き続ける
 *
 * 手口は vc_presence_test.ts / vc_mesh_test.ts と同じで、偽の DOM・偽の
 * RTCPeerConnection・偽の MediaStream の上に vc.js を new Function で読み込み、
 * Deno から素の JavaScript として動かす。
 *
 * 偽の環境には AudioContext を置かない（発話検知は特徴検出で素通りする）。
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
  ontrack: ((event: { track: FakeTrack }) => void) | null = null;
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
  /** onMicMute で外へ流れたミュート状態（voice.js へ渡る値） */
  micMutes: boolean[];
  /** 自分のマイクのトラック（ミュートが独立していることの確認用） */
  micTracks(): FakeTrack[];
};

/** vc.js を偽の環境で読み込む */
function load(): Harness {
  FakePeerConnection.instances = [];
  const sent: Sent[] = [];
  const micMutes: boolean[] = [];
  const micStreams: FakeStream[] = [];
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
        getUserMedia: (constraints: { video?: unknown }) => {
          const stream = new FakeStream([
            new FakeTrack(constraints.video === false ? "audio" : "video"),
          ]);
          if (constraints.video === false) micStreams.push(stream);
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
    onMicMute: (muted: boolean) => micMutes.push(muted),
  });

  return {
    vc,
    sent,
    container,
    micMutes,
    micTracks: () => micStreams.flatMap((s) => s.getAudioTracks()),
  };
}

type Player = { id: string; nickname: string; vcEligible: boolean; connected: boolean };

function player(id: string, nickname: string): Player {
  return { id, nickname, vcEligible: true, connected: true };
}

/** 卓の顔ぶれを流し込む */
function roomState(h: Harness, players: Player[]): void {
  h.vc.handleServerMessage({ t: "roomState", snapshot: { youId: "me", players } });
}

/** 相手の ready を受けてピアを1本張る */
function acceptReady(h: Harness, from: string): void {
  h.vc.handleServerMessage({
    t: "rtcSignal",
    from,
    payload: { kind: "ready", session: `s-${from}` },
  });
}

/** 自分（me）と相手たちがいる卓に入る */
async function joinWith(h: Harness, others: string[]): Promise<void> {
  roomState(h, [player("me", "わたし"), ...others.map((id) => player(id, id))]);
  assert(await h.vc.join(), "VC に参加できていない");
  for (const id of others) acceptReady(h, id);
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

/** 枠の中で相手の声を鳴らしている audio 要素（class を持たないので tagName で引く） */
function peerAudio(h: Harness, playerId: string): FakeElement {
  const found = peerTile(h, playerId).children.find((c) => c.tagName === "audio");
  assertExists(found, `${playerId} の audio が無い`);
  return found;
}

/** 枠の「声を消しています」札 */
function deafMark(tile: FakeElement): FakeElement {
  const found = tile.querySelector(".vc-deaf-mark");
  assertExists(found, "スピーカーミュートの札が無い");
  return found;
}

// ===========================================================================
// 1. 消したら相手の声が止まる
// ===========================================================================

Deno.test("VC: スピーカーミュートで相手の声が止まり、解除で戻る", async () => {
  const h = load();
  await joinWith(h, ["you", "nomi"]);
  assertEquals(peerAudio(h, "you").muted, false, "何もしていないのに消えている");

  assertEquals(h.vc.setSpeakerMuted(true), true);
  assertEquals(h.vc.getState().speakerMuted, true);
  assertEquals(peerAudio(h, "you").muted, true, "相手の声が止まっていない");
  assertEquals(peerAudio(h, "nomi").muted, true, "卓の全員に効いていない");

  assertEquals(h.vc.setSpeakerMuted(false), false);
  assertEquals(peerAudio(h, "you").muted, false, "解除しても声が戻らない");
  assertEquals(peerAudio(h, "nomi").muted, false);
});

Deno.test("VC: スピーカーミュートは押すたびに裏返る", async () => {
  const h = load();
  await joinWith(h, ["you"]);
  assertEquals(h.vc.toggleSpeakerMute(), true);
  assertEquals(peerAudio(h, "you").muted, true);
  assertEquals(h.vc.toggleSpeakerMute(), false);
  assertEquals(peerAudio(h, "you").muted, false);
});

Deno.test("VC: 消しているあいだに入ってきた相手にも効く", async () => {
  const h = load();
  await joinWith(h, ["you"]);
  h.vc.setSpeakerMuted(true);

  // 後から「のみすけ」が卓に着く
  roomState(h, [player("me", "わたし"), player("you", "you"), player("nomi", "のみすけ")]);
  acceptReady(h, "nomi");

  assertEquals(peerAudio(h, "nomi").muted, true, "途中参加の人の声だけ聞こえてしまっている");
  assertEquals(deafMark(peerTile(h, "nomi")).hidden, false, "途中参加の枠に札が出ていない");
});

Deno.test("VC: 声が届いた後（ontrack）も消えたままになる", async () => {
  const h = load();
  await joinWith(h, ["you"]);
  h.vc.setSpeakerMuted(true);

  // 相手の音声トラックが届く。vc.js はここで srcObject を張り直す
  const pc = FakePeerConnection.instances[0];
  assertExists(pc, "ピアが張られていない");
  pc.ontrack?.({ track: new FakeTrack("audio") });

  assertEquals(peerAudio(h, "you").muted, true, "トラックの到着で消音が外れている");

  // 声が届いた後で戻せば、そのまま鳴り出す
  h.vc.setSpeakerMuted(false);
  assertEquals(peerAudio(h, "you").muted, false);
});

// ===========================================================================
// 2. 相手には伝わらない
// ===========================================================================

Deno.test("VC: スピーカーミュートは相手に伝えない（rtcSignal が飛ばない）", async () => {
  const h = load();
  await joinWith(h, ["you"]);
  h.sent.length = 0;

  h.vc.setSpeakerMuted(true);
  h.vc.setSpeakerMuted(false);

  assertEquals(
    h.sent,
    [],
    "聞いていないことが相手に伝わる作りになっている（誰が消しているかは知らせない）",
  );
});

// ===========================================================================
// 3. マイクのミュートとは独立
// ===========================================================================

Deno.test("VC: スピーカーミュートでは自分の声は止まらない", async () => {
  const h = load();
  await joinWith(h, ["you"]);
  h.vc.setSpeakerMuted(true);

  assertEquals(h.vc.getState().muted, false, "スピーカーを消したらマイクまで切れている");
  for (const track of h.micTracks()) {
    assertEquals(track.enabled, true, "自分のマイクのトラックが止められている");
  }
});

Deno.test("VC: マイクをミュートしても相手の声は聞こえたままにする", async () => {
  const h = load();
  await joinWith(h, ["you"]);
  h.vc.setMuted(true);

  assertEquals(h.vc.getState().speakerMuted, false);
  assertEquals(peerAudio(h, "you").muted, false, "マイクのミュートで相手の声まで消えている");
  assertEquals(deafMark(peerTile(h, "you")).hidden, true, "マイクのミュートで札が出ている");
});

// ===========================================================================
// 4. 卓上の表示
// ===========================================================================

Deno.test("VC: 消しているあいだだけ、相手の枠に札を出す", async () => {
  const h = load();
  await joinWith(h, ["you"]);
  const tile = peerTile(h, "you");
  assertEquals(deafMark(tile).hidden, true, "何もしていないのに札が出ている");
  assertEquals(
    deafMark(tile).attributes.get("aria-label"),
    "この人の声を消しています",
    "読み上げ名が入っていない",
  );

  h.vc.setSpeakerMuted(true);
  assertEquals(deafMark(tile).hidden, false, "消しているのに札が出ない");

  h.vc.setSpeakerMuted(false);
  assertEquals(deafMark(tile).hidden, true, "戻したのに札が残っている");
});

Deno.test("VC: 自分の枠には札を出さない（自分の声は元から鳴っていない）", async () => {
  const h = load();
  await joinWith(h, ["you"]);
  h.vc.setSpeakerMuted(true);
  assertEquals(
    selfTile(h).querySelector(".vc-deaf-mark"),
    null,
    "自分の枠に「声を消しています」と出ている",
  );
});

// ===========================================================================
// 5. マイクのミュートを外へ伝える（文字起こしを止めるため）
// ===========================================================================

Deno.test("VC: マイクのミュートを onMicMute で外へ伝える", async () => {
  const h = load();
  await joinWith(h, ["you"]);
  // 参加した時点で「ミュートしていない」が1件流れる（前の卓の状態を残さない）
  assertEquals(h.micMutes, [false]);

  h.vc.toggleMute();
  assertEquals(h.micMutes.at(-1), true, "ミュートが文字起こしへ伝わっていない");
  h.vc.toggleMute();
  assertEquals(h.micMutes.at(-1), false, "解除が文字起こしへ伝わっていない");
});

Deno.test("VC: ミュートしたまま卓を畳んでも、解除が伝わる", async () => {
  const h = load();
  await joinWith(h, ["you"]);
  h.vc.setMuted(true);
  assertEquals(h.micMutes.at(-1), true);

  h.vc.teardown();
  assertEquals(
    h.micMutes.at(-1),
    false,
    "VC を畳んだのにミュート中のままで、文字起こしが止まりっぱなしになる",
  );
});

Deno.test("VC: onMicMute を渡していなくても壊れない（開発用ページ）", async () => {
  const h = load();
  // init を渡し直して onMicMute を外す（voice.js が載っていないページの想定）
  h.vc.init({ send: (msg: Sent) => h.sent.push(msg), container: h.container, onStatus: () => {} });
  await joinWith(h, ["you"]);
  h.vc.toggleMute();
  assertEquals(h.vc.getState().muted, true);
});
