/**
 * public/room/vc.js / public/app.js の「getUserMedia を多重に呼ばせない」ガードのテスト。
 *
 * 本題はただ1つ、**掴んだメディアのストリームを1本も取りこぼさないこと**。
 * getUserMedia は許可ダイアログのあいだ数秒〜数十秒返らないので、その窓に
 * もう一度呼ばれると2本目を掴んでしまう。1本目は参照を失って二度と stop()
 * されず、退室してもカメラ・マイクの動作ランプが消えない（プライバシーの実害）。
 * 孤児のトラックは setMuted() の対象からも外れるため、ミュートも効かなくなる。
 *
 * 手口は vc_teardown_test.ts / vc_screenshare_test.ts と同じで、偽の DOM・
 * 偽の RTCPeerConnection・偽の MediaStream の上に vc.js を new Function で
 * 読み込み、Deno から素の JavaScript として動かす。
 * getUserMedia は「呼んだ瞬間にストリームを作り、解決だけを保留できる」偽物に
 * してあり、許可ダイアログが開いている状態を再現する。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createFakeDocument, FakeElement } from "./fake_dom.ts";

const VC_JS = fromFileUrl(new URL("../../public/room/vc.js", import.meta.url));
const source = await Deno.readTextFile(VC_JS);
const APP_JS = fromFileUrl(new URL("../../public/app.js", import.meta.url));
const appSource = await Deno.readTextFile(APP_JS);

// ---------------------------------------------------------------------------
// ブラウザ API の偽物
// ---------------------------------------------------------------------------

/** MediaStreamTrack の偽物。stop() が呼ばれたかを記録する（ここが本題） */
class FakeTrack {
  stopped = false;
  enabled = true;
  readyState = "live";
  muted = false;
  contentHint = "";

  constructor(
    readonly kind: "audio" | "video",
    readonly settings: Record<string, unknown> = { frameRate: 30 },
  ) {}

  stop(): void {
    this.stopped = true;
    this.readyState = "ended";
  }

  applyConstraints(): Promise<void> {
    return Promise.resolve();
  }

  getSettings(): Record<string, unknown> {
    return this.settings;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
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

/** RTCRtpSender の偽物 */
class FakeSender {
  constructor(public track: FakeTrack | null) {}

  replaceTrack(track: FakeTrack | null): Promise<void> {
    this.track = track;
    return Promise.resolve();
  }

  getParameters(): Record<string, unknown> {
    return { encodings: [{}] };
  }

  setParameters(): Promise<void> {
    return Promise.resolve();
  }
}

/** RTCPeerConnection の偽物 */
class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  closeCount = 0;
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

type Sent = { t: string; to?: string; payload?: Record<string, unknown> };

type Harness = {
  // deno-lint-ignore no-explicit-any
  vc: any;
  sent: Sent[];
  /** getUserMedia が返す（返した）全ストリーム。呼ばれた時点で積む */
  streams: FakeStream[];
  /** getUserMedia の呼び出し回数（マイク／カメラ別） */
  micCalls(): number;
  cameraCalls(): number;
  /** true にすると、release するまで getUserMedia が解決しない（許可ダイアログ） */
  hold: { mic: boolean; camera: boolean };
  releaseMic(): void;
  releaseCamera(): void;
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
  const hold = { mic: false, camera: false };
  const pending = { mic: [] as (() => void)[], camera: [] as (() => void)[] };
  let micCalls = 0;
  let cameraCalls = 0;
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

  const win = {
    setInterval: addTimer,
    clearInterval: dropTimer,
    setTimeout: addTimer,
    clearTimeout: dropTimer,
    navigator: {
      mediaDevices: {
        // join() は video:false で呼ぶ。カメラ ON はそれ以外
        getUserMedia: (constraints: { video?: unknown }) => {
          const isCamera = constraints.video !== false;
          if (isCamera) cameraCalls += 1;
          else micCalls += 1;
          // 呼ばれた時点でストリームを作る。保留しても「掴んだ本数」は数えたい
          const stream = new FakeStream([new FakeTrack(isCamera ? "video" : "audio")]);
          streams.push(stream);
          const which = isCamera ? "camera" : "mic";
          if (!hold[which]) return Promise.resolve(stream);
          return new Promise<FakeStream>((resolve) => {
            pending[which].push(() => resolve(stream));
          });
        },
        getDisplayMedia: () => {
          const stream = new FakeStream([
            new FakeTrack("video", { frameRate: 10, displaySurface: "window" }),
          ]);
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
    container: new FakeElement("div", "vc-media"),
    onStatus: (event: { kind: string; message: string }) => notices.push(event),
  });

  const release = (which: "mic" | "camera") => () => {
    const waiting = pending[which].splice(0, pending[which].length);
    for (const resolve of waiting) resolve();
  };

  return {
    vc,
    sent,
    streams,
    micCalls: () => micCalls,
    cameraCalls: () => cameraCalls,
    hold,
    releaseMic: release("mic"),
    releaseCamera: release("camera"),
    liveTimers: () => timers.size,
    notices,
  };
}

/** ルームに入った状態にする（VC にはまだ参加しない） */
function enterRoom(h: Harness): void {
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
}

/** ルームに入って VC にも参加する（マイクは保留しない） */
async function joinVc(h: Harness): Promise<void> {
  enterRoom(h);
  assert(await h.vc.join(), "VC に参加できていない");
}

/** まだ1本でもトラックが生きているストリーム */
function liveStreams(h: Harness): FakeStream[] {
  return h.streams.filter((s) => s.getTracks().some((t) => !t.stopped));
}

/** 掴んだトラックが1本残らず止まっているか */
function allTracksStopped(h: Harness): boolean {
  return h.streams.every((s) => s.getTracks().every((t) => t.stopped));
}

// ---------------------------------------------------------------------------
// C-2: カメラの多重取得
// ---------------------------------------------------------------------------

Deno.test("C-2: setCamera(true) を連打してもカメラのストリームは1本しか掴まない", async () => {
  const h = load();
  await joinVc(h);

  // ボタンの連打。await せずに2回呼ぶ（実際のクリックと同じ順序になる）
  const first = h.vc.setCamera(true);
  const second = h.vc.setCamera(true);
  const [a, b] = await Promise.all([first, second]);

  assertEquals(h.cameraCalls(), 1, "getUserMedia（カメラ）が二重に走った");
  assert(a, "1回目でカメラが ON になっていない");
  // 2回目は「もう ON になっている」ので true でよいが、掴み直してはいけない
  assert(b === true || b === false, "戻り値が真偽値でない");
  assertEquals(liveStreams(h).length, 2, "生きているのはマイク1本＋カメラ1本のはず");
  assertEquals(
    liveStreams(h).filter((s) => s.getVideoTracks().length > 0).length,
    1,
    "カメラのストリームが2本生きている（孤児が残っている）",
  );
});

Deno.test("C-2: 許可ダイアログ待ちの最中に押し直しても、掴むカメラは1本だけ", async () => {
  const h = load();
  await joinVc(h);
  h.hold.camera = true;

  const first = h.vc.setCamera(true);
  // 1回目が返る前の2回目。ここが監査 C-2 の窓
  const second = h.vc.setCamera(true);
  h.releaseCamera();
  await Promise.all([first, second]);

  assertEquals(h.cameraCalls(), 1, "選択待ちの最中に getUserMedia を二度呼んだ");
  assertEquals(
    liveStreams(h).filter((s) => s.getVideoTracks().length > 0).length,
    1,
    "カメラのストリームが2本生きている（孤児が残っている）",
  );
  assert(h.vc.getState().camera, "カメラが ON になっていない");
});

Deno.test("C-2: 許可を待っているあいだに OFF を押したら、掴んだカメラは捨てる", async () => {
  const h = load();
  await joinVc(h);
  h.hold.camera = true;

  const turningOn = h.vc.setCamera(true);
  // 利用者の最後の操作は OFF。あとから解決した ON でランプが点いてはいけない
  assertFalse(await h.vc.setCamera(false), "OFF の戻り値が false でない");
  h.releaseCamera();
  assertFalse(await turningOn, "打ち消されたはずの ON が成立している");

  assertFalse(h.vc.getState().camera, "OFF にしたのにカメラが ON のまま");
  const cameraStreams = h.streams.filter((s) => s.getVideoTracks().length > 0);
  assertEquals(cameraStreams.length, 1);
  assert(
    cameraStreams.every((s) => s.getTracks().every((t) => t.stopped)),
    "捨てたはずのカメラのトラックが止まっていない",
  );
});

Deno.test("C-2: 画面共有をやめてカメラへ戻す最中に押しても、二重に掴まない", async () => {
  const h = load();
  await joinVc(h);
  assert(await h.vc.setCamera(true), "カメラを ON にできていない");
  assert(await h.vc.startScreenShare("text"), "画面共有を始められていない");
  const callsBefore = h.cameraCalls();
  h.hold.camera = true;

  // 共有をやめるとカメラを取り直す。その await の最中にカメラのボタンが押される
  const stopping = h.vc.stopScreenShare();
  const pressed = h.vc.setCamera(true);
  h.releaseCamera();
  await Promise.all([stopping, pressed]);

  assertEquals(h.cameraCalls() - callsBefore, 1, "取り直しと手動 ON で二重に掴んだ");
  assertEquals(
    liveStreams(h).filter((s) => s.getVideoTracks().length > 0).length,
    1,
    "カメラのストリームが2本生きている（孤児が残っている）",
  );

  h.vc.leave();
  assert(allTracksStopped(h), "退室後も止まっていないトラックがある");
});

// ---------------------------------------------------------------------------
// C-3: マイクの多重取得
// ---------------------------------------------------------------------------

Deno.test("C-3: 許可ダイアログ待ちの最中に join() が再入してもマイクは1本だけ", async () => {
  const h = load();
  enterRoom(h);
  h.hold.mic = true;

  const first = h.vc.join();
  // 得点確定・ノックでも roomState は配られる。その2通目で autoJoinVc が再入する
  const second = h.vc.join();
  h.releaseMic();
  const [a, b] = await Promise.all([first, second]);

  assertEquals(h.micCalls(), 1, "getUserMedia（マイク）が二重に走った");
  assert(a, "1回目の参加が成立していない");
  assertFalse(b, "参加処理の最中の2回目が受け付けられている");
  assertEquals(liveStreams(h).length, 1, "マイクのストリームが2本生きている（孤児が残っている）");
  assert(h.vc.getState().active, "VC に参加できていない");
});

Deno.test("C-3 の二次被害: 二重に join() したあとでもミュートが全マイクに効く", async () => {
  const h = load();
  enterRoom(h);
  h.hold.mic = true;
  const first = h.vc.join();
  const second = h.vc.join();
  h.releaseMic();
  await Promise.all([first, second]);

  assert(h.vc.setMuted(true), "ミュートの戻り値が true でない");

  const liveAudio = h.streams
    .flatMap((s) => s.getAudioTracks())
    .filter((t) => !t.stopped);
  assertEquals(liveAudio.length, 1, "生きているマイクのトラックが1本ではない");
  assert(
    liveAudio.every((t) => !t.enabled),
    "ミュートが効いていないマイクのトラックが残っている（孤児側は setMuted の対象外）",
  );
});

Deno.test("C-3: 許可を待っているあいだに卓を離れたら、掴んだマイクは捨てる", async () => {
  const h = load();
  enterRoom(h);
  h.hold.mic = true;

  const joining = h.vc.join();
  // サーバー再起動・退室。この時点では state.active がまだ立っていない
  h.vc.teardown();
  h.releaseMic();
  assertFalse(await joining, "卓を離れたのに参加が成立している");

  assertFalse(h.vc.getState().active, "退室後に VC 参加中になっている");
  assert(allTracksStopped(h), "捨てたはずのマイクのトラックが止まっていない");
});

// ---------------------------------------------------------------------------
// 退室: 競合を起こした後でも1本残らず止まること
// ---------------------------------------------------------------------------

Deno.test("退室: マイクもカメラも競合させた後で leave() すると全トラックが止まる", async () => {
  const h = load();
  enterRoom(h);

  // マイクを競合させる
  h.hold.mic = true;
  const j1 = h.vc.join();
  const j2 = h.vc.join();
  h.releaseMic();
  await Promise.all([j1, j2]);

  // 相手とのピアを1本張る（後始末の対象を増やす）
  h.vc.handleServerMessage({
    t: "rtcSignal",
    from: "you",
    payload: { kind: "ready", session: "s" },
  });

  // カメラを競合させる
  h.hold.camera = true;
  const c1 = h.vc.setCamera(true);
  const c2 = h.vc.setCamera(true);
  h.releaseCamera();
  await Promise.all([c1, c2]);

  assertFalse(allTracksStopped(h), "退室前に止まってしまっている");

  h.vc.leave();

  // ここが本題。1本でも残るとカメラ・マイクのランプが消えない
  assert(allTracksStopped(h), "退室後も止まっていないトラックがある");
  assertEquals(liveStreams(h).length, 0);
  assertEquals(h.liveTimers(), 0, "品質監視のタイマーが残っている");
  assertFalse(h.vc.getState().active);
});

Deno.test("退室: teardown（サーバー再起動）でも競合分をまとめて止める", async () => {
  const h = load();
  enterRoom(h);
  h.hold.mic = true;
  const j1 = h.vc.join();
  const j2 = h.vc.join();
  h.releaseMic();
  await Promise.all([j1, j2]);
  h.hold.camera = true;
  const c1 = h.vc.setCamera(true);
  const c2 = h.vc.setCamera(true);
  h.releaseCamera();
  await Promise.all([c1, c2]);

  h.vc.teardown();

  assert(allTracksStopped(h), "teardown 後も止まっていないトラックがある");
  for (const stream of h.streams) {
    for (const track of stream.getTracks()) assertEquals(track.readyState, "ended");
  }
});

// ---------------------------------------------------------------------------
// app.js 側の門（再入ガードとボタンの閉じ）
// ---------------------------------------------------------------------------

/** app.js が使う WebSocket の偽物（app_reconnect_test.ts と同じ手口） */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

/** 呼ばれたことだけ控えるダミーモジュール */
function stubModule(
  name: string,
  calls: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return new Proxy({ ...extra }, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return () => {
        calls.push(`${name}.${prop}`);
        return undefined;
      };
    },
  });
}

type AppHarness = {
  calls: string[];
  element(id: string): FakeElement;
  socket(): FakeSocket;
  /** roomState を1件流し込む（得点確定・ノックでも同じものが飛ぶ） */
  sendRoomState(): void;
  /** 保留していた VC.join() を解決する */
  releaseJoin(): void;
  /** 保留していた VC.toggleCamera() を解決する */
  releaseCamera(): void;
  /** マイクロタスクを片付ける */
  settle(): Promise<void>;
};

/** app.js を偽の環境で読み込む。VC は保留できるダミーに差し替える */
async function loadApp(options: { vcActive?: boolean } = {}): Promise<AppHarness> {
  FakeSocket.instances = [];
  const { document } = createFakeDocument();
  const storage = new Map<string, string>();
  const calls: string[] = [];
  const timers: Array<{ id: number; fn: () => void }> = [];
  let timerSeq = 1;
  let pendingJoin: ((value: boolean) => void) | null = null;
  let pendingCamera: ((value: boolean) => void) | null = null;

  const fetchStub = () =>
    Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });

  const factory = new Function(
    "document",
    "fetch",
    "WebSocket",
    "sessionStorage",
    "GuestProfile",
    "RoomHandoff",
    "location",
    "setTimeout",
    "clearTimeout",
    "VC",
    "Voice",
    "Chat",
    "Bot",
    "Sound",
    `${appSource}\n; return {};`,
  );

  factory(
    document,
    fetchStub,
    FakeSocket,
    {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    { getGuestProfile: () => ({ nickname: "", tags: [] }) },
    { consumePendingCreateRoom: () => null, consumePendingJoinRoom: () => null },
    { protocol: "http:", host: "127.0.0.1:8000", href: "" },
    (fn: () => void) => {
      const id = timerSeq++;
      timers.push({ id, fn });
      return id;
    },
    (id: number) => {
      const at = timers.findIndex((t) => t.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
    stubModule("VC", calls, {
      getState: () => ({
        active: options.vcActive === true,
        muted: false,
        camera: false,
        eligible: true,
        screen: false,
        screenSupported: true,
        sharingPeerId: null,
        peers: [],
        quality: null,
      }),
      // 実物は許可ダイアログが閉じるまで返らない。その窓を再現する
      join: () => {
        calls.push("VC.join");
        return new Promise<boolean>((resolve) => {
          pendingJoin = resolve;
        });
      },
      toggleCamera: () => {
        calls.push("VC.toggleCamera");
        return new Promise<boolean>((resolve) => {
          pendingCamera = resolve;
        });
      },
    }),
    stubModule("Voice", calls, { getState: () => ({ enabled: false }), isSupported: () => false }),
    stubModule("Chat", calls),
    stubModule("Bot", calls, { getState: () => ({ bots: {}, isHost: false }) }),
    stubModule("Sound", calls, { GAYA_CORRIDOR: 0.32, GAYA_ROOM: 0.06 }),
  );

  // start() は fetch を await してから connect() する。その解決を待つ
  await new Promise((resolve) => setTimeout(resolve, 0));

  const socket = () => FakeSocket.instances[FakeSocket.instances.length - 1];
  return {
    calls,
    element: (id: string) => document.getElementById(id),
    socket,
    sendRoomState: () => {
      socket().receive({
        t: "roomState",
        snapshot: {
          code: "123456",
          session: "sess-abc",
          youId: "p1",
          youAreHost: true,
          hostId: "p1",
          players: [],
          capacity: 6,
          availableGames: [],
          selectedGameId: null,
          description: "",
          tags: [],
          chat: [],
          phase: "lobby",
          deadline: null,
          view: { phase: "lobby", selectedGameId: null },
        },
      });
    },
    releaseJoin: () => {
      const resolve = pendingJoin;
      pendingJoin = null;
      if (resolve !== null) resolve(true);
    },
    releaseCamera: () => {
      const resolve = pendingCamera;
      pendingCamera = null;
      if (resolve !== null) resolve(true);
    },
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

Deno.test("app.js: 参加処理の最中に roomState が来ても VC.join を二度呼ばない", async () => {
  const h = await loadApp();
  h.socket().open();

  h.sendRoomState();
  // 得点確定（全員へ）・ノック（ホストへ）でも roomState は配られる。
  // マイクの許可ダイアログが開いているあいだに届くのはこれ
  h.sendRoomState();
  h.sendRoomState();

  assertEquals(
    h.calls.filter((c) => c === "VC.join").length,
    1,
    "許可を待っている最中に VC.join を呼び直している",
  );

  h.releaseJoin();
  await h.settle();
});

Deno.test("app.js: カメラのボタンは処理中 disabled になり、連打が通らない", async () => {
  const h = await loadApp({ vcActive: true });
  h.socket().open();
  const button = h.element("vc-camera");
  assertFalse(button.disabled, "参加中なのに最初から押せない");

  button.click();

  assert(button.disabled, "処理中もカメラのボタンが押せてしまう");
  // 連打しても2本目の getUserMedia には進ませない
  button.click();
  button.click();
  assertEquals(
    h.calls.filter((c) => c === "VC.toggleCamera").length,
    1,
    "連打がそのまま VC へ通っている",
  );

  h.releaseCamera();
  await h.settle();

  assertFalse(button.disabled, "処理が終わってもボタンが閉じたまま");
});
