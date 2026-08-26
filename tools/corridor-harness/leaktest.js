// 実際に scene に置かれたインスタンスから、目線の高さ(1.55m)の遮蔽物を組み立て、
// 廊下から「見えてはいけない場所」へ抜けられないかを塗り広げで確かめる。
// 遮蔽物は「壁板（2.00 × 2.35 × 0.14）」と「隅柱（0.50 × 2.35 × 0.50）」だけを数える。
// 扉の枠など内側にしか無いものは数えないので、判定は甘くならない（穴を見逃さない）。
import * as THREE from "./three-shim.js";

const CELL = 3.0, HALF_W = 1.0, EYE = 1.55;
const P_STREET = 0.50, P_SEGMENT = 0.78, P_SHORTCUT = 0.14;
function hash01(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16; return (h >>> 0) / 4294967296;
}
const row = (z) => hash01(z, 0, 7) < P_STREET, col = (x) => hash01(x, 0, 8) < P_STREET;
const D = [["N", 0, -1], ["E", 1, 0], ["S", 0, 1], ["W", -1, 0]];
function edgeOpen(x, z, d) {
  if (d === "W") return edgeOpen(x - 1, z, "E");
  if (d === "N") return edgeOpen(x, z - 1, "S");
  if (d === "E") return hash01(x, z, 1) < (row(z) ? P_SEGMENT : P_SHORTCUT);
  return hash01(x, z, 2) < (col(x) ? P_SEGMENT : P_SHORTCUT);
}
export const cellUsed = (x, z) => D.some((d) => edgeOpen(x, z, d[0]));

const box = new THREE.Box3(), m4 = new THREE.Matrix4(), size = new THREE.Vector3();
const near = (a, b) => Math.abs(a - b) < 0.02;

/** 壁板か隅柱なら、その世界座標の箱を返す。それ以外は null */
function shellBox(mesh, i) {
  mesh.getMatrixAt(i, m4);
  if (m4.elements[0] === 0 && m4.elements[1] === 0 && m4.elements[2] === 0) return null;  // 空き枠
  if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
  box.copy(mesh.geometry.boundingBox).applyMatrix4(m4);
  box.getSize(size);
  const s = [size.x, size.y, size.z].sort((a, b) => a - b);
  const wall = near(s[0], 0.14) && near(s[1], 2.00) && near(s[2], 2.35);
  const post = near(s[0], 0.50) && near(s[1], 0.50) && near(s[2], 2.35);
  if (!wall && !post) return null;
  if (box.min.y > EYE || box.max.y < EYE) return null;
  return box;
}

/** カメラを (cx, cz) に置いた状態の scene を調べる。漏れた点の数を返す */
export function measureLeak(scene, cx, cz, opts = {}) {
  const G = opts.grid ?? 0.05;
  const R = opts.radius ?? 3;                 // VIEW_R
  const inner = opts.inner ?? 2;              // 判定するのは中心 ±2 マスぶん
  const LO = -(R + 0.5) * CELL, HI = (R + 0.5) * CELL;
  const N = Math.round((HI - LO) / G);
  const idx = (i, j) => j * N + i;
  const solid = new Uint8Array(N * N), want = new Uint8Array(N * N);
  const fill = (arr, x0, x1, z0, z1) => {
    const i0 = Math.max(0, Math.ceil((x0 - cx * CELL - LO) / G));
    const i1 = Math.min(N - 1, Math.floor((x1 - cx * CELL - LO) / G));
    const j0 = Math.max(0, Math.ceil((z0 - cz * CELL - LO) / G));
    const j1 = Math.min(N - 1, Math.floor((z1 - cz * CELL - LO) / G));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) arr[idx(i, j)] = 1;
  };
  let shells = 0;
  scene.traverse((o) => {
    if (o.isInstancedMesh !== true) return;
    for (let i = 0; i < o.count; i++) {
      const b = shellBox(o, i);
      if (b === null) continue;
      shells++;
      fill(solid, b.min.x, b.max.x, b.min.z, b.max.z);
    }
  });
  for (let dz = -R - 1; dz <= R + 1; dz++) {
    for (let dx = -R - 1; dx <= R + 1; dx++) {
      const x = cx + dx, z = cz + dz;
      if (!cellUsed(x, z)) continue;
      fill(want, x * CELL - HALF_W, x * CELL + HALF_W, z * CELL - HALF_W, z * CELL + HALF_W);
      if (edgeOpen(x, z, "E")) fill(want, x * CELL + HALF_W, (x + 1) * CELL - HALF_W, z * CELL - HALF_W, z * CELL + HALF_W);
      if (edgeOpen(x, z, "S")) fill(want, x * CELL - HALF_W, x * CELL + HALF_W, z * CELL + HALF_W, (z + 1) * CELL - HALF_W);
    }
  }
  const seen = new Uint8Array(N * N);
  const start = idx(Math.round((0 - LO) / G), Math.round((0 - LO) / G));
  if (solid[start] === 1) return { leaks: 0, shells, skipped: true };
  const q = [start];
  seen[start] = 1;
  let leaks = 0, at = null;
  const lim = Math.round(inner * CELL / G);
  const mid = Math.round((0 - LO) / G);
  for (let h = 0; h < q.length; h++) {
    const p = q[h], i = p % N, j = (p / N) | 0;
    if (Math.abs(i - mid) <= lim && Math.abs(j - mid) <= lim && want[p] === 0) {
      leaks++;
      if (at === null) at = [(cx * CELL + LO + i * G).toFixed(2), (cz * CELL + LO + j * G).toFixed(2)];
    }
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const np = idx(ni, nj);
      if (seen[np] === 1 || solid[np] === 1) continue;
      seen[np] = 1; q.push(np);
    }
  }
  return { leaks, shells, at, area: leaks * G * G };
}
