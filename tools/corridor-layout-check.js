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
