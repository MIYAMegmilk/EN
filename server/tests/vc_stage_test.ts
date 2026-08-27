/**
 * 卓上の主役エリア（#vc-stage）のテスト。
 *
 * 本題は次の4つ。
 *   1. タイルを押すとその人が主役になり、もう一度押すと降りること。押し口は
 *      ネイティブの <button> で、マウスでもキーボードでも同じように動くこと
 *   2. あそびが動き出したら、あそびの面（#phase）が自動で主役に上がり、
 *      降りるときは .stage-board の定位置（#phase-slot）へ必ず戻ること
 *   3. 主役の人が消えたら（退室・カメラ切・共有停止）、黒い枠を残さず
 *      自動で降りること
 *   4. #phase を行き来させても、あそびのビューモジュールの器が作り直されない
 *      こと（作り直すと中身とリスナが毎回消える）
 *
 * 手口は vc_presence_test.ts / app_reconnect_test.ts と同じだが、この機能は
 * vc.js（タイルと押し口）と app.js（主役エリアと #phase の移動）にまたがるので、
 * **両方を同じ偽 DOM の上に載せて**端から端まで通す。VC を差し替えてしまうと、
 * 押し口を押したときに主役が変わるかを確かめられない。
 *
 * 偽の環境には AudioContext を置かない（発話検知は特徴検出で素通りする）。
 * 実測サイズ・ResizeObserver・<dialog> も無いので、状態はすべてクラス名・
 * dataset・hidden で表現してある。
 */

import { assert, assertEquals, assertExists, assertFalse } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createFakeDocument, FakeElement } from "./fake_dom.ts";

const VC_JS = fromFileUrl(new URL("../../public/room/vc.js", import.meta.url));
const APP_JS = fromFileUrl(new URL("../../public/app.js", import.meta.url));
const INDEX_HTML = fromFileUrl(new URL("../../public/index.html", import.meta.url));
const vcSource = await Deno.readTextFile(VC_JS);
const appSource = await Deno.readTextFile(APP_JS);

// ---------------------------------------------------------------------------
// ブラウザ API の偽物
// ---------------------------------------------------------------------------

/** MediaStreamTrack の偽物 */
class FakeTrack {
  enabled = true;
  readyState = "live";
  muted = false;
  contentHint = "";
  readonly listeners = new Map<string, (() => void)[]>();

  constructor(readonly kind: "audio" | "video") {}

  stop(): void {
    this.readyState = "ended";
  }

  applyConstraints(): Promise<void> {
    return Promise.resolve();
  }

  getSettings(): Record<string, number> {
    return { frameRate: 30 };
  }

  addEventListener(type: string, handler: () => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(handler);
    this.listeners.set(type, bucket);
  }

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

/** RTCPeerConnection の偽物 */
class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState = "connected";
  signalingState = "stable";
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
  close(): void {}
  restartIce(): void {}

  setLocalDescription(): Promise<void> {
    return Promise.resolve();
  }

  getStats(): Promise<Map<string, unknown>> {
    return Promise.resolve(new Map());
  }
}

/** WebSocket の偽物。S2C を流し込むためだけに使う */
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
    this.onopen?.();
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

/** 何もしないダミーモジュール（voice.js / chat.js などの代わり） */
function stubModule(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy({ ...extra }, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return () => undefined;
    },
  });
}

// ---------------------------------------------------------------------------
// 偽の環境に vc.js と app.js を載せる
// ---------------------------------------------------------------------------

type App = {
  // deno-lint-ignore no-explicit-any
  state: any;
  // deno-lint-ignore no-explicit-any
  vcStage: any;
  // deno-lint-ignore no-explicit-any
  gameModuleHost: () => any;
};

type Harness = {
  app: App;
  // deno-lint-ignore no-explicit-any
  vc: any;
  /** id で要素を引く（未生成なら作られる） */
  element(id: string): FakeElement;
  // deno-lint-ignore no-explicit-any
  document: any;
  socket(): FakeSocket;
  /** タイルが差し込まれる先（index.html の #vc-people） */
  people(): FakeElement;
};

/**
 * index.html のうち、この機能が寄りかかっている入れ子だけを組む。
 * 偽の document は getElementById で要素を作るが、親子までは知らないため。
 */
function buildDom(document: { getElementById(id: string): FakeElement }): void {
  const at = (id: string) => document.getElementById(id);
  at("vc-media").appendChild(at("vc-frames"));
  at("vc-frames").appendChild(at("vc-stage"));
  at("vc-stage").appendChild(at("vc-stage-title"));
  at("vc-stage").appendChild(at("vc-stage-full"));
  at("vc-stage").appendChild(at("vc-stage-close"));
  at("vc-stage").appendChild(at("vc-stage-body"));
  at("vc-stage-body").appendChild(at("vc-stage-video"));
  at("vc-frames").appendChild(at("vc-people"));
  at("stage-board").appendChild(at("phase-slot"));
  at("phase-slot").appendChild(at("phase"));
  at("phase").appendChild(at("phase-title"));
  at("phase").appendChild(at("phase-deadline"));
  at("phase").appendChild(at("phase-body"));
  at("stage-board").appendChild(at("result"));
}

async function load(): Promise<Harness> {
  FakePeerConnection.instances = [];
  FakeSocket.instances = [];
  const { document } = createFakeDocument();
  buildDom(document);
  const timers: Array<{ id: number; fn: () => void }> = [];
  let seq = 1;

  const addTimer = (fn?: () => void) => {
    const id = seq++;
    if (typeof fn === "function") timers.push({ id, fn });
    return id;
  };
  const dropTimer = (id: number) => {
    const at = timers.findIndex((t) => t.id === id);
    if (at >= 0) timers.splice(at, 1);
  };

  // AudioContext は置かない（発話検知は特徴検出で素通りする）
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

  const vcFactory = new Function(
    "window",
    "document",
    "MediaStream",
    "setInterval",
    "clearInterval",
    "setTimeout",
    "clearTimeout",
    `${vcSource}\n; return window.VC;`,
  );
  // deno-lint-ignore no-explicit-any
  const vc: any = vcFactory(
    win,
    document,
    FakeStream,
    addTimer,
    dropTimer,
    addTimer,
    dropTimer,
  );

  const appFactory = new Function(
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
    `${appSource}\n; return { state, vcStage, gameModuleHost };`,
  );

  const storage = new Map<string, string>();
  const app = appFactory(
    document,
    () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    FakeSocket,
    {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    { getGuestProfile: () => ({ nickname: "", tags: [] }) },
    { consumePendingCreateRoom: () => null, consumePendingJoinRoom: () => null },
    { protocol: "http:", host: "127.0.0.1:8000", href: "" },
    addTimer,
    dropTimer,
    vc,
    stubModule({ getState: () => ({ enabled: false }), isSupported: () => false }),
    stubModule(),
    stubModule({ getState: () => ({ bots: {}, isHost: false }) }),
    stubModule({ GAYA_CORRIDOR: 0.32, GAYA_ROOM: 0.06 }),
  ) as App;

  // start() は fetch を await してから connect() する。その解決を待つ
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    app,
    vc,
    element: (id: string) => document.getElementById(id),
    document,
    socket: () => FakeSocket.instances[FakeSocket.instances.length - 1],
    people: () => document.getElementById("vc-people"),
  };
}

// ---------------------------------------------------------------------------
// 卓に入る／人を増やす小道具
// ---------------------------------------------------------------------------

type Player = { id: string; nickname: string; vcEligible: boolean; connected: boolean };

function snapshot(players: Player[], phase = "lobby"): Record<string, unknown> {
  return {
    code: "123456",
    session: "sess-abc",
    youId: "me",
    youAreHost: true,
    hostId: "me",
    players: players.map((p) => ({ ...p, isHost: p.id === "me", score: 0 })),
    capacity: 6,
    availableGames: [],
    selectedGameId: null,
    description: "",
    tags: [],
    chat: [],
    phase,
    deadline: null,
    view: { phase, selectedGameId: null },
  };
}

/** 卓に入って VC に参加する。peerIds の相手とはピアを張る */
async function enterRoom(h: Harness, peerIds: string[] = []): Promise<void> {
  const players: Player[] = [{ id: "me", nickname: "わたし", vcEligible: true, connected: true }];
  for (const id of peerIds) {
    players.push({ id, nickname: `${id}すけ`, vcEligible: true, connected: true });
  }
  h.socket().open();
  h.socket().receive({ t: "roomState", snapshot: snapshot(players) });
  // VC.join() はマイクの取得を待つ。解決するまで待ってから続ける
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(h.vc.getState().active, "VC に参加できていない");
  for (const id of peerIds) {
    h.vc.handleServerMessage({
      t: "rtcSignal",
      from: id,
      payload: { kind: "ready", session: `s-${id}` },
    });
  }
  assertEquals(FakePeerConnection.instances.length, peerIds.length, "ピアが揃っていない");
}

/**
 * 相手から映像が届いたことにする。
 * 主役に出せるかどうかは「生きた映像が来ているか」で決まるので、
 * 告知（kind:"video"）だけでは足りない。
 */
function receiveVideo(h: Harness, index: number, source: "camera" | "screen"): void {
  const from = ["a", "b"][index];
  h.vc.handleServerMessage({
    t: "rtcSignal",
    from,
    payload: { kind: "video", on: true, source },
  });
  const pc = FakePeerConnection.instances[index];
  assertExists(pc.ontrack, "ontrack が張られていない");
  pc.ontrack({ track: new FakeTrack("video") });
}

/** playerId のタイル */
function tileOf(h: Harness, playerId: string): FakeElement {
  const found = h.people().children.find((c) => c.dataset.playerId === playerId);
  assertExists(found, `${playerId} のタイルが無い`);
  return found;
}

/** タイルの押し口（主役にする透明なボタン） */
function pickOf(tile: FakeElement): FakeElement {
  const found = tile.querySelector(".vc-peer-pick");
  assertExists(found, "押し口が無い");
  return found;
}

/** あそびが動き出したことにする */
function startGame(h: Harness): void {
  h.socket().receive({
    t: "phase",
    phase: "playing",
    deadline: null,
    view: { phase: "playing" },
  });
}

/** あそびが終わったことにする */
function endGame(h: Harness): void {
  h.socket().receive({
    t: "phase",
    phase: "lobby",
    deadline: null,
    view: { phase: "lobby", selectedGameId: null },
  });
}

// ---------------------------------------------------------------------------
// 正常系: 人を主役にする
// ---------------------------------------------------------------------------

Deno.test("タイルを押すとその人が主役になる", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);
  receiveVideo(h, 0, "camera");

  pickOf(tileOf(h, "a")).click();

  assertFalse(h.element("vc-stage").hidden, "主役エリアが畳まれたまま");
  assertEquals(h.document.body.dataset.vcStage, "peer");
  assertEquals(h.app.vcStage.playerId, "a");
  // ニックネームは textContent で入る（§3.8）
  assertEquals(h.element("vc-stage-title").textContent, "aすけ さん");
  // タイルの DOM を移すのではなく、同じ MediaStream を主役の video に張る
  const tile = tileOf(h, "a");
  assertEquals(tile.parent, h.people(), "タイルが #vc-people から動いている");
  const tileVideo = tile.querySelector(".vc-video");
  assertExists(tileVideo);
  assertEquals(
    h.element("vc-stage-video").srcObject,
    tileVideo.srcObject,
    "主役の video に同じストリームが張られていない",
  );
  // 見た目と支援技術の両方に主役であることが出る
  assert(tile.className.includes("vc-peer-onstage"), "主役の印が付いていない");
  assertEquals(pickOf(tile).attributes.get("aria-pressed"), "true");
});

Deno.test("押し口はネイティブの button なので、キーボードでも主役にできる", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);
  receiveVideo(h, 0, "camera");
  const tile = tileOf(h, "a");
  const pick = pickOf(tile);

  // ARIA の第一原則。div に role="button" を付けるのではなく <button> を使う。
  // Tab での移動と Enter / Space での押下はブラウザが受け持つので、
  // 自前の keydown は持たない（持つと二重発火や実装漏れの元になる）
  assertEquals(pick.tagName, "button");
  // type は属性ではなくプロパティで入れる（vc.js の他のボタンと同じ流儀）
  assertEquals((pick as unknown as { type?: string }).type, "button");
  assertEquals(pick.handlers.get("keydown"), undefined, "自前のキー処理を持っている");
  assertEquals(tile.attributes.get("role"), undefined, "枠に role を付けている");
  assertEquals(tile.attributes.get("tabindex"), undefined, "枠に tabindex を付けている");
  // 読み上げ名が無いと「ボタン」としか読まれない
  const label = pick.attributes.get("aria-label");
  assertExists(label);
  assert(label.includes("aすけ"), `名前が読み上げ名に入っていない: ${label}`);

  // ブラウザが Enter / Space を click に変換する。その click で主役になる
  pick.click();
  assertEquals(h.app.vcStage.playerId, "a");
  assertEquals(h.document.body.dataset.vcStage, "peer");
});

Deno.test("押し口は入れ子のボタンになっていない（札の中のボタンは外側に残る）", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);
  receiveVideo(h, 0, "screen");
  const tile = tileOf(h, "a");
  const pick = pickOf(tile);

  // 押し口の中は空（<button> の入れ子は HTML として不正）
  assertEquals(pick.children.length, 0, "押し口の中に要素がある");
  // 「拡大」は押し口の兄弟であって、子孫ではない
  const zoom = tile.querySelector(".vc-share-zoom");
  assertExists(zoom);
  assertEquals(pick.querySelector(".vc-share-zoom"), null, "拡大が押し口の中に入っている");
  // 枠そのものもボタンにはしない
  assertEquals(tile.tagName, "div");

  // 「拡大」を押すと、その共有画面が主役になる
  zoom.click();
  assertEquals(h.app.vcStage.playerId, "a");
  assertEquals(h.app.vcStage.source, "screen");
});

Deno.test("主役中のタイルをもう一度押すと主役を降りる", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);
  receiveVideo(h, 0, "camera");
  const pick = pickOf(tileOf(h, "a"));

  pick.click();
  assertEquals(h.app.vcStage.kind, "peer");
  pick.click();

  assertEquals(h.app.vcStage.kind, "none", "主役を降りていない");
  assert(h.element("vc-stage").hidden, "主役エリアが畳まれていない");
  assertEquals(h.document.body.dataset.vcStage, "none");
  assertEquals(h.element("vc-stage-video").srcObject, null, "ストリームが残っている");
  assertEquals(pickOf(tileOf(h, "a")).attributes.get("aria-pressed"), "false");
  assertFalse(tileOf(h, "a").className.includes("vc-peer-onstage"));
});

Deno.test("共有画面なら contain、カメラなら cover で主役に出す", async () => {
  const h = await load();
  await enterRoom(h, ["a", "b"]);
  receiveVideo(h, 0, "screen");
  receiveVideo(h, 1, "camera");
  const video = h.element("vc-stage-video");

  pickOf(tileOf(h, "a")).click();
  // 共有画面は端を切らない（読ませるための主役表示なので全体が入ることが最優先）
  assert(video.className.includes("vc-stage-video-screen"), "共有画面が contain になっていない");
  assertEquals(h.element("vc-stage-title").textContent, "aすけ さんの共有画面");

  pickOf(tileOf(h, "b")).click();
  // 人の顔は枠に合わせて切ってよい
  assertFalse(video.className.includes("vc-stage-video-screen"), "カメラが cover に戻っていない");
});

Deno.test("主役の人が共有をやめてカメラに変わると、主役の中身も追随する", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);
  receiveVideo(h, 0, "screen");
  pickOf(tileOf(h, "a")).click();
  assertEquals(h.app.vcStage.source, "screen");

  // 共有をやめてカメラへ戻った、という告知だけが届く
  h.vc.handleServerMessage({
    t: "rtcSignal",
    from: "a",
    payload: { kind: "video", on: true, source: "camera" },
  });

  assertEquals(h.app.vcStage.kind, "peer", "主役から落ちてしまっている");
  assertEquals(h.app.vcStage.source, "camera", "出どころが追随していない");
  assertFalse(h.element("vc-stage-video").className.includes("vc-stage-video-screen"));
});

// ---------------------------------------------------------------------------
// 異常系: 主役の人が消える
// ---------------------------------------------------------------------------

Deno.test("主役の人が退出すると主役が自動で解ける", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);
  receiveVideo(h, 0, "camera");
  pickOf(tileOf(h, "a")).click();
  assertEquals(h.app.vcStage.kind, "peer");

  h.socket().receive({
    t: "playerLeft",
    player: { id: "a", nickname: "aすけ", vcEligible: true, connected: false },
  });

  assertEquals(h.app.vcStage.kind, "none", "退出したのに主役が残っている");
  assert(h.element("vc-stage").hidden, "中身の無い主役エリアが残っている");
  assertEquals(h.element("vc-stage-video").srcObject, null);
});

Deno.test("主役の人がカメラを切ると主役が自動で解ける", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);
  receiveVideo(h, 0, "camera");
  pickOf(tileOf(h, "a")).click();

  h.vc.handleServerMessage({ t: "rtcSignal", from: "a", payload: { kind: "video", on: false } });

  assertEquals(h.app.vcStage.kind, "none", "カメラを切ったのに主役が残っている");
  // 映像の無い人は押しても主役にできない
  assert(pickOf(tileOf(h, "a")).disabled, "映像が無いのに押し口が開いている");
});

// ---------------------------------------------------------------------------
// あそびを主役にする
// ---------------------------------------------------------------------------

Deno.test("あそびが動き出すと自動であそびが主役になる", async () => {
  const h = await load();
  await enterRoom(h);
  assertEquals(h.app.vcStage.kind, "none");

  startGame(h);

  assertEquals(h.app.vcStage.kind, "game");
  assertEquals(h.document.body.dataset.vcStage, "game");
  assertFalse(h.element("vc-stage").hidden);
  // #phase をセクションごと動かす（内蔵のあそびは器を使わず #phase-body に直接描く）
  assertEquals(h.element("phase").parent, h.element("vc-stage-body"), "#phase が主役に居ない");
  // 二重に挿さっていないこと（remove してから appendChild しているか）
  assertEquals(h.element("phase-slot").children.length, 0, "定位置に抜け殻が残っている");
  // あそびが主役のあいだは降りる口を出さない
  assert(h.element("vc-stage-close").className.includes("hidden"));
});

Deno.test("あそびが主役のときに人を押すと入れ替わり、#phase は .stage-board に戻る", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);
  receiveVideo(h, 0, "camera");
  startGame(h);
  assertEquals(h.app.vcStage.kind, "game");

  pickOf(tileOf(h, "a")).click();

  assertEquals(h.app.vcStage.kind, "peer");
  assertEquals(h.app.vcStage.playerId, "a");
  assertEquals(h.element("phase").parent, h.element("phase-slot"), "#phase が定位置に戻っていない");
  assertEquals(h.element("phase-slot").parent, h.element("stage-board"));
  // 戻り先は #result より前（入れ物ごと定位置に置いてあるので順序は動かない）
  const board = h.element("stage-board");
  assertEquals(board.children.indexOf(h.element("phase-slot")), 0);
  assertEquals(board.children.indexOf(h.element("result")), 1);
  assertEquals(h.element("vc-stage-body").children.indexOf(h.element("phase")), -1);
});

Deno.test("主役を降りたとき、あそびが動いていればあそびが主役に戻る", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);
  receiveVideo(h, 0, "camera");
  startGame(h);
  const pick = pickOf(tileOf(h, "a"));
  pick.click();
  assertEquals(h.app.vcStage.kind, "peer");

  pick.click();

  assertEquals(h.app.vcStage.kind, "game", "あそびが主役に戻っていない");
  assertEquals(h.element("phase").parent, h.element("vc-stage-body"));
  assertFalse(h.element("vc-stage").hidden);
});

Deno.test("あそびが終わると主役から降り、#phase は定位置へ戻る", async () => {
  const h = await load();
  await enterRoom(h);
  startGame(h);
  assertEquals(h.app.vcStage.kind, "game");

  endGame(h);

  assertEquals(h.app.vcStage.kind, "none");
  assertEquals(h.document.body.dataset.vcStage, "none");
  assert(h.element("vc-stage").hidden);
  assertEquals(h.element("phase").parent, h.element("phase-slot"));
});

Deno.test("#phase を行き来させても、あそびの器は作り直されない", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);
  receiveVideo(h, 0, "camera");
  startGame(h);

  // ビューモジュールが器の中に置いた DOM の代わり
  const host = h.app.gameModuleHost();
  const planted = new FakeElement("canvas");
  host.appendChild(planted);
  assertEquals(host.parent, h.element("phase-body"), "器が #phase-body に居ない");

  // 主役 → 人 → 主役 と往復させる
  const pick = pickOf(tileOf(h, "a"));
  pick.click();
  pick.click();

  assertEquals(h.app.gameModuleHost(), host, "器が作り直されている");
  assertEquals(host.children.indexOf(planted), 0, "器の中身が消えている");
  assertEquals(host.parent, h.element("phase-body"), "器が #phase-body から外れている");
});

// ---------------------------------------------------------------------------
// 境界値: 主役が居ないとき／0人・1人
// ---------------------------------------------------------------------------

Deno.test("境界値: 誰も居ない卓では主役エリアを出さない（0人）", async () => {
  const h = await load();
  await enterRoom(h);

  assertEquals(h.app.vcStage.kind, "none");
  assert(h.element("vc-stage").hidden, "誰も居ないのに主役エリアが出ている");
  // 帯へ切り替えるのは CSS。その引き金になる body の印が「主役なし」であること
  assertEquals(h.document.body.dataset.vcStage, "none");
  // 自分の枠だけが並ぶ（格子のまま）
  assertEquals(h.people().children.length, 1);
});

Deno.test("境界値: 相手が1人でも、押すまでは主役エリアを出さない（1人）", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);
  receiveVideo(h, 0, "camera");

  assert(h.element("vc-stage").hidden, "押していないのに主役エリアが出ている");
  assertEquals(h.document.body.dataset.vcStage, "none");
  assertEquals(h.people().children.length, 2, "自分と相手の枠が並んでいない");
  // 映像が来ているので押し口は開いている
  assertFalse(pickOf(tileOf(h, "a")).disabled);
});

Deno.test("境界値: 映像が来ていない相手は主役にできない", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);

  const pick = pickOf(tileOf(h, "a"));
  assert(pick.disabled, "映像が無いのに押し口が開いている");
  // 押しても何も起きない（黒い枠だけの主役を作らない）
  pick.click();
  assertEquals(h.app.vcStage.kind, "none");
  assert(h.element("vc-stage").hidden);
});

// ---------------------------------------------------------------------------
// 卓を出る／全画面
// ---------------------------------------------------------------------------

Deno.test("卓を出ると主役の状態が初期化される", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);
  receiveVideo(h, 0, "camera");
  startGame(h);
  pickOf(tileOf(h, "a")).click();
  assertEquals(h.app.vcStage.kind, "peer");

  h.element("leave").click();

  assertEquals(h.app.vcStage.kind, "none", "主役が次の卓へ持ち越される");
  assertEquals(h.app.vcStage.playerId, null);
  assertEquals(h.document.body.dataset.vcStage, "none");
  assert(h.element("vc-stage").hidden);
  assertEquals(h.element("vc-stage-video").srcObject, null);
  // #phase は定位置に戻っている（次に入った卓であそびが始まっても迷子にならない）
  assertEquals(h.element("phase").parent, h.element("phase-slot"));
  assertEquals(h.people().children.length, 0, "自分の枠が残っている");
});

Deno.test("端末の全画面に出ているあいだの Escape では主役を降りない", async () => {
  const h = await load();
  await enterRoom(h, ["a"]);
  receiveVideo(h, 0, "screen");
  pickOf(tileOf(h, "a")).click();

  // 全画面はブラウザが Escape で外す。ここで主役まで降ろすと、
  // 一度の Escape で共有画面そのものが消えてしまう
  h.document.fullscreenElement = h.element("vc-stage-body");
  h.document.dispatch("keydown", { key: "Escape" });
  assertEquals(h.app.vcStage.kind, "peer", "全画面中の Escape で主役が降りている");

  // 全画面から出たあとの Escape は、従来どおり主役を降ろす
  h.document.fullscreenElement = null;
  h.document.dispatch("keydown", { key: "Escape" });
  assertEquals(h.app.vcStage.kind, "none", "Escape で主役を降りられない");
});

Deno.test("全画面 API の無い端末では、その押し口を出さない", async () => {
  const h = await load();
  // 偽の環境には requestFullscreen も webkitEnterFullscreen も無い
  assert(
    h.element("vc-stage-full").className.includes("hidden"),
    "対応していないのに全画面の押し口が出ている",
  );
  // 文言は状態から引く（F11 やブラウザの UI で外れても表示がずれない）
  assertEquals(h.element("vc-stage-full").textContent, "端末の全画面");
});

// ---------------------------------------------------------------------------
// 見た目の土台（index.html）の番人
//
// 偽の DOM には実測サイズが無いので高さそのものは測れない。
// 「高さの鎖を作る指定が消えていないか」だけを CSS の文字で見張る。
// ---------------------------------------------------------------------------

Deno.test("主役エリアからあそびの root まで、高さの鎖をつくる指定が残っている", async () => {
  const css = await Deno.readTextFile(INDEX_HTML);
  const rules = [
    // 主役エリア自身が親から高さを受け取る
    /\.vc-stage \{[^}]*flex: 1 1 0;[^}]*min-height: 0;/s,
    // 主役の中身の枠
    /\.vc-stage-body \{[^}]*flex: 1;[^}]*min-height: 0;/s,
    // #phase が枠いっぱいに広がり、縦に積む器になる
    /\.vc-stage-body > #phase \{[^}]*min-height: 0;[^}]*flex-direction: column;/s,
    // 残りの高さを #phase-body（＝あそびの root の親）へ渡す
    /\.vc-stage-body > #phase > #phase-body \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;/s,
  ];
  for (const rule of rules) {
    assert(rule.test(css), `高さの鎖が切れている: ${rule}`);
  }
});

Deno.test("主役が居るあいだは呑み手の面を横一列の帯にする指定がある", async () => {
  const css = await Deno.readTextFile(INDEX_HTML);
  // 折り返さず横に流す（格子のままだと主役の場所が無くなる）
  assert(
    /body:not\(\[data-vc-stage="none"\]\) #vc-people \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/s
      .test(css),
    "帯モードの指定が無い",
  );
  // 狭い画面（縦積み）でも潰れないよう、卓上の高さを取り直している
  assert(
    /@media \(max-width: 900px\)[\s\S]*body:not\(\[data-vc-stage="none"\]\) #vc \{/.test(css),
    "900px 以下での主役の場所取りが無い",
  );
  // 覆いは廃止した。主役エリアに一本化してある
  assertFalse(css.includes('id="vc-zoom"'), "拡大表示の覆いが残っている");
});
