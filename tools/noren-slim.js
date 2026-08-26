/**
 * 暖簾モデル（public/assets/noren.glb）の減量。
 *
 *   deno run --allow-read --allow-write tools/noren-slim.js
 *
 * このモデルは 1.53MB あるが、ジオメトリ実体は 2,168 三角形しかない。
 * 中身を実測すると、容量のほぼ全部が Strip0..3（暖簾の布）に付いた
 * **46 個ずつのモーフターゲット**だった。ところが weights アニメーションは
 * キーが 2 つあるだけで、その値は両方とも全ウェイト 0.0000 になっている。
 * つまり途中で放棄されたクロスシムのベイクが書き出しに残ったまま、
 * 1 バイトも仕事をせずに 1.5MB を占めている。
 *
 * ベイク済みのアニメーションも落とす。カメラ・扉・布の動きは
 * noren-scene.js が自前の時間軸で作るようになったので、glb 側のトラックは
 * 使われないどころか「どちらが本物か」を分かりにくくするだけになる。
 * （元のトラックの数値は noren-scene.js の定数のコメントに書き残してある）
 *
 * 何度流しても結果は同じ。すでに減量済みのファイルに流すと「変更なし」で終わる。
 * Blender を経由しないのは、このモデルの .blend がリポジトリに無いのと、
 * 形そのものには手を入れる必要がないため。
 */

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

const MODEL_PATH = new URL("../public/assets/noren.glb", import.meta.url);

/** GLB を JSON チャンクとバイナリチャンクに分ける */
function parseGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error("GLB ではありません");
  if (view.getUint32(4, true) !== 2) throw new Error("glTF 2.0 ではありません");

  let json = null;
  let bin = new Uint8Array(0);
  let at = 12;
  while (at < bytes.byteLength) {
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === CHUNK_BIN) bin = body;
    at += 8 + length;
  }
  if (json === null) throw new Error("JSON チャンクがありません");
  return { json, bin };
}

/** 4バイト境界に合わせる。glTF はチャンクもアクセサも4の倍数で始まる決まり */
function pad4(n) {
  return (4 - (n % 4)) % 4;
}

function buildGlb(json, bin) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = pad4(jsonBytes.byteLength);
  const binPad = pad4(bin.byteLength);
  const total = 12 + 8 + jsonBytes.byteLength + jsonPad + 8 + bin.byteLength + binPad;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);

  let at = 12;
  view.setUint32(at, jsonBytes.byteLength + jsonPad, true);
  view.setUint32(at + 4, CHUNK_JSON, true);
  out.set(jsonBytes, at + 8);
  // JSON チャンクの詰め物は空白。0 で埋めるとパーサによっては JSON として読めない
  out.fill(0x20, at + 8 + jsonBytes.byteLength, at + 8 + jsonBytes.byteLength + jsonPad);
  at += 8 + jsonBytes.byteLength + jsonPad;

  view.setUint32(at, bin.byteLength + binPad, true);
  view.setUint32(at + 4, CHUNK_BIN, true);
  out.set(bin, at + 8);
  return out;
}

/**
 * 使われなくなったアクセサとバッファビューを捨てて、バイナリを詰め直す。
 * 参照を消しただけではファイルは小さくならない（実体がバイナリに残る）ので、
 * 生きている参照だけを辿って新しいバッファを組み立てる。
 */
function compact(json, bin) {
  const usedAccessors = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      for (const index of Object.values(prim.attributes)) usedAccessors.add(index);
      if (prim.indices !== undefined) usedAccessors.add(prim.indices);
    }
  }
  for (const skin of json.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined) usedAccessors.add(skin.inverseBindMatrices);
  }
  for (const anim of json.animations ?? []) {
    for (const s of anim.samplers) {
      usedAccessors.add(s.input);
      usedAccessors.add(s.output);
    }
  }

  const keptAccessors = [...usedAccessors].sort((a, b) => a - b);
  const accessorMap = new Map(keptAccessors.map((old, i) => [old, i]));

  const usedViews = new Set();
  for (const index of keptAccessors) {
    const a = json.accessors[index];
    if (a.bufferView !== undefined) usedViews.add(a.bufferView);
    if (a.sparse) {
      usedViews.add(a.sparse.indices.bufferView);
      usedViews.add(a.sparse.values.bufferView);
    }
  }

  const keptViews = [...usedViews].sort((a, b) => a - b);
  const viewMap = new Map(keptViews.map((old, i) => [old, i]));

  // 生きているバッファビューだけを順に並べ直す。中のバイトはそのまま写すので、
  // アクセサの byteOffset（ビューの中での位置）は書き換えなくてよい
  const chunks = [];
  const newViews = [];
  let cursor = 0;
  for (const index of keptViews) {
    const v = json.bufferViews[index];
    const start = v.byteOffset ?? 0;
    chunks.push(bin.subarray(start, start + v.byteLength));
    const copy = { ...v, byteOffset: cursor, byteLength: v.byteLength };
    delete copy.buffer;
    copy.buffer = 0;
    newViews.push(copy);
    cursor += v.byteLength;
    const padding = pad4(cursor);
    if (padding > 0) {
      chunks.push(new Uint8Array(padding));
      cursor += padding;
    }
  }

  const newBin = new Uint8Array(cursor);
  let at = 0;
  for (const c of chunks) {
    newBin.set(c, at);
    at += c.byteLength;
  }

  const newAccessors = keptAccessors.map((index) => {
    const a = { ...json.accessors[index] };
    if (a.bufferView !== undefined) a.bufferView = viewMap.get(a.bufferView);
    if (a.sparse) {
      a.sparse = {
        ...a.sparse,
        indices: { ...a.sparse.indices, bufferView: viewMap.get(a.sparse.indices.bufferView) },
        values: { ...a.sparse.values, bufferView: viewMap.get(a.sparse.values.bufferView) },
      };
    }
    return a;
  });

  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      for (const [name, index] of Object.entries(prim.attributes)) {
        prim.attributes[name] = accessorMap.get(index);
      }
      if (prim.indices !== undefined) prim.indices = accessorMap.get(prim.indices);
    }
  }
  for (const skin of json.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined) {
      skin.inverseBindMatrices = accessorMap.get(skin.inverseBindMatrices);
    }
  }
  for (const anim of json.animations ?? []) {
    for (const s of anim.samplers) {
      s.input = accessorMap.get(s.input);
      s.output = accessorMap.get(s.output);
    }
  }

  json.accessors = newAccessors;
  json.bufferViews = newViews;
  json.buffers = [{ byteLength: newBin.byteLength }];
  return newBin;
}

function main() {
  const before = Deno.readFileSync(MODEL_PATH);
  const { json, bin } = parseGlb(before);

  let morphTargets = 0;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      morphTargets += prim.targets?.length ?? 0;
      delete prim.targets;
    }
    delete mesh.weights;
    if (mesh.extras) {
      delete mesh.extras.targetNames;
      if (Object.keys(mesh.extras).length === 0) delete mesh.extras;
    }
  }
  for (const node of json.nodes ?? []) delete node.weights;

  const animations = json.animations?.length ?? 0;
  delete json.animations;

  if (morphTargets === 0 && animations === 0) {
    console.log("変更なし（すでに減量済み）");
    return;
  }

  const newBin = compact(json, bin);
  const after = buildGlb(json, newBin);
  Deno.writeFileSync(MODEL_PATH, after);

  const kb = (n) => (n / 1024).toFixed(0) + " KB";
  console.log(`モーフターゲット ${morphTargets} 個 / アニメーション ${animations} 本を除去`);
  console.log(`  ${kb(before.byteLength)} -> ${kb(after.byteLength)}  (${
    (100 * (1 - after.byteLength / before.byteLength)).toFixed(1)
  }% 減)`);
}

main();
