/**
 * ブラウザにしか無いものを、検証に要る分だけ用意する。
 *
 * 時計は自前で持つ。`performance.now()` も requestAnimationFrame に渡る時刻も
 * この時計を返すので、**演出の時間軸を 1/60 秒ずつ手で進められる**。実時間で
 * 待たないから 2.6 秒の演出が一瞬で終わり、しかも毎回まったく同じ結果になる。
 */

let clock = 0;
let seq = 0;
const pending = new Map();

globalThis.requestAnimationFrame = (fn) => {
  pending.set(++seq, fn);
  return seq;
};
globalThis.cancelAnimationFrame = (id) => {
  pending.delete(id);
};

// noren-scene.js は開始時刻を performance.now() で取り、経過を rAF の引数から
// 出す。両方を同じ時計に載せないと経過がでたらめになる
Object.defineProperty(performance, "now", {
  value: () => clock,
  configurable: true,
  writable: true,
});

/** いまの時刻（ミリ秒） */
export function now() {
  return clock;
}

/** 時計を進めて、予約されている rAF を1回ぶん実行する */
export function advance(ms) {
  clock += ms;
  const fns = [...pending.values()];
  pending.clear();
  for (const fn of fns) fn(clock);
}

/** いま予約されている rAF の数。0 なら次のコマは来ない */
export function pendingFrames() {
  return pending.size;
}

/** 積まれている Promise とタイマを流す。演出側の await を進めるために挟む */
export function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── DOM のふり ──────────────────────────────────────────

/** 2D の描画命令は全部受け流す。中身の絵は測らない（測れない）ので要らない */
function make2dContext() {
  const gradient = { addColorStop() {} };
  return {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    fillRect() {},
    beginPath() {},
    arc() {},
    stroke() {},
    fill() {},
    fillText() {},
    measureText: () => ({ width: 0 }),
  };
}

function makeCanvas() {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext(kind) {
      // "webgl2" は supportsWebGL() が有無だけを見る。真な値なら何でもよい
      return kind === "2d" ? make2dContext() : {};
    },
  };
}

globalThis.WebGLRenderingContext = class {};
globalThis.devicePixelRatio = 1;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
/**
 * 画像の代わり。three の TextureLoader は <img> を建てて src を入れ、
 * load / error を待つ。ここでは何も届かないので、テクスチャは空のまま。
 * 演出は絵を待たずに始まる作りなので、それで通る（本物も同じ経路）。
 */
function makeImage() {
  return {
    style: {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
  };
}

globalThis.document = {
  documentElement: {},
  createElement(tag) {
    if (tag === "canvas") return makeCanvas();
    if (tag === "img") return makeImage();
    return { style: {} };
  },
  // three は img を createElementNS（XHTML 名前空間）で建てる
  createElementNS(_ns, tag) {
    return this.createElement(tag);
  },
};
// 布のテクスチャが en.css の --serif を読みに来る。Deno には CSS が無いので
// 空を返す（noren-scene.js 側は "serif" に倒す）
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });

/** #noren-stage の代わり。付いた class と、入れ替えられた子を覚えておく */
export function makeStage() {
  const classes = new Set();
  return {
    children: [],
    /** replaceChildren() を引数無しで呼ばれた回数＝片付けが走った回数 */
    clears: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    replaceChildren(...nodes) {
      if (nodes.length === 0) this.clears++;
      this.children = nodes;
    },
  };
}

// ── 本体を読む ──────────────────────────────────────────

export function modelPath() {
  return new URL("../../public/assets/noren.glb", import.meta.url);
}

/**
 * 本物の public/noren-scene.js を読み込む。
 *
 * あちらのパスはブラウザ向けの絶対パス（/vendor/... と /assets/...）なので
 * Deno では解決できない。そこで**その3行だけ**書き換えて data URL として読む。
 * ファイルをコピーしないので、検証台と本体がずれることが原理的に起きない。
 */
export async function loadNorenScene() {
  const base = new URL("./", import.meta.url);
  const src = await Deno.readTextFile(new URL("../../public/noren-scene.js", base));

  const swaps = [
    ['"/vendor/three/three.module.min.js"', new URL("./three-shim.js", base).href],
    [
      '"/vendor/three/GLTFLoader.js"',
      new URL("../../public/vendor/three/GLTFLoader.js", base).href,
    ],
    ['"/assets/noren.glb"', modelPath().href],
  ];

  let patched = src;
  for (const [from, to] of swaps) {
    if (!patched.includes(from)) {
      throw new Error(`noren-scene.js の ${from} が見つかりません（読み込み先が変わった？）`);
    }
    patched = patched.replace(from, JSON.stringify(to));
  }
  return await import(`data:text/javascript,${encodeURIComponent(patched)}`);
}
