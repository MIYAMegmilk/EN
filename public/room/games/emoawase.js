/**
 * 絵合わせ — クライアント専用ゲーム（設計書 docs/design/games-unified.md）
 *
 * **「画像ファイルを置いたら、そのまま使える」ことを示すための1本。**
 * 絵は `public/assets/games/emoawase/*.svg`（このリポジトリの自作。CREDITS.md 参照）に
 * 置いてあり、ここからは `/assets/games/emoawase/<名前>.svg` で普通に読むだけ。
 * 本体の CSP は `img-src 'self' data:` なので、同一オリジンの画像に追加の設定は要らない。
 *
 * ルール:
 *   - 3×4 の12枚（6組）を裏返しに並べる。2枚めくって同じ絵なら取れる。
 *   - 盤面は `view.seed` から作るので **卓の全員が同じ並び**。同じ盤で速さを競う。
 *   - 全部そろえたらタイムを卓に流す。早い順に並べて表示する。
 *   - 終わらせるのはホストの「すすめる」（skipPhase）。押すと卓はロビーへ戻る。
 *   - **ここでの成績は宴の公式スコアではない**（クライアント専用ゲームの定義2）。
 *
 * 通信（中継。1人1ゲームにつき1件だけ）:
 *   { k: "done", ms }   各自 → 全員: 全部そろえるのにかかった時間（ms）
 */

import {
  clear,
  createRelayReader,
  createRng,
  createShell,
  el,
  intField,
  kindOf,
  loadImage,
  nameOf,
  readNumber,
} from "./_client.js";

/** 絵の種類。ファイル名がそのまま組の識別子になる */
const FACES = ["tokkuri", "ochoko", "edamame", "yakitori", "chochin", "yunomi"];
const BACK = "back";
const ASSET_DIR = "/assets/games/emoawase";
const COLS = 4;

/** 裏返すまでの待ち（ms） */
const FLIP_BACK_MS = 800;
/** 記録として受け付ける最長時間（ms） */
const MAX_MS = 30 * 60 * 1000;

/** 絵のファイル名 → 表示名（読み上げ・代替テキスト用） */
const FACE_LABELS = {
  tokkuri: "とっくり",
  ochoko: "おちょこ",
  edamame: "えだまめ",
  yakitori: "やきとり",
  chochin: "ちょうちん",
  yunomi: "ゆのみ",
};

export function mount(container, api) {
  const shell = createShell(container, "絵合わせ");

  const grid = el("div");
  grid.style.display = "grid";
  grid.style.gridTemplateColumns = `repeat(${COLS}, 1fr)`;
  grid.style.gap = "6px";
  grid.style.maxWidth = "360px";
  shell.body.appendChild(grid);

  const board = el("ol");
  board.style.margin = "8px 0 0";
  board.style.paddingLeft = "1.4em";
  shell.root.appendChild(board);

  const relay = createRelayReader();

  const g = {
    /** 12枚の絵（index 順）。null なら未初期化 */
    cards: null,
    /** 取れた札の index */
    matched: new Set(),
    /** いま表になっている index（最大2枚） */
    open: [],
    /** 札のボタン要素 */
    buttons: [],
    /** 開始時刻（サーバー時刻・epoch ms） */
    startedAt: 0,
    /** 自分の記録（ms）。未達成は null */
    myMs: null,
    sent: false,
    /** 他人の記録 [{ id, ms }] */
    results: [],
    view: null,
    ended: false,
    /** 裏返しのタイマー。unmount で必ず止める（規約3） */
    flipTimer: 0,
    disposed: false,
  };

  /** 画像は先に読み込んでおく。読めなくても落とさない（loadImage は失敗を null で返す） */
  const preloaded = Promise.all(
    [...FACES, BACK].map((name) => loadImage(`${ASSET_DIR}/${name}.svg`)),
  );

  /** 盤面を作る。seed から決まるので全員同じ並びになる */
  function buildBoard(seed) {
    const rng = createRng(seed);
    g.cards = rng.shuffle([...FACES, ...FACES]);
    clear(grid);
    g.buttons = [];
    for (let i = 0; i < g.cards.length; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.style.padding = "0";
      btn.style.border = "none";
      btn.style.background = "transparent";
      btn.style.cursor = "pointer";
      btn.style.lineHeight = "0";
      btn.dataset.index = String(i);
      const img = document.createElement("img");
      img.src = `${ASSET_DIR}/${BACK}.svg`;
      img.alt = "うら";
      img.width = 100;
      img.height = 100;
      img.style.width = "100%";
      img.style.height = "auto";
      img.style.borderRadius = "8px";
      img.draggable = false;
      btn.appendChild(img);
      grid.appendChild(btn);
      g.buttons.push(btn);
    }
    paint();
  }

  /** いまの状態を札に反映する（骨組みは作り直さない。規約5） */
  function paint() {
    if (g.cards === null) return;
    for (let i = 0; i < g.buttons.length; i++) {
      const btn = g.buttons[i];
      const img = btn.firstChild;
      if (!(img instanceof HTMLImageElement)) continue;
      const faceUp = g.matched.has(i) || g.open.includes(i);
      const face = g.cards[i];
      const src = faceUp ? `${ASSET_DIR}/${face}.svg` : `${ASSET_DIR}/${BACK}.svg`;
      if (!img.src.endsWith(src)) img.src = src;
      img.alt = faceUp ? (FACE_LABELS[face] ?? face) : "うら";
      btn.style.opacity = g.matched.has(i) ? "0.45" : "1";
      btn.disabled = g.ended || g.matched.has(i) || g.myMs !== null;
    }
  }

  function onGridClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest("button");
    if (btn === null || !grid.contains(btn)) return;
    const index = Number(btn.dataset.index);
    if (!Number.isInteger(index)) return;
    flip(index);
  }
  grid.addEventListener("click", onGridClick);

  function flip(index) {
    if (g.cards === null || g.ended || g.myMs !== null) return;
    if (g.matched.has(index) || g.open.includes(index)) return;
    if (g.open.length >= 2) return;
    g.open.push(index);
    paint();
    if (g.open.length < 2) return;

    const [a, b] = g.open;
    if (g.cards[a] === g.cards[b]) {
      g.matched.add(a);
      g.matched.add(b);
      g.open = [];
      paint();
      checkCleared();
      return;
    }
    // そろわなければ少し見せてから裏に戻す
    g.flipTimer = setTimeout(() => {
      g.flipTimer = 0;
      if (g.disposed) return;
      g.open = [];
      paint();
    }, FLIP_BACK_MS);
    updateStatus();
  }

  function checkCleared() {
    if (g.cards === null || g.matched.size < g.cards.length) {
      updateStatus();
      return;
    }
    g.myMs = Math.max(0, Math.round(api.serverNow() - g.startedAt));
    if (!g.sent) {
      g.sent = true;
      // 中継は1ゲームにつきここ1回だけ
      api.send({ k: "done", ms: Math.min(MAX_MS, g.myMs) });
    }
    record(api.youId, g.myMs);
    updateStatus();
    paint();
  }

  function updateStatus() {
    if (g.cards === null) {
      shell.status.textContent = "絵をよみこんでいます…";
      return;
    }
    if (g.myMs !== null) {
      shell.status.textContent = `そろった！ ${formatMs(g.myMs)}`;
      return;
    }
    shell.status.textContent = `そろった組 ${g.matched.size / 2} / ${FACES.length}`;
  }

  function formatMs(ms) {
    const sec = ms / 1000;
    return `${sec.toFixed(1)}秒`;
  }

  /** 記録を1件積む。同じ人の2件目は無視する */
  function record(id, ms) {
    if (g.results.some((r) => r.id === id)) return;
    g.results.push({ id, ms });
    g.results.sort((a, b) => a.ms - b.ms);
    renderBoard();
  }

  /** 順位表。名前はユーザー由来なので textContent（en の規約） */
  function renderBoard() {
    clear(board);
    for (const row of g.results) {
      const label = row.id === api.youId ? `${nameOf(g.view, row.id)}（あなた）` : nameOf(g.view, row.id);
      board.appendChild(el("li", `${label} — ${formatMs(row.ms)}`));
    }
  }

  // 画像が揃ってから盤を出す（読み込み中に押されて空札が見えるのを避ける）
  let pendingSeed = null;
  preloaded.then(() => {
    if (g.disposed) return;
    if (pendingSeed !== null && g.cards === null) buildBoard(pendingSeed);
    updateStatus();
  });

  updateStatus();

  return {
    update(view) {
      g.view = view;
      g.ended = view !== null && typeof view === "object" && view.ended === true;
      const seed = readNumber(view, "seed", 0);
      const startedAt = readNumber(view, "startedAt", 0);
      if (g.startedAt === 0 && startedAt > 0) g.startedAt = startedAt;
      if (g.cards === null) {
        pendingSeed = seed;
        preloaded.then(() => {
          if (g.disposed || g.cards !== null) return;
          buildBoard(seed);
          updateStatus();
        });
      }
      // 他人から届く payload は形を確かめてから使う（想定外は黙って捨てる）
      for (const event of relay.take(view)) {
        if (event.from === api.youId) continue;
        if (kindOf(event.payload) !== "done") continue;
        const ms = intField(event.payload, "ms", 0, MAX_MS);
        if (ms === null) continue;
        record(event.from, ms);
      }
      renderBoard();
      paint();
    },

    unmount() {
      g.disposed = true;
      if (g.flipTimer !== 0) clearTimeout(g.flipTimer);
      g.flipTimer = 0;
      grid.removeEventListener("click", onGridClick);
      clear(container);
    },
  };
}
