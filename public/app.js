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

/** プリセット部屋タグの一覧（/api/room-tags の結果）。作成フォームの描画に使う */
let presetRoomTags = [];

/** 作成直後に PATCH で反映する説明文・タグ。作成ボタン押下時にセットし、roomState 受信後にクリアする */
let pendingRoomMeta = null;

/** 卓を立てるフォームのタグ選択肢を描画する */
function renderRoomTagsPicker(tags) {
  const container = $("room-tags");
  container.textContent = "";
  for (const tag of tags) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = tag.id;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(tag.label));
    container.appendChild(label);
  }
}

/** チェック済みのタグIDを取得する */
function checkedRoomTagIds() {
  return [...document.querySelectorAll('#room-tags input[type="checkbox"]:checked')]
    .map((el) => el.value);
}

/** 卓作成の直後に説明文・タグを反映する。失敗しても卓自体は使えるので握りつぶしてエラー表示のみ行う */
async function applyPendingRoomMeta(code, meta) {
  try {
    const res = await fetch(`/api/rooms/${code}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(meta),
    });
    if (!res.ok) {
      let message = "説明文・タグの保存に失敗しました";
      try {
        const body = await res.json();
        if (typeof body?.error === "string") message = body.error;
      } catch {
        // JSONで返らなかった場合は既定の文言のまま
      }
      showError(message);
    }
  } catch {
    showError("説明文・タグの保存に失敗しました");
  }
}

/** 起動時にプリセット部屋タグを読み込む */
async function loadRoomTags() {
  try {
    const res = await fetch("/api/room-tags", { credentials: "same-origin" });
    if (!res.ok) return;
    const body = await res.json();
    presetRoomTags = Array.isArray(body?.tags) ? body.tags : [];
    renderRoomTagsPicker(presetRoomTags);
  } catch {
    // 読み込めなくてもタグなしで卓は作れるので無視する
  }
}

/**
 * サーバーが停止・再起動するときに返るクローズコード（1001 = going away）。
 * 退室・キックの 1000（正常終了）と区別するために使う。
 * サーバー側の定義は server/rooms.ts の SHUTDOWN_CLOSE_CODE（ビルド無しのため値を二重に持つ）
 */
const SERVER_SHUTDOWN_CLOSE_CODE = 1001;

/**
 * 自動再接続の待ち時間。1秒から倍々にして 30 秒で頭打ちにする。
 * 待たずに繋ぎ直すと、まだ起動していないサーバーに対して高速なループを回すことになり、
 * 実質的に自分たちへの DoS になる
 */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * 諦めるまでの試行回数。1+2+4+8+16+30+30+30 = 約2分。
 * systemd の restart は普通10秒もかからないので十分待てて、
 * サーバーが本当に落ちたままのときは無限に試し続けない
 */
const RECONNECT_MAX_ATTEMPTS = 8;

/** ページ内の状態 */
const state = {
  ws: null,
  snapshot: null,
  view: null,
  phase: "lobby",
  deadline: null,
  // 自分から退室した直後の切断かどうか（true の間は onclose のエラー表示を抑制する）
  leaving: false,
  // サーバー再起動による自動再接続の途中かどうか（onopen で false に戻す）
  reconnecting: false,
  // 次に繋がったら「再起動からの復帰」であることを onopen へ伝える受け渡し用
  restartRecovery: false,
  // 再起動からの復帰として join を送り、その返事を待っている最中かどうか。
  // ルームはサーバーのメモリ上にしかないため再起動で必ず消えており、この join は
  // ROOM_NOT_FOUND で失敗する。打ち間違いの ROOM_NOT_FOUND と区別するために持つ
  rejoinAfterRestart: false,
  // これまでの自動再接続の試行回数。待ち時間の指数と、諦める判定に使う
  reconnectAttempts: 0,
  // 再接続待ちの setTimeout ハンドル。多重に予約しないための番人でもある
  reconnectTimer: null,
};

/**
 * サーバー再起動による切断から、待ち時間を伸ばしつつ繋ぎ直す。
 *
 * 2回目以降の試行が失敗したときのクローズコードは 1001 ではなく 1006（異常終了）に
 * なるため、コードだけで判定すると1回で再試行が止まってしまう。そこで
 * state.reconnecting を立てて「再接続モードに入っている間は再試行する」形にしている
 */
function scheduleReconnect() {
  // 既に次の試行を予約済みなら何もしない（onerror と onclose の二重発火よけ）
  if (state.reconnectTimer !== null) return;
  if (state.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    state.reconnecting = false;
    // ここまで来たらサーバーが戻る見込みはない。畳まずに放置すると、通話相手も
    // 同じ理由で消えているのにマイク・カメラだけが動き続け、カメラのランプが
    // 永久に点いたままになる（ROOM_NOT_FOUND の経路と違い、ここは復帰しない）
    const wasInCall = VC.getState().active;
    VC.teardown();
    // 通話が切れたことは利用者から見える変化なので、黙って切らずに理由まで伝える
    showError(
      wasInCall
        ? "サーバーに繋がりません。通話を終了しました。サーバーが戻ってから再読み込みしてください"
        : "サーバーに繋がりません。サーバーが戻ってから再読み込みしてください",
    );
    // 通話を畳んだので VC のボタン表示（参加中のまま）を実態に合わせ直す
    renderAll();
    return;
  }
  state.reconnecting = true;
  // 繋がった先で送る復帰 join が「再起動起因」だと分かるようにしておく
  state.restartRecovery = true;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** state.reconnectAttempts, RECONNECT_MAX_MS);
  state.reconnectAttempts += 1;
  // 待っているあいだも利用者に落ち度はないので、赤い警告ではなく通知として出す。
  // 諦めたときだけは、利用者に操作（再読み込み）を求めるのでエラー表示に戻す
  showNotice(
    `サーバーを再起動しています。${Math.round(delay / 1000)}秒後に自動で繋ぎ直します` +
      `（${state.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS}回目）`,
  );
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, delay);
}

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
  const box = $("error");
  // 直前に showNotice で出していた場合に備えて、警告の見た目へ戻す
  box.className = "alert";
  box.setAttribute("role", "alert");
  box.textContent = text ?? "";
}

/**
 * 利用者に落ち度のない事実（サーバーの再起動など）を伝える。
 * 同じ場所を使うが、赤い警告（.alert）ではなく落ち着いた .notice で出す。
 * 読み上げの割り込みも要らないので role は alert ではなく status にする
 */
function showNotice(text) {
  const box = $("error");
  box.className = "notice";
  box.setAttribute("role", "status");
  box.textContent = text ?? "";
}

/** ログイン状態を確認して表示する（§3.0） */
async function refreshAccount() {
  const res = await fetch("/api/me", { credentials: "same-origin" });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const loggedIn = res.ok && body !== null && typeof body.userId === "string";
  $("account-status").textContent = loggedIn ? `ログイン中: ${body.userId}` : "未ログイン";
  $("logout").classList.toggle("hidden", !loggedIn);
  $("login-link").classList.toggle("hidden", loggedIn);
  $("profile-link").classList.toggle("hidden", !loggedIn);

  // 保存済みのあだ名があれば入室欄に自動入力する（§3.0）。ユーザーが既に入力していたら上書きしない
  if (loggedIn && typeof body.nickname === "string" && $("nickname").value === "") {
    $("nickname").value = body.nickname;
  }
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
    // ここまで来たら接続済みなので、直前の退室フラグが残っていても持ち越さない
    state.leaving = false;
    // 繋がったので待ち時間はリセットする（次の再起動もまた1秒から始められる）
    state.reconnecting = false;
    state.reconnectAttempts = 0;
    // 「再起動からの復帰か」はここで受け取って、この後の join の返事まで持ち越す
    const afterRestart = state.restartRecovery;
    state.restartRecovery = false;
    const saved = store.load();
    if (saved !== null) {
      // 再接続を試す（60秒以内なら復帰できる）。session が生きていればサーバーは
      // あだ名を見ない（doJoin が reconnect で早期 return する）ので、あだ名を省略して
      // 入室した人も復帰できるよう空欄でも送る。猶予を過ぎていた場合は新規入室に
      // 倒れ、そこでも空欄ならあらためて二つ名が付く
      const msg = { t: "join", roomCode: saved.code, session: saved.session };
      const nickname = $("nickname").value.trim();
      if (nickname.length > 0) msg.nickname = nickname;
      state.rejoinAfterRestart = afterRestart;
      send(msg);
    }
  };
  ws.onclose = (event) => {
    if (state.leaving) {
      state.leaving = false;
      // 退室によるサーバー側切断なので、一覧に戻れるようソケットを張り直す
      connect();
      return;
    }
    // 1001（going away）はサーバーの停止・再起動。少し待てば同じ URL に戻ってくるので、
    // 再読み込みを促すのではなく案内を出して自動で張り直す。
    // 再接続モードに入っている間は、繋がらなかった試行（1006）もここで扱う。
    //
    // ここで VC.teardown() を呼ばないのは意図的（早く畳んだ方が良さそうに見えるが、
    // それは改悪になる）。VC は P2P で、メディアはブラウザ同士が直接やり取りしており
    // サーバーを経由していない（サーバーが担うのはシグナリングだけ・§3.6）。
    // つまりサーバーが再起動している数秒のあいだ、通話そのものは生きたまま繋がり続けて
    // いる。ここで畳むと「まだ正常に機能している通話を、こちらから壊す」ことになる。
    // 復帰できないと確定してから畳む（receive の ROOM_NOT_FOUND と scheduleReconnect
    // の諦めた側の分岐、その2か所だけ）
    if (event.code === SERVER_SHUTDOWN_CLOSE_CODE || state.reconnecting) {
      scheduleReconnect();
      return;
    }
    showError("接続が切れました。再読み込みしてください");
  };
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
    // 通話の文字起こし（docs/design/bot-voice.md §5.4）
    Voice.handleServerMessage(msg);
    Chat.handleServerMessage(msg);
    // bot の演出面（docs/design/bot.md §4）
    Bot.handleServerMessage(msg);
    // サンドボックスゲーム（docs/design/game-sandbox.md）
    Sandbox.handleServerMessage(msg);
    // ボットの VC タイル（見た目のみ）。Bot モジュールの状態確定後に描き直す
    renderVcBotTiles();
    if (msg.t === "chat" && msg.message !== undefined && msg.message.bot === true) {
      glowBotVcTile(msg.message.botId);
    }
  };
}

/**
 * 卓から離れた状態に戻し、一覧の見える画面を描き直す。
 * #entry の hidden が外れると rooms.js が MutationObserver で一覧を取り直すので、
 * ここでは一覧の更新を明示的に呼ばなくてよい。
 * 画面に出す文言は状況ごとに違うので、呼び出し側が描画のあとに出す
 */
function resetToEntry() {
  store.drop();
  state.snapshot = null;
  state.rejoinAfterRestart = false;
  Chat.reset();
  Voice.reset();
  Bot.reset();
  Sandbox.reset();
  renderAll();
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
      Chat.setSelfId(msg.snapshot.youId);
      Voice.setSelfId(msg.snapshot.youId);
      Bot.setSelfId(msg.snapshot.youId);
      // 復帰 join の返事が来たので、再起動起因かどうかの記憶はここで捨てる
      state.rejoinAfterRestart = false;
      showError("");
      if (pendingRoomMeta !== null) {
        const meta = pendingRoomMeta;
        pendingRoomMeta = null;
        applyPendingRoomMeta(msg.snapshot.code, meta);
      }
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
      resetToEntry();
      showError("ルームから退出しました");
      break;
    case "error":
      pendingRoomMeta = null;
      // 再起動からの復帰 join が失敗したときだけ、事実の通知として扱う。
      // ルームはサーバーのメモリ上にしかないので、再起動すれば必ずこうなる。
      // 利用者は何も間違えていないので、赤い警告ではなく .notice で伝え、
      // 次に取れる行動（別の卓に入る・作り直す）へ繋がる一覧の見える画面に戻す。
      // 参加コードの打ち間違いなど、通常の ROOM_NOT_FOUND の文言は変えない
      if (msg.code === "ROOM_NOT_FOUND" && state.rejoinAfterRestart) {
        // ピアに bye は送らずに VC を畳む。相手も同じ再起動で切れているので通知は届かず、
        // 繋ぎ直した先の新しいサーバーへ宛先不明の rtcSignal を投げるだけになる。
        // それでもマイク・カメラのトラックは必ず止める（カメラのランプが残らないように）
        VC.teardown();
        // 保存済みセッションを捨てないと、次に開いたときも消えた卓へ復帰しようとする
        resetToEntry();
        showNotice("サーバーが再起動したため、卓は解散しました。一覧から入り直してください");
        break;
      }
      state.rejoinAfterRestart = false;
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
  $("bot").classList.toggle("hidden", snapshot === null);
  $("chat").classList.toggle("hidden", snapshot === null);
  $("phase").classList.toggle("hidden", snapshot === null);
  $("sandbox").classList.toggle("hidden", snapshot === null);
  renderVc();
  renderVcBotTiles();
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

/** 品質判定モード（§3.6）の表示名。iOS Safari 実機で画面から確認できるようにする */
const VC_QUALITY_MODE_LABELS = {
  primary: "主指標",
  fallback: "代替指標",
  unknown: "判定不可",
};

/**
 * VC 卓（#vc-media）にボットを「参加している風」に見せるための表示専用データ。
 * 音声合成・音声認識・WebRTC のピア接続は一切行わない（見た目だけ。VC_CAPACITY も消費しない）。
 * bot.js の BOTS（id/name/role）は非公開のため、表示専用の情報としてここに複製する。
 */
const BOT_VC_INFO = [
  { id: "shunpi", name: "しゅんぴ", role: "あだ名をつける" },
  { id: "seri", name: "せり", role: "川柳を見つける" },
  { id: "gucchi", name: "ぐっちー", role: "場を温める" },
  { id: "nabe", name: "なべ", role: "進行を仕切る" },
];

/** botId → 自分が #vc-media に足したタイル一式（root 要素と発言演出のタイマー） */
const botVcTiles = new Map();

/** ボットの VC タイルを1つ組み立てる（画像は使わず CSS のみ。中身は固定文言のみなので textContent で十分） */
function createBotVcTile(info) {
  const root = document.createElement("div");
  root.className = "vc-peer vc-peer-bot";
  root.dataset.botId = info.id;

  const mark = document.createElement("span");
  mark.className = "vc-bot-mark";
  mark.textContent = "BOT";
  root.appendChild(mark);

  const face = document.createElement("div");
  face.className = "vc-bot-face";
  face.dataset.botId = info.id;
  root.appendChild(face);

  const label = document.createElement("p");
  label.className = "vc-peer-label vc-bot-label";
  label.textContent = info.name;
  root.appendChild(label);

  const role = document.createElement("p");
  role.className = "vc-bot-role";
  role.textContent = info.role;
  root.appendChild(role);

  return { root, glowTimer: null };
}

/**
 * 有効なボットだけを #vc-media に出す／無効・退室なら消す。
 * vc.js が管理する人のタイルには触れず、botVcTiles に控えた自分ぶんのタイルだけを
 * 個別に追加・削除する（コンテナ全体を clear しない。vc.js のタイルと共存する）。
 * VC に参加していなくても表示する（ボットは音声を扱わず、部屋にいる間ずっと
 * 「その場にいる」演出のため。ホストの ON/OFF だけに従う）。
 */
function renderVcBotTiles() {
  const container = $("vc-media");
  if (container === null) return;
  if (state.snapshot === null) {
    for (const tile of botVcTiles.values()) {
      if (tile.glowTimer !== null) clearTimeout(tile.glowTimer);
      tile.root.remove();
    }
    botVcTiles.clear();
    return;
  }
  const bots = Bot.getState().bots;
  for (const info of BOT_VC_INFO) {
    const enabled = bots[info.id] !== false;
    const existing = botVcTiles.get(info.id);
    if (enabled && existing === undefined) {
      const tile = createBotVcTile(info);
      container.appendChild(tile.root);
      botVcTiles.set(info.id, tile);
    } else if (!enabled && existing !== undefined) {
      if (existing.glowTimer !== null) clearTimeout(existing.glowTimer);
      existing.root.remove();
      botVcTiles.delete(info.id);
    }
  }
}

/**
 * ボットがチャットで発言したとき、そのボットのタイルを短時間だけ光らせる（演出のみ・任意）。
 * prefers-reduced-motion のときは en.css 側でアニメーションを止める。
 */
function glowBotVcTile(botId) {
  const tile = botVcTiles.get(botId);
  if (tile === undefined) return;
  if (tile.glowTimer !== null) clearTimeout(tile.glowTimer);
  tile.root.classList.add("vc-bot-speaking");
  tile.glowTimer = setTimeout(() => {
    tile.root.classList.remove("vc-bot-speaking");
    tile.glowTimer = null;
  }, 1600);
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
  const peers = vc.peers
    .map((p) => `${p.nickname}: ${p.connectionState}${p.degraded === true ? "（品質低下）" : ""}`)
    .join(" / ");
  const head = vc.active ? "参加中" : vc.eligible ? "未参加" : "未参加（VC枠外）";
  $("vc-status").textContent = peers.length > 0 ? `${head} — ${peers}` : head;
  renderVcQuality(vc);
}

/**
 * 品質劣化時の映像自動停止（§3.6）まわりの表示を更新する。
 * quality はコア側（vc.js）の品質監視が有効なときだけ入る。
 */
function renderVcQuality(vc) {
  const quality = vc.quality;
  const resume = $("vc-resume");
  const mode = $("vc-quality-mode");
  if (quality === undefined || quality === null || !vc.active) {
    // VC 未参加なら前回の通知文言も消す（退室で状態はリセットされる）
    if (!vc.active) $("vc-quality").textContent = "";
    resume.classList.add("hidden");
    resume.classList.remove("vc-resume-ready");
    mode.textContent = "";
    return;
  }
  // 自動停止中のみ再開操作を出す。映像は自動では戻さない（§3.6 の明示操作規定）
  resume.classList.toggle("hidden", quality.autoStopped !== true);
  // 回復済みで再開を勧められるときだけ強調する
  resume.classList.toggle("vc-resume-ready", quality.canResume === true);
  const label = VC_QUALITY_MODE_LABELS[quality.mode];
  mode.textContent = `判定: ${label === undefined ? "判定不可" : label}`;
}

/**
 * サーバーから ICE サーバー設定（STUN / TURN）を取得する。
 * 取得できなければ null を返し、VC 側の既定（STUN のみ）で続行する。
 */
async function fetchIceServers() {
  try {
    const res = await fetch("/api/ice", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();
    const servers = data === null ? undefined : data.iceServers;
    return Array.isArray(servers) && servers.length > 0 ? servers : null;
  } catch {
    return null;
  }
}

/** VC モジュールを組み込む。iceServers が null なら VC 側の既定を使う */
function bindVc(iceServers) {
  VC.init({
    send,
    iceServers,
    container: $("vc-media"),
    onStatus: (event) => {
      if (event.kind === "error") showError(event.message);
      // 品質劣化の通知（§3.6）は異常ではなく正常な保護動作なので、
      // エラー表示（赤字・他のエラーで上書きされる）ではなく専用の枠に出す
      if (event.kind === "quality") $("vc-quality").textContent = event.message;
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
  $("vc-resume").addEventListener("click", () => {
    // 自動停止した映像は本人の明示操作でのみ戻す（§3.6）
    if (typeof VC.resumeCamera !== "function") {
      log("VC", "resumeCamera が未実装のため再開できません");
      return;
    }
    // 停止・回復の文言は再開の時点で役目を終える（VC 側は kind:"quality" を出さない）
    $("vc-quality").textContent = "";
    Promise.resolve(VC.resumeCamera()).then(renderVc, () => renderVc());
  });
}

/**
 * Voice モジュールを組み込む（docs/design/bot-voice.md §5.4）。
 * 非対応ブラウザ（iOS Safari・Firefox 等）ではトグルを無効化し、理由を title で示す。
 */
function bindVoice() {
  const transcribeBtn = $("vc-transcribe");
  // ボタン文言は常に Voice.getState().enabled から導く（vc-camera / vc-mute と同じ流儀）。
  // 権限拒否や5回連続失敗など、クリック以外の理由で OFF に倒れたときも表示がずれない
  const syncTranscribeLabel = () => {
    transcribeBtn.textContent = Voice.getState().enabled ? "文字起こしOFF" : "文字起こしON";
  };
  Voice.init({
    send,
    captionEl: $("voice-caption"),
    linesEl: $("voice-lines"),
    onStatus: (event) => {
      $("vc-status").textContent = event.message;
      syncTranscribeLabel();
    },
  });
  if (!Voice.isSupported()) {
    transcribeBtn.disabled = true;
    transcribeBtn.title = "このブラウザは音声の文字起こしに対応していません";
    return;
  }
  transcribeBtn.addEventListener("click", () => {
    Voice.toggle();
    syncTranscribeLabel();
  });
}

/** 操作の割り当て */
function bind() {
  $("logout").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    location.href = "/login.html";
  });
  $("create").addEventListener("click", () => {
    state.rejoinAfterRestart = false;
    // 公開ルームはルーム名必須（§3.1）。一覧（rooms.js）に載るのはこちらだけ
    const visibility = $("visibility").value === "public" ? "public" : "private";
    const msg = { t: "createRoom", nickname: $("nickname").value, visibility };
    if (visibility === "public") {
      msg.roomName = $("room-name").value;
      pendingRoomMeta = {
        description: $("room-description").value,
        tags: checkedRoomTagIds(),
      };
    } else {
      pendingRoomMeta = null;
    }
    send(msg);
  });
  $("join").addEventListener("click", () => {
    pendingRoomMeta = null;
    // 自分で入り直す操作。以降の ROOM_NOT_FOUND は打ち間違いなので通常の文言に戻す
    state.rejoinAfterRestart = false;
    // 空欄なら nickname を積まない。省略するとしゅんぴが二つ名を付ける（§3.10）。
    // 空文字は「入力し忘れ」と区別できないのでサーバーが弾く（types.ts の join 参照）
    const msg = { t: "join", roomCode: $("code").value };
    const nickname = $("nickname").value.trim();
    if (nickname.length > 0) msg.nickname = nickname;
    send(msg);
  });
  $("select-game").addEventListener("click", () => {
    send({ t: "selectGame", gameId: $("game").value });
  });
  $("start").addEventListener("click", () => send({ t: "startGame" }));
  $("skip").addEventListener("click", () => send({ t: "skipPhase" }));
  $("leave").addEventListener("click", () => {
    state.leaving = true;
    VC.leave();
    send({ t: "leave" });
    resetToEntry();
  });
  bindVoice();
  Bot.init({
    send,
    container: $("bot"),
    onError: showError,
  });
  Chat.init({
    send,
    listEl: $("chat-log"),
    inputEl: $("chat-text"),
    formEl: $("chat-form"),
    onError: showError,
  });
  Sandbox.init({
    send,
    container: $("sandbox"),
    onStatus: (event) => {
      if (event.kind === "error") showError(event.message);
      log("Sandbox", event.message);
    },
  });
}

/** 起動する。ICE 設定を先に取ってから VC を初期化する */
async function start() {
  bind();
  loadRoomTags();
  refreshAccount();
  bindVc(await fetchIceServers());
  connect();
}

start();
