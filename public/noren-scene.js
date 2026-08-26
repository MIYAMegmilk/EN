/**
 * ログイン成功演出「暖簾をくぐる」。
 *
 * Blender で作った店構え（noren.glb: 暖簾・引き戸・軒・壁）を three.js で
 * フルスクリーン再生する。
 *
 * ## glb からは「形」だけもらう
 *
 * 以前はカメラも扉も布も、glTF に書き出されたキーフレームを AnimationMixer で
 * そのまま流していた。が、そのベイク済みトラックを実測したら壊れていた。
 *
 *   ・全長 5.667 秒のうち、頭の 2.45 秒はカメラも扉も布も一切動かない静止画
 *   ・布の揺れは面内の横振り（隣と交差する向き）で、しかも最大 26 度どまり
 *   ・カメラが暖簾の面（z=0）を通過するのは t≒4.95 で、そのとき布は静止しきって
 *     いる。つまり「暖簾をくぐる」瞬間そのものが存在しなかった
 *
 * 直すには Blender 側の再エクスポートが要るが、このモデルの .blend は
 * リポジトリに無い。そこで時間軸はこのファイルが持つことにした。以後この
 * 演出の間はコードだけで詰められる。glb 側のトラックとモーフターゲット
 * （全ウェイト 0 のまま 1.4MB を占めていた）は tools/noren-slim.js で落とした。
 *
 * ## 布は作り直して、物理で割る
 *
 * 元の Strip は 4 枚とも幅 0.30m で x=±0.175 / ±0.525 に置かれており、
 * **中央に 5cm の隙間が空いていた**。カメラは x=0 を直進するので、
 * つまり布に一度も触れずにその隙間を素通りしていた。どれだけ揺らしても
 * 「くぐった」ようには見えないわけで、これが安さの根っこだった。
 * 幅を 0.38m に広げて隣と重ね、continuous な一枚の暖簾にしてある。
 *
 * ついでにジオメトリごと作り直している。元の Strip は UV を持っておらず
 * （「宴」の字を貼れない）、シェイプキーのせいで頂点が 189 → 356 に割れて
 * いたため、直すより PlaneGeometry で作るほうが速くて素直だった。
 * ノードの位置と材質は glb のものをそのまま使う（作者の絵づくりは残す）。
 *
 * 動きは「カメラが近いほど強く押し退けられ、通り過ぎたら減衰振動で戻る」
 * バネ。秒数で「ここで揺らす」と決め打ちしないので、カメラの間を変えても
 * 布の反応と衣ずれの効果音が勝手に追随する。
 *
 * ## 光と、扉の向こう
 *
 * 以前は Ambient 1.1 + Directional 0.55 の平坦な昼光だった。照明の三分の二が
 * 無指向性では陰影の勾配が生まれず、どれだけ丁寧にモデリングしてもベタ塗りに
 * 見える。しかもこの店構えだけが昼で、ログイン画面の CSS も index.html も
 * 廊下（corridor-view.js）も夜の暖色なので、ここだけ世界から浮いていた。
 *
 * glb にはライトの実体こそ無いが（Blender のエリアライトは KHR_lights_punctual
 * で書き出せない）、作者が置いた位置は空ノードとして残っているので、そこに
 * 実体を建て直している。回り込みは環境マップに持たせた。金物（metal 0.9）は
 * 映り込む対象が無いと真っ黒に落ちるので、環境マップが無いあいだ暖簾の輪も
 * 引き戸の取っ手も窓もただの黒い塊だった。
 *
 * また、このモデルは z が -0.73 までしかない薄い書き割りで、**扉の向こうにも
 * 足元にも何も無い**。戸が開くと背景の黒が覗くだけだったので、土間と
 * 「奥の店内」をこちら側で足している。
 *
 * WebGL 非対応・モデル読み込み失敗時は "unsupported" を返す。呼び出し側
 * （login.js）はそれを受けたら CSS のフォールバック演出を使うこと。
 */

import * as THREE from "/vendor/three/three.module.min.js";
import { GLTFLoader } from "/vendor/three/GLTFLoader.js";

const MODEL_URL = "/assets/noren.glb";
/** 暖簾をくぐった先の景色。login.html / entrance.html と共有する正本 */
const INTERIOR_URL = "/assets/interior.svg";

// ── 時間割（ミリ秒） ────────────────────────────────────
// 合計 2.6 秒。以前は 5.667 秒で、うち 2.45 秒が完全な静止画だった。
// ログイン直後に見せる絵ではないので、間はすべて動きのために使う。
const T_DOOR_OPEN = 60; // 引き戸が動き出す（ふすまの音はここ）
const T_DOOR_DONE = 900; // 開ききる
const T_WALK_START = 300; // 踏み出す
const T_WALK_END = 2150; // 立ち止まる
const T_END = 2600; // 演出の終わり（この後、呼び出し側が暗転させる）

// ── カメラの道のり ──────────────────────────────────────
// 元のベイクと同じ始点・終点を使う（Blender の構図をそのまま活かすため）。
// 違うのは緩急と、歩きに合わせた頭の揺れだけ。
const CAM_FROM = new THREE.Vector3(0, 1.45, 5.0);
const CAM_TO = new THREE.Vector3(0, 1.35, -1.2);

/**
 * 揺れを嫌う設定で見せる一コマの、道のりの進み具合（0..1、緩急を掛けた後の値）。
 *
 * 終点（z=-1.2）ではない。あそこは暖簾も引き戸も庇も**すべてカメラの後ろ**で、
 * 正面には 1.8m 先の書き割りしか無い。動きを止めた途端、のっぺりした一色の
 * 面だけが残って絵にならない。
 *
 * 0.55 は z=+1.6。ここなら割れた暖簾が横幅のほとんどを占め、その切れ目の先に
 * 開いた戸と店の灯りが覗く。「暖簾をくぐった」が一枚の絵で伝わる構図。
 */
const STILL_WALK_T = 0.55;

/** 頭の上下の揺れ。歩幅ふたつぶん。大きくすると途端に酔うので 2cm 弱に留める */
const BOB_Y = 0.018;
const BOB_X = 0.010;
const BOB_STEPS = 2.4;

// ── 引き戸 ──────────────────────────────────────────────
const DOOR_TRAVEL = 1.8; // 元のベイクの開き量

// ── 暖簾の布 ────────────────────────────────────────────
/**
 * 布の幅。元は 0.30m で、0.35m 間隔に 4 枚並ぶため隣との間に 5cm の隙間が
 * 空いていた。カメラが通る x=0 がちょうどその隙間なので、布に一切触れずに
 * 通過していた。0.38m にして隣と 3cm 重ね、切れ目のない一枚にする。
 * ぶら下げ棒（NorenPole）は x∈[-0.78, 0.78] なので、広げた 1.43m は収まる。
 */
const STRIP_W = 0.38;
const STRIP_H = 1.20;
/** 元の glb と同じ配置。ノードは動かさない（輪 Ring0..3 が子なので一緒に動く） */
const STRIP_X = [-0.525, -0.175, 0.175, 0.525];
/** 体に巻きつく曲がりが多角形に見えない程度の分割 */
const STRIP_SEG_X = 8;
const STRIP_SEG_Y = 20;
/** 布がぶら下がっている面。カメラの z がここを跨いだ瞬間が「くぐった」 */
const STRIP_PLANE_Z = 0;
/** 横へ押し退けられる最大量（m） */
const PUSH_X = 0.24;
/** 体で奥へ押し込まれる最大量（m） */
const PUSH_Z = 0.12;
/** 体の幅。これより近い布が強く反応する */
const BODY_REACH = 0.62;
/** バネの速さ（rad/s）と減衰。減衰を小さくすると通過後にしばらく揺れ続ける */
const SPRING_W = 13.5;
const SPRING_ZETA = 0.26;

// ── 光 ──────────────────────────────────────────────────
const NIGHT = 0x140d07;

/**
 * フォールバック用: glTF にカメラが含まれていなかった場合に使う画角。
 * （Blender のカメラ初期位置を Y-up に変換したものが CAM_FROM）
 */
const FALLBACK_CAMERA_FOV_DEG = 45.75;

/** Blender 側のレンダー解像度（4:3）。構図の基準 */
const REF_ASPECT = 960 / 720;

let cachedGltfPromise = null;

function loadModel() {
  if (cachedGltfPromise === null) {
    cachedGltfPromise = new GLTFLoader().loadAsync(MODEL_URL);
  }
  return cachedGltfPromise;
}

function supportsWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      globalThis.WebGLRenderingContext &&
      (canvas.getContext("webgl2") || canvas.getContext("webgl"))
    );
  } catch {
    return false;
  }
}

/**
 * 3D 一式（three と glb）を先に取っておく。
 *
 * これが無いと、ボタンを押してから取りに行くことになり「押した → 無反応 →
 * 唐突に 3D」になる。login.js が画面を開いた後のヒマな時間に呼ぶ。
 *
 * @returns {Promise<boolean>} 演出を出せる見込みがあるか
 */
export async function preloadNorenIntro() {
  if (!supportsWebGL()) return false;
  try {
    // 店内の絵も先に取りに行く。歩き終わりに間に合わないと、いちばん見せたい
    // ところが無地の暗がりになる。待たないのは、glb さえあれば演出は始められるため
    loadInteriorTexture();
    await loadModel();
    return true;
  } catch {
    // 落とせなくてもページは壊さない。呼び出し側は CSS 版で通す
    cachedGltfPromise = null;
    return false;
  }
}

// ── 補間 ────────────────────────────────────────────────

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 踏み出しと止まりの両方を丸める。歩き出しの演出はこれで十分に見える */
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** 引き戸のように「勢いよく出て静かに止まる」動き */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** 0..1 に正規化した区間の進み具合 */
function span(nowMs, fromMs, toMs) {
  return clamp01((nowMs - fromMs) / (toMs - fromMs));
}

/**
 * Blender で作った画角（refFovDeg / REF_ASPECT）を基準の構図として、実際の
 * ウィンドウ比率がそれと違っても背景（店構えの外側）が見えないように調整する。
 * CSS の object-fit: cover と同じ考え方。基準より横長のウィンドウなら横幅を
 * 基準に合わせて固定し、代わりに上下が少しトリミングされる形でズームする。
 */
function applyCoverFov(camera, refFovDeg, viewportAspect) {
  const refVFov = THREE.MathUtils.degToRad(refFovDeg);
  let vFov = refVFov;
  if (viewportAspect >= REF_ASPECT) {
    const refHFov = 2 * Math.atan(Math.tan(refVFov / 2) * REF_ASPECT);
    vFov = 2 * Math.atan(Math.tan(refHFov / 2) / viewportAspect);
  }
  camera.fov = THREE.MathUtils.radToDeg(vFov);
  camera.aspect = viewportAspect;
  camera.updateProjectionMatrix();
}

// ── 環境マップ ──────────────────────────────────────────

/**
 * 環境マップを手続きで作る。
 *
 * このモデルはテクスチャを 1 枚も持たない単色 PBR で、しかも Gold は
 * metal=0.90 / rough=0.30、Glass は metal=0.20 / rough=0.15。金属は映り込む
 * 対象が無いと真っ黒に落ちるので、環境マップが無いあいだ、暖簾の輪も
 * 引き戸の取っ手も窓もただの黒い塊だった。質感が安く見えた最大の原因。
 *
 * 画像は足さない（CSP も転送量も増やさない）。equirectangular のグラデーションを
 * 1 枚描いて PMREM に通すだけで、金と硝子は十分に生き返る。examples/jsm の
 * RoomEnvironment は vendor に無いうえ「明るい室内」で夜の店先には合わないが、
 * PMREMGenerator は three 本体に入っているので追加の vendoring は要らない。
 *
 * three の equirectUv は u = atan2(z, x)/2π + 0.5 なので、扉のある -Z 方向は
 * u=0.25。店の灯りはそこへ置く。
 */
function buildEnvironment(renderer) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");

  const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
  sky.addColorStop(0.00, "#080a12"); // 真上: 夜空
  sky.addColorStop(0.42, "#1b1410"); // 軒の下
  sky.addColorStop(0.52, "#3a2a1a"); // 地平: 向かいの店の灯り
  sky.addColorStop(1.00, "#241a11"); // 真下: 路面の照り返し
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const blob = (x, y, r, color) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };
  // 扉の側（u=0.25）に店内の暖色。これが金物と硝子に映り込む本体
  blob(64, 70, 46, "rgba(255,168,86,0.85)");
  // 背後（u=0.75）は通りの街灯。金物の縁に冷たいハイライトが一本立つ
  blob(192, 62, 34, "rgba(150,170,220,0.35)");

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  // sRGB を明示する。落とすと環境が眠くなる
  texture.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromEquirectangular(texture);
  pmrem.dispose();
  texture.dispose();
  return target;
}

// ── 暖簾の布のテクスチャ ────────────────────────────────

/**
 * 暖簾の柄を canvas で描く。
 *
 * モデルには「宴」の字が入っておらず、ただの赤い板が 4 枚ぶら下がっているだけ
 * だった。ログイン画面の CSS の暖簾（login.html の .cloth-red / .noren-mark）は
 * 白丸に「宴」なので、同じ意匠を 3D にも入れて両者を同じ物に見せる。
 *
 * 4 枚ぶんを 1 枚の絵として描き、各板には世界座標から求めた u の窓を割り当てる
 * （板が重なっていても絵が途切れない）。こうすると「宴」が中央の切れ目で
 * ちょうど割れる。本物の暖簾がそうなっているし、割れて左右に退く演出とも
 * 意味が合う——くぐる瞬間に字が二つに分かれる。
 *
 * 地色も CSS 側と同じ #a8241f → #7e1a15 を使う。glb の NorenFabric は単色
 * だったので、material.color は白に倒して色ごとこのテクスチャに持たせている。
 */
function buildFabricTexture(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = Math.round(1024 * (height / width));
  const ctx = canvas.getContext("2d");

  const cloth = ctx.createLinearGradient(0, 0, 0, canvas.height);
  cloth.addColorStop(0, "#a8241f");
  cloth.addColorStop(1, "#7e1a15");
  ctx.fillStyle = cloth;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 織り目。真っ平らな色面は近づくとビニールに見えるので、
  // 目に留まらない程度の横筋を入れて布の density を出す
  ctx.globalAlpha = 0.05;
  for (let y = 0; y < canvas.height; y += 3) {
    ctx.fillStyle = y % 6 === 0 ? "#000" : "#fff";
    ctx.fillRect(0, y, canvas.width, 1);
  }
  ctx.globalAlpha = 1;

  // 白丸に「宴」。CSS 側の .noren-mark と同じ構え（丸は塗らず線だけ）
  const cx = canvas.width / 2;
  const cy = canvas.height * 0.34;
  const r = canvas.width * 0.105;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.88)";
  ctx.lineWidth = canvas.width * 0.005;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // en.css の --serif をそのまま読む。ここで別の指定を書くと二重管理になる。
  // 外部フォントは CSP（default-src 'self'）で読めないが、--serif は全部
  // 端末に入っている書体なので問題ない
  const serif = getComputedStyle(document.documentElement)
    .getPropertyValue("--serif").trim() || "serif";
  ctx.font = `${Math.round(r * 1.3)}px ${serif}`;
  ctx.fillText("宴", cx, cy + r * 0.04);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * 扉の向こうの店内。
 *
 * 中身は public/assets/interior.svg が持つ。あの1枚が「くぐった先の景色」の
 * 正本で、ここ（3D の背景板）と、login.html の遷移画面と、entrance.html の
 * 到着の3か所から同じ絵として使う。3つがずれると「くぐった先」と「遷移画面」と
 * 「着いた先」が別の店に見えてしまうため、絵は1枚しか持たない。
 *
 * canvas で描いていたのをやめたのは、遷移画面（CSS）と共有できないから。
 * SVG なら three は <img> 経由でテクスチャにでき、CSS は background-image に
 * できる。同じファイルなので、色を変えても3か所が勝手に揃う。
 *
 * 画面に入る範囲はウィンドウの縦横比で変わるので、3D と CSS を画素まで
 * 合わせることはできない。合わせる代わりに「どこを切り取っても居酒屋の中に
 * 見える」絵にしてある（詳細は interior.svg の冒頭）。
 */
let cachedInteriorTexture = null;

function loadInteriorTexture() {
  if (cachedInteriorTexture === null) {
    // load() はテクスチャを即座に返し、画像が届いた時点で中身が入る。
    // 待たないので、絵が遅れても演出の出だしは止まらない
    cachedInteriorTexture = new THREE.TextureLoader().load(INTERIOR_URL);
    cachedInteriorTexture.colorSpace = THREE.SRGBColorSpace;
  }
  return cachedInteriorTexture;
}

// ── シーンの組み立て ────────────────────────────────────

/**
 * 土間と、扉の向こうの店内を足す。
 *
 * glb は店構えの面（z ∈ [-0.73, 0.04]）しか持っていない。足元が無いので
 * 影の落ちる先が無く、戸を開けた先も背景の黒だった。どちらもこの演出では
 * ずっと画面に映るので、こちらで用意する。
 */
function buildBackdrop(scene) {
  const disposables = [];

  const groundGeo = new THREE.PlaneGeometry(16, 14);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x1c130b,
    roughness: 0.78,
    metalness: 0.0,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, 1.0); // カメラの通り道（z=5→-1.2）を覆う
  ground.receiveShadow = true;
  scene.add(ground);
  disposables.push(groundGeo, groundMat);

  // 店内の絵が届かない・板の外へ視界がはみ出す場合の受け皿。無地の暗がりを
  // 一枚後ろに立てておくと、隙間から背景の黒が覗くことがなくなる
  const voidGeo = new THREE.PlaneGeometry(9, 6);
  const voidMat = new THREE.MeshBasicMaterial({ color: 0x150d07, toneMapped: false });
  const backVoid = new THREE.Mesh(voidGeo, voidMat);
  backVoid.position.set(0, 1.5, -3.4);
  scene.add(backVoid);
  disposables.push(voidGeo, voidMat);

  // 店内。interior.svg は 1200x800（3:2）なので、板も同じ比にして歪ませない。
  //
  // 大きさと高さは「歩き終わりに何が正面に来るか」で決めてある。カメラは
  // (0, 1.35, -1.2) で止まり、そこから見えるのはこの板の横 56% / 縦 45% ほど。
  //
  // 板を大きくすると絵が引き伸ばされて、見える範囲が狭まる（＝寄る）。
  // 逆に小さくすると引くが、戸を通して見える範囲を覆えなくなる。3.6 x 2.4 が
  // その折り合いで、中心を目線より下げてあるのは、切り取られる枠を絵の
  // 上のほうへずらして提灯を入れるため。枠に入るのは提灯の下端・品書き・
  // 棚の瓶・カウンターの天板。
  const backGeo = new THREE.PlaneGeometry(3.6, 2.4);
  // 光を受けない板にする。奥は「明るい場所」であってほしいので、
  // こちら側のライトの届き方に左右させない
  const backMat = new THREE.MeshBasicMaterial({ map: loadInteriorTexture(), toneMapped: true });
  const back = new THREE.Mesh(backGeo, backMat);
  back.position.set(0, 1.30, -3.0);
  scene.add(back);
  // テクスチャは使い回すので、ここでは捨てない（dispose() がまとめて片付ける）
  disposables.push(backGeo, backMat);

  return disposables;
}

/**
 * glb に空ノードとして残っているライトの位置に、実体を建てる。
 * Blender のエリアライトは KHR_lights_punctual で書き出せないので実体は
 * 落ちているが、作者が「どこに置きたかったか」は座標として残っている。
 */
function buildLights(scene, root) {
  const at = (name, fallback) => {
    const node = root.getObjectByName(name);
    return node ? node.getWorldPosition(new THREE.Vector3()) : fallback;
  };

  // 環境マップが回り込みを受け持つので、空と地面の色を薄く足すだけに留める。
  // ここを上げると陰影の勾配が消えて、一気にベタ塗りに見える（以前の
  // AmbientLight 1.1 がまさにそれで、平坦さの主因だった）
  scene.add(new THREE.HemisphereLight(0x2a3550, 0x140d07, 0.35));

  const key = new THREE.DirectionalLight(0xffe0b0, 1.5);
  key.position.copy(at("KeyLight", new THREE.Vector3(-2, 3.2, 2.5)));
  key.target.position.set(0, 1.3, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0012;
  // 布は厚みゼロの平面なので、これが無いと自分の影で縞が出る
  key.shadow.normalBias = 0.02;
  // 影の箱は画に入る範囲だけ。広げるほど同じ解像度が薄まってがさつく
  const cam = key.shadow.camera;
  cam.left = -3.2;
  cam.right = 3.2;
  cam.top = 3.6;
  cam.bottom = -0.6;
  cam.near = 0.5;
  cam.far = 14;
  cam.updateProjectionMatrix();
  scene.add(key);
  scene.add(key.target);

  const fill = new THREE.DirectionalLight(0xa8c4e0, 0.22);
  fill.position.copy(at("FillLight", new THREE.Vector3(2.6, 2.0, 2.2)));
  scene.add(fill);

  // 店内から外へ向けたスポット。作者が RimLight をここに置いていたのは
  // 「中から漏れる逆光」の意図。影を持たせると、戸が滑るのに合わせて
  // 路面に漏れる光が勝手に広がる（手で付ける必要がない）
  const spill = new THREE.SpotLight(0xffb15e, 14, 9, 0.95, 0.85, 2.0);
  spill.position.copy(at("RimLight", new THREE.Vector3(0.3, 2.2, -1.2)));
  spill.target.position.set(0.15, 0, 2.2);
  spill.castShadow = true;
  spill.shadow.mapSize.set(512, 512);
  scene.add(spill);
  scene.add(spill.target);

  // 開口のふちを舐める灯り。扉が開くにつれ強くする＝「明るい方へ歩いていく」
  // 画になる。強さは drawFrame() が動かすので、ここでは 0 から始める
  const beyond = new THREE.PointLight(0xffc98a, 0, 7.0, 2.0);
  beyond.position.copy(at("BeyondGlow", new THREE.Vector3(0, 1.3, -0.9)));
  scene.add(beyond);

  return { beyond };
}

/**
 * 布 4 枚を作り直して、揺らすのに要る情報を持たせる。
 *
 * 元の Strip は UV を持っておらず（「宴」を貼れない）、シェイプキーのせいで
 * 頂点が 189 → 356 に割れていた。中身がただの平面である以上、直すより
 * PlaneGeometry で作り直すほうが素直で、横の分割も自由に選べる。
 *
 * `reach` は「体がどれだけ触るか」。カメラは x=0 を通るので、内側の 2 枚
 * （|x|=0.175）は正面から分けられ、外側の 2 枚（|x|=0.525）は肩がかすめる程度。
 * ここを一律にすると 4 枚が同じ動きで開いて、途端に嘘くさくなる。
 */
function prepareStrips(root, fabric) {
  const strips = [];
  const left = STRIP_X[0] - STRIP_W / 2;
  const total = STRIP_X[3] + STRIP_W / 2 - left;

  for (let i = 0; i < 4; i++) {
    const node = root.getObjectByName(`Strip${i}`);
    if (!node) continue;

    const old = node.geometry;
    const geometry = new THREE.PlaneGeometry(STRIP_W, STRIP_H, STRIP_SEG_X, STRIP_SEG_Y);
    // 元データと同じく、上端が y=0（＝ノードの高さ＝棒の高さ）に来るようにする
    geometry.translate(0, -STRIP_H / 2, 0);

    // u は板ごとの 0..1 ではなく、暖簾全体の中での位置から引く。
    // 板が隣と重なっていても絵が途切れず、「宴」が切れ目でちょうど割れる
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    for (let v = 0; v < uv.count; v++) {
      uv.setX(v, (STRIP_X[i] + position.getX(v) - left) / total);
    }
    uv.needsUpdate = true;

    position.setUsage(THREE.DynamicDrawUsage);
    geometry.getAttribute("normal").setUsage(THREE.DynamicDrawUsage);
    // 曲げは毎フレーム「元の形から」作り直す。前フレームの結果に積むと
    // 誤差が溜まって布が伸びていく
    const base = new Float32Array(position.array);

    node.geometry = geometry;
    old.dispose();
    node.material = fabric;
    // 大きく振れるので、毎フレーム境界球を計算させない
    node.frustumCulled = false;

    const x = STRIP_X[i];
    // 内側は 1.0、外側は 0.3 前後（0.62 は体の幅 BODY_REACH）
    const reach = clamp01(1 - (Math.abs(x) - 0.175) / BODY_REACH) * 0.7 + 0.3;

    strips.push({
      node,
      geometry,
      position,
      base,
      x0: x,
      dir: x < 0 ? -1 : 1,
      reach,
      // 横（x）と奥（z）で別々のバネを持つ。押し退けられるのと押し込まれるのは
      // 戻り方が違うので、ひとつにまとめると動きが単調になる
      x: { value: 0, vel: 0 },
      z: { value: 0, vel: 0 },
    });
  }
  return strips;
}

/** バネを 1 ステップ進める。通り過ぎたあと目標が 0 に戻ると、勝手に揺り返す */
function stepSpring(spring, target, dt) {
  const acc = SPRING_W * SPRING_W * (target - spring.value) -
    2 * SPRING_ZETA * SPRING_W * spring.vel;
  spring.vel += acc * dt;
  spring.value += spring.vel * dt;
}

/**
 * 布を曲げる。
 *
 * 上端（y=0）は棒に通してあるので動かず、裾へ行くほど大きく振れる。
 * 189 頂点 × 4 枚 = 756 頂点なので、シェーダを差し替えるより CPU で書いたほうが
 * 素直で、法線もそのまま計算し直せる。影の深度パスも同じバッファを読むので、
 * 影まで一緒に割れてくれる。
 *
 * 「横に振れたぶん裾が上がる」（糸は伸びない）を入れているのが肝。これが無いと
 * ただ斜めに歪んだ板にしか見えず、布に見えない。
 */
function bendStrip(strip) {
  const { position, base } = strip;
  const array = position.array;
  const pushX = strip.x.value;
  const pushZ = strip.z.value;

  for (let i = 0; i < array.length; i += 3) {
    const bx = base[i];
    const y = base[i + 1];
    // 0（上端）から 1（裾）へ。smoothstep にさらに t を掛けて、付け根が
    // ほとんど動かないようにする＝布の重さが出る
    const t = clamp01(-y / STRIP_H);
    const pin = t * t * (3 - 2 * t) * t;
    // 体に近い縁ほど大きく退く。板が「回りながら」開いて見える
    const inner = clamp01((-strip.dir * bx + STRIP_W / 2) / STRIP_W);
    const w = pin * (0.55 + 0.45 * inner);

    const dx = pushX * w;
    const dz = pushZ * w;
    // 上端からこの点までの布の長さは変わらない。斜辺を保って垂れ下がりを縮める
    const spanLen = STRIP_H * t;
    const flat = Math.min(Math.hypot(dx, dz), spanLen * 0.94);
    const drop = Math.sqrt(Math.max(0, spanLen * spanLen - flat * flat));

    array[i] = bx + dx;
    array[i + 1] = -drop;
    array[i + 2] = base[i + 2] + dz;
  }
  position.needsUpdate = true;
  // 曲がった面に光が正しく乗るように法線を引き直す。この規模なら毎フレームで足りる
  strip.geometry.computeVertexNormals();
}

/**
 * @typedef {"ready"|"doorOpen"|"norenSplit"|"walkStart"|"walkEnd"} NorenBeat
 *
 * @param {HTMLElement|null} stageEl 3D を差し込むフルスクリーンのコンテナ
 * @param {{
 *   reducedMotion?: boolean,
 *   signal?: AbortSignal,
 *   onBeat?: (beat: NorenBeat, atMs: number) => void,
 * }} [options]
 * @returns {Promise<"played"|"still"|"unsupported">}
 */
export async function playNorenIntro(stageEl, options = {}) {
  const { reducedMotion = false, signal = null, onBeat = null } = options;
  if (!stageEl || !supportsWebGL()) return "unsupported";

  let gltf;
  try {
    gltf = await loadModel();
  } catch {
    cachedGltfPromise = null;
    return "unsupported";
  }
  if (signal?.aborted) return "unsupported";

  const beat = (name, atMs) => {
    try {
      onBeat?.(name, atMs);
    } catch {
      // 呼び出し側の都合で演出を止めない
    }
  };

  // ── 描画の土台 ──────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.setSize(globalThis.innerWidth, globalThis.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // トーンマッピング無しだと、ライトの合計が 1.0 を超えた箇所が白飛びして
  // 木の色が消える。露出は corridor-view.js と同じ 0.95 に揃えている
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  // 霧が無いと、実体を置くのをやめた先が黒く抜ける（corridor-view.js と同じ理由）
  scene.background = new THREE.Color(NIGHT);
  scene.fog = new THREE.FogExp2(NIGHT, 0.045);

  const envTarget = buildEnvironment(renderer);
  scene.environment = envTarget.texture;

  const root = gltf.scene;
  scene.add(root);

  const extras = buildBackdrop(scene);
  const { beyond } = buildLights(scene, root);

  // 布の材質は 4 枚で共有する。u を世界座標から引いているので、1 枚の絵を
  // 4 枚で分け持つ形になる
  const fabricTex = buildFabricTexture(
    STRIP_X[3] + STRIP_W / 2 - (STRIP_X[0] - STRIP_W / 2),
    STRIP_H,
  );
  const fabric = root.getObjectByName("Strip0").material;
  fabric.map = fabricTex;
  fabric.color = new THREE.Color(0xffffff); // 色はテクスチャ側が持つ
  fabric.side = THREE.DoubleSide; // くぐった後は裏から見ることになる
  fabric.shadowSide = THREE.DoubleSide;
  fabric.needsUpdate = true;
  const strips = prepareStrips(root, fabric);

  const door = root.getObjectByName("SlidingDoor");
  const doorFromX = door ? door.position.x : 0;

  // 壁と窓ガラスは影を受けるだけ。大きい面まで影を落とさせると、影の箱の
  // 解像度を平らな板に食われて、細かい桟の影がつぶれる
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.receiveShadow = true;
    obj.castShadow = !/^Wall|^WindowGlass/.test(obj.name);
  });

  // 金物と硝子は、環境が入っただけだと「綺麗すぎる鏡」になる。夜の店先に寄せる
  for (const mesh of [root.getObjectByName("DoorHandle"), root.getObjectByName("NorenPole")]) {
    if (mesh?.material) {
      mesh.material.roughness = 0.36;
      mesh.material.envMapIntensity = 1.4;
    }
  }
  const glass = root.getObjectByName("WindowGlass");
  if (glass?.material) {
    glass.material.metalness = 0.0;
    glass.material.roughness = 0.08;
    glass.material.envMapIntensity = 2.0;
    // 中の灯りが硝子越しに滲む。板ガラスの夜の見え方
    glass.material.emissive = new THREE.Color(0xff9a48);
    glass.material.emissiveIntensity = 0.12;
  }

  // ── カメラ ──────────────────────────────────────────
  let camera = null;
  root.traverse((obj) => {
    if (camera === null && obj.isCamera) camera = obj;
  });
  const refFovDeg = camera ? camera.fov : FALLBACK_CAMERA_FOV_DEG;
  if (camera === null) {
    camera = new THREE.PerspectiveCamera(refFovDeg, 1, 0.1, 50);
  }
  // 通過の瞬間、布は目の前 20cm まで寄る。near を切り詰めないと顔の前で消える
  camera.near = 0.03;
  camera.far = 40;
  // glTF のノード階層にぶら下がったままだと位置を自分で決められないので、
  // シーン直下へ移す（元の回転はほぼ無回転なので捨ててよい）
  scene.add(camera);
  camera.rotation.set(0, 0, 0);
  applyCoverFov(camera, refFovDeg, globalThis.innerWidth / globalThis.innerHeight);

  // ── 1 フレーム描く ──────────────────────────────────
  /**
   * @param {number} nowMs 演出開始からの経過。負なら「くぐり終えた一コマ」
   * @param {number} dt 前フレームからの秒数
   */
  function drawFrame(nowMs, dt) {
    const still = nowMs < 0;

    // 引き戸
    const doorT = still ? 1 : easeOutCubic(span(nowMs, T_DOOR_OPEN, T_DOOR_DONE));
    if (door) door.position.x = doorFromX + DOOR_TRAVEL * doorT;
    // 扉が開くほど中の灯りが漏れる
    beyond.intensity = 6.5 * doorT;

    // カメラ
    const walkT = still ? STILL_WALK_T : easeInOutCubic(span(nowMs, T_WALK_START, T_WALK_END));
    camera.position.lerpVectors(CAM_FROM, CAM_TO, walkT);
    if (!still) {
      // 歩いている間だけ頭を揺らす。止まっているのに揺れると乗り物酔いになる。
      // sin(πt) を掛けているので、踏み出しと止まりで揺れが自然に消える
      const moving = Math.sin(Math.PI * walkT);
      const phase = walkT * Math.PI * 2 * BOB_STEPS;
      camera.position.y += Math.sin(phase) * BOB_Y * moving;
      camera.position.x += Math.sin(phase * 0.5) * BOB_X * moving;
      // 頭の揺れに合わせてほんの少しだけ首が傾く（0.35 度ほど）
      camera.rotation.z = Math.sin(phase * 0.5) * 0.006 * moving;
    }

    // 布
    for (const strip of strips) {
      if (still) {
        // 静止の一コマは「くぐり終えて布が開いたところ」。動かさずに絵だけ作る
        strip.x.value = strip.dir * PUSH_X * 0.75 * strip.reach;
        strip.z.value = -PUSH_Z * 0.4 * strip.reach;
      } else {
        // カメラが布の面にどれだけ近いか。跨いだ瞬間が 1
        const dz = (camera.position.z - STRIP_PLANE_Z) / 0.6;
        const near = Math.exp(-dz * dz);
        // 体の中心から布までの距離ぶん、当たりを弱める
        const dx = (strip.x0 - camera.position.x) / BODY_REACH;
        const hit = near * Math.exp(-dx * dx * 0.55) * strip.reach;

        stepSpring(strip.x, strip.dir * PUSH_X * hit, dt);
        stepSpring(strip.z, -PUSH_Z * hit, dt);
      }
      bendStrip(strip);
    }

    renderer.render(scene, camera);
  }

  // ── 後片付け ────────────────────────────────────────
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    globalThis.removeEventListener("resize", onResize);

    // 形と材質は glb の中で共有されている（壁の桟は同じ箱を使い回す等）ので、
    // 集めてから重複なく捨てる。corridor-view.js:1156-1172 と同じ手当て
    const geometries = new Set();
    const materials = new Set();
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      geometries.add(obj.geometry);
      for (const m of [].concat(obj.material)) materials.add(m);
    });
    for (const g of geometries) g.dispose();
    for (const m of materials) {
      m?.map?.dispose();
      m?.dispose();
    }
    for (const d of extras) d.dispose();
    envTarget.dispose();
    cachedInteriorTexture?.dispose();
    cachedInteriorTexture = null;
    scene.environment = null;
    renderer.dispose();
    // これを呼ばないと WebGL のコンテキストがブラウザの上限（16 前後）まで
    // 溜まる。遷移すれば消えるが、演出を飛ばして画面に留まる経路がある
    renderer.forceContextLoss();
    stageEl.replaceChildren();
    // 形も材質も捨てたので、次に開くときは読み直す
    cachedGltfPromise = null;
  }

  /**
   * 画面を離れるときに片付ける。
   *
   * すでに中断済みの signal に後からリスナを足しても呼ばれないので、
   * その場合は直に片付ける。ここを素通りさせると、演出の途中で
   * pagehide した回だけ WebGL のコンテキストが残る。
   */
  function disposeOnAbort() {
    if (!signal) return;
    if (signal.aborted) dispose();
    else signal.addEventListener("abort", dispose, { once: true });
  }

  function onResize() {
    const w = globalThis.innerWidth;
    const h = globalThis.innerHeight;
    applyCoverFov(camera, refFovDeg, w / h);
    renderer.setSize(w, h);
  }
  globalThis.addEventListener("resize", onResize);

  stageEl.replaceChildren(renderer.domElement);

  // ── 揺れを嫌う設定: くぐり終えた一コマだけ ──────────
  if (reducedMotion) {
    drawFrame(-1, 0);
    await showStage(stageEl);
    beat("ready", 0);
    // 描いた絵はそのまま出しっぱなしにする。ここで片付けると canvas が
    // 空になって、暗転までのあいだ真っ黒な板が出てしまう。
    // 掃除はページを離れるとき（login.js が signal を abort する）に走る
    disposeOnAbort();
    return "still";
  }

  // ── 本編 ────────────────────────────────────────────
  // 最初の一コマを描いてから表に出す。描く前に .visible を付けると、
  // まだ何も描かれていない真っ黒な canvas が 1 フレーム見える
  drawFrame(0, 0);
  await showStage(stageEl);
  beat("ready", 0);

  await new Promise((resolve) => {
    const start = performance.now();
    let last = start;
    let rafId = 0;
    let saidDoor = false;
    let saidWalkStart = false;
    let saidWalkEnd = false;
    let saidSplit = false;
    let prevZ = CAM_FROM.z;

    function finish() {
      cancelAnimationFrame(rafId);
      clearTimeout(guard);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    // タブが裏に回ると rAF が止まる。戻ってこられないと遷移まで詰まるので保険を張る
    const guard = setTimeout(finish, T_END + 1500);
    signal?.addEventListener("abort", finish, { once: true });

    function tick(now) {
      const elapsed = now - start;
      // 間が空いたとき（タブが裏に回った等）にバネが吹き飛ばないよう頭を押さえる
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;

      drawFrame(elapsed, dt);

      if (!saidDoor && elapsed >= T_DOOR_OPEN) {
        saidDoor = true;
        beat("doorOpen", elapsed);
      }
      if (!saidWalkStart && elapsed >= T_WALK_START) {
        saidWalkStart = true;
        beat("walkStart", elapsed);
      }
      // 「くぐった」は秒数ではなく、カメラが布の面を跨いだ事実で決める。
      // カメラの間を変えても衣ずれの音が勝手に追随する
      if (!saidSplit && prevZ > STRIP_PLANE_Z && camera.position.z <= STRIP_PLANE_Z) {
        saidSplit = true;
        beat("norenSplit", elapsed);
      }
      prevZ = camera.position.z;
      if (!saidWalkEnd && elapsed >= T_WALK_END) {
        saidWalkEnd = true;
        beat("walkEnd", elapsed);
      }

      if (elapsed >= T_END) {
        finish();
        return;
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  });

  // 最後のコマは消さずに残す（reducedMotion と同じ理由）。呼び出し側が
  // この絵の上から暗転させ、そのまま遷移する
  disposeOnAbort();
  return "played";
}

/**
 * canvas を表に出して、実際に合成されるまで待つ。
 * rAF 1 回では「次のフレームの用意ができた」だけで、まだ画面に出ていないことが
 * あるので二重に待つ。ここを待たずに暗幕を戻すと、その先が真っ黒になる。
 */
function showStage(stageEl) {
  stageEl.classList.add("visible");
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
