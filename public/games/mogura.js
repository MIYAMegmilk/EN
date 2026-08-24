/**
 * もぐらたたき「MOGURA」
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
 * ルール:
 *   - 1人でも最後まで遊べる（minPlayers: 1）。他の参加者がいなくても成立する。
 *   - 3×3 のマスのどこかにランダムでもぐらが出る。出ている間にタップ/クリックすると得点。
 *   - 空振りしても減点はしない（飲み会なので厳しくしない）。
 *   - 制限時間は30秒。残り時間を常に表示する。
 *   - 難易度は時間とともに緩やかに上がる（もぐらの表示時間が短くなり、後半は
 *     同時に2匹出ることがある）。やりすぎない範囲にとどめる。
 *   - 30秒経過したら終了し、最終スコアと簡単な評価文を出す。画面をタップすると
 *     再スタートできる。
 *   - ここでの得点はこのゲームの中だけのもので、宴の公式スコアではない（方針3）。
 *
 * 他の人がいるときの味付け（軽く1つだけ。凝った同期はしない）:
 *   - 終了時に自分の最終スコアを EN.send で共有する。
 *   - 他の人から届いた最終スコアを画面の隅に小さく出す（1人プレイの成立を妨げない）。
 *
 * 通信（EN.send で全員に配る。自分には返ってこない点に注意）:
 *   { k:"final", nickname, score }   各自→全員: 自分の最終スコア（表示専用。集計はしない）
 */

"use strict";

var GAME_SECONDS = 30; // 制限時間
var GRID = 3; // 3x3
var W = EN.size.width;
var H = EN.size.height;

// マス目のジオメトリ（正方形の盤面を画面中央に置く）
var BOARD = Math.min(W, H) - 40;
var BOARD_X = (W - BOARD) / 2;
var BOARD_Y = (H - BOARD) / 2 - 6;
var CELL = BOARD / GRID;

/** ゲーム状態 */
var g = {
  me: null, // 自分の id
  myNickname: "",

  phase: "ready", // ready | playing | over
  timeLeft: GAME_SECONDS, // 残り秒数
  elapsed: 0, // 経過秒数（難易度計算用）
  score: 0, // このゲーム内だけの得点

  // マス目ごとのもぐら状態。null = 出ていない。数値 = 残り表示秒数
  holes: makeHoles(),
  moleTimer: 0, // 次にもぐらの出し入れを判定するまでの残り秒数

  message: "画面をタップして開始",

  // 他プレイヤーの最終スコア表示（表示専用。届いた順に最大5件保持）
  peerResults: [], // [{ nickname, score }]
};

function makeHoles() {
  var arr = [];
  for (var i = 0; i < GRID * GRID; i += 1) arr.push(null);
  return arr;
}

// -----------------------------------------------------------------------------
// 難易度カーブ
// -----------------------------------------------------------------------------

/** 経過秒数から「もぐらが出ている時間（秒）」を求める。じわじわ短くする */
function moleShowDuration(elapsed) {
  var t = 1.1 - elapsed * 0.02; // 30秒で 0.5 秒まで下がる
  return Math.max(0.5, t);
}

/** 経過秒数から「次にもぐらを出すまでの間隔（秒）」を求める */
function spawnInterval(elapsed) {
  var t = 0.9 - elapsed * 0.012;
  return Math.max(0.45, t);
}

/** 後半だけ、まれに2匹同時に出す */
function spawnCount(elapsed) {
  if (elapsed > 15 && Math.random() < 0.35) return 2;
  return 1;
}

// -----------------------------------------------------------------------------
// ゲーム進行
// -----------------------------------------------------------------------------

function resetGame() {
  g.phase = "playing";
  g.timeLeft = GAME_SECONDS;
  g.elapsed = 0;
  g.score = 0;
  g.holes = makeHoles();
  g.moleTimer = 0;
  g.message = "";
  updateStatus();
}

/** 空いているマスにもぐらを出す */
function spawnMoles(count) {
  var empty = [];
  for (var i = 0; i < g.holes.length; i += 1) {
    if (g.holes[i] === null) empty.push(i);
  }
  var dur = moleShowDuration(g.elapsed);
  for (var n = 0; n < count && empty.length > 0; n += 1) {
    var pick = Math.floor(Math.random() * empty.length);
    var idx = empty[pick];
    empty.splice(pick, 1);
    g.holes[idx] = dur;
  }
}

/** 得点を表示用の状態文言に反映する。宴の公式スコアではないことが分かる文言にする */
function updateStatus() {
  EN.setStatus(
    "MOGURA 得点（このゲーム内のみ）: " + g.score + " / 残り " + Math.ceil(g.timeLeft) + "秒",
  );
}

function evaluate(score) {
  if (score >= 25) return "もぐら退治の達人！";
  if (score >= 15) return "なかなかやるね！";
  if (score >= 8) return "まずまずの成績";
  return "また挑戦してみよう";
}

function endGame() {
  g.phase = "over";
  g.timeLeft = 0;
  g.message = evaluate(g.score);
  EN.setStatus("MOGURA 最終得点（このゲーム内のみ）: " + g.score);
  // 他の参加者がいる場合だけ意味を持つ、軽い味付け（凝った同期はしない）
  EN.send({ k: "final", nickname: g.myNickname, score: g.score });
}

function tick(dt) {
  if (g.phase !== "playing") return;

  g.elapsed += dt;
  g.timeLeft -= dt;

  // もぐらごとの残り表示時間を減らし、尽きたら引っ込める
  for (var i = 0; i < g.holes.length; i += 1) {
    if (g.holes[i] === null) continue;
    g.holes[i] -= dt;
    if (g.holes[i] <= 0) g.holes[i] = null;
  }

  // 次のもぐら出現を判定する
  g.moleTimer -= dt;
  if (g.moleTimer <= 0) {
    spawnMoles(spawnCount(g.elapsed));
    g.moleTimer = spawnInterval(g.elapsed);
  }

  if (g.timeLeft <= 0) {
    endGame();
    return;
  }
  updateStatus();
}

// -----------------------------------------------------------------------------
// 入力
// -----------------------------------------------------------------------------

/** canvas 座標からマス目 index を求める。盤面の外なら -1 */
function cellAt(x, y) {
  if (x < BOARD_X || x >= BOARD_X + BOARD) return -1;
  if (y < BOARD_Y || y >= BOARD_Y + BOARD) return -1;
  var col = Math.floor((x - BOARD_X) / CELL);
  var row = Math.floor((y - BOARD_Y) / CELL);
  if (col < 0 || col >= GRID || row < 0 || row >= GRID) return -1;
  return row * GRID + col;
}

function onTap(x, y) {
  if (g.phase === "ready" || g.phase === "over") {
    resetGame();
    return;
  }
  if (g.phase !== "playing") return;

  var idx = cellAt(x, y);
  if (idx < 0) return;
  if (g.holes[idx] !== null) {
    g.holes[idx] = null; // 叩いたもぐらは即座に引っ込める
    g.score += 1;
    updateStatus();
  }
  // 空振りは減点しない（飲み会なので厳しくしない）
}

// -----------------------------------------------------------------------------
// 描画
// -----------------------------------------------------------------------------

function render(ctx, dt) {
  tick(dt);

  // 背景
  ctx.fillStyle = "#16211a";
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 15px system-ui, sans-serif";
  ctx.fillText("MOGURA — もぐらたたき", W / 2, 20);

  if (g.phase === "ready") {
    ctx.font = "14px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText("出てきたもぐらをタップ！ 制限時間30秒", W / 2, H / 2 - 10);
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.fillText("画面をタップして開始", W / 2, H / 2 + 20);
    drawBoard(ctx);
    return;
  }

  // 残り時間
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.fillStyle = g.timeLeft <= 5 ? "#ff8a8a" : "#dfe4ee";
  ctx.fillText("残り " + Math.max(0, Math.ceil(g.timeLeft)) + "秒", W / 2, 40);

  drawBoard(ctx);

  // スコア
  ctx.textAlign = "left";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.fillStyle = "#ffe08a";
  ctx.fillText("SCORE（このゲーム内） " + g.score, 12, H - 12);

  if (g.phase === "over") {
    // 半透明パネルで結果を出す
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, H / 2 - 46, W, 92);
    ctx.textAlign = "center";
    ctx.font = "bold 20px system-ui, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText("最終得点: " + g.score, W / 2, H / 2 - 14);
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(g.message, W / 2, H / 2 + 10);
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillText("タップでもう一度", W / 2, H / 2 + 32);
  }

  // 他の参加者の最終スコア（表示専用。画面の隅に小さく。いなければ何も出ない）
  if (g.peerResults.length > 0) {
    ctx.textAlign = "right";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    for (var i = 0; i < g.peerResults.length; i += 1) {
      var r = g.peerResults[i];
      ctx.fillText(r.nickname + ": " + r.score, W - 8, H - 12 - i * 13);
    }
    ctx.textAlign = "left";
  }
}

/** 3x3 の盤面ともぐらを描く */
function drawBoard(ctx) {
  for (var row = 0; row < GRID; row += 1) {
    for (var col = 0; col < GRID; col += 1) {
      var idx = row * GRID + col;
      var x = BOARD_X + col * CELL;
      var y = BOARD_Y + row * CELL;
      var pad = 5;

      // 穴（マス）
      ctx.fillStyle = "#2c1c12";
      roundRect(ctx, x + pad, y + pad, CELL - pad * 2, CELL - pad * 2, 10);
      ctx.fill();

      // もぐら
      if (g.holes[idx] !== null) {
        ctx.fillStyle = "#8a5a34";
        var cx = x + CELL / 2;
        var cy = y + CELL / 2;
        var r = (CELL - pad * 2) * 0.32;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        // 目
        ctx.fillStyle = "#1a1a1a";
        ctx.beginPath();
        ctx.arc(cx - r * 0.35, cy - r * 0.1, r * 0.14, 0, Math.PI * 2);
        ctx.arc(cx + r * 0.35, cy - r * 0.1, r * 0.14, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** 角丸の矩形パス（Canvas 標準に roundRect が無い環境向けの自前実装） */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// -----------------------------------------------------------------------------
// 組み立て
// -----------------------------------------------------------------------------

EN.onStart(function (info) {
  g.me = info.youId;
  // EN は自分自身のニックネームを渡してくれない（peers は自分以外の一覧）ので、
  // reflex.js の nameOf() と同じ流儀で id の先頭6文字を表示名の代わりに使う
  g.myNickname = String(info.youId).slice(0, 6);
  EN.setStatus("MOGURA 得点（このゲーム内のみ）: 0");
  g.message = "画面をタップして開始";
  EN.log("MOGURA 開始準備完了 / host=" + info.isHost + " / joinedLate=" + info.joinedLate);
});

EN.onMessage(function (_from, msg) {
  if (msg === null || typeof msg !== "object") return;
  if (msg.k !== "final") return;
  if (typeof msg.score !== "number") return;
  var nickname = typeof msg.nickname === "string" && msg.nickname.length > 0
    ? msg.nickname.slice(0, 10)
    : "誰か";
  g.peerResults.unshift({ nickname: nickname, score: msg.score });
  if (g.peerResults.length > 5) g.peerResults.length = 5;
});

EN.onInput(function (input) {
  if (input.type === "pointerdown") onTap(input.x, input.y);
});

// 後片付け。ホストが終了した / 親が iframe を畳む直前に呼ばれる。
// このゲームは setInterval/setTimeout を張らず draw の tick だけで進行しているので、
// フェーズを over にして draw ループ内の判定を止めておけば十分。
EN.onEnd(function () {
  g.phase = "over";
});

EN.draw(render);
