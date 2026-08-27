/**
 * お絵かき当て（ビューモジュール。docs/design/games-unified.md §2.7 / §3.2 / §8-17）
 *
 * 出題者だけに配られたお題を絵で伝え、ほかの人は**既存のチャットに答えを書いて**当てる。
 * 出題者は交代制で、参加者全員が1回ずつ描く。
 *
 * このファイルは表示専用である。お題の秘匿・正解判定・進行・描画履歴の保持はすべて
 * サーバー（server/games/draw.ts）にあり、ここは届いた view をそのまま絵にするだけ。
 *
 * サーバーとの契約（§2.2 / §2.7）:
 *   C2S: { t:"gameEvent", payload } … api.send(payload) で送る。payload は4種類だけ
 *     { k:"draw", s:<ストロークID>, c:<色番号 0..7>, w:<太さ番号 0..2>, p:[x,y,...] }
 *     { k:"end" }    … ストロークの終わり（サーバーはここで必ず配信する）
 *     { k:"undo" }   … 直近のストロークを消す
 *     { k:"clear" }  … 全部消す
 *     座標は 0〜479 の整数。1回の p は 64点まで
 *   S2C: { t:"gameView", gameId:"draw", view, deadline } … update(view, deadline)
 *
 * view の形（サーバーと確定済み）:
 *   {
 *     kind:"draw", phase:"draw"|"reveal"|"final",
 *     turn, totalTurns, drawerId, drawerName, youAreDrawer,
 *     topic: string|null,        // draw 中は**出題者にしか入らない**。reveal 以降は全員
 *     topicLength,               // お題の文字数（回答者向けヒント）
 *     strokes: [{ id, color, width, points:[x,y,...] }],  // 描画履歴の全量
 *     rev, pointCount, pointMax,
 *     correct: [{ playerId, nickname, order, points }],
 *     guesserCount, myCorrectOrder: number|null, myTurnPoints,
 *     result?: { turn, drawerId, drawerName, topic, correct, drawerPoints, aborted },
 *     players: [{ playerId, nickname, connected, correct, drawer }],
 *     standings: [{ playerId, nickname, score, rank }],
 *   }
 *
 * ---- 表示規約（§3.2 / §7 / CLAUDE.md セキュリティ基準。_template.js と共通）----
 * 1. ユーザー由来テキスト（ニックネーム・お題）は必ず textContent。innerHTML は使わない。
 * 2. 音を出さない（VC の会話にかぶせない）。
 * 3. unmount() で setInterval・addEventListener をすべて解除する。
 * 4. サーバーが唯一の状態機械。勝敗・進行をクライアントで判断しない。
 * 5. update は何度でも呼ばれる。**canvas を作り直すと描いた絵が消える**ので、
 *    骨組みは mount で1度だけ作り、update では中身だけ変える。
 * 6. 送信前にここでも範囲・点数を確かめる（サーバーでも検証されるが、無駄な往復を減らす）。
 *
 * index.html に専用 CSS が無いため、見た目は inline style と汎用クラス .btn で作る。
 */

/** 論理座標の一辺（サーバーの DRAW_COORD_MAX + 1 と同じ） */
const CANVAS_SIZE = 480;
/** 1チャンクに載せる点数の上限（サーバーの DRAW_MAX_CHUNK_POINTS と同じ） */
const MAX_CHUNK_POINTS = 64;
/** チャンクを送る間隔（ミリ秒）。10回/秒 + ストローク終わりで、gameEvent のソフト枠30件/秒に収まる */
const SEND_INTERVAL_MS = 100;
/** これ未満しか動いていない点は捨てる（高頻度な pointermove で点数を使い切らないため） */
const MIN_STEP = 2;
/**
 * canvas ビットマップの総画素数の上限。
 *
 * 表示が大きいほど内部解像度も上げるが、際限なく上げるとメモリと塗り直しの負荷が効く
 * （1画素4バイトなので 2048×2048 で約16MiB）。2048 は 2D の実装でもまず確保できる
 * 辺の長さなので、ここを頭打ちにしておけば高 dpr の大画面でも破綻しない
 */
const MAX_CANVAS_PIXELS = 2048 * 2048;
/** devicePixelRatio の上限。これ以上は見た目がほとんど変わらず、面積だけが増える */
const MAX_DPR = 3;

/** パレット。**並び順がサーバーの色番号（0..7）そのもの**なので、勝手に入れ替えないこと */
const COLORS = [
  "#222222",
  "#e74c3c",
  "#e67e22",
  "#f1c40f",
  "#2ecc71",
  "#3498db",
  "#9b59b6",
  "#ffffff",
];
/** 線の太さ。並び順がサーバーの太さ番号（0..2） */
const WIDTHS = [3, 8, 18];
/** 太さ選択ボタンの表示名 */
const WIDTH_LABELS = ["細", "中", "太"];

/**
 * @param {HTMLElement} container 専用の空要素
 * @param {{
 *   send: (payload: unknown) => void,
 *   youId: string,
 *   isHost: boolean,
 *   serverNow: () => number,
 * }} api
 */
export function mount(container, api) {
  // ---------------------------------------------------------------------------
  // 骨組み（mount で1度だけ組み立てる。規約5）
  // ---------------------------------------------------------------------------
  const root = document.createElement("div");
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "8px";
  // 器に高さがあればそれを使い切る（高さが決まっていない器では auto と同じ扱いになる）。
  // minHeight:0 が無いと、中身が縮めず器からはみ出す
  root.style.height = "100%";
  root.style.minHeight = "0";
  root.style.boxSizing = "border-box";

  const titleEl = el("h3", "お絵かき当て");
  titleEl.style.margin = "0";
  root.appendChild(titleEl);

  /** 「第N/Mターン ／ 出題者: だれそれ」 */
  const headEl = el("p", "");
  headEl.style.margin = "0";
  headEl.style.fontWeight = "700";
  root.appendChild(headEl);

  /** 残り時間 */
  const timerEl = el("p", "");
  timerEl.style.margin = "0";
  timerEl.style.opacity = "0.8";
  root.appendChild(timerEl);

  /** 役割に応じた案内（お題 or 「チャットに答えを書いてね」） */
  const roleEl = el("p", "");
  roleEl.style.margin = "0";
  roleEl.style.padding = "6px 8px";
  roleEl.style.borderRadius = "6px";
  roleEl.style.background = "rgba(127,127,127,0.12)";
  root.appendChild(roleEl);

  /** 自分が正解したときの本人向けフィードバック（正解の発言はチャットから消えるため） */
  const myResultEl = el("p", "");
  myResultEl.style.margin = "0";
  myResultEl.style.fontWeight = "700";
  myResultEl.style.color = "#1e8449";
  root.appendChild(myResultEl);

  // --- canvas（作り直さない。規約5） ---
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  // 大きさは器なり（固定の px 上限は置かない）。幅と高さの両方に収まるよう
  // max-width / max-height を効かせ、正方形の比率は object-fit: contain が守る
  canvas.style.width = "100%";
  canvas.style.maxWidth = "100%";
  canvas.style.maxHeight = "100%";
  canvas.style.minHeight = "0";
  canvas.style.flex = "0 1 auto";
  canvas.style.aspectRatio = "1 / 1";
  canvas.style.objectFit = "contain";
  // 枠線ぶんで器からはみ出さないようにする
  canvas.style.boxSizing = "border-box";
  canvas.style.background = "#ffffff";
  canvas.style.border = "1px solid rgba(127,127,127,0.5)";
  canvas.style.borderRadius = "6px";
  canvas.style.display = "block";
  // スマホで指を動かしたときに画面がスクロールしないようにする（タッチ対応の要）
  canvas.style.touchAction = "none";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "お絵かきの画面");
  root.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  // --- 道具箱（出題者のときだけ出す） ---
  const toolsBox = document.createElement("div");
  toolsBox.style.display = "flex";
  toolsBox.style.flexWrap = "wrap";
  toolsBox.style.gap = "6px";
  toolsBox.style.alignItems = "center";

  /** @type {HTMLButtonElement[]} */
  const colorBtns = [];
  COLORS.forEach((color, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.width = "26px";
    btn.style.height = "26px";
    btn.style.padding = "0";
    btn.style.borderRadius = "50%";
    btn.style.background = color;
    btn.style.cursor = "pointer";
    btn.setAttribute("aria-label", `色 ${index + 1}`);
    colorBtns.push(btn);
    toolsBox.appendChild(btn);
  });

  /** @type {HTMLButtonElement[]} */
  const widthBtns = [];
  WIDTHS.forEach((_, index) => {
    const btn = el("button", WIDTH_LABELS[index]);
    btn.type = "button";
    btn.className = "btn";
    widthBtns.push(btn);
    toolsBox.appendChild(btn);
  });

  const undoBtn = el("button", "ひとつ戻す");
  undoBtn.type = "button";
  undoBtn.className = "btn";
  toolsBox.appendChild(undoBtn);

  const clearBtn = el("button", "全部消す");
  clearBtn.type = "button";
  clearBtn.className = "btn";
  toolsBox.appendChild(clearBtn);

  root.appendChild(toolsBox);

  /** 「あと◯点ぶん描けます」／上限に達したときの注意 */
  const budgetEl = el("p", "");
  budgetEl.style.margin = "0";
  budgetEl.style.fontSize = "0.9em";
  budgetEl.style.opacity = "0.8";
  root.appendChild(budgetEl);

  // --- 正解者一覧 ---
  const correctBox = document.createElement("div");
  const correctHead = el("h4", "正解した人");
  correctHead.style.margin = "0 0 4px";
  correctBox.appendChild(correctHead);
  const correctList = document.createElement("ul");
  correctList.style.margin = "0";
  correctList.style.padding = "0";
  correctList.style.listStyle = "none";
  correctBox.appendChild(correctList);
  root.appendChild(correctBox);

  // --- 答え合わせ ---
  const resultBox = document.createElement("div");
  const answerEl = el("p", "");
  answerEl.style.margin = "0";
  answerEl.style.fontWeight = "700";
  answerEl.style.fontSize = "1.1em";
  resultBox.appendChild(answerEl);
  const resultNoteEl = el("p", "");
  resultNoteEl.style.margin = "0";
  resultBox.appendChild(resultNoteEl);
  root.appendChild(resultBox);

  // --- 順位表 ---
  const standingsBox = document.createElement("div");
  const standingsHead = el("h4", "得点");
  standingsHead.style.margin = "0 0 4px";
  standingsBox.appendChild(standingsHead);
  const standingsList = document.createElement("ul");
  standingsList.style.margin = "0";
  standingsList.style.padding = "0";
  standingsList.style.listStyle = "none";
  standingsBox.appendChild(standingsList);
  root.appendChild(standingsBox);

  container.appendChild(root);

  // ---------------------------------------------------------------------------
  // 表示のためだけの一時値（ゲームの状態はサーバーが持つ。規約4）
  // ---------------------------------------------------------------------------
  /** 直近の deadline（epoch ms） */
  let deadline = null;
  /** 直近に受け取った view（再描画のときに読む） */
  let lastView = null;
  /** 最後に canvas へ描いたときの版番号。変わったときだけ全再描画する */
  let renderedRev = -1;
  /** 最後に描いたターン番号（ターンが変わったらストロークIDを振り直す） */
  let renderedTurn = -1;
  /** いま描けるか（自分が出題者で、フェーズが draw） */
  let canDraw = false;
  /** 選択中の色番号・太さ番号 */
  let colorIndex = 0;
  let widthIndex = 1;
  /** 次に使うストロークID（サーバーは「増えていくこと」を要求する） */
  let nextStrokeId = 0;
  /** いま引いている線。{ id, color, width, points:[x,y,...] } / 引いていなければ null */
  let localStroke = null;
  /** まだ送っていない点（平坦な配列） */
  let outbox = [];
  /** ストロークの終わり（k:"end"）を送ったあと、次の view で localStroke を捨てる合図 */
  let awaitingFlush = false;
  /** ポインタ操作中のポインタID（マウス・タッチ・ペンを同じ経路で扱う） */
  let activePointerId = null;

  // ---------------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------------

  /** 1本のストロークを canvas へ引く。1点だけなら丸を打つ */
  function paintStroke(stroke) {
    if (ctx === null || stroke === null) return;
    const points = Array.isArray(stroke.points) ? stroke.points : [];
    if (points.length < 2) return;
    const color = COLORS[numberOrNull(stroke.color) ?? 0] ?? COLORS[0];
    const width = WIDTHS[numberOrNull(stroke.width) ?? 1] ?? WIDTHS[1];
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (points.length === 2) {
      ctx.beginPath();
      ctx.arc(points[0], points[1], width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0], points[1]);
    for (let i = 2; i + 1 < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
    ctx.stroke();
  }

  /** 履歴（view.strokes）から全再描画し、引きかけの線を上に重ねる */
  function redraw() {
    if (ctx === null) return;
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    const strokes = lastView !== null && Array.isArray(lastView.strokes) ? lastView.strokes : [];
    for (const stroke of strokes) paintStroke(stroke);
    // サーバーへ届く前の手元のインクを重ねる（往復待ちで線が遅れて見えないように）
    paintStroke(localStroke);
  }

  /**
   * canvas の内部解像度（ビットマップ）を、いま表示されている大きさに合わせる。
   *
   * **canvas.width への代入はビットマップも 2D の変換行列も消す**。
   * 論理座標（0..CANVAS_SIZE-1。サーバー正本と同じ）のまま描き続けられるよう、
   * ここで必ず行列を掛け直す。消えた絵の描き直しは呼び出し側の仕事。
   *
   * @returns {boolean} 実際に作り直したら true。同じ大きさなら何もせず false
   */
  function fitCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(MAX_DPR, Math.max(1, globalThis.devicePixelRatio || 1));
    // 表示は object-fit: contain。絵が出るのは箱に収まる正方形なので、その辺で倍率を決める。
    // 箱が 0 のとき（隠れている・まだ measure されていない）は等倍で置いておき、
    // 見えるようになったときの通知で作り直す
    const contain = Math.min(rect.width, rect.height) / CANVAS_SIZE;
    let scale = Number.isFinite(contain) && contain > 0 ? contain * dpr : dpr;
    // 面積の上限で頭打ちにする（大画面 × 高 dpr で内部解像度が暴走しないように）
    const pixels = CANVAS_SIZE * CANVAS_SIZE * scale * scale;
    if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    // 1px 未満に潰れても 0 にはしない（canvas.width = 0 は描画が全部無効になる）
    const side = Math.max(1, Math.round(CANVAS_SIZE * scale));
    if (canvas.width === side && canvas.height === side) return false;
    canvas.width = side;
    canvas.height = side;
    if (ctx !== null) ctx.setTransform(side / CANVAS_SIZE, 0, 0, side / CANVAS_SIZE, 0, 0);
    return true;
  }

  fitCanvas();
  /**
   * 表示の大きさを見張って内部解像度を追従させる。unmount で必ず disconnect する（規約3）。
   * ResizeObserver は続けて何度も発火するので、作り直したときだけ描き直す
   */
  const sizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
      if (!fitCanvas()) return;
      // 作り直したビットマップは白紙。update は rev が変わったときしか描き直さないので、
      // 版番号を無効にしたうえで、その場で描き直す（次の点が打たれるまで白紙にしない）
      renderedRev = -1;
      redraw();
    })
    : null;
  if (sizeObserver !== null) sizeObserver.observe(canvas);

  // ---------------------------------------------------------------------------
  // 入力（マウス・タッチ・ペンを Pointer Events でまとめて扱う）
  // ---------------------------------------------------------------------------

  /** 画面座標を論理座標（0..CANVAS_SIZE-1 の整数）へ直す */
  function toLogical(event) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    // 表示は object-fit: contain。正方形の絵は箱の中央に収まるので、
    // 余白（レターボックス）を除いてから論理座標に直す
    const side = Math.min(rect.width, rect.height);
    const left = rect.left + (rect.width - side) / 2;
    const top = rect.top + (rect.height - side) / 2;
    const x = Math.round((event.clientX - left) / side * CANVAS_SIZE);
    const y = Math.round((event.clientY - top) / side * CANVAS_SIZE);
    return {
      x: clamp(x, 0, CANVAS_SIZE - 1),
      y: clamp(y, 0, CANVAS_SIZE - 1),
    };
  }

  /** 上限に達していないか（サーバーでも弾かれるが、無駄な送信をしない。規約6） */
  function hasBudget() {
    if (lastView === null) return false;
    const used = numberOrNull(lastView.pointCount) ?? 0;
    const max = numberOrNull(lastView.pointMax) ?? 0;
    return used + outbox.length / 2 < max;
  }

  function onPointerDown(event) {
    if (!canDraw || activePointerId !== null) return;
    const point = toLogical(event);
    if (point === null) return;
    if (!hasBudget()) return;
    event.preventDefault();
    activePointerId = event.pointerId;
    // 前の線の後始末待ちは、新しい線を引き始めた時点で不要になる
    awaitingFlush = false;
    if (typeof canvas.setPointerCapture === "function") {
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // 捕捉できない環境でも描けること自体は変わらないので、握りつぶす
      }
    }
    localStroke = {
      id: nextStrokeId,
      color: colorIndex,
      width: widthIndex,
      points: [point.x, point.y],
    };
    outbox = [point.x, point.y];
    redraw();
  }

  function onPointerMove(event) {
    if (!canDraw || localStroke === null || event.pointerId !== activePointerId) return;
    const point = toLogical(event);
    if (point === null) return;
    event.preventDefault();
    const points = localStroke.points;
    const lastX = points[points.length - 2];
    const lastY = points[points.length - 1];
    // 細かすぎる動きは捨てる（点数の上限を無駄遣いしないため）
    if (Math.abs(point.x - lastX) < MIN_STEP && Math.abs(point.y - lastY) < MIN_STEP) return;
    if (!hasBudget()) {
      endStroke();
      return;
    }
    points.push(point.x, point.y);
    outbox.push(point.x, point.y);
    redraw();
  }

  /** 線を引き終える。溜まった点を送り切ってから end を送る */
  function endStroke() {
    if (localStroke === null) return;
    activePointerId = null;
    flushChunks();
    nextStrokeId += 1;
    awaitingFlush = true;
    api.send({ k: "end" });
  }

  function onPointerUp(event) {
    if (localStroke === null || event.pointerId !== activePointerId) return;
    endStroke();
  }

  /**
   * 溜まった点を 64点ずつに切って送る（サーバーの1チャンク上限に合わせる）。
   * 同じストロークIDへの追記はサーバー側で1本の点列に連結されるので、
   * チャンクの境目で点を重ねる必要は無い（線は自然に繋がる）
   */
  function flushChunks() {
    if (localStroke === null) return;
    while (outbox.length >= 2) {
      const chunk = outbox.slice(0, MAX_CHUNK_POINTS * 2);
      outbox = outbox.slice(chunk.length);
      api.send({
        k: "draw",
        s: localStroke.id,
        c: localStroke.color,
        w: localStroke.width,
        p: chunk,
      });
    }
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  // 一定間隔で送る（毎 pointermove で送るとレート枠を使い切る）
  const sendTimerId = setInterval(() => {
    if (!canDraw) return;
    flushChunks();
  }, SEND_INTERVAL_MS);

  // --- 道具箱の操作 ---
  function selectColor(index) {
    colorIndex = index;
    paintToolState();
  }
  function selectWidth(index) {
    widthIndex = index;
    paintToolState();
  }
  function onUndo() {
    if (!canDraw) return;
    api.send({ k: "undo" });
  }
  function onClear() {
    if (!canDraw) return;
    api.send({ k: "clear" });
  }
  /** @type {Array<() => void>} */
  const toolHandlers = [];
  colorBtns.forEach((btn, index) => {
    const handler = () => selectColor(index);
    toolHandlers.push(() => btn.removeEventListener("click", handler));
    btn.addEventListener("click", handler);
  });
  widthBtns.forEach((btn, index) => {
    const handler = () => selectWidth(index);
    toolHandlers.push(() => btn.removeEventListener("click", handler));
    btn.addEventListener("click", handler);
  });
  undoBtn.addEventListener("click", onUndo);
  clearBtn.addEventListener("click", onClear);

  /** 選択中の色・太さを見た目に出す */
  function paintToolState() {
    colorBtns.forEach((btn, index) => {
      btn.style.border = index === colorIndex
        ? "3px solid #2c3e50"
        : "1px solid rgba(127,127,127,0.6)";
    });
    widthBtns.forEach((btn, index) => {
      btn.style.fontWeight = index === widthIndex ? "700" : "400";
      btn.style.outline = index === widthIndex ? "2px solid #2c3e50" : "";
    });
  }
  paintToolState();

  // ---------------------------------------------------------------------------
  // 秒読み
  // ---------------------------------------------------------------------------
  function renderTimer() {
    if (deadline === null) {
      timerEl.textContent = "";
      return;
    }
    const left = Math.max(0, Math.ceil((deadline - api.serverNow()) / 1000));
    timerEl.textContent = `残り約 ${left} 秒`;
  }
  const timerId = setInterval(renderTimer, 1000);

  // ---------------------------------------------------------------------------
  // 一覧の描画
  // ---------------------------------------------------------------------------

  /** 正解者。誰が当てたかは出すが、お題そのものは reveal まで出さない */
  function renderCorrect(correct) {
    clear(correctList);
    if (correct.length === 0) {
      const item = document.createElement("li");
      item.style.opacity = "0.7";
      item.appendChild(el("span", "まだ誰も当てていません"));
      correctList.appendChild(item);
      return;
    }
    for (const entry of correct) {
      if (entry === null || typeof entry !== "object") continue;
      const item = document.createElement("li");
      item.style.display = "flex";
      item.style.gap = "6px";
      item.style.padding = "2px 4px";
      const order = numberOrNull(entry.order);
      item.appendChild(el("span", order === null ? "・" : `${order}着`));
      const name = el("span", nameOf(entry));
      if (entry.playerId === api.youId) name.style.fontWeight = "700";
      item.appendChild(name);
      const points = numberOrNull(entry.points);
      if (points !== null) item.appendChild(el("span", `+${points}点`));
      correctList.appendChild(item);
    }
  }

  /** 得点表。final では1位を目立たせる */
  function renderStandings(standings, isFinal) {
    clear(standingsList);
    for (const row of standings) {
      if (row === null || typeof row !== "object") continue;
      const rank = numberOrNull(row.rank);
      const score = numberOrNull(row.score);
      const item = document.createElement("li");
      item.style.display = "flex";
      item.style.gap = "6px";
      item.style.padding = "2px 4px";
      const rankEl = el("span", rank === null ? "-" : `${rank}位`);
      rankEl.style.minWidth = "3em";
      item.appendChild(rankEl);
      const name = el("span", nameOf(row));
      if (row.playerId === api.youId) name.style.fontWeight = "700";
      item.appendChild(name);
      item.appendChild(el("span", score === null ? "" : `${score}点`));
      if (isFinal && rank === 1) {
        item.style.fontWeight = "700";
        item.style.background = "rgba(212, 175, 55, 0.25)";
        item.style.borderRadius = "4px";
        item.appendChild(el("span", "★ 優勝"));
      }
      standingsList.appendChild(item);
    }
  }

  return {
    /**
     * @param {unknown} view gameView.view（上のコメントの形）
     * @param {number|null} nextDeadline 期限（epoch ms）
     */
    update(view, nextDeadline) {
      deadline = typeof nextDeadline === "number" && Number.isFinite(nextDeadline)
        ? nextDeadline
        : null;
      renderTimer();
      if (view === null || typeof view !== "object") return;
      lastView = view;

      const phase = typeof view.phase === "string" ? view.phase : "";
      const turn = numberOrNull(view.turn) ?? 0;
      const totalTurns = numberOrNull(view.totalTurns) ?? 0;
      const youAreDrawer = view.youAreDrawer === true;
      const drawerName = typeof view.drawerName === "string" && view.drawerName.length > 0
        ? view.drawerName
        : "（名無し）";
      const topic = typeof view.topic === "string" ? view.topic : null;
      const topicLength = numberOrNull(view.topicLength) ?? 0;
      const rev = numberOrNull(view.rev) ?? 0;
      const pointCount = numberOrNull(view.pointCount) ?? 0;
      const pointMax = numberOrNull(view.pointMax) ?? 0;
      const correct = Array.isArray(view.correct) ? view.correct : [];
      const standings = Array.isArray(view.standings) ? view.standings : [];
      const result = view.result !== null && typeof view.result === "object" ? view.result : null;
      const myOrder = numberOrNull(view.myCorrectOrder);
      const myPoints = numberOrNull(view.myTurnPoints) ?? 0;

      // ターンが変わったら手元の状態を初期化する（ストロークIDはターンごとに0から）
      if (turn !== renderedTurn) {
        renderedTurn = turn;
        nextStrokeId = 0;
        localStroke = null;
        outbox = [];
        awaitingFlush = false;
        activePointerId = null;
        renderedRev = -1;
      }
      // end を送った後の view が来たら、手元の線はサーバーの履歴に含まれている
      if (awaitingFlush) {
        awaitingFlush = false;
        localStroke = null;
        renderedRev = -1;
      }

      canDraw = youAreDrawer && phase === "draw";

      // 見出し
      headEl.textContent = phase === "final"
        ? "最終結果"
        : `第${turn} / ${totalTurns}ターン ・ 出題者: ${drawerName}`;

      // 役割の案内
      if (phase === "draw" && youAreDrawer) {
        roleEl.textContent = topic === null
          ? "あなたが描く番です"
          : `あなたのお題は「${topic}」。絵だけで伝えてください（チャットに書くとその発言は消えます）`;
      } else if (phase === "draw") {
        roleEl.textContent = `${drawerName} さんが描いています。答えが分かったら${
          topicLength > 0 ? `（ヒント: ${topicLength}文字）` : ""
        }チャットに書いてください`;
      } else if (phase === "reveal") {
        roleEl.textContent = "答え合わせ";
      } else {
        roleEl.textContent = "おつかれさまでした";
      }

      // 本人向けフィードバック（正解の発言はチャットから消えるので、ここで必ず知らせる）
      if (myOrder !== null) {
        myResultEl.textContent = `正解！ あなたは${myOrder}番目でした（+${myPoints}点）`;
      } else if (phase === "draw" && !youAreDrawer) {
        myResultEl.textContent = "";
      } else {
        myResultEl.textContent = "";
      }

      // canvas は版番号が変わったときだけ描き直す（毎回だと重い・ちらつく）
      if (rev !== renderedRev) {
        renderedRev = rev;
        redraw();
      }

      // 道具箱は出題者の描画中だけ
      setShown(toolsBox, canDraw);
      setShown(budgetEl, canDraw);
      if (canDraw) {
        const left = Math.max(0, pointMax - pointCount);
        budgetEl.textContent = left === 0
          ? "描ける量の上限に達しました（「全部消す」でやり直せます）"
          : `あと ${left} 点ぶん描けます（全 ${pointMax} 点）`;
        budgetEl.style.color = left === 0 ? "#c0392b" : "";
      }

      // 正解者は描画中と答え合わせで出す
      setShown(correctBox, phase !== "final");
      if (phase !== "final") renderCorrect(correct);

      // 答え合わせ
      const showResult = phase === "reveal" && result !== null;
      setShown(resultBox, showResult);
      if (showResult) {
        const answer = typeof result.topic === "string" ? result.topic : "";
        answerEl.textContent = `答えは「${answer}」`;
        const drawerPoints = numberOrNull(result.drawerPoints) ?? 0;
        const resultDrawer = typeof result.drawerName === "string" && result.drawerName.length > 0
          ? result.drawerName
          : "（名無し）";
        if (result.aborted === "drawerLeft") {
          resultNoteEl.textContent = `${resultDrawer} さんが居なくなったため、このターンは打ち切りました`;
        } else if (result.aborted === "drawerKicked") {
          resultNoteEl.textContent = `${resultDrawer} さんが退室したため、このターンは打ち切りました`;
        } else {
          resultNoteEl.textContent = `出題者 ${resultDrawer} さん: +${drawerPoints}点`;
        }
      }

      // 得点表は常に出す
      setShown(standingsBox, standings.length > 0);
      if (standings.length > 0) renderStandings(standings, phase === "final");
    },

    /** タイマー・リスナを片付ける（規約3） */
    unmount() {
      clearInterval(timerId);
      clearInterval(sendTimerId);
      if (sizeObserver !== null) sizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      undoBtn.removeEventListener("click", onUndo);
      clearBtn.removeEventListener("click", onClear);
      for (const off of toolHandlers) off();
      clear(container);
    },
  };
}

// -----------------------------------------------------------------------------
// 小道具
// -----------------------------------------------------------------------------

/** テキストだけを持つ要素を作る（innerHTML は使わない） */
function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** 子要素をすべて取り除く */
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 表示・非表示を切り替える */
function setShown(node, shown) {
  node.style.display = shown ? "" : "none";
}

/** 有限な数値ならその値、そうでなければ null */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 範囲に収める */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 表示用のニックネーム */
function nameOf(entry) {
  return typeof entry.nickname === "string" && entry.nickname.length > 0
    ? entry.nickname
    : "（名無し）";
}
