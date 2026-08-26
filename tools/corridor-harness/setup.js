/**
 * ブラウザにしか無いものを、検証に要る分だけ用意する。
 *
 * requestAnimationFrame は自動では回さない。flushFrames() で1フレームずつ進めることで、
 * 「pause() で rAF の予約そのものが消えるか」まで確かめられる（フラグで描画を
 * 飛ばすだけの実装だと予約が残るので、そこで落ちる）。
 */
let seq = 0;
const pending = new Map();

globalThis.requestAnimationFrame = (fn) => {
  pending.set(++seq, fn);
  return seq;
};
globalThis.cancelAnimationFrame = (id) => {
  pending.delete(id);
};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

/** 予約されている rAF を n 回ぶん実行する */
export function flushFrames(n = 1) {
  for (let i = 0; i < n; i++) {
    const fns = [...pending.values()];
    pending.clear();
    for (const fn of fns) fn();
  }
}

/** いま予約されている rAF の数 */
export function pendingFrames() {
  return pending.size;
}

/** 描画先の箱の代わり */
export function makeContainer() {
  return {
    clientWidth: 800,
    clientHeight: 600,
    children: [],
    appendChild(c) {
      this.children.push(c);
    },
  };
}

/**
 * 本物の public/assets/3d/corridor-view.js を読み込む。
 *
 * あちらの import はブラウザ向けの絶対パス（/vendor/three/...）なので Deno では
 * 解決できない。そこで**その2行だけ**書き換えて data URL として読む。
 * ファイルをコピーしないので、検証台と本体がずれることが原理的に起きない。
 */
export async function loadCorridorView() {
  const base = new URL("./", import.meta.url);
  const src = await Deno.readTextFile(new URL("../../public/assets/3d/corridor-view.js", base));
  const patched = src
    .replace('"/vendor/three/three.module.min.js"', JSON.stringify(new URL("./three-shim.js", base).href))
    .replace(
      '"/vendor/three/GLTFLoader.js"',
      JSON.stringify(new URL("../../public/vendor/three/GLTFLoader.js", base).href),
    );
  if (patched === src) {
    throw new Error("corridor-view.js の import を書き換えられませんでした（読み込み先が変わった？）");
  }
  return await import(`data:text/javascript,${encodeURIComponent(patched)}`);
}

/** 部品モデルの場所 */
export function kitUrl() {
  return new URL("../../public/assets/3d/izakaya_corridor_kit.glb", import.meta.url).href;
}
