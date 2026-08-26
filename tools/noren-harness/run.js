/**
 * 暖簾をくぐる演出の検証台。`deno run --allow-read tools/noren-harness/run.js`
 *
 * **ブラウザを起動せずに**、本物の three.js と本物の GLB を Deno に読ませて
 * public/noren-scene.js をそのまま動かし、演出の時間軸を 1/60 秒ずつ手で進めて
 * 「実際に描かれた 1 コマ」を全部写し取る。
 *
 * ここで守っているのは、作り直す前の演出が実際に踏んでいた欠陥そのもの:
 *
 *   A. 全長 5.667 秒のうち頭の 2.45 秒が完全な静止画だった
 *      → 300ms を超える静止区間が無いこと
 *   B. カメラが暖簾の面を通過する瞬間、布は静止しきっていた
 *      （そもそも布 4 枚は中央に 5cm の隙間を空けて並んでおり、カメラが通る
 *       x=0 には布が無かった）
 *      → 通過のコマで内側の 2 枚が動いており、休み位置から退いていること
 *   C. 布の揺れが 1 コマで 11 度 → 0 度へ不連続にスナップバックしていた
 *      → 隣接コマ間で変位が飛ばないこと
 *   D. glb の 89% が全ウェイト 0 の死んだモーフターゲットだった
 *      → モーフターゲットが 1 個も無いこと
 *
 * noren-scene.js は**コピーせず**、ブラウザ向けの絶対パス 3 行だけ書き換えて
 * 読み込む（setup.js の loadNorenScene）。本体を直せば、この検証台も必ず追随する。
 */
import {
  advance,
  loadNorenScene,
  makeStage,
  modelPath,
  now,
  pendingFrames,
  settle,
} from "./setup.js";

const { playNorenIntro } = await loadNorenScene();

let fails = 0;
const ok = (cond, label, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  OK " : "NG   "} ${label}${extra ? "  " + extra : ""}`);
};

/** 1 コマの長さ。実時間では待たないので、実機と同じ 60fps の刻みで回せる */
const STEP = 1000 / 60;
/** これ未満の動きは「止まっている」とみなす（0.05mm） */
const EPS = 5e-5;

// ─────────────────────────────────────────────────────────
// 1. glb の中身（診断 D の再混入を止める）
// ─────────────────────────────────────────────────────────
console.log("=== 1. glb ===");
{
  const bytes = Deno.readFileSync(modelPath());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let json = null;
  let at = 12;
  while (at < bytes.byteLength) {
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    if (type === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(at + 8, at + 8 + length)));
    }
    at += 8 + length;
  }
  if (json === null) throw new Error("JSON チャンクがありません");

  const targets = (json.meshes ?? [])
    .flatMap((m) => m.primitives ?? [])
    .reduce((n, p) => n + (p.targets?.length ?? 0), 0);
  const weights = (json.meshes ?? []).filter((m) => m.weights !== undefined).length +
    (json.nodes ?? []).filter((n) => n.weights !== undefined).length;
  const clips = (json.animations ?? []).length;

  ok(targets === 0, "モーフターゲットが無い", `${targets} 個`);
  ok(weights === 0, "モーフのウェイトが残っていない", `${weights} 箇所`);
  ok(clips === 0, "ベイク済みアニメが無い（時間軸は noren-scene.js が持つ）", `${clips} 本`);
  ok(
    bytes.byteLength < 300_000,
    "ファイルが 300KB 未満（元は 1.53MB）",
    `${(bytes.byteLength / 1024).toFixed(0)}KB`,
  );
}

// ─────────────────────────────────────────────────────────
// 演出を回す道具
// ─────────────────────────────────────────────────────────

/** 実際に描かれた 1 コマを写し取る。測るのは理屈ではなく、本当に出した値 */
function snapshot(scene, camera) {
  const door = scene.getObjectByName("SlidingDoor");
  const strips = [];
  const stripX = [];
  for (let i = 0; i < 4; i++) {
    const node = scene.getObjectByName(`Strip${i}`);
    strips.push(
      node ? Float32Array.from(node.geometry.getAttribute("position").array) : new Float32Array(0),
    );
    stripX.push(node ? node.position.x : NaN);
  }
  return {
    t: now(),
    cam: [camera.position.x, camera.position.y, camera.position.z],
    doorX: door ? door.position.x : 0,
    strips,
    stripX,
  };
}

const maxDiff = (a, b) => {
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) worst = d;
  }
  return worst;
};

/** 前のコマからどれだけ動いたか */
function motion(prev, next) {
  const cam = Math.max(...[0, 1, 2].map((i) => Math.abs(next.cam[i] - prev.cam[i])));
  const door = Math.abs(next.doorX - prev.doorX);
  const strips = prev.strips.map((s, i) => maxDiff(s, next.strips[i]));
  return { cam, door, strips, max: Math.max(cam, door, ...strips) };
}

/**
 * 演出を最後まで回す。時計は自前なので実時間では待たない。
 * @param {object} options playNorenIntro へそのまま渡す
 */
async function runIntro(options = {}) {
  const stage = makeStage();
  const frames = [];
  const beats = [];
  globalThis.__onRender = (scene, camera) => frames.push(snapshot(scene, camera));

  let result = null;
  const play = playNorenIntro(stage, {
    ...options,
    onBeat: (name, atMs) => beats.push({ name, atMs, t: now() }),
  }).then((r) => {
    result = r;
  });

  for (let i = 0; i < 800 && result === null; i++) {
    // 演出側の await（モデルの読み込み・showStage）を進めてから次のコマへ
    await settle();
    if (result !== null) break;
    advance(STEP);
  }
  await play;
  globalThis.__onRender = null;
  return { stage, frames, beats, result, endedAt: now() };
}

// ─────────────────────────────────────────────────────────
// 2. 本編
// ─────────────────────────────────────────────────────────
console.log("=== 2. 本編 ===");
const run = await runIntro();
ok(run.result === "played", "最後まで再生される", `結果 ${run.result}`);
ok(run.frames.length > 100, "コマが出ている", `${run.frames.length} コマ`);

const readyAt = run.beats.find((b) => b.name === "ready")?.t ?? 0;
const total = run.endedAt - readyAt;
ok(total <= 2800, "総尺が 2.8 秒以内（以前は 5.667 秒）", `${total.toFixed(0)}ms`);
ok(total >= 2000, "短すぎない", `${total.toFixed(0)}ms`);

const order = run.beats.map((b) => b.name).join(" → ");
ok(
  order === "ready → doorOpen → walkStart → norenSplit → walkEnd",
  "合図が順番どおりに出る",
  order,
);

// ─────────────────────────────────────────────────────────
// 3. 布の並び（診断 B の根っこ）
// ─────────────────────────────────────────────────────────
console.log("=== 3. 布の並び ===");
{
  const first = run.frames[0];
  const covering = first.strips.filter((s, i) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let v = 0; v < s.length; v += 3) {
      if (s[v] < lo) lo = s[v];
      if (s[v] > hi) hi = s[v];
    }
    return first.stripX[i] + lo <= 0 && first.stripX[i] + hi >= 0;
  }).length;
  ok(
    covering >= 2,
    "カメラの通り道 x=0 に布がある（以前は 5cm の隙間を素通りしていた）",
    `覆う枚数 ${covering}`,
  );
}

// ─────────────────────────────────────────────────────────
// 4. 静止区間（診断 A）
// ─────────────────────────────────────────────────────────
console.log("=== 4. 静止区間 ===");
{
  let dead = 0;
  let worst = 0;
  let worstAt = 0;
  for (let i = 1; i < run.frames.length; i++) {
    const dt = run.frames[i].t - run.frames[i - 1].t;
    if (motion(run.frames[i - 1], run.frames[i]).max <= EPS) {
      dead += dt;
      if (dead > worst) {
        worst = dead;
        worstAt = run.frames[i].t - readyAt;
      }
    } else {
      dead = 0;
    }
  }
  ok(
    worst <= 300,
    "300ms を超える静止区間が無い（以前は頭に 2450ms）",
    `最長 ${worst.toFixed(0)}ms（t=${worstAt.toFixed(0)}ms）`,
  );
}

// ─────────────────────────────────────────────────────────
// 5. くぐる瞬間（診断 B・C）
// ─────────────────────────────────────────────────────────
console.log("=== 5. くぐる瞬間 ===");
{
  let crossing = -1;
  for (let i = 1; i < run.frames.length; i++) {
    if (run.frames[i - 1].cam[2] > 0 && run.frames[i].cam[2] <= 0) {
      crossing = i;
      break;
    }
  }
  ok(crossing > 0, "カメラが暖簾の面（z=0）を横切る");
  if (crossing > 0) {
    const at = run.frames[crossing];
    const m = motion(run.frames[crossing - 1], at);
    ok(
      m.strips[1] > 1e-3 && m.strips[2] > 1e-3,
      "その 1 コマで内側の 2 枚が動いている（以前は静止しきっていた）",
      `${m.strips[1].toFixed(4)}m / ${m.strips[2].toFixed(4)}m`,
    );
    const off = [1, 2].map((i) => maxDiff(at.strips[i], run.frames[0].strips[i]));
    ok(
      Math.min(...off) > 0.02,
      "布が休み位置から実際に退いている",
      `${off[0].toFixed(3)}m / ${off[1].toFixed(3)}m`,
    );
    const split = run.beats.find((b) => b.name === "norenSplit");
    ok(
      split !== undefined && Math.abs(split.t - at.t) <= STEP,
      "衣ずれの合図が通過のコマと同じ（以前は絵と音が 3.8 秒ずれていた）",
      `t=${(at.t - readyAt).toFixed(0)}ms`,
    );
  }
}

// ─────────────────────────────────────────────────────────
// 6. なめらかさ（診断 C のスナップバック再発防止）
// ─────────────────────────────────────────────────────────
console.log("=== 6. なめらかさ ===");
{
  let cloth = 0;
  let cam = 0;
  let door = 0;
  for (let i = 1; i < run.frames.length; i++) {
    const m = motion(run.frames[i - 1], run.frames[i]);
    cloth = Math.max(cloth, ...m.strips);
    cam = Math.max(cam, m.cam);
    door = Math.max(door, m.door);
  }
  // 元のベイクは 1 コマで 11 度（裾で 0.23m）ぶん 0 へ跳ねていた。
  // 上限はそれより十分に低いところへ置く
  ok(cloth <= 0.08, "布が隣接コマ間で飛ばない", `最大 ${cloth.toFixed(4)}m/コマ`);
  // カメラは 6.2m を easeInOutCubic で渡る。この曲線のいちばん急なところは
  // 等速の 3 倍なので、60fps なら 1 コマ 0.17m まで出る。上限はその上に置く
  ok(cam <= 0.25, "カメラが飛ばない", `最大 ${cam.toFixed(4)}m/コマ`);
  ok(door <= 0.20, "引き戸が飛ばない", `最大 ${door.toFixed(4)}m/コマ`);
}

// ─────────────────────────────────────────────────────────
// 7. 揺れを嫌う設定（診断 H）
// ─────────────────────────────────────────────────────────
console.log("=== 7. prefers-reduced-motion ===");
{
  const still = await runIntro({ reducedMotion: true });
  ok(still.result === "still", "静止した代替表現に落ちる", `結果 ${still.result}`);
  ok(still.frames.length === 1, "描くのは一コマだけ", `${still.frames.length} コマ`);
  ok(pendingFrames() === 0, "次のコマを予約しない");
}

// ─────────────────────────────────────────────────────────
// 8. 途中で画面を離れたときの後片付け
// ─────────────────────────────────────────────────────────
console.log("=== 8. 後片付け ===");
{
  const controller = new AbortController();
  const stage = makeStage();
  let result = null;
  const play = playNorenIntro(stage, { signal: controller.signal }).then((r) => {
    result = r;
  });
  for (let i = 0; i < 800 && result === null; i++) {
    await settle();
    if (result !== null) break;
    advance(STEP);
    // 演出の途中（1 秒あたり）で画面を離れる
    if (i === 70) controller.abort();
  }
  await play;
  await settle();

  const renderer = globalThis.__renderer;
  ok(pendingFrames() === 0, "rAF の予約が残らない", `${pendingFrames()} 件`);
  ok(
    renderer.disposeCount === 1,
    "途中で離れても片付けが 1 回だけ走る",
    `${renderer.disposeCount} 回`,
  );
  ok(renderer.contextLossCount === 1, "WebGL のコンテキストを明け渡す");
  ok(stage.clears === 1, "canvas を取り除く", `${stage.clears} 回`);
  controller.abort();
  ok(renderer.disposeCount === 1, "二重に離れても片付けは 1 回のまま");
}

console.log(fails === 0 ? "\nすべて OK" : `\n${fails} 件 NG`);
if (fails > 0) Deno.exit(1);
