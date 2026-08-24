/**
 * 反射神経バトル「REFLEX」
 *
 * ============================================================================
 * これはサンドボックスで動くゲームの実装例です。
 * 「宴 -EN-」のサンドボックスゲーム実行基盤（docs/design/game-sandbox.md）向けに
 * チームが書いたサンプルで、公式スコアには算入されません（同設計書 方針3）。
 * このファイル全体が runner（public/sandbox/runner.js）の new Function に文字列として
 * 渡され、iframe sandbox="allow-scripts"（allow-same-origin なし）の中だけで動きます。
 * 使えるのはグローバル EN の API だけで、親の DOM にも WebSocket にも直接は触れません
 * （触ろうとしても隔離により失敗します）。
 *
 * プロトタイプ（proto/games/reflex.js）からの移植。設計書の確定 API（§3.2）に合わせて
 * EN.setScore(n) を EN.setStatus(text) に置き換えている（方針3・付録A）。
 * ============================================================================
 *
 * ルール:
 *   - 全5ラウンド。ホストが進行を握る。
 *   - ラウンドが始まると画面が灰色になる。ランダムな待ち時間（1.2〜4.0秒）の
 *     あと、ホストが全員へ「今！」の合図を配信し、画面が緑になる。
 *   - 緑になってから最も速くタップ（またはスペース）した人が 3点。
 *     2位が 2点、3位以下は 1点。
 *   - 緑になる前に押すとフライングで、そのラウンドは 0点。
 *   - 最終ラウンド後に総合順位を表示する。
 *   - ここでの得点はこのゲームの中だけのもので、宴の公式スコアではない（方針3）。
 *
 * 通信（EN.send で全員に配る。自分には返ってこない点に注意）:
 *   { k:"round",  r }                      ホスト→全員: ラウンド開始（待機フェーズ）
 *   { k:"go",     r }                      ホスト→全員: 合図
 *   { k:"tap",    r, rt }                  各自→全員: 反応時間ms（rt<0 はフライング）
 *   { k:"result", r, rows, scores }        ホスト→全員: ラウンド結果と累計スコア
 *   { k:"final",  scores }                 ホスト→全員: 最終結果
 */

"use strict";

var TOTAL_ROUNDS = 5;
var GO_TIMEOUT_MS = 4000; // 合図から締め切るまで
var WAIT_MIN_MS = 1200;
var WAIT_MAX_MS = 4000;
var W = EN.size.width;
var H = EN.size.height;

/** ゲーム状態 */
var g = {
  me: null, // 自分の id
  isHost: false,
  players: {}, // id -> nickname
  order: [], // 表示順を安定させるための id 配列

  phase: "lobby", // lobby | wait | go | result | final
  round: 0,
  goAt: 0, // 合図を受け取ったローカル時刻（performance.now）
  tapped: false, // このラウンドで自分が押したか
  myRt: null,

  rows: [], // 直近ラウンドの結果 [{ id, rt }]
  scores: {}, // id -> 累計点（このゲーム内だけの点。宴の公式スコアではない）
  message: "画面をタップして開始（ホストのみ）",
  flash: 0, // 演出用の残り時間

  // ホスト専用の進行管理
  hostTimer: null, // setTimeout のハンドル
  hostTaps: {}, // このラウンドで集めた id -> rt
};

// -----------------------------------------------------------------------------
// ユーティリティ
// -----------------------------------------------------------------------------

/** 名前を引く（未知の id でも落ちないようにする） */
function nameOf(id) {
  var n = g.players[id];
  return typeof n === "string" && n.length > 0 ? n : String(id).slice(0, 6);
}

/** 参加者を登録する */
function addPlayer(id, nickname) {
  if (!Object.prototype.hasOwnProperty.call(g.players, id)) g.order.push(id);
  g.players[id] = nickname;
  if (typeof g.scores[id] !== "number") g.scores[id] = 0;
}

/** 参加者を外す */
function removePlayer(id) {
  delete g.players[id];
  g.order = g.order.filter(function (x) { return x !== id; });
}

/**
 * 全員に配りつつ、自分にも同じ処理を適用する。
 * EN.send は自分には返ってこないので、ホストが出したメッセージは
 * ローカルにも手で適用する必要がある。
 */
function broadcast(msg) {
  EN.send(msg);
  apply(g.me, msg);
}

/** ホスト用タイマーを張り替える */
function hostSchedule(ms, fn) {
  if (g.hostTimer !== null) clearTimeout(g.hostTimer);
  g.hostTimer = setTimeout(function () {
    g.hostTimer = null;
    fn();
  }, ms);
}

/** ホスト用タイマーを止める（EN.onEnd での後片付け用） */
function hostCancel() {
  if (g.hostTimer !== null) {
    clearTimeout(g.hostTimer);
    g.hostTimer = null;
  }
}

// -----------------------------------------------------------------------------
// ホストの進行
// -----------------------------------------------------------------------------

/** ラウンドを始める */
function hostStartRound(r) {
  if (!EN.isHost) return;
  g.hostTaps = {};
  broadcast({ k: "round", r: r });
  var wait = WAIT_MIN_MS + Math.random() * (WAIT_MAX_MS - WAIT_MIN_MS);
  hostSchedule(wait, function () {
    if (!EN.isHost) return;
    broadcast({ k: "go", r: r });
    // 合図から一定時間で締め切る
    hostSchedule(GO_TIMEOUT_MS, function () { hostFinishRound(r); });
  });
}

/** ラウンドを締めて結果を配る */
function hostFinishRound(r) {
  if (!EN.isHost) return;
  if (g.phase === "result" || g.round !== r) return;

  // 押さなかった人は「時間切れ」として rt = -2 で並べる
  var rows = [];
  for (var i = 0; i < g.order.length; i += 1) {
    var id = g.order[i];
    var rt = Object.prototype.hasOwnProperty.call(g.hostTaps, id) ? g.hostTaps[id] : -2;
    rows.push({ id: id, rt: rt });
  }
  // 有効な反応（rt >= 0）だけを速い順に並べ、そのあとに失格を置く
  rows.sort(function (a, b) {
    if (a.rt >= 0 && b.rt >= 0) return a.rt - b.rt;
    if (a.rt >= 0) return -1;
    if (b.rt >= 0) return 1;
    return b.rt - a.rt;
  });

  var rank = 0;
  for (var j = 0; j < rows.length; j += 1) {
    if (rows[j].rt < 0) continue;
    var gain = rank === 0 ? 3 : rank === 1 ? 2 : 1;
    g.scores[rows[j].id] = (g.scores[rows[j].id] || 0) + gain;
    rank += 1;
  }

  var scores = g.order.map(function (id) {
    return { id: id, nickname: nameOf(id), score: g.scores[id] || 0 };
  });

  broadcast({ k: "result", r: r, rows: rows, scores: scores });

  // 次のラウンドへ、または終了
  hostSchedule(2600, function () {
    if (!EN.isHost) return;
    if (r >= TOTAL_ROUNDS) {
      broadcast({ k: "final", scores: scores });
    } else {
      hostStartRound(r + 1);
    }
  });
}

// -----------------------------------------------------------------------------
// 受信したメッセージの適用（自分が出したものも同じ関数を通る）
// -----------------------------------------------------------------------------

/** 受け取った値が想定の形かを確かめる。壊れていたら無視する */
function apply(from, msg) {
  if (msg === null || typeof msg !== "object") return;
  if (typeof msg.k !== "string") return;

  switch (msg.k) {
    case "round":
      if (typeof msg.r !== "number") return;
      g.round = msg.r;
      g.phase = "wait";
      g.tapped = false;
      g.myRt = null;
      g.rows = [];
      g.message = "まだ押すな…";
      break;

    case "go":
      if (typeof msg.r !== "number" || msg.r !== g.round) return;
      if (g.phase !== "wait") return;
      g.phase = "go";
      g.goAt = performance.now();
      g.flash = 0.35;
      g.message = "今！";
      break;

    case "tap":
      // ホストだけが集計に使う。他の人は表示にも使わない（結果配信を待つ）
      if (typeof msg.r !== "number" || typeof msg.rt !== "number") return;
      if (!EN.isHost || msg.r !== g.round) return;
      if (Object.prototype.hasOwnProperty.call(g.hostTaps, from)) return; // 先勝ち
      g.hostTaps[from] = msg.rt;
      // 全員押したら締め切りを待たずに確定させる
      if (g.order.every(function (id) {
        return Object.prototype.hasOwnProperty.call(g.hostTaps, id);
      })) {
        hostFinishRound(g.round);
      }
      break;

    case "result": {
      if (typeof msg.r !== "number" || !Array.isArray(msg.rows)) return;
      g.phase = "result";
      g.rows = msg.rows.filter(function (row) {
        return row !== null && typeof row === "object" && typeof row.id === "string" &&
          typeof row.rt === "number";
      });
      applyScores(msg.scores);
      var mine = g.rows.filter(function (row) { return row.id === g.me; })[0];
      g.message = mine === undefined
        ? "結果"
        : mine.rt < 0
        ? (mine.rt === -1 ? "フライング！" : "時間切れ")
        : mine.rt.toFixed(0) + " ms";
      break;
    }

    case "final":
      g.phase = "final";
      applyScores(msg.scores);
      g.message = "ゲーム終了";
      break;

    default:
      break;
  }
}

/** サーバー経由で来たスコア表を取り込む（形が違えば無視） */
function applyScores(scores) {
  if (!Array.isArray(scores)) return;
  for (var i = 0; i < scores.length; i += 1) {
    var s = scores[i];
    if (s === null || typeof s !== "object") continue;
    if (typeof s.id !== "string" || typeof s.score !== "number") continue;
    g.scores[s.id] = s.score;
    if (typeof s.nickname === "string" && s.nickname.length > 0) addPlayer(s.id, s.nickname);
  }
  // 自分の得点は親のヘッダーにも出す。あくまでこのゲーム内だけの点で、
  // 宴の公式スコアではないため、そう誤認されない文言にする（方針3・PRチェックリスト §6.4）
  if (g.me !== null && typeof g.scores[g.me] === "number") {
    EN.setStatus("REFLEX 得点（このゲーム内のみ）: " + g.scores[g.me]);
  }
}

// -----------------------------------------------------------------------------
// 入力
// -----------------------------------------------------------------------------

function onPress() {
  if (g.phase === "lobby") {
    // 開始はホストだけが握る
    if (EN.isHost) {
      EN.log("ホストとしてゲームを開始します");
      hostStartRound(1);
    } else {
      g.message = "ホストの開始を待っています";
    }
    return;
  }
  if (g.phase !== "wait" && g.phase !== "go") return;
  if (g.tapped) return;
  g.tapped = true;

  if (g.phase === "wait") {
    // フライング
    g.myRt = -1;
    g.message = "フライング！";
    EN.send({ k: "tap", r: g.round, rt: -1 });
    if (EN.isHost) apply(g.me, { k: "tap", r: g.round, rt: -1 });
    return;
  }

  var rt = performance.now() - g.goAt;
  g.myRt = rt;
  g.message = rt.toFixed(0) + " ms";
  EN.send({ k: "tap", r: g.round, rt: rt });
  if (EN.isHost) apply(g.me, { k: "tap", r: g.round, rt: rt });
}

// -----------------------------------------------------------------------------
// 描画
// -----------------------------------------------------------------------------

/** フェーズごとの背景色 */
function stageColor() {
  if (g.phase === "go") return "#1f9b4b";
  if (g.phase === "wait") return g.tapped ? "#6b2230" : "#3a3f4d";
  if (g.phase === "final") return "#2b3a6b";
  return "#242a36";
}

function render(ctx, dt) {
  if (g.flash > 0) g.flash = Math.max(0, g.flash - dt);

  // 背景
  ctx.fillStyle = "#171b24";
  ctx.fillRect(0, 0, W, H);

  // メインステージ（左）
  var stageW = W - 150;
  ctx.fillStyle = stageColor();
  ctx.fillRect(0, 0, stageW, H);

  // 合図の瞬間だけ白くフラッシュさせる
  if (g.flash > 0) {
    ctx.fillStyle = "rgba(255,255,255," + (g.flash / 0.35 * 0.5).toFixed(3) + ")";
    ctx.fillRect(0, 0, stageW, H);
  }

  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 13px system-ui, sans-serif";
  var header = g.phase === "lobby"
    ? "REFLEX — 反射神経バトル"
    : g.phase === "final"
    ? "最終結果"
    : "ラウンド " + g.round + " / " + TOTAL_ROUNDS;
  ctx.fillText(header, stageW / 2, 26);

  ctx.font = "bold 34px system-ui, sans-serif";
  ctx.fillText(g.message, stageW / 2, H / 2 + 4);

  ctx.font = "12px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  var hint = g.phase === "lobby"
    ? (EN.isHost ? "タップ / スペースで開始" : "ホストの開始待ち")
    : g.phase === "wait"
    ? "緑になったら押す"
    : g.phase === "go"
    ? "押せ！"
    : g.phase === "result"
    ? "次のラウンドまで少し待つ"
    : "お疲れさま";
  ctx.fillText(hint, stageW / 2, H / 2 + 34);

  // 直近ラウンドの上位を出す
  if (g.phase === "result") {
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "left";
    for (var i = 0; i < Math.min(3, g.rows.length); i += 1) {
      var row = g.rows[i];
      var label = row.rt < 0
        ? (row.rt === -1 ? "フライング" : "時間切れ")
        : row.rt.toFixed(0) + "ms";
      ctx.fillStyle = row.id === g.me ? "#ffe08a" : "rgba(255,255,255,0.8)";
      ctx.fillText((i + 1) + ". " + nameOf(row.id) + "  " + label, 14, H - 52 + i * 15);
    }
  }

  // スコアボード（右）。あくまでゲーム内の点であることが分かるよう見出しに明記する
  ctx.fillStyle = "#12161f";
  ctx.fillRect(stageW, 0, W - stageW, H);
  ctx.textAlign = "left";
  ctx.fillStyle = "#8b93a7";
  ctx.font = "bold 11px system-ui, sans-serif";
  ctx.fillText("SCORE（このゲーム内）", stageW + 12, 22);

  var ranked = g.order.slice().sort(function (a, b) {
    return (g.scores[b] || 0) - (g.scores[a] || 0);
  });
  ctx.font = "12px system-ui, sans-serif";
  for (var j = 0; j < ranked.length && j < 10; j += 1) {
    var id = ranked[j];
    ctx.fillStyle = id === g.me ? "#ffe08a" : "#dfe4ee";
    var nm = nameOf(id);
    if (nm.length > 8) nm = nm.slice(0, 8);
    ctx.fillText(nm, stageW + 12, 44 + j * 20);
    ctx.textAlign = "right";
    ctx.fillText(String(g.scores[id] || 0), W - 12, 44 + j * 20);
    ctx.textAlign = "left";
  }

  ctx.fillStyle = "#5c6478";
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillText(EN.isHost ? "host" : "guest", stageW + 12, H - 12);
}

// -----------------------------------------------------------------------------
// 組み立て
// -----------------------------------------------------------------------------

EN.onStart(function (info) {
  g.me = info.youId;
  g.isHost = info.isHost;
  for (var i = 0; i < info.peers.length; i += 1) {
    addPlayer(info.peers[i].id, info.peers[i].nickname);
  }
  addPlayer(info.youId, nameOf(info.youId));
  EN.setStatus("REFLEX 得点（このゲーム内のみ）: 0");
  g.message = info.joinedLate
    ? "進行中のゲームに途中参加しました"
    : info.isHost
    ? "タップで開始"
    : "ホストの開始待ち";
  EN.log(
    "REFLEX 開始準備完了 / 参加者 " + g.order.length + "人 / host=" + info.isHost +
      " / joinedLate=" + info.joinedLate,
  );
});

EN.onPeer(function (ev) {
  if (ev.kind === "join") {
    addPlayer(ev.id, ev.nickname);
    EN.log(ev.nickname + " が参加しました");
  } else {
    removePlayer(ev.id);
    EN.log(ev.nickname + " が退出しました");
  }
});

EN.onMessage(function (from, msg) {
  apply(from, msg);
});

EN.onInput(function (input) {
  if (input.type === "pointerdown") onPress();
  else if (input.type === "key" && (input.key === " " || input.key === "Enter")) onPress();
});

// ホストが終了する / 親が iframe を畳む直前に呼ばれる。張ったタイマーを片付けておく
EN.onEnd(function () {
  hostCancel();
});

EN.draw(render);
