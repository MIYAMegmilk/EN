/**
 * ビューモジュール（public/room/games/*.js）が**表示領域の大小に耐える**ことのテスト。
 *
 * ゲームは「通話タイルの下の小さい枠」にも「通話の枠内の主役表示」にも置かれる。
 * 器の大きさが変わっても、canvas の内部解像度が追従し、絵が消えず、座標がずれないこと。
 *
 * 偽 DOM はこのファイルに閉じてある（server/tests/fake_dom.ts は canvas も
 * ResizeObserver も持たないため）。作りは client_view_smoke_test.ts の偽 DOM に、
 * corridor_client_test.ts の FakeResizeObserver を足したもの。
 * ここでは寸法と変換行列を見たいので、2D コンテキストは受け流しではなく記録する。
 */

import { assert, assertEquals } from "@std/assert";

// ---------------------------------------------------------------------------
// 偽 2D コンテキスト（変換行列と塗りを記録する）
// ---------------------------------------------------------------------------

/** 記録した描画命令 */
interface DrawOp {
  op: string;
  args: number[];
}

/** 変換行列。回転・傾きはどのゲームも使わないので、拡大と平行移動だけ持つ */
interface Transform {
  a: number;
  d: number;
  e: number;
  f: number;
}

function createFakeCtx(canvas: unknown): {
  ctx: unknown;
  transform: Transform;
  ops: DrawOp[];
} {
  const transform: Transform = { a: 1, d: 1, e: 0, f: 0 };
  const ops: DrawOp[] = [];
  const methods: Record<string, (...args: number[]) => void> = {
    setTransform: (a, _b, _c, d, e, f) => {
      transform.a = a;
      transform.d = d;
      transform.e = e;
      transform.f = f;
    },
    scale: (x, y) => {
      transform.a *= x;
      transform.d *= y;
    },
    translate: (x, y) => {
      transform.e += transform.a * x;
      transform.f += transform.d * y;
    },
    clearRect: (...args) => ops.push({ op: "clearRect", args }),
    fillRect: (...args) => ops.push({ op: "fillRect", args }),
    stroke: () => ops.push({ op: "stroke", args: [] }),
    fill: () => ops.push({ op: "fill", args: [] }),
  };
  const noop = () => {};
  const ctx = new Proxy({ canvas } as Record<string | symbol, unknown>, {
    get: (target, key) => {
      if (Object.hasOwn(methods, key)) return methods[key as string];
      if (key in target) return target[key];
      return noop;
    },
    set: () => true,
  });
  return { ctx, transform, ops };
}

// ---------------------------------------------------------------------------
// 偽 DOM
// ---------------------------------------------------------------------------

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent = "";
  className = "";
  type = "";
  alt = "";
  src = "";
  width = 0;
  height = 0;
  disabled = false;
  draggable = false;
  decoding = "";
  /** getBoundingClientRect が返す寸法。テストから setRect で差し替える */
  rect = { left: 0, top: 0, width: 0, height: 0 };
  // deno-lint-ignore no-explicit-any
  readonly style: Record<string, any> = { setProperty: () => {} };
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly handlers = new Map<string, ((event: unknown) => void)[]>();
  /** getContext が返したもの（テストから中身を覗く） */
  ctx: unknown = null;
  ctxTransform: Transform | null = null;
  ctxOps: DrawOp[] = [];

  constructor(readonly tagName: string) {}

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement): void {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parent = null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    const bucket = this.handlers.get(type) ?? [];
    bucket.push(handler);
    this.handlers.set(type, bucket);
  }
  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const bucket = this.handlers.get(type);
    if (bucket === undefined) return;
    const at = bucket.indexOf(handler);
    if (at >= 0) bucket.splice(at, 1);
  }
  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) {
      handler({ target: this, preventDefault: () => {}, ...event });
    }
  }
  closest(selector: string): FakeElement | null {
    if (this.tagName === selector) return this;
    return this.parent === null ? null : this.parent.closest(selector);
  }
  contains(other: FakeElement | null): boolean {
    let node = other;
    while (node !== null) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }
  /** 表示されている大きさを差し替える（器が伸び縮みしたときの再現） */
  setRect(width: number, height: number, left = 0, top = 0): void {
    this.rect = { left, top, width, height };
  }
  getBoundingClientRect() {
    return this.rect;
  }
  getContext(): unknown {
    if (this.ctx === null) {
      const made = createFakeCtx(this);
      this.ctx = made.ctx;
      this.ctxTransform = made.transform;
      this.ctxOps = made.ops;
    }
    return this.ctx;
  }
  handlerCount(): number {
    let total = 0;
    for (const bucket of this.handlers.values()) total += bucket.length;
    for (const child of this.children) total += child.handlerCount();
    return total;
  }
  findAll(tagName: string, out: FakeElement[] = []): FakeElement[] {
    for (const child of this.children) {
      if (child.tagName === tagName) out.push(child);
      child.findAll(tagName, out);
    }
    return out;
  }
}

class FakeImage extends FakeElement {
  constructor() {
    super("img");
  }
}

/** ResizeObserver 1件ぶんの控え（発火と解除漏れを見るのに使う） */
interface ObserverRec {
  target: FakeElement | null;
  cb: () => void;
  disconnected: boolean;
}

/** ビューモジュールを動かすのに要る globalThis を差し込む。戻り値で元に戻す */
function installDom(dpr = 2): {
  restore: () => void;
  frames: (() => void)[];
  observers: ObserverRec[];
  fireResize: (target: FakeElement) => void;
} {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  const frames: (() => void)[] = [];
  const observers: ObserverRec[] = [];
  const set = (key: string, value: unknown) => {
    saved[key] = g[key];
    g[key] = value;
  };

  class FakeResizeObserver {
    private readonly rec: ObserverRec;
    constructor(cb: () => void) {
      this.rec = { target: null, cb, disconnected: false };
      observers.push(this.rec);
    }
    observe(target: FakeElement): void {
      this.rec.target = target;
    }
    disconnect(): void {
      this.rec.disconnected = true;
    }
  }

  set("document", {
    createElement: (tag: string) => tag === "img" ? new FakeImage() : new FakeElement(tag),
  });
  set("Image", FakeImage);
  set("HTMLImageElement", FakeImage);
  set("Element", FakeElement);
  set("devicePixelRatio", dpr);
  set("ResizeObserver", FakeResizeObserver);
  set("requestAnimationFrame", (fn: (t: number) => void) => {
    frames.push(() => fn(performance.now()));
    return frames.length;
  });
  set("cancelAnimationFrame", () => {});

  return {
    frames,
    observers,
    fireResize: (target: FakeElement) => {
      for (const rec of [...observers]) {
        if (!rec.disconnected && rec.target === target) rec.cb();
      }
    },
    restore: () => {
      for (const [key, value] of Object.entries(saved)) g[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const YOU = "you-1";
const OTHER = "other-1";
/** draw.js の CANVAS_SIZE（サーバーの DRAW_COORD_MAX + 1）と同じ */
const DRAW_SIZE = 480;
/** mogura の論理サイズ（_client.js の createCanvas に渡す値） */
const MOGURA_W = 420;
const MOGURA_H = 300;
/** _client.js / draw.js の MAX_CANVAS_PIXELS と同じ */
const MAX_CANVAS_PIXELS = 2048 * 2048;

// deno-lint-ignore no-explicit-any
async function loadGame(id: string): Promise<any> {
  return await import(`../../../public/room/games/${id}.js`);
}

function makeApi(sent: unknown[], now = { value: T0 }) {
  return {
    send: (payload: unknown) => sent.push(payload),
    youId: YOU,
    isHost: true,
    serverNow: () => now.value,
  };
}

/** クライアント専用ゲーム（mogura）に配られる view */
function clientView() {
  return {
    seed: 20260827,
    startedAt: T0,
    players: [
      { id: YOU, name: "じぶん", connected: true },
      { id: OTHER, name: "あいて", connected: true },
    ],
    events: [],
    ended: false,
  };
}

/** draw（サーバー側モジュール型）の view。自分が出題者で、まだ描ける状態 */
function drawView(rev: number, strokes: unknown[] = []) {
  return {
    kind: "draw",
    phase: "draw",
    turn: 1,
    totalTurns: 2,
    drawerId: YOU,
    drawerName: "じぶん",
    youAreDrawer: true,
    topic: "ねこ",
    topicLength: 2,
    strokes,
    rev,
    pointCount: 0,
    pointMax: 5000,
    correct: [],
    guesserCount: 1,
    myCorrectOrder: null,
    myTurnPoints: 0,
    players: [{ playerId: YOU, nickname: "じぶん", connected: true, correct: false, drawer: true }],
    standings: [{ playerId: YOU, nickname: "じぶん", score: 0, rank: 1 }],
  };
}

/** 直近の「全面塗り」を探す。redraw が走ったかの目印 */
function countFullFills(ops: DrawOp[], w: number, h: number): number {
  return ops.filter((o) =>
    o.op === "fillRect" && o.args[0] === 0 && o.args[1] === 0 && o.args[2] === w &&
    o.args[3] === h
  ).length;
}

/** 溜まった rAF を1周ぶん流す */
function runFrames(frames: (() => void)[]): void {
  for (const frame of frames.splice(0)) frame();
}

// ---------------------------------------------------------------------------
// 1. 表示サイズを変えたら内部解像度が追従する（正常系）
// ---------------------------------------------------------------------------

Deno.test("draw: 表示サイズを変えると canvas の内部解像度が追従する", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("draw");
    const container = new FakeElement("div");
    const canvasProbe = { el: null as FakeElement | null };
    // mount 中に canvas が作られるので、器の寸法は document.createElement 直後には決められない。
    // 先に器の寸法を持たせるため、mount 後に rect を入れて通知する
    const handle = module.mount(container, makeApi([]));
    canvasProbe.el = container.findAll("canvas")[0] ?? null;
    const canvas = canvasProbe.el;
    assert(canvas !== null, "canvas が無い");
    assert(dom.observers.length > 0, "表示サイズの見張りが登録されていない");

    canvas.setRect(240, 240);
    dom.fireResize(canvas);
    // 240 CSS px × dpr 2 = 480
    assertEquals(canvas.width, 480, "縮めたときの内部解像度");
    assertEquals(canvas.height, 480);

    canvas.setRect(600, 600);
    dom.fireResize(canvas);
    // 600 CSS px × dpr 2 = 1200。従来の 480px 上限を超えて大きくなる
    assertEquals(canvas.width, 1200, "広げたときの内部解像度");
    assertEquals(canvas.height, 1200);

    handle.unmount();
  } finally {
    dom.restore();
  }
});

Deno.test("mogura: 表示サイズを変えると canvas の内部解像度が追従する", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("mogura");
    const container = new FakeElement("div");
    const handle = module.mount(container, makeApi([]));
    handle.update(clientView(), null);
    const canvas = container.findAll("canvas")[0];
    assert(canvas !== undefined, "canvas が無い");
    assert(dom.observers.length > 0, "表示サイズの見張りが登録されていない");

    canvas.setRect(MOGURA_W * 2, MOGURA_H * 2);
    dom.fireResize(canvas);
    // 論理 420×300 の2倍表示 × dpr 2
    assertEquals(canvas.width, MOGURA_W * 4, "広げたときの内部解像度（幅）");
    assertEquals(canvas.height, MOGURA_H * 4, "広げたときの内部解像度（高さ）");

    handle.unmount();
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. リサイズ後も絵が消えない（canvas.width への代入はビットマップを消す）
// ---------------------------------------------------------------------------

Deno.test("draw: リサイズ直後に描き直される（白紙のまま取り残されない）", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("draw");
    const container = new FakeElement("div");
    const handle = module.mount(container, makeApi([]));
    const canvas = container.findAll("canvas")[0];
    assert(canvas !== undefined, "canvas が無い");
    canvas.setRect(480, 480);

    // 線が1本ある状態にする（rev が変わったので update が描く）
    handle.update(drawView(1, [{ id: 0, color: 0, width: 1, points: [10, 10, 100, 100] }]), null);
    const before = countFullFills(canvas.ctxOps, DRAW_SIZE, DRAW_SIZE);
    assert(before > 0, "update で一度も描かれていない");

    // 大きさが変わる → ビットマップは作り直され、中身は消える
    canvas.setRect(960, 960);
    dom.fireResize(canvas);
    const after = countFullFills(canvas.ctxOps, DRAW_SIZE, DRAW_SIZE);
    assert(after > before, "リサイズ後に描き直していない（次の点まで白紙のまま）");
    // 引かれた線も描き直されている
    assert(
      canvas.ctxOps.some((o) => o.op === "stroke"),
      "履歴のストロークが描き直されていない",
    );

    // さらに、次に同じ rev の view が来ても描き直しは済んでいる（絵は残る）
    handle.update(drawView(1, [{ id: 0, color: 0, width: 1, points: [10, 10, 100, 100] }]), null);
    handle.unmount();
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. リサイズ後も変換行列が保たれる（canvas.width への代入は行列も消す）
// ---------------------------------------------------------------------------

Deno.test("mogura: リサイズ後も塗りが canvas 全面に及ぶ（変換行列が掛け直される）", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("mogura");
    const container = new FakeElement("div");
    const handle = module.mount(container, makeApi([]));
    handle.update(clientView(), null);
    const canvas = container.findAll("canvas")[0];
    assert(canvas !== undefined, "canvas が無い");
    assert(dom.observers.length > 0, "表示サイズの見張りが登録されていない");

    const before = canvas.width;
    canvas.setRect(MOGURA_W * 3, MOGURA_H * 3);
    dom.fireResize(canvas);
    runFrames(dom.frames);
    assert(canvas.width !== before, "リサイズでビットマップを作り直していない");

    const transform = canvas.ctxTransform;
    assert(transform !== null, "2D コンテキストを取っていない");
    // 背景の全面塗り fillRect(0, 0, 420, 300) が、実際に canvas 全面を覆うこと
    assert(
      countFullFills(canvas.ctxOps, MOGURA_W, MOGURA_H) > 0,
      "背景の全面塗りが走っていない",
    );
    assertEquals(
      Math.round(transform.a * MOGURA_W),
      canvas.width,
      "横の倍率が合っていない（左上に縮んで描かれる）",
    );
    assertEquals(
      Math.round(transform.d * MOGURA_H),
      canvas.height,
      "縦の倍率が合っていない（左上に縮んで描かれる）",
    );
    assertEquals(transform.e, 0, "原点がずれている");
    assertEquals(transform.f, 0, "原点がずれている");

    handle.unmount();
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. unmount で ResizeObserver が外れる（解除漏れの番人）
// ---------------------------------------------------------------------------

Deno.test("unmount で ResizeObserver が disconnect される（mount を繰り返しても溜まらない）", async () => {
  for (const id of ["draw", "mogura"]) {
    const dom = installDom(2);
    try {
      const module = await loadGame(id);
      const container = new FakeElement("div");
      const handle = module.mount(container, makeApi([]));
      assert(dom.observers.length > 0, `${id}: ResizeObserver を登録していない`);
      assert(
        dom.observers.every((o) => !o.disconnected),
        `${id}: まだ外れていないはず`,
      );
      handle.unmount();
      assert(
        dom.observers.every((o) => o.disconnected),
        `${id}: unmount で disconnect していない（mount のたびに溜まる）`,
      );
      // 外れた後に通知が来ても、もう何もしない
      const canvas = container.findAll("canvas")[0] ?? null;
      if (canvas !== null) {
        canvas.setRect(1000, 1000);
        dom.fireResize(canvas);
      }
    } finally {
      dom.restore();
    }
  }
});

// ---------------------------------------------------------------------------
// 5. 同じ大きさで再通知されても作り直さない（ResizeObserver は続けて発火する）
// ---------------------------------------------------------------------------

Deno.test("draw: 同じ大きさの再通知では作り直さない（描き直しも走らない）", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("draw");
    const container = new FakeElement("div");
    const handle = module.mount(container, makeApi([]));
    const canvas = container.findAll("canvas")[0];
    assert(canvas !== undefined, "canvas が無い");
    assert(dom.observers.length > 0, "表示サイズの見張りが登録されていない");

    const initial = canvas.width;
    canvas.setRect(500, 500);
    dom.fireResize(canvas);
    const width = canvas.width;
    const ops = canvas.ctxOps.length;
    assert(width !== initial, "大きさが変わったのに作り直していない（前提が成り立っていない）");

    // 同じ寸法のまま何度通知されても、ビットマップも描画も増えない
    dom.fireResize(canvas);
    dom.fireResize(canvas);
    dom.fireResize(canvas);
    assertEquals(canvas.width, width, "同じ大きさなのに作り直している");
    assertEquals(canvas.ctxOps.length, ops, "同じ大きさなのに描き直している");

    handle.unmount();
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// 6. 極端に小さい大きさで落ちない（異常系・境界値）
// ---------------------------------------------------------------------------

Deno.test("極端に小さい表示（0px・1px）でも落ちず、内部解像度は 1px 以上を保つ", async () => {
  for (const id of ["draw", "mogura"]) {
    const dom = installDom(3);
    try {
      const module = await loadGame(id);
      const container = new FakeElement("div");
      const handle = module.mount(container, makeApi([]));
      handle.update(id === "draw" ? drawView(1) : clientView(), null);
      const canvas = container.findAll("canvas")[0];
      assert(canvas !== undefined, `${id}: canvas が無い`);
      assert(dom.observers.length > 0, `${id}: 表示サイズの見張りが登録されていない`);

      for (const [w, h] of [[0, 0], [1, 1], [1, 0], [0, 1], [1, 900]]) {
        canvas.setRect(w, h);
        dom.fireResize(canvas);
        runFrames(dom.frames);
        assert(canvas.width >= 1, `${id}: ${w}x${h} で幅が 0 になった`);
        assert(canvas.height >= 1, `${id}: ${w}x${h} で高さが 0 になった`);
        assert(Number.isFinite(canvas.width), `${id}: ${w}x${h} で幅が有限でない`);
        assert(Number.isFinite(canvas.height), `${id}: ${w}x${h} で高さが有限でない`);
      }
      // 小さすぎる箱では座標が取れなくても落ちないこと（0 幅は無効な位置を返す）
      canvas.setRect(0, 0);
      canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 1 });
      canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 1 });

      handle.unmount();
    } finally {
      dom.restore();
    }
  }
});

// ---------------------------------------------------------------------------
// 7. 極端に大きい表示 × 高 dpr でも内部解像度は上限で頭打ち（境界値）
// ---------------------------------------------------------------------------

Deno.test("巨大な表示 × 高 dpr でも内部解像度は上限を超えない", async () => {
  for (const id of ["draw", "mogura"]) {
    const dom = installDom(4); // dpr は 3 で頭打ちになるはず
    try {
      const module = await loadGame(id);
      const container = new FakeElement("div");
      const handle = module.mount(container, makeApi([]));
      handle.update(id === "draw" ? drawView(1) : clientView(), null);
      const canvas = container.findAll("canvas")[0];
      assert(canvas !== undefined, `${id}: canvas が無い`);

      canvas.setRect(8000, 8000);
      dom.fireResize(canvas);
      const pixels = canvas.width * canvas.height;
      // 丸めのぶんだけ超えることはあるので、辺の長さぶんの余裕をみる
      assert(
        pixels <= MAX_CANVAS_PIXELS + canvas.width + canvas.height,
        `${id}: 内部解像度が上限を超えた: ${canvas.width}x${canvas.height}`,
      );
      // 上限が効いてなお、帯のときより十分大きいこと（ただ小さく固定しているのではない）
      assert(canvas.width >= 2000, `${id}: 上限が厳しすぎる: ${canvas.width}`);

      handle.unmount();
    } finally {
      dom.restore();
    }
  }
});

// ---------------------------------------------------------------------------
// 8. 座標変換は拡大・縮小のどちらでも同じ論理座標を返す
// ---------------------------------------------------------------------------

Deno.test("draw: 同じ位置のクリックは、拡大しても縮小しても同じ論理座標になる", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("draw");

    /** 箱の寸法を与えて、箱の (fx, fy) 割の位置を押したときに送られる座標を返す */
    const pressAt = (
      rect: { w: number; h: number; left: number; top: number },
      clientX: number,
      clientY: number,
    ): number[] => {
      const container = new FakeElement("div");
      const sent: unknown[] = [];
      const handle = module.mount(container, makeApi(sent));
      const canvas = container.findAll("canvas")[0];
      canvas.setRect(rect.w, rect.h, rect.left, rect.top);
      handle.update(drawView(1), null);
      canvas.fire("pointerdown", { clientX, clientY, pointerId: 1 });
      canvas.fire("pointerup", { clientX, clientY, pointerId: 1 });
      handle.unmount();
      const chunk = sent.find((p) => (p as { k?: string }).k === "draw") as
        | { p: number[] }
        | undefined;
      assert(chunk !== undefined, "描いた点が送られていない");
      return chunk.p;
    };

    // 480px 表示の真ん中の少し左上 → 拡大（960px）でも縮小（120px）でも同じ論理座標
    const base = pressAt({ w: 480, h: 480, left: 0, top: 0 }, 120, 120);
    assertEquals(base, [120, 120], "等倍のときの論理座標");
    assertEquals(
      pressAt({ w: 960, h: 960, left: 0, top: 0 }, 240, 240),
      base,
      "拡大したときにずれた",
    );
    assertEquals(
      pressAt({ w: 120, h: 120, left: 0, top: 0 }, 30, 30),
      base,
      "縮小したときにずれた",
    );
    // 器がずれた位置にあっても同じ
    assertEquals(
      pressAt({ w: 960, h: 960, left: 100, top: 40 }, 340, 280),
      base,
      "器の位置がずれるとずれる",
    );
    // 箱が正方形でないとき（高さで詰められて左右に余白ができる）も同じ
    // 800×400 の箱に収まる正方形は 400×400 で、左に 200 の余白ができる
    assertEquals(
      pressAt({ w: 800, h: 400, left: 0, top: 0 }, 300, 100),
      base,
      "レターボックスの余白ぶんずれている",
    );
  } finally {
    dom.restore();
  }
});

Deno.test("_client.js pointerPos: 拡大・縮小・レターボックスのどれでも同じ論理座標", async () => {
  const helpers = await loadGame("_client");
  const w = MOGURA_W;
  const h = MOGURA_H;
  const fakeCanvas = (width: number, height: number, left = 0, top = 0) => ({
    getBoundingClientRect: () => ({ left, top, width, height }),
  });
  const round = (p: { x: number; y: number }) => ({
    x: Math.round(p.x * 100) / 100,
    y: Math.round(p.y * 100) / 100,
  });

  // 等倍。真ん中は縮尺を変えてもたまたま一致してしまうので、わざと中心から外す
  const base = round(
    helpers.pointerPos(fakeCanvas(w, h), { clientX: 100, clientY: 150 }, w, h),
  );
  assertEquals(base, { x: 100, y: 150 }, "等倍のときの論理座標");
  // 2倍表示
  assertEquals(
    round(helpers.pointerPos(fakeCanvas(w * 2, h * 2), { clientX: 200, clientY: 300 }, w, h)),
    base,
    "拡大したときにずれた",
  );
  // 半分表示 + 位置ずれ
  assertEquals(
    round(
      helpers.pointerPos(fakeCanvas(w / 2, h / 2, 30, 70), { clientX: 80, clientY: 145 }, w, h),
    ),
    base,
    "縮小・位置ずれでずれた",
  );
  // 箱の縦横比が違うとき（左右に 100 ずつ余白ができ、中央の 420×300 が絵）
  assertEquals(
    round(helpers.pointerPos(fakeCanvas(w + 200, h), { clientX: 200, clientY: 150 }, w, h)),
    base,
    "レターボックスの余白ぶんずれている",
  );
  // 箱が潰れているときは無効な位置（-1, -1）を返して落ちない（異常系）
  assertEquals(helpers.pointerPos(fakeCanvas(0, 0), { clientX: 1, clientY: 1 }, w, h), {
    x: -1,
    y: -1,
  });
});

// ---------------------------------------------------------------------------
// 9. 固定の px 上限・固定高さが残っていないこと（作りの番人）
// ---------------------------------------------------------------------------

Deno.test("ビューモジュールに固定の px 上限が残っていない（器の大きさに追従できる）", async () => {
  const dir = new URL("../../../public/room/games/", import.meta.url);
  for (const name of ["draw.js", "_client.js", "emoawase.js"]) {
    const source = await Deno.readTextFile(new URL(name, dir));
    // maxWidth を px で止めると、器が広くても主役として大きくできない
    assert(
      !/maxWidth\s*=\s*[`"'][^`"']*px/.test(source),
      `${name}: maxWidth が px で止められている`,
    );
  }
});
