/**
 * 開発用の動作確認スクリプト
 * コアシステム（WS プロトコル）の疎通を手で確かめるための暫定実装。
 * 本番の画面はフロントエンド担当が別途作成する。
 *
 * 表示規約（§3.8 / CLAUDE.md セキュリティ基準）:
 * ユーザー由来のテキストは必ず textContent で描画し、innerHTML は使わない。
 */

"use strict";

/** 要素を取得する */
function $(id) {
  return document.getElementById(id);
}

/** 子要素をすべて取り除く */
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** テキストだけを持つ要素を作る */
function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/** ページ内の状態 */
const state = {
  ws: null,
  snapshot: null,
  view: null,
  phase: "lobby",
  deadline: null,
};

/** ルームごとのセッショントークン（再接続用）。タブ単位で保持する */
const store = {
  key: "en-session",
  save(code, session) {
    sessionStorage.setItem(store.key, JSON.stringify({ code, session }));
  },
  load() {
    try {
      const raw = sessionStorage.getItem(store.key);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  },
  drop() {
    sessionStorage.removeItem(store.key);
  },
};

/** ログを1行追加する */
function log(direction, msg) {
  const line = el("div", `${direction} ${JSON.stringify(msg)}`);
  const box = $("log");
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

/** エラー表示を更新する */
function showError(text) {
  $("error").textContent = text ?? "";
}

/** サーバーへ送る */
function send(msg) {
  if (state.ws === null || state.ws.readyState !== WebSocket.OPEN) {
    showError("サーバーに接続していません");
    return;
  }
  state.ws.send(JSON.stringify(msg));
  log("→", msg);
}

/** WebSocket を開く */
function connect() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${scheme}//${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    showError("");
    const saved = store.load();
    const nickname = $("nickname").value.trim();
    if (saved !== null && nickname.length > 0) {
      // 再接続を試す（60秒以内なら復帰できる）
      send({ t: "join", roomCode: saved.code, nickname, session: saved.session });
    }
  };
  ws.onclose = () => showError("接続が切れました。再読み込みしてください");
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    log("←", msg);
    receive(msg);
    // VC は参加者の増減とシグナリングを同じ WS で受け取る（§3.2 / §3.6）
    VC.handleServerMessage(msg);
  };
}

/** S2C メッセージを処理する */
function receive(msg) {
  switch (msg.t) {
    case "roomState":
      state.snapshot = msg.snapshot;
      state.phase = msg.snapshot.phase;
      state.deadline = msg.snapshot.deadline;
      state.view = msg.snapshot.view;
      if (typeof msg.snapshot.session === "string") {
        store.save(msg.snapshot.code, msg.snapshot.session);
      }
      showError("");
      renderAll();
      break;
    case "playerJoined":
      upsertPlayer(msg.player);
      renderAll();
      break;
    case "playerLeft":
      upsertPlayer(msg.player, true);
      renderAll();
      break;
    case "playerKicked":
      removePlayer(msg.playerId);
      renderAll();
      break;
    case "hostChanged":
      if (state.snapshot !== null) {
        state.snapshot.hostId = msg.playerId;
        state.snapshot.youAreHost = msg.playerId === state.snapshot.youId;
      }
      renderAll();
      break;
    case "phase":
      state.phase = msg.phase;
      state.deadline = msg.deadline ?? null;
      state.view = msg.view;
      if (state.snapshot !== null && msg.view.phase === "lobby") {
        state.snapshot.selectedGameId = msg.view.selectedGameId;
      }
      renderAll();
      break;
    case "roundResult":
      renderScores("ラウンド結果", msg.scores);
      break;
    case "finalResult":
      renderScores("最終結果", msg.scores);
      break;
    case "kicked":
      store.drop();
      state.snapshot = null;
      showError("ルームから退出しました");
      renderAll();
      break;
    case "error":
      showError(`${msg.code}: ${msg.message}`);
      break;
    default:
      break;
  }
}

/** 参加者一覧を更新する */
function upsertPlayer(player, leaving) {
  if (state.snapshot === null) return;
  const list = state.snapshot.players;
  const index = list.findIndex((p) => p.id === player.id);
  if (index >= 0) list[index] = player;
  else if (!leaving) list.push(player);
}

/** 参加者を一覧から取り除く */
function removePlayer(playerId) {
  if (state.snapshot === null) return;
  state.snapshot.players = state.snapshot.players.filter((p) => p.id !== playerId);
}

/** 画面全体を描き直す */
function renderAll() {
  const snapshot = state.snapshot;
  $("entry").classList.toggle("hidden", snapshot !== null);
  $("room").classList.toggle("hidden", snapshot === null);
  $("vc").classList.toggle("hidden", snapshot === null);
  $("phase").classList.toggle("hidden", snapshot === null);
  renderVc();
  if (snapshot === null) return;

  $("room-code").textContent = snapshot.code;
  $("room-meta").textContent =
    `${snapshot.players.length} / ${snapshot.capacity}人・フェーズ: ${state.phase}` +
    (snapshot.youAreHost ? "・あなたはホストです" : "");

  const players = $("players");
  clear(players);
  for (const p of snapshot.players) {
    const marks = [];
    if (p.isHost) marks.push("ホスト");
    if (!p.connected) marks.push("切断中");
    if (p.id === snapshot.youId) marks.push("あなた");
    const suffix = marks.length > 0 ? `（${marks.join("・")}）` : "";
    players.appendChild(el("li", `${p.nickname}${suffix} ${p.score}点`));
  }

  const inLobby = state.phase === "lobby";
  $("lobby-controls").classList.toggle("hidden", !inLobby);
  if (inLobby) renderGameSelect(snapshot);
  $("skip").disabled = !snapshot.youAreHost || inLobby;
  $("start").disabled = !snapshot.youAreHost;
  $("select-game").disabled = !snapshot.youAreHost;

  renderPhase();
}

/** ゲーム選択の選択肢を作る */
function renderGameSelect(snapshot) {
  const select = $("game");
  clear(select);
  for (const game of snapshot.availableGames) {
    const option = el("option", `${game.title}（${game.rounds}ラウンド）`);
    option.value = game.id;
    if (game.id === snapshot.selectedGameId) option.selected = true;
    select.appendChild(option);
  }
}

/** 現在のフェーズを描画する */
function renderPhase() {
  const view = state.view;
  const body = $("phase-body");
  clear(body);
  $("phase-title").textContent = `フェーズ: ${state.phase}`;
  $("phase-deadline").textContent = state.deadline === null
    ? ""
    : `期限まで約 ${Math.max(0, Math.round((state.deadline - Date.now()) / 1000))} 秒`;
  if (view === null || view === undefined) return;

  switch (view.phase) {
    case "lobby":
      body.appendChild(el("p", "ホストがゲームを選んで開始するのを待っています。"));
      break;
    case "intro":
      body.appendChild(el("p", view.title));
      if (view.description) body.appendChild(el("p", view.description));
      body.appendChild(el("p", `全${view.totalRounds}ラウンド・採点: ${view.scoring}`));
      break;
    case "prompt":
      body.appendChild(el("p", `第${view.round}問 / ${view.totalRounds}`));
      body.appendChild(el("p", view.promptText));
      break;
    case "input":
      renderInput(body, view);
      break;
    case "reveal":
      body.appendChild(el("p", view.promptText));
      body.appendChild(renderEntries(view, false));
      if (typeof view.answerIndex === "number" && Array.isArray(view.options)) {
        body.appendChild(el("p", `正解: ${view.options[view.answerIndex]}`));
      }
      break;
    case "judge":
      body.appendChild(el("p", `投票: ${view.votedCount} / ${view.participantCount}`));
      body.appendChild(renderEntries(view, view.canVote));
      break;
    case "roundResult":
      renderScores(`第${view.round}ラウンド結果`, view.scores);
      body.appendChild(el("p", "次のラウンドを待っています。"));
      break;
    case "finalResult":
      renderScores("最終結果", view.scores);
      body.appendChild(el("p", "ゲームが終了しました。"));
      break;
    default:
      break;
  }
}

/** 入力フェーズの UI */
function renderInput(body, view) {
  body.appendChild(el("p", view.promptText));
  body.appendChild(el("p", `提出: ${view.submittedCount} / ${view.participantCount}`));
  if (!view.canSubmit) {
    body.appendChild(el("p", view.submitted ? "提出済みです。" : "このラウンドは観戦のみです。"));
    return;
  }
  if (view.inputType === "choice" && Array.isArray(view.options)) {
    view.options.forEach((option, index) => {
      const button = el("button", option);
      button.type = "button";
      button.addEventListener("click", () => send({ t: "submitInput", value: index }));
      body.appendChild(button);
    });
    return;
  }
  const input = el("input");
  input.maxLength = 140;
  const button = el("button", "回答する");
  button.type = "button";
  button.addEventListener("click", () => {
    const value = input.value.trim();
    if (value.length === 0) return;
    send({ t: "submitInput", value });
    input.value = "";
  });
  body.appendChild(input);
  body.appendChild(button);
}

/** 回答一覧（投票可能なら投票ボタンを付ける） */
function renderEntries(view, canVote) {
  const list = el("ul");
  for (const entry of view.entries) {
    const item = el("li");
    const label = entry.nickname === undefined
      ? String(entry.value)
      : `${entry.nickname}: ${entry.value}`;
    item.appendChild(el("span", label));
    if (canVote) {
      const button = el("button", "投票");
      button.type = "button";
      button.addEventListener("click", () => {
        send({ t: "submitVote", targetPlayerId: entry.playerId });
      });
      item.appendChild(button);
    }
    list.appendChild(item);
  }
  return list;
}

/** 順位表を描画する */
function renderScores(title, scores) {
  $("result").classList.remove("hidden");
  $("result-title").textContent = title;
  const list = $("result-list");
  clear(list);
  for (const row of scores) {
    list.appendChild(
      el("li", `${row.rank}位 ${row.nickname}  ラウンド${row.roundScore}点 / 累計${row.totalScore}点`),
    );
  }
}

/** VC の操作ボタンと状態表示を更新する */
function renderVc() {
  const vc = VC.getState();
  $("vc-join").disabled = vc.active;
  $("vc-leave").disabled = !vc.active;
  $("vc-mute").disabled = !vc.active;
  $("vc-camera").disabled = !vc.active;
  $("vc-mute").textContent = vc.muted ? "ミュート解除" : "ミュート";
  $("vc-camera").textContent = vc.camera ? "カメラOFF" : "カメラON";
  const peers = vc.peers.map((p) => `${p.nickname}: ${p.connectionState}`).join(" / ");
  const head = vc.active ? "参加中" : vc.eligible ? "未参加" : "未参加（VC枠外）";
  $("vc-status").textContent = peers.length > 0 ? `${head} — ${peers}` : head;
}

/** VC モジュールを組み込む */
function bindVc() {
  VC.init({
    send,
    container: $("vc-media"),
    onStatus: (event) => {
      if (event.kind === "error") showError(event.message);
      log("VC", event.message);
      renderVc();
    },
  });
  $("vc-join").addEventListener("click", () => {
    // 自動再生制限（iOS Safari）を避けるため、マイク取得はこの操作の直後に行う
    VC.join().then(renderVc);
  });
  $("vc-leave").addEventListener("click", () => {
    VC.leave();
    renderVc();
  });
  $("vc-mute").addEventListener("click", () => {
    VC.toggleMute();
    renderVc();
  });
  $("vc-camera").addEventListener("click", () => {
    VC.toggleCamera().then(renderVc);
  });
}

/** 操作の割り当て */
function bind() {
  $("create").addEventListener("click", () => {
    send({ t: "createRoom", nickname: $("nickname").value, visibility: "private" });
  });
  $("join").addEventListener("click", () => {
    send({ t: "join", roomCode: $("code").value, nickname: $("nickname").value });
  });
  $("select-game").addEventListener("click", () => {
    send({ t: "selectGame", gameId: $("game").value });
  });
  $("start").addEventListener("click", () => send({ t: "startGame" }));
  $("skip").addEventListener("click", () => send({ t: "skipPhase" }));
  $("leave").addEventListener("click", () => {
    VC.leave();
    send({ t: "leave" });
    store.drop();
    state.snapshot = null;
    renderAll();
  });
}

bind();
bindVc();
connect();
