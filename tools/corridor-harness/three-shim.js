/**
 * 検証台むけの three.js。**本物をそのまま読み**、WebGLRenderer だけ差し替える。
 *
 * three.js の数学まわり（Matrix4 / Vector3 / PerspectiveCamera / InstancedMesh）は
 * DOM を要らないので Deno でそのまま動く。画面を持たないのは WebGLRenderer だけなので、
 * そこだけ偽物にすれば、corridor-view.js を**書き換えずに**動かして測れる。
 *
 * `export *` は明示した名前を上書きしないので、WebGLRenderer だけこちらが勝つ。
 */
export * from "../../public/vendor/three/three.module.min.js";

/** 実際に描かれる物を数える偽レンダラ。数えた値は globalThis に置いて検証台から読む */
export class WebGLRenderer {
  constructor() {
    this.toneMapping = 0;
    this.toneMappingExposure = 1;
    this.renderCount = 0;
    this.lastDrawCalls = 0;
    this.domElement = makeFakeCanvas();
    this.capabilities = { getMaxAnisotropy: () => 1 };
  }
  setPixelRatio() {}
  setSize() {}
  dispose() {}
  render(scene, camera) {
    this.renderCount++;
    // InstancedMesh は中身が何個でも1回で描かれる。ここがドローコールの見積り。
    let n = 0;
    scene.traverse((o) => {
      if (o.visible !== true) return;
      if (o.isInstancedMesh === true) {
        if (o.count > 0) n++;
        return;
      }
      if (o.isMesh === true) n++;
    });
    this.lastDrawCalls = n;
    globalThis.__drawCalls = n;
    globalThis.__scene = scene;
    void camera;
  }
}

/** canvas の代わり。イベントは fire() で流し込めるようにしてある */
function makeFakeCanvas() {
  const listeners = new Map();
  return {
    style: {},
    tabIndex: 0,
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 600 };
    },
    remove() {},
    fire(type, ev) {
      listeners.get(type)?.(ev);
    },
    listeners,
  };
}
