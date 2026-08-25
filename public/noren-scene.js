/**
 * ログイン成功演出: Blenderで作成した暖簾+引き戸+店構えのアニメーション(noren.glb)を
 * Three.jsでフルスクリーン再生する。
 *
 * カメラはBlender側でキーフレーム付き(一人称視点で扉に向かって歩いていく動き)のため、
 * glTFに書き出したカメラノードをそのまま使用する(AnimationMixerが同じクリップで
 * カメラの位置/回転も一緒に再生してくれる)。
 *
 * ライトはBlenderのエリアライトがKHR_lights_punctualで書き出せないため、Three.js側に
 * 均一な昼光(アンビエント+柔らかい太陽光ひとつ)だけを用意している。演出的な暖色の
 * スポット/リムライトは、木の色が白飛びして見えなくなるため使用しない。
 *
 * WebGL非対応・モデル読み込み失敗時は false を返す。呼び出し側(login.js)は
 * false を受け取ったら既存のCSSフォールバック演出を使うこと。
 */

import * as THREE from "/assets/vendor/three/three.module.js";
import { GLTFLoader } from "/assets/vendor/three/addons/loaders/GLTFLoader.js";

const MODEL_URL = "/assets/noren.glb";
const MIN_PLAY_MS = 1500;

// フォールバック用: もしglTFにカメラが含まれていなかった場合に使う固定カメラ
// (Blenderのカメラ初期位置(0, -5.0, 1.45)をYup(Three.js)座標に変換したもの)
const FALLBACK_CAMERA_POSITION = new THREE.Vector3(0, 1.45, 5.0);
const FALLBACK_CAMERA_TARGET = new THREE.Vector3(0, 1.42, 0);
const FALLBACK_CAMERA_FOV_DEG = 41.1;

let cachedGltfPromise = null;

function loadModel() {
  if (!cachedGltfPromise) {
    cachedGltfPromise = new GLTFLoader().loadAsync(MODEL_URL);
  }
  return cachedGltfPromise;
}

function supportsWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl2") || canvas.getContext("webgl"))
    );
  } catch {
    return false;
  }
}

function findExportedCamera(root) {
  let found = null;
  root.traverse((obj) => {
    if (!found && obj.isCamera) found = obj;
  });
  return found;
}

/**
 * Blenderで作った画角(refFovDeg/refAspect)を「基準の構図」として、実際のブラウザの
 * ウィンドウ比率がそれと違っても背景(店構えの外側の黒)が見えないように調整する。
 * CSSの object-fit: cover と同じ考え方: 基準より横長のウィンドウなら、横幅を基準の
 * 画角に合わせて固定し、代わりに上下が少しトリミングされる形でズームする。
 * 基準より縦長(スマホの縦画面など)なら、逆に縦を基準に合わせて左右をトリミングする。
 */
function applyCoverFov(camera, refFovDeg, refAspect, viewportAspect) {
  const refVFov = THREE.MathUtils.degToRad(refFovDeg);
  let vFov;
  if (viewportAspect >= refAspect) {
    const refHFov = 2 * Math.atan(Math.tan(refVFov / 2) * refAspect);
    vFov = 2 * Math.atan(Math.tan(refHFov / 2) / viewportAspect);
  } else {
    vFov = refVFov;
  }
  camera.fov = THREE.MathUtils.radToDeg(vFov);
  camera.aspect = viewportAspect;
  camera.updateProjectionMatrix();
}

function buildLights(scene) {
  // 参考写真(自然光の下の明るい木造居酒屋の店構え)に合わせて、演出的な暖色スポット/
  // リムライトは廃止。全体を均一に照らす柔らかい昼光だけにして、木の色や引き戸の質感が
  // きちんと見えるようにしている。
  scene.add(new THREE.AmbientLight(0xfff6ea, 1.1));

  const sun = new THREE.DirectionalLight(0xfff2df, 0.55);
  sun.position.set(-1.2, 3.5, 3.0);
  scene.add(sun);
}

/**
 * @param {HTMLElement|null} stageEl 3D描画を差し込むフルスクリーン用のコンテナ要素
 * @returns {Promise<boolean>} 再生できた場合 true、フォールバックすべき場合 false
 */
export async function playNorenIntro(stageEl) {
  if (!stageEl || !supportsWebGL()) return false;

  const gltf = await loadModel();

  const width = window.innerWidth;
  const height = window.innerHeight;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // トーンマッピング無し(既定)だと、ライトの合計値が1.0を超えた箇所が白飛びして
  // 木の色などが完全に消えてしまう。ACESFilmicで滑らかに圧縮する。
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  stageEl.replaceChildren(renderer.domElement);
  stageEl.classList.add("visible");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050302);
  scene.add(gltf.scene);

  let camera = findExportedCamera(gltf.scene);
  let usingFallbackCamera = false;
  let refFovDeg;
  const refAspect = 960 / 720; // Blender側のレンダー解像度(4:3)に合わせた基準アスペクト比
  if (!camera) {
    usingFallbackCamera = true;
    refFovDeg = FALLBACK_CAMERA_FOV_DEG;
    camera = new THREE.PerspectiveCamera(refFovDeg, width / height, 0.1, 50);
    camera.position.copy(FALLBACK_CAMERA_POSITION);
    camera.lookAt(FALLBACK_CAMERA_TARGET);
  } else {
    refFovDeg = camera.fov; // glTFに書き出された時点の垂直画角(基準の構図)を保持しておく
    camera.near = 0.1;
    camera.far = 50;
  }
  applyCoverFov(camera, refFovDeg, refAspect, width / height);

  buildLights(scene);

  const mixer = new THREE.AnimationMixer(gltf.scene);
  let maxDuration = 0;
  for (const clip of gltf.animations) {
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce);
    action.clampWhenFinished = true;
    action.play();
    maxDuration = Math.max(maxDuration, clip.duration);
  }

  const clock = new THREE.Clock();
  let rafId = null;

  function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    applyCoverFov(camera, refFovDeg, refAspect, w / h);
    renderer.setSize(w, h);
  }
  window.addEventListener("resize", onResize);

  function tick() {
    mixer.update(clock.getDelta());
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(tick);
  }
  tick();

  const waitMs = Math.max(MIN_PLAY_MS, maxDuration * 1000);
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  cancelAnimationFrame(rafId);
  window.removeEventListener("resize", onResize);

  void usingFallbackCamera; // デバッグ時に切り分けやすいよう変数として残す

  return true;
}
