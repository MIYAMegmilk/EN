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

// ---------------------------------------------------------------------------
// 10. 狭い器で「主役」が真っ先に潰れないこと（CSS の指定の番人）
//
// 縦の flex では、min-height が auto のままの文字の兄弟は縮まないのに、
// min-height: 0 の canvas だけがいくらでも縮む。器に高さが通ると不足分が
// ほぼ全部 canvas に割り当たり、実ブラウザで 2px まで潰れて操作不能になった。
// 偽 DOM には実測レイアウトが無いので、ここでは **CSS の指定そのもの** を見る。
// ---------------------------------------------------------------------------

/**
 * 「潰れきらない」と言える下限（CSS px）。
 * これ未満だと絵も盤面も読めないので、指定として意味を成さない。
 *
 * 64px は論理 480 の 1/7.5 にあたり、太い線（論理 18px）が 2.4 CSS px、
 * もぐらたたきなら 3×3 の的が 1マス 21px 相当。小さいが「絵」「盤面」として形が分かる。
 * かつては 100px にしていたが、下限は **道具箱やお題を画面外へ押し出さない** 大きさで
 * なければならず（§11 参照）、上限側の制約のほうがきつい。下げてある
 */
const MIN_MEANINGFUL_PX = 64;

/** style.flex の指定から flex-grow / flex-shrink を読む。未指定は既定の 0 1 auto 相当 */
function parseFlex(value: unknown): { grow: number; shrink: number } {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "none") return { grow: 0, shrink: 0 };
  const parts = text.split(/\s+/);
  const grow = Number(parts[0]);
  const shrink = parts.length > 1 ? Number(parts[1]) : 1;
  return {
    grow: Number.isFinite(grow) ? grow : 0,
    shrink: Number.isFinite(shrink) ? shrink : 1,
  };
}

/** "120px" のような指定を数値で読む。px 以外・未指定は 0（下限なし） */
function pxOf(value: unknown): number {
  const matched = /^(\d+(?:\.\d+)?)px$/.exec(typeof value === "string" ? value.trim() : "");
  return matched === null ? 0 : Number(matched[1]);
}

Deno.test("draw: canvas は残りの高さを受け取る側で、下限まで潰れきらない", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("draw");
    const container = new FakeElement("div");
    const handle = module.mount(container, makeApi([]));
    const canvas = container.findAll("canvas")[0];
    assert(canvas !== undefined, "canvas が無い");

    const flex = parseFlex(canvas.style.flex);
    assert(
      flex.grow > 0,
      `canvas が余った高さを受け取らない（flex: ${canvas.style.flex}）`,
    );
    assert(
      pxOf(canvas.style.minHeight) >= MIN_MEANINGFUL_PX,
      `canvas に実用的な下限が無い（min-height: ${canvas.style.minHeight}）`,
    );

    handle.unmount();
  } finally {
    dom.restore();
  }
});

Deno.test("draw: 道具箱は潰れない（0px になると描く操作そのものが死ぬ）", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("draw");
    const container = new FakeElement("div");
    const handle = module.mount(container, makeApi([]));
    const root = container.children[0];
    assert(root !== undefined, "root が無い");
    // 道具箱は「ボタンを抱えた div」。色・太さ・ひとつ戻す・全部消すが入っている
    const tools = root.children.find(
      (child) => child.tagName === "div" && child.findAll("button").length > 0,
    );
    assert(tools !== undefined, "道具箱が見つからない");
    assertEquals(
      parseFlex(tools.style.flex).shrink,
      0,
      `道具箱が縮む指定になっている（flex: ${tools.style.flex}）`,
    );

    handle.unmount();
  } finally {
    dom.restore();
  }
});

Deno.test("_client.js: 遊ぶ面と canvas が残りの高さを受け取る側で、下限まで潰れきらない", async () => {
  const dom = installDom(2);
  try {
    const helpers = await loadGame("_client");

    // createShell の body（もぐらたたき・絵合わせ・反射神経が遊ぶところ）
    const container = new FakeElement("div");
    const shell = helpers.createShell(container, "テスト");
    assert(
      parseFlex(shell.body.style.flex).grow > 0,
      `遊ぶ面が余った高さを受け取らない（flex: ${shell.body.style.flex}）`,
    );
    assert(
      pxOf(shell.body.style.minHeight) >= MIN_MEANINGFUL_PX,
      `遊ぶ面に実用的な下限が無い（min-height: ${shell.body.style.minHeight}）`,
    );

    // createCanvas の canvas（もぐらたたきの盤面）
    const made = helpers.createCanvas(MOGURA_W, MOGURA_H);
    assert(
      parseFlex(made.canvas.style.flex).grow > 0,
      `canvas が余った高さを受け取らない（flex: ${made.canvas.style.flex}）`,
    );
    assert(
      pxOf(made.canvas.style.minHeight) >= MIN_MEANINGFUL_PX,
      `canvas に実用的な下限が無い（min-height: ${made.canvas.style.minHeight}）`,
    );
    // 遊ぶ面の下限が canvas の下限より低いと、canvas が遊ぶ面からはみ出す
    assert(
      pxOf(shell.body.style.minHeight) >= pxOf(made.canvas.style.minHeight),
      "遊ぶ面の下限が canvas の下限より低い（canvas がはみ出して下の文字に重なる）",
    );
  } finally {
    dom.restore();
  }
});

Deno.test("mogura: 盤面が残りの高さを受け取る側になっている（_client.js 経由）", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("mogura");
    const container = new FakeElement("div");
    const handle = module.mount(container, makeApi([]));
    handle.update(clientView(), null);
    const canvas = container.findAll("canvas")[0];
    assert(canvas !== undefined, "canvas が無い");

    assert(
      parseFlex(canvas.style.flex).grow > 0,
      `canvas が余った高さを受け取らない（flex: ${canvas.style.flex}）`,
    );
    assert(
      pxOf(canvas.style.minHeight) >= MIN_MEANINGFUL_PX,
      `canvas に実用的な下限が無い（min-height: ${canvas.style.minHeight}）`,
    );
    // canvas を抱えている遊ぶ面（createShell の body）も、縮みきらないこと
    const root = container.children[0];
    const body = root.children.find(
      (child) => child.tagName === "div" && child.contains(canvas),
    );
    assert(body !== undefined, "遊ぶ面が見つからない");
    assert(
      pxOf(body.style.minHeight) >= pxOf(canvas.style.minHeight),
      `遊ぶ面が canvas より先に潰れる（min-height: ${body.style.minHeight}）`,
    );

    handle.unmount();
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// 11. 主役表示で「まず絵に高さを配る」こと（CSS の指定の番人）
//
// 10 の下限（潰れない最低線）を満たしていても、文字の兄弟が縮まない設定で
// 高さを先に取ってしまうと、canvas は下限へ張り付いたままになる。
// 実ブラウザ（Chrome・窓の高さ 698px・卓に3人・お絵かき当てを主役・出題者の画面）で
// canvas が 120×120px、左右 558px が空白という状態が実測された。
//
// そこで配り方そのものを検査する。
//   - 副次的な文字（答え合わせ・正解した人・得点表）＝ **真っ先に** 畳まれる
//   - 遊ぶのに要る1行情報（ターン・残り秒・お題・道具箱・残量）＝ 縮まない
//   - 遊ぶ面＝ 余りを受け取り、縮むのは最後。下限は「潰れ防止」だけの最低線
//   - 道具箱とお題は canvas より前に並ぶ（あふれても押し出されない）
// 偽 DOM には実測レイアウトが無いので、ここでも **CSS の指定そのもの** を見る。
// ---------------------------------------------------------------------------

/**
 * 下限（min-height）として置いてよい上限（CSS px）。
 *
 * 下限は「潰れ防止の最低線」であって、遊びやすい大きさの目標ではない。
 * 実ブラウザ（Chrome・窓の高さ 698px・卓に3人・お絵かき当てを主役・出題者の画面）で
 * 主役表示の器（#phase-body）は 241px しかなく、縮まない兄弟
 * （見出し 28 + お題 36 + 道具箱 42 + 隙間 24 ＝ 130px）を引いた残りは 111px。
 * 下限をこれより高く置くと、下限を満たすために器からあふれ、あふれたぶんが
 * **道具箱を外側スクロールの向こうへ押し出す**（実測: 道具箱 563〜604px に対し
 * 表示領域の下端は 494px）。絵を描くゲームで道具箱に届かないのは、
 * 絵が少し小さいことより悪い。
 *
 * かつてここは「遊べる大きさ」として 240px 以上を要求していたが、それがまさに
 * 上の押し出しを起こしていた。240px は **器に余裕があるときの目標** に格下げし、
 * 下限としては 111px を超えないこと——余裕をみて 120px を上限——を要求する
 */
const MAX_FLOOR_PX = 120;

/** min-height が「0」と言えるか（"0" でも "0px" でも可） */
function isZeroMinHeight(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "0" || text === "0px";
}

/** 「縮められて・自前でスクロールする」指定になっているか調べる */
function assertShrinkableScroller(box: FakeElement, label: string): void {
  assert(
    box.style.overflowY === "auto",
    `${label}: 自前でスクロールしない（overflow-y: ${box.style.overflowY}）`,
  );
  assert(
    isZeroMinHeight(box.style.minHeight),
    `${label}: min-height が 0 でない（${box.style.minHeight}）。` +
      "flex 既定の min-height: auto のままだと中身の高さぶんを先に確保してしまう",
  );
  const flex = parseFlex(box.style.flex);
  assert(flex.shrink > 0, `${label}: 縮まない指定になっている（flex: ${box.style.flex}）`);
  assertEquals(
    flex.grow,
    0,
    `${label}: 余った高さを受け取る側になっている（主役から高さを奪う）`,
  );
}

Deno.test("draw: 副次的な文字は縮んで自前でスクロールする（絵の取り分を奪わない）", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("draw");
    const container = new FakeElement("div");
    const handle = module.mount(container, makeApi([]));
    handle.update(drawView(1), T0 + 30_000);
    const root = container.children[0];
    assert(root !== undefined, "root が無い");

    // 「正解した人」「答え合わせ」「得点」は1つのスクロール領域にまとまっていること。
    // root 直下で h4（正解した人 / 得点）を抱えている div がそれ
    const side = root.children.find(
      (child) => child.tagName === "div" && child.findAll("h4").length >= 2,
    );
    assert(
      side !== undefined,
      "副次的な文字がひとまとめになっていない（別々に並んでいると隙間もその数だけ要る）",
    );
    assertShrinkableScroller(side, "副次的な文字の領域");

    // canvas はその領域の中に入っていないこと（入れると一緒にスクロールしてしまう）
    const canvas = container.findAll("canvas")[0];
    assert(!side.contains(canvas), "canvas が副次的な文字の領域に入っている");

    handle.unmount();
  } finally {
    dom.restore();
  }
});

Deno.test("draw: 遊ぶのに要る1行情報は縮まない（canvas と副次領域だけが縮む）", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("draw");
    const container = new FakeElement("div");
    const handle = module.mount(container, makeApi([]));
    handle.update(drawView(1), T0 + 30_000);
    const root = container.children[0];
    const canvas = container.findAll("canvas")[0];
    const side = root.children.find(
      (child) => child.tagName === "div" && child.findAll("h4").length >= 2,
    );
    assert(side !== undefined, "副次的な文字の領域が無い");

    // 題名・ターン・残り秒は1行に畳んであること（縦に積むと行の数だけ隙間も要る）
    const headRow = root.children.find(
      (child) => child.tagName === "div" && child.findAll("h3").length === 1,
    );
    assert(headRow !== undefined, "見出し行（題名＋ターン＋残り秒）がまとまっていない");
    assert(
      headRow.findAll("p").length >= 2,
      "ターン表示と残り秒が見出し行に入っていない",
    );

    for (const child of root.children) {
      if (child === canvas || child === side) continue;
      assertEquals(
        parseFlex(child.style.flex).shrink,
        0,
        `遊ぶのに要る情報が縮む指定になっている（${child.tagName}: flex ${child.style.flex}）`,
      );
    }

    handle.unmount();
  } finally {
    dom.restore();
  }
});

Deno.test("draw: canvas の下限は潰れ防止の最低線で、道具箱を追い出す高さではない", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("draw");
    const container = new FakeElement("div");
    const handle = module.mount(container, makeApi([]));
    const canvas = container.findAll("canvas")[0];
    const floor = pxOf(canvas.style.minHeight);
    assert(
      floor >= MIN_MEANINGFUL_PX,
      `絵を描ける面の下限が低すぎる（min-height: ${canvas.style.minHeight}）。` +
        "数 px まで潰れると絵ではなく帯になる",
    );
    assert(
      floor <= MAX_FLOOR_PX,
      `絵を描ける面の下限が ${MAX_FLOOR_PX}px を超えている（min-height: ${canvas.style.minHeight}）。` +
        "241px の器では下限を満たすために器からあふれ、道具箱が表示領域の外へ押し出される",
    );
    handle.unmount();
  } finally {
    dom.restore();
  }
});

Deno.test("draw: 道具箱とお題は canvas より前に並ぶ（あふれても押し出されない）", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("draw");
    const container = new FakeElement("div");
    const handle = module.mount(container, makeApi([]));
    handle.update(drawView(1), T0 + 30_000);
    const root = container.children[0];
    const kids = root.children;
    const canvasIndex = kids.findIndex((child: FakeElement) => child.tagName === "canvas");
    assert(canvasIndex >= 0, "canvas が root 直下に無い");

    // 道具箱（ボタンを抱えた div）
    const toolsIndex = kids.findIndex(
      (child: FakeElement) => child.tagName === "div" && child.findAll("button").length > 0,
    );
    assert(toolsIndex >= 0, "道具箱が見つからない");
    assert(
      toolsIndex < canvasIndex,
      "道具箱が canvas より後ろに並んでいる。" +
        "器からあふれると、あふれたぶんが道具箱を表示領域の外へ押し流す",
    );

    // お題（背景色の付いた案内の段落）
    const roleIndex = kids.findIndex(
      (child: FakeElement) =>
        child.tagName === "p" && child.style.background !== undefined &&
        String(child.style.background).length > 0,
    );
    assert(roleIndex >= 0, "お題の案内が見つからない");
    assert(roleIndex < canvasIndex, "お題が canvas より後ろに並んでいる");

    // 残量表示は道具箱の中（別行にすると 1行ぶん＋隙間で canvas の取り分を削る）
    const tools = kids[toolsIndex];
    assert(
      tools.findAll("p").length > 0,
      "描ける残量が道具箱の中に入っていない",
    );

    handle.unmount();
  } finally {
    dom.restore();
  }
});

Deno.test("draw: 副次領域は canvas より先に縮む（縮み係数が桁違いに大きい）", async () => {
  const dom = installDom(2);
  try {
    const module = await loadGame("draw");
    const container = new FakeElement("div");
    const handle = module.mount(container, makeApi([]));
    const root = container.children[0];
    const canvas = container.findAll("canvas")[0];
    const side = root.children.find(
      (child: FakeElement) => child.tagName === "div" && child.findAll("h4").length >= 2,
    );
    assert(side !== undefined, "副次的な文字の領域が無い");

    const canvasShrink = parseFlex(canvas.style.flex).shrink;
    const sideShrink = parseFlex(side.style.flex).shrink;
    assert(canvasShrink > 0, "canvas が縮まない指定になっている（器からあふれる）");
    assert(
      sideShrink >= canvasShrink * 100,
      `副次領域の縮み係数が canvas と同程度（side: ${side.style.flex} / canvas: ${canvas.style.flex}）。` +
        "同じ係数だと両方がいっしょに縮み、canvas が下限へ張り付いて器を広げても育たない",
    );

    handle.unmount();
  } finally {
    dom.restore();
  }
});

Deno.test("_client.js: 盤面の下限は潰れ防止の最低線で、side が真っ先に縮む", async () => {
  const dom = installDom(2);
  try {
    const helpers = await loadGame("_client");
    const container = new FakeElement("div");
    const shell = helpers.createShell(container, "テスト");

    // 盤面の下限は「潰れ防止」の範囲に収まっていること
    const bodyFloor = pxOf(shell.body.style.minHeight);
    assert(
      bodyFloor >= MIN_MEANINGFUL_PX && bodyFloor <= MAX_FLOOR_PX,
      `遊ぶ面の下限が潰れ防止の範囲（${MIN_MEANINGFUL_PX}〜${MAX_FLOOR_PX}px）の外` +
        `（min-height: ${shell.body.style.minHeight}）`,
    );
    const made = helpers.createCanvas(MOGURA_W, MOGURA_H);
    const canvasFloor = pxOf(made.canvas.style.minHeight);
    assert(
      canvasFloor >= MIN_MEANINGFUL_PX && canvasFloor <= MAX_FLOOR_PX,
      `盤面 canvas の下限が潰れ防止の範囲の外（min-height: ${made.canvas.style.minHeight}）`,
    );

    // side は盤面より桁違いに縮みやすいこと（真っ先に畳まれる側）
    const bodyShrink = parseFlex(shell.body.style.flex).shrink;
    const sideShrink = parseFlex(shell.side.style.flex).shrink;
    assert(bodyShrink > 0, "遊ぶ面が縮まない指定になっている（器からあふれる）");
    assert(
      sideShrink >= bodyShrink * 100,
      `side の縮み係数が盤面と同程度（side: ${shell.side.style.flex} / body: ${shell.body.style.flex}）`,
    );

    // 副次的な文字を入れる場所があり、縮んで自前でスクロールすること
    assert(shell.side !== undefined, "createShell が副次的な文字の置き場（side）を返さない");
    assertShrinkableScroller(shell.side, "createShell の side");

    // 見出しと断り書きは1行に畳んであり、縮まないこと
    const headRow = shell.root.children.find(
      (child: FakeElement) => child.tagName === "div" && child.findAll("h3").length === 1,
    );
    assert(headRow !== undefined, "見出し行がまとまっていない");
    assertEquals(parseFlex(headRow.style.flex).shrink, 0, "見出し行が縮む指定になっている");
    assertEquals(parseFlex(shell.status.style.flex).shrink, 0, "状態行が縮む指定になっている");
  } finally {
    dom.restore();
  }
});

Deno.test("もぐらたたき・絵合わせ・反射神経: 副次的な文字を side に入れている", async () => {
  for (const id of ["mogura", "emoawase", "reflex"]) {
    const dom = installDom(2);
    try {
      const module = await loadGame(id);
      const container = new FakeElement("div");
      const handle = module.mount(container, makeApi([]));
      handle.update(clientView(), null);
      const root = container.children[0];
      // createShell の並びは [見出し行, 遊ぶ面, 状態行, side]
      const side = root.children[root.children.length - 1];
      assertShrinkableScroller(side, `${id}: side`);
      assert(
        side.children.length > 0,
        `${id}: 得点・順位の一覧が side に入っていない（root 直下だと盤面の高さを奪う）`,
      );
      // 一覧（ul / ol）が root 直下に residual していないこと
      const strayList = root.children.some(
        (child: FakeElement) => child.tagName === "ul" || child.tagName === "ol",
      );
      assert(!strayList, `${id}: 一覧が root 直下に残っている`);
      handle.unmount();
    } finally {
      dom.restore();
    }
  }
});
