/**
 * public/room/vc.js の `ready` 反射レート制限のテスト（監査 06-vc-webrtc #8）。
 *
 * 本題:
 *   `ready` を1件受けると、こちらは **ready の反射・映像状態・マイク状態の3件**を
 *   送り返し、さらにピアを畳んで張り直す。ここに上限が無いと、同室の誰か1人が
 *   毎回違う `session` を名乗って `ready` を連投するだけで、こちらの rtcSignal 枠
 *   （server/types.ts の WS_SIGNAL_RATE_MAX = 100件/秒）をこちらの返信で使い切らせる
 *   ことができる。使い切ると**他のピア**への offer / answer / ICE がサーバー側で
 *   破棄され、その人たちとの通話が成立しなくなる。
 *
 * 上限を入れる修正でいちばん危ないのは「入れすぎ」なので、抑える側と同じ重さで
 * 次の2つを見張る。
 *
 *   過剰抑制の番人 … 正常な接続確立・再接続・相手ごとの独立性が上限に当たらない
 *   詰みの番人     … 一度上限に当たっても、静かになれば再び反応できる
 *                    （当たっているあいだも、相手の offer から張れる保険が生きている）
 *
 * 手口は vc_mesh_test.ts と同じで、偽の DOM・偽の RTCPeerConnection・偽の
 * MediaStream の上に vc.js を new Function で読み込み、素の JavaScript として動かす。
 * 違いは **Date も差し替える**ことだけ。判定窓（1秒）の前後を実時間を待たずに
 * 行き来したいので、時計を試験側で進める。
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createFakeDocument, FakeElement } from "./fake_dom.ts";

const VC_JS = fromFileUrl(new URL("../../public/room/vc.js", import.meta.url));
const source = await Deno.readTextFile(VC_JS);

/** vc.js の READY_ADMIT_WINDOW_MS と同じ値 */
const WINDOW_MS = 1000;
/** vc.js の READY_ADMIT_MAX と同じ値 */
const MAX = 3;
/** 1件の ready を受け入れたときに送り返す件数（ready / video / mic） */
const REPLY_PER_READY = 3;

// ---------------------------------------------------------------------------
// ブラウザ API の偽物（vc_mesh_test.ts と同じ作り）
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

/** RTCPeerConnection の偽物 */
class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState = "connected";
  signalingState = "stable";
  localDescription: Description | null = null;
  remoteDescription: Description | null = null;
  closeCount = 0;
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

  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }

  getStats(): Promise<Map<string, unknown>> {
    return Promise.resolve(new Map());
  }
}

type Payload = { kind?: string; session?: string; description?: Description };
type Sent = { t: string; to?: string; payload?: Payload };

type Player = { id: string; nickname: string; vcEligible: boolean; connected: boolean };

type Harness = {
  // deno-lint-ignore no-explicit-any
  vc: any;
  /** サーバーへ送られた rtcSignal */
  sent: Sent[];
  /** vc.js から見える現在時刻。試験側で進める */
  advance: (ms: number) => void;
  container: FakeElement;
};

/**
 * vc.js を偽の環境で読み込む。
 * Date を差し込むのがここだけの工夫で、vc.js の中の `Date.now()` は
 * new Function の引数として渡したこちらの偽物に解決される（vc.js は無改造）。
 */
function load(): Harness {
  FakePeerConnection.instances = [];
  const sent: Sent[] = [];
  let seq = 1;
  // 実時間に近い値から始める（0 起点だと「時計が巻き戻った」判定と紛れる）
  let clock = 1_700_000_000_000;
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
    "Date",
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
    { now: () => clock },
  );

  vc.init({ send: (msg: Sent) => sent.push(msg), container, onStatus: () => {} });

  return {
    vc,
    sent,
    advance: (ms: number) => {
      clock += ms;
    },
    container,
  };
}

function player(id: string, opts: Partial<Player> = {}): Player {
  return {
    id,
    nickname: id,
    vcEligible: opts.vcEligible ?? true,
    connected: opts.connected ?? true,
  };
}

/** 「わたし」を含む参加者一覧をそのまま roomState として流し込む */
function roomState(h: Harness, players: Player[]): void {
  h.vc.handleServerMessage({ t: "roomState", snapshot: { youId: "me", players } });
}

/** 相手から ready を1件受ける */
function receiveReady(h: Harness, from: string, session: string): void {
  h.vc.handleServerMessage({ t: "rtcSignal", from, payload: { kind: "ready", session } });
}

/** 相手から offer を受ける（ready を取りこぼしたときの保険経路） */
function receiveOffer(h: Harness, from: string, sdp = "v=0"): void {
  h.vc.handleServerMessage({
    t: "rtcSignal",
    from,
    payload: { kind: "desc", description: { type: "offer", sdp } },
  });
}

/** 指定した相手へ送った signal のうち、kind が一致するものだけ */
function signalsTo(h: Harness, to: string, kind?: string): Sent[] {
  return h.sent.filter((m) =>
    m.t === "rtcSignal" && m.to === to && (kind === undefined || m.payload?.kind === kind)
  );
}

/** いま張っているピアの playerId */
function orderedPeerIds(h: Harness): string[] {
  return h.vc.getState().peers.map((p: { id: string }) => p.id);
}

/** マイクロタスクを吐き切らせる */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 「わたし」が VC に参加した状態を作る */
async function joinWith(h: Harness, players: Player[]): Promise<void> {
  roomState(h, [player("me"), ...players]);
  assert(await h.vc.join(), "VC に参加できていない");
}

// ===========================================================================
// 純粋関数 admitReady の判定（境界値・異常系）
// ===========================================================================

Deno.test("VC admitReady: 初めての相手はそのまま受け入れ、窓を開く", () => {
  const h = load();
  const now = 1_000_000;
  assertEquals(h.vc.admitReady(undefined, now), {
    admit: true,
    record: { at: now, count: 1 },
  });
});

Deno.test("VC admitReady: 同じ窓の中では上限まで受け入れ、超えたぶんは捨てる", () => {
  const h = load();
  const at = 1_000_000;
  let record = { at, count: 0 };
  for (let i = 1; i <= MAX; i++) {
    const verdict = h.vc.admitReady(record, at + 10 * i);
    assert(verdict.admit, `窓の中の${i}件目が捨てられている（正常な張り直しを塞いでいる）`);
    assertEquals(verdict.record.count, i, "受け入れた回数が数えられていない");
    assertEquals(verdict.record.at, at, "受け入れるたびに窓の起点がずれている");
    record = verdict.record;
  }
  const over = h.vc.admitReady(record, at + 10 * (MAX + 1));
  assert(!over.admit, "上限を超えた ready を受け入れている");
});

Deno.test("VC admitReady: 捨てたぶんは記録を進めない（窓が延びて締め出されない）", () => {
  const h = load();
  const at = 1_000_000;
  const record = { at, count: MAX };
  // 窓の中で何度捨てても、起点も回数も動かない
  let current = record;
  for (let i = 0; i < 50; i++) {
    const verdict = h.vc.admitReady(current, at + 100 + i);
    assert(!verdict.admit, "上限を超えた ready を受け入れている");
    current = verdict.record;
  }
  assertEquals(current, { at, count: MAX }, "捨てたぶんで窓が延びている（詰みの原因になる）");
  // 窓が明ければ受け入れに戻る
  const after = h.vc.admitReady(current, at + WINDOW_MS);
  assert(after.admit, "窓が明けても受け入れに戻らない");
});

Deno.test("VC admitReady: 窓の境界ちょうどで開き直す（1ミリ秒手前は同じ窓）", () => {
  const h = load();
  const at = 1_000_000;
  const full = { at, count: MAX };
  assert(
    !h.vc.admitReady(full, at + WINDOW_MS - 1).admit,
    "窓が明ける1ミリ秒手前で受け入れている",
  );
  const boundary = h.vc.admitReady(full, at + WINDOW_MS);
  assert(boundary.admit, "窓の境界ちょうどで受け入れていない");
  assertEquals(
    boundary.record,
    { at: at + WINDOW_MS, count: 1 },
    "新しい窓が開き直されていない",
  );
});

Deno.test("VC admitReady: 端末の時計が巻き戻っても締め出さない", () => {
  const h = load();
  const at = 1_000_000;
  const full = { at, count: MAX };
  // now < at。放っておくと now - at が負のまま窓が明けず、永久に締め出される
  const verdict = h.vc.admitReady(full, at - 60_000);
  assert(verdict.admit, "時計が巻き戻ると受け入れられなくなる（詰む）");
  assertEquals(verdict.record, { at: at - 60_000, count: 1 }, "窓が開き直されていない");
});

Deno.test("VC admitReady: 壊れた記録は新しい窓として扱う", () => {
  const h = load();
  const now = 1_000_000;
  for (const broken of [null, {}, { at: "x", count: 1 }, { at: 1, count: "y" }]) {
    const verdict = h.vc.admitReady(broken, now);
    assert(verdict.admit, `壊れた記録（${JSON.stringify(broken)}）で受け入れが止まっている`);
    assertEquals(verdict.record, { at: now, count: 1 }, "窓が開き直されていない");
  }
});

// ===========================================================================
// 過剰抑制の番人 — 正常な接続確立・再接続を塞がないこと
// ===========================================================================

Deno.test("VC ready制限: ふつうの接続確立（相手1人が1回 ready）はそのまま通る", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  h.sent.length = 0;

  receiveReady(h, "you", "s-you-1");

  assertEquals(signalsTo(h, "you", "ready").length, 1, "ready が返っていない");
  assertEquals(signalsTo(h, "you", "video").length, 1, "映像状態が返っていない");
  assertEquals(signalsTo(h, "you", "mic").length, 1, "マイク状態が返っていない");
  assertEquals(orderedPeerIds(h), ["you"], "ピアが張られていない");
});

Deno.test("VC ready制限: 上限は相手ごとに独立していて、他の人への返信を巻き添えにしない", async () => {
  const h = load();
  const others = ["a", "b", "c", "d", "e"];
  await joinWith(h, others.map((id) => player(id)));
  h.sent.length = 0;

  // 「a」が上限いっぱいまで連投しても、それは a の枠だけを使う
  for (let i = 0; i < MAX + 5; i++) receiveReady(h, "a", `s-a-${i}`);
  for (const id of others.slice(1)) receiveReady(h, id, `s-${id}-1`);

  for (const id of others.slice(1)) {
    assertEquals(signalsTo(h, id, "ready").length, 1, `${id} への ready が巻き添えで消えている`);
  }
  assertEquals(orderedPeerIds(h).sort(), others.sort(), "巻き添えでピアが張られていない");
});

Deno.test("VC ready制限: 同じ session の連投は枠を使わない（正常な相手を枯らさない）", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  receiveReady(h, "you", "s-you-1");
  h.sent.length = 0;

  // 同じ session の ready は元から「返事をしない」打ち止めの対象。
  // ここで枠を消費してしまうと、後から来た正当な張り直しが弾かれる
  for (let i = 0; i < 20; i++) receiveReady(h, "you", "s-you-1");
  assertEquals(h.sent, [], "同じ session の ready に反応している");

  // 枠は減っていないので、本物の張り直しはまだ MAX-1 回ぶん通る
  for (let i = 2; i <= MAX; i++) receiveReady(h, "you", `s-you-${i}`);
  assertEquals(
    signalsTo(h, "you", "ready").length,
    MAX - 1,
    "同じ session の連投で枠が食われている",
  );
});

Deno.test("VC ready制限: 回線の悪い相手が窓の中で上限回まで張り直しても全部通る", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  h.sent.length = 0;

  for (let i = 1; i <= MAX; i++) receiveReady(h, "you", `s-you-${i}`);

  assertEquals(signalsTo(h, "you", "ready").length, MAX, "正常な張り直しが途中で塞がれている");
  assertEquals(orderedPeerIds(h), ["you"], "張り直しの結果ピアが残っていない");
});

Deno.test("VC ready制限: 窓をまたいで張り直す相手は何度でも通る", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  h.sent.length = 0;

  // 1秒おきの再接続を10回。ふつうの再接続バックオフはこれより長い
  for (let i = 1; i <= 10; i++) {
    receiveReady(h, "you", `s-you-${i}`);
    h.advance(WINDOW_MS);
  }

  assertEquals(signalsTo(h, "you", "ready").length, 10, "窓をまたいだ張り直しが塞がれている");
});

// ===========================================================================
// 上限そのもの — 1人に枠を枯らされないこと
// ===========================================================================

Deno.test("VC ready制限: 違う session の ready を連投されても、返信は上限で頭打ちになる", async () => {
  const h = load();
  await joinWith(h, [player("you"), player("him")]);
  h.sent.length = 0;

  // 悪意ある（あるいは壊れた）クライアントの連投。1件あたり3件を返させる狙い
  for (let i = 0; i < 100; i++) receiveReady(h, "you", `s-you-${i}`);

  assertEquals(signalsTo(h, "you", "ready").length, MAX, "ready の反射に上限が効いていない");
  assertEquals(signalsTo(h, "you", "video").length, MAX, "映像状態の送信に上限が効いていない");
  assertEquals(signalsTo(h, "you", "mic").length, MAX, "マイク状態の送信に上限が効いていない");
  assertEquals(
    h.sent.length,
    MAX * REPLY_PER_READY,
    "100件の ready で送信件数が上限を超えている（rtcSignal 枠が枯れる）",
  );
});

Deno.test("VC ready制限: 上限を超えたぶんではピアを畳まない（切られっぱなしにしない）", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  receiveReady(h, "you", "s-you-1");
  const pcs = FakePeerConnection.instances.length;

  // 上限に当たるまで連投させる
  for (let i = 2; i < 50; i++) receiveReady(h, "you", `s-you-${i}`);

  // 受け入れたぶん（MAX 回）だけ畳んで張り直す。捨てたぶんでは畳まない
  assertEquals(
    FakePeerConnection.instances.length - pcs,
    MAX - 1,
    "捨てたはずの ready でもピアを作り直している",
  );
  assertEquals(orderedPeerIds(h), ["you"], "ピアが畳まれたまま張り直されていない");
});

Deno.test("VC ready制限: 上限に当たっているあいだも、相手の offer からはピアを張れる", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  // 参加時にこちらから送った ready は数えない
  h.sent.length = 0;
  // ピアをまだ張っていない状態で連投され、枠を使い切る
  for (let i = 0; i < 50; i++) receiveReady(h, "you", `s-you-${i}`);
  assertEquals(
    signalsTo(h, "you", "ready").length,
    MAX,
    "前提が崩れている（上限に当たっていない）",
  );

  // 新しい相手「him」の ready を捨てても、offer が来れば onDescription の
  // 保険（ensurePeer）でピアは張られる。ここが死ぬと「繋がらない」になる
  h.sent.length = 0;
  receiveOffer(h, "him");
  await settle();
  assert(orderedPeerIds(h).includes("him"), "offer からピアが張られていない");
});

// ===========================================================================
// 詰みの番人 — 一度当たっても復帰できること
// ===========================================================================

Deno.test("VC ready制限: 窓が明ければ、同じ相手の ready にまた反応する", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  h.sent.length = 0;

  for (let i = 0; i < 50; i++) receiveReady(h, "you", `s-you-${i}`);
  assertEquals(
    signalsTo(h, "you", "ready").length,
    MAX,
    "前提が崩れている（上限に当たっていない）",
  );
  h.sent.length = 0;

  // 連投が止まって窓が明けた。ここで反応が戻らないと、暴れた相手とは
  // 二度と繋がり直せない（＝上限が別の不具合になる）
  h.advance(WINDOW_MS);
  receiveReady(h, "you", "s-you-calm");

  assertEquals(signalsTo(h, "you", "ready").length, 1, "窓が明けても ready が返らない");
  assertEquals(signalsTo(h, "you", "video").length, 1, "窓が明けても映像状態が返らない");
  assertEquals(signalsTo(h, "you", "mic").length, 1, "窓が明けても マイク状態が返らない");
  assertEquals(orderedPeerIds(h), ["you"], "窓が明けてもピアが張り直されない");
});

Deno.test("VC ready制限: 連投が続いているあいだも、窓ごとに上限ぶんは通る（完全には黙らない）", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  h.sent.length = 0;

  let session = 0;
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 30; i++) receiveReady(h, "you", `s-${session++}`);
    h.advance(WINDOW_MS);
  }

  assertEquals(
    signalsTo(h, "you", "ready").length,
    MAX * 3,
    "窓ごとに上限ぶんを通していない（捨てたぶんで窓が延びている）",
  );
});

Deno.test("VC ready制限: VC を抜けて入り直したら記録は捨てる", async () => {
  const h = load();
  await joinWith(h, [player("you")]);
  // 参加時にこちらから送った ready は数えない
  h.sent.length = 0;
  for (let i = 0; i < 50; i++) receiveReady(h, "you", `s-you-${i}`);
  assertEquals(
    signalsTo(h, "you", "ready").length,
    MAX,
    "前提が崩れている（上限に当たっていない）",
  );

  // 抜けて入り直す。前の通話の記録を持ち越すと、入り直した直後の
  // 接続確立だけが弾かれる（同じ窓の中で入り直したときに効く）
  h.vc.leave();
  h.sent.length = 0;
  assert(await h.vc.join(), "VC に入り直せていない");
  h.sent.length = 0;

  receiveReady(h, "you", "s-you-new");
  assertEquals(signalsTo(h, "you", "ready").length, 1, "入り直した後も前の記録で弾いている");
});
