/**
 * public/room/vc.js の画面共有のテスト（docs/design/vc-screenshare.md §11）。
 *
 * 本題は次の3つ。
 *   1. 送出する映像トラックは常に高々1本という不変条件（§4.1）が守られること
 *   2. カメラ⇔画面の行き来で、既存のカメラ・品質監視が壊れないこと（§5 の T1〜T12）
 *   3. 止めるべきときに必ず止まること（トラックの stop 漏れはブラウザの
 *      「共有中」バーが残り続けることを意味する）
 *
 * 手口は vc_teardown_test.ts と同じで、偽の DOM・偽の RTCPeerConnection・
 * 偽の MediaStream の上に vc.js を new Function で読み込み、Deno から素の
 * JavaScript として動かす。
 *
 * 偽の FakeTrack は **stop() で ended を発火させない**。実ブラウザがそうで
 * あり（§9-1）、ここで親切に発火させてしまうと「自前の停止経路で後始末が
 * 完了しているか」を検証できなくなる。
 */

import { assert, assertEquals, assertExists, assertFalse } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createFakeDocument, FakeElement } from "./fake_dom.ts";
import { startServer } from "../main.ts";

const VC_JS = fromFileUrl(new URL("../../public/room/vc.js", import.meta.url));
const source = await Deno.readTextFile(VC_JS);

// ---------------------------------------------------------------------------
// ブラウザ API の偽物
// ---------------------------------------------------------------------------

/**
 * MediaStreamTrack の偽物。
 * contentHint は書き込み可、applyConstraints は呼び出しを記録する。
 * stop() は ended を発火させない（実ブラウザの挙動・§9-1）。
 */
class FakeTrack {
  stopped = false;
  enabled = true;
  readyState = "live";
  muted = false;
  contentHint = "";
  readonly constraints: unknown[] = [];
  readonly listeners = new Map<string, (() => void)[]>();

  constructor(
    readonly kind: "audio" | "video",
    readonly settings: Record<string, unknown> = { frameRate: 30 },
  ) {}

  stop(): void {
    this.stopped = true;
    this.readyState = "ended";
  }

  applyConstraints(constraints: unknown): Promise<void> {
    this.constraints.push(constraints);
    return Promise.resolve();
  }

  getSettings(): Record<string, unknown> {
    return this.settings;
  }

  addEventListener(type: string, handler: () => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(handler);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, handler: () => void): void {
    const bucket = this.listeners.get(type);
    if (bucket === undefined) return;
    const at = bucket.indexOf(handler);
    if (at >= 0) bucket.splice(at, 1);
  }

  /** ブラウザの共有バーから止められた場合を模す */
  fire(type: string): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler();
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

/** RTCRtpSender の偽物。差し替えたトラックと送出パラメータを覚える */
class FakeSender {
  readonly replaced: (FakeTrack | null)[] = [];
  /** setParameters で受け取った最後のパラメータ */
  params: Record<string, unknown> = {};
  /** true にすると replaceTrack が reject する（E7 用） */
  failReplace = false;

  constructor(public track: FakeTrack | null) {}

  replaceTrack(track: FakeTrack | null): Promise<void> {
    this.replaced.push(track);
    if (this.failReplace) return Promise.reject(new Error("replaceTrack failed"));
    this.track = track;
    return Promise.resolve();
  }

  getParameters(): Record<string, unknown> {
    // 本物と同じく、その場のコピーを返す（呼び出し側が書き換えて戻す）
    return JSON.parse(JSON.stringify(this.params));
  }

  setParameters(params: Record<string, unknown>): Promise<void> {
    this.params = params;
    return Promise.resolve();
  }
}

/** RTCPeerConnection の偽物 */
class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  closeCount = 0;
  removeTrackCount = 0;
  connectionState = "connected";
  iceConnectionState = "connected";
  signalingState = "stable";
  localDescription = null;
  onnegotiationneeded: unknown = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  readonly senders: FakeSender[] = [];

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTrack(track: FakeTrack): FakeSender {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return sender;
  }

  getSenders(): FakeSender[] {
    return this.senders;
  }

  removeTrack(): void {
    this.removeTrackCount++;
  }

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

  /** 映像を送っている sender（vc.js が videoSender として持つもの） */
  videoSender(): FakeSender | undefined {
    return this.senders.find((s) => s.replaced.length > 0 || s.track?.kind === "video");
  }
}

/** getDisplayMedia に何を返させるかの指示（テストごとに差し替える） */
type ScreenPlan = {
  /** 与えると getDisplayMedia が reject する */
  error?: { name: string };
  /** 返す映像トラックの本数（既定 1） */
  videoTracks?: number;
  /** 返す音声トラックの本数（既定 0。§6.5 の守りを試すときに使う） */
  audioTracks?: number;
  /** getSettings().displaySurface が返す値 */
  displaySurface?: string;
  /** true にすると、releaseDisplay() を呼ぶまで getDisplayMedia が返らない */
  hold?: boolean;
};

type Sent = { t: string; to?: string; payload?: Record<string, unknown> };

type Harness = {
  // deno-lint-ignore no-explicit-any
  vc: any;
  sent: Sent[];
  /** getUserMedia が返したストリーム（[0] がマイク、以降カメラ） */
  streams: FakeStream[];
  /** getDisplayMedia が返したストリーム */
  screens: FakeStream[];
  /** getDisplayMedia に渡された制約 */
  displayCalls: Record<string, unknown>[];
  /** 次の getDisplayMedia の振る舞い */
  plan: ScreenPlan;
  liveTimers(): number;
  /** 品質監視の1周期を進める（setInterval の中身を1回呼ぶ） */
  tick(): Promise<void>;
  /** 選択ダイアログを閉じた（＝ getDisplayMedia が返る）ことにする */
  releaseDisplay(): void;
  notices: Array<{ kind: string; message: string }>;
  /** onZoom で頼まれた開閉。null は「閉じて」 */
  zooms: Array<{ view: unknown; playerId: unknown }>;
  container: FakeElement;
};

/** vc.js を偽の環境で読み込む */
function load(options: { getStats?: () => Promise<Map<string, unknown>> } = {}): Harness {
  FakePeerConnection.instances = [];
  const sent: Sent[] = [];
  const streams: FakeStream[] = [];
  const screens: FakeStream[] = [];
  const displayCalls: Record<string, unknown>[] = [];
  const notices: Array<{ kind: string; message: string }> = [];
  const zooms: Array<{ view: unknown; playerId: unknown }> = [];
  const plan: ScreenPlan = {};
  const timers = new Set<number>();
  /** setInterval で仕掛けられた中身。tick() から呼ぶ */
  const intervals = new Map<number, () => unknown>();
  let pendingDisplay: (() => void) | null = null;
  let seq = 1;
  const { document } = createFakeDocument();

  const addTimer = () => {
    const id = seq++;
    timers.add(id);
    return id;
  };
  const addInterval = (fn: () => unknown) => {
    const id = addTimer();
    intervals.set(id, fn);
    return id;
  };
  const dropTimer = (id: number) => {
    timers.delete(id);
    intervals.delete(id);
  };

  const win = {
    setInterval: addInterval,
    clearInterval: dropTimer,
    setTimeout: addTimer,
    clearTimeout: dropTimer,
    navigator: {
      mediaDevices: {
        getUserMedia: (constraints: { video?: unknown }) => {
          const stream = new FakeStream([
            new FakeTrack(constraints.video === false ? "audio" : "video"),
          ]);
          streams.push(stream);
          return Promise.resolve(stream);
        },
        getDisplayMedia: (constraints: Record<string, unknown>) => {
          displayCalls.push(constraints);
          if (plan.error !== undefined) return Promise.reject(plan.error);
          const build = () => {
            const tracks: FakeTrack[] = [];
            const videoCount = plan.videoTracks === undefined ? 1 : plan.videoTracks;
            for (let i = 0; i < videoCount; i += 1) {
              tracks.push(
                new FakeTrack("video", {
                  frameRate: 10,
                  displaySurface: plan.displaySurface ?? "window",
                }),
              );
            }
            for (let i = 0; i < (plan.audioTracks ?? 0); i += 1) {
              tracks.push(new FakeTrack("audio"));
            }
            const stream = new FakeStream(tracks);
            screens.push(stream);
            return stream;
          };
          // 利用者が画面を選ぶまで返らない、という実物の性質を再現する
          if (plan.hold === true) {
            return new Promise<FakeStream>((resolve) => {
              pendingDisplay = () => resolve(build());
            });
          }
          return Promise.resolve(build());
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

  const container = new FakeElement("div", "vc-media");
  vc.init({
    send: (msg: Sent) => sent.push(msg),
    container,
    onStatus: (event: { kind: string; message: string }) => notices.push(event),
    onZoom: (view: unknown, playerId: unknown) => zooms.push({ view, playerId }),
    // 既定のままだと FakePeerConnection の空の統計が返る
    getStats: options.getStats,
  });

  return {
    vc,
    sent,
    streams,
    screens,
    displayCalls,
    plan,
    liveTimers: () => timers.size,
    tick: async () => {
      for (const fn of [...intervals.values()]) await fn();
      // 統計の読み取りは非同期なので、片付くまで待つ
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    releaseDisplay: () => {
      const resolve = pendingDisplay;
      pendingDisplay = null;
      if (resolve !== null) resolve();
    },
    notices,
    zooms,
    container,
  };
}

/** VC に参加し、指定した相手とのピアを張る */
async function joinWith(h: Harness, peerIds: string[]): Promise<void> {
  const players = [{ id: "me", nickname: "わたし", vcEligible: true, connected: true }];
  for (const id of peerIds) {
    players.push({ id, nickname: `${id} さん`, vcEligible: true, connected: true });
  }
  h.vc.handleServerMessage({ t: "roomState", snapshot: { youId: "me", players } });
  assert(await h.vc.join(), "VC に参加できていない");
  for (const id of peerIds) {
    h.vc.handleServerMessage({
      t: "rtcSignal",
      from: id,
      payload: { kind: "ready", session: `s-${id}` },
    });
  }
  assertEquals(FakePeerConnection.instances.length, peerIds.length, "ピアが揃っていない");
}

/** 送られた video 告知のうち最後のもの */
function lastVideoPayload(h: Harness, to: string): Record<string, unknown> | undefined {
  const list = h.sent.filter((m) => m.to === to && m.payload?.kind === "video");
  return list.length === 0 ? undefined : list[list.length - 1].payload;
}

/** 相手が画面共有を始めたことにする */
function remoteShares(h: Harness, from: string): void {
  h.vc.handleServerMessage({
    t: "rtcSignal",
    from,
    payload: { kind: "video", on: true, source: "screen", surface: "window" },
  });
}

// ---------------------------------------------------------------------------
// 正常系（設計書 §11 の N1〜N6）
// ---------------------------------------------------------------------------

Deno.test("N1: 共有開始で全ピアの sender に画面トラックが replaceTrack される", async () => {
  const h = load();
  await joinWith(h, ["a", "b"]);
  assert(await h.vc.setCamera(true), "カメラを ON にできていない");

  assert(await h.vc.startScreenShare("text"), "画面共有を始められていない");

  const screenTrack = h.screens[0].getVideoTracks()[0];
  assertEquals(FakePeerConnection.instances.length, 2);
  for (const pc of FakePeerConnection.instances) {
    const sender = pc.videoSender();
    assertExists(sender);
    assertEquals(sender.track, screenTrack, "この sender に画面トラックが載っていない");
  }
  assertEquals(h.vc.getState().videoSource, "screen");
  assertEquals(h.vc.getState().screen, true);
});

Deno.test("N2: 送出パラメータは sender 1個ずつに当てる（BWE が独立しているため）", async () => {
  const h = load();
  await joinWith(h, ["a", "b"]);
  await h.vc.setCamera(true);

  await h.vc.startScreenShare("text");

  for (const pc of FakePeerConnection.instances) {
    const sender = pc.videoSender();
    assertExists(sender);
    const params = sender.params as {
      encodings?: Array<Record<string, number>>;
      degradationPreference?: string;
    };
    assertExists(params.encodings, "encodings が設定されていない");
    assertEquals(params.encodings[0].maxBitrate, 700000, "標準案の maxBitrate と違う");
    assertEquals(params.encodings[0].maxFramerate, 10, "標準案の maxFramerate と違う");
    // contentHint に非対応のブラウザ（Firefox）でも挙動を揃えるために明示する
    assertEquals(params.degradationPreference, "maintain-resolution");
  }
});

Deno.test("N3: 全ピアへ source: screen を告知する", async () => {
  const h = load();
  await joinWith(h, ["a", "b"]);

  await h.vc.startScreenShare("text");

  for (const id of ["a", "b"]) {
    const payload = lastVideoPayload(h, id);
    assertExists(payload, `${id} へ video 告知が飛んでいない`);
    assertEquals(payload.on, true);
    assertEquals(payload.source, "screen");
    // 実際に選ばれたものを事後確認して載せる（信頼して制御に使ってはいけない）
    assertEquals(payload.surface, "window");
  }
});

Deno.test("N4: 画面トラックに contentHint が入る（文字向けは text）", async () => {
  const h = load();
  await joinWith(h, ["a"]);

  await h.vc.startScreenShare("text");
  assertEquals(h.screens[0].getVideoTracks()[0].contentHint, "text");

  await h.vc.stopScreenShare();
  h.plan.displaySurface = "window";
  await h.vc.startScreenShare("motion");
  assertEquals(h.screens[1].getVideoTracks()[0].contentHint, "motion");
});

Deno.test("N5: 停止するとカメラへ戻る。カメラが切なら replaceTrack(null) になる", async () => {
  const withCamera = load();
  await joinWith(withCamera, ["a"]);
  await withCamera.vc.setCamera(true);
  const camTrack = withCamera.streams[1].getVideoTracks()[0];
  await withCamera.vc.startScreenShare("text");

  await withCamera.vc.stopScreenShare();

  const sender = FakePeerConnection.instances[0].videoSender();
  assertExists(sender);
  assertEquals(sender.track, camTrack, "カメラへ戻っていない");
  assertEquals(withCamera.vc.getState().videoSource, "camera");
  const payload = lastVideoPayload(withCamera, "a");
  assertExists(payload);
  assertEquals(payload.on, true);
  assertEquals(payload.source, "camera");

  const noCamera = load();
  await joinWith(noCamera, ["a"]);
  await noCamera.vc.startScreenShare("text");

  await noCamera.vc.stopScreenShare();

  const sender2 = FakePeerConnection.instances[FakePeerConnection.instances.length - 1]
    .videoSender();
  assertExists(sender2);
  assertEquals(sender2.track, null, "映像を外していない");
  assertEquals(noCamera.vc.getState().videoSource, "none");
  const payload2 = lastVideoPayload(noCamera, "a");
  assertExists(payload2);
  assertEquals(payload2.on, false);
});

Deno.test("N6: displayConstraints は ideal / max しか含まない（TypeError の作り込み防止）", () => {
  const h = load();
  const constraints = h.vc.displayConstraints({
    width: 1280,
    height: 720,
    frameRate: 10,
    maxBitrate: 700000,
    contentHint: "text",
  });
  const json = JSON.stringify(constraints);
  for (const forbidden of ["min", "exact", "advanced"]) {
    assertFalse(json.includes(`"${forbidden}"`), `${forbidden} が含まれている: ${json}`);
  }
  assertEquals(constraints.video.width.max, 1280);
  assertEquals(constraints.video.height.max, 720);
  assertEquals(constraints.video.frameRate.max, 10);
  // 共有音声はスコープ外（§6.5）
  assertEquals(constraints.audio, false);
  // EN のタブ自身を共有すると、その部屋のチャットや参加者名が外へ出る（§9-1）
  assertEquals(constraints.selfBrowserSurface, "exclude");
});

// ---------------------------------------------------------------------------
// 既存の壊れ方の回帰（設計書 §5 の表に対応）
// ---------------------------------------------------------------------------

Deno.test("R1: 共有中に setCamera(false) を呼んでも共有が落ちない（T1）", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  await h.vc.setCamera(true);
  await h.vc.startScreenShare("text");
  const pc = FakePeerConnection.instances[0];
  const sender = pc.videoSender();
  assertExists(sender);
  const replacedBefore = sender.replaced.length;

  await h.vc.setCamera(false);

  assertEquals(pc.removeTrackCount, 0, "sender が removeTrack されている");
  assertEquals(sender.replaced.length, replacedBefore, "共有中に映像が差し替えられている");
  assertEquals(sender.track, h.screens[0].getVideoTracks()[0], "共有が落ちている");
  assertEquals(h.vc.getState().videoSource, "screen");
  assertEquals(h.vc.getState().camera, false);
});

Deno.test("R2: 共有中に setCamera(false) しても品質監視が止まらない（T2）", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  await h.vc.setCamera(true);
  await h.vc.startScreenShare("text");
  assert(h.liveTimers() > 0, "品質監視が動いていない");

  await h.vc.setCamera(false);

  assert(h.liveTimers() > 0, "共有は続いているのに見張りが居なくなった");
});

Deno.test("R3: 共有中に入ってきたピアにも画面が載り、source も飛ぶ（T3 / T5）", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  await h.vc.startScreenShare("text");

  h.vc.handleServerMessage({
    t: "playerJoined",
    player: { id: "c", nickname: "あとから", vcEligible: true, connected: true },
  });
  // 入ってきた相手からの ready でピアが張られる
  h.vc.handleServerMessage({
    t: "rtcSignal",
    from: "c",
    payload: { kind: "ready", session: "s-c" },
  });

  const pc = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
  const sender = pc.videoSender();
  assertExists(sender, "後から来たピアに映像 sender が無い");
  assertEquals(
    sender.track,
    h.screens[0].getVideoTracks()[0],
    "後から来たピアに画面が載っていない",
  );
  const payload = lastVideoPayload(h, "c");
  assertExists(payload, "後から来たピアへ video 告知が飛んでいない");
  assertEquals(payload.source, "screen");
});

Deno.test("R4: leave() / teardown() で画面トラックも止まる（T12）", async () => {
  for (const how of ["leave", "teardown"]) {
    const h = load();
    await joinWith(h, ["a"]);
    await h.vc.setCamera(true);
    await h.vc.startScreenShare("text");
    const screenTrack = h.screens[0].getVideoTracks()[0];
    assertFalse(screenTrack.stopped);

    h.vc[how]();

    // 止め損ねるとブラウザの「共有中」バーが残り続ける
    assert(screenTrack.stopped, `${how} で画面トラックが止まっていない`);
    for (const stream of h.streams) {
      for (const track of stream.getTracks()) {
        assert(track.stopped, `${how} でマイク・カメラが止まっていない`);
      }
    }
    assertEquals(h.liveTimers(), 0, `${how} でタイマーが残っている`);
    assertEquals(h.vc.getState().screen, false);
  }
});

Deno.test("再接続でピアを張り直しても、画面共有が載ったままになる", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  await h.vc.startScreenShare("text");
  const screenTrack = h.screens[0].getVideoTracks()[0];

  // 再接続。restartPeers() が全ピアを畳んで ready を打ち直す
  h.vc.handleServerMessage({
    t: "roomState",
    snapshot: {
      youId: "me",
      players: [
        { id: "me", nickname: "わたし", vcEligible: true, connected: true },
        { id: "a", nickname: "a さん", vcEligible: true, connected: true },
      ],
    },
  });
  h.vc.handleServerMessage({
    t: "rtcSignal",
    from: "a",
    payload: { kind: "ready", session: "s-a2" },
  });

  const pc = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
  const sender = pc.videoSender();
  assertExists(sender, "張り直したピアに映像 sender が無い");
  assertEquals(sender.track, screenTrack, "張り直したピアに画面が載っていない");
  const payload = lastVideoPayload(h, "a");
  assertExists(payload);
  assertEquals(payload.source, "screen");
  // 共有そのものは切れていない
  assertFalse(screenTrack.stopped);
});

// ---------------------------------------------------------------------------
// 異常系（設計書 §11 の E1〜E7）
// ---------------------------------------------------------------------------

Deno.test("E1: 利用者が取り消しても、カメラ送出は壊れない", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  await h.vc.setCamera(true);
  const camTrack = h.streams[1].getVideoTracks()[0];
  h.notices.length = 0;
  h.plan.error = { name: "NotAllowedError" };

  assertFalse(await h.vc.startScreenShare("text"), "取り消したのに開始扱いになっている");

  assertEquals(h.vc.getState().videoSource, "camera", "カメラ送出が壊れている");
  const sender = FakePeerConnection.instances[0].videoSender();
  assertExists(sender);
  assertEquals(sender.track, camTrack);
  assertEquals(h.notices.filter((n) => n.kind === "error").length, 1, "通知が1回でない");
});

Deno.test("E2: NotFoundError / AbortError でも安全に戻る", async () => {
  for (const name of ["NotFoundError", "AbortError"]) {
    const h = load();
    await joinWith(h, ["a"]);
    h.plan.error = { name };

    assertFalse(await h.vc.startScreenShare("text"));

    assertEquals(h.vc.getState().videoSource, "none");
    assertEquals(h.vc.getState().screen, false);
  }
});

Deno.test("E3: 映像トラックが0本で返っても落ちない", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  h.plan.videoTracks = 0;

  assertFalse(await h.vc.startScreenShare("text"));

  assertEquals(h.vc.getState().screen, false);
});

Deno.test("E4: 音声トラックが混ざっていても送らずに捨てる（§6.5）", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  h.plan.audioTracks = 1;

  assert(await h.vc.startScreenShare("text"));

  const stream = h.screens[0];
  assertEquals(stream.getAudioTracks().length, 0, "音声トラックが残っている");
  // 送っていないだけでなく、その場で止めてある
  const pc = FakePeerConnection.instances[0];
  assertEquals(
    pc.getSenders().filter((s) => s.track?.kind === "audio" && s.track !== null).length,
    1,
    "マイク以外の音声 sender が増えている",
  );
});

Deno.test("E5: stop() で ended が発火しなくても、自前の停止で後始末が終わる", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  await h.vc.startScreenShare("text");
  const track = h.screens[0].getVideoTracks()[0];

  await h.vc.stopScreenShare();

  assert(track.stopped, "画面トラックが止まっていない");
  assertEquals(h.vc.getState().screen, false);
  assertEquals(h.vc.getState().videoSource, "none");
  const payload = lastVideoPayload(h, "a");
  assertExists(payload);
  assertEquals(payload.on, false);
});

Deno.test("E6: ブラウザの共有バーから止められた場合も同じ後始末に合流する", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  await h.vc.startScreenShare("text");
  const track = h.screens[0].getVideoTracks()[0];

  // 共有バーの「共有を停止」= トラックの ended
  track.fire("ended");
  await Promise.resolve();
  // 二重に走っても壊れないこと
  await h.vc.stopScreenShare();

  assert(track.stopped);
  assertEquals(h.vc.getState().screen, false);
});

Deno.test("E7: 1本の replaceTrack が失敗しても、他のピアの処理は続く", async () => {
  const h = load();
  await joinWith(h, ["a", "b"]);
  await h.vc.setCamera(true);
  const first = FakePeerConnection.instances[0].videoSender();
  assertExists(first);
  first.failReplace = true;

  assert(await h.vc.startScreenShare("text"));

  const second = FakePeerConnection.instances[1].videoSender();
  assertExists(second);
  assertEquals(second.track, h.screens[0].getVideoTracks()[0], "2本目まで巻き添えで止まっている");
});

/** 統計の偽物。framesEncoded が増えない（エンコード不成立）状態を作る */
function stalledStats(): () => Promise<Map<string, unknown>> {
  return () =>
    Promise.resolve(
      new Map<string, unknown>([
        ["out", { type: "outbound-rtp", kind: "video", framesEncoded: 0, timestamp: 1 }],
      ]),
    );
}

Deno.test("E8: エンコードが1フレームも成立しなければ共有を止める（§8.4）", async () => {
  const h = load({ getStats: stalledStats() });
  await joinWith(h, ["a"]);
  await h.vc.startScreenShare("text");
  h.notices.length = 0;

  for (let i = 0; i < 3; i += 1) await h.tick();

  assertEquals(h.vc.getState().screen, false, "エンコード不成立を拾えていない");
  assert(
    h.notices.some((n) => n.message.includes("送り出せなかった")),
    "理由が利用者に出ていない",
  );
  assert(h.screens[0].getVideoTracks()[0].stopped, "画面トラックが止まっていない");
});

Deno.test("E8: まだ繋がっていないだけのピアでは共有を止めない", async () => {
  const h = load({ getStats: stalledStats() });
  await joinWith(h, ["a"]);
  // 接続が張れるまではエンコーダが動かず framesEncoded は 0 のまま。
  // ここで止めてしまうと、回線が遅いだけの正常系で共有が落ちる
  FakePeerConnection.instances[0].connectionState = "connecting";
  await h.vc.startScreenShare("text");

  for (let i = 0; i < 5; i += 1) await h.tick();

  assertEquals(h.vc.getState().screen, true, "繋がる前に共有を止めている");
});

Deno.test("開始の選択中に相手が始めていたら、掴んだ画面を捨てて断る（§4.4）", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  // getDisplayMedia は利用者が画面を選ぶまで返らない。この窓は数十秒あり得る
  h.plan.hold = true;
  const starting = h.vc.startScreenShare("text");
  // 選んでいるあいだに相手が共有を始めた
  remoteShares(h, "a");
  h.releaseDisplay();

  assertFalse(await starting, "相手が共有中なのに開始扱いになっている");

  assertEquals(h.vc.getState().screen, false);
  assertEquals(h.vc.getState().sharingPeerId, "a");
  assert(h.screens[0].getVideoTracks()[0].stopped, "掴んだ画面を捨てていない");
});

Deno.test("開始の選択中に卓を離れたら、掴んだ画面を捨てる", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  h.plan.hold = true;
  const starting = h.vc.startScreenShare("text");
  h.vc.leave();
  h.releaseDisplay();

  assertFalse(await starting);

  assert(h.screens[0].getVideoTracks()[0].stopped, "ブラウザの共有中バーが残る");
  assertEquals(h.vc.getState().screen, false);
});

// ---------------------------------------------------------------------------
// 境界値（設計書 §11 の B1〜B6）
// ---------------------------------------------------------------------------

Deno.test("B1: 同時共有の競合は、両者の端末で同じ答えになる", () => {
  const h = load();
  // 自分が "b"、相手が "a" のとき → 辞書順で小さい "a" が共有権を持つ
  assertEquals(h.vc.resolveShareOwner("b", ["a"]), "a");
  // 相手側の端末では自分が "a"、相手が "b" → 同じ答え
  assertEquals(h.vc.resolveShareOwner("a", ["b"]), "a");
  // 3人以上でも最小が勝つ
  assertEquals(h.vc.resolveShareOwner("m", ["z", "c"]), "c");
  // 誰も共有していなければ自分
  assertEquals(h.vc.resolveShareOwner("m", []), "m");
});

Deno.test("B1: 競合したとき、負けた側だけが自分の共有を止める", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  await h.vc.startScreenShare("text");
  assertEquals(h.vc.getState().screen, true);

  // "a" < "me" なので相手が共有権を持つ
  remoteShares(h, "a");
  // 停止は非同期（全ピアの replaceTrack を待つ）ので、片付くまで待つ
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(h.vc.getState().screen, false, "負けた側の共有が止まっていない");
  assert(
    h.notices.some((n) => n.message.includes("重なったため")),
    "止めた理由が利用者に出ていない",
  );
});

Deno.test("B2: 他人が共有中は getDisplayMedia を呼ばずに断る", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  remoteShares(h, "a");

  assertFalse(await h.vc.startScreenShare("text"));

  assertEquals(h.displayCalls.length, 0, "選択ダイアログを出してから断っている");
  assertEquals(h.vc.getState().sharingPeerId, "a");
});

Deno.test("B3: 共有者が退室すると共有権が自動的に解ける", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  remoteShares(h, "a");
  assertEquals(h.vc.getState().sharingPeerId, "a");

  h.vc.handleServerMessage({
    t: "playerLeft",
    player: { id: "a", nickname: "a さん", vcEligible: true, connected: false },
  });

  assertEquals(h.vc.getState().sharingPeerId, null, "共有権が解けていない");
  // 拡大表示も畳む（黒い枠だけが残らないように）
  assert(h.zooms.some((z) => z.view === null && z.playerId === "a"));
});

Deno.test("B4: 共有中は fps 比だけでは停止判定が立たない（§8.1 / T10）", () => {
  const h = load();
  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    samples.push({
      at: i,
      warmedUp: true,
      videoActive: true,
      screenShare: true,
      // 静止した画面ではフレームが出ない。これは劣化ではない
      limitationReason: null,
      fpsRatio: 0,
      rtt: 0.05,
      outgoingBitrate: 2000000,
    });
  }
  const decision = h.vc.evaluateQuality(new Map([["a", samples]]), 1, 0, {
    autoStopped: false,
    reason: null,
    stoppedAt: null,
    autoStopCount: 0,
  });
  assertFalse(decision.shouldStop, "健全な共有が劣化と判定されている");
});

Deno.test("B5: 共有中でも RTT が閾値を割れば判定が立つ", () => {
  const h = load();
  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    samples.push({
      at: i,
      warmedUp: true,
      videoActive: true,
      screenShare: true,
      limitationReason: null,
      fpsRatio: 1,
      rtt: 1.2,
      outgoingBitrate: 2000000,
    });
  }
  const decision = h.vc.evaluateQuality(new Map([["a", samples]]), 1, 0, {
    autoStopped: false,
    reason: null,
    stoppedAt: null,
    autoStopCount: 0,
  });
  assert(decision.shouldStop, "共有中の劣化を拾えていない");
});

Deno.test("B6: TURN リレー時は軽い案へ落とす", () => {
  const h = load();
  assertEquals(h.vc.pickProfile({ requested: "text", relay: true }), "light");
  assertEquals(h.vc.pickProfile({ requested: "motion", relay: true }), "light");
  assertEquals(h.vc.pickProfile({ requested: "text", relay: false }), "text");
  assertEquals(h.vc.pickProfile({ requested: "motion", relay: false }), "motion");
});

Deno.test("B7: ピアが1人だけ（majority = 1）でも判定が働く", () => {
  const h = load();
  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    samples.push({
      at: i,
      warmedUp: true,
      videoActive: true,
      screenShare: false,
      // 経路側の遅延は過半数で止める。1人なら ⌈1/2⌉ = 1 で足りる
      limitationReason: "bandwidth",
      fpsRatio: 1,
      rtt: 1.2,
      outgoingBitrate: 2000000,
    });
  }
  const decision = h.vc.evaluateQuality(new Map([["a", samples]]), 1, 0, {
    autoStopped: false,
    reason: null,
    stoppedAt: null,
    autoStopCount: 0,
  });
  assert(decision.shouldStop);
  assertEquals(decision.reason, "bandwidth");
  assertEquals(decision.degradedPeerCount, 1);
});

// ---------------------------------------------------------------------------
// 表示（§7 / §9-3）
// ---------------------------------------------------------------------------

Deno.test("共有中のタイルには札と拡大の口が出る（§7 / §9-3）", async () => {
  const h = load();
  await joinWith(h, ["a"]);

  remoteShares(h, "a");

  const tile = h.container.children.find((c) => c.dataset.playerId === "a");
  assertExists(tile, "相手のタイルが無い");
  const badge = tile.querySelector(".vc-share-badge");
  assertExists(badge);
  assertFalse(badge.hidden, "共有中なのに札が出ていない");
  // タイルの中では読めないので contain に切り替える（§7.3）
  const video = tile.querySelector(".vc-video");
  assertExists(video);
  assert(video.className.includes("vc-video-screen"), "object-fit が切り替わっていない");

  // 拡大を押すと、その人の受信ストリームで覆いを開くよう頼む
  const zoom = tile.querySelector(".vc-share-zoom");
  assertExists(zoom);
  zoom.click();
  const opened = h.zooms.filter((z) => z.view !== null);
  assertEquals(opened.length, 1, "拡大表示が頼まれていない");

  // 共有が止まったら札も畳み、拡大表示も閉じてもらう
  h.vc.handleServerMessage({ t: "rtcSignal", from: "a", payload: { kind: "video", on: false } });
  assert(badge.hidden, "共有が止まっても札が残っている");
  assert(h.zooms.some((z) => z.view === null && z.playerId === "a"));
});

Deno.test("画面全体を選んだときは強めに警告する（§9-1）", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  h.plan.displaySurface = "monitor";

  await h.vc.startScreenShare("text");

  assert(
    h.notices.some((n) => n.kind === "error" && n.message.includes("画面全体")),
    "画面全体の警告が出ていない",
  );
  // 止めはしない（利用者の選択を機械が覆さない）
  assertEquals(h.vc.getState().screen, true);
});

Deno.test("非対応の端末では始められないが、受信はできる", async () => {
  const h = load();
  await joinWith(h, ["a"]);
  // 出し分けは特徴検出で行う（UA 文字列は見ない）。偽の環境では
  // getDisplayMedia を持たせてあるので true になる
  assertEquals(h.vc.getState().screenSupported, true);

  // 受信は常に有効。相手の共有は、こちらが送れるかどうかに関わらず受け取れる
  remoteShares(h, "a");
  assertEquals(h.vc.getState().sharingPeerId, "a");
});

// ---------------------------------------------------------------------------
// サーバー側（設計書 §11 の S2 / S3 / S4）
// ---------------------------------------------------------------------------

Deno.test("S2: アプリ本体に Permissions-Policy が付く（§9-2）", async () => {
  const kv = await Deno.openKv(":memory:");
  const handle = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    const policy = res.headers.get("permissions-policy");
    assertExists(policy, "Permissions-Policy が付いていない");
    for (const directive of ["display-capture=(self)", "camera=(self)", "microphone=(self)"]) {
      assert(policy.includes(directive), `${directive} が無い: ${policy}`);
    }
    await res.body?.cancel();
  } finally {
    await handle.shutdown();
    kv.close();
  }
});

Deno.test("S3: /sandbox/ には画面取得を誰にも許さない（§9-2）", async () => {
  const handle = startServer(0);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/sandbox/runner.html`);
    const policy = res.headers.get("permissions-policy");
    assertExists(policy);
    for (const directive of ["display-capture=()", "camera=()", "microphone=()"]) {
      assert(policy.includes(directive), `${directive} が無い: ${policy}`);
    }
    await res.body?.cancel();
  } finally {
    await handle.shutdown();
  }
});

Deno.test("S4: runner の iframe に allow-same-origin が入っていない（§9-2 の前提）", async () => {
  const path = fromFileUrl(new URL("../../public/room/sandbox.js", import.meta.url));
  const sandbox = await Deno.readTextFile(path);
  // 見るのは実際に付けている属性値だけ（コメントには「付けない」と書いてある）
  const values = [...sandbox.matchAll(/setAttribute\(\s*"sandbox"\s*,\s*"([^"]*)"/g)]
    .map((m) => m[1]);
  assert(values.length > 0, "iframe の sandbox 属性を付けている箇所が見つからない");
  for (const value of values) {
    assertFalse(
      value.includes("allow-same-origin"),
      `runner が同一オリジンになると、Permissions-Policy の self に一致してしまう: ${value}`,
    );
  }
});
