/**
 * サンドボックスゲーム UI（docs/design/game-sandbox.md）
 * 開発用動作確認ページ（index.html / app.js）に組み込む、サンドボックスゲームの
 * 選択・開始・終了・実行を扱うモジュール。chat.js / vc.js / bot.js と同じ流儀の
 * classic script として app.js より前に読み込み、グローバルに Sandbox だけを公開する。
 * DOM は空のコンテナに自前で組み立てるので、呼び出し側が用意するのは
 * `<section id="sandbox"></section>` 1つでよい（bot.js と同じ設計）。
 *
 * 責務（設計書 §2 / §3 / §5）:
 *   1. ゲーム一覧の取得（GET /api/sandboxGames）とホスト向けの選択・開始・終了 UI
 *   2. iframe（public/sandbox/runner.html）の生成・破棄。属性・src の組み立てはこの
 *      ファイルの createFrame() 1か所に閉じ込める（§2.2「属性の綴りを間違えると
 *      隔離が丸ごと消える」ため）
 *   3. サーバー ⇄ runner の間でメッセージを橋渡しする（サーバーの sandboxSignal と
 *      runner の EN.send / onMessage を接続する）
 *
 * 【最重要】このファイルは絶対にゲームコードを評価しない。
 * GET /games/<file> で取得したコードは文字列のまま postMessage で runner に渡すだけ。
 * eval / new Function / <script> の動的生成はこのファイルで一切使わない。
 *
 * 親側の postMessage 検証（§2.5・タスク指示）:
 * event.source === iframe.contentWindow で行う。event.origin では比較しない
 * （allow-same-origin を付けない iframe からのメッセージは event.origin が
 * 文字列 "null" になり、正しく設定していても全メッセージが弾かれてしまうため）。
 *
 * postMessage に載せてよいもの（§2.5 / §4.4 の規約）:
 * playerId / nickname / isHost / gameId / serverTime（オフセット） / ゲーム自身の payload のみ。
 * session / entryToken / userId / Cookie 由来の値は絶対に載せない。
 *
 * サーバーとの契約（設計書 §4.2。別担当が並行実装中）:
 *   C2S: { t:"sandboxStart", gameId } / { t:"sandboxEnd" } / { t:"sandboxSignal", payload }
 *   S2C: { t:"sandboxState", game:{gameId,startedBy,startedAt}|null }
 *        { t:"sandboxSignal", from, payload }
 *   roomState のスナップショットに sandbox: SandboxGameState|null が入る（§5.3 途中参加・再接続）
 *   GET /api/sandboxGames → マニフェスト（public/games/manifest.json）の内容
 *
 * 表示規約（§3.8 / CLAUDE.md セキュリティ基準）:
 * ユーザー由来のテキスト（ニックネーム・ゲームの title/description・ゲームからの
 * ログ文字列）は必ず textContent で描画し、innerHTML は使わない。
 *
 * runner との内部メッセージ（postMessage）の形は、設計書に明記が無いため
 * このファイルと public/sandbox/runner.js の間だけの内部契約として自分で決めている。
 * プロトタイプ（proto/public/app/app.js）の形を土台に、EN API の変更（setScore 廃止・
 * onEnd / now 追加・joinedLate 追加）に合わせて拡張した:
 *   親→runner: { t:"load", code } / { t:"start", youId, isHost, peers, joinedLate, serverTimeOffsetMs } /
 *              { t:"peer", kind, id, nickname } / { t:"host", id } / { t:"message", from, msg } /
 *              { t:"time", offsetMs } / { t:"end" }
 *   runner→親: { t:"ready" } / { t:"send", msg } / { t:"status", text } / { t:"log", message } /
 *              { t:"error", message }
 */

"use strict";

(function (global) {
  /** iframe の唯一の生成箇所（§2.2）。他のどこにも iframe を作るコードを置かない */
  const RUNNER_SRC = "/sandbox/runner.html";
  /** ゲーム一覧の正本はサーバー（§6.2）。manifest.json を直接 fetch しない */
  const GAMES_ENDPOINT = "/api/sandboxGames";
  /** ゲームコード fetch の上限文字数（暴走したファイルで固まらないようにする保険） */
  const CODE_FETCH_TIMEOUT_MS = 8000;
  /** ログ欄（EN.log）に残す行数の上限 */
  const LOG_LINES_MAX = 50;

  /** init で注入される依存 */
  const deps = { send: null, container: null, onStatus: null };

  /** モジュール内の状態 */
  const state = {
    // ルームの参加者情報。roomState / playerJoined / playerLeft / playerKicked /
    // hostChanged から更新する（設計書 §3.2 onPeer・§5.1 ホスト交代の引き継ぎのため、
    // タスク指示の3種別（roomState/sandboxState/sandboxSignal）に加えて追跡している。
    // vc.js が同じ理由で playerJoined 等も handleServerMessage で扱っているのに倣った）
    youId: null,
    isHost: false,
    hostId: null,
    players: [], // [{ id, nickname }] 接続中のみ・自分を含む
    serverOffsetMs: 0, // roomState.serverTime - Date.now()（受信時点）。EN.now() の元

    // ゲーム一覧（GET /api/sandboxGames）
    games: [],
    gamesLoading: false,
    gamesError: null,

    // ホストの選択欄
    selectedGameId: null,

    // 稼働中のサンドボックスゲーム。null なら非稼働（SandboxGameState 相当）
    running: null,

    // iframe
    frame: null,
    frameReady: false,
    pendingCode: null, // ready 待ちのコード文字列
    pendingJoinedLate: false,
    loadToken: 0, // beginGame ごとに増やす連番。古い fetch の結果が後から届いても無視するため
    loadError: null, // ゲームコードの取得・実行に失敗した理由（表示用）

    // runner からの表示情報
    statusText: "",
    logLines: [],

    // 組み立て済みの DOM 要素
    el: {
      controlsRow: null,
      select: null,
      startBtn: null,
      endBtn: null,
      hostHint: null,
      statusEl: null,
      errorEl: null,
      frameSlot: null,
      logEl: null,
    },
  };

  // ---------------------------------------------------------------------------
  // 小道具
  // ---------------------------------------------------------------------------

  /** テキストだけを持つ要素を作る（chat.js / bot.js と同じ方式） */
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className !== undefined) node.className = className;
    return node;
  }

  /** 子要素をすべて取り除く */
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** 呼び出し側へ状態変化・エラーを伝える（VC.onStatus と同じ流儀） */
  function notify(kind, message) {
    if (typeof deps.onStatus === "function") deps.onStatus({ kind, message });
  }

  /** サーバーへ送る */
  function send(msg) {
    if (typeof deps.send === "function") deps.send(msg);
  }

  // ---------------------------------------------------------------------------
  // ゲーム一覧
  // ---------------------------------------------------------------------------

  /** GET /api/sandboxGames を取得する。失敗しても壊れた画面にせず理由を表示する */
  async function loadGamesList() {
    state.gamesLoading = true;
    state.gamesError = null;
    renderControls();
    try {
      const res = await fetch(GAMES_ENDPOINT, {
        credentials: "same-origin",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`サーバーが ${res.status} を返しました`);
      const data = await res.json();
      state.games = normalizeGamesList(data);
      if (state.games.length === 0) {
        state.gamesError = "遊べるゲームがまだ登録されていません";
      }
    } catch (err) {
      state.games = [];
      state.gamesError = `ゲーム一覧を取得できませんでした（${describeError(err)}）`;
      notify("error", state.gamesError);
    } finally {
      state.gamesLoading = false;
      renderControls();
    }
  }

  /** サーバー応答のスキーマ検証。壊れた要素は落とす（外部由来のデータを信用しない） */
  function normalizeGamesList(data) {
    if (data === null || typeof data !== "object" || !Array.isArray(data.games)) return [];
    const out = [];
    for (const g of data.games) {
      if (g === null || typeof g !== "object") continue;
      if (typeof g.id !== "string" || typeof g.title !== "string") continue;
      if (typeof g.file !== "string") continue;
      out.push({
        id: g.id,
        title: g.title,
        description: typeof g.description === "string" ? g.description : "",
        file: g.file,
        minPlayers: typeof g.minPlayers === "number" ? g.minPlayers : 1,
        maxPlayers: typeof g.maxPlayers === "number" ? g.maxPlayers : 10,
        author: typeof g.author === "string" ? g.author : "",
      });
    }
    return out;
  }

  /** エラーの人間向け説明を作る（AbortError / TypeError などをそのまま出さない） */
  function describeError(err) {
    if (err && err.name === "TimeoutError") return "タイムアウトしました";
    if (err && err.name === "AbortError") return "タイムアウトしました";
    if (err instanceof TypeError) return "ネットワークに接続できませんでした";
    return err && err.message ? err.message : String(err);
  }

  // ---------------------------------------------------------------------------
  // 表示
  // ---------------------------------------------------------------------------

  /** コンテナの中身を1度だけ組み立てる */
  function buildPanel(container) {
    clear(container);

    const head = el("div", undefined, "sandbox-head");
    head.appendChild(el("h2", "あそぶ（サンドボックス）"));
    head.appendChild(
      el(
        "p",
        "チーム製の余興ゲーム。宴の公式スコアには算入されません。",
        "sandbox-note",
      ),
    );
    container.appendChild(head);

    const controls = el("div", undefined, "sandbox-controls");
    const select = document.createElement("select");
    select.className = "input sandbox-select";
    select.addEventListener("change", () => {
      state.selectedGameId = select.value.length > 0 ? select.value : null;
    });
    controls.appendChild(select);

    const startBtn = el("button", "はじめる", "btn btn-gold");
    startBtn.type = "button";
    startBtn.addEventListener("click", () => {
      if (state.selectedGameId === null) {
        notify("error", "ゲームを選んでください");
        return;
      }
      send({ t: "sandboxStart", gameId: state.selectedGameId });
    });
    controls.appendChild(startBtn);

    const endBtn = el("button", "終了する（ホスト）", "btn btn-red");
    endBtn.type = "button";
    endBtn.addEventListener("click", () => send({ t: "sandboxEnd" }));
    controls.appendChild(endBtn);

    container.appendChild(controls);

    const hostHint = el(
      "p",
      "ホストだけがサンドボックスゲームを開始・終了できます。",
      "sandbox-note dim",
    );
    container.appendChild(hostHint);

    const status = el("p", "", "sandbox-status");
    container.appendChild(status);

    const error = el("p", "", "sandbox-error alert");
    container.appendChild(error);

    const frameSlot = el("div", undefined, "sandbox-frame-slot");
    container.appendChild(frameSlot);

    const logDetails = document.createElement("details");
    logDetails.className = "devlog sandbox-log-details";
    const summary = el("summary", "ゲームからのログ（開発用）");
    logDetails.appendChild(summary);
    const logEl = el("div", "", "sandbox-log");
    logDetails.appendChild(logEl);
    container.appendChild(logDetails);

    state.el.controlsRow = controls;
    state.el.select = select;
    state.el.startBtn = startBtn;
    state.el.endBtn = endBtn;
    state.el.hostHint = hostHint;
    state.el.statusEl = status;
    state.el.errorEl = error;
    state.el.frameSlot = frameSlot;
    state.el.logEl = logEl;
  }

  /** 選択欄・開始終了ボタンを描き直す */
  function renderControls() {
    const select = state.el.select;
    if (select === null) return;

    clear(select);
    if (state.games.length === 0) {
      const placeholder = el("option", state.gamesLoading ? "読み込み中…" : "（ゲームが無い）");
      placeholder.value = "";
      select.appendChild(placeholder);
    } else {
      for (const game of state.games) {
        const label = `${game.title}（${game.minPlayers}〜${game.maxPlayers}人）`;
        const option = el("option", label);
        option.value = game.id;
        select.appendChild(option);
      }
      if (state.selectedGameId === null || !state.games.some((g) => g.id === state.selectedGameId)) {
        state.selectedGameId = state.games[0].id;
      }
      select.value = state.selectedGameId;
    }

    const running = state.running !== null;
    const canOperate = state.isHost && state.games.length > 0;
    // 開始・終了の操作はホストにだけ見せる（設計書 §5.1・タスク指示）。非ホストは
    // 単に disabled にするだけでは「見えるが押せない」ままになるため、行ごと隠す
    state.el.controlsRow.classList.toggle("hidden", !state.isHost);
    select.disabled = !canOperate || running;
    state.el.startBtn.disabled = !canOperate || running;
    state.el.startBtn.classList.toggle("hidden", running);
    state.el.endBtn.disabled = !state.isHost || !running;
    state.el.endBtn.classList.toggle("hidden", !running);
    state.el.hostHint.classList.toggle("hidden", state.isHost);

    renderStatus();
  }

  /** 状態文字列・エラー文字列を描き直す */
  function renderStatus() {
    const parts = [];
    if (state.running !== null) {
      const game = state.games.find((g) => g.id === state.running.gameId);
      const title = game !== undefined ? game.title : state.running.gameId;
      parts.push(`稼働中: ${title}`);
    } else {
      parts.push("未実施");
    }
    if (state.statusText.length > 0) parts.push(state.statusText);
    state.el.statusEl.textContent = parts.join(" / ");

    const errorText = state.gamesError ?? state.loadError ?? "";
    state.el.errorEl.textContent = errorText;
  }

  /** EN.log の履歴を描き直す */
  function renderLog() {
    const box = state.el.logEl;
    if (box === null) return;
    clear(box);
    for (const line of state.logLines) box.appendChild(el("div", line));
    box.scrollTop = box.scrollHeight;
  }

  /** ログ1行を追加する（上限を設けて無限に伸びないようにする） */
  function pushLog(text) {
    const time = new Date().toLocaleTimeString("ja-JP", { hour12: false });
    state.logLines.push(`${time} ${text}`);
    if (state.logLines.length > LOG_LINES_MAX) state.logLines = state.logLines.slice(-LOG_LINES_MAX);
    renderLog();
  }

  // ---------------------------------------------------------------------------
  // iframe の生成・破棄（唯一の生成箇所。§2.2 / §9.2）
  // ---------------------------------------------------------------------------

  /**
   * iframe を作り直す。ゲームを読み込むたびに新しい文書を使うことで、
   * 前のゲームが残した setInterval / requestAnimationFrame / リスナを確実に捨てる（§3.3）。
   */
  function createFrame() {
    destroyFrame();
    const frame = document.createElement("iframe");
    // 【最重要】allow-same-origin を付けない。付けないことでこの文書は
    // 一意の不透明オリジンになり、親の DOM・Cookie・localStorage のいずれにも触れなくなる（§2.2）
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", "ゲームサンドボックス");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.className = "sandbox-frame";
    frame.src = RUNNER_SRC;
    state.el.frameSlot.appendChild(frame);
    state.frame = frame;
    state.frameReady = false;
  }

  /** 現在の iframe に終了通知を送ってから取り除く */
  function destroyFrame() {
    if (state.frame === null) return;
    toFrame({ t: "end" });
    if (state.frame.parentNode !== null) state.frame.parentNode.removeChild(state.frame);
    state.frame = null;
    state.frameReady = false;
  }

  /**
   * runner へ送る。targetOrigin は "*" にせざるを得ない
   * （不透明オリジンの文書は名前で指定できるオリジンを持たないため）。
   * 宛先の同一性は「自分が生成した iframe の contentWindow に対してだけ送る」ことで担保する（§2.5）。
   */
  function toFrame(msg) {
    if (state.frame === null || state.frame.contentWindow === null) return;
    state.frame.contentWindow.postMessage(msg, "*");
  }

  /** ready とコード取得の両方が揃っていれば runner にゲームを渡す */
  function deliverIfReady() {
    if (!state.frameReady || state.pendingCode === null) return;
    const code = state.pendingCode;
    state.pendingCode = null;
    toFrame({ t: "load", code });
    toFrame({
      t: "start",
      youId: state.youId,
      isHost: state.isHost,
      peers: state.players.filter((p) => p.id !== state.youId),
      joinedLate: state.pendingJoinedLate,
      serverTimeOffsetMs: state.serverOffsetMs,
    });
    pushLog(`ゲームコードを runner へ渡しました（${code.length} 文字 / joinedLate=${state.pendingJoinedLate}）`);
  }

  // ---------------------------------------------------------------------------
  // ゲームコードの取得（このファイルが fetch する。runner は connect-src 'none' で fetch 不可）
  // ---------------------------------------------------------------------------

  /** ゲームコードを取得する。親はこの文字列を絶対に評価しない（postMessage で渡すだけ） */
  async function fetchGameCode(gameId) {
    const known = state.games.find((g) => g.id === gameId);
    // 一覧取得に失敗していても、file 名の既定（id + ".js"、§6.2 の検証規約）でフォールバックする
    const file = known !== undefined ? known.file : `${gameId}.js`;
    const res = await fetch(`/games/${file}`, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(CODE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`/games/${file} が ${res.status} を返しました`);
    const text = await res.text();
    if (text.length === 0) throw new Error(`/games/${file} が空でした`);
    return text;
  }

  // ---------------------------------------------------------------------------
  // ゲームの開始・終了
  // ---------------------------------------------------------------------------

  /** サンドボックスゲームを開始する（sandboxState で game が来た時 / roomState で稼働中だった時） */
  function beginGame(game, joinedLate) {
    state.running = game;
    state.loadError = null;
    state.statusText = "";
    state.logLines = [];
    renderLog();
    renderControls();

    const token = ++state.loadToken;
    createFrame();
    state.pendingJoinedLate = joinedLate;

    fetchGameCode(game.gameId).then(
      (code) => {
        if (token !== state.loadToken) return; // 途中で終了・別ゲーム開始が起きていた
        state.pendingCode = code;
        deliverIfReady();
      },
      (err) => {
        if (token !== state.loadToken) return;
        state.loadError = `ゲームコードを読み込めませんでした（${describeError(err)}）`;
        notify("error", state.loadError);
        renderStatus();
      },
    );
  }

  /** サンドボックスゲームを終了する（sandboxState で game が null になった時） */
  function endGame() {
    if (state.frame === null && state.running === null) return;
    state.loadToken += 1; // 実行中の fetch の結果を無視させる
    destroyFrame();
    state.running = null;
    state.pendingCode = null;
    state.statusText = "";
    renderControls();
  }

  // ---------------------------------------------------------------------------
  // runner → 親 のメッセージ
  // ---------------------------------------------------------------------------

  global.addEventListener("message", (event) => {
    // 【重要】event.origin ではなく event.source で検証する（タスク指示・§2.5）。
    // allow-same-origin を付けていない iframe の文書からの postMessage は
    // event.origin が文字列 "null" になるため、event.origin で比較すると
    // 正しく設定できていても全メッセージが弾かれてしまう。
    if (state.frame === null || event.source !== state.frame.contentWindow) return;

    const data = event.data;
    if (data === null || typeof data !== "object" || typeof data.t !== "string") return;

    switch (data.t) {
      case "ready":
        state.frameReady = true;
        deliverIfReady();
        break;

      case "send":
        // ゲームからの送信。親は中身を解釈せず、そのままサーバーへ中継する（§4.1）
        send({ t: "sandboxSignal", payload: data.msg });
        break;

      case "status":
        if (typeof data.text !== "string") return;
        state.statusText = data.text;
        renderStatus();
        break;

      case "log":
        if (typeof data.message !== "string") return;
        pushLog(data.message);
        break;

      case "error":
        if (typeof data.message !== "string") return;
        pushLog(`[error] ${data.message}`);
        notify("log", `sandbox: ${data.message}`);
        break;

      default:
        break;
    }
  });

  // ---------------------------------------------------------------------------
  // サーバー → 親 のメッセージ
  // ---------------------------------------------------------------------------

  /** players 配列から接続中のメンバーだけを { id, nickname } で取り出す */
  function normalizePlayers(players) {
    if (!Array.isArray(players)) return [];
    const out = [];
    for (const p of players) {
      if (p === null || typeof p !== "object") continue;
      if (typeof p.id !== "string") continue;
      if (p.connected === false) continue;
      out.push({ id: p.id, nickname: typeof p.nickname === "string" ? p.nickname : "" });
    }
    return out;
  }

  /**
   * S2C メッセージを渡す。ルーム側の受信処理からそのまま流し込む。
   *
   * タスク指示では roomState / sandboxState / sandboxSignal の3種別が対象とされているが、
   * 稼働中のゲームへ EN.onPeer（参加者の増減）と EN.isHost（ホスト交代）を正しく伝えるには
   * playerJoined / playerLeft / playerKicked / hostChanged も追う必要がある（設計書 §3.2 / §5.1）。
   * vc.js が同じ理由でこれらを handleServerMessage 内で扱っているのに倣い、ここでも同様に扱う。
   * これは指示からの拡張であり、想定外なら削って構わない旨をレビューで報告する。
   */
  function handleServerMessage(msg) {
    if (typeof msg !== "object" || msg === null || typeof msg.t !== "string") return;
    switch (msg.t) {
      case "roomState": {
        const snapshot = msg.snapshot;
        if (snapshot === null || typeof snapshot !== "object") return;
        state.youId = typeof snapshot.youId === "string" ? snapshot.youId : null;
        state.isHost = snapshot.youAreHost === true;
        state.hostId = typeof snapshot.hostId === "string" ? snapshot.hostId : null;
        state.players = normalizePlayers(snapshot.players);
        if (typeof snapshot.serverTime === "number" && Number.isFinite(snapshot.serverTime)) {
          state.serverOffsetMs = snapshot.serverTime - Date.now();
        }

        // snapshot.sandbox は本モジュールが前提とする契約（設計書 §4.2）。
        // サーバー側の実装が無い間は undefined のままなので、その場合は何もしない
        const incoming = snapshot.sandbox === undefined ? undefined : snapshot.sandbox;
        if (incoming === undefined) {
          renderControls();
          return;
        }
        if (incoming !== null) {
          // 途中入室・再接続（§5.3）。既に同じゲームが動いていても iframe は作り直す
          beginGame(incoming, /* joinedLate */ true);
        } else if (state.running !== null) {
          endGame();
        } else {
          renderControls();
        }
        break;
      }

      case "sandboxState": {
        const game = msg.game === undefined ? null : msg.game;
        if (game !== null && typeof game === "object" && typeof game.gameId === "string") {
          beginGame(game, /* joinedLate */ false);
        } else {
          endGame();
        }
        break;
      }

      case "sandboxSignal":
        if (typeof msg.from !== "string") return;
        toFrame({ t: "message", from: msg.from, msg: msg.payload });
        break;

      case "playerJoined": {
        const player = msg.player;
        if (player === null || typeof player !== "object" || typeof player.id !== "string") return;
        const nickname = typeof player.nickname === "string" ? player.nickname : "";
        if (!state.players.some((p) => p.id === player.id)) {
          state.players.push({ id: player.id, nickname });
        }
        toFrame({ t: "peer", kind: "join", id: player.id, nickname });
        break;
      }

      case "playerLeft":
      case "playerKicked": {
        const playerId = msg.t === "playerKicked" ? msg.playerId : msg.player && msg.player.id;
        if (typeof playerId !== "string") return;
        const known = state.players.find((p) => p.id === playerId);
        state.players = state.players.filter((p) => p.id !== playerId);
        toFrame({ t: "peer", kind: "leave", id: playerId, nickname: known ? known.nickname : "" });
        break;
      }

      case "hostChanged":
        if (typeof msg.playerId !== "string") return;
        state.hostId = msg.playerId;
        state.isHost = msg.playerId === state.youId;
        toFrame({ t: "host", id: msg.playerId });
        renderControls();
        break;

      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // 公開 API
  // ---------------------------------------------------------------------------

  /** 依存を注入し、パネルを組み立てる */
  function init(options) {
    deps.send = options.send;
    deps.container = options.container;
    deps.onStatus = options.onStatus;
    buildPanel(deps.container);
    renderControls();
    loadGamesList();
  }

  /** 退室・キック時などにゲームを畳んで初期状態へ戻す */
  function reset() {
    endGame();
    state.youId = null;
    state.isHost = false;
    state.hostId = null;
    state.players = [];
    state.selectedGameId = null;
    state.loadError = null;
    state.statusText = "";
    state.logLines = [];
    renderLog();
    renderControls();
  }

  /** デバッグ・テスト用に内部状態を返す */
  function getState() {
    return {
      running: state.running,
      isHost: state.isHost,
      frameReady: state.frameReady,
      gamesCount: state.games.length,
      gamesError: state.gamesError,
    };
  }

  global.Sandbox = { init, handleServerMessage, reset, getState };
})(window);
