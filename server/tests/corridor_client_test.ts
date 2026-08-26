/**
 * 廊下ビューの配線（public/assets/3d/corridor-ui.js）のテスト。
 *
 * クライアントのファイルだが、corridor-ui.js が触るブラウザ API は
 * DOM・requestAnimationFrame・ResizeObserver・MutationObserver・fetch・matchMedia
 * ・localStorage だけなので、偽物を渡せば Deno から素の JavaScript として動かせる
 * （voice_client_test.ts が public/room/voice.js でやっているのと同じ手口）。
 *
 * 3D 側（public/assets/3d/corridor-view.js）は WebGL が要るので動かせない。
 * 代わりに、合意した API の形だけを持つ偽の CorridorView を渡して、
 * 「受け取り側が何をするか」を見る。ここで守りたいのは次の7つ。
 *   - WebGL が無い端末でも卓を選べること（3D が唯一の入口にならないこと）
 *   - 一覧からも廊下からも、同じ入店の道（rooms.js の enterRoom）を通ること
 *   - 満席の卓を押せないこと
 *   - 後ろ（behind）の扉を前方に描かないこと
 *   - 画面の縁で札と矢印が入れ替わり続けないこと（歩くと毎フレーム跨ぐ）
 *   - サーバー由来の文字列が文字のまま入ること（innerHTML の経路を持たないこと）
 *   - 見えていない間は描画を止めること（映っていないのに電池を食わないこと）
 *
 * 実機でしか分からないこと（操作感・見え方・実際のフレームレート・
 * three.js の動的 import が本当に走ること）は見ていない。
 */

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";

const read = (rel: string) => Deno.readTextFile(fromFileUrl(new URL(rel, import.meta.url)));

/** 配線の本体。両ページで共通 */
const uiSource = await read("../../public/assets/3d/corridor-ui.js");
/** 入口。3D 本体をいつ読むかだけを持つ */
const entrySource = await read("../../public/corridor.js");
/** 一覧と入店（ホーム側のデータ源） */
const roomsSource = await read("../../public/rooms.js");
const htmlSource = await read("../../public/corridor.html");
const indexSource = await read("../../public/index.html");
const cssSource = await read("../../public/assets/en.css");
/* [hidden] の昇格で壊れていないことを見るための2本 */
const appSource = await read("../../public/app.js");
const vcSource = await read("../../public/room/vc.js");

/**
 * corridor-ui.js は ES モジュールだが import は持たない（three.js を引き連れる
 * corridor-view.js は呼び出し側から動的 import で渡される）。
 * export だけ外して関数の本体として読み込み、触るグローバルはすべて引数で受け取らせる。
 * 本物のグローバルには一切触れないので、テスト同士が互いの偽物を踏まない。
 */
const EXPORT_LINE = "export function mountCorridor(";
if (!uiSource.includes(EXPORT_LINE)) {
  throw new Error("corridor-ui.js の export が変わっています。テストの読み込み方を直してください");
}
const source = uiSource.replace(EXPORT_LINE, "function mountCorridor(") +
  "\nreturn { mountCorridor };";

// ── 偽 DOM ────────────────────────────────────────────
/*
 * server/tests/fake_dom.ts はこの枝には無く（別の枝の未マージ分）、
 * addEventListener が何もしない・style も getBoundingClientRect も持たない作りで、
 * 指の操作と毎フレームの位置決めを見るこのテストには足りない。
 * 共通部品を先に広げると他の枝と衝突するので、ここでは自前で持つ。
 */

/** corridor-ui.js が触る範囲だけの要素 */
class FakeEl {
  readonly children: FakeEl[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
  parent: FakeEl | null = null;
  className = "";
  type = "";
  value = "";
  hidden = false;
  disabled = false;
  open = false;
  clientWidth = 0;
  clientHeight = 0;
  rect = { left: 0, top: 0, width: 0, height: 0 };
  private text = "";

  /** 本物と同じく大文字（document.createElement("button") → "BUTTON"） */
  readonly tagName: string;

  constructor(tag: string, readonly id = "") {
    this.tagName = tag.toUpperCase();
  }

  readonly classList = {
    add: (name: string) => this.setClasses([...this.classes(), name]),
    remove: (name: string) => this.setClasses(this.classes().filter((c) => c !== name)),
    contains: (name: string) => this.classes().includes(name),
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes().includes(name);
      if (on) this.classList.add(name);
      else this.classList.remove(name);
      return on;
    },
  };

  private classes(): string[] {
    return this.className.split(" ").filter((c) => c.length > 0);
  }

  private setClasses(list: string[]): void {
    this.className = [...new Set(list)].join(" ");
  }

  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }

  /** 本物と同じく、子があれば子の文字を繋いで返す */
  get textContent(): string {
    if (this.children.length > 0) return this.children.map((c) => c.textContent).join("");
    return this.text;
  }

  set textContent(value: string) {
    this.children.length = 0;
    this.text = String(value);
  }

  appendChild(child: FakeEl): FakeEl {
    this.text = "";
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeEl[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  removeChild(child: FakeEl): FakeEl {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parent = null;
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  /** テストから操作を起こす */
  fire(type: string, ev: Record<string, unknown> = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ preventDefault() {}, ...ev });
  }

  /** rooms.js の enterRoom が押す本物の click（HTMLElement#click） */
  click(): void {
    this.fire("click");
  }

  getBoundingClientRect() {
    return this.rect;
  }

  get parentNode(): FakeEl | null {
    return this.parent;
  }

  /** 親から外す。表示・非表示は DOM の繋がりで表すので、これが「消す」操作になる */
  remove(): void {
    this.parent?.removeChild(this);
  }

  setPointerCapture(): void {}
  releasePointerCapture(): void {}

  // <dialog>
  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.fire("close");
  }

  /** 部分木をすべてたどる */
  *walk(): Generator<FakeEl> {
    yield this;
    for (const child of this.children) yield* child.walk();
  }
}

// ── 偽 CorridorView ───────────────────────────────────

interface Room {
  code: string;
  roomName: string;
  playerCount: number;
  capacity: number;
  playing: boolean;
  gameTitle?: string;
  tags?: string[];
  createdAt: number;
}

interface Door {
  /** その扉を一意に指す。視点が変わっても同じ扉なら同じ値。省略時は暫定の鍵に落ちる */
  id?: string;
  code: string;
  room: Room;
  x: number;
  y: number;
  distance: number;
  /** カメラ正面が 0、左が + の水平方位角（rad）。画面外の矢印の向きに使う */
  bearing: number;
  onScreen: boolean;
  behind: boolean;
}

/** 偽 CorridorView が受け取ったものの控え */
interface ViewLog {
  rooms: Room[];
  labels: Map<string, string> | null;
  steps: number[];
  turns: number[];
  inputs: Array<{ forward: number; strafe: number; turn: number }>;
  doors: Door[];
  paused: boolean;
  disposed: boolean;
  /** position の setter で入ってきた向き。矢印を押して振り向く経路を見る */
  yaw: number;
  /** focusedRoom。いま見ている扉の段（tier-focus）を決めるのに使われる */
  focus: Room | null;
  /** 3D 側が扉のタップ・Enter キーで呼ぶ入店の口 */
  onEnter: ((code: string) => void) | null;
}

/** どの API を生やすか。まだ入っていない状態も試せるようにしておく */
type ApiName = "pause" | "resume" | "visibleDoors" | "setInput";

interface LoadOptions {
  debug?: boolean;
  stageWidth?: number;
  stageHeight?: number;
  webgl?: boolean;
  reducedMotion?: boolean;
  throwOnCreate?: string;
  rejectReady?: string;
  /** 動的 import そのものが失敗した場合（配信の取りこぼし・オフライン） */
  failImport?: string;
  provide?: Partial<Record<ApiName, boolean>>;
  /** 覚えている表示（localStorage）。ホームでだけ効く */
  stored?: string;
}

const TAGS = {
  tags: [{ id: "board", label: "ボードゲーム" }, { id: "quiet", label: "静か" }],
};

/** テスト用の卓。既定は 3/6 名・人狼で遊んでいる 19:24 開始の卓 */
function room(over: Partial<Room> = {}): Room {
  return {
    code: "AKANE",
    roomName: "茜屋の奥座敷",
    playerCount: 3,
    capacity: 6,
    playing: true,
    gameTitle: "人狼",
    tags: ["board"],
    createdAt: new Date(2026, 7, 24, 19, 24).getTime(),
    ...over,
  };
}

/** corridor.html が持っている要素の ID。document はこれ以外には null を返す */
const STANDALONE_IDS = [
  "stage",
  "signs",
  "edges",
  "signs-note",
  "stick",
  "stick-knob",
  "left",
  "right",
  "back",
  "fwd",
  "enter",
  "count",
  "focus-name",
  "focus-meta",
  "error",
  "walk-controls",
  "mode-3d",
  "mode-list",
  "list-view",
  "rooms-list",
  "vc-join",
  "vc-leave",
  "confirm",
  "confirm-name",
  "confirm-state",
  "confirm-meta",
  "confirm-since",
  "confirm-ok",
  "confirm-cancel",
];

/** index.html が持っている要素の ID（廊下ぶん ＋ rooms.js / app.js が使うもの） */
const HOME_IDS = [
  "entry",
  "rooms-list",
  "rooms-count",
  "code",
  "join",
  "error",
  "corridor-stage",
  "corridor-signs",
  "corridor-edges",
  "corridor-note",
  "corridor-stick",
  "corridor-knob",
  "corridor-left",
  "corridor-right",
  "corridor-back",
  "corridor-fwd",
  "corridor-enter",
  "corridor-focus-name",
  "corridor-focus-meta",
  "corridor-error",
  "corridor-walk",
  "corridor-mode-3d",
  "corridor-mode-list",
  "corridor-list",
  "corridor-confirm",
  "corridor-confirm-name",
  "corridor-confirm-state",
  "corridor-confirm-meta",
  "corridor-confirm-since",
  "corridor-confirm-ok",
  "corridor-confirm-cancel",
];

/**
 * 偽のブラウザを1つ組み立てる。
 * ページの種類（corridor.html / index.html）ごとに、そのページにある要素だけを置く。
 * 置いていない ID には document.getElementById が null を返す
 * ――corridor-ui.js はこれで「どちらのページに載っているか」を見分ける。
 */
function makeWindow(ids: string[], options: LoadOptions = {}) {
  const elements = new Map<string, FakeEl>();
  for (const id of ids) elements.set(id, new FakeEl("div", id));

  const getElementById = (id: string): FakeEl | null => elements.get(id) ?? null;

  /** テストから触るときは、無い ID もその場で作って返す（assert の書きやすさのため） */
  const $ = (id: string): FakeEl => {
    const found = elements.get(id);
    if (found !== undefined) return found;
    const created = new FakeEl("div", id);
    elements.set(id, created);
    return created;
  };

  const docListeners = new Map<string, Array<() => void>>();
  const doc = {
    hidden: false,
    getElementById,
    createElement: (tag: string) => new FakeEl(tag),
    addEventListener(type: string, fn: () => void) {
      const list = docListeners.get(type) ?? [];
      list.push(fn);
      docListeners.set(type, list);
    },
  };
  const fireDocument = (type: string) => {
    for (const fn of [...(docListeners.get(type) ?? [])]) fn();
  };

  /** 覚えている表示。プライベートモードで例外になる環境も試せるようにしてある */
  const store = new Map<string, string>();
  if (options.stored !== undefined) store.set("en.corridor.mode", options.stored);

  const fakeGlobal: Record<string, unknown> = {
    matchMedia: () => ({
      matches: options.reducedMotion === true,
      addEventListener() {},
    }),
    location: { search: options.debug === true ? "?demo=1&debug=1" : "?demo=1" },
    WebGLRenderingContext: options.webgl === false ? undefined : class {},
    confirm: () => false,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
  };

  /** #entry の class を見張る。app.js の renderAll が付け外しするのと同じ経路 */
  const observers: Array<{ target: FakeEl; cb: () => void }> = [];
  class FakeMutationObserver {
    constructor(private readonly cb: () => void) {}
    observe(target: FakeEl): void {
      observers.push({ target, cb: this.cb });
    }
    disconnect(): void {}
  }
  const fireMutations = (target: FakeEl) => {
    for (const o of [...observers]) {
      if (o.target === target) o.cb();
    }
  };

  class FakeResizeObserver {
    constructor(private readonly cb: () => void) {}
    observe(): void {
      this.cb();
    }
    disconnect(): void {}
  }

  return {
    $,
    doc,
    fireDocument,
    fireMutations,
    fakeGlobal,
    store,
    FakeMutationObserver,
    FakeResizeObserver,
  };
}

/** 手で回す requestAnimationFrame */
function makeClock() {
  let frames = new Map<number, (now: number) => void>();
  let nextFrame = 1;
  let now = 0;
  const requestAnimationFrame = (fn: (now: number) => void) => {
    const id = nextFrame++;
    frames.set(id, fn);
    return id;
  };
  const cancelAnimationFrame = (id: number) => frames.delete(id);
  const tick = (times = 1) => {
    for (let i = 0; i < times; i++) {
      now += 16;
      const due = [...frames.values()];
      frames = new Map();
      for (const fn of due) fn(now);
    }
  };
  return { requestAnimationFrame, cancelAnimationFrame, tick };
}

/** 偽 CorridorView を1つ作る工場と、そこへ渡ってきたものの控えを返す */
function makeView(options: LoadOptions = {}) {
  const log: ViewLog = {
    rooms: [],
    labels: null,
    steps: [],
    turns: [],
    inputs: [],
    doors: [],
    paused: false,
    disposed: false,
    yaw: 0,
    focus: null,
    onEnter: null,
  };
  let created = false;

  const provide: Record<ApiName, boolean> = {
    pause: true,
    resume: true,
    visibleDoors: true,
    setInput: true,
    ...options.provide,
  };

  const createCorridorView = (
    container: FakeEl,
    opts: { onEnter?: (code: string) => void } = {},
  ) => {
    if (options.throwOnCreate !== undefined) throw new Error(options.throwOnCreate);
    created = true;
    log.onEnter = opts.onEnter ?? null;
    const canvas = new FakeEl("canvas");
    container.appendChild(canvas);
    // deno-lint-ignore no-explicit-any
    const api: any = {
      ready: options.rejectReady === undefined
        ? Promise.resolve()
        : Promise.reject(new Error(options.rejectReady)),
      setRooms(rooms: Room[], labels: Map<string, string>) {
        log.rooms = rooms;
        log.labels = labels;
      },
      step: (d: number) => log.steps.push(d),
      turn: (d: number) => log.turns.push(d),
      get focusedRoom() {
        return log.focus;
      },
      get position(): { x: number; z: number; yaw: number } {
        return { x: 0, z: 0, yaw: log.yaw };
      },
      set position(p: { x?: number; z?: number; yaw?: number }) {
        if (typeof p?.yaw === "number") log.yaw = p.yaw;
      },
      dispose() {
        log.disposed = true;
        container.removeChild(canvas);
      },
    };
    if (provide.pause) {
      api.pause = () => {
        log.paused = true;
      };
    }
    if (provide.resume) {
      api.resume = () => {
        log.paused = false;
      };
    }
    if (provide.visibleDoors) api.visibleDoors = () => log.doors;
    if (provide.setInput) {
      api.setInput = (input: { forward: number; strafe: number; turn: number }) =>
        log.inputs.push({ ...input });
    }
    return api;
  };

  /** corridor.js が渡すのと同じ形（3D 本体を後から読む関数） */
  const createView = () => {
    if (options.failImport !== undefined) return Promise.reject(new Error(options.failImport));
    return Promise.resolve(createCorridorView);
  };

  return {
    log,
    createView,
    get created() {
      return created;
    },
  };
}

/** corridor-ui.js を1つ読み込んで、mountCorridor を取り出す */
// deno-lint-ignore no-explicit-any
function loadModule(env: any) {
  return new Function(
    "document",
    "globalThis",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "ResizeObserver",
    "MutationObserver",
    "fetch",
    "setInterval",
    source,
  )(
    env.doc,
    env.fakeGlobal,
    env.requestAnimationFrame,
    env.cancelAnimationFrame,
    env.FakeResizeObserver,
    env.FakeMutationObserver,
    env.fetch,
    () => 0,
    // deno-lint-ignore no-explicit-any
  ) as { mountCorridor: (o: unknown) => any };
}

/** 待ち合わせ。main() の中の await（タグ取得・ready）を落ち着かせる */
async function settle(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** corridor.html（単独ページ）として読み込む */
async function load(options: LoadOptions = {}) {
  const win = makeWindow(STANDALONE_IDS, options);
  const clock = makeClock();
  const view = makeView(options);
  const { $, doc } = win;

  // corridor.html が持っている初期状態を写す
  $("stage").clientWidth = options.stageWidth ?? 800;
  $("stage").clientHeight = options.stageHeight ?? 600;
  $("stick").rect = { left: 0, top: 0, width: 132, height: 132 };
  $("list-view").className = "corridor-list hidden";
  $("error").className = "corridor-error hidden";
  $("mode-3d").setAttribute("aria-pressed", "true");
  $("mode-list").setAttribute("aria-pressed", "false");
  $("vc-leave").disabled = true;

  const fetched: string[] = [];
  const fetchStub = (url: string) => {
    fetched.push(String(url));
    const body = String(url).includes("room-tags") ? TAGS : { rooms: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };

  const mod = loadModule({ ...win, ...clock, fetch: fetchStub });
  const ui = mod.mountCorridor({ createView: view.createView });
  await ui.ready;
  await settle();

  /*
   * 表示されている＝コンテナに繋がっている。スタイルではなく構造で判定する。
   * 偽 DOM は CSS のカスケードを再現できないので、スタイルで隠す作りだと
   * 「隠したつもり」を検証できない（実際それで hidden の不具合を取り逃がした）。
   */
  const shown = (id: string) => [...$(id).children];
  const part = (root: FakeEl, cls: string): FakeEl => {
    const found = [...root.walk()].find((n) => n.className.split(" ").includes(cls));
    if (found === undefined) throw new Error(`${cls} が見つかりません`);
    return found;
  };

  return {
    $,
    doc,
    ui,
    log: view.log,
    fetched,
    tick: clock.tick,
    fireDocument: win.fireDocument,
    get created() {
      return view.created;
    },
    signs: () => shown("signs"),
    edges: () => shown("edges"),
    part,
    /** 札の卓名の一覧 */
    signNames: () => shown("signs").map((s) => part(s, "corridor-sign-name").textContent),
    /** 札の段の一覧（近い順） */
    tiers: () =>
      shown("signs").map((s) => s.className.split(" ").find((c) => c.startsWith("tier-")) ?? "?"),
  };
}

/**
 * index.html（本番のホーム）として読み込む。
 * rooms.js も同じ偽ブラウザの上で動かすので、一覧の取得・購読・入店まで通しで見られる。
 */
async function loadHome(options: LoadOptions & { rooms?: Room[] } = {}) {
  const win = makeWindow(HOME_IDS, options);
  const clock = makeClock();
  const view = makeView(options);
  const { $, doc } = win;

  $("corridor-stage").clientWidth = options.stageWidth ?? 800;
  $("corridor-stage").clientHeight = options.stageHeight ?? 600;
  $("corridor-stick").rect = { left: 0, top: 0, width: 132, height: 132 };
  $("corridor-stage").className = "corridor-stage hidden";
  $("corridor-walk").className = "corridor-walk hidden";
  $("corridor-list").className = "corridor-home-list";
  $("corridor-error").className = "corridor-error";
  $("corridor-mode-3d").setAttribute("aria-pressed", "false");
  $("corridor-mode-list").setAttribute("aria-pressed", "true");

  const rooms = options.rooms ?? [room()];
  const fetched: string[] = [];
  const fetchStub = (url: string) => {
    fetched.push(String(url));
    const body = String(url).includes("room-tags") ? TAGS : { rooms };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };

  // rooms.js（一覧・入店・購読の口）を先に走らせる。index.html と同じ順番
  new Function(
    "window",
    "document",
    "fetch",
    "setInterval",
    "clearInterval",
    "MutationObserver",
    "console",
    roomsSource,
  )(
    win.fakeGlobal,
    doc,
    fetchStub,
    () => 0,
    () => {},
    win.FakeMutationObserver,
    console,
  );
  await settle();

  const mod = loadModule({ ...win, ...clock, fetch: fetchStub });
  const ui = mod.mountCorridor({ createView: view.createView });
  await ui.ready;
  await settle();

  const shown = (id: string) => [...$(id).children];
  return {
    $,
    doc,
    ui,
    log: view.log,
    fetched,
    store: win.store,
    tick: clock.tick,
    fireDocument: win.fireDocument,
    fireMutations: win.fireMutations,
    get created() {
      return view.created;
    },
    signs: () => shown("corridor-signs"),
    edges: () => shown("corridor-edges"),
    /** #entry を隠す／戻す。app.js の renderAll がやるのと同じこと */
    setInRoom(inRoom: boolean) {
      $("entry").classList.toggle("hidden", inRoom);
      win.fireMutations($("entry"));
    },
  };
}

// ── 一覧へのフォールバック（3D が唯一の入口にならないこと） ──

Deno.test("corridor.js: WebGL が使えなければ卓の一覧へ自動で落ちる", async () => {
  const h = await load({ webgl: false });
  assertFalse(h.created, "WebGL が無いのに 3D を作りにいってはいけない");
  assert(h.$("list-view").classList.contains("hidden") === false, "一覧が出ていない");
  assert(h.$("stage").classList.contains("hidden"), "3D の場が残っている");
  assertEquals(h.$("mode-list").getAttribute("aria-pressed"), "true");
  assertStringIncludes(h.$("error").textContent, "一覧に切り替えました");
  assertEquals(h.$("rooms-list").children.length, 7, "一覧に卓のカードが並んでいない");
});

Deno.test("corridor.js: 廊下の読み込みに失敗しても一覧へ落ち、作りかけを片付ける", async () => {
  const h = await load({ rejectReady: "GLB を読み込めませんでした" });
  assert(h.$("list-view").classList.contains("hidden") === false);
  assertStringIncludes(h.$("error").textContent, "GLB を読み込めませんでした");
  assert(h.log.disposed, "作りかけの canvas を残している");
  assertEquals(h.$("rooms-list").children.length, 7);
});

Deno.test("corridor.js: 生成時に例外が出ても一覧へ落ちる", async () => {
  const h = await load({ throwOnCreate: "WebGL の初期化に失敗しました" });
  assert(h.$("list-view").classList.contains("hidden") === false);
  assertStringIncludes(h.$("error").textContent, "WebGL の初期化に失敗しました");
});

Deno.test("corridor.js: 3D が動かなくても切り替えボタン自体は残す", async () => {
  const h = await load({ webgl: false });
  assert(h.$("mode-3d").disabled, "描けない側は塞ぐ");
  assertFalse(h.$("mode-list").disabled, "一覧側まで塞いではいけない");
});

Deno.test("corridor.js: 3D が動く端末でも一覧を選べ、そのあいだは描画を止める", async () => {
  const h = await load();
  assertFalse(h.log.paused);
  h.$("mode-list").fire("click");
  assert(h.log.paused, "一覧を見ているあいだも描き続けている");
  assert(h.$("stage").classList.contains("hidden"));
  assertEquals(h.$("mode-list").getAttribute("aria-pressed"), "true");
  h.$("mode-3d").fire("click");
  assertFalse(h.log.paused, "店内へ戻しても再開していない");
});

// ── 札の並べ方 ────────────────────────────────────────

/**
 * 重なり・距離・向き・画面外をまとめて見るための扉の並び。
 * visibleDoors() は距離順に返す約束なので、こちらもその順に並べてある。
 */
function doorFixture(): Door[] {
  return [
    {
      code: "F",
      room: room({ code: "F", roomName: "後ろの卓" }),
      x: 300,
      y: 300,
      distance: 2,
      bearing: Math.PI,
      onScreen: true,
      behind: true,
    },
    {
      code: "A",
      room: room({ code: "A", roomName: "近い卓" }),
      x: 400,
      y: 300,
      distance: 3,
      bearing: 0.02,
      onScreen: true,
      behind: false,
    },
    {
      code: "H",
      room: room({ code: "H", roomName: "左後ろの卓" }),
      x: 10,
      y: 10,
      distance: 3,
      bearing: 2.4,
      onScreen: false,
      behind: true,
    },
    {
      code: "D",
      room: room({ code: "D", roomName: "満席の卓", playerCount: 6, capacity: 6 }),
      x: 650,
      y: 200,
      distance: 4,
      bearing: -0.3,
      onScreen: true,
      behind: false,
    },
    {
      code: "C",
      room: room({ code: "C", roomName: "離れた卓" }),
      x: 120,
      y: 480,
      distance: 5,
      bearing: 0.4,
      onScreen: true,
      behind: false,
    },
    {
      code: "B",
      room: room({ code: "B", roomName: "重なる卓" }),
      x: 410,
      y: 305,
      distance: 6,
      bearing: 0.02,
      onScreen: true,
      behind: false,
    },
    {
      code: "E",
      room: room({ code: "E", roomName: "画面の外" }),
      x: 1400,
      y: 300,
      distance: 7,
      bearing: -0.6,
      onScreen: false,
      behind: false,
    },
    {
      code: "G",
      room: room({ code: "G", roomName: "遠すぎる卓" }),
      x: 500,
      y: 300,
      distance: 30,
      bearing: 0,
      onScreen: true,
      behind: false,
    },
  ];
}

Deno.test("corridor.js: behind の扉は札にしない（符号の反転を受け取り側でも弾く）", async () => {
  const h = await load();
  h.log.doors = doorFixture();
  h.tick();
  const names = h.signNames();
  assertFalse(names.includes("後ろの卓"), "後ろの扉が前に出ている");
  assertFalse(names.includes("左後ろの卓"), "後ろの扉が前に出ている");
});

Deno.test("corridor.js: 札が重なるときは近いほうを残し、省いた枚数を注記に出す", async () => {
  const h = await load();
  h.log.doors = doorFixture();
  h.tick();
  const names = h.signNames();
  assert(names.includes("近い卓"), "近い札が出ていない");
  assertFalse(names.includes("重なる卓"), "重なった遠い札まで出している");
  assert(names.includes("離れた卓"), "離れた位置の札まで捨てている");
  assertStringIncludes(h.$("signs-note").textContent, "省略");
});

Deno.test("corridor.js: 9m より遠い扉には札を出さない", async () => {
  const h = await load();
  h.log.doors = doorFixture();
  h.tick();
  assertFalse(h.signNames().includes("遠すぎる卓"));
});

// ── 段階表示（近い扉だけ詳しく） ──────────────────────

Deno.test("corridor.js: 近い扉は複数あっても詳細を出し、溢れたぶんは錠剤・点へ落とす", async () => {
  const h = await load();
  const rooms = [
    room({ code: "A", roomName: "卓1" }),
    room({ code: "B", roomName: "卓2" }),
    room({ code: "C", roomName: "卓3" }),
    room({ code: "D", roomName: "卓4" }),
    room({ code: "E", roomName: "卓5" }),
  ];
  // 重ならないよう散らす。距離は 1,2,3,4,5m
  h.log.doors = rooms.map((r, i) => ({
    id: `d${i}`,
    code: r.code,
    room: r,
    x: 100 + i * 140,
    y: 100 + i * 90,
    distance: 1 + i,
    bearing: 0,
    onScreen: true,
    behind: false,
  }));
  // focusedRoom は使わない。距離だけで段が決まること
  h.log.focus = null;
  h.tick();

  // 3.5m 以内の2枚が詳細。3枚目は枚数の天井で錠剤へ、
  // 4・5枚目は面積の予算に入らないので点へ落ちる（消えはしない）
  assertEquals(h.tiers(), ["tier-focus", "tier-focus", "tier-pill", "tier-dot", "tier-dot"]);
  assertEquals(h.signs().length, 5, "予算のために扉ごと消してはいけない");

  // どの段でも、読み上げには全部の情報が載っている
  for (const sign of h.signs()) {
    const label = sign.getAttribute("aria-label") ?? "";
    assertStringIncludes(label, "6人中3人");
    assertStringIncludes(label, "19:24 から");
  }
});

Deno.test("corridor.js: 段は focusedRoom ではなく距離で決まる", async () => {
  const h = await load();
  const one = room({ code: "A", roomName: "近い卓" });
  h.log.focus = null; // 目の前の扉が無いとされている状態でも
  h.log.doors = [
    {
      id: "d0",
      code: "A",
      room: one,
      x: 400,
      y: 300,
      distance: 2,
      bearing: 0,
      onScreen: true,
      behind: false,
    },
  ];
  h.tick();
  assertEquals(h.tiers(), ["tier-focus"], "通路の途中で詳細が1枚も出ない");

  // 離れれば錠剤、さらに離れれば点
  h.log.doors = [
    {
      id: "d0",
      code: "A",
      room: one,
      x: 400,
      y: 300,
      distance: 4.5,
      bearing: 0,
      onScreen: true,
      behind: false,
    },
  ];
  h.tick();
  assertEquals(h.tiers(), ["tier-pill"]);

  h.log.doors = [
    {
      id: "d0",
      code: "A",
      room: one,
      x: 400,
      y: 300,
      distance: 8,
      bearing: 0,
      onScreen: true,
      behind: false,
    },
  ];
  h.tick();
  assertEquals(h.tiers(), ["tier-dot"]);
});

Deno.test("corridor.js: 札の合計面積は上限を超えない（占有率が跳ねない）", async () => {
  // CSS と corridor.js の SIGN_BOX に合わせた寸法。ここがずれたら両方直すこと
  const BOX: Record<string, { w: number; h: number }> = {
    "tier-focus": { w: 150, h: 72 },
    "tier-pill": { w: 124, h: 28 },
    "tier-dot": { w: 42, h: 20 },
  };
  const h = await load({ stageWidth: 390, stageHeight: 560 });
  // 目の前に扉が密集している最悪の場合（全部 1m 以内・重ならない位置）
  h.log.doors = Array.from({ length: 10 }, (_, i) => {
    const r = room({ code: `R${i}`, roomName: `卓${i}` });
    return {
      id: `d${i}`,
      code: r.code,
      room: r,
      x: 30 + (i % 2) * 200,
      y: 30 + Math.floor(i / 2) * 100,
      distance: 0.5,
      bearing: 0,
      onScreen: true,
      behind: false,
    };
  });
  h.tick();

  let area = 0;
  for (const sign of h.signs()) {
    const tier = sign.className.split(" ").find((c) => c.startsWith("tier-"))!;
    const scale = Number(sign.style.transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1);
    area += BOX[tier].w * BOX[tier].h * scale * scale;
  }
  // 詳細2枚(21,600) ＋ 錠剤1枚(3,472) ＋ 点3枚(2,520) = 27,592px²
  assert(area <= 27_600, `札が画面を食いすぎている: ${Math.round(area)}px²`);
  // 幅390 × 高さ560 の場に対して 13% 未満
  assert(area / (390 * 560) < 0.13, `占有率が高すぎる: ${(area / (390 * 560) * 100).toFixed(1)}%`);
  assert(h.signs().length <= 6);
});

Deno.test("corridor.js: 幅390pxの画面でも札は6枚・矢印は3件を超えない", async () => {
  const h = await load({ stageWidth: 390, stageHeight: 700 });
  // 見える扉を多めに（壁越しを落としても平均 8.5 枚返る想定）
  h.log.doors = Array.from({ length: 14 }, (_, i) => {
    const r = room({ code: `R${i}`, roomName: `卓${i}` });
    return {
      code: r.code,
      room: r,
      x: 40 + (i % 5) * 78,
      y: 60 + Math.floor(i / 5) * 200,
      distance: 1 + i * 0.5,
      bearing: 0,
      onScreen: i < 11,
      behind: i >= 12,
    };
  });
  h.tick();
  assert(h.signs().length <= 6, `札が多すぎる: ${h.signs().length}枚`);
  assert(h.edges().length <= 3, `矢印が多すぎる: ${h.edges().length}件`);
  assertStringIncludes(h.$("signs-note").textContent, "札");
});

Deno.test("corridor.js: 遠い札ほど小さく薄い", async () => {
  const h = await load();
  h.log.doors = doorFixture();
  h.tick();
  const near = h.signs().find((s) => h.part(s, "corridor-sign-name").textContent === "近い卓");
  const far = h.signs().find((s) => h.part(s, "corridor-sign-name").textContent === "離れた卓");
  assert(near !== undefined && far !== undefined);
  const scaleOf = (e: FakeEl) => Number(e.style.transform.match(/scale\(([\d.]+)\)/)?.[1]);
  assert(scaleOf(far) < scaleOf(near), "遠い札が小さくなっていない");
  assert(Number(far.style.opacity) < Number(near.style.opacity), "遠い札が薄くなっていない");
});

// ── 画面外の卓（bearing で向きを出す） ────────────────

Deno.test("corridor.js: 画面外の卓は画面の縁に矢印で寄せる", async () => {
  const h = await load();
  h.log.doors = doorFixture();
  h.tick();
  const edges = h.edges();
  // 後ろ2つ ＋ 前方だが画面外の1つ ＝ 3件（上限ちょうど）
  assertEquals(edges.length, 3, "画面外の卓を出していない");
  for (const edge of edges) {
    const at = edge.style.transform.match(/translate3d\((-?[\d.]+)px, (-?[\d.]+)px/);
    assert(at !== null, "位置が入っていない");
    const x = Number(at[1]);
    const y = Number(at[2]);
    assert(x >= 0 && x <= 800 && y >= 0 && y <= 600, `画面の外に置いている: ${x},${y}`);
    assertStringIncludes(edge.children[0].style.transform, "rotate", "矢印の向きが無い");
  }
});

Deno.test("corridor.js: bearing から左後ろ／右後ろ／真後ろを区別して出す", async () => {
  const h = await load();
  const mk = (code: string, bearing: number): Door => ({
    code,
    room: room({ code, roomName: code }),
    x: 0,
    y: 0,
    distance: 3,
    bearing,
    onScreen: false,
    behind: true,
  });
  const at = (i: number) => {
    const m = h.edges()[i].style.transform.match(/translate3d\((-?[\d.]+)px, (-?[\d.]+)px/);
    return { x: Number(m![1]), y: Number(m![2]) };
  };

  // 真後ろ（bearing = π）は画面の下、左後ろは左下、右後ろは右下
  h.log.doors = [mk("BACK", Math.PI)];
  h.tick();
  assertEquals(at(0).x, 400, "真後ろの卓が中央に来ていない");
  assert(at(0).y > 300, "真後ろの卓が下に来ていない");

  h.log.doors = [mk("LEFT", (Math.PI * 3) / 4)];
  h.tick();
  assert(at(0).x < 400, `左後ろの卓が左に出ていない: ${at(0).x}`);
  assert(at(0).y > 300, "左後ろの卓が下に出ていない");

  h.log.doors = [mk("RIGHT", (-Math.PI * 3) / 4)];
  h.tick();
  assert(at(0).x > 400, `右後ろの卓が右に出ていない: ${at(0).x}`);
  assert(at(0).y > 300, "右後ろの卓が下に出ていない");

  // 真横（bearing = ±π/2）は縁の中ほど
  h.log.doors = [mk("SIDE", Math.PI / 2)];
  h.tick();
  assert(
    at(0).x < 100 && Math.abs(at(0).y - 300) < 1,
    `真左が縁の中ほどに来ていない: ${at(0).x},${at(0).y}`,
  );
});

Deno.test("corridor.js: 画面外の矢印を押すと、その卓のほうを向く", async () => {
  const h = await load();
  h.log.doors = [{
    code: "E",
    room: room({ code: "E", roomName: "画面の外" }),
    x: 0,
    y: 0,
    distance: 3,
    bearing: 2,
    onScreen: false,
    behind: true,
  }];
  h.tick();
  assertEquals(h.log.yaw, 0);
  h.edges()[0].fire("click");
  // bearing は正面が 0 で左が +。yaw に足せばその扉が正面に来る
  assertEquals(h.log.yaw, 2);
  assertFalse(h.$("confirm").open, "見えていない卓の入店確認をいきなり出している");
});

// ── 境目での点滅を止める（ヒステリシス） ──────────────

Deno.test("corridor.js: 画面の縁を跨いでも札と矢印が入れ替わり続けない", async () => {
  const h = await load();
  const one = room({ code: "A", roomName: "縁の卓" });
  const put = (x: number) => {
    h.log.doors = [{
      code: "A",
      room: one,
      x,
      y: 300,
      distance: 3,
      bearing: 0,
      onScreen: x >= 0 && x <= 800,
      behind: false,
    }];
    h.tick();
    // 同じ扉が札と矢印の両方に出てはいけない
    assertEquals(h.signs().length + h.edges().length, 1, `x=${x} で二重に出ている`);
    return h.signs().length === 1 ? "sign" : "edge";
  };

  const modes: string[] = [];
  // 縁のすぐ内 ⇄ すぐ外を何度も往復する（歩いていると毎フレーム起きる）
  for (const x of [400, 790, 810, 790, 810, 790, 810]) modes.push(put(x));
  assertEquals(new Set(modes).size, 1, `縁の往復で入れ替わっている: ${modes}`);
  assertEquals(modes[0], "sign");

  // 十分に外へ出れば矢印になる
  assertEquals(put(900), "edge");
  // すぐ内側へ戻ったくらいでは札に戻さない（ここで戻すとまた点滅する）
  assertEquals(put(790), "edge");
  assertEquals(put(810), "edge");
  // 十分に内側まで入って初めて札へ戻る
  assertEquals(put(600), "sign");
});

// ── 札の中身 ──────────────────────────────────────────

Deno.test("corridor.js: 人数は 3/6 形式で、状態を記号と文字の両方で示す", async () => {
  const h = await load();
  const rooms = [
    room({ code: "A", roomName: "遊んでいる卓" }),
    room({ code: "B", roomName: "空の卓", playerCount: 0, playing: false, gameTitle: undefined }),
    room({ code: "C", roomName: "歓談の卓", playing: false, gameTitle: undefined }),
    room({ code: "D", roomName: "満席の卓", playerCount: 6, playing: false, gameTitle: undefined }),
  ];
  h.log.doors = rooms.map((r, i) => ({
    code: r.code,
    room: r,
    x: 150 + (i % 2) * 400,
    y: 150 + Math.floor(i / 2) * 300,
    distance: 3,
    bearing: 0,
    onScreen: true,
    behind: false,
  }));
  h.tick();
  const byName = new Map(
    h.signs().map((s) => [h.part(s, "corridor-sign-name").textContent, s] as const),
  );
  assertEquals(byName.size, 4, "4枚とも出ていない");

  const seats = (name: string) => h.part(byName.get(name)!, "corridor-sign-seats").textContent;
  const mark = (name: string) => h.part(byName.get(name)!, "corridor-sign-mark").textContent;
  const label = (name: string) => h.part(byName.get(name)!, "corridor-sign-label").textContent;

  assertEquals(seats("遊んでいる卓"), "3/6");
  assertEquals(seats("満席の卓"), "6/6");
  // 記号と文字の両方。色が見えなくても読み分けられること
  assertEquals([mark("遊んでいる卓"), label("遊んでいる卓")], ["▶", "ゲーム中"]);
  assertEquals([mark("空の卓"), label("空の卓")], ["○", "空き"]);
  assertEquals([mark("歓談の卓"), label("歓談の卓")], ["●", "入店中"]);
  assertEquals([mark("満席の卓"), label("満席の卓")], ["×", "満席"]);

  const sign = byName.get("遊んでいる卓")!;
  assertEquals(h.part(sign, "corridor-sign-game").textContent, "人狼 で遊んでいます");
  assertEquals(h.part(sign, "corridor-sign-tags").textContent, "ボードゲーム");
  assertEquals(h.part(sign, "corridor-sign-since").textContent, "19:24 から");
  assertStringIncludes(sign.getAttribute("aria-label") ?? "", "6人中3人");
});

Deno.test("corridor.js: 満席の卓は押せない（札と一覧のどちらからも）", async () => {
  const h = await load();
  const full = room({ code: "D", roomName: "満席の卓", playerCount: 6, capacity: 6 });
  h.log.doors = [
    {
      code: "D",
      room: full,
      x: 400,
      y: 300,
      distance: 3,
      bearing: 0,
      onScreen: true,
      behind: false,
    },
  ];
  h.tick();
  assert(h.signs()[0].disabled, "満席の札を押せてしまう");

  // 一覧側（デモの「蛍」が 6/6）
  const card = h.$("rooms-list").children.find((c) =>
    [...c.walk()].some((n) => n.textContent === "蛍")
  );
  assert(card !== undefined, "満席の卓が一覧に無い");
  const button = [...card.walk()].find((n) => n.tagName === "BUTTON");
  assert(button?.disabled === true, "一覧から満席の卓に入れてしまう");

  // 押しても確認は出ない
  h.signs()[0].fire("click");
  assertFalse(h.$("confirm").open);
});

Deno.test("corridor.js: 満席でも画面外の矢印は押せる（入店ではなく振り向くため）", async () => {
  const h = await load();
  const full = room({ code: "D", roomName: "満席の卓", playerCount: 6, capacity: 6 });
  h.log.doors = [
    { code: "D", room: full, x: 0, y: 0, distance: 3, bearing: 1, onScreen: false, behind: true },
  ];
  h.tick();
  assertFalse(h.edges()[0].disabled, "振り向くだけの矢印まで塞いでいる");
  assertStringIncludes(h.edges()[0].getAttribute("aria-label") ?? "", "満席");
  h.edges()[0].fire("click");
  assertEquals(h.log.yaw, 1);
  assertFalse(h.$("confirm").open);
});

Deno.test("corridor.js: 卓名やタグは文字のまま入る（innerHTML の経路を持たない）", async () => {
  const evil = '<img src=x onerror="alert(1)">「あ」&amp;';
  const h = await load();
  h.log.doors = [
    {
      code: "X",
      room: room({ code: "X", roomName: evil }),
      x: 400,
      y: 300,
      distance: 3,
      bearing: 0,
      onScreen: true,
      behind: false,
    },
  ];
  h.tick();
  const name = h.part(h.signs()[0], "corridor-sign-name");
  assertEquals(name.textContent, evil, "卓名が加工されている");
  assertEquals(name.children.length, 0, "卓名が要素に化けている（HTML として解釈されている）");
  assertFalse(uiSource.includes("innerHTML"), "corridor.js が innerHTML を使っている");
  assertFalse(uiSource.includes("outerHTML"), "corridor.js が outerHTML を使っている");
  assertFalse(uiSource.includes("insertAdjacentHTML"));
});

Deno.test("corridor.html / index.html: インラインの script や on* 属性を持たない（CSP）", () => {
  for (const [name, page] of [["corridor.html", htmlSource], ["index.html", indexSource]]) {
    assertFalse(/<script(?![^>]*\bsrc=)/i.test(page), `${name} にインラインの script がある`);
    assertFalse(/\son[a-z]+\s*=/i.test(page), `${name} に on* 属性がある`);
    assertFalse(
      /<script[^>]*type=["']importmap/i.test(page),
      `${name} のインライン importmap は CSP に弾かれる`,
    );
  }
  // ESM は type="module" ＋ 絶対パスの import だけで読む。
  // 本番の CSP は default-src 'self' だけで script-src を別に持たないので、
  // 同一オリジンの絶対パスなら静的 import も動的 import も通る。
  assertStringIncludes(indexSource, '<script type="module" src="./corridor.js">');
  assertStringIncludes(entrySource, `import("/assets/3d/corridor-view.js")`);
});

Deno.test("en.css: 札の寸法は corridor-ui.js の SIGN_BOX と揃っている", () => {
  // 重なり判定は SIGN_BOX の値でやるので、CSS とずれると札が重なる
  for (
    const [tier, w, h] of [["tier-focus", 150, 72], ["tier-pill", 124, 28], [
      "tier-dot",
      42,
      20,
    ]] as const
  ) {
    assertStringIncludes(uiSource, `"${tier}": { w: ${w}, h: ${h} }`);
    assert(cssSource.includes(`.${tier} {`), `${tier} の CSS が無い`);
  }
  // いま見ている扉では、状態を記号だけでなく文字でも出す
  assert(
    cssSource.includes(".tier-focus > .corridor-sign-label {"),
    "焦点の札で状態の文字が隠れたままになっている",
  );
  assertStringIncludes(cssSource, "width: 150px");
  assertStringIncludes(cssSource, "max-width: 124px");
  assertStringIncludes(cssSource, "width: 42px");
});

Deno.test("en.css: 廊下の見た目は1か所にまとめてある（2ページに写していない）", () => {
  // corridor.html と index.html が同じ CSS を持つと、片方だけ直る事故が起きる
  for (const page of [htmlSource, indexSource]) {
    assertFalse(page.includes(".corridor-sign {"), "札の CSS がページ側に残っている");
    assertFalse(page.includes(".tier-focus {"), "段の CSS がページ側に残っている");
    assertFalse(page.includes(".corridor-stick {"), "スティックの CSS がページ側に残っている");
  }
});

// ── 入店 ──────────────────────────────────────────────

Deno.test("corridor.js: 押すと確認を挟み、確認して初めて入店する", async () => {
  const h = await load();
  h.log.doors = [
    {
      code: "A",
      room: room({ code: "A", roomName: "近い卓" }),
      x: 400,
      y: 300,
      distance: 3,
      bearing: 0,
      onScreen: true,
      behind: false,
    },
  ];
  h.tick();

  h.signs()[0].fire("click");
  assert(h.$("confirm").open, "確認が出ていない");
  assertEquals(h.$("confirm-name").textContent, "近い卓（A）");
  assertStringIncludes(h.$("confirm-state").textContent, "3/6");
  assertStringIncludes(h.$("confirm-since").textContent, "19:24");

  h.$("confirm-cancel").fire("click");
  assertFalse(h.$("confirm").open);
  assertFalse(h.$("count").textContent.includes("「A」"), "やめたのに入店している");

  h.signs()[0].fire("click");
  h.$("confirm-ok").fire("click");
  assertStringIncludes(h.$("count").textContent, "「A」を選びました");
  assertFalse(h.$("confirm").open);
});

Deno.test("corridor.js: 確認を開くとその場で足を止める", async () => {
  const h = await load();
  h.log.doors = [
    {
      code: "A",
      room: room({ code: "A", roomName: "近い卓" }),
      x: 400,
      y: 300,
      distance: 3,
      bearing: 0,
      onScreen: true,
      behind: false,
    },
  ];
  h.tick();
  h.$("stick").fire("pointerdown", { pointerId: 1, clientX: 66, clientY: 0 });
  h.tick(30);
  assert(h.log.inputs.at(-1)!.forward > 0.5, "歩き出していない");
  h.signs()[0].fire("click");
  assertEquals(
    h.log.inputs.at(-1),
    { forward: 0, strafe: 0, turn: 0 },
    "確認を出したのに歩き続けている",
  );
});

// ── 指で歩く ──────────────────────────────────────────

Deno.test("corridor.js: スティックを倒すと前後・左右の連続入力になり、離すと止まる", async () => {
  const h = await load();
  const stick = h.$("stick");

  // 真上へいっぱいに倒す（中心 66,66 / 半径 66）
  stick.fire("pointerdown", { pointerId: 1, clientX: 66, clientY: 66 - 50 });
  h.tick(30);
  let input = h.log.inputs.at(-1)!;
  assert(input.forward > 0.5, `前進していない: ${JSON.stringify(input)}`);
  assert(Math.abs(input.strafe) < 0.01, "倒していない向きへ動いている");

  // 真横へ倒す＝平行移動（旋回ではない）
  stick.fire("pointermove", { pointerId: 1, clientX: 66 + 50, clientY: 66 });
  h.tick(30);
  input = h.log.inputs.at(-1)!;
  assert(input.strafe > 0.5, `右へ平行移動していない: ${JSON.stringify(input)}`);

  // 2本目の指はスティックを奪わない（見回しと同時に効かせるため）
  stick.fire("pointerdown", { pointerId: 2, clientX: 0, clientY: 0 });
  h.tick(5);
  assert(h.log.inputs.at(-1)!.strafe > 0.5, "2本目の指がスティックを乗っ取っている");

  stick.fire("pointerup", { pointerId: 1 });
  h.tick(60);
  assertEquals(h.log.inputs.at(-1), { forward: 0, strafe: 0, turn: 0 }, "指を離しても止まらない");
});

Deno.test("corridor.js: 遊びの中では歩き出さない", async () => {
  const h = await load();
  // 中心から 8px（半径 66 の 0.12 ＜ 遊び 0.16）
  h.$("stick").fire("pointerdown", { pointerId: 1, clientX: 66 + 8, clientY: 66 });
  h.tick(10);
  assertEquals(h.log.inputs.at(-1), { forward: 0, strafe: 0, turn: 0 });
});

Deno.test("corridor.js: 揺れを嫌う設定では加速の慣らしを切り、最高速を落とす", async () => {
  const h = await load({ reducedMotion: true });
  h.$("stick").fire("pointerdown", { pointerId: 1, clientX: 66, clientY: 0 });
  h.tick();
  // 慣らしが入っていれば1フレームでは 0.1 程度にしかならない
  assertEquals(h.log.inputs.at(-1), { forward: 0.75, strafe: 0, turn: 0 });
  h.$("stick").fire("pointerup", { pointerId: 1 });
  h.tick();
  assertEquals(
    h.log.inputs.at(-1),
    { forward: 0, strafe: 0, turn: 0 },
    "離した瞬間に止まっていない",
  );
});

Deno.test("corridor.js: PC のボタン操作は1回ぶんの step / turn のまま残る", async () => {
  const h = await load();
  h.$("fwd").fire("click");
  h.$("back").fire("click");
  h.$("left").fire("click");
  h.$("right").fire("click");
  assertEquals(h.log.steps, [1, -1]);
  assertEquals(h.log.turns, [1, -1]);
});

// ── 描画を止める ──────────────────────────────────────

Deno.test("corridor.js: 画面が隠れたら pause()、戻ったら resume() を呼ぶ", async () => {
  const h = await load();
  assertFalse(h.log.paused);
  h.doc.hidden = true;
  h.fireDocument("visibilitychange");
  assert(h.log.paused, "隠れても描き続けている");
  h.doc.hidden = false;
  h.fireDocument("visibilitychange");
  assertFalse(h.log.paused, "戻っても再開していない");
});

Deno.test("corridor.js: VC に入ると描画を止め、抜けると再開する", async () => {
  const h = await load();
  h.log.doors = doorFixture();
  h.tick();
  assert(h.signs().length > 0);

  h.$("vc-join").fire("click");
  assert(h.log.paused, "VC 中も描き続けている");
  assert(h.$("vc-join").disabled && !h.$("vc-leave").disabled, "ボタンの状態が入れ替わらない");
  assertStringIncludes(h.$("signs-note").textContent, "VC中");
  assertEquals(h.signs().length, 0, "止めたのに札が残っている");

  const before = h.log.inputs.length;
  h.tick(3);
  assertEquals(h.log.inputs.length, before, "止めたのに毎フレームの処理が回っている");

  h.$("vc-leave").fire("click");
  assertFalse(h.log.paused, "VC を抜けても再開していない");
  h.tick();
  assert(h.signs().length > 0, "再開しても札が戻らない");
});

// ── CorridorView 側がまだ揃っていない場合 ──────────────

Deno.test("corridor.js: 未実装の API があっても動き、どれが無いかを名指しで出す", async () => {
  const h = await load({
    provide: { pause: false, resume: false, visibleDoors: false, setInput: false },
  });
  assertStringIncludes(h.$("error").textContent, "visibleDoors");
  assertStringIncludes(h.$("error").textContent, "setInput");
  assertEquals(h.$("rooms-list").children.length, 7, "一覧まで道連れになっている");

  // setInput / visibleDoors が無くても落ちない（札もスティックも黙って何もしない）
  h.$("stick").fire("pointerdown", { pointerId: 1, clientX: 66, clientY: 66 - 50 });
  h.tick(30);
  assertEquals(h.signs().length, 0);
  assertEquals(h.log.inputs.length, 0);
});

// ── 症状の再現（同じ位置に張り付く） ──────────────────

Deno.test("corridor.js: 札は扉の画面座標にそのまま追従する（縁で張り付かない）", async () => {
  // 幅 390px のスマホ。札の幅の半分ぶん内側へ押し戻していると、
  // 画面の端にある扉の札が同じ x に固まって動かなくなる
  const h = await load({ stageWidth: 390, stageHeight: 700 });
  const one = room({ code: "A", roomName: "端の卓" });
  const at = (x: number): Door[] => [
    { code: "A", room: one, x, y: 350, distance: 3, bearing: 0, onScreen: true, behind: false },
  ];

  const seen: number[] = [];
  for (const x of [200, 140, 100, 60, 20]) {
    h.log.doors = at(x);
    h.tick();
    const m = h.signs()[0].style.transform.match(/translate3d\((-?[\d.]+)px/);
    assert(m !== null);
    seen.push(Number(m[1]));
  }
  assertEquals(seen, [200, 140, 100, 60, 20], `札が扉から離れた位置に留まっている: ${seen}`);
});

Deno.test("corridor.js: 視界から消えた扉の札は次のフレームで片付く", async () => {
  const h = await load();
  h.log.doors = doorFixture();
  h.tick();
  assert(h.signs().length > 0, "そもそも札が出ていない");
  assert(h.edges().length > 0, "そもそも矢印が出ていない");

  h.log.doors = [];
  h.tick();
  assertEquals(h.signs().length, 0, "消えた扉の札が残っている");
  assertEquals(h.edges().length, 0, "消えた扉の矢印が残っている");
  assertEquals(h.$("signs-note").textContent, "", "注記が残っている");
});

// ── 同じ扉を同じ扉として扱う（id） ────────────────────

/**
 * 同じ卓を受け持つ扉が2枚あり、視点を振ると遠近が入れ替わる場面。
 *
 * 実機で「4/6 などの表示が、視点を横に振ると分裂して増える」と言われた症状。
 * 扉を「卓コード ＋ 近い順」で覚えていると、順位が入れ替わった拍子に
 * 札と矢印の区分ごと入れ替わり、画面外に居るはずの扉まで札として残ってしまう。
 */
function twinDoors(nearDist: number, farDist: number): Door[] {
  const shared = room({ code: "R", roomName: "同じ卓", playerCount: 4 });
  const doors: Door[] = [
    // 画面のまん中に居る扉
    {
      id: "3,0,1",
      code: "R",
      room: shared,
      x: 400,
      y: 300,
      distance: nearDist,
      bearing: 0,
      onScreen: true,
      behind: false,
    },
    // 画面のすぐ外に居る扉（ヒステリシスの余裕 40px の内側）
    {
      id: "5,2,3",
      code: "R",
      room: shared,
      x: 830,
      y: 300,
      distance: farDist,
      bearing: -0.5,
      onScreen: false,
      behind: false,
    },
  ];
  return doors.sort((a, b) => a.distance - b.distance);
}

Deno.test("corridor.js: 距離の順が入れ替わっても、同じ扉が札として分裂しない", async () => {
  const h = await load();

  h.log.doors = twinDoors(3, 5);
  h.tick();
  assertEquals([h.signs().length, h.edges().length], [1, 1], "はじめの区分がおかしい");

  // 視点を振って、同じ卓を受け持つ2枚の扉の遠近が入れ替わる
  h.log.doors = twinDoors(3, 2);
  h.tick();
  assertEquals(
    [h.signs().length, h.edges().length],
    [1, 1],
    "画面の外に居るはずの扉まで札になっている（同じ卓の 4/6 が二重に出る）",
  );
  assertEquals(h.signNames(), ["同じ卓"]);
});

Deno.test("corridor.js: id が無いビューでも落ちない（実装前の繋ぎ）", async () => {
  const h = await load();
  const noId = twinDoors(3, 5).map((d) => {
    const copy = { ...d };
    delete copy.id;
    return copy;
  });
  h.log.doors = noId;
  h.tick();
  assertEquals([h.signs().length, h.edges().length], [1, 1]);
  assertEquals(h.signNames(), ["同じ卓"]);
});

// ── 使い終わった枠が画面に残らない ────────────────────

Deno.test("corridor.js: 表示・非表示を hidden 属性ではなく DOM の繋がりで表す", async () => {
  const h = await load();
  h.log.doors = doorFixture();
  h.tick();
  const signCount = h.$("signs").children.length;
  const edgeCount = h.$("edges").children.length;
  assert(signCount > 0 && edgeCount > 0, "そもそも何も出ていない");
  const firstSign = h.$("signs").children[0];

  // 扉が視界から消えたら、DOM からも消える（スタイルで隠すだけにしない）
  h.log.doors = [];
  h.tick();
  assertEquals(h.$("signs").children.length, 0, "使い終わった札の枠が DOM に残っている");
  assertEquals(h.$("edges").children.length, 0, "使い終わった矢印の枠が DOM に残っている");

  // 再び扉が現れたら、作り直さず使い回す
  h.log.doors = doorFixture();
  h.tick();
  assertEquals(h.$("signs").children.length, signCount);
  assertEquals(h.$("edges").children.length, edgeCount);
  assert(h.$("signs").children[0] === firstSign, "枠を使い回さず作り直している");
});

Deno.test("corridor.js: 札の出し入れに hidden 属性を使っていない", () => {
  // hidden 属性が効くのは UA スタイルの [hidden] { display: none } によってだけで、
  // 作者スタイルの display（.corridor-sign の flex）はそれより強い。
  // 偽 DOM ではカスケードを再現できないため、hidden に頼ると検証できない穴が残る。
  assertFalse(
    /\.hidden\s*=\s*(true|false)/.test(uiSource),
    "hidden 属性で枠を隠している箇所がある（DOM から外すこと）",
  );
});

Deno.test("en.css: hidden 属性を使ってしまったときの保険がアプリ全体に効いている", () => {
  assert(
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(cssSource),
    "[hidden] { display: none !important } の打ち消しが無い",
  );
  // ページ側に置き去りにしない（corridor.html だけ守られている状態を作らない）
  assertFalse(
    /\[hidden\]\s*\{/.test(htmlSource),
    "corridor.html に [hidden] の規則が残っている（en.css へ昇格させること）",
  );
});

Deno.test("[hidden] を足しても、従来の表示切り替えが壊れていない", () => {
  // app.js は .hidden（クラス）で出し分ける。!important のまま残っていること
  assert(
    /\.hidden\s*\{[^}]*display:\s*none\s*!important/.test(cssSource),
    ".hidden の !important が外れている（ID セレクタに負ける）",
  );
  assertStringIncludes(appSource, `classList.toggle("hidden"`);
  // vc.js は video.hidden（属性）で出し分ける。index.html の打ち消しも残っていること
  assertStringIncludes(vcSource, "video.hidden");
  assertStringIncludes(indexSource, ".vc-video[hidden] {");
  // 属性とクラス、どちらも display: none なので競合しない
  const hiddenRule = /\[hidden\]\s*\{([^}]*)}/.exec(cssSource);
  assert(hiddenRule !== null, "[hidden] の規則が見つからない");
  assertEquals(
    [...hiddenRule[1].matchAll(/display:\s*([a-z-]+)/g)].map((m) => m[1]),
    ["none"],
    "[hidden] に none 以外の display を書いている",
  );
});

// ── 数百フレーム歩き回す ──────────────────────────────

/**
 * 廊下を歩いて見回す様子を、visibleDoors() の返り値として作り出す簡易カメラ。
 * corridor-view.js と同じ約束に合わせてある
 * （yaw=0 で -Z を向く／bearing は正面が 0 で左が +／後方では投影の符号が反転する）。
 */
function makeWorld() {
  const rooms = [
    room({ code: "A", roomName: "茜屋の奥座敷" }),
    room({ code: "B", roomName: "蛍", playerCount: 6, capacity: 6 }),
    room({ code: "C", roomName: "鈴の間", playerCount: 0, playing: false, gameTitle: undefined }),
  ];
  // 通路の両側に扉を並べる。同じ卓を複数の扉が受け持つ状況もそのまま入る
  const doors = Array.from({ length: 18 }, (_, i) => ({
    id: `${i % 2 === 0 ? -1 : 1},${-i},${i % 4}`,
    wx: i % 2 === 0 ? -1 : 1,
    wz: -i * 1.6,
    room: rooms[i % rooms.length],
  }));
  const tanHalf = Math.tan((58 * Math.PI) / 180 / 2);

  return function look(cx: number, cz: number, yaw: number, w: number, h: number): Door[] {
    const aspect = w / h;
    const out: Door[] = [];
    for (const d of doors) {
      const rx = d.wx - cx;
      const rz = d.wz - cz;
      const fz = rx * -Math.sin(yaw) + rz * -Math.cos(yaw); // 前方成分
      const fx = rx * Math.cos(yaw) + rz * -Math.sin(yaw); // 右成分
      const denom = Math.abs(fz) < 1e-4 ? (fz < 0 ? -1e-4 : 1e-4) : fz;
      const x = ((fx / denom / (aspect * tanHalf)) * 0.5 + 0.5) * w;
      const y = (-(0.25 / denom / tanHalf) * 0.5 + 0.5) * h;
      out.push({
        id: d.id,
        code: d.room.code,
        room: d.room,
        x,
        y,
        distance: Math.hypot(fx, fz),
        bearing: Math.atan2(-fx, fz),
        onScreen: fz > 0.05 && x >= 0 && x <= w && y >= 0 && y <= h,
        behind: fz <= 0,
      });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  };
}

Deno.test("corridor.js: 数百フレーム歩き回しても、出ている DOM が実際の扉とずれない", async () => {
  const W = 390;
  const H = 560;
  const h = await load({ stageWidth: W, stageHeight: H });
  const look = makeWorld();
  const at = (e: FakeEl) => {
    const m = e.style.transform.match(/translate3d\((-?[\d.]+)px, (-?[\d.]+)px/);
    assert(m !== null, "位置が入っていない");
    return { x: Number(m[1]), y: Number(m[2]) };
  };

  for (let f = 0; f < 400; f++) {
    // 歩きながら首を振る。扉が視界に入り、段が変わり、画面外へ抜けていく
    const cz = -(f / 400) * 26;
    const cx = Math.sin(f * 0.05) * 0.6;
    const yaw = Math.sin(f * 0.09) * 1.6;
    const doors = look(cx, cz, yaw, W, H);
    h.log.doors = doors;
    h.tick();

    const signs = h.signs();
    const edges = h.edges();
    const inRange = doors.filter((d) => d.distance <= 9);

    assert(signs.length <= 6, `frame ${f}: 札が ${signs.length} 枚`);
    assert(edges.length <= 3, `frame ${f}: 矢印が ${edges.length} 件`);
    assert(
      signs.length + edges.length <= inRange.length,
      `frame ${f}: 9m 以内の扉 ${inRange.length} 枚に対し、札${signs.length}＋矢印${edges.length} が出ている`,
    );

    // 出ている札は、すべて「このフレームの扉の位置」に居る＝古い枠が残っていない
    for (const sign of signs) {
      const p = at(sign);
      assert(
        doors.some((d) => Math.abs(d.x - p.x) < 0.6 && Math.abs(d.y - p.y) < 0.6),
        `frame ${f}: いまの扉に対応しない札が (${p.x}, ${p.y}) に残っている`,
      );
    }

    // 同じ位置に2枚出ていない＝同じ扉を二重に描いていない
    const spots = new Set(signs.map((sign) => `${at(sign).x},${at(sign).y}`));
    assertEquals(spots.size, signs.length, `frame ${f}: 同じ位置に札が重なっている`);
  }
});

// ── 切り分け用の表示（?debug=1） ──────────────────────

Deno.test("corridor.js: ?debug=1 で DOM の枚数・扉の数・段の内訳を出す", async () => {
  const h = await load({ debug: true });
  h.log.doors = doorFixture();
  h.tick();
  const note = h.$("signs-note").textContent;
  // 「DOM 札」が「札 N枚」より多ければ、使い終わった枠が画面に残っている
  assertStringIncludes(note, `DOM 札${h.signs().length}/矢${h.edges().length}`);
  assertStringIncludes(note, `扉${h.log.doors.length}`);
  assertStringIncludes(note, "詳");
  assert(h.$("signs-note").classList.contains("is-debug"), "注記を debug 用の位置に逃がしていない");
});

Deno.test("corridor.js: debug でなければ DOM の枚数は出さない", async () => {
  const h = await load();
  h.log.doors = doorFixture();
  h.tick();
  assertFalse(h.$("signs-note").textContent.includes("DOM"));
  assertFalse(h.$("signs-note").classList.contains("is-debug"));
});

// ── ホーム（index.html）への統合 ───────────────────────
/*
 * ここから下は、廊下ビューを本番のホームに載せたときの振る舞い。
 * rooms.js も同じ偽ブラウザの上で動かしているので、
 * 「一覧を取る → 廊下へ配る → 入店する」までが通しで見られる。
 */

/** 部分木からクラス名で1つ拾う */
function findByClass(root: FakeEl, cls: string): FakeEl {
  const found = [...root.walk()].find((n) => n.className.split(" ").includes(cls));
  if (found === undefined) throw new Error(`${cls} が見つかりません`);
  return found;
}

/** #join が押されたときの卓コードを控える */
function watchJoin(h: { $: (id: string) => FakeEl }): string[] {
  const pressed: string[] = [];
  h.$("join").addEventListener("click", () => pressed.push(h.$("code").value));
  return pressed;
}

Deno.test("ホーム: 既定は一覧。3D は「店内を歩く」を選ばれるまで読み込まない", async () => {
  const h = await loadHome();
  assertFalse(h.created, "一覧を見ているだけなのに 3D を読み込んでいる");
  assert(h.$("corridor-stage").classList.contains("hidden"), "廊下の場が出たままになっている");
  assertEquals(h.$("corridor-mode-list").getAttribute("aria-pressed"), "true");
  assertEquals(h.$("corridor-mode-3d").getAttribute("aria-pressed"), "false");
  assert(h.$("corridor-walk").classList.contains("hidden"), "歩くボタンが出たままになっている");
  assertFalse(h.$("corridor-list").classList.contains("hidden"), "一覧が畳まれている");

  h.$("corridor-mode-3d").fire("click");
  await settle();
  assert(h.created, "店内を選んでも 3D を読み込んでいない");
  assertFalse(h.$("corridor-stage").classList.contains("hidden"));
  assert(h.$("corridor-list").classList.contains("hidden"), "店内なのに一覧が残っている");
});

Deno.test("ホーム: 選んだ表示を憶えて、次に開いたときもその側で出す", async () => {
  const h = await loadHome();
  assertEquals(h.store.get("en.corridor.mode"), "list");
  h.$("corridor-mode-3d").fire("click");
  await settle();
  assertEquals(h.store.get("en.corridor.mode"), "3d", "選んだ側を憶えていない");

  // 次に開いたとき（憶えた値が「店内」）
  const again = await loadHome({ stored: "3d" });
  assert(again.created, "憶えた側で開いていない");
  assertFalse(again.$("corridor-stage").classList.contains("hidden"));
});

Deno.test("ホーム: 憶えた側が店内でも、WebGL が無ければ一覧に落ちる", async () => {
  const h = await loadHome({ stored: "3d", webgl: false });
  assertFalse(h.created, "WebGL が無いのに 3D を作りにいっている");
  assert(h.$("corridor-stage").classList.contains("hidden"), "廊下の場が残っている");
  assertEquals(h.$("corridor-mode-list").getAttribute("aria-pressed"), "true");
  assert(h.$("corridor-mode-3d").disabled, "選べない側を塞いでいない");
  assertFalse(h.$("corridor-mode-list").disabled, "一覧側まで塞いではいけない");
  assertStringIncludes(h.$("corridor-error").textContent, "3D 表示を使えません");
  assertStringIncludes(h.$("corridor-error").textContent, "一覧に切り替えました");
  // 落ちた先を憶えてしまうと、次に別の端末で開いても一覧のままになる
  assertEquals(h.store.get("en.corridor.mode"), "3d");
});

Deno.test("ホーム: 店内を選んだあとに 3D が動かないと分かったら、理由を出して一覧へ戻す", async () => {
  const h = await loadHome({ webgl: false });
  assertFalse(h.$("corridor-mode-3d").disabled, "まだ選べる状態のはず");

  h.$("corridor-mode-3d").fire("click");
  await settle();
  assert(h.$("corridor-mode-3d").disabled, "描けない側を塞いでいない");
  assert(h.$("corridor-stage").classList.contains("hidden"));
  assertStringIncludes(h.$("corridor-error").textContent, "一覧に切り替えました");
  assertFalse(h.$("corridor-list").classList.contains("hidden"), "一覧が戻っていない");
});

Deno.test("ホーム: 廊下の読み込み自体に失敗しても一覧へ落ちる", async () => {
  const h = await loadHome({ stored: "3d", failImport: "読み込めませんでした" });
  assertFalse(h.created);
  assertStringIncludes(h.$("corridor-error").textContent, "廊下を読み込めませんでした");
  assert(h.$("corridor-mode-3d").disabled);
});

Deno.test("ホーム: /api/rooms を二重に取りに行かない", async () => {
  const h = await loadHome({ stored: "3d" });
  assert(h.created, "3D が立ち上がっていない（この確認の前提が崩れている）");
  const rooms = h.fetched.filter((u) => u.includes("/api/rooms"));
  const tags = h.fetched.filter((u) => u.includes("/api/room-tags"));
  assertEquals(rooms.length, 1, `/api/rooms を ${rooms.length} 回取りに行っている`);
  assertEquals(tags.length, 1, `/api/room-tags を ${tags.length} 回取りに行っている`);
});

Deno.test("ホーム: 一覧の取得結果とタグの表示名が、そのまま廊下へ渡る", async () => {
  const h = await loadHome({ stored: "3d", rooms: [room({ code: "123456" })] });
  assertEquals(h.log.rooms.map((r) => r.code), ["123456"]);
  assertEquals(h.log.labels?.get("board"), "ボードゲーム");
});

Deno.test("ホーム: 一覧のカードは rooms.js が描く（廊下ビューが二重に描かない）", async () => {
  const h = await loadHome({ rooms: [room({ code: "123456" })] });
  assertEquals(h.$("rooms-list").children.length, 1, "同じ卓のカードが二重に並んでいる");
});

Deno.test("ホーム: 一覧のカードから入店すると #code に入って #join が押される", async () => {
  const h = await loadHome({ rooms: [room({ code: "123456" })] });
  const pressed = watchJoin(h);

  const card = h.$("rooms-list").children[0];
  findByClass(card, "btn").fire("click");
  assertEquals(pressed, ["123456"], "一覧から入店の道を通っていない");
});

Deno.test("ホーム: 廊下の札から入店しても、一覧と同じ道（enterRoom）を通る", async () => {
  const only = room({ code: "123456", roomName: "茜屋の奥座敷" });
  const h = await loadHome({ stored: "3d", rooms: [only] });
  const pressed = watchJoin(h);

  h.log.doors = [
    {
      code: "123456",
      room: only,
      x: 400,
      y: 300,
      distance: 3,
      bearing: 0,
      onScreen: true,
      behind: false,
    },
  ];
  h.tick();
  assertEquals(h.signs().length, 1, "札が出ていない");

  // 押し間違い防止の確認をはさむ。確認して初めて入店する
  h.signs()[0].fire("click");
  assertEquals(pressed, [], "確認する前に入店している");
  assert(h.$("corridor-confirm").open, "確認が出ていない");
  assertStringIncludes(h.$("corridor-confirm-name").textContent, "茜屋の奥座敷");

  h.$("corridor-confirm-ok").fire("click");
  assertEquals(pressed, ["123456"], "廊下から入店の道を通っていない");
});

Deno.test("ホーム: 3D 側の扉（canvas のタップ）からも同じ道を通る", async () => {
  const only = room({ code: "123456" });
  const h = await loadHome({ stored: "3d", rooms: [only] });
  const pressed = watchJoin(h);

  // corridor-view.js が扉のタップと Enter キーで呼ぶ経路
  assert(h.log.onEnter !== null, "onEnter を渡していない");
  h.log.onEnter?.("123456");
  assert(h.$("corridor-confirm").open, "確認が出ていない");
  h.$("corridor-confirm-ok").fire("click");
  assertEquals(pressed, ["123456"], "3D 側のタップが入店の道を通っていない");
});

Deno.test("ホーム: 卓に着いたら描画を止め、戻ったら再開する", async () => {
  const h = await loadHome({ stored: "3d" });
  assertFalse(h.log.paused, "はじめから止まっている");

  // app.js の renderAll が #entry に hidden を付けるのと同じこと
  h.setInRoom(true);
  assert(h.log.paused, "卓に着いても描き続けている（通話中ずっと GPU を食う）");
  assertStringIncludes(h.$("corridor-note").textContent, "卓に着いている");

  const before = h.log.inputs.length;
  h.tick(3);
  assertEquals(h.log.inputs.length, before, "止めたのに毎フレームの処理が回っている");

  h.setInRoom(false);
  assertFalse(h.log.paused, "退室しても再開していない");
});

Deno.test("ホーム: 卓に着いているあいだはタブに戻っても再開しない", async () => {
  const h = await loadHome({ stored: "3d" });
  h.setInRoom(true);
  h.doc.hidden = true;
  h.fireDocument("visibilitychange");
  h.doc.hidden = false;
  h.fireDocument("visibilitychange");
  assert(h.log.paused, "卓に着いているのにタブが戻っただけで再開している");
});

Deno.test("ホーム: 一覧に切り替えているあいだは描画を止める", async () => {
  const h = await loadHome({ stored: "3d" });
  assertFalse(h.log.paused);
  h.$("corridor-mode-list").fire("click");
  assert(h.log.paused, "一覧を見ているあいだも描き続けている");
  h.$("corridor-mode-3d").fire("click");
  await settle();
  assertFalse(h.log.paused, "店内へ戻しても再開していない");
});

Deno.test("ホーム: 卓名は文字のまま入る（innerHTML の経路を持たない）", async () => {
  const nasty = room({ code: "123456", roomName: '<img src=x onerror="alert(1)">' });
  const h = await loadHome({ stored: "3d", rooms: [nasty] });
  h.log.doors = [
    {
      code: "123456",
      room: nasty,
      x: 400,
      y: 300,
      distance: 3,
      bearing: 0,
      onScreen: true,
      behind: false,
    },
  ];
  h.tick();
  assertEquals(
    findByClass(h.signs()[0], "corridor-sign-name").textContent,
    '<img src=x onerror="alert(1)">',
  );
});

// ── 送信の経路は1本 ───────────────────────────────────

Deno.test("廊下ビューは自前の WebSocket 送信を持たない（入店は rooms.js の道だけ）", () => {
  for (const [name, src] of [["corridor-ui.js", uiSource], ["corridor.js", entrySource]]) {
    assertFalse(src.includes("WebSocket"), `${name} が WebSocket を触っている`);
    assertFalse(src.includes("wss://"), `${name} が WS の URL を持っている`);
    assertFalse(/"t":\s*"join"/.test(src), `${name} が join メッセージを組み立てている`);
    assertFalse(/{\s*t:\s*"/.test(src), `${name} が WS メッセージを組み立てている`);
  }
  // 入店は rooms.js の enterRoom に集約されている
  assertStringIncludes(uiSource, "globalThis.Rooms?.enterRoom?.(code)");
  assertStringIncludes(roomsSource, "els.join.click();");
  assertStringIncludes(
    roomsSource,
    "global.Rooms = { init, refresh, stop, subscribe, enterRoom };",
  );
});

Deno.test("rooms.js: 購読の口は、まだ取れていないうちは呼ばない", async () => {
  const win = makeWindow(HOME_IDS);
  const seen: Array<{ n: number }> = [];
  let resolveFetch = () => {};
  const gate = new Promise<void>((r) => {
    resolveFetch = r;
  });
  const fetchStub = (url: string) => {
    const body = String(url).includes("room-tags") ? TAGS : { rooms: [room()] };
    return gate.then(() => ({ ok: true, json: () => Promise.resolve(body) }));
  };

  new Function(
    "window",
    "document",
    "fetch",
    "setInterval",
    "clearInterval",
    "MutationObserver",
    "console",
    roomsSource,
  )(win.fakeGlobal, win.doc, fetchStub, () => 0, () => {}, win.FakeMutationObserver, console);

  // deno-lint-ignore no-explicit-any
  const Rooms = (win.fakeGlobal as any).Rooms;
  Rooms.subscribe((list: Room[]) => seen.push({ n: list.length }));
  assertEquals(seen, [], "まだ何も取れていないのに通知している");

  resolveFetch();
  await settle();
  assertEquals(seen, [{ n: 1 }], "取れた時点で購読者に渡っていない");
});
