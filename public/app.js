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

/** テキストだけを持つ要素を作る（className は任意。chat.js / bot.js と同じ形） */
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className !== undefined) node.className = className;
  return node;
}

/** VC への自動参加が進行中か（マイクの許可を待っている間だけ true） */
let vcJoining = false;

/**
 * いま選ばれているあそび（"official:<id>" / "sandbox:<id>"）。
 * 選択欄を品書きに置き換えたので、選択は画面ではなくここが持つ。
 * serverSelectedGameId は、卓側の選択が変わったことを見分けるための控え。
 */
const gameChoiceState = { choice: null, serverSelectedGameId: undefined };

/** 作成直後に PATCH で反映する説明文・タグ。作成ボタン押下時にセットし、roomState 受信後にクリアする */
let pendingRoomMeta = null;

/**
 * createRoom を送る。#create ボタンでの手動作成と、entrance.html からの
 * 自動作成（RoomHandoff、connect() の ws.onopen 参照）の両方から呼ぶ。
 */
function doCreateRoom({ nickname, visibility, roomName, description, tags }) {
  state.rejoinAfterRestart = false;
  const msg = { t: "createRoom", nickname, visibility };
  if (visibility === "public") {
    msg.roomName = roomName ?? "";
    pendingRoomMeta = { description: description ?? "", tags: Array.isArray(tags) ? tags : [] };
  } else {
    pendingRoomMeta = null;
  }
  send(msg);
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
  // ログイン済みか（/api/me の結果）。「お会計」の出し入れに使う
  loggedIn: false,
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
  state.loggedIn = loggedIn;
  $("account-status").textContent = loggedIn ? `ログイン中: ${body.userId}` : "未ログイン";
  $("login-link").classList.toggle("hidden", loggedIn);
  $("profile-link").classList.toggle("hidden", !loggedIn);
  renderLogout();

  // 保存済みのあだ名があれば入室欄に自動入力する（§3.0）。ユーザーが既に入力していたら上書きしない
  if (loggedIn && typeof body.nickname === "string" && $("nickname").value === "") {
    $("nickname").value = body.nickname;
  } else if (!loggedIn && $("nickname").value === "") {
    // ゲストの一時あだ名（entrance.html の簡易プロフィール編集で保存したもの、§3.0）
    // があれば同様に自動入力する
    const guest = GuestProfile.getGuestProfile();
    if (guest.nickname !== "") $("nickname").value = guest.nickname;
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
    // create-room.html / corridor.html から渡された「これから建てる卓」「入りたい卓」が
    // あれば読み出す。再接続すべきセッションがある場合（下の if 分岐）はそちらを優先するが、
    // 読み出し自体は必ず行い sessionStorage から消しておく。そうしないと、
    // 今回は再接続が勝って使わなかった pending が sessionStorage に残ったまま
    // になり、この後の「退室 → 新規 onopen」など別の再接続のない機会に
    // 意図せず自動作成・自動入室が発火してしまう
    const pendingCreate = RoomHandoff.consumePendingCreateRoom();
    const pendingJoin = RoomHandoff.consumePendingJoinRoom();
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
    } else if (pendingCreate !== null) {
      doCreateRoom(pendingCreate);
    } else if (pendingJoin !== null) {
      // corridor.html で扉を選んだ卓に入る。あだ名は集めていないので空欄のまま送る
      // （join はあだ名省略可。サーバーが自動で二つ名を付ける、§3.10）
      state.rejoinAfterRestart = false;
      send({ t: "join", roomCode: pendingJoin.roomCode });
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
    // 卓に着いたら VC にも自動で参加する（VC.handleServerMessage が selfId を
    // 入れた後でないと join() が弾かれるので、この順で呼ぶ）
    autoJoinVc(msg);
    // 通話の文字起こし（docs/design/bot-voice.md §5.4）
    Voice.handleServerMessage(msg);
    autoStartVoice(msg);
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
  // 卓を出たらざわめきも止める。一覧に戻ったのに店内の音が続くと居場所が分からない
  Sound.stop("gaya");
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
      // 卓に入った瞬間だけ、戸を叩いてふすまが開く。roomState は再接続でも飛んでくるので
      // 「いま卓の外にいた」ときに限る。以降はざわめきを絞ったまま流し続ける
      if (state.snapshot === null) {
        Sound.sequence("knock", "slidingScreen");
        Sound.loop("gaya", { volume: Sound.GAYA_ROOM });
      }
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
      // チャットに流れている提案ボタンの可否はホストかどうかで変わる。
      // chat.js は chat / roomState でしか描き直さないので、ここで促す
      Chat.refresh();
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

/**
 * 「お会計」の出し入れ。
 *
 * お座敷一覧にいるときだけ出す。卓に着いている間は、抜ける道は
 * 「お先に失礼」の一本にしたい（帯からいきなり店を出られると、
 * 同席者への挨拶も VC の後始末も飛ばすことになる）。
 */
function renderLogout() {
  const inRoom = state.snapshot !== null;
  $("logout").classList.toggle("hidden", !state.loggedIn || inRoom);
}

/** 画面全体を描き直す */
function renderAll() {
  const snapshot = state.snapshot;
  renderLogout();
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
    `${snapshot.players.length} / ${snapshot.capacity}人・${phaseLabel(state.phase)}` +
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
  // ロビー中かは CSS からも要る（卓上と座の面で高さの配り方を変える）。
  // 入口の .hidden を :has() で見ていたが、入口を左レールへ移して列をまたいだ
  // ので、列に依らない body の属性で持つ
  document.body.dataset.roomPhase = inLobby ? "lobby" : "playing";
  syncGameChoice(snapshot);
  $("skip").disabled = !snapshot.youAreHost || inLobby;
  $("start").disabled = !snapshot.youAreHost;
  // 選ぶこと自体は誰でもできてよいが、卓に伝わる（selectGame）のはホストだけ。
  // 見るぶんには全員に開けたほうが、次に何をやるか相談しやすい
  $("game-open").disabled = false;

  renderPhase();
}

/** 採点方式の日本語名（server/types.ts の ScoringMode と1対1） */
const SCORING_LABELS = {
  vote: "投票で採点",
  match: "一致で採点",
  correct: "正解で採点",
};

/**
 * サムネの地の色。離れた色相を並べてあり、品書きの並び順に配る。
 * IDのハッシュから決めると、たまたま同じ色が2枚並ぶ（実際に起きた）。
 * 並び順は「公式ゲーム→余興」で安定しているので、開くたびに変わることもない。
 */
const THUMB_HUES = [28, 202, 96, 330, 44, 268, 168, 8];

/**
 * 品書きに並べる1本ぶんの情報に均す。
 *
 * 公式ゲーム（roomState の availableGames）と余興サンドボックス
 * （/api/sandboxGames）は形も出どころも違うので、ここで同じ形にしてから
 * 札を組む。choice が "official:<id>" / "sandbox:<id>"（開始時の出し分け用）。
 */
function listGames(snapshot) {
  const games = [];
  const withHue = (game) => ({ ...game, hue: THUMB_HUES[games.length % THUMB_HUES.length] });
  for (const game of snapshot.availableGames) {
    const scoring = SCORING_LABELS[game.scoring];
    games.push(withHue({
      choice: `official:${game.id}`,
      id: game.id,
      title: game.title,
      description: game.description ?? "",
      meta: `${game.rounds}ラウンド・${scoring === undefined ? game.scoring : scoring}`,
      badge: "宴の余興",
      official: true,
    }));
  }
  for (const game of Sandbox.getGames()) {
    games.push(withHue({
      choice: `sandbox:${game.id}`,
      id: game.id,
      title: game.title,
      description: game.description ?? "",
      meta: `${game.minPlayers}〜${game.maxPlayers}人・作: ${game.author}`,
      badge: "あそび（点は付かない）",
      official: false,
    }));
  }
  return games;
}

/** 選択欄の値を { kind, gameId } に解く */
function parseGameChoice(value) {
  if (typeof value !== "string") return null;
  const sep = value.indexOf(":");
  if (sep < 0) return null;
  return { kind: value.slice(0, sep), gameId: value.slice(sep + 1) };
}

/** いま選ばれている1本を返す。無ければ null */
function currentGame() {
  if (state.snapshot === null) return null;
  return listGames(state.snapshot).find((g) => g.choice === gameChoiceState.choice) ?? null;
}

/**
 * 品書き（ゲーム一覧）を組み直す。
 * 余興の一覧は HTTP で後から届く（sandbox.js の onGames）ため、何度も呼ばれる。
 */
function renderGamePlatform() {
  const list = $("game-list");
  clear(list);
  if (state.snapshot === null) return;

  const games = listGames(state.snapshot);
  if (games.length === 0) {
    list.appendChild(el("p", "あそびがまだありません", "platform-empty"));
    return;
  }

  for (const game of games) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "gamecard";
    card.dataset.choice = game.choice;
    card.setAttribute("aria-pressed", game.choice === gameChoiceState.choice ? "true" : "false");

    // 絵は用意されていないので、題名の一文字目を明朝で置いた札をサムネにする
    const thumb = el("span", [...game.title][0] ?? "宴", "gamecard-thumb");
    thumb.style.setProperty("--thumb-hue", String(game.hue));
    thumb.setAttribute("aria-hidden", "true");
    card.appendChild(thumb);

    card.appendChild(el("span", game.title, "gamecard-title"));
    card.appendChild(el("span", game.meta, "gamecard-meta"));
    if (game.description.length > 0) {
      card.appendChild(el("span", game.description, "gamecard-desc"));
    }
    card.appendChild(
      el("span", game.badge, `gamecard-badge${game.official ? " gamecard-badge-official" : ""}`),
    );

    // 選べるのはホストだけ。非ホストが選んでも卓には伝わらず、次の roomState で
    // 戻されて食い違うだけなので、押させない（読むぶんには開けておく）
    card.disabled = !canStartGame();
    card.addEventListener("click", () => pickGame(game.choice));
    list.appendChild(card);
  }
}

/** 1本を選ぶ。品書きを開いたままでも、選び直しがその場で見える */
function pickGame(choice) {
  gameChoiceState.choice = choice;
  const parsed = parseGameChoice(choice);
  // 公式ゲームは選んだ時点で卓に伝える。全員に「何が選ばれたか」が見える
  if (parsed !== null && parsed.kind === "official" && state.snapshot !== null) {
    if (state.snapshot.selectedGameId !== parsed.gameId) {
      send({ t: "selectGame", gameId: parsed.gameId });
    }
  }
  for (const card of $("game-list").children) {
    if (card.dataset === undefined) continue;
    card.setAttribute("aria-pressed", card.dataset.choice === choice ? "true" : "false");
  }
  renderGamePick();
}

/** いま選ばれている1本の表示（卓の札と品書きの足元）を更新する */
function renderGamePick() {
  const game = currentGame();
  const label = game === null ? "まだ選ばれていません" : `${game.title}（${game.meta}）`;
  $("game-current").textContent = label;
  $("platform-pick").textContent = canStartGame()
    ? (game === null ? "あそびを選んでください" : label)
    : `${label}（選べるのはホストだけです）`;
  $("platform-start").disabled = game === null || !canStartGame();
}

/** ゲームを始められるか（ホストだけ） */
function canStartGame() {
  return state.snapshot !== null && state.snapshot.youAreHost;
}

/**
 * 卓の選択（selectGame）に画面を追随させ、品書きを組み直す。
 *
 * ボットの提案や、ホスト交代後の選び直しも selectGame で流れてくるので、
 * サーバー側の値が変わったときは、こちらの選択もそれに合わせる。
 * 余興を選んでいる間は selectedGameId が動かないため、上書きされない。
 */
function syncGameChoice(snapshot) {
  if (snapshot.selectedGameId !== gameChoiceState.serverSelectedGameId) {
    gameChoiceState.serverSelectedGameId = snapshot.selectedGameId;
    if (snapshot.selectedGameId !== null) {
      gameChoiceState.choice = `official:${snapshot.selectedGameId}`;
    }
  }
  const games = listGames(snapshot);
  // 選んでいたものが消えた（一覧が入れ替わった）ときは先頭に戻す
  if (!games.some((g) => g.choice === gameChoiceState.choice)) {
    gameChoiceState.choice = games.length > 0 ? games[0].choice : null;
  }
  renderGamePlatform();
  renderGamePick();
}

/**
 * 選ばれているあそびを始める。公式ゲームと余興で出し口が違うので、
 * 種別を見て selectGame+startGame と sandboxStart を分ける。
 */
function startChosenGame() {
  const choice = parseGameChoice(gameChoiceState.choice);
  if (choice === null) {
    showError("あそびを選んでください");
    return;
  }
  if (choice.kind === "sandbox") {
    Sandbox.start(choice.gameId);
    return;
  }
  // 品書きで選んだ時点で送っているが、卓側とずれていれば始める前に揃える
  const selected = state.snapshot === null ? null : state.snapshot.selectedGameId;
  if (selected !== choice.gameId) send({ t: "selectGame", gameId: choice.gameId });
  send({ t: "startGame" });
}

/**
 * bot の発言に付く付加情報（ChatMessage.card）を、その発言の行の中に描く。
 *
 * 卓上に浮かべていたテロップの札は廃止した。提案はチャットの流れに押せる形で
 * 置いたほうが、見逃さず、後からさかのぼっても押せる。
 * 句や詠み手はユーザー由来なので必ず textContent で入れる（§3.8）。
 */
function renderChatCard(message, item) {
  const card = message.card;
  if (card.c === "senryu") {
    const box = el("div", undefined, "chat-card bot-card");
    const lines = el("div", undefined, "bot-senryu-lines");
    const morae = Array.isArray(card.morae) ? card.morae : [0, 0, 0];
    for (const [i, line] of (card.lines ?? []).entries()) {
      const row = el("p", undefined, "bot-senryu-line");
      row.appendChild(el("span", line, "bot-senryu-text"));
      row.appendChild(el("span", morae[i], "bot-senryu-mora"));
      lines.appendChild(row);
    }
    box.appendChild(lines);
    const foot = el("p", undefined, "bot-card-foot");
    const shape = card.exact === true ? "五七五" : Bot.shapeLabel(morae);
    foot.appendChild(el("span", shape, "bot-badge"));
    foot.appendChild(el("span", `${card.author} さんの一句`, "bot-senryu-author"));
    box.appendChild(foot);
    item.appendChild(box);
    return;
  }
  if (card.c === "gameSuggest") {
    const box = el("div", undefined, "chat-card");
    // 何で遊ぶことになるのかを押す口自体に出す（本文を読み返さずに済む）
    const title = typeof card.gameTitle === "string" ? card.gameTitle : "これ";
    const button = el("button", `${title}で遊ぶ`, "btn chat-card-action");
    button.type = "button";
    button.disabled = !canStartGame();
    if (!canStartGame()) button.title = "あそびを選べるのはホストだけです";
    button.addEventListener("click", () => pickGame(`official:${card.gameId}`));
    box.appendChild(button);
    item.appendChild(box);
  }
}

/** 品書きの開け閉め */
function toggleGamePlatform(open) {
  $("game-platform").classList.toggle("hidden", !open);
  if (open) $("platform-close").focus();
}

/** 現在のフェーズを描画する */
function renderPhase() {
  const view = state.view;
  const body = $("phase-body");
  clear(body);
  $("phase-title").textContent = phaseLabel(state.phase);
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
/**
 * フェーズの日本語名（server/types.ts の Phase と1対1）。
 * 画面には必ずこちらを出す。"lobby" のような内部の名前は開発者以外に読めない。
 * 未知の値が来たらそのまま出す（サーバーが増やしたときに空欄にしない）。
 */
const PHASE_LABELS = {
  lobby: "待機中",
  intro: "ゲーム説明",
  prompt: "お題",
  input: "回答中",
  reveal: "答え合わせ",
  judge: "投票中",
  roundResult: "ラウンド結果",
  finalResult: "最終結果",
};

/** フェーズの表示名を返す */
function phaseLabel(phase) {
  const label = PHASE_LABELS[phase];
  return label === undefined ? phase : label;
}

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
  {
    id: "shunpi",
    name: "しゅんぴ",
    role: "あだ名をつける",
    // 荷札。名前を付けて回る役
    glyph: [
      "M3.4 11.6 11.6 3.4H19a1.6 1.6 0 0 1 1.6 1.6v7.4l-8.2 8.2a1.6 1.6 0 0 1-2.26 0L3.4 13.86a1.6 1.6 0 0 1 0-2.26Z",
      "M17.4 7.4a1.3 1.3 0 1 1-2.6 0 1.3 1.3 0 0 1 2.6 0Z",
    ],
  },
  {
    id: "seri",
    name: "せり",
    role: "川柳を見つける",
    // 短冊。中の3本は上から五・七・五のつもりで長さを変えてある
    glyph: [
      "M7 2.6h10a1 1 0 0 1 1 1v16.8a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1Z",
      "M14.6 6.2v5M12 6.2v10.6M9.4 6.2v5",
    ],
  },
  {
    id: "gucchi",
    name: "ぐっちー",
    role: "場を温める",
    // お猪口と湯気。燗をつけて場を温める役
    glyph: [
      "M6.6 11.4h10.8l-1.5 6.1a2.2 2.2 0 0 1-2.14 1.7h-3.52a2.2 2.2 0 0 1-2.14-1.7Z",
      "M5 21.2h14",
      "M10.2 8.4c0-1.4 1.3-1.4 1.3-2.8M14.2 8.4c0-1.4-1.3-1.4-1.3-2.8",
    ],
  },
  {
    id: "nabe",
    name: "なべ",
    role: "進行を仕切る",
    // 土鍋。名前そのまま。蓋を取り仕切る役でもある
    glyph: [
      "M3.4 9.6h17.2",
      "M12 6.2v3.4",
      "M5.2 9.6v4.6a4.4 4.4 0 0 0 4.4 4.4h4.8a4.4 4.4 0 0 0 4.4-4.4V9.6",
      "M5.2 11.8H3M18.8 11.8H21",
    ],
  },
];

/** inline SVG は名前空間付きで作らないと描画されない */
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * ボットの絵を作る。
 *
 * 4体を金の濃淡だけで見分けるのは無理があったので、形と色の両方を変えてある
 * （形＝役どころ、色＝個体）。名前と役の文字は絵の下に別で出ている。
 * 外部の画像・アイコンフォントは読み込めない（§3.8 CSP）ので inline SVG。
 */
function createBotGlyph(info) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "vc-bot-glyph");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of info.glyph) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

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
  face.appendChild(createBotGlyph(info));
  root.appendChild(face);

  const label = document.createElement("p");
  label.className = "vc-peer-label vc-bot-label";
  label.textContent = info.name;
  root.appendChild(label);

  const role = document.createElement("p");
  role.className = "vc-bot-role";
  role.textContent = info.role;
  root.appendChild(role);

  /*
   * ON / OFF。卓上の bot の行の右端に置く（呑み手のミュートと同じ位置感覚）。
   * 押せるのはホストだけ。表示は消さない ―― いま誰が動いているかは全員が
   * 知っておきたい情報で、隠すと bot が黙った理由が分からなくなる（§3.10）。
   * 反映はサーバーの botState で返る。楽観更新はしない（bot.js の toggle）。
   */
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "toggle vc-bot-toggle";
  // 文字を持たないので、読み上げ用の名前は aria-label で付ける
  toggle.setAttribute("aria-label", info.name);
  toggle.addEventListener("click", () => Bot.toggle(info.id));
  root.appendChild(toggle);

  return { root, toggle, glowTimer: null };
}

/**
 * 有効なボットだけを #vc-media に出す／無効・退室なら消す。
 * vc.js が管理する人のタイルには触れず、botVcTiles に控えた自分ぶんのタイルだけを
 * 個別に追加・削除する（コンテナ全体を clear しない。vc.js のタイルと共存する）。
 * VC に参加していなくても表示する（ボットは音声を扱わず、部屋にいる間ずっと
 * 「その場にいる」演出のため。ホストの ON/OFF だけに従う）。
 */
function renderVcBotTiles() {
  const container = $("vc-bots");
  if (container === null) return;
  if (state.snapshot === null) {
    for (const tile of botVcTiles.values()) {
      if (tile.glowTimer !== null) clearTimeout(tile.glowTimer);
      tile.root.remove();
    }
    botVcTiles.clear();
    return;
  }
  const botState = Bot.getState();
  for (const info of BOT_VC_INFO) {
    let tile = botVcTiles.get(info.id);
    if (tile === undefined) {
      tile = createBotVcTile(info);
      container.appendChild(tile.root);
      botVcTiles.set(info.id, tile);
    }
    // OFF でも枠は消さない。消すと戻す手がかりが画面から無くなる
    const enabled = botState.bots[info.id] !== false;
    tile.root.classList.toggle("vc-bot-off", !enabled);
    tile.toggle.disabled = !botState.isHost;
    tile.toggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    tile.toggle.title = botState.isHost
      ? `${info.name}を${enabled ? "黙らせる" : "呼び戻す"}`
      : "bot を切り替えられるのはホストだけです";
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

/**
 * 手元の操作ボタン（ミュート／カメラ／文字起こし）の見た目を更新する。
 *
 * ボタン自身に textContent を入れると中の <svg> ごと消えてしまうので、
 * 文字は .vc-ctl-label にだけ入れる。入／切は data-state で持ち、
 * 斜線入りの絵への差し替えと色は index.html の CSS が受け持つ。
 *
 * aria-pressed は付けない。文言そのものが「ミュート」→「ミュート解除」と
 * 入れ替わる作りなので、押下状態を別に持つと読み上げが二重になる。
 */
function setVcControl(button, on, label) {
  if (button === null) return;
  button.dataset.state = on ? "on" : "off";
  const labelEl = button.querySelector(".vc-ctl-label");
  if (labelEl !== null) labelEl.textContent = label;
}

/** VC の操作ボタンと状態表示を更新する */
function renderVc() {
  const vc = VC.getState();
  $("vc-mute").disabled = !vc.active;
  $("vc-camera").disabled = !vc.active;
  // 文言は「押すとどうなるか」、絵は「いまどうなっているか」を出す（Zoom と同じ流儀）
  setVcControl($("vc-mute"), !vc.muted, vc.muted ? "ミュート解除" : "ミュート");
  setVcControl($("vc-camera"), vc.camera, vc.camera ? "カメラOFF" : "カメラON");
  const peers = vc.peers
    .map((p) => `${p.nickname}: ${p.connectionState}${p.degraded === true ? "（品質低下）" : ""}`)
    .join(" / ");
  const head = vc.active
    ? "参加中"
    : vcJoining
    ? "マイクの許可を待っています…"
    : vc.eligible
    ? "音声なし"
    : "音声なし（VC枠外）";
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

/**
 * 卓に着いたら VC にも自動で参加する。
 *
 * 「VCに参加」「VC退出」のボタンは置いていない。入店＝着席＝声の輪に入る、
 * とひとつながりにするため。抜けるときは卓ごと（「お先に失礼」→ VC.leave）。
 *
 * VC.join() はマイク拒否・枠外（先着6人）・非対応ブラウザをすべて自分で
 * 通知して false を返すので、失敗しても卓そのものは続く（音声なしで居られる）。
 * roomState は再接続でも飛んでくるが、参加中なら join() が早期 return する。
 */
function autoJoinVc(msg) {
  if (msg.t !== "roomState") return;
  if (VC.getState().active) return;
  // 先に一度描き直す。renderAll() は VC.handleServerMessage より前に走るので、
  // ここで描き直さないと「VC枠外」（selfId 未設定のときの既定）が残ってしまう
  vcJoining = true;
  renderVc();
  const done = () => {
    vcJoining = false;
    renderVc();
  };
  VC.join().then(done, done);
}

/**
 * 卓に着いたら文字起こしも始める。
 *
 * VC の自動参加と揃える。ボタンは残してあるので、要らない人はいつでも切れる。
 * 非対応ブラウザ（iOS Safari・Firefox 等）では setEnabled が自分で断るが、
 * 無駄な通知を出さないよう先に isSupported を見る。
 * roomState は再接続でも飛ぶので、すでに ON なら何もしない。
 *
 * 注意: docs/design/bot-voice.md §5.4 は「既定 OFF」と書いてある。
 * この既定は仕様書の記述と食い違うので、追随のこと。
 */
function autoStartVoice(msg) {
  if (msg.t !== "roomState") return;
  if (!Voice.isSupported()) return;
  if (Voice.getState().enabled) return;
  Voice.setEnabled(true);
}

/** VC モジュールを組み込む。iceServers が null なら VC 側の既定を使う */
function bindVc(iceServers) {
  VC.init({
    send,
    iceServers,
    container: $("vc-people"),
    onStatus: (event) => {
      if (event.kind === "error") showError(event.message);
      // 品質劣化の通知（§3.6）は異常ではなく正常な保護動作なので、
      // エラー表示（赤字・他のエラーで上書きされる）ではなく専用の枠に出す
      if (event.kind === "quality") $("vc-quality").textContent = event.message;
      log("VC", event.message);
      renderVc();
    },
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
    const on = Voice.getState().enabled;
    setVcControl(transcribeBtn, on, on ? "文字起こしOFF" : "文字起こしON");
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
  $("game-open").addEventListener("click", () => toggleGamePlatform(true));
  $("platform-close").addEventListener("click", () => toggleGamePlatform(false));
  // 覆いの余白を押したら閉じる（札そのものを押したときは閉じない）
  $("game-platform").addEventListener("click", (event) => {
    if (event.target === $("game-platform")) toggleGamePlatform(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") toggleGamePlatform(false);
  });
  $("platform-start").addEventListener("click", () => {
    toggleGamePlatform(false);
    startChosenGame();
  });
  $("start").addEventListener("click", startChosenGame);
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
    renderCard: renderChatCard,
    listEl: $("chat-log"),
    inputEl: $("chat-text"),
    formEl: $("chat-form"),
    onError: showError,
  });
  Sandbox.init({
    send,
    container: $("sandbox"),
    // 余興の一覧は HTTP で後から届く。揃ったら品書きを組み直す
    onGames: () => {
      if (state.snapshot !== null) syncGameChoice(state.snapshot);
    },
    onStatus: (event) => {
      if (event.kind === "error") showError(event.message);
      log("Sandbox", event.message);
    },
  });
}

/** 起動する。ICE 設定を先に取ってから VC を初期化する */
async function start() {
  bind();
  Sound.bindButtons();
  Sound.mountControls();
  // 入室の音は鳴る間が決まっていて、その場で取りに行くと間に合わない
  Sound.preload("decide", "knock", "slidingScreen");
  refreshAccount();
  bindVc(await fetchIceServers());
  connect();
}

start();
