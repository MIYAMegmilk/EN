/**
 * もぐらたたき「MOGURA」— クライアント専用ゲーム（設計書 docs/design/games-unified.md）
 *
 * `public/games/mogura.js`（iframe サンドボックス版）からの移植。
 * サンドボックス基盤は廃止したので、いまはアプリのオリジンで動く普通の ES モジュール。
 * サーバー側のコードは無く、登録は server/games/index.ts の clientGame({...}) 1行だけ。
 *
 * ルール（移植元と同じ）:
 *   - 1人でも最後まで遊べる（minPlayers: 1）。
 *   - 3×3 のマスのどこかにもぐらが出る。出ている間に叩くと得点。空振りは減点しない。
 *   - 制限時間は30秒。難易度は時間とともに緩やかに上がる。
 *   - 終わったら最終得点と評価文を出す。もう一度押せば再挑戦できる。
 *   - **ここでの得点は宴の公式スコアではない**（クライアント専用ゲームの定義2）。
 *
 * 通信（中継。1ゲームにつき自分の最終得点1件だけ。これ以上は送らない）:
 *   { k: "final", s }   各自 → 全員: 自分の最終得点（表示専用。集計はしない）
 *
 * 盤面は各自バラバラでよいので view.seed は使わず Math.random() で進める
 * （全員の盤面を揃えたいゲームは createRng(view.seed) を使う）。
 */

import {
  autoFitCanvas,
  clear,
  createCanvas,
  createLoop,
  createRelayReader,
  createShell,
  el,
  intField,
  kindOf,
  nameOf,
  pointerPos,
} from "./_client.js";

const GAME_SECONDS = 30;
const GRID = 3;
const W = 420;
const H = 300;
const BOARD = Math.min(W, H) - 40;
const BOARD_X = (W - BOARD) / 2;
const BOARD_Y = (H - BOARD) / 2 - 6;
const CELL = BOARD / GRID;

/** 他人の結果を出す上限。増やすと画面が埋まる */
const PEER_MAX = 5;

export function mount(container, api) {
  const shell = createShell(container, "もぐらたたき MOGURA");
  const { canvas, ctx } = createCanvas(W, H);
  shell.body.appendChild(canvas);
  // 表示の大きさに内部解像度を追従させる（帯にも主役表示にも耐えるように）。
  // 盤面は毎フレーム描き直すので、作り直しの通知は要らない。stop() は unmount で必ず呼ぶ
  const canvasFit = autoFitCanvas(canvas, ctx, W, H);

  // 他の人の得点は副次的な文字。盤面の高さを奪わないよう shell.side へ入れる
  // （狭い器ではここが縮んで自前でスクロールする）
  const peerList = el("ul");
  peerList.style.margin = "0";
  peerList.style.paddingLeft = "1.2em";
  peerList.style.fontSize = "12px";
  peerList.style.opacity = "0.8";
  shell.side.appendChild(peerList);

  const relay = createRelayReader();

  /** 表示のためだけの状態。ゲームの勝敗をサーバーは持っていない */
  const g = {
    phase: "ready", // ready | playing | over
    timeLeft: GAME_SECONDS,
    elapsed: 0,
    score: 0,
    holes: makeHoles(),
    moleTimer: 0,
    message: "画面を押して開始",
    sent: false,
    /** 他の参加者の最終得点（届いた順・表示専用） */
    peers: [],
    /** 最後に受け取った view（名簿を引くのに使う） */
    view: null,
    ended: false,
  };

  function makeHoles() {
    return new Array(GRID * GRID).fill(null);
  }

  // --- 進行 -----------------------------------------------------------------

  function resetGame() {
    g.phase = "playing";
    g.timeLeft = GAME_SECONDS;
    g.elapsed = 0;
    g.score = 0;
    g.holes = makeHoles();
    g.moleTimer = 0;
    g.message = "";
    g.sent = false;
  }

  /** 経過秒数から「もぐらが出ている時間（秒）」。じわじわ短くする */
  function moleShowDuration(elapsed) {
    return Math.max(0.5, 1.1 - elapsed * 0.02);
  }

  /** 次にもぐらを出すまでの間隔（秒） */
  function spawnInterval(elapsed) {
    return Math.max(0.45, 0.9 - elapsed * 0.012);
  }

  /** 後半だけ、まれに2匹同時に出す */
  function spawnCount(elapsed) {
    return elapsed > 15 && Math.random() < 0.35 ? 2 : 1;
  }

  function spawnMoles(count) {
    const empty = [];
    for (let i = 0; i < g.holes.length; i++) {
      if (g.holes[i] === null) empty.push(i);
    }
    const dur = moleShowDuration(g.elapsed);
    for (let n = 0; n < count && empty.length > 0; n++) {
      const pick = Math.floor(Math.random() * empty.length);
      g.holes[empty[pick]] = dur;
      empty.splice(pick, 1);
    }
  }

  function evaluate(score) {
    if (score >= 25) return "もぐら退治の達人！";
    if (score >= 15) return "なかなかやるね！";
    if (score >= 8) return "まずまずの成績";
    return "また挑戦してみよう";
  }

  function finish() {
    g.phase = "over";
    g.timeLeft = 0;
    g.message = evaluate(g.score);
    // 中継は1ゲームにつきここ1回だけ。連打しても増えない
    if (!g.sent) {
      g.sent = true;
      api.send({ k: "final", s: g.score });
    }
  }

  function tick(dt) {
    if (g.phase !== "playing") return;
    g.elapsed += dt;
    g.timeLeft -= dt;
    for (let i = 0; i < g.holes.length; i++) {
      if (g.holes[i] === null) continue;
      g.holes[i] -= dt;
      if (g.holes[i] <= 0) g.holes[i] = null;
    }
    g.moleTimer -= dt;
    if (g.moleTimer <= 0) {
      spawnMoles(spawnCount(g.elapsed));
      g.moleTimer = spawnInterval(g.elapsed);
    }
    if (g.timeLeft <= 0) finish();
  }

  // --- 入力 -----------------------------------------------------------------

  function cellAt(x, y) {
    if (x < BOARD_X || x >= BOARD_X + BOARD) return -1;
    if (y < BOARD_Y || y >= BOARD_Y + BOARD) return -1;
    const col = Math.floor((x - BOARD_X) / CELL);
    const row = Math.floor((y - BOARD_Y) / CELL);
    if (col < 0 || col >= GRID || row < 0 || row >= GRID) return -1;
    return row * GRID + col;
  }

  function onPointerDown(event) {
    if (g.ended) return;
    const { x, y } = pointerPos(canvas, event, W, H);
    if (g.phase !== "playing") {
      resetGame();
      return;
    }
    const idx = cellAt(x, y);
    if (idx < 0 || g.holes[idx] === null) return;
    g.holes[idx] = null;
    g.score += 1;
  }
  canvas.addEventListener("pointerdown", onPointerDown);

  // --- 描画 -----------------------------------------------------------------

  function render() {
    if (ctx === null) return;
    ctx.fillStyle = "#16211a";
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 15px system-ui, sans-serif";
    ctx.fillText("MOGURA — もぐらたたき", W / 2, 22);

    if (g.phase === "ready") {
      ctx.font = "14px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText("出てきたもぐらを叩く！ 制限時間30秒", W / 2, H / 2 - 10);
      ctx.font = "bold 16px system-ui, sans-serif";
      ctx.fillText("画面を押して開始", W / 2, H / 2 + 20);
      drawBoard();
      return;
    }

    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.fillStyle = g.timeLeft <= 5 ? "#ff8a8a" : "#dfe4ee";
    ctx.fillText(`残り ${Math.max(0, Math.ceil(g.timeLeft))}秒`, W / 2, 42);

    drawBoard();

    ctx.textAlign = "left";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.fillStyle = "#ffe08a";
    ctx.fillText(`SCORE ${g.score}`, 12, H - 12);

    if (g.phase === "over") {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, H / 2 - 46, W, 92);
      ctx.textAlign = "center";
      ctx.font = "bold 20px system-ui, sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(`最終得点: ${g.score}`, W / 2, H / 2 - 14);
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText(g.message, W / 2, H / 2 + 10);
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillText("押すともう一度", W / 2, H / 2 + 32);
    }
  }

  function drawBoard() {
    if (ctx === null) return;
    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        const idx = row * GRID + col;
        const x = BOARD_X + col * CELL;
        const y = BOARD_Y + row * CELL;
        const pad = 5;
        ctx.fillStyle = "#2c1c12";
        roundRect(x + pad, y + pad, CELL - pad * 2, CELL - pad * 2, 10);
        ctx.fill();
        if (g.holes[idx] === null) continue;
        const cx = x + CELL / 2;
        const cy = y + CELL / 2;
        const r = (CELL - pad * 2) * 0.32;
        ctx.fillStyle = "#8a5a34";
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1a1a1a";
        ctx.beginPath();
        ctx.arc(cx - r * 0.35, cy - r * 0.1, r * 0.14, 0, Math.PI * 2);
        ctx.arc(cx + r * 0.35, cy - r * 0.1, r * 0.14, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** 角丸の矩形パス（roundRect が無い環境向けの自前実装） */
  function roundRect(x, y, w, h, r) {
    if (ctx === null) return;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** 他人の結果一覧を描き直す。ニックネームはユーザー由来なので textContent */
  function renderPeers() {
    clear(peerList);
    for (const peer of g.peers) {
      peerList.appendChild(el("li", `${peer.name}: ${peer.score}点`));
    }
  }

  const loop = createLoop((dt) => {
    tick(dt);
    render();
    shell.status.textContent = g.phase === "playing"
      ? `得点 ${g.score} / 残り ${Math.max(0, Math.ceil(g.timeLeft))}秒`
      : g.message;
  });

  return {
    update(view) {
      g.view = view;
      g.ended = view !== null && typeof view === "object" && view.ended === true;
      // 他人から届く payload は形を確かめてから使う（想定外は黙って捨てる）
      let changed = false;
      for (const event of relay.take(view)) {
        if (event.from === api.youId) continue;
        if (kindOf(event.payload) !== "final") continue;
        const score = intField(event.payload, "s", 0, 9999);
        if (score === null) continue;
        g.peers.unshift({ name: nameOf(view, event.from), score });
        if (g.peers.length > PEER_MAX) g.peers.length = PEER_MAX;
        changed = true;
      }
      if (changed) renderPeers();
    },

    unmount() {
      loop.stop();
      canvasFit.stop();
      canvas.removeEventListener("pointerdown", onPointerDown);
      clear(container);
    },
  };
}
