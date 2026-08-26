/**
 * 廊下ビューの検証台。`deno run --allow-read tools/corridor-harness/run.js`
 *
 * **ブラウザを起動せずに**、本物の three.js と本物の GLB を Deno に読ませて
 * public/assets/3d/corridor-view.js をそのまま動かし、次を実測する。
 *
 *   1.  ドローコール（実際に描かれる物の数。部品の種類数で頭打ちになっているか）
 *   1b. 壁の穴（廊下から「見えてはいけない場所」へ抜けられないか）
 *   2.  visibleDoors() の画面座標・前後・方位角
 *   2a. 扉の id が視点に依らず扉を一意に指すか
 *   2b. 扉を押したときの当たり判定（枠番号 → 扉の対応）
 *   2c. 歩いて戻ったときの決定性（間取りと卓の割り当て）
 *   3.  pause / resume が rAF の予約そのものを止めているか
 *   4.  setInput の効き方と進む向き
 *   6.  dispose
 *
 * corridor-view.js は**コピーせず**、import の2行だけ書き換えて読み込む
 * （setup.js の loadCorridorView を参照）。本体を直せば、この検証台も必ず追随する。
 *
 * **アセット（izakaya_corridor_kit.glb）を差し替えたら必ず走らせること。**
 * 壁板や隅柱の寸法が変わると、目では気づけない穴が開く。
 */
import { flushFrames, kitUrl, loadCorridorView, makeContainer, pendingFrames } from "./setup.js";
import { cellUsed, measureLeak } from "./leaktest.js";

const KIT = kitUrl();
const { createCorridorView } = await loadCorridorView();

let fails = 0;
const ok = (cond, label, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  OK " : "NG   "} ${label}${extra ? "  " + extra : ""}`);
};

const rooms = (n) =>
  Array.from({ length: n }, (_, i) => ({
    code: `R${String(i).padStart(3, "0")}`,
    roomName: `卓${i}`,
    playerCount: i % 5,
    capacity: 4,
    playing: i % 3 === 0,
    tags: [],
    createdAt: Date.now(),
  }));

const container = makeContainer();
let entered = null;
const view = createCorridorView(container, {
  modelUrl: KIT,
  onEnter: (code) => { entered = code; },
});
await view.ready;
view.setRooms(rooms(7));

// ── 1. ドローコール ───────────────────────────────
console.log("=== 1. ドローコール ===");
let worst = 0;
let worstDoors = 0;
let cellsSeen = 0;
for (let t = 0; t < 400; t++) {
  view.position = { x: (t % 20) * 3.0, z: ((t / 20) | 0) * 3.0, yaw: 0 };
  flushFrames(1);
  const n = globalThis.__drawCalls ?? 0;
  if (n > worst) worst = n;
  // いま置かれている扉の数（＝旧方式ならメッシュがこの 9 倍出ていた）
  let doors = 0;
  let instances = 0;
  globalThis.__scene.traverse((o) => {
    if (o.isInstancedMesh !== true) return;
    instances += o.count;
  });
  doors = instances;
  if (doors > worstDoors) worstDoors = doors;
  cellsSeen++;
}
console.log(`  400地点を歩いて測定 / 最大ドローコール ${worst} / 置かれた部品の延べ最大 ${worstDoors}`);
ok(worst <= 50, "扉の多い場所でもドローコール 50 以下", `最大 ${worst}`);
ok(cellsSeen === 400, "全地点で描画できた");

// 枠が溢れていないか（alloc が -1 を返すと部品が欠ける）
{
  let overflow = false;
  globalThis.__scene.traverse((o) => {
    if (o.isInstancedMesh !== true) return;
    if (o.count > o.instanceMatrix.count) overflow = true;
  });
  ok(!overflow, "確保した枠を超えていない");
}

console.log("=== 1b. 壁の穴（廊下から見えてはいけない場所へ抜けられないか） ===");
{
  let totalLeak = 0, worstLeak = 0, worstAt = null, checked = 0, shells = 0;
  for (let t = 0; t < 120; t++) {
    const cx = (t % 12) - 6, cz = ((t / 12) | 0) - 5;
    if (!cellUsed(cx, cz)) continue;          // 人が入れないマスにカメラは置けない
    view.position = { x: cx * 3, z: cz * 3, yaw: 0 };
    flushFrames(1);
    const r = measureLeak(globalThis.__scene, cx, cz);
    if (r.skipped === true) continue;
    checked++;
    shells = Math.max(shells, r.shells);
    totalLeak += r.leaks;
    if (r.leaks > worstLeak) { worstLeak = r.leaks; worstAt = r.at; }
  }
  console.log(`  ${checked}地点で塗り広げ / 遮蔽物の最大 ${shells} 個 / 漏れの合計 ${totalLeak} 点`);
  ok(checked >= 40, "十分な地点を調べた", `${checked} 地点`);
  ok(totalLeak === 0, "廊下から見えてはいけない場所へ抜けられない（壁に穴が無い）",
    worstAt ? `最悪 ${worstLeak} 点 例 (${worstAt[0]}, ${worstAt[1]})` : "");
}

console.log("=== 2. visibleDoors ===");
// 一意に追える扉が欲しいので、卓を扉より多くしておく
view.setRooms(rooms(300));
view.position = { x: 0, z: 0, yaw: 0 };
flushFrames(1);
const list = view.visibleDoors();
ok(list.length > 0, "扉が返る", `${list.length} 枚`);
ok(
  list.every((d) => typeof d.code === "string" && d.room !== undefined),
  "code と room が入っている",
);
ok(
  list.every((d) => Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.distance)),
  "x / y / distance が数値",
);
ok(
  list.every((d) => Number.isFinite(d.bearing) && Math.abs(d.bearing) <= Math.PI + 1e-9),
  "bearing が -π..π",
);
ok(list.every((d) => !(d.behind && d.onScreen)), "behind なら onScreen は false");
ok(
  list.every((d, i) => i === 0 || list[i - 1].distance <= d.distance),
  "distance 昇順",
);
// 向きの決まり: 左が + であること。画面内の扉で、bearing の符号と
// 画面の左右が食い違っていないかを直接見る（ここを間違えると矢印が左右逆に出る）。
{
  const onScreen = list.filter((d) => d.onScreen);
  ok(onScreen.length > 0, "画面内の扉がある", `${onScreen.length} 枚`);
  const wrong = onScreen.filter((d) =>
    Math.abs(d.bearing) > 0.02 && (d.bearing > 0) !== (d.x < 400)
  );
  ok(wrong.length === 0, "bearing が + の扉は画面の左半分に居る（左が +）",
    wrong.length > 0 ? `食い違い ${wrong.length} 枚 例 bearing=${wrong[0].bearing.toFixed(2)} x=${wrong[0].x.toFixed(0)}` : "");
}

// 前後と左右が正しいか: 一意に見分けられる扉を、向きを変えて見る。
// 卓は扉より少なく同じ code が何枚も出るので、1枚しか出ていない code を選ぶ。
{
  const seen = new Map();
  for (const d of list) seen.set(d.code, (seen.get(d.code) ?? 0) + 1);
  const unique = list.find((d) => seen.get(d.code) === 1 && !d.behind &&
    Math.abs(d.bearing) > 0.05 && Math.abs(Math.abs(d.bearing) - Math.PI) > 0.05);
  if (unique === undefined) {
    ok(true, "（一意に追える扉が無かったので前後反転の確認は省略）");
  } else {
    view.position = { x: 0, z: 0, yaw: Math.PI };
    flushFrames(1);
    const flipped = view.visibleDoors().find((d) => d.code === unique.code);
    ok(flipped !== undefined, "振り返っても同じ扉が居る");
    if (flipped !== undefined) {
      ok(flipped.behind === true, "正面にあった扉は、振り返ると behind になる");
      ok(flipped.onScreen === false, "behind の扉は onScreen が false");
      ok(
        Math.abs(Math.abs(flipped.bearing - unique.bearing) - Math.PI) < 0.02,
        "振り返ると bearing がちょうど π ずれる",
        `${unique.bearing.toFixed(3)} → ${flipped.bearing.toFixed(3)}`,
      );
      ok(
        Math.abs(flipped.distance - unique.distance) < 1e-6,
        "向きを変えても distance は変わらない",
      );
    }
  }
}

// 左へ振ると、正面の扉は画面の右へ動き、bearing は減る
{
  view.position = { x: 0, z: 0, yaw: 0 };
  flushFrames(1);
  const now = view.visibleDoors();
  const seen = new Map();
  for (const d of now) seen.set(d.code, (seen.get(d.code) ?? 0) + 1);
  const a2 = now.find((d) => seen.get(d.code) === 1 && d.onScreen);
  if (a2 === undefined) {
    ok(true, "（一意に追える画面内の扉が無かったので省略）");
  } else {
    view.position = { x: 0, z: 0, yaw: 0.25 };   // yaw が増える = 左を向く
    flushFrames(1);
    const b2 = view.visibleDoors().find((d) => d.code === a2.code);
    ok(b2 !== undefined && b2.bearing < a2.bearing, "左を向くと正面の扉の bearing が減る",
      `${a2.bearing.toFixed(3)} → ${b2?.bearing.toFixed(3)}`);
    ok(b2 !== undefined && b2.x > a2.x, "左を向くと正面の扉は画面の右へ動く",
      `${a2.x.toFixed(0)} → ${b2?.x.toFixed(0)}`);
  }
}

console.log("=== 2a. 扉の id（視点に依らず扉を一意に指すか） ===");
{
  view.setRooms(rooms(7));                    // 卓を扉より少なくして、code では見分けられない状態にする
  view.position = { x: 0, z: 0, yaw: 0 };
  flushFrames(1);

  // 返ってきた値から扉の居場所そのものを復元する。距離だけだと、左右対称の位置に
  // ある別々の扉が同じ値になってしまい、同一性の代わりにならない。
  // 木札は扉の根から高さ 1.42 の位置にあり、目線は 1.55 なので上下差は全扉で共通。
  // 方位角は正面から左が + なので、世界での向きは yaw + bearing。
  const placeOf = (cam, d) => {
    const dy = 1.42 - 1.55;
    const horiz = Math.sqrt(Math.max(0, d.distance * d.distance - dy * dy));
    const a = cam.yaw + d.bearing;
    return `${(cam.x - Math.sin(a) * horiz).toFixed(3)},${(cam.z - Math.cos(a) * horiz).toFixed(3)}`;
  };

  // 1地点から、向きだけを一周ぶん変えて集める
  const byId = new Map();
  const byPlace = new Map();
  let calls = 0, rows = 0, dupInCall = 0;
  for (let t = 0; t < 24; t++) {
    view.position = { x: 0, z: 0, yaw: (t / 24) * Math.PI * 2 };
    flushFrames(1);
    const cam = view.position;
    const list = view.visibleDoors();
    calls++;
    const seen = new Set();
    for (const d of list) {
      rows++;
      if (seen.has(d.id)) dupInCall++;
      seen.add(d.id);
      const place = placeOf(cam, d);
      if (!byId.has(d.id)) byId.set(d.id, new Set());
      byId.get(d.id).add(place);
      if (!byPlace.has(place)) byPlace.set(place, new Set());
      byPlace.get(place).add(d.id);
    }
  }
  ok(rows > 0 && calls === 24, "一周ぶん見回して扉を集めた", `${rows} 件 / ${byId.size} 種`);
  ok(dupInCall === 0, "1回の呼び出しの中で id が重複しない", dupInCall > 0 ? `${dupInCall} 件` : "");
  ok(
    [...byId.values()].every((s) => s.size === 1),
    "向きを変えても、同じ id は同じ扉を指し続ける",
    `ぶれた id ${[...byId.values()].filter((s) => s.size > 1).length} 種`,
  );
  ok(
    [...byPlace.values()].every((s) => s.size === 1),
    "同じ扉が2つ以上の id を持たない（＝異なる扉は必ず異なる id）",
    `ぶれた扉 ${[...byPlace.values()].filter((s) => s.size > 1).length} 箇所`,
  );
  // code だけでは足りないこと（この API を足した理由）も測っておく
  view.position = { x: 0, z: 0, yaw: 0 };
  flushFrames(1);
  const one = view.visibleDoors();
  const codes = new Set(one.map((d) => d.code));
  ok(
    codes.size < one.length,
    "同じ卓を複数の扉が受け持つ（code は鍵にできない）",
    `扉 ${one.length} 枚 / 卓 ${codes.size} 種`,
  );

  // 歩いて戻っても同じ id
  const before = view.visibleDoors().map((d) => d.id).sort().join("|");
  for (let t = 0; t < 40; t++) { view.position = { x: t * 3, z: t * 3, yaw: t }; flushFrames(1); }
  view.position = { x: 0, z: 0, yaw: 0 };
  flushFrames(1);
  const after = view.visibleDoors().map((d) => d.id).sort().join("|");
  ok(before === after && before.length > 0, "遠くまで歩いて戻っても id が変わらない");

  // 別の地点から見ても、同じ扉なら同じ id（重なる範囲で確かめる）
  view.position = { x: 0, z: 0, yaw: 0 };
  flushFrames(1);
  const home = new Map(view.visibleDoors().map((d) => [d.id, d.code]));
  let shared = 0, mismatch = 0;
  for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [3, 3]]) {
    view.position = { x: dx, z: dz, yaw: 1.0 };
    flushFrames(1);
    for (const d of view.visibleDoors()) {
      if (!home.has(d.id)) continue;
      shared++;
      if (home.get(d.id) !== d.code) mismatch++;
    }
  }
  ok(shared > 0, "別の地点からも同じ扉が見えている", `${shared} 件`);
  ok(mismatch === 0, "視点が変わっても id と卓の対応が動かない", mismatch > 0 ? `${mismatch} 件` : "");
  view.setRooms(rooms(300));
}

console.log("=== 2b. 扉を押す（当たり判定は InstancedMesh の枠番号で引く） ===");
{
  view.position = { x: 0, z: 0, yaw: 0 };
  flushFrames(1);
  const el = container.children[0];
  const doors = view.visibleDoors();
  const onScreenCodes = new Set(doors.filter((d) => d.onScreen).map((d) => d.code));
  const allCodes = new Set(doors.map((d) => d.code));
  let hits = 0;
  let outside = 0;
  let notVisible = 0;
  for (let sy = 40; sy < 600; sy += 40) {
    for (let sx = 20; sx < 800; sx += 20) {
      entered = null;
      el.fire("pointerdown", { clientX: sx, clientY: sy, pointerId: 1 });
      el.fire("pointerup", { clientX: sx, clientY: sy, pointerId: 1 });
      if (entered === null) continue;
      hits++;
      if (!allCodes.has(entered)) outside++;
      else if (!onScreenCodes.has(entered)) notVisible++;
    }
  }
  ok(hits > 0, "画面を舐めると扉に当たる", `${hits} 回`);
  ok(outside === 0, "当たった卓は必ず置かれている扉のもの（枠番号の対応が正しい）",
    outside > 0 ? `外れ ${outside} 回` : "");
  ok(notVisible === 0, "当たった卓は画面内に出ている扉のもの",
    notVisible > 0 ? `画面外 ${notVisible} 回` : "");
}

console.log("=== 2c. 歩いて戻ると同じ間取り・同じ卓（決定性） ===");
{
  const snapshot = () => {
    flushFrames(1);
    return view.visibleDoors()
      .map((d) => `${d.code}@${d.distance.toFixed(4)}/${d.bearing.toFixed(4)}`)
      .sort()
      .join("|");
  };
  view.position = { x: 0, z: 0, yaw: 0.7 };
  const first = snapshot();
  for (let t = 0; t < 60; t++) {
    view.position = { x: t * 3, z: t * 3, yaw: t * 0.3 };
    flushFrames(1);
  }
  view.position = { x: 0, z: 0, yaw: 0.7 };
  const again = snapshot();
  ok(first === again && first.length > 0, "遠くまで歩いて戻っても、見える扉と卓が一致する");
  // 卓一覧を入れ替えて戻しても同じ
  view.setRooms(rooms(7));
  flushFrames(1);
  view.setRooms(rooms(300));
  const third = snapshot();
  ok(first === third, "卓一覧を差し替えて戻しても同じ割り当てになる");
}

console.log("=== 3. pause / resume ===");
view.position = { x: 0, z: 0, yaw: 0 };
flushFrames(1);
ok(pendingFrames() === 1, "回っているときは rAF が1件予約されている", `${pendingFrames()}`);
view.pause();
ok(pendingFrames() === 0, "pause で rAF の予約が消える（フラグだけではない）", `${pendingFrames()}`);
flushFrames(3);
ok(pendingFrames() === 0, "pause 中はフレームが積み上がらない");
view.pause();
ok(pendingFrames() === 0, "pause の二重呼びで壊れない");
view.resume();
ok(pendingFrames() === 1, "resume で戻る", `${pendingFrames()}`);
view.resume();
ok(pendingFrames() === 1, "resume の二重呼びで rAF が二重に回らない", `${pendingFrames()}`);
flushFrames(1);

console.log("=== 4. setInput ===");
view.setInput({});
const p0 = view.position;
flushFrames(5);
const p1 = view.position;
ok(
  Math.abs(p1.x - p0.x) < 1e-6 && Math.abs(p1.z - p0.z) < 1e-6,
  "setInput({}) で止まったまま",
);
view.setInput({ turn: 1 });
const y0 = view.position.yaw;
flushFrames(5);
ok(view.position.yaw > y0, "turn:+1 で yaw が増える（左旋回）");
view.setInput({ turn: 0 });
view.setInput({ forward: 2 });   // 範囲外は丸める
flushFrames(5);
ok(true, "範囲外の値を渡しても落ちない");
view.setInput({ forward: Number.NaN, strafe: "x" });
flushFrames(5);
ok(Number.isFinite(view.position.x) && Number.isFinite(view.position.z), "NaN を渡しても座標が壊れない");
view.setInput({});

console.log("=== 4b. 進む向き ===");
{
  const move = (input, frames = 30) => {
    view.setInput({});
    view.position = { x: 0, z: 0, yaw: 0 };   // yaw = 0 は北（-Z）向き
    flushFrames(2);
    const from = view.position;
    view.setInput(input);
    flushFrames(frames);
    const to = view.position;
    view.setInput({});
    return { dx: to.x - from.x, dz: to.z - from.z };
  };
  const f = move({ forward: 1 });
  ok(f.dz < 0 && Math.abs(f.dx) < Math.abs(f.dz), "forward:+1 は北（-Z）へ進む",
    `dx=${f.dx.toExponential(1)} dz=${f.dz.toExponential(1)}`);
  const b = move({ forward: -1 });
  ok(b.dz > 0, "forward:-1 は南へ下がる");
  const r = move({ strafe: 1 });
  ok(r.dx > 0 && Math.abs(r.dz) < Math.abs(r.dx), "strafe:+1 は右（東 = +X）へ寄る",
    `dx=${r.dx.toExponential(1)} dz=${r.dz.toExponential(1)}`);
  const l = move({ strafe: -1 });
  ok(l.dx < 0, "strafe:-1 は左（西）へ寄る");
}

console.log("=== 5. setLookLimit ===");
view.setLookLimit(0.6);
ok(true, "setLookLimit が呼べる");
view.setLookLimit(Number.NaN);
ok(true, "NaN を渡しても落ちない");

console.log("=== 6. dispose ===");
view.dispose();
ok(pendingFrames() === 0, "dispose で rAF が止まる");
view.dispose();
ok(true, "dispose の二重呼びで落ちない");
void entered;

console.log(fails === 0 ? "\nすべて通過" : `\n${fails} 件失敗`);
if (fails > 0) Deno.exit(1);
