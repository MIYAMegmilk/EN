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
 * プールに戻して使い回すので、歩いた距離に関係なく物の数は一定になる。
 *
 * ■ 扉
 * 塞がった辺には扉が付く（一部は扉なしの壁にして単調さを避ける）。
 * どの扉がどの卓を受け持つかも座標のハッシュで決まる。卓の数より扉のほうが
 * 多いので、歩き続ければ同じ卓に何度も出会う。
 *
 * 扉ごとの情報は木札（Door_Sign）に canvas を貼って描く。DOM ではないので
 * innerHTML の経路は無く、サーバー由来の文字列は fillText にそのまま渡している。
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

/** 体の太さ。壁にめり込まないよう、この分だけ手前で止める */
const BODY_R = 0.35;
const LIMIT = HALF_W - BODY_R;

/** 木札に貼る canvas。板（0.38 × 0.52）の縦横比に合わせる */
const SIGN_W = 440;
const SIGN_H = 602;

/** 配色は en.css のトークンに合わせる（CSS 変数は canvas から読めないので写す） */
const COLOR = {
  paper: "#f6ecdc",
  ink: "#2a1a06",
  wood: "#3d2c1c",
  muted: "#7b6750",
  gold: "#c8862a",
  red: "#8c1f1a",
  green: "#4d6b31",
};

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

/** 塞がった辺に扉を出すか */
function hasDoor(x, z, i) {
  return hash01(x * 4 + i, z, 3) < P_DOOR;
}

/** その扉が受け持つ卓 */
function roomAt(x, z, i, rooms) {
  if (rooms.length === 0) return null;
  return rooms[Math.floor(hash01(x * 4 + i, z * 3 + i, 4) * rooms.length) % rooms.length];
}

/** epoch ms を HH:MM に。rooms.js と同じ書式 */
function formatTime(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 幅に収まるところで折り返して、最大 maxLines 行で切る */
function wrapText(ctx, text, maxWidth, maxLines) {
  const lines = [];
  let line = "";
  for (const ch of String(text)) {
    const next = line + ch;
    if (ctx.measureText(next).width > maxWidth && line !== "") {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line !== "") lines.push(line);
  return lines;
}

/**
 * 木札1枚を描く。room が null なら「空室」の面にする。
 * 呼ばれるのは扉を別の卓に振り直した瞬間だけなので、毎フレームの負荷にはならない。
 */
function drawSign(canvas, room, tagLabels) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#fbf3e6");
  bg.addColorStop(0.5, COLOR.paper);
  bg.addColorStop(1, "#e8dbc4");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(61, 44, 28, 0.35)";
  ctx.lineWidth = 7;
  ctx.strokeRect(4, 4, W - 8, H - 8);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (room === null) {
    ctx.fillStyle = COLOR.muted;
    ctx.font = `86px "Yu Mincho", "Hiragino Mincho ProN", serif`;
    ctx.fillText("空室", W / 2, H / 2 - 24);
    ctx.font = `32px "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif`;
    ctx.fillText("準備中", W / 2, H / 2 + 58);
    return;
  }

  const full = room.playerCount >= room.capacity;

  // 卓コード。遠目にはこれが一番効く
  ctx.fillStyle = COLOR.wood;
  ctx.fillRect(28, 30, W - 56, 72);
  ctx.fillStyle = COLOR.paper;
  ctx.font = `bold 46px "Yu Gothic", "Hiragino Kaku Gothic ProN", monospace`;
  ctx.fillText(String(room.code ?? ""), W / 2, 67);

  // 卓名。長ければ 2 行で折り返す
  ctx.fillStyle = COLOR.ink;
  ctx.font = `50px "Yu Mincho", "Hiragino Mincho ProN", serif`;
  wrapText(ctx, room.roomName ?? "", W - 70, 2)
    .forEach((line, i) => ctx.fillText(line, W / 2, 152 + i * 60));

  ctx.strokeStyle = "rgba(61, 44, 28, 0.25)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(46, 282);
  ctx.lineTo(W - 46, 282);
  ctx.stroke();

  // 何をしているか
  ctx.fillStyle = COLOR.muted;
  ctx.font = `30px "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif`;
  const doing = room.gameTitle === undefined
    ? (room.playing ? "遊んでいます" : "品定め中")
    : `${room.gameTitle}${room.playing ? " で" : " を"}`;
  wrapText(ctx, doing, W - 70, 1).forEach((l) => ctx.fillText(l, W / 2, 322));

  // 好みのタグ。1つだけ拾って添える
  const tagId = Array.isArray(room.tags) ? room.tags[0] : undefined;
  if (tagId !== undefined) {
    const label = tagLabels?.get(tagId) ?? tagId;
    ctx.font = `25px "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif`;
    const w = ctx.measureText(label).width + 32;
    ctx.fillStyle = "rgba(200, 134, 42, 0.18)";
    ctx.fillRect((W - w) / 2, 350, w, 40);
    ctx.fillStyle = COLOR.gold;
    ctx.fillText(label, W / 2, 370);
  }

  // 人数
  ctx.fillStyle = COLOR.ink;
  ctx.font = `bold 54px "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif`;
  ctx.fillText(`${room.playerCount} / ${room.capacity}`, W / 2, 446);
  ctx.font = `25px "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif`;
  ctx.fillStyle = COLOR.muted;
  ctx.fillText("名", W / 2 + 92, 456);

  // 空席の札
  ctx.fillStyle = full ? COLOR.red : COLOR.green;
  ctx.fillRect(68, 492, W - 136, 50);
  ctx.fillStyle = COLOR.paper;
  ctx.font = `30px "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif`;
  ctx.fillText(full ? "満席" : "空きあり", W / 2, 517);

  ctx.fillStyle = COLOR.muted;
  ctx.font = `23px "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif`;
  ctx.fillText(`${formatTime(room.createdAt)} から`, W / 2, 570);
}


/**
 * 廊下ビューを作る。
 *
 * @param {HTMLElement} container 描画先。ここに canvas を1枚足す
 * @param {object} [options]
 * @param {string} [options.modelUrl] 部品モデルの URL
 * @param {(code: string) => void} [options.onEnter] 扉を押したとき。卓コードを渡す
 * @param {(room: object|null) => void} [options.onFocus] 目の前の扉が変わったとき
 * @param {Map<string, string>} [options.tagLabels] タグID → 表示名
 * @returns {{ready: Promise<void>, setRooms: Function, step: Function, turn: Function,
 *            focusedRoom: object|null, dispose: Function}}
 */
export function createCorridorView(container, options = {}) {
  const modelUrl = options.modelUrl ?? "/assets/3d/izakaya_corridor_kit.glb";
  const onEnter = options.onEnter ?? null;
  const onFocus = options.onFocus ?? null;
  let tagLabels = options.tagLabels ?? new Map();

  let rooms = [];
  let disposed = false;
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
  let speed = 0;
  let focused = null;

  // ── 部品のプール ──────────────────────────────────
  const proto = { core: null, wall: null, door: null, pendant: null };
  const pools = { core: [], wall: [], door: [], pendant: [] };
  const tiles = new Map();     // "x,z" → { x, z, parts: [], doors: [] }

  function makeDoor() {
    const root = proto.door.clone(true);
    const sign = root.getObjectByName("Door_Sign");
    const paper = root.getObjectByName("Door_Paper");
    const lantern = root.getObjectByName("Door_Lantern");
    const hit = root.getObjectByName("Door_Hit");

    // clone() は材質を共有する。扉ごとに違う卓を出すので、ここだけ実体を分ける。
    const canvas = document.createElement("canvas");
    canvas.width = SIGN_W;
    canvas.height = SIGN_H;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // glTF の UV は V が反転している。CanvasTexture の既定（flipY = true）のままだと
    // そこで二重に反転して札が上下逆さまになる。
    texture.flipY = false;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    sign.material = new THREE.MeshStandardMaterial({
      map: texture,
      emissiveMap: texture,
      emissive: 0xffffff,
      emissiveIntensity: 0.22,   // 暗い廊下でも札だけは読める程度に自分で光らせる
      roughness: 0.9,
      metalness: 0,
    });
    lantern.material = lantern.material.clone();
    paper.material = paper.material.clone();
    paper.material.color.setHex(0x9c8b73);
    hit.material = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false,
    });

    const slot = { root, sign, canvas, texture, paper, lantern, hit, room: null, x: 0, z: 0 };
    hit.userData.slot = slot;
    return slot;
  }

  function take(kind) {
    const pooled = pools[kind].pop();
    if (pooled !== undefined) return pooled;
    if (kind === "door") return makeDoor();
    return proto[kind].clone(true);
  }

  function give(kind, item) {
    const obj = kind === "door" ? item.root : item;
    scene.remove(obj);
    pools[kind].push(item);
  }

  /** 扉に卓を割り当てて、木札・提灯・障子を書き換える */
  function bindDoor(slot, room) {
    slot.room = room;
    drawSign(slot.canvas, room, tagLabels);
    slot.texture.needsUpdate = true;
    if (room === null) {
      slot.lantern.material.color.setHex(0x4a3a2c);
      slot.lantern.material.emissive.setHex(0x2a1c10);
      slot.lantern.material.emissiveIntensity = 0.5;
      slot.paper.material.emissiveIntensity = 0.10;
      return;
    }
    const full = room.playerCount >= room.capacity;
    slot.lantern.material.color.setHex(full ? 0x8a5a4a : 0xf2b070);
    slot.lantern.material.emissive.setHex(full ? 0x7a2018 : 0xff8828);
    slot.lantern.material.emissiveIntensity = full ? 1.1 : 2.4;
    slot.paper.material.emissiveIntensity = room.playing ? 0.62 : 0.30;
  }

  /** マス1つ分を組む。開いている辺には何も置かない＝そこが通路になる */
  function buildTile(x, z) {
    const parts = [];
    const doors = [];
    const core = take("core");
    core.position.set(x * CELL, 0, z * CELL);
    scene.add(core);
    parts.push({ kind: "core", item: core });

    if (hash01(x, z, 5) < P_LIGHT) {
      const p = take("pendant");
      p.position.set(x * CELL, 0, z * CELL);
      scene.add(p);
      parts.push({ kind: "pendant", item: p });
    }

    DIRS.forEach((d, i) => {
      if (edgeOpen(x, z, d.key)) return;
      if (hasDoor(x, z, i)) {
        const slot = take("door");
        slot.root.position.set(x * CELL, 0, z * CELL);
        slot.root.rotation.y = d.rot;
        slot.x = x;
        slot.z = z;
        slot.dir = d;
        bindDoor(slot, roomAt(x, z, i, rooms));
        scene.add(slot.root);
        parts.push({ kind: "door", item: slot });
        doors.push(slot);
      } else {
        const w = take("wall");
        w.position.set(x * CELL, 0, z * CELL);
        w.rotation.y = d.rot;
        scene.add(w);
        parts.push({ kind: "wall", item: w });
      }
    });
    return { x, z, parts, doors };
  }

  function dropTile(tile) {
    for (const p of tile.parts) give(p.kind, p.item);
  }

  /** カメラの周りだけ実体を持つ。離れたマスは部品ごとプールへ返す */
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

  // ── 読み込み ─────────────────────────────────────
  const ready = new Promise((resolve, reject) => {
    new GLTFLoader().load(modelUrl, (gltf) => {
      if (disposed) return;
      try {
        for (const name of ["Kit_Core", "Kit_Wall", "Kit_Door", "Kit_Pendant"]) {
          const found = gltf.scene.getObjectByName(name);
          if (found === undefined) {
            throw new Error(`モデルに ${name} がありません（GLB を作り直してください）`);
          }
          found.removeFromParent();
          proto[name.replace("Kit_", "").toLowerCase()] = found;
        }
        findStart();
        streamTiles();
        resize();
        loop();
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
  let dragging = false;
  let dragMoved = 0;
  let lastX = 0;
  let lastY = 0;

  /** イベントの位置を正規化デバイス座標へ。タップは pointermove を伴わない */
  function ndcFromEvent(ev) {
    const rect = el.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    return ndc;
  }

  function onPointerDown(ev) {
    dragging = true;
    dragMoved = 0;
    lastX = ev.clientX;
    lastY = ev.clientY;
    el.setPointerCapture(ev.pointerId);
  }

  function onPointerMove(ev) {
    if (!dragging) return;
    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    yaw -= dx * 0.005;
    pitch = clamp(pitch - dy * 0.005, -0.9, 0.9);
  }

  function onPointerUp(ev) {
    if (!dragging) return;
    dragging = false;
    try { el.releasePointerCapture(ev.pointerId); } catch { /* 解放済み */ }
    if (dragMoved > 8) return;   // 振り回していたら見回しとみなす
    // いま置かれているマスの扉だけを対象にする。プール側は行列が古いままなので、
    // 混ぜるとシーンに居ない扉に当たることがある。
    const targets = [];
    for (const tile of tiles.values()) {
      for (const slot of tile.doors) targets.push(slot.hit);
    }
    raycaster.setFromCamera(ndcFromEvent(ev), camera);
    const hits = raycaster.intersectObjects(targets, false);
    const room = hits.length > 0 ? hits[0].object.userData.slot?.room ?? null : null;
    if (room !== null && onEnter !== null) onEnter(room.code);
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

  // ── 毎フレーム ───────────────────────────────────
  const clock = new THREE.Clock();

  function loop() {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.1);

    if (keys.has("w") || keys.has("W") || keys.has("ArrowUp")) speed += 12 * dt;
    if (keys.has("s") || keys.has("S") || keys.has("ArrowDown")) speed -= 12 * dt;
    if (keys.has("a") || keys.has("A") || keys.has("ArrowLeft")) yaw += 1.8 * dt;
    if (keys.has("d") || keys.has("D") || keys.has("ArrowRight")) yaw -= 1.8 * dt;

    speed = clamp(speed, -3.2, 3.2);
    // yaw = 0 で -Z（北）を向く。three.js のカメラの既定の向きに合わせてある。
    px += -Math.sin(yaw) * speed * dt;
    pz += -Math.cos(yaw) * speed * dt;
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

  // ── 外向きの API ─────────────────────────────────
  return {
    ready,

    /** 一覧を差し替える。ポーリングのたびに呼んでよい */
    setRooms(next, labels) {
      rooms = Array.isArray(next) ? next : [];
      if (labels !== undefined) tagLabels = labels;
      rebindAll();
      focused = undefined;   // 同じ扉でも中身が変わっているので通知し直す
      updateFocus();
    },

    /** 前後に歩く（+1 で前、-1 で後ろ）。画面上のボタンから呼ぶ用 */
    step(direction = 1) {
      speed += direction * 2.0;
    },

    /** その場で向きを変える（+1 で左、-1 で右） */
    turn(direction = 1) {
      yaw += direction * 0.45;
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
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("keyup", onKeyUp);
      const free = (obj) => obj.traverse((o) => {
        if (o.isMesh !== true) return;
        o.geometry?.dispose();
        for (const m of [].concat(o.material)) {
          m?.map?.dispose();
          m?.dispose();
        }
      });
      free(scene);
      for (const [kind, list] of Object.entries(pools)) {
        for (const item of list) free(kind === "door" ? item.root : item);
      }
      renderer.dispose();
      el.remove();
    },
  };
}

// 既存ページは classic script（app.js / rooms.js）なので、module から窓口を渡しておく。
globalThis.CorridorView = { create: createCorridorView, CELL };
