/**
 * 検証台むけの three.js。**本物をそのまま読み**、画面が要る 2 つだけ差し替える。
 *
 * three.js の数学まわり（Vector3 / PlaneGeometry / computeVertexNormals /
 * PerspectiveCamera）は DOM を要らないので Deno でそのまま動く。GPU が要るのは
 * WebGLRenderer と、それを使って環境マップを焼く PMREMGenerator だけなので、
 * そこだけ偽物にすれば noren-scene.js を**書き換えずに**動かして測れる。
 *
 * `export *` は明示した名前を上書きしないので、この 2 つだけこちらが勝つ。
 * corridor-harness/three-shim.js と同じ手口。
 */
import { Texture } from "../../public/vendor/three/three.module.min.js";

export * from "../../public/vendor/three/three.module.min.js";

/**
 * 描かない偽レンダラ。
 *
 * render() のたびに `globalThis.__onRender` へシーンとカメラを渡す。検証台は
 * そこで「実際に描かれた 1 コマ」を写し取る。つまり測っているのは理屈ではなく、
 * コードが本当に画面へ出した値。
 */
export class WebGLRenderer {
  constructor() {
    this.outputColorSpace = "";
    this.toneMapping = 0;
    this.toneMappingExposure = 1;
    this.shadowMap = { enabled: false, type: 0 };
    this.capabilities = { getMaxAnisotropy: () => 1 };
    this.domElement = { style: {}, remove() {} };
    this.renderCount = 0;
    this.disposeCount = 0;
    this.contextLossCount = 0;
    // 検証台から後片付けの回数を見るために、最後に作った物を置いておく
    globalThis.__renderer = this;
  }
  setPixelRatio() {}
  setSize() {}
  render(scene, camera) {
    this.renderCount++;
    globalThis.__onRender?.(scene, camera);
  }
  dispose() {
    this.disposeCount++;
  }
  forceContextLoss() {
    this.contextLossCount++;
  }
}

/** 環境マップを焼く代わりに、空のテクスチャを1枚返すだけ */
export class PMREMGenerator {
  constructor(renderer) {
    this.renderer = renderer;
  }
  fromEquirectangular() {
    const texture = new Texture();
    return { texture, dispose() {} };
  }
  dispose() {}
}
