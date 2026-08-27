/**
 * 反射神経バトル「REFLEX」— クライアント専用ゲーム（設計書 docs/design/games-unified.md）
 *
 * `public/games/reflex.js`（iframe サンドボックス版）からの移植。
 *
 * 移植で変えたところ（ここが新方式の勘所）:
 *   旧版は「ホスト役のブラウザが round / go / result を全員へ配る」作りで、
 *   ホストが落ちると進行ごと止まり、通信量もラウンドごとに何往復もしていた。
 *   新版は **進行を通信で配らない**。`view.seed` と `view.startedAt` は卓の全員に
 *   同じ値が配られるので、「第 r ラウンドの合図が何時何分何秒か」を各自が
 *   同じ計算で導く（createRng(seed)）。中継するのは「自分がいつ押したか」だけ。
 *   結果としてホスト役が要らなくなり、中継は1人1ラウンド1件で済む。
 *
 * ルール:
 *   - 全5ラウンド。ラウンドが始まると画面が灰色になり、1.2〜4.0秒後に緑になる。
 *   - 緑になってから最も速く押した人が3点、2位が2点、3位以下は1点。
 *   - 緑になる前に押すとフライングで、そのラウンドは0点。
 *   - 全ラウンド後に総合順位を出す。終わらせるのはホストの「すすめる」（skipPhase）。
 *   - **ここでの得点は宴の公式スコアではない**（クライアント専用ゲームの定義2）。
 *
 * 通信（中継。1人1ラウンドにつき1件だけ）:
 *   { k: "t", r, rt }   各自 → 全員: 第 r ラウンドの反応時間ms（rt < 0 はフライング）
 *
 * 中継ログには上限があるので、古いラウンドのイベントは押し出されて消える。
 * そのため累計点は **届いたそばから各自が積む**（後からログを読み直して復元しない）。
 * 途中参加した人は、参加より前のラウンドの点を持たない。これは仕様（設計書の定義3）。
 */

import {
  clear,
  createLoop,
  createRelayReader,
  createRng,
  createShell,
  el,
  intField,
  kindOf,
  nameOf,
  readNumber,
} from "./_client.js";

const TOTAL_ROUNDS = 5;
/** ラウンド開始から灰色で待たせる最短・最長（ms）。移植元と同じ */
const WAIT_MIN_MS = 1200;
const WAIT_MAX_MS = 4000;
/** ラウンド頭の予告（ms） */
const LEAD_MS = 2500;
/** 合図のあと、結果を見せてから次のラウンドへ移るまで（ms） */
const AFTER_MS = 4000;
/** 1ラウンドの長さ（ms）。待ち時間の長短にかかわらず固定にして、全員の時計を揃える */
const ROUND_MS = LEAD_MS + WAIT_MAX_MS + AFTER_MS;
/** 合図から受け付ける締め切り（ms） */
const GO_TIMEOUT_MS = 4000;
/**
 * ラウンドを締めるまでの猶予（ms）。
 * 締め切りは各自の api.serverNow() で判定するので、時計のずれと中継の遅れで
 * 「締切ぎわのタップが、送った本人には入って他人には入らない」ズレが起きる。
 * 猶予を挟むぶんだけ、そのズレを吸収する
 */
const SETTLE_GRACE_MS = 800;

export function mount(container, api) {
  const shell = createShell(container, "反射神経バトル REFLEX");

  const pad = el("div");
  // 高さは器なり。広い枠では余った高さを取り、狭い帯では文字とタップ域が潰れない
  // 下限（文字3行ぶん）まで縮む。160px は従来の高さで、伸び縮みの基準として残してある
  pad.style.height = "160px";
  pad.style.flex = "1 1 auto";
  pad.style.minHeight = "3em";
  pad.style.maxHeight = "100%";
  pad.style.borderRadius = "10px";
  pad.style.display = "flex";
  pad.style.alignItems = "center";
  pad.style.justifyContent = "center";
  pad.style.cursor = "pointer";
  pad.style.userSelect = "none";
  pad.style.touchAction = "manipulation";
  pad.style.background = "#3a4150";
  pad.setAttribute("role", "button");
  pad.setAttribute("tabindex", "0");
  const padText = el("strong", "はじまります");
  padText.style.fontSize = "20px";
  padText.style.color = "#ffffff";
  pad.appendChild(padText);
  shell.body.appendChild(pad);

  const board = el("ol");
  board.style.margin = "8px 0 0";
  board.style.paddingLeft = "1.4em";
  shell.root.appendChild(board);

  const relay = createRelayReader();

  const g = {
    /** 各ラウンドの待ち時間（ms）。seed から決まるので全員同じ */
    waits: [],
    /** 開始時刻（サーバー時刻・epoch ms） */
    startedAt: 0,
    /** id -> 累計点 */
    scores: new Map(),
    /** 集計済みのラウンド番号 */
    settled: new Set(),
    /** 集計待ちのラウンド: r -> Map(id -> rt) */
    taps: new Map(),
    /** 自分が押したラウンド */
    myTapped: new Set(),
    /** 直近ラウンドの並び（表示用）[{ id, rt }] */
    lastRows: [],
    lastRound: -1,
    view: null,
    ended: false,
    ready: false,
  };

  /** いま何ラウンド目か（0 始まり）。全ラウンド終わっていれば TOTAL_ROUNDS */
  function currentRound(now) {
    const elapsed = now - g.startedAt;
    if (elapsed < 0) return 0;
    return Math.min(TOTAL_ROUNDS, Math.floor(elapsed / ROUND_MS));
  }

  /** 第 r ラウンドの合図の時刻（epoch ms） */
  function goAt(r) {
    return g.startedAt + r * ROUND_MS + LEAD_MS + (g.waits[r] ?? WAIT_MIN_MS);
  }

  /** 押す */
  function onPress() {
    if (!g.ready || g.ended) return;
    const now = api.serverNow();
    const r = currentRound(now);
    if (r >= TOTAL_ROUNDS) return;
    if (g.myTapped.has(r)) return;
    const go = goAt(r);
    if (now < g.startedAt + r * ROUND_MS + LEAD_MS) return; // 予告中は無効
    g.myTapped.add(r);
    const rt = now < go ? -1 : Math.round(now - go);
    if (rt > GO_TIMEOUT_MS) return; // 締め切り後は送らない
    api.send({ k: "t", r, rt });
    // 自分のぶんは中継が返ってくる前に積んでおく（表示のもたつきを消す）
    recordTap(r, api.youId, rt);
  }

  function onKey(event) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    onPress();
  }

  pad.addEventListener("pointerdown", onPress);
  pad.addEventListener("keydown", onKey);

  /** 1件の反応時間を積む。同じ人の2件目は無視（最初の1件だけ有効） */
  function recordTap(r, id, rt) {
    if (g.settled.has(r)) return;
    let row = g.taps.get(r);
    if (row === undefined) {
      row = new Map();
      g.taps.set(r, row);
    }
    if (row.has(id)) return;
    row.set(id, rt);
  }

  /** ラウンド r を締めて加点する。1ラウンドにつき1回だけ */
  function settle(r) {
    if (g.settled.has(r)) return;
    g.settled.add(r);
    const row = g.taps.get(r) ?? new Map();
    g.taps.delete(r);
    const rows = [...row.entries()]
      .map(([id, rt]) => ({ id, rt }))
      .sort((a, b) => {
        // フライング（rt < 0）は最後尾へ
        if (a.rt < 0 && b.rt < 0) return 0;
        if (a.rt < 0) return 1;
        if (b.rt < 0) return -1;
        return a.rt - b.rt;
      });
    let rank = 0;
    for (const entry of rows) {
      if (entry.rt < 0) continue; // フライングは0点
      const gain = rank === 0 ? 3 : rank === 1 ? 2 : 1;
      g.scores.set(entry.id, (g.scores.get(entry.id) ?? 0) + gain);
      rank += 1;
    }
    g.lastRows = rows;
    g.lastRound = r;
  }

  /** 順位表を描き直す。名前はユーザー由来なので textContent */
  function renderBoard() {
    clear(board);
    const ids = new Set(g.scores.keys());
    for (const p of g.view !== null && Array.isArray(g.view.players) ? g.view.players : []) {
      if (p !== null && typeof p === "object" && typeof p.id === "string") ids.add(p.id);
    }
    const rows = [...ids]
      .map((id) => ({ id, score: g.scores.get(id) ?? 0 }))
      .sort((a, b) => b.score - a.score);
    for (const row of rows) {
      const label = row.id === api.youId ? `${nameOf(g.view, row.id)}（あなた）` : nameOf(g.view, row.id);
      board.appendChild(el("li", `${label} — ${row.score}点`));
    }
  }

  /** 画面（パッド）を今の時刻に合わせて描く */
  function renderPad() {
    if (!g.ready) {
      padText.textContent = "はじまります";
      pad.style.background = "#3a4150";
      return;
    }
    const now = api.serverNow();
    const r = currentRound(now);
    if (g.ended || r >= TOTAL_ROUNDS) {
      pad.style.background = "#2f3a4a";
      padText.textContent = "おわり";
      shell.status.textContent = "全5ラウンド終了。ホストが「すすめる」を押すまで結果を出しています";
      return;
    }
    const roundStart = g.startedAt + r * ROUND_MS;
    const go = goAt(r);
    if (now < roundStart + LEAD_MS) {
      pad.style.background = "#3a4150";
      padText.textContent = `第${r + 1}ラウンド 用意`;
    } else if (now < go) {
      pad.style.background = "#7a5c2e";
      padText.textContent = g.myTapped.has(r) ? "フライング！" : "まだ！";
    } else if (now < go + GO_TIMEOUT_MS) {
      pad.style.background = g.myTapped.has(r) ? "#2f6f3f" : "#2fae5a";
      padText.textContent = g.myTapped.has(r) ? "おした！" : "いま！";
    } else {
      pad.style.background = "#2f3a4a";
      padText.textContent = `第${r + 1}ラウンド 結果`;
    }
    shell.status.textContent = `第${Math.min(TOTAL_ROUNDS, r + 1)}／${TOTAL_ROUNDS}ラウンド` +
      (g.lastRound >= 0 ? ` ・ 前回の1位 ${describeWinner()}` : "");
  }

  function describeWinner() {
    const first = g.lastRows.find((row) => row.rt >= 0);
    if (first === undefined) return "なし";
    return `${nameOf(g.view, first.id)}（${first.rt}ms）`;
  }

  let lastBoardKey = "";
  const loop = createLoop(() => {
    if (g.ready) {
      const now = api.serverNow();
      const r = currentRound(now);
      // 合図から締め切り + 猶予を過ぎたラウンドは、その場で締める（時刻だけで決まる）
      for (let past = 0; past < r; past++) {
        if (now >= goAt(past) + GO_TIMEOUT_MS + SETTLE_GRACE_MS) settle(past);
      }
      if (r < TOTAL_ROUNDS && now >= goAt(r) + GO_TIMEOUT_MS + SETTLE_GRACE_MS) settle(r);
      const key = [...g.scores.entries()].map(([id, s]) => `${id}:${s}`).sort().join(",");
      if (key !== lastBoardKey) {
        lastBoardKey = key;
        renderBoard();
      }
    }
    renderPad();
  });

  return {
    update(view) {
      g.view = view;
      g.ended = view !== null && typeof view === "object" && view.ended === true;
      const startedAt = readNumber(view, "startedAt", 0);
      const seed = readNumber(view, "seed", 0);
      if (!g.ready && startedAt > 0) {
        g.startedAt = startedAt;
        // 全員が同じ seed から同じ待ち時間の列を作る（通信で配らない）
        const rng = createRng(seed);
        g.waits = [];
        for (let r = 0; r < TOTAL_ROUNDS; r++) {
          g.waits.push(rng.int(WAIT_MIN_MS, WAIT_MAX_MS + 1));
        }
        g.ready = true;
        renderBoard();
      }
      // 他人から届く payload は形を確かめてから使う（想定外は黙って捨てる）
      for (const event of relay.take(view)) {
        if (event.from === api.youId) continue;
        if (kindOf(event.payload) !== "t") continue;
        const r = intField(event.payload, "r", 0, TOTAL_ROUNDS - 1);
        const rt = intField(event.payload, "rt", -1, GO_TIMEOUT_MS);
        if (r === null || rt === null) continue;
        recordTap(r, event.from, rt);
      }
      renderBoard();
    },

    unmount() {
      loop.stop();
      pad.removeEventListener("pointerdown", onPress);
      pad.removeEventListener("keydown", onKey);
      clear(container);
    },
  };
}
