/**
 * 居酒屋の廊下を歩いて卓を選ぶ 3D ビュー（部屋リストの見せ方その2）。
 *
 * ■ 廊下の作り方
 * 卓は何百あるかもしれないので、廊下を作り置きせず、正方形のマス目の上に
 * 部品（izakaya_corridor_kit.glb）を並べて組む。マスとマスの境目（辺）を
 * 開けるか塞ぐかを決めるだけで、直線・角・T字・十字・行き止まりが自然に出る。
 *
 * 辺の開閉は座標から計算するハッシュで決めている。乱数表を持たないので、
 * 同じ場所へ戻れば必ず同じ形になり、どれだけ歩いても地図を保持しなくてよい。
 * 判定は「マス」ではなく「辺」に対して行うのが肝で、辺は隣り合う2マスで
 * 共有されるため、隣同士で食い違うことが原理的に起きない。
 *
 * 実体として置くのはカメラの周り VIEW_R マスぶんだけ。離れたマスは部品ごと
 * 使い回すので、歩いた距離に関係なく物の数は一定になる。
 *
 * ■ 描き方（ドローコール）
 * 部品はマスごとに Mesh を作るのではなく、部品の「種類」ごとに1つの
 * InstancedMesh を持ち、マスごとの置き場所は行列で渡す。マスが増えても
 * ドローコールは種類の数（現状 22 本）で頭打ちになる。
 * マスごとに Mesh を作っていた頃は 719〜944 枚あった（GLB は材質ごとにメッシュが
 * 割れるので、扉1枚で 9 枚になる）。
 *
 * ■ 扉
 * 塞がった辺には扉が付く（一部は扉なしの壁にして単調さを避ける）。
 * どの扉がどの卓を受け持つかは、ブロック内で扉に連番を振って決める（roomAt）。
 * 卓の数より扉のほうが多いので、歩き続ければ同じ卓に何度も出会う。
 *
 * 卓名・卓コードなどの文字は 3D には描かず、visibleDoors() が返す画面座標に
 * 呼び出し側が HTML の目印を重ねる。canvas を扉ごとに持たなくて済むので
 * 材質を共有でき、上の InstancedMesh 化が効く。読み上げにも乗る。
 *
 * このビューは一覧カードの代わりではなく上乗せ。スクリーンリーダーや WebGL が
 * 無い環境では従来のカード一覧が本体として残る前提で作っている。
 * 目の前の卓は onFocus で外へ渡すので、呼び出し側で aria-live に流せる。
 */

import * as THREE from "/vendor/three/three.module.min.js";
import { GLTFLoader } from "/vendor/three/GLTFLoader.js";

/** モデル側の取り決め（tools/blender/izakaya_kit.py と一致させる） */
const CELL = 3.00;      // マスの1辺
const HALF_W = 1.00;    // 通り幅の半分（＝壁の内側の面まで）
const EYE = 1.55;       // 目線の高さ

/** 進む向き。three.js は Y が上なので、北は -Z。Blender の +Y がここに来る */
const DIRS = [
  { key: "N", dx: 0, dz: -1, rot: 0 },
  { key: "E", dx: 1, dz: 0, rot: -Math.PI / 2 },
  { key: "S", dx: 0, dz: 1, rot: Math.PI },
  { key: "W", dx: -1, dz: 0, rot: Math.PI / 2 },
];

/**
 * 辺を1本ずつ独立に開け閉めすると、通路ではなく「柱の立った広間」になる。
 * 廊下に見せるには、先に「通りになる行・列」を決めてから、その筋に沿った辺だけを
 * 開けるのが要る。行と列の通りが交差したところが十字路、片側が塞がればT字路、
 * 二方向だけ残れば曲がり角、一方向だけなら行き止まり — と自然に出そろう。
 */
// この3つを振って形の出方を測った結果の組み合わせ。
// 直線29% / 角10% / T字22% / 十字10% / 行き止まり28% になり、
// かつ起点から全域へ歩いて行ける（どこかに閉じ込められない）。
// P_SEGMENT を下げると角と行き止まりが増える代わりに網が千切れ、
// 0.7 を割ると歩ける範囲が半分以下に落ちるので、ここが下限に近い。
const P_STREET = 0.50;     // 通りになる行・列の割合
const P_SEGMENT = 0.78;    // 通りの一区間が繋がっている割合。欠けるとT字や角になる
const P_SHORTCUT = 0.14;   // 通り以外の辺がたまたま抜ける割合。小部屋や近道になる
/** 塞がった辺のうち、扉が付く割合。残りは素の壁になり、通路に緩急が出る */
const P_DOOR = 0.72;
/** 天井の灯りを置くマスの割合 */
const P_LIGHT = 0.45;

/** カメラのマスから何マスぶん実体を置くか。曲がり角で先が見えないので3で足りる */
const VIEW_R = 3;

/**
 * 隅柱（Kit_Core の中の1本）の寸法と置き場所。GLB から測った実測値。
 *
 * マスの1辺は 3.00 だが壁板の幅は通路と同じ 2.00 しかないので、マスとマスの境目には
 * 幅 1.00 の「壁の厚み」の区画が残る。その 1.00 四方の角を 4 つのマスが 0.50 ずつ
 * 分け合う形になっているのに、Kit_Core は +X / -Z 側の1本しか持っていない。
 * 隣のマスの柱は1マスぶん先の角を埋めるので、README にある「隣のマスの柱が残り3隅を
 * 埋める」は成り立たず、**まっすぐな廊下でもマスの境目ごとに 0.5m 幅・天井まで届く
 * 縦穴が開く**（目線の高さで塗り広げて測ると、-8..8 マスの範囲で 767 m² ぶん
 * 「見えてはいけない場所」へ抜けられた）。
 *
 * そこで読み込み時に柱の三角形だけを取り出し、90 / 180 / 270° 回した3本を足して
 * 四隅を埋める。同じ測り方で漏れ 0 になることを確認済み
 * （tools/corridor-layout-check.js と検証台の「壁の穴」を参照）。
 * GLB を作り直さずに済ませるため、この形にしてある。
 */
const CORR_H = 2.35;            // 天井高。柱はここまで届く
const POST_W = CELL / 2 - HALF_W;   // 0.50。角の1/4ぶん
/** 柱を取り出すための箱。ここに三角形が丸ごと入っているものだけを柱とみなす */
const POST_BOX = {
  minX: HALF_W, maxX: CELL / 2,
  minY: 0, maxY: CORR_H,
  minZ: -CELL / 2, maxZ: -HALF_W,
};
/** 四隅ぶんの回転。柱は Kit_Core から切り離して、この4本を置き直す */
const POST_ROTS = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

/** 体の太さ。壁にめり込まないよう、この分だけ手前で止める */
const BODY_R = 0.35;
const LIMIT = HALF_W - BODY_R;

/** 歩く速さの上限（m/s）。これを超えると1フレームの移動が LIMIT に近づいて壁を抜ける */
const MAX_SPEED = 3.2;
/** その場旋回の速さ（rad/s）。キーボードの左右と同じ効き */
const TURN_RATE = 1.8;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 座標から 0..1 を作る。整数3つを混ぜて潰すだけの、表を持たないハッシュ。
 * 同じ入力なら必ず同じ値が出るので、歩いて戻ってきても廊下の形が変わらない。
 */
function hash01(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^
    Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 行 z が東西の通りか（＝横に抜けられる筋か） */
const rowIsStreet = (z) => hash01(z, 0, 7) < P_STREET;
/** 列 x が南北の通りか */
const colIsStreet = (x) => hash01(x, 0, 8) < P_STREET;

/**
 * マス (x, z) の dir 側の辺が開いているか。
 * 辺は2つのマスで共有されるので、必ず「辺そのもの」を一意に指す形で引く。
 * W と N は隣のマスの E / S と同じ辺なので、そちらへ委ねて食い違いを断つ。
 */
function edgeOpen(x, z, dirKey) {
  if (dirKey === "W") return edgeOpen(x - 1, z, "E");
  if (dirKey === "N") return edgeOpen(x, z - 1, "S");
  if (dirKey === "E") {
    return hash01(x, z, 1) < (rowIsStreet(z) ? P_SEGMENT : P_SHORTCUT);
  }
  return hash01(x, z, 2) < (colIsStreet(x) ? P_SEGMENT : P_SHORTCUT);   // S
}

/** どこにも抜けられないマスは、そもそも人が入れないので作らない */
function cellUsed(x, z) {
  return DIRS.some((d) => edgeOpen(x, z, d.key));
}

/**
 * 塞がった辺に扉を出すか。
 *
 * **`edgeOpen` と違って「辺」ではなく「マス＋方向」で引いているのは意図的。**
 * 直したくなるが、直さないこと。理由は3つある。
 *
 * 1. **壁板は辺そのものに建っていない。**マスの1辺は 3.00 だが板の幅は通路と同じ
 *    2.00 で、板はマスの中心から HALF_W（1.00）の位置に立つ。隣のマスが建てる板は
 *    0.72 離れた別の板であって、同じ1枚ではない。つまり「表と裏」ではなく、
 *    それぞれの廊下に面した独立した2枚。片方が扉でもう片方が壁でも矛盾しない
 *    （現実の建物でも、廊下Aから見て扉・廊下Bから見て壁は普通に起きる）。
 * 2. **扉の向こうに部屋の実体は無い。**押して入るのは WebSocket の卓であって
 *    3D の空間ではないので、「隣が廊下か行き止まりか」は表示上の意味を持たない。
 * 3. **辺で引くように「揃える」と体験が壊れる。**実際に測った（12,379 マス）:
 *    いまの扉の 73.4% は「両側とも廊下」の辺に立っている。そこを外すと
 *    扉は 16,137 → 4,291（1.30枚/マス → 0.35枚/マス）まで落ち、
 *    **扉が1枚も無い廊下のマスが 21.7% → 70.1% になる。**
 *    P_DOOR を 1.00 まで上げても 0.48枚/マス・61.3% にしかならず届かない。
 *
 * なお「廊下の外に扉の裏側が見える」不具合は、辺の引き方ではなく隅柱の穴が原因
 * だった（POST_BOX のコメントを参照）。塞いだ以上、原理的に画面へ出てこない。
 */
function hasDoor(x, z, i) {
  return hash01(x * 4 + i, z, 3) < P_DOOR;
}

/**
 * 卓を配る単位。8×8 マス（24m 四方）。
 * 視界（VIEW_R = 3 マス ＝ 7×7）より大きく取ると、見えている扉が1つのブロックに
 * 収まる地点が増えて重複が減る。4 / 8 / 16 / 32 を測ったところ 8 でほぼ頭打ちになり
 * （卓7で 3.17 → 3.12 → 3.11 → 3.11）、割り当ての costs は 1.5 → 6.9 → 24 → 84 µs と
 * 4倍ずつ増えるので 8 を採る。
 * これ以上大きくしても効かないのは、ブロック内の扉数が卓数を超えると
 * 結局ブロックの中で卓を一周してしまうため。
 */
const BLOCK = 8;

/** (x, z) がヒルベルト曲線の何番目か。n は2の冪 */
function hilbertIndex(n, x, z) {
  let d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const rz = (z & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ rz);
    if (rz === 0) {                       // 象限に合わせて座標系を回す
      if (rx === 1) {
        x = s - 1 - x;
        z = s - 1 - z;
      }
      const t = x;
      x = z;
      z = t;
    }
  }
  return d;
}

/**
 * ブロックの中をどの順に数えるか。ヒルベルト曲線（次の番号が必ず隣のマスになる並び）。
 * 連番の近さが場所の近さとほぼ一致するので、卓を連番順に配ると、同じ卓が再び出るのは
 * 「卓数ぶん先」＝場所としても離れた所になる。
 * 素直な行走査だと行をまたぐたびに端から端へ飛ぶため、同じ卓が縦に並びやすかった。
 * 中身は 0..BLOCK*BLOCK-1 を z * BLOCK + x で表したもの。読み込み時に1回だけ組む。
 */
const BLOCK_ORDER = (() => {
  const cells = [];
  for (let z = 0; z < BLOCK; z++) {
    for (let x = 0; x < BLOCK; x++) cells.push({ x, z, d: hilbertIndex(BLOCK, x, z) });
  }
  cells.sort((a, b) => a.d - b.d);
  return cells.map((c) => c.z * BLOCK + c.x);
})();

/**
 * その扉が受け持つ卓。
 *
 * 扉ごとに独立してハッシュを引くと、卓が少ないときに近くへ同じ卓がいくつも並ぶ。
 * そこで「ブロックの中に実在する扉だけを決まった順に数え、その連番で卓を順ぐりに配る」。
 * 連番が密なので、卓数より扉が少ないブロックでは重複が原理的に出ない。
 *
 * 座標だけから決まるので決定性は保たれ、訪れたマスを覚える必要も無い
 * （毎回ブロック 8×8 マスを数え直すだけ。1扉あたり 7µs 程度で、
 *  扉を置き直すときと卓一覧が入れ替わったときにしか呼ばれない）。
 *
 * 1地点から見える扉（視線が通る扉）の重複数は tools/corridor-layout-check.js で測れる。
 * 卓7で 3.68 → 3.12（鳩の巣による下限は 2.19）、
 * 隣り合う扉が同じ卓になる率は 14.8% → 5.3% に下がる。
 */
function roomAt(x, z, i, rooms) {
  if (rooms.length === 0) return null;
  const bx = Math.floor(x / BLOCK);
  const bz = Math.floor(z / BLOCK);
  let k = 0;
  for (const cell of BLOCK_ORDER) {
    const cx = bx * BLOCK + (cell % BLOCK);
    const cz = bz * BLOCK + ((cell / BLOCK) | 0);
    const used = cellUsed(cx, cz);
    for (let d = 0; d < 4; d++) {
      if (cx === x && cz === z && d === i) {
        // ブロックごとに配り始めをずらす。揃えると、どのブロックでも
        // 同じ卓が同じ位置に来て、格子模様に見えてしまう。
        const off = Math.floor(hash01(bx, bz, 11) * rooms.length);
        return rooms[(off + k) % rooms.length];
      }
      if (used && !edgeOpen(cx, cz, DIRS[d].key) && hasDoor(cx, cz, d)) k++;
    }
  }
  return rooms[0];   // ブロックの外の扉を訊かれない限り来ない
}

/** 同時に置くマスの数と、その四方の辺の数。まとめ描きの枠はこの上限で確保する */
const MAX_CELLS = (VIEW_R * 2 + 1) * (VIEW_R * 2 + 1);
const MAX_EDGES = MAX_CELLS * 4;
/** 隅柱はマスあたり4本 */
const MAX_POSTS = MAX_CELLS * POST_ROTS.length;

/** 提灯の見え方は「空室 / 空きあり / 満席」の3通りしかない */
const lanternStateOf = (room) =>
  room === null ? 0 : (room.playerCount >= room.capacity ? 2 : 1);
/** 障子から漏れる灯りも「空室 / 品定め中 / 遊んでいる」の3通り */
const paperStateOf = (room) => (room === null ? 0 : (room.playing ? 2 : 1));

/** 提灯の3通りの見た目。遠くからの空席サインなので、色と光り方をはっきり分ける */
const LANTERN_LOOK = [
  { color: 0x4a3a2c, emissive: 0x2a1c10, intensity: 0.5 },   // 空室
  { color: 0xf2b070, emissive: 0xff8828, intensity: 2.4 },   // 空きあり
  { color: 0x8a5a4a, emissive: 0x7a2018, intensity: 1.1 },   // 満席
];
/** 障子の光り方3通り。並びは paperStateOf に合わせる */
const PAPER_GLOW = [0.10, 0.30, 0.62];

/**
 * 廊下ビューを作る。
 *
 * @param {HTMLElement} container 描画先。ここに canvas を1枚足す
 * @param {object} [options]
 * @param {string} [options.modelUrl] 部品モデルの URL
 * @param {(code: string) => void} [options.onEnter] 扉を押したとき。卓コードを渡す
 * @param {(room: object|null) => void} [options.onFocus] 目の前の扉が変わったとき
 * @param {(state: "lost"|"restored") => void} [options.onContextChange]
 *   GPU 側の描画文脈が落ちた／戻ったとき。落ちている間は描画ループも止まるので、
 *   呼び出し側は「いま描けていない」ことを画面に出すために使う（黒いまま放置しない）
 * @param {Map<string, string>} [options.tagLabels] タグID → 表示名。木札の文字を
 *   HTML 側の目印へ移したのでこのビューでは読まないが、呼び出し側の書き方を
 *   壊さないよう受け取りだけ残してある
 * @returns {{ready: Promise<void>, setRooms: Function, step: Function, turn: Function,
 *            setInput: Function, setLookLimit: Function, visibleDoors: Function,
 *            pause: Function, resume: Function,
 *            focusedRoom: object|null, position: object, dispose: Function}}
 */
export function createCorridorView(container, options = {}) {
  const modelUrl = options.modelUrl ?? "/assets/3d/izakaya_corridor_kit.glb";
  const onEnter = options.onEnter ?? null;
  const onFocus = options.onFocus ?? null;
  const onContextChange = options.onContextChange ?? null;

  let rooms = [];
  let disposed = false;
  let loaded = false;
  let paused = false;
  let running = false;
  /** GPU 側の描画文脈が落ちている間は true。onContextLost / onContextRestored を参照 */
  let contextLost = false;
  let raf = 0;

  // ── 描画の土台 ────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  const el = renderer.domElement;
  el.style.display = "block";
  el.style.width = "100%";
  el.style.height = "100%";
  el.style.touchAction = "none";
  container.appendChild(el);

  const scene = new THREE.Scene();
  // 霧が無いと、実体を置くのをやめた先が黒く抜けて見える
  scene.background = new THREE.Color(0x0d0906);
  scene.fog = new THREE.FogExp2(0x0d0906, 0.10);

  const camera = new THREE.PerspectiveCamera(58, 1, 0.02, 60);
  scene.add(new THREE.AmbientLight(0xffd9a8, 0.22));

  // 灯りはカメラの居るマスとその四方に置く。曲がった先も同じ明るさになる。
  const lamps = Array.from({ length: 5 }, () => {
    const light = new THREE.PointLight(0xffc07a, 6.0, 8.0, 2.0);
    scene.add(light);
    return light;
  });

  // ── 位置と向き ────────────────────────────────────
  let px = 0;
  let pz = 0;
  let yaw = 0;        // 0 で北（-Z）を向く
  let pitch = 0;
  let speed = 0;      // キーと step() から入る撃力ぶんの前後速度
  let inForward = 0;  // setInput() で押されっぱなしになっている量（-1..1）
  let inStrafe = 0;
  let inTurn = 0;
  let focused = null;

  // ── まとめ描き（InstancedMesh） ────────────────────
  /** 空き枠に入れておく行列。大きさ0なので面が潰れて見えなくなる */
  const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
  /** 作ったまとめ描きの全部。解放に使う */
  const batches = [];

  /**
   * 部品の中身を「メッシュ1枚ずつ ＋ 部品の根から見た行列」に開く。
   * glTF は材質ごとにメッシュが分かれるので、ここで出てくる枚数がそのまま
   * InstancedMesh の本数＝ドローコール数になる。
   */
  function collectParts(root, subtree, into = []) {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    subtree.traverse((o) => {
      if (o.isMesh !== true) return;
      into.push({
        geometry: o.geometry,
        material: o.material,
        offset: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld),
      });
    });
    return into;
  }

  /**
   * 部品から隅柱の三角形を切り離す。柱1本ぶんの形と、柱を抜いた残りに分ける。
   *
   * 柱は床・天井・梁と1つのメッシュに結合されているので、名前や並び順では拾えない
   * （並び順は書き出すたびに変わり得る）。そこで POST_BOX（GLB から測った
   * 0.50 × 2.35 × 0.50 の角）に三角形が丸ごと入っているかどうかだけで選ぶ。
   * 梁は必ず箱の外へはみ出す頂点を持つので混ざらない。
   *
   * 見つからない・寸法が違うときは例外にする。GLB を差し替えたときに黙って壁へ穴が
   * 開くのが最悪なので、そこで止める。
   */
  function splitPost(parts) {
    const eps = 1e-3;
    const inside = (x, y, z) =>
      x >= POST_BOX.minX - eps && x <= POST_BOX.maxX + eps &&
      y >= POST_BOX.minY - eps && y <= POST_BOX.maxY + eps &&
      z >= POST_BOX.minZ - eps && z <= POST_BOX.maxZ + eps;

    const build = (px, nx) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(px, 3));
      if (nx.length === px.length) {
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(nx, 3));
      } else {
        geometry.computeVertexNormals();
      }
      return geometry;
    };

    for (const part of parts) {
      // 部品の根から見た形に直してから切る。以後この部品は行列を持たない。
      const src = part.geometry.clone().applyMatrix4(part.offset);
      const pos = src.attributes.position;
      const nor = src.attributes.normal;
      const index = src.index;
      const count = index === null ? pos.count : index.count;
      const at = (t) => (index === null ? t : index.getX(t));
      const inP = [], inN = [], outP = [], outN = [];
      for (let t = 0; t + 2 < count; t += 3) {
        const v = [at(t), at(t + 1), at(t + 2)];
        const hit = v.every((i) => inside(pos.getX(i), pos.getY(i), pos.getZ(i)));
        const px = hit ? inP : outP;
        const nx = hit ? inN : outN;
        for (const i of v) {
          px.push(pos.getX(i), pos.getY(i), pos.getZ(i));
          if (nor !== undefined) nx.push(nor.getX(i), nor.getY(i), nor.getZ(i));
        }
      }
      if (inP.length === 0) {
        src.dispose();
        continue;
      }

      const postGeometry = build(inP, inN);
      postGeometry.computeBoundingBox();
      const b = postGeometry.boundingBox;
      const size = new THREE.Vector3();
      b.getSize(size);
      const near = (a, want) => Math.abs(a - want) < 0.01;
      if (
        inP.length / 9 !== 12 ||
        !near(size.x, POST_W) || !near(size.z, POST_W) || !near(size.y, CORR_H) ||
        !near(b.min.x, POST_BOX.minX) || !near(b.max.z, POST_BOX.maxZ)
      ) {
        throw new Error(
          `隅柱の形が想定と違います（三角形 ${inP.length / 9} 枚 / ` +
          `${size.x.toFixed(3)}×${size.y.toFixed(3)}×${size.z.toFixed(3)}）。` +
          `GLB を差し替えたなら POST_BOX を測り直してください`,
        );
      }
      const material = part.material;
      part.geometry = build(outP, outN);      // 柱を抜いた残り（梁）
      part.offset = new THREE.Matrix4();
      src.dispose();
      return { geometry: postGeometry, material, offset: new THREE.Matrix4() };
    }
    throw new Error("モデルに隅柱が見つかりません（GLB を作り直してください）");
  }

  /**
   * 同じ形・同じ材質の部品をまとめて1回で描くための入れ物。
   *
   * 番号（インスタンス）を1つ配ると、その番号の枠が parts の枚数ぶん同時に埋まる。
   * マスをいくつ置いてもメッシュは増えないので、ドローコールは「部品の種類数」で
   * 頭打ちになる。マスごとに Mesh を作っていた頃は、置く物の数がそのまま効いて
   * 平均 719 枚・最大 944 枚（扉 78 枚の地点）だった。いまは 22 本で動かない。
   *
   * @param {Array} parts collectParts の戻り
   * @param {number} capacity 同時に置ける最大数。VIEW_R から決まる上限を渡す
   */
  function createBatch(parts, capacity) {
    const meshes = parts.map((p) => {
      const mesh = new THREE.InstancedMesh(p.geometry, p.material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // InstancedMesh は中身がどこに散っていても「1つの物体」として視錐台に掛かる。
      // 廊下は必ずカメラを取り囲む形に置かれ、塊ごと画面から外れることが無いので、
      // 判定しても常に「描く」に倒れて無駄。しかも外れたと判定された日には
      // 廊下が丸ごと消えるので、判定自体を切っておくほうが安全でもある。
      mesh.frustumCulled = false;
      mesh.count = 0;
      scene.add(mesh);
      return mesh;
    });
    const freed = [];
    let next = 0;
    const work = new THREE.Matrix4();
    const batch = {
      meshes,
      /** 置き場所を渡して番号を貰う。空きが無ければ -1（VIEW_R から溢れない限り起きない） */
      alloc(matrix) {
        const id = freed.length > 0 ? freed.pop() : (next < capacity ? next++ : -1);
        if (id < 0) return -1;
        for (let i = 0; i < meshes.length; i++) {
          work.multiplyMatrices(matrix, parts[i].offset);
          meshes[i].setMatrixAt(id, work);
          meshes[i].count = next;               // 一度も配っていない後ろの枠は描かせない
          meshes[i].instanceMatrix.needsUpdate = true;
        }
        return id;
      },
      /** 番号を返す。空いた枠は大きさ0の行列で潰しておく */
      free(id) {
        if (id < 0) return;
        for (const mesh of meshes) {
          mesh.setMatrixAt(id, HIDDEN);
          mesh.instanceMatrix.needsUpdate = true;
        }
        freed.push(id);
      },
    };
    batches.push(batch);
    return batch;
  }

  /** 部品の種類ごとのまとめ描き。読み込みが終わるまでは空 */
  const kit = {
    core: null, post: null, wall: null, pendant: null, door: null, hit: null,
    lantern: [], paper: [],
  };
  /** 木札の板の中心。扉の根から見た位置。HTML の目印を置く的にする */
  const signLocal = new THREE.Vector3();
  /** 当たり板の番号 → 扉。押された枠から扉を引くため */
  const doorById = [];
  const tiles = new Map();     // "x,z" → { x, z, parts: [], doors: [] }

  /**
   * GLB から部品を取り出して、まとめ描きを組み立てる。
   *
   * 扉のうち「卓によって見え方が変わる」のは提灯と障子だけで、しかも3通りしかない。
   * そこで材質を3つ作って共有し、扉はそのどれかの組に入る形にした。
   * 扉ごとに material.clone() すると材質が全部別物になり、まとめ描きができなくなる。
   */
  function buildKit(gltf) {
    const proto = {};
    for (const name of ["Kit_Core", "Kit_Wall", "Kit_Door", "Kit_Pendant"]) {
      const found = gltf.scene.getObjectByName(name);
      if (found === undefined) {
        throw new Error(`モデルに ${name} がありません（GLB を作り直してください）`);
      }
      found.removeFromParent();
      proto[name.replace("Kit_", "").toLowerCase()] = found;
    }
    const doorRoot = proto.door;
    const named = (name) => {
      const found = doorRoot.getObjectByName(name);
      if (found === undefined) {
        throw new Error(`モデルに ${name} がありません（GLB を作り直してください）`);
      }
      return found;
    };
    const signObj = named("Door_Sign");
    const lanternObj = named("Door_Lantern");
    const paperObj = named("Door_Paper");
    const hitObj = named("Door_Hit");

    // 扉の「どの卓でも同じ」部分。木札の板もここに入れる（文字は HTML 側で出す）。
    const doorParts = [];
    for (const child of doorRoot.children) {
      if (child === lanternObj || child === paperObj || child === hitObj) continue;
      collectParts(doorRoot, child, doorParts);
    }
    // 当たり板は最後に足して、その1枚だけ透明な材質に差し替える
    const hitIndex = doorParts.length;
    collectParts(doorRoot, hitObj, doorParts);
    doorParts[hitIndex].material = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false,
    });

    const coreParts = collectParts(proto.core, proto.core);
    // 隅柱を切り離して、四隅ぶん置き直せるようにする（POST_BOX のコメント参照）
    kit.post = createBatch([splitPost(coreParts)], MAX_POSTS);
    kit.core = createBatch(coreParts, MAX_CELLS);
    kit.pendant = createBatch(collectParts(proto.pendant, proto.pendant), MAX_CELLS);
    kit.wall = createBatch(collectParts(proto.wall, proto.wall), MAX_EDGES);
    kit.door = createBatch(doorParts, MAX_EDGES);
    kit.hit = kit.door.meshes[hitIndex];

    kit.lantern = LANTERN_LOOK.map((look) => {
      const parts = collectParts(doorRoot, lanternObj);
      for (const p of parts) {
        const material = p.material.clone();
        material.color.setHex(look.color);
        material.emissive.setHex(look.emissive);
        material.emissiveIntensity = look.intensity;
        p.material = material;
      }
      return createBatch(parts, MAX_EDGES);
    });
    kit.paper = PAPER_GLOW.map((intensity) => {
      const parts = collectParts(doorRoot, paperObj);
      for (const p of parts) {
        const material = p.material.clone();
        material.color.setHex(0x9c8b73);   // 素のままだと明るすぎて紙が白飛びする
        material.emissiveIntensity = intensity;
        p.material = material;
      }
      return createBatch(parts, MAX_EDGES);
    });

    doorRoot.updateMatrixWorld(true);
    signLocal.setFromMatrixPosition(
      new THREE.Matrix4().copy(doorRoot.matrixWorld).invert().multiply(signObj.matrixWorld),
    );
  }

  /** 扉に卓を割り当てて、提灯と障子の灯りを差し替える */
  function bindDoor(slot, room) {
    slot.room = room;
    const lantern = lanternStateOf(room);
    if (lantern !== slot.lanternState) {
      if (slot.lanternState >= 0) kit.lantern[slot.lanternState].free(slot.lanternId);
      slot.lanternId = kit.lantern[lantern].alloc(slot.matrix);
      slot.lanternState = lantern;
    }
    const paper = paperStateOf(room);
    if (paper !== slot.paperState) {
      if (slot.paperState >= 0) kit.paper[slot.paperState].free(slot.paperId);
      slot.paperId = kit.paper[paper].alloc(slot.matrix);
      slot.paperState = paper;
    }
  }

  /** マス1つ分を組む。開いている辺には何も置かない＝そこが通路になる */
  function buildTile(x, z) {
    const parts = [];
    const doors = [];
    const base = new THREE.Matrix4().makeTranslation(x * CELL, 0, z * CELL);
    parts.push({ batch: kit.core, id: kit.core.alloc(base) });
    // 隅柱は四隅ぶん置く。Kit_Core は +X / -Z の1本しか持っておらず、
    // そのままだとマスの境目ごとに 0.5m 幅・天井までの縦穴が開く。
    for (const rot of POST_ROTS) {
      const m = new THREE.Matrix4().makeRotationY(rot).setPosition(x * CELL, 0, z * CELL);
      parts.push({ batch: kit.post, id: kit.post.alloc(m) });
    }

    if (hash01(x, z, 5) < P_LIGHT) {
      parts.push({ batch: kit.pendant, id: kit.pendant.alloc(base) });
    }

    DIRS.forEach((d, i) => {
      if (edgeOpen(x, z, d.key)) return;
      const matrix = new THREE.Matrix4().makeRotationY(d.rot).setPosition(x * CELL, 0, z * CELL);
      if (hasDoor(x, z, i)) {
        const instanceId = kit.door.alloc(matrix);
        const slot = {
          // まとめ描きの枠番号。空きが出れば別の扉に配り直されるので、外へは出さない
          instanceId,
          // 扉そのものを指す値。マスの座標と辺の番号だけで決まるので、視点にも
          // 並び順にも枠の配り直しにも影響されない。visibleDoors() が返す id はこれ。
          id: `${x},${z},${i}`,
          x, z, dir: d, matrix,
          anchor: signLocal.clone().applyMatrix4(matrix),
          room: null, lanternState: -1, lanternId: -1, paperState: -1, paperId: -1,
        };
        if (instanceId >= 0) doorById[instanceId] = slot;
        bindDoor(slot, roomAt(x, z, i, rooms));
        parts.push({ batch: kit.door, id: instanceId });
        doors.push(slot);
      } else {
        parts.push({ batch: kit.wall, id: kit.wall.alloc(matrix) });
      }
    });
    return { x, z, parts, doors };
  }

  function dropTile(tile) {
    for (const slot of tile.doors) {
      if (slot.lanternState >= 0) kit.lantern[slot.lanternState].free(slot.lanternId);
      if (slot.paperState >= 0) kit.paper[slot.paperState].free(slot.paperId);
      if (slot.instanceId >= 0) doorById[slot.instanceId] = null;
    }
    for (const p of tile.parts) p.batch.free(p.id);
  }

  /** カメラの周りだけ実体を持つ。離れたマスは枠ごと空きに戻す */
  function streamTiles() {
    const cx = Math.round(px / CELL);
    const cz = Math.round(pz / CELL);
    for (const [key, tile] of tiles) {
      if (Math.abs(tile.x - cx) > VIEW_R || Math.abs(tile.z - cz) > VIEW_R) {
        dropTile(tile);
        tiles.delete(key);
      }
    }
    for (let dz = -VIEW_R; dz <= VIEW_R; dz++) {
      for (let dx = -VIEW_R; dx <= VIEW_R; dx++) {
        const x = cx + dx;
        const z = cz + dz;
        if (!cellUsed(x, z)) continue;
        const key = `${x},${z}`;
        if (!tiles.has(key)) tiles.set(key, buildTile(x, z));
      }
    }
  }

  /** 置き直さずに、いま出ているぶんの卓だけ振り直す */
  function rebindAll() {
    for (const tile of tiles.values()) {
      DIRS.forEach((d, i) => {
        if (edgeOpen(tile.x, tile.z, d.key) || !hasDoor(tile.x, tile.z, i)) return;
        const slot = tile.doors.find((s) => s.dir === d);
        if (slot !== undefined) bindDoor(slot, roomAt(tile.x, tile.z, i, rooms));
      });
    }
  }

  // ── 歩く ─────────────────────────────────────────
  /**
   * 壁で止める。マスの中央 2m 四方はいつでも歩けて、そこから外へ出られるのは
   * 辺が開いている向きだけ。開いている向きへ出るときは、通路の幅から
   * はみ出さないよう横方向を締める（角を斜めに突っ切らせない）。
   */
  function collide() {
    const cx = Math.round(px / CELL);
    const cz = Math.round(pz / CELL);
    let dx = px - cx * CELL;
    let dz = pz - cz * CELL;
    if (dx > LIMIT) {
      if (edgeOpen(cx, cz, "E")) dz = clamp(dz, -LIMIT, LIMIT);
      else dx = LIMIT;
    } else if (dx < -LIMIT) {
      if (edgeOpen(cx, cz, "W")) dz = clamp(dz, -LIMIT, LIMIT);
      else dx = -LIMIT;
    }
    if (dz > LIMIT) {
      if (edgeOpen(cx, cz, "S")) dx = clamp(dx, -LIMIT, LIMIT);
      else dz = LIMIT;
    } else if (dz < -LIMIT) {
      if (edgeOpen(cx, cz, "N")) dx = clamp(dx, -LIMIT, LIMIT);
      else dz = -LIMIT;
    }
    px = cx * CELL + dx;
    pz = cz * CELL + dz;
  }

  /** 通れる辺が2つ以上あるマスから始める。行き止まりに閉じ込めないため */
  function findStart() {
    for (let r = 0; r <= 6; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const open = DIRS.filter((d) => edgeOpen(dx, dz, d.key));
          if (open.length >= 2) {
            px = dx * CELL;
            pz = dz * CELL;
            yaw = Math.atan2(-open[0].dx, -open[0].dz);   // 通れる向きへ体を向ける
            return;
          }
        }
      }
    }
  }

  /**
   * 目の前の卓。扉は左右にあるので、視線ではなく距離で選ぶほうが歩き方に合う。
   * 3.4m は「自分のマスの扉（1.0m）と、隣のマスの側面の扉（約3.2m）まで」の範囲。
   * ここを詰めると、通路の途中で誰も選ばれない時間ができる。
   */
  function updateFocus() {
    let best = 3.4;
    let room = null;
    for (const tile of tiles.values()) {
      for (const slot of tile.doors) {
        const wx = slot.x * CELL + slot.dir.dx * HALF_W;
        const wz = slot.z * CELL + slot.dir.dz * HALF_W;
        const d = Math.hypot(wx - px, wz - pz);
        if (d < best) {
          best = d;
          room = slot.room;
        }
      }
    }
    if (room === focused) return;
    focused = room;
    if (onFocus !== null) onFocus(room);
  }

  /**
   * 目から扉の板まで、塞がった辺を跨がずに届くか。
   *
   * 壁の向こうにある扉まで目印を出すと、何も無い壁に札が浮いて出る。距離で切っても
   * 曲がった先の扉は落ちないので、辺の開閉そのものを見る。マスの境目だけを順に踏む
   * 走査なので、跨ぐ辺は VIEW_R ぶんの数枚で済む。
   */
  function hasLineOfSight(ax, az, bx, bz) {
    let cx = Math.round(ax / CELL);
    let cz = Math.round(az / CELL);
    const ex = Math.round(bx / CELL);
    const ez = Math.round(bz / CELL);
    const dx = bx - ax;
    const dz = bz - az;
    const sx = dx > 0 ? 1 : -1;
    const sz = dz > 0 ? 1 : -1;
    // t は線分を 0..1 で測った位置。次にどちらの境目へ先に着くかで進む向きを決める。
    let tx = dx === 0 ? Infinity : (((cx + sx * 0.5) * CELL) - ax) / dx;
    let tz = dz === 0 ? Infinity : (((cz + sz * 0.5) * CELL) - az) / dz;
    const stepX = dx === 0 ? Infinity : CELL / Math.abs(dx);
    const stepZ = dz === 0 ? Infinity : CELL / Math.abs(dz);
    for (let guard = 0; guard < 32 && (cx !== ex || cz !== ez); guard++) {
      if (tx > 1 && tz > 1) return false;      // 扉のマスへ着く前に線分が尽きた
      if (tx < tz) {
        if (!edgeOpen(cx, cz, sx > 0 ? "E" : "W")) return false;
        cx += sx;
        tx += stepX;
      } else {
        if (!edgeOpen(cx, cz, sz > 0 ? "S" : "N")) return false;
        cz += sz;
        tz += stepZ;
      }
    }
    return cx === ex && cz === ez;
  }

  // ── 読み込み ─────────────────────────────────────
  const ready = new Promise((resolve, reject) => {
    new GLTFLoader().load(modelUrl, (gltf) => {
      if (disposed) return;
      try {
        buildKit(gltf);
        loaded = true;
        findStart();
        streamTiles();
        resize();
        start();
        resolve();
      } catch (err) {
        reject(err);
      }
    }, undefined, () => reject(new Error(`廊下のモデルを読み込めませんでした: ${modelUrl}`)));
  });

  // ── 操作 ─────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const keys = new Set();
  // 見回しは1本目の指だけに任せる。真偽値1つで持つと、canvas に2本目の指が乗った瞬間に
  // 両方の pointermove が同じ yaw を動かして倍速になる（スティックを持つ手が滑ると起きる）。
  let dragPointer = null;
  let dragMoved = 0;
  let lastX = 0;
  let lastY = 0;
  /** 見上げ・見下ろしの上限（rad）。酔うようなら setLookLimit() で浅くできる */
  let lookLimit = 0.9;

  /** イベントの位置を正規化デバイス座標へ。タップは pointermove を伴わない */
  function ndcFromEvent(ev) {
    const rect = el.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    return ndc;
  }

  function onPointerDown(ev) {
    if (dragPointer !== null) return;   // 2本目以降の指は見回しに参加させない
    dragPointer = ev.pointerId;
    dragMoved = 0;
    lastX = ev.clientX;
    lastY = ev.clientY;
    el.setPointerCapture(ev.pointerId);
  }

  function onPointerMove(ev) {
    if (ev.pointerId !== dragPointer) return;
    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    yaw -= dx * 0.005;
    pitch = clamp(pitch - dy * 0.005, -lookLimit, lookLimit);
  }

  function onPointerUp(ev) {
    if (ev.pointerId !== dragPointer) return;
    dragPointer = null;
    try { el.releasePointerCapture(ev.pointerId); } catch { /* 解放済み */ }
    if (dragMoved > 8) return;   // 振り回していたら見回しとみなす
    if (kit.hit === null) return;
    // 当たり板は全部の扉ぶんが1つの InstancedMesh に入っている。空き枠は大きさ0に
    // 潰してあるので当たらない。当たった枠の番号から扉を引く。
    // 枠を配り直すたびに中身が動くので、当たり判定用の球はここで作り直す。
    kit.hit.computeBoundingSphere();
    raycaster.setFromCamera(ndcFromEvent(ev), camera);
    // 当たり板だけを見ているので、壁は光線を止めてくれない。手前から順に見て、
    // 視線が通る最初の扉を採る。そうしないと壁の向こうの卓に入れてしまう。
    for (const hit of raycaster.intersectObject(kit.hit, false)) {
      const slot = doorById[hit.instanceId];
      if (slot === undefined || slot === null || slot.room === null) continue;
      if (!hasLineOfSight(px, pz, slot.anchor.x, slot.anchor.z)) continue;
      if (onEnter !== null) onEnter(slot.room.code);
      return;
    }
  }

  function onWheel(ev) {
    ev.preventDefault();
    speed += (ev.deltaY > 0 ? -1 : 1) * 0.8;
  }

  function onKeyDown(ev) {
    if (ev.key === "Enter" && focused !== null && onEnter !== null) {
      onEnter(focused.code);
      return;
    }
    keys.add(ev.key);
  }
  const onKeyUp = (ev) => keys.delete(ev.key);

  /**
   * 押されているキーの記録を空にする。
   *
   * 押下は keydown で覚えて keyup で消しているが、**キーを押したまま canvas から
   * フォーカスが外れると keyup が二度と届かない**（Alt+Tab で窓ごと後ろへ回る、
   * 画面のボタンを押して焦点が移る、など）。記録だけが残るので、戻ってこないかぎり
   * 歩き続けて止まらない。焦点を失った時点で必ず空にする。
   */
  function releaseKeys() {
    keys.clear();
  }

  // ── 毎フレーム ───────────────────────────────────
  const clock = new THREE.Clock();

  /**
   * rAF を回し始める。pause() 中・読み込み前・文脈が落ちている間は何もしない。
   * 描画をフラグで飛ばすだけだと rAF は回り続けてしまい、電池を食うのは変わらない。
   */
  function start() {
    if (running || paused || disposed || contextLost || !loaded) return;
    running = true;
    clock.getDelta();          // 止まっていた間の時間を捨てる。再開で一気に飛ばないように
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  /**
   * GPU 側の描画文脈が落ちたとき。
   *
   * GPU ドライバの再起動・タブの長時間放置・他アプリの負荷などで実際に起きる。
   * 何も手当てしないと、**描く物が消えた真っ黒な canvas の上で rAF だけが回り続ける**。
   * 電池と CPU を食う一方で、利用者からは「固まった」ようにしか見えない。
   *
   * 既定動作を止めるのは必須。止めないと webglcontextrestored が来ない＝復帰できない。
   * three.js の WebGLRenderer も自前で同じことをしているが、こちらの登録順に依存しない
   * よう自分でも止めておく（preventDefault は何度呼んでも害が無い）。
   */
  function onContextLost(ev) {
    ev.preventDefault();
    if (contextLost) return;      // 二重に来ても片付けは1回だけ
    contextLost = true;
    releaseKeys();                // 止まっている間の押下を持ち越さない
    stop();
    if (onContextChange !== null) onContextChange("lost");
  }

  /**
   * 文脈が戻ったとき。復帰させる方針を採っている。
   *
   * three.js 側は WebGLRenderer が自分で内部の状態を作り直す（形も材質もこちらが
   * 持ったままなので、次に描くときに載せ直される）。こちらは大きさを入れ直して
   * 回し始めるだけでよい。pause() 中に戻ってきたときは start() が自分で断るので、
   * ここで paused を見る必要は無い。
   */
  function onContextRestored() {
    if (!contextLost) return;     // 落ちていないのに来たら何もしない
    contextLost = false;
    resize();
    start();
    if (onContextChange !== null) onContextChange("restored");
  }

  function loop() {
    if (disposed || !running) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.1);

    if (keys.has("w") || keys.has("W") || keys.has("ArrowUp")) speed += 12 * dt;
    if (keys.has("s") || keys.has("S") || keys.has("ArrowDown")) speed -= 12 * dt;
    if (keys.has("a") || keys.has("A") || keys.has("ArrowLeft")) yaw += 1.8 * dt;
    if (keys.has("d") || keys.has("D") || keys.has("ArrowRight")) yaw -= 1.8 * dt;
    yaw += inTurn * TURN_RATE * dt;

    speed = clamp(speed, -MAX_SPEED, MAX_SPEED);
    // yaw = 0 で -Z（北）を向く。three.js のカメラの既定の向きに合わせてある。
    // 右手は前を -90° 回した向きなので (cos yaw, -sin yaw)。
    // キーの撃力（speed）と押しっぱなしの入力（inForward）は足し合わせる。
    const forward = speed + inForward * MAX_SPEED;
    const strafe = inStrafe * MAX_SPEED;
    let vx = -Math.sin(yaw) * forward + Math.cos(yaw) * strafe;
    let vz = -Math.cos(yaw) * forward - Math.sin(yaw) * strafe;
    // 合成すると上限を超えうる。速すぎると1フレームの移動が LIMIT を跨いで壁を抜けるので、
    // 向きは保ったまま長さだけ詰める。
    const v = Math.hypot(vx, vz);
    if (v > MAX_SPEED) {
      vx *= MAX_SPEED / v;
      vz *= MAX_SPEED / v;
    }
    px += vx * dt;
    pz += vz * dt;
    speed *= Math.pow(0.0025, dt);   // 指数減衰。フレームレートに依らず同じ効き方になる
    if (Math.abs(speed) < 0.001) speed = 0;

    collide();
    camera.position.set(px, EYE, pz);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(yaw);
    camera.rotateX(pitch);

    const cx = Math.round(px / CELL);
    const cz = Math.round(pz / CELL);
    lamps[0].position.set(cx * CELL, 1.85, cz * CELL);
    DIRS.forEach((d, i) => {
      lamps[i + 1].position.set((cx + d.dx) * CELL, 1.85, (cz + d.dz) * CELL);
    });

    streamTiles();
    updateFocus();
    renderer.render(scene, camera);
  }

  // ── 寸法合わせ ───────────────────────────────────
  function resize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerUp);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.tabIndex = 0;   // キー操作を受けるためにフォーカスできるようにする
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("keyup", onKeyUp);
  // 焦点が canvas から外れたとき（ページ内の別の物を押した等）
  el.addEventListener("blur", releaseKeys);
  // 窓ごと後ろへ回ったとき（Alt+Tab・別アプリ・最小化）。この経路で要素の blur まで
  // 飛ぶかはブラウザ任せなので、要素側だけに頼らず窓でも受ける。
  // やることは記録を空にするだけなので、両方から来ても害は無い
  globalThis.addEventListener("blur", releaseKeys);
  el.addEventListener("webglcontextlost", onContextLost);
  el.addEventListener("webglcontextrestored", onContextRestored);

  // ── 外向きの API ─────────────────────────────────
  /** visibleDoors() の作業用。毎フレーム呼ばれるので使い回す */
  const probe = new THREE.Vector3();

  return {
    ready,

    /** 一覧を差し替える。ポーリングのたびに呼んでよい */
    setRooms(next) {
      rooms = Array.isArray(next) ? next : [];
      rebindAll();
      focused = undefined;   // 同じ扉でも中身が変わっているので通知し直す
      updateFocus();
    },

    /** 前後に歩く（+1 で前、-1 で後ろ）。画面上のボタンから呼ぶ用の撃力 */
    step(direction = 1) {
      speed += direction * 2.0;
    },

    /** その場で向きを変える（+1 で左、-1 で右）。こちらも1回ぶんの撃力 */
    turn(direction = 1) {
      yaw += direction * 0.45;
    },

    /**
     * 押されている間の連続入力。毎フレーム呼ばれる前提で、次に呼ばれるまで保持される。
     * step() / turn() は1回ぶんの撃力なので、毎フレーム叩くと speed の指数減衰と
     * 噛み合ってガタつく。押しっぱなしの操作はこちらを使う。
     *
     * 加速の慣らしは呼び出し側の担当。ここでは受け取った値をそのまま速度に写す。
     * キーボード入力とは足し合わせるので、PC の操作と同時に効く。
     *
     * @param {{forward?: number, strafe?: number, turn?: number}} input
     *   forward: -1..1（+1 前進 / -1 後退）
     *   strafe:  -1..1（+1 右へ平行移動 / -1 左へ）
     *   turn:    -1..1（+1 左旋回 / -1 右旋回。turn() と同符号）
     *   省略した項目は 0 扱い。setInput({}) で全解除。
     */
    setInput(input) {
      const axis = (v) => (Number.isFinite(v) ? clamp(v, -1, 1) : 0);
      inForward = axis(input?.forward);
      inStrafe = axis(input?.strafe);
      inTurn = axis(input?.turn);
    },

    /**
     * 見上げ・見下ろしの上限（rad）を決める。既定は 0.9（≒52°）。
     * 実機で酔うようなら浅くできるよう、外から触れるようにしてある。
     * 0 から 1.5rad（≒86°）の間に収める。真上を向けると天井しか映らないため。
     */
    setLookLimit(rad) {
      if (!Number.isFinite(rad)) return;
      lookLimit = clamp(rad, 0, 1.5);
      pitch = clamp(pitch, -lookLimit, lookLimit);
    },

    /**
     * いま画面に出す価値のある扉の一覧。HTML の目印を重ねるために使う。
     * 毎フレーム呼ばれる前提なので、置いてあるマスの扉を舐めるだけにしてある。
     *
     * 壁の向こうの扉は返さない（返すと、何も無い壁に札が浮いて出る）。
     * 置いてあるのは 7×7 マスぶんで扉は 50 枚前後あるが、視線が通るのは平均 8.5 枚。
     * 判定は辺の開閉を辿るだけなので、1フレームぶんで数百回のハッシュに収まる。
     *
     * 3D の点を画面座標へ移すとき、カメラの後ろにある点は符号が反転する
     * （投影行列を掛けたあと w で割るが、後方では w < 0 になるため左右・上下が裏返る）。
     * そこで前後と方位角は「投影する前」のカメラ空間で決めてから投影する。
     * ここを投影後の値でやると、後ろの卓の矢印が画面の逆側に出る。
     *
     * @returns {Array<{id: string, code: string, room: object, x: number, y: number,
     *                  distance: number, bearing: number,
     *                  onScreen: boolean, behind: boolean}>}
     *   x, y は container の左上を原点とする px。behind が true のときの x, y は
     *   上記の反転を受けた値なので、向きには使わず bearing を見ること。
     *
     *   id は扉そのものを指す。マスの座標と辺の番号だけから決まるので、視点を振っても
     *   歩いて戻っても、同じ扉なら必ず同じ値になる。**表示の状態を覚えておく鍵には
     *   code ではなく id を使うこと。**卓は扉より少なく、同じ卓を複数の扉が受け持つので、
     *   code だけでは扉を見分けられない。「code ＋ 近い順」で代用すると、視点を振って
     *   見える扉の集合が変わったときに順位がずれ、同じ扉が二重に出たり消えたりする。
     */
    visibleDoors() {
      const out = [];
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      for (const tile of tiles.values()) {
        for (const slot of tile.doors) {
          if (slot.room === null) continue;
          // 壁越しの扉は「出す価値のある扉」ではないので落とす
          if (!hasLineOfSight(px, pz, slot.anchor.x, slot.anchor.z)) continue;
          probe.copy(slot.anchor).applyMatrix4(camera.matrixWorldInverse);
          // カメラ空間では前方が -Z。z が 0 以上なら後方。
          const behind = probe.z >= 0;
          const inFront = probe.z < -camera.near;
          const distance = probe.length();
          // 方位角は正面が 0 で左が +。カメラ空間の左は -X 側なので -x を渡す。
          const bearing = Math.atan2(-probe.x, -probe.z);
          probe.applyMatrix4(camera.projectionMatrix);   // ここで w 除算が入る
          const x = (probe.x * 0.5 + 0.5) * w;
          const y = (-probe.y * 0.5 + 0.5) * h;
          out.push({
            id: slot.id,
            code: slot.room.code,
            room: slot.room,
            x,
            y,
            distance,
            bearing,
            onScreen: inFront && x >= 0 && x <= w && y >= 0 && y <= h,
            behind,
          });
        }
      }
      out.sort((a, b) => a.distance - b.distance);
      return out;
    },

    /**
     * 描画を止める。VC に入るときなど、見えていない間の電池を守るため。
     * dispose() と違って壊さないので resume() で戻れる。
     */
    pause() {
      if (paused || disposed) return;
      paused = true;
      stop();
      // 止めている間の押下は持ち越さない。resume() した瞬間に勝手に歩き出さないため
      releaseKeys();
    },

    /** 止めた描画を再開する。止めていなければ何もしない */
    resume() {
      if (!paused || disposed) return;
      paused = false;
      start();
    },

    /** いま目の前にある卓 */
    get focusedRoom() {
      return focused ?? null;
    },

    /** 廊下のどこに居るか。表示位置を覚えておきたいとき用 */
    get position() {
      return { x: px, z: pz, yaw };
    },
    set position(p) {
      if (p === null || typeof p !== "object") return;
      if (Number.isFinite(p.x)) px = p.x;
      if (Number.isFinite(p.z)) pz = p.z;
      if (Number.isFinite(p.yaw)) yaw = p.yaw;
      speed = 0;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      ro.disconnect();
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("keyup", onKeyUp);
      el.removeEventListener("blur", releaseKeys);
      globalThis.removeEventListener("blur", releaseKeys);
      el.removeEventListener("webglcontextlost", onContextLost);
      el.removeEventListener("webglcontextrestored", onContextRestored);
      // 形と材質はまとめ描きの間で共有している（提灯の3状態は同じ形を使う等）ので、
      // 一度集めてから重複なく捨てる。
      const geometries = new Set();
      const materials = new Set();
      for (const batch of batches) {
        for (const mesh of batch.meshes) {
          geometries.add(mesh.geometry);
          for (const m of [].concat(mesh.material)) materials.add(m);
          mesh.dispose();        // インスタンス用のバッファ
          scene.remove(mesh);
        }
      }
      batches.length = 0;
      tiles.clear();
      doorById.length = 0;
      for (const g of geometries) g.dispose();
      for (const m of materials) {
        m?.map?.dispose();
        m?.emissiveMap?.dispose();
        m?.dispose();
      }
      renderer.dispose();
      el.remove();
    },
  };
}

// 既存ページは classic script（app.js / rooms.js）なので、module から窓口を渡しておく。
globalThis.CorridorView = { create: createCorridorView, CELL };
