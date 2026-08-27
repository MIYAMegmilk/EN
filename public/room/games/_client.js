/**
 * クライアント専用ゲームの共通ヘルパー（設計書 docs/design/games-unified.md）
 *
 * `public/room/games/<id>.js` から `import { ... } from "./_client.js";` で使う。
 * ここに置いてあるのは「どのクライアント専用ゲームでも要る雑用」だけで、
 * ゲームのルールは一切知らない。
 *
 * ゲームIDにならない名前（先頭 `_`）にしてあるので、カタログから読み込まれることは無い。
 */

// ---------------------------------------------------------------------------
// DOM（innerHTML は使わない。CLAUDE.md セキュリティ基準 / 設計書 §3.2）
// ---------------------------------------------------------------------------

/** テキストだけを持つ要素を作る。text はユーザー由来でも安全（textContent） */
export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className !== undefined) node.className = className;
  return node;
}

/** 子要素をすべて取り除く */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---------------------------------------------------------------------------
// 中継イベント（gameView.events）
// ---------------------------------------------------------------------------

/**
 * 中継ログの差分を取り出す器を作る。
 *
 * サーバーは view のたびに「直近N件」をまるごと配ってくるので、
 * 連番 `n` を覚えておいて、まだ処理していないものだけを返す。
 * 中継ログには上限があり、混んでいると取りこぼすことがある（設計書の定義3）。
 * 取りこぼしても壊れない作りにすること。
 */
export function createRelayReader() {
  let seen = 0;
  return {
    /**
     * view から未処理のイベントだけを古い順で取り出す。
     * @param {unknown} view gameView.view
     * @returns {{ n: number, from: string, payload: unknown }[]}
     */
    take(view) {
      const events = readArray(view, "events");
      const fresh = [];
      for (const raw of events) {
        if (raw === null || typeof raw !== "object") continue;
        const n = raw.n;
        if (typeof n !== "number" || !Number.isFinite(n) || n <= seen) continue;
        if (typeof raw.from !== "string") continue;
        fresh.push({ n, from: raw.from, payload: raw.payload });
      }
      fresh.sort((a, b) => a.n - b.n);
      if (fresh.length > 0) seen = fresh[fresh.length - 1].n;
      return fresh;
    },
    /** 取りこぼしを許して読み直したいときに、覚えている位置を戻す */
    reset() {
      seen = 0;
    },
  };
}

/**
 * view から配列フィールドを安全に取り出す。形が違えば空配列。
 * view はサーバー経由とはいえ、中身（payload）は他人のブラウザ由来なので必ず確かめる
 */
export function readArray(view, key) {
  if (view === null || typeof view !== "object") return [];
  const value = view[key];
  return Array.isArray(value) ? value : [];
}

/** view から数値フィールドを取り出す。形が違えば fallback */
export function readNumber(view, key, fallback) {
  if (view === null || typeof view !== "object") return fallback;
  const value = view[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 名簿から表示名を引く。未知のIDは「誰か」。
 * 返る文字列はユーザー由来なので、必ず textContent で描くこと
 */
export function nameOf(view, id) {
  for (const p of readArray(view, "players")) {
    if (p !== null && typeof p === "object" && p.id === id && typeof p.name === "string") {
      return p.name;
    }
  }
  return "誰か";
}

// ---------------------------------------------------------------------------
// 他人から届く payload の検証（設計書 §9 / 雛形の規約7）
// ---------------------------------------------------------------------------

/**
 * 中継 payload から「種別」を取り出す。オブジェクトでない・k が文字列でないなら null。
 * 受け取る側は必ずこれで種別を確かめてから中身を読む
 */
export function kindOf(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return typeof payload.k === "string" ? payload.k : null;
}

/** payload の整数フィールドを取り出す。型違い・範囲外・非整数は null */
export function intField(payload, key, min, max) {
  if (payload === null || typeof payload !== "object") return null;
  const value = payload[key];
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

// ---------------------------------------------------------------------------
// 決定的な乱数（サーバーの nextSeed / randomFloat と同じ xorshift32）
// ---------------------------------------------------------------------------

/** 種が 0 のときの代替値。server/games/module.ts の SEED_FALLBACK と同じ */
const SEED_FALLBACK = 0x9e3779b9;

/**
 * view.seed から決定的な乱数列を作る。
 *
 * seed は卓の全員に同じ値が配られるので、これを使えば
 * **通信なしで全員の進行を一致させられる**（出題順・合図の時刻など）。
 * 逆に「自分だけの盤面」でよいなら Math.random() を使ってよい。
 */
export function createRng(seed) {
  let x = (seed >>> 0) === 0 ? SEED_FALLBACK : seed >>> 0;
  const next = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
  return {
    /** 0 以上 1 未満 */
    float: () => next() / 0x1_0000_0000,
    /**
     * min 以上 max 未満の整数。
     * 範囲が空（max <= min）でも **種を1つ進める**。サーバーの randomInt が
     * そうしているためで、ここを揃えないと空範囲を1回通しただけで
     * 以降の列が卓の全員で食い違う
     */
    int: (min, max) => {
      const span = Math.floor(max) - Math.floor(min);
      const r = next() / 0x1_0000_0000;
      if (span <= 0) return Math.floor(min);
      return Math.floor(min) + Math.floor(r * span);
    },
    /** 配列を決定的に混ぜた新しい配列（Fisher-Yates） */
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor((next() / 0x1_0000_0000) * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// 画面まわり
// ---------------------------------------------------------------------------

/**
 * ゲーム1本ぶんの外枠を作って container に差す。
 * 「点は付かない」断り書き（設計書の定義2）を必ず出すので、これを使えば書き忘れない。
 *
 * @returns {{ root: HTMLElement, body: HTMLElement, status: HTMLElement }}
 */
export function createShell(container, title) {
  const root = el("div", null, "clientgame");
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "8px";
  // 器に高さがあればそれを使い切る（高さが決まっていない器では auto と同じ扱いになる）。
  // minHeight:0 が無いと、中身が縮めず器からはみ出す
  root.style.height = "100%";
  root.style.minHeight = "0";
  root.style.boxSizing = "border-box";

  const head = el("h3", title);
  head.style.margin = "0";
  root.appendChild(head);

  const note = el("p", "このあそびの点は宴の得点には入りません");
  note.style.margin = "0";
  note.style.fontSize = "12px";
  note.style.opacity = "0.7";
  root.appendChild(note);

  // 遊ぶところ。余った高さはここが引き取る（大きい器では主役が大きくなる）
  const body = el("div");
  body.style.display = "flex";
  body.style.flexDirection = "column";
  body.style.flex = "1 1 auto";
  body.style.minHeight = "0";
  root.appendChild(body);

  const status = el("p", "");
  status.style.margin = "0";
  status.style.minHeight = "1.2em";
  root.appendChild(status);

  container.appendChild(root);
  return { root, body, status };
}

/**
 * canvas ビットマップの総画素数の上限。
 *
 * 表示が大きいほど内部解像度も上げるが、際限なく上げるとメモリと塗り直しの負荷が効く
 * （1画素4バイトなので 2048×2048 で約16MiB）。2048 は 2D/WebGL どちらの実装でも
 * まず確保できる辺の長さなので、ここを頭打ちにしておけば高 dpr の大画面でも破綻しない
 */
const MAX_CANVAS_PIXELS = 2048 * 2048;
/** devicePixelRatio の上限。これ以上は見た目がほとんど変わらず、面積だけが増える */
const MAX_DPR = 3;

/**
 * 論理サイズ w×h の canvas を作る（devicePixelRatio 対応）。
 * 返る ctx は論理座標で描けるよう、あらかじめ拡大してある。
 *
 * 大きさは器なり（固定の px 上限は置かない）。幅と高さの両方に収まるよう
 * max-width / max-height を効かせ、比率は object-fit: contain が守る。
 * 器に差し込んだら autoFitCanvas を呼び、表示サイズに内部解像度を追従させること
 */
export function createCanvas(w, h) {
  const canvas = document.createElement("canvas");
  const ratio = Math.min(MAX_DPR, Math.max(1, globalThis.devicePixelRatio || 1));
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  canvas.style.width = "100%";
  canvas.style.maxWidth = "100%";
  canvas.style.maxHeight = "100%";
  canvas.style.minHeight = "0";
  canvas.style.flex = "0 1 auto";
  canvas.style.aspectRatio = `${w} / ${h}`;
  canvas.style.objectFit = "contain";
  canvas.style.touchAction = "manipulation";
  canvas.style.display = "block";
  const ctx = canvas.getContext("2d");
  if (ctx !== null) ctx.scale(ratio, ratio);
  return { canvas, ctx, width: w, height: h };
}

/**
 * canvas の内部解像度（ビットマップ）を、いま表示されている大きさに合わせる。
 *
 * **canvas.width への代入はビットマップも 2D の変換行列も消す**。
 * 論理サイズ w×h のまま描き続けられるよう、ここで必ず行列を掛け直す
 * （掛け直しを忘れると、以後 1倍で左上に縮んで描かれる）。
 * 消えたビットマップの描き直しは呼び出し側の仕事（autoFitCanvas の onResize）。
 *
 * @returns {boolean} 実際に作り直したら true。同じ大きさなら何もせず false
 */
export function fitCanvasBitmap(canvas, ctx, w, h) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(MAX_DPR, Math.max(1, globalThis.devicePixelRatio || 1));
  // 表示は object-fit: contain。絵が出るのは箱に収まる w:h の矩形なので、その倍率を使う。
  // 箱が 0 のとき（隠れている・まだ measure されていない）は等倍で置いておき、
  // 見えるようになったときの通知で作り直す
  const contain = Math.min(rect.width / w, rect.height / h);
  let scale = Number.isFinite(contain) && contain > 0 ? contain * dpr : dpr;
  // 面積の上限で頭打ちにする（大画面 × 高 dpr で内部解像度が暴走しないように）
  const pixels = w * h * scale * scale;
  if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
  // 1px 未満に潰れても 0 にはしない（canvas.width = 0 は描画が全部無効になる）
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  if (ctx !== null) ctx.setTransform(width / w, 0, 0, height / h, 0, 0);
  return true;
}

/**
 * canvas の表示サイズを見張り、内部解像度を追い掛けさせる。
 * **返る stop() を unmount で必ず呼ぶこと**（規約3。解除し忘れると mount のたびに溜まる）。
 *
 * @param {(() => void)} [onResize] 作り直したときだけ呼ばれる。消えた絵を描き直す用
 */
export function autoFitCanvas(canvas, ctx, w, h, onResize) {
  fitCanvasBitmap(canvas, ctx, w, h);
  if (typeof ResizeObserver !== "function") return { stop() {} };
  const observer = new ResizeObserver(() => {
    // ResizeObserver は続けて何度も発火する。大きさが変わっていなければ何もしない
    if (!fitCanvasBitmap(canvas, ctx, w, h)) return;
    if (typeof onResize === "function") onResize();
  });
  observer.observe(canvas);
  return {
    stop() {
      observer.disconnect();
    },
  };
}

/**
 * pointerdown の位置を canvas の論理座標に直す。
 * CSS で伸縮していても、論理サイズ（createCanvas の w/h）基準の座標が返る。
 * object-fit: contain の余白（レターボックス）を除いてから直すので、
 * 器の縦横比が w:h とずれていてもずれない
 */
export function pointerPos(canvas, event, w, h) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { x: -1, y: -1 };
  const scale = Math.min(rect.width / w, rect.height / h);
  if (!Number.isFinite(scale) || scale <= 0) return { x: -1, y: -1 };
  return {
    x: (event.clientX - rect.left - (rect.width - w * scale) / 2) / scale,
    y: (event.clientY - rect.top - (rect.height - h * scale) / 2) / scale,
  };
}

/**
 * requestAnimationFrame のループを回す。
 * 返る stop() を unmount で必ず呼ぶこと（雛形の規約3）
 *
 * @param {(dt: number) => void} step dt は前フレームからの経過秒（最大 0.1 秒に丸める）
 */
export function createLoop(step) {
  let handle = 0;
  let last = 0;
  let running = true;
  const frame = (now) => {
    if (!running) return;
    const dt = last === 0 ? 0 : Math.min(0.1, (now - last) / 1000);
    last = now;
    step(dt);
    handle = requestAnimationFrame(frame);
  };
  handle = requestAnimationFrame(frame);
  return {
    stop() {
      running = false;
      if (handle !== 0) cancelAnimationFrame(handle);
      handle = 0;
    },
  };
}

/**
 * 画像を読み込む。`public/assets/games/<id>/` 配下のファイルを渡す。
 * 本体の CSP は `img-src 'self' data:` なので、同一オリジンの画像は追加設定なしで読める。
 * 読めなかった場合も落ちないよう、失敗は null で返す
 */
export function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.addEventListener("load", () => resolve(img), { once: true });
    img.addEventListener("error", () => resolve(null), { once: true });
    img.src = src;
  });
}
