/**
 * 廊下の間取り生成を机上で検証する道具。`deno run tools/corridor-layout-check.js`
 *
 * 出てくる形（直線・角・T字・十字・行き止まり）の割合と、
 *   1. 壁をすり抜けないか
 *   2. どこかに閉じ込められないか
 * を測る。P_STREET / P_SEGMENT / P_SHORTCUT を触るときは必ずここで測ってから決める。
 * 数字を見ずに動かすと、通路が千切れて歩ける範囲が一気に狭くなる（P_SEGMENT が
 * 0.7 を割ると到達マスが半分以下に落ちる）。
 *
 * 注意: 定数と判定式は public/assets/3d/corridor-view.js の写し。
 * ブラウザ側から import できない（あちらは three.js を読む ES module）ため
 * 二重に持っている。片方を変えたらもう片方も合わせること。
 */

const CELL = 3.0, HALF_W = 1.0, BODY_R = 0.35, LIMIT = HALF_W - BODY_R;
const P_STREET = 0.50, P_SEGMENT = 0.78, P_SHORTCUT = 0.14;
function hash01(a,b,c){let h=Math.imul(a|0,0x27d4eb2d)^Math.imul(b|0,0x165667b1)^Math.imul(c|0,0x9e3779b1);
  h=Math.imul(h^(h>>>15),0x85ebca6b);h=Math.imul(h^(h>>>13),0xc2b2ae35);h^=h>>>16;return (h>>>0)/4294967296;}
const row=(z)=>hash01(z,0,7)<P_STREET, col=(x)=>hash01(x,0,8)<P_STREET;
function edgeOpen(x,z,d){ if(d==="W")return edgeOpen(x-1,z,"E"); if(d==="N")return edgeOpen(x,z-1,"S");
  if(d==="E")return hash01(x,z,1)<(row(z)?P_SEGMENT:P_SHORTCUT); return hash01(x,z,2)<(col(x)?P_SEGMENT:P_SHORTCUT);}
const clamp=(v,lo,hi)=>v<lo?lo:v>hi?hi:v;

let px=0, pz=0;
function collide(){
  const cx=Math.round(px/CELL), cz=Math.round(pz/CELL);
  let dx=px-cx*CELL, dz=pz-cz*CELL;
  if(dx>LIMIT){ if(edgeOpen(cx,cz,"E")) dz=clamp(dz,-LIMIT,LIMIT); else dx=LIMIT; }
  else if(dx<-LIMIT){ if(edgeOpen(cx,cz,"W")) dz=clamp(dz,-LIMIT,LIMIT); else dx=-LIMIT; }
  if(dz>LIMIT){ if(edgeOpen(cx,cz,"S")) dx=clamp(dx,-LIMIT,LIMIT); else dz=LIMIT; }
  else if(dz<-LIMIT){ if(edgeOpen(cx,cz,"N")) dx=clamp(dx,-LIMIT,LIMIT); else dz=-LIMIT; }
  px=cx*CELL+dx; pz=cz*CELL+dz;
}

// 壁の中に入っていないか。塞がった辺の向きへ LIMIT を越えていたら違反。
function violation(){
  const cx=Math.round(px/CELL), cz=Math.round(pz/CELL);
  const dx=px-cx*CELL, dz=pz-cz*CELL;
  const eps=1e-6;
  if(dx> LIMIT+eps && !edgeOpen(cx,cz,"E")) return "E";
  if(dx<-LIMIT-eps && !edgeOpen(cx,cz,"W")) return "W";
  if(dz> LIMIT+eps && !edgeOpen(cx,cz,"S")) return "S";
  if(dz<-LIMIT-eps && !edgeOpen(cx,cz,"N")) return "N";
  // 開いた辺から出ている最中は、通路の幅を越えていないか
  if(Math.abs(dx)>LIMIT+eps && Math.abs(dz)>LIMIT+eps) return "斜め抜け";
  return null;
}

// 起点
const D=[["N",0,-1],["E",1,0],["S",0,1],["W",-1,0]];
outer: for(let r=0;r<=8;r++) for(let z=-r;z<=r;z++) for(let x=-r;x<=r;x++)
  if(D.filter(d=>edgeOpen(x,z,d[0])).length>=2){ px=x*CELL; pz=z*CELL; break outer; }

let seed=12345; const rnd=()=>((seed=Math.imul(seed,1103515245)+12345|0)>>>8)/16777216;
const visited=new Set(); let bad=0, worst=null;
let yaw=0;
for(let step=0;step<400000;step++){
  if(rnd()<0.04) yaw += (rnd()-0.5)*2.2;          // ときどき向きを変える
  const dt=0.016, v=3.0;
  px += -Math.sin(yaw)*v*dt;
  pz += -Math.cos(yaw)*v*dt;
  collide();
  const bad1=violation();
  if(bad1){ bad++; worst=worst??`${bad1} @ (${px.toFixed(2)}, ${pz.toFixed(2)})`; }
  visited.add(`${Math.round(px/CELL)},${Math.round(pz/CELL)}`);
}
console.log(`歩数 400000 / 訪れたマス ${visited.size} / 壁抜け ${bad}${worst?` 例: ${worst}`:""}`);
console.log(visited.size > 200 ? "→ 閉じ込められずに広く歩けている" : "→ 動ける範囲が狭い。要調整");

// 形の割合も出す（歩けるマスに対する比率）
{
  const D2 = [["N", 0, -1], ["E", 1, 0], ["S", 0, 1], ["W", -1, 0]];
  const R = 40;
  let cells = 0, dead = 0, straight = 0, corner = 0, tee = 0, cross = 0;
  for (let z = -R; z <= R; z++) {
    for (let x = -R; x <= R; x++) {
      const o = D2.filter((d) => edgeOpen(x, z, d[0])).map((d) => d[0]);
      if (o.length === 0) continue;
      cells++;
      if (o.length === 1) dead++;
      else if (o.length === 4) cross++;
      else if (o.length === 3) tee++;
      else if ((o.includes("N") && o.includes("S")) || (o.includes("E") && o.includes("W"))) straight++;
      else corner++;
    }
  }
  const pc = (n) => `${((n / cells) * 100).toFixed(1)}%`;
  console.log(
    `直線 ${pc(straight)} / 角 ${pc(corner)} / T字 ${pc(tee)} / 十字 ${pc(cross)} / 行き止まり ${pc(dead)}`,
  );
}

// ── 卓の割り当て: 1地点から見える扉のうち、同じ卓が何枚あるか ────────────
//
// 扉のほうが卓より多いので重複はゼロにならない。測りたいのは「避けられるはずの重複が
// どれだけ残っているか」なので、鳩の巣による下限（見える扉が D 枚、卓が R なら
// max(0, D - R)）を標本ごとに出して、そこからの超過を見る。
// D の分布に幅があるため、平均扉数から R を引く出し方は下限を過小評価する。
//
// 「見える」は視線で決める。カメラの居るマスから扉の板までを結んだ線が、
// 途中で塞がった辺を跨いだら見えない扱い。距離だけで切ると壁の向こうの扉まで
// 数えてしまい、数字の意味が無くなる。
{
  const VIEW_R = 3;                        // corridor-view.js と同じ（実体を置く範囲）
  const P_DOOR = 0.72;
  const D4 = [["N", 0, -1], ["E", 1, 0], ["S", 0, 1], ["W", -1, 0]];
  const cellUsed = (x, z) => D4.some((d) => edgeOpen(x, z, d[0]));
  const hasDoor = (x, z, i) => hash01(x * 4 + i, z, 3) < P_DOOR;

  // 改善前: 扉ごとに独立してハッシュを引く
  const oldRoom = (x, z, i, R) => Math.floor(hash01(x * 4 + i, z * 3 + i, 4) * R) % R;

  // 改善後: ブロック内の実在する扉に密な連番を振り、卓を順ぐりに配る
  // （corridor-view.js の roomAt の写し。BLOCK / 走査順もあちらと合わせること）
  const BLOCK = 8;
  const hilbert = (n, x, z) => {
    let d = 0;
    for (let s = n >> 1; s > 0; s >>= 1) {
      const rx = (x & s) > 0 ? 1 : 0, rz = (z & s) > 0 ? 1 : 0;
      d += s * s * ((3 * rx) ^ rz);
      if (rz === 0) {
        if (rx === 1) { x = s - 1 - x; z = s - 1 - z; }
        const t = x; x = z; z = t;
      }
    }
    return d;
  };
  const ORDER = (() => {
    const cells = [];
    for (let z = 0; z < BLOCK; z++) for (let x = 0; x < BLOCK; x++) cells.push({ x, z, d: hilbert(BLOCK, x, z) });
    cells.sort((a, b) => a.d - b.d);
    return cells.map((c) => c.z * BLOCK + c.x);
  })();
  const newRoom = (x, z, i, R) => {
    const bx = Math.floor(x / BLOCK), bz = Math.floor(z / BLOCK);
    let k = 0;
    for (const cell of ORDER) {
      const cx = bx * BLOCK + (cell % BLOCK), cz = bz * BLOCK + ((cell / BLOCK) | 0);
      const used = cellUsed(cx, cz);
      for (let d = 0; d < 4; d++) {
        if (cx === x && cz === z && d === i) return (Math.floor(hash01(bx, bz, 11) * R) + k) % R;
        if (used && !edgeOpen(cx, cz, D4[d][0]) && hasDoor(cx, cz, d)) k++;
      }
    }
    return 0;
  };

  // 目から扉の板まで、閉じた辺を跨がずに届くか（マスの境目だけを見る格子の走査）。
  // corridor-view.js の hasLineOfSight と同じ判定。あちらは visibleDoors() の
  // 「壁越しの扉を出さない」に使っている。片方を変えたらもう片方も合わせること。
  function visible(px0, pz0, qx, qz) {
    let cx = Math.round(px0 / CELL), cz = Math.round(pz0 / CELL);
    const ex = Math.round(qx / CELL), ez = Math.round(qz / CELL);
    const dx = qx - px0, dz = qz - pz0;
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    let tx = dx === 0 ? Infinity : (((cx + sx * 0.5) * CELL) - px0) / dx;
    let tz = dz === 0 ? Infinity : (((cz + sz * 0.5) * CELL) - pz0) / dz;
    const ddx = dx === 0 ? Infinity : CELL / Math.abs(dx);
    const ddz = dz === 0 ? Infinity : CELL / Math.abs(dz);
    for (let g = 0; g < 64 && (cx !== ex || cz !== ez); g++) {
      if (tx > 1 && tz > 1) return false;                       // 板より手前で線分が尽きた
      if (tx < tz) { if (!edgeOpen(cx, cz, sx > 0 ? "E" : "W")) return false; cx += sx; tx += ddx; }
      else { if (!edgeOpen(cx, cz, sz > 0 ? "S" : "N")) return false; cz += sz; tz += ddz; }
    }
    return cx === ex && cz === ez;
  }

  function doorsFrom(sx, sz) {
    const ox = sx * CELL, oz = sz * CELL, out = [];
    for (let dz = -VIEW_R; dz <= VIEW_R; dz++) {
      for (let dx = -VIEW_R; dx <= VIEW_R; dx++) {
        const x = sx + dx, z = sz + dz;
        if (!cellUsed(x, z)) continue;
        for (let i = 0; i < 4; i++) {
          if (edgeOpen(x, z, D4[i][0]) || !hasDoor(x, z, i)) continue;
          const qx = x * CELL + D4[i][1] * HALF_W, qz = z * CELL + D4[i][2] * HALF_W;
          if (visible(ox, oz, qx, qz)) out.push([x, z, i]);
        }
      }
    }
    return out;
  }

  const SPAN = 40;   // -40..40 マスの、人が入れるマス全部を1地点ずつ
  const sets = [];
  for (let z = -SPAN; z <= SPAN; z++) {
    for (let x = -SPAN; x <= SPAN; x++) {
      if (!cellUsed(x, z)) continue;
      const ds = doorsFrom(x, z);
      if (ds.length > 0) sets.push(ds);
    }
  }

  // 扉の総数の分布
  const lens = sets.map((s) => s.length);
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  const hist = new Map();
  for (const n of lens) hist.set(n, (hist.get(n) ?? 0) + 1);
  const bars = [...hist.keys()].sort((a, b) => a - b)
    .map((n) => `${n}枚:${((hist.get(n) / lens.length) * 100).toFixed(1)}%`);
  console.log("");
  console.log(`1地点から見える扉 ${sets.length}地点 / 平均 ${avg.toFixed(2)}枚 / 最大 ${Math.max(...lens)}枚`);
  console.log(`  分布 ${bars.join(" ")}`);

  // 卓数を振って、重複の出方を改善前後で比べる
  function measure(pick, R) {
    let dup = 0, over = 0, worst = 0, adjSame = 0, adjAll = 0;
    for (const ds of sets) {
      const cols = ds.map(([x, z, i]) => pick(x, z, i, R));
      const count = new Map();
      for (const c of cols) count.set(c, (count.get(c) ?? 0) + 1);
      for (const v of count.values()) if (v > worst) worst = v;
      dup += ds.length - count.size;
      over += Math.min(ds.length, R) - count.size;      // 鳩の巣の下限からの超過
      for (let p = 0; p < ds.length; p++) {
        for (let q = p + 1; q < ds.length; q++) {
          // 同じマスか隣のマスにある扉どうし。ここが同じ卓だと、並んだ2枚に
          // 同じ卓名が出て、見た瞬間に壊れて見える。いちばん効く指標。
          if (Math.max(Math.abs(ds[p][0] - ds[q][0]), Math.abs(ds[p][1] - ds[q][1])) > 1) continue;
          adjAll++;
          if (cols[p] === cols[q]) adjSame++;
        }
      }
    }
    const n = sets.length;
    return { dup: dup / n, over: over / n, worst, adj: adjSame / adjAll };
  }

  console.log("卓の重複（1地点あたりの平均。重複 = 見えた扉の枚数 − 出てきた卓の種類数）");
  for (const R of [3, 7, 12, 30]) {
    const floor = lens.reduce((a, D) => a + Math.max(0, D - R), 0) / lens.length;
    const a = measure(oldRoom, R), b = measure(newRoom, R);
    const f = (v) => v.toFixed(2);
    console.log(
      `  卓${String(R).padStart(2)}: 下限 ${f(floor)} ／ 重複 ${f(a.dup)} → ${f(b.dup)}` +
      ` ／ 下限からの超過 ${f(a.over)} → ${f(b.over)}` +
      ` ／ 同じ卓の最多 ${a.worst} → ${b.worst}` +
      ` ／ 隣り合う扉が同卓 ${(a.adj * 100).toFixed(1)}% → ${(b.adj * 100).toFixed(1)}%`,
    );
  }
  console.log(
    "  ※ 下限は標本ごとに max(0, 扉数 − 卓数) を出して平均したもの。" +
    "平均扉数から卓数を引くやり方は下限を低く見積もる（扉数に分布があるため）。",
  );
}

// ── 壁の穴: 廊下から「見えてはいけない場所」へ抜けられないか ────────────
//
// マスの1辺は 3.00 だが、壁板の幅は通路と同じ 2.00 しかない。差の 1.00 がマスと
// マスの境目の「壁の厚み」の区画で、その 1.00 四方の角を 4 つのマスが 0.50 ずつ
// 分け合う。ところが Kit_Core は +X / -Z 側の隅柱 1 本しか持っていない。
// 隣のマスの柱は 1 マスぶん先の角を埋めるので、README にあった
// 「隣のマスの柱が残り3隅を埋める」は成り立たず、**まっすぐな廊下でもマスの
// 境目ごとに 0.5m 幅・天井まで届く縦穴が開く**。
//
// 目線の高さを横切る部品（壁板と隅柱）はどれも床から天井まで通っているので、
// 高さ 1.55m の断面だけ見れば足りる。そこを 5cm の升目にして、廊下の起点から
// 実体の無いところを塗り広げ、「見えてよい場所」の外へ出たら穴があるとみなす。
// 塗り広げは視線より広く回り込むので、これで漏れ 0 なら見えないことも保証できる。
{
  const D4 = [["N", 0, -1, 0], ["E", 1, 0, -Math.PI / 2],
              ["S", 0, 1, Math.PI], ["W", -1, 0, Math.PI / 2]];
  const cellUsed = (x, z) => D4.some((d) => edgeOpen(x, z, d[0]));
  // GLB から測った実寸（目線 1.55m を横切るもの）。扉の壁板も Kit_Wall と同じ。
  const WALL = { x0: -1.000, x1: 1.000, z0: -1.140, z1: -1.000 };
  const POST = { x0: 1.000, x1: 1.500, z0: -1.500, z1: -1.000 };

  const R = 8, G = 0.05;
  const LO = -(R + 1) * CELL, HI = (R + 1) * CELL;
  const N = Math.round((HI - LO) / G);
  const at = (i, j) => j * N + i;

  function fill(arr, x0, x1, z0, z1) {
    const i0 = Math.max(0, Math.ceil((x0 - LO) / G)), i1 = Math.min(N - 1, Math.floor((x1 - LO) / G));
    const j0 = Math.max(0, Math.ceil((z0 - LO) / G)), j1 = Math.min(N - 1, Math.floor((z1 - LO) / G));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) arr[at(i, j)] = 1;
  }
  function place(arr, box, cx, cz, rot) {
    const c = Math.round(Math.cos(rot)), s = Math.round(Math.sin(rot));
    const pts = [[box.x0, box.z0], [box.x1, box.z0], [box.x0, box.z1], [box.x1, box.z1]]
      .map(([x, z]) => [x * c + z * s, -x * s + z * c]);
    const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
    fill(arr, cx * CELL + Math.min(...xs), cx * CELL + Math.max(...xs),
              cz * CELL + Math.min(...zs), cz * CELL + Math.max(...zs));
  }

  // 見えてよい場所: 通れるマスの通路断面 ＋ 開いた辺の連結部
  const want = new Uint8Array(N * N);
  for (let z = -R - 1; z <= R + 1; z++) {
    for (let x = -R - 1; x <= R + 1; x++) {
      if (!cellUsed(x, z)) continue;
      fill(want, x * CELL - HALF_W, x * CELL + HALF_W, z * CELL - HALF_W, z * CELL + HALF_W);
      if (edgeOpen(x, z, "E")) {
        fill(want, x * CELL + HALF_W, (x + 1) * CELL - HALF_W, z * CELL - HALF_W, z * CELL + HALF_W);
      }
      if (edgeOpen(x, z, "S")) {
        fill(want, x * CELL - HALF_W, x * CELL + HALF_W, z * CELL + HALF_W, (z + 1) * CELL - HALF_W);
      }
    }
  }

  function run(postRots) {
    const solid = new Uint8Array(N * N);
    let posts = 0;
    for (let z = -R - 1; z <= R + 1; z++) {
      for (let x = -R - 1; x <= R + 1; x++) {
        if (!cellUsed(x, z)) continue;
        for (const rot of postRots) { place(solid, POST, x, z, rot); posts++; }
        for (const d of D4) if (!edgeOpen(x, z, d[0])) place(solid, WALL, x, z, d[3]);
      }
    }
    let sx = 0, sz = 0;
    outer: for (let r = 0; r <= R; r++) {
      for (let z = -r; z <= r; z++) {
        for (let x = -r; x <= r; x++) if (cellUsed(x, z)) { sx = x; sz = z; break outer; }
      }
    }
    const seen = new Uint8Array(N * N);
    const start = at(Math.round((sx * CELL - LO) / G), Math.round((sz * CELL - LO) / G));
    const q = [start];
    seen[start] = 1;
    let leaks = 0, spot = null;
    const edge = Math.round(CELL / G);          // 調べる範囲の縁は判定から外す
    for (let h = 0; h < q.length; h++) {
      const p = q[h], i = p % N, j = (p / N) | 0;
      if (i > edge && i < N - edge && j > edge && j < N - edge && want[p] === 0) {
        leaks++;
        if (spot === null) spot = `(${(LO + i * G).toFixed(2)}, ${(LO + j * G).toFixed(2)})`;
      }
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const np = at(ni, nj);
        if (seen[np] === 1 || solid[np] === 1) continue;
        seen[np] = 1;
        q.push(np);
      }
    }
    return { posts, leaks, area: leaks * G * G, spot };
  }

  const one = run([0]);                                              // GLB のまま（1本）
  const four = run([0, Math.PI / 2, Math.PI, -Math.PI / 2]);          // corridor-view.js の置き方
  console.log("");
  console.log(`壁の穴（${R * 2 + 1}×${R * 2 + 1}マス / ${G * 100}cm 刻み / 目線 1.55m の断面）`);
  console.log(
    `  隅柱を GLB のまま 1 本だけ置く: 柱 ${one.posts} 本 / ` +
    `見えてはいけない所へ漏れ ${one.leaks} 点 = ${one.area.toFixed(1)} m²` +
    (one.spot ? ` 例 ${one.spot}` : ""),
  );
  console.log(
    `  四隅ぶん 4 本置く（いまの corridor-view.js）: 柱 ${four.posts} 本 / ` +
    `漏れ ${four.leaks} 点 = ${four.area.toFixed(1)} m²`,
  );
  console.log(
    four.leaks === 0
      ? "  → 廊下の外は一切見えない。壁に穴は無い"
      : "  → まだ穴がある。隅柱の置き方か壁板の寸法を見直すこと",
  );
}
