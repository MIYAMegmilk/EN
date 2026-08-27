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

/**
 * VC への自動参加が進行中か（マイクの許可を待っている間だけ true）。
 * 表示（「マイクの許可を待っています…」）だけでなく、autoJoinVc の
 * 再入ガードも兼ねる。roomState は得点確定やノックでも飛んでくるので、
 * 許可ダイアログを見ているあいだに二度目の join を始めさせない。
 */
let vcJoining = false;

/**
 * 参加処理の最中に「自分が VC 枠へ繰り上がった」知らせを取りこぼしたか。
 *
 * vcJoining の門（上記）は、マイクの許可ダイアログを見ているあいだに届いた
 * 知らせをそのまま捨ててしまう。捨てられたのが繰り上がりの知らせだと、本人は
 * 枠内なのに二度と参加できない（次の知らせが来る保証がない）。そこで
 * 「取りこぼした」ことだけを覚えておき、進行中の参加が落ち着いた時点で一度だけ
 * やり直す。覚えるのは1件だけ（真偽値）で、やり直しを始める前に必ず下ろすので、
 * 新しい知らせが来ない限り再々試行にはならない（マイクを拒否している人が
 * 延々と許可を求められ続けない）。
 */
let vcJoinPending = false;

/**
 * カメラの入切が進行中か（getUserMedia の応答待ちを含む）。
 * 進行中はカメラのボタンを閉じる。閉じないと連打で取得が二重に走る。
 */
let vcCameraBusy = false;

/**
 * いま選ばれているあそび（"official:<id>"）。
 * 選択欄を品書きに置き換えたので、選択は画面ではなくここが持つ。
 * serverSelectedGameId は、卓側の選択が変わったことを見分けるための控え。
 */
const gameChoiceState = { choice: null, serverSelectedGameId: undefined };

/** 作成直後に PATCH で反映する説明文・タグ。作成ボタン押下時にセットし、roomState 受信後にクリアする */
let pendingRoomMeta = null;

/**
 * createRoom を送る。create-room.html からの自動作成（RoomHandoff、
 * connect() の ws.onopen 参照）が唯一の入口。
 *
 * 承認制（entryMode・§3.1.1）は一覧に出す卓にだけ、合言葉（passphrase・§3.1）は
 * 招待制の卓にだけ付く。どちらもサーバー側で同じ条件を検査するので、ここで
 * 混ぜて送るとエラーになる。create-room.js が入力欄を出し分けているが、
 * 積むかどうかの最終判断はこの関数が持つ。
 */
function doCreateRoom(
  { nickname, visibility, roomName, description, tags: roomTags, entryMode, passphrase },
) {
  state.rejoinAfterRestart = false;
  // 卓を建てる本人の趣味タグ（§3.11）。下の roomTags（卓そのものに付くルームタグ）とは別物
  const msg = withMyTags({ t: "createRoom", nickname, visibility });
  if (visibility === "public") {
    msg.roomName = roomName ?? "";
    // 既定は open。knock のときだけ積む（サーバーの既定に合わせる）
    if (entryMode === "knock") msg.entryMode = "knock";
    pendingRoomMeta = {
      description: description ?? "",
      tags: Array.isArray(roomTags) ? roomTags : [],
    };
  } else {
    pendingRoomMeta = null;
    // 空欄なら積まない。付けない卓が大半なので、既定を「無し」にしておく
    const phrase = typeof passphrase === "string" ? passphrase.trim() : "";
    if (phrase.length > 0) msg.passphrase = phrase;
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
  // 「こちらが分かっている正常な切断」の直後かどうか（自分からの退室と、
  // ホストによるキック）。true の間は onclose のエラー表示を抑制し、代わりに
  // ソケットを張り直す。サーバーはどちらも 1000 で閉じるのでコードでは見分けられない
  leaving: false,
  // 直前の切断がキックだったかどうか（張り直しの onopen まで持ち越す）。
  // キックされた卓のトークンは §3.1 のブロック判定のために残すので、何もしないと
  // 繋ぎ直した先で「追い出された卓」へ自動で join し直してしまう。その抑止に使う
  kickedOut: false,
  // 張り直したあとにも出しておきたい文言（キックの理由など）。onopen は
  // showError("") で表示を消すので、消させないためにここで持ち越す
  messageAfterReopen: null,
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
  // サーバー時刻との差（serverTime - Date.now()）。ビューモジュールの秒読みに使う
  serverOffsetMs: 0,
};

/**
 * 趣味タグID → 表示名（GET /api/tags の結果、§3.11）。
 *
 * サーバーは参加者のタグを ID でしか配らない（表示テキストをサーバー由来だけに
 * 保つため）。卓の一覧に日本語で出すには、この対応表が要る。
 * 取得に失敗したら空のままで、その場合は ID をそのまま出す（名前が出ないより良い）
 */
let hobbyTagLabels = new Map();

/**
 * 自分の趣味タグ（§3.11）。ログイン中はアカウント保存の値、ゲストは
 * entrance.html で選んだ一時的な値。入室・卓作成・相席待ちのときに持ち込む
 */
let myHobbyTags = [];

/** 趣味タグの対応表を取ってくる。失敗しても卓自体は使えるので握りつぶす */
async function loadHobbyTagLabels() {
  try {
    const res = await fetch("/api/tags", { credentials: "same-origin" });
    if (!res.ok) return;
    const body = await res.json();
    const tags = Array.isArray(body?.tags) ? body.tags : [];
    hobbyTagLabels = new Map(tags.map((t) => [t.id, t.label]));
  } catch {
    // 対応表が無いだけなら ID で出す。ここで卓に入れなくなる方が困る
  }
}

/**
 * 送るメッセージに自分の趣味タグを積む（§3.11）。
 *
 * 1つも選んでいなければ積まない（空配列でも通るが、送らない方が意図が明確）。
 * 同じ msg を返すので `send(withMyTags({ t: "join", ... }))` と書ける
 */
function withMyTags(msg) {
  if (myHobbyTags.length > 0) msg.tags = [...myHobbyTags];
  return msg;
}

/**
 * 専用モジュール型ゲーム（docs/design/games-unified.md §3.2）の表示。
 *
 * サーバーは進行中、受信者ごとの gameView を配ってくる。こちらはその gameId から
 * ビューモジュール（public/room/games/<id>.js）を動的 import して mount し、
 * 以降は update に view を流すだけにする。ゲームの状態機械はサーバーにしか無い。
 */
const gameModuleState = {
  /** いま mount しているゲームID（未 mount は null） */
  gameId: null,
  /** mount が返したハンドル（{ update, unmount }）。読み込み中は null */
  handle: null,
  /** import の多重発行を防ぐための、読み込み中のゲームID */
  loadingId: null,
  /** mount 前・読み込み中に届いた最新の gameView（mount 直後に流し込む） */
  pending: null,
  /** ビューモジュールを差し込む器。#phase-body の中に置いたまま使い回す */
  host: null,
};

/**
 * 読み込めるビューモジュールのIDか（設計書 §9.3 パス注入の防止）。
 *
 * URL に混ぜてよいのは**サーバーのカタログ由来のID**だけ、というのが規約だが、
 * 受け取った文字列がその形をしているかは受け側でも必ず確かめる。
 * 英小文字・数字・ハイフン・アンダースコアだけを通し、"/" や ".." は弾く
 */
function isLoadableGameId(gameId) {
  return typeof gameId === "string" && /^[a-z0-9_-]{1,32}$/.test(gameId);
}

/**
 * ビューモジュールへ渡す api（設計書 §3.2）。
 *
 * youId / isHost を**取り出すたびに読む getter** にしてあるのが肝。
 * ここを素の値にすると mount した瞬間の値で固まってしまい、進行中の卓へ
 * 途中参加して roomState より先に gameView が届いた場合、`api.youId` が
 * null のまま二度と更新されない（自分の手番・自分の回答を見分けられなくなる）。
 * ゲーム側は view から自分を指す手がかりを持たない実装が多く、モジュールの
 * 中では回避しようがないので、配る側で現在の値を返す形にしておく。
 */
function gameModuleApi() {
  return {
    send: (payload) => send({ t: "gameEvent", payload }),
    get youId() {
      return state.snapshot === null ? null : state.snapshot.youId;
    },
    get isHost() {
      return state.snapshot !== null && state.snapshot.youAreHost === true;
    },
    serverNow: () => Date.now() + state.serverOffsetMs,
  };
}

/**
 * gameView を1件受け取る。まだ mount していなければ、そのゲームの
 * ビューモジュールを読み込んでから流し込む。
 */
function applyGameView(gameId, view, deadline) {
  if (!isLoadableGameId(gameId)) return;
  gameModuleState.pending = { gameId, view, deadline };
  if (gameModuleState.gameId === gameId && gameModuleState.handle !== null) {
    flushGameView();
    return;
  }
  if (gameModuleState.loadingId === gameId) return;
  loadGameModule(gameId);
}

/** 保留している view をビューモジュールへ渡す */
function flushGameView() {
  const pending = gameModuleState.pending;
  const handle = gameModuleState.handle;
  if (pending === null || handle === null) return;
  if (pending.gameId !== gameModuleState.gameId) return;
  try {
    handle.update(pending.view, pending.deadline);
  } catch (error) {
    log("Game", `表示の更新に失敗しました: ${error}`);
  }
}

/**
 * ビューモジュールを読み込んで mount する。
 * import する URL は上の isLoadableGameId を通ったカタログ由来のIDだけから組み立てる。
 */
async function loadGameModule(gameId) {
  unmountGameModule();
  gameModuleState.loadingId = gameId;
  try {
    const module = await import(`/room/games/${gameId}.js`);
    // 読み込みを待っている間に別のゲームへ移った・卓を出た場合は捨てる
    if (gameModuleState.loadingId !== gameId) return;
    if (typeof module.mount !== "function") {
      throw new Error("mount が見つかりません");
    }
    const host = gameModuleHost();
    clear(host);
    gameModuleState.gameId = gameId;
    gameModuleState.handle = module.mount(host, gameModuleApi());
    flushGameView();
  } catch (error) {
    showError("あそびの画面を読み込めませんでした");
    log("Game", `${gameId} の読み込みに失敗しました: ${error}`);
  } finally {
    if (gameModuleState.loadingId === gameId) gameModuleState.loadingId = null;
  }
}

/**
 * ビューモジュールを片付ける。ゲームが終わったとき・卓を出たとき、
 * および loadGameModule が新しいモジュールに差し替える直前に呼ぶ。
 *
 * pending はここで消さない。loadGameModule はまだ mount していない新しい
 * gameView を pending に積んだ直後にこの関数を呼ぶため、ここで pending を
 * null に戻すと「サーバーから1通しか届かない gameView」を mount 前に
 * 取りこぼしてしまう（届いた view はもう二度と再送されない）。
 *
 * 消さなくても誤配信にはならない: flushGameView は
 * `pending.gameId !== gameModuleState.gameId` のときは何もしないので、
 * ここで gameId を null にしておけば、mount が完了して gameId が入り直すまで
 * 古い pending が別のハンドルへ渡ることはない。
 */
function unmountGameModule() {
  const handle = gameModuleState.handle;
  gameModuleState.gameId = null;
  gameModuleState.handle = null;
  gameModuleState.loadingId = null;
  if (handle !== null) {
    try {
      handle.unmount();
    } catch (error) {
      log("Game", `後始末に失敗しました: ${error}`);
    }
  }
  if (gameModuleState.host !== null) clear(gameModuleState.host);
}

/**
 * ビューモジュールを差し込む器を返す。
 *
 * #phase-body は renderPhase のたびに空にされるが、この器そのものは作り直さない。
 * 作り直すと、描き直しのたびにビューモジュールの DOM とリスナが消えてしまう
 * （器を持ち回して付け替えるだけなら、中身はそのまま生き残る）
 */
function gameModuleHost() {
  if (gameModuleState.host === null) {
    gameModuleState.host = el("div", undefined, "game-module");
  }
  return gameModuleState.host;
}

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

/** ログを1行追加する（#log が無いページでは何もしない） */
function log(direction, msg) {
  const box = $("log");
  if (box === null) return;
  const line = el("div", `${direction} ${JSON.stringify(msg)}`);
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

/**
 * ログイン状態を確認して表示する（§3.0）。
 *
 * fetch そのものを try で包むのがこの関数の要。ここで throw を外へ出すと
 * start() の Promise.all ごと転び、その後ろの connect() が呼ばれない。
 * つまり /api/me が一度こけただけで「卓に一切繋がらない」画面になる。
 * サーバーの再起動直後はまさに全要求が一瞬こけるので、現実に踏む。
 *
 * 繋がらなかったときは「未ログイン」とは言い切らない。ログインしている人に
 * 「未ログイン」と出すと、本人は落ち度が自分にあると誤解する（§3.0 の表示は
 * 事実だけを出す）。確認できなかったことをそのまま出し、操作は未ログイン相当で
 * 続けられるようにしておく。
 */
async function refreshAccount() {
  let res = null;
  let body = null;
  try {
    res = await fetch("/api/me", { credentials: "same-origin" });
    body = await res.json();
  } catch {
    // fetch の失敗（通信断・サーバー停止）と、JSON で返らなかった場合の両方。
    // res が取れているかどうかで下の文言を出し分ける
    body = null;
  }
  const reachable = res !== null;
  const loggedIn = reachable && res.ok && body !== null && typeof body.userId === "string";
  state.loggedIn = loggedIn;
  $("account-status").textContent = loggedIn
    ? `ログイン中: ${body.userId}`
    : (reachable ? "未ログイン" : "ログイン状態を確認できませんでした");
  // 名札（profile.html）はログイン中・ゲストどちらも編集できるので常に表示する
  // のれんをくぐる・店内を歩く・卓を建てるの出し分けは renderAccountBar() に任せる
  // （卓に着いている間も隠す必要があり、ログイン状態だけでは決まらないため）
  renderAccountBar();

  // 保存済みのあだ名があれば入室欄に自動入力する（§3.0）。ユーザーが既に入力していたら上書きしない
  if (loggedIn && typeof body.nickname === "string" && $("nickname").value === "") {
    $("nickname").value = body.nickname;
  } else if (!loggedIn && $("nickname").value === "") {
    // ゲストの一時あだ名（entrance.html の簡易プロフィール編集で保存したもの、§3.0）
    // があれば同様に自動入力する
    const guest = GuestProfile.getGuestProfile();
    if (guest.nickname !== "") $("nickname").value = guest.nickname;
  }

  // 趣味タグも同じ出どころから拾う（§3.11）。あだ名と違って入力欄が無いので、
  // 画面には出さず、入室時に持ち込む値としてだけ控えておく
  if (loggedIn) {
    myHobbyTags = Array.isArray(body.tags) ? body.tags : [];
  } else {
    myHobbyTags = GuestProfile.getGuestProfile().tags;
  }
}

/**
 * サーバーへ送る。送れたかどうかを返す。
 *
 * 戻り値があるのは、送信できなかったときに打った本文を消させないため
 * （chat.js の submit 参照）。接続が切れているときに黙って入力欄を空にすると、
 * 長文を打った直後の切断で書き直しになる。
 */
function send(msg) {
  if (state.ws === null || state.ws.readyState !== WebSocket.OPEN) {
    showError("サーバーに接続していません");
    return false;
  }
  try {
    state.ws.send(JSON.stringify(msg));
  } catch {
    // readyState が OPEN でも、直後に閉じられていれば投げる
    showError("サーバーに接続していません");
    return false;
  }
  log("→", msg);
  return true;
}

/** WebSocket を開く */
function connect() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${scheme}//${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    // 繋ぎ直しの理由を伝える文言（キックなど）は消さずに出し直す。
    // ここで一律に空にすると、切断の直前に出した説明が一瞬で消えてしまう
    const carried = state.messageAfterReopen;
    state.messageAfterReopen = null;
    showError(carried ?? "");
    // ここまで来たら接続済みなので、直前の退室フラグが残っていても持ち越さない
    state.leaving = false;
    // 「直前の切断はキックだったか」もここで受け取って捨てる
    const afterKick = state.kickedOut;
    state.kickedOut = false;
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
    // キック直後の張り直しでは、保存済みトークンがあっても自動では入り直さない。
    // そのトークンは §3.1 のブロック判定のために残しているだけで、追い出された卓へ
    // 戻る意思の表明ではない（自分でコードを打ち直したときだけ join に積む）
    if (saved !== null && !afterKick) {
      // 再接続を試す（60秒以内なら復帰できる）。session が生きていればサーバーは
      // あだ名を見ない（doJoin が reconnect で早期 return する）ので、あだ名を省略して
      // 入室した人も復帰できるよう空欄でも送る。猶予を過ぎていた場合は新規入室に
      // 倒れ、そこでも空欄ならあらためて二つ名が付く
      // 猶予内なら session が勝ってタグは見られない。猶予切れで新規入室に倒れた
      // ときのために積んでおく（サーバーは再接続と判断した時点で無視する）
      const msg = withMyTags({ t: "join", roomCode: saved.code, session: saved.session });
      const nickname = $("nickname").value.trim();
      if (nickname.length > 0) msg.nickname = nickname;
      state.rejoinAfterRestart = afterRestart;
      send(msg);
      // 廊下で扉を選んだ・create-room.html で「建てる」を押した直後だと、その
      // 明示的な操作を握りつぶして前の卓へ戻したことになる。どちらが優先かは
      // 卓の再接続の設計（app_reconnect_test.ts が復帰優先を固定している）に
      // 従うが、黙って別の結果にすると「押しても何も起きなかった」と読まれる
      //
      // 行き止まりにしないため、選んだ先へ行く道筋まで書く。「お先に失礼」で
      // 出ると store.drop() で再接続トークンが消え（resetToEntry）、そこから
      // もう一度「店内を歩く」で扉を選べば、今度は競合相手がいないので
      // 選んだ卓に入れる（この2つの導線は卓を出ると出てくる・renderAccountBar）
      if (pendingCreate !== null || pendingJoin !== null) {
        showNotice(
          "前にいた卓へ戻りました。選んだ卓へ移るには、「お先に失礼」で出てから、" +
            "もう一度「店内を歩く」でお選びください",
        );
      }
    } else if (pendingCreate !== null) {
      doCreateRoom(pendingCreate);
    } else if (pendingJoin !== null) {
      // corridor.html で扉を選んだ卓に入る。あだ名は集めていないので空欄のまま送る
      // （join はあだ名省略可。サーバーが自動で二つ名を付ける、§3.10）
      state.rejoinAfterRestart = false;
      send(withMyTags({ t: "join", roomCode: pendingJoin.roomCode }));
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
    // ボットの VC タイル（見た目のみ）。Bot モジュールの状態確定後に描き直す
    renderVcBotTiles();
    if (msg.t === "chat" && msg.message !== undefined && msg.message.bot === true) {
      glowBotVcTile(msg.message.botId);
    }
  };
}

/**
 * ノックの状態（§3.1.1）。
 *
 * 申請者は卓に入っていないので、snapshot ではここが唯一の手がかりになる。
 * 承認されたら entryToken を添えて join し直す（それが §3.1.1 の入室経路）。
 */
const knockState = { roomCode: null, nickname: "" };

/** 公開・承認制の卓にノックする。一覧（rooms.js）の「ノックする」から呼ぶ */
function knockRoom(roomCode) {
  state.rejoinAfterRestart = false;
  pendingRoomMeta = null;
  const nickname = $("nickname").value.trim();
  if (nickname.length === 0) {
    // 承認するホストは名前しか手がかりが無いので、ここだけは省略させない
    showError("ノックにはあだ名が要ります。先に入力してください");
    return;
  }
  knockState.roomCode = roomCode;
  knockState.nickname = nickname;
  const msg = { t: "knock", roomCode, nickname };
  // 前にこの卓へ関わったときのトークンがあれば渡す（ブロック判定に使われる）
  const saved = store.load();
  if (saved !== null && saved.code === roomCode) msg.session = saved.session;
  send(msg);
  showNotice("ノックしました。ホストが気づくまでお待ちください（60秒）");
}

/** ノックの返事。通れば entryToken を添えてそのまま入室する */
function handleKnockResult(msg) {
  const roomCode = msg.roomCode ?? knockState.roomCode;
  if (!msg.accepted || roomCode === null || msg.entryToken === undefined) {
    knockState.roomCode = null;
    showError("入店をお断りされました（時間切れの場合もあります）");
    return;
  }
  showNotice("通していただけました。入店します");
  send(withMyTags({
    t: "join",
    roomCode,
    nickname: knockState.nickname,
    entryToken: msg.entryToken,
  }));
  knockState.roomCode = null;
}

/** ホストの手元に、表で待っている人を出す（§3.2 原則3 によりホストにしか届かない） */
function renderKnocks(snapshot) {
  const box = $("knocks");
  const list = $("knocks-list");
  const knocks = Array.isArray(snapshot.pendingKnocks) ? snapshot.pendingKnocks : [];
  box.classList.toggle("hidden", knocks.length === 0);
  clear(list);
  const full = snapshot.players.length >= snapshot.capacity;
  for (const knock of knocks) {
    const row = el("li");
    row.appendChild(el("span", knock.nickname));
    const actions = el("div", undefined, "knock-actions");
    const ok = el("button", full ? "満席" : "通す", "btn btn-gold btn-mini");
    ok.type = "button";
    // 満席のあいだは通せない。申請は残るので、誰かが抜けたら押せるようになる（§3.1）
    ok.disabled = full;
    ok.addEventListener("click", () => send({ t: "approveKnock", knockId: knock.knockId }));
    const no = el("button", "お断り", "btn btn-mini");
    no.type = "button";
    no.addEventListener("click", () => send({ t: "rejectKnock", knockId: knock.knockId }));
    actions.appendChild(ok);
    actions.appendChild(no);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

/**
 * ランダムマッチ（§3.1.2）の待機状態。
 * サーバーが唯一の状態機械なので、ここは表示のためだけに持つ。
 */
let queueWaiting = false;

/** 待機表示を出し入れする */
function renderQueue(text) {
  queueWaiting = text !== null;
  $("queue-waiting").classList.toggle("hidden", !queueWaiting);
  $("queue-join").disabled = queueWaiting;
  if (text !== null) $("queue-status").textContent = text;
}

/** 相席の待機列に並ぶ。あだ名は空欄でよい（しゅんぴが二つ名を付ける） */
function joinQueue() {
  state.rejoinAfterRestart = false;
  pendingRoomMeta = null;
  const msg = withMyTags({ t: "joinQueue" });
  const nickname = $("nickname").value.trim();
  if (nickname.length > 0) msg.nickname = nickname;
  send(msg);
  renderQueue("席を探しています…");
}

/** 待機列から抜ける */
function leaveQueue() {
  send({ t: "leaveQueue" });
  renderQueue(null);
  showError("");
}

/** 待っている人数の目安と、次に席が合うまでの見込みを出す */
function handleQueueStatus(msg) {
  if (!queueWaiting) return;
  const seconds = Math.max(0, Math.round((msg.nextCheckAt - Date.now()) / 1000));
  const others = Math.max(0, msg.waiting - 1);
  const company = others === 0
    ? "いまはあなただけです"
    : `ほかに${others}人が探しています`;
  renderQueue(`席を探しています…（${company}／次の見合わせまで約${seconds}秒）`);
}

/**
 * 「お引き取り」を押した相手と、その待ち受けを捨てるタイマー。
 * 一度押しただけでは送らず、二度目で確定させる（§3.1）。
 */
let pendingKick = null;

/** 待ち受けを畳む。確定・取り消し・卓を出たときのどれでも通る */
function clearPendingKick() {
  if (pendingKick === null) return;
  clearTimeout(pendingKick.timer);
  pendingKick = null;
}

/**
 * ホストが参加者を退出させる（§3.1）。
 *
 * キックされた人は同じブラウザのままこの卓に戻れなくなる。取り消せない操作なので、
 * 一度目は確認だけ出して、続けてもう一度押されたときに送る。
 * ブラウザの confirm() は使わない。呼ぶと以降のイベントが止まるうえ、
 * 卓の中では VC もゲームも同じタブで動いているので巻き添えが大きい。
 */
function confirmKick(player) {
  if (pendingKick !== null && pendingKick.playerId === player.id) {
    clearPendingKick();
    send({ t: "kick", playerId: player.id });
    renderAll();
    return;
  }
  clearPendingKick();
  pendingKick = {
    playerId: player.id,
    timer: setTimeout(() => {
      pendingKick = null;
      renderAll();
    }, 6000),
  };
  // ボタンのラベルを「本当に？」に変える。再描画されても pendingKick から
  // 組み立て直すので、入室などで描き直されても armed のまま保たれる
  renderAll();
}

/**
 * 卓から離れた状態に戻し、一覧の見える画面を描き直す。
 * #entry の hidden が外れると rooms.js が MutationObserver で一覧を取り直すので、
 * ここでは一覧の更新を明示的に呼ばなくてよい。
 * 画面に出す文言は状況ごとに違うので、呼び出し側が描画のあとに出す
 */
function resetToEntry() {
  store.drop();
  renderQueue(null);
  clearPendingKick();
  // 卓を出たらざわめきも止める。一覧に戻ったのに店内の音が続くと居場所が分からない
  Sound.stop("gaya");
  state.snapshot = null;
  state.rejoinAfterRestart = false;
  Chat.reset();
  Voice.reset();
  Bot.reset();
  unmountGameModule();
  // 順位表も卓のものなので、卓を出たら片付ける。#result は #room / #phase の
  // 子ではなく renderAll() が畳む対象にも入っていないため、ここで消さないと
  // 一覧の画面にも次の卓にも、前の卓のあだ名と得点が出たまま残る
  clearResult();
  // 主役は見ている人ごとの手元の状態。次に入った卓へ持ち越さない
  resetStage();
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
      if (typeof msg.snapshot.serverTime === "number") {
        state.serverOffsetMs = msg.snapshot.serverTime - Date.now();
      }
      // 途中参加・再接続でも、進行中のあそびを丸ごと復元する（設計書 §5）
      if (msg.snapshot.game !== undefined && msg.snapshot.game !== null) {
        applyGameView(
          msg.snapshot.game.gameId,
          msg.snapshot.game.view,
          msg.snapshot.game.deadline,
        );
      } else {
        unmountGameModule();
      }
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
      // 新しいあそびが始まったら、前のあそびの順位表は片付ける。残しておくと
      // あそびの面に居座って主役エリアの高さを奪い続ける（読めるのはロビーの間）
      if (state.phase === "lobby" && msg.phase !== "lobby") clearResult();
      state.phase = msg.phase;
      state.deadline = msg.deadline ?? null;
      state.view = msg.view;
      // あそびが終わった（ロビーへ戻った）ら、ビューモジュールを片付ける。
      // 進行中の gameView は phase とは別便で届く（設計書 §2.2）
      if (msg.phase !== "playing") unmountGameModule();
      if (state.snapshot !== null && msg.view.phase === "lobby") {
        state.snapshot.selectedGameId = msg.view.selectedGameId;
      }
      renderAll();
      break;
    case "gameView":
      applyGameView(msg.gameId, msg.view, msg.deadline);
      break;
    case "roundResult":
      renderScores("ラウンド結果", msg.scores);
      break;
    case "finalResult":
      renderScores("最終結果", msg.scores);
      break;
    case "queueStatus":
      handleQueueStatus(msg);
      break;
    case "matched":
      // 直後に roomState が続くので、ここでは待機表示を畳むだけでよい
      renderQueue(null);
      showNotice("相席が決まりました。入店します");
      break;
    case "knockResult":
      handleKnockResult(msg);
      break;
    case "knockRequest":
      // 申請そのものはスナップショットで届くので、ここでは気づかせるだけ
      showNotice(`${msg.nickname} さんが表でノックしています`);
      break;
    case "kicked": {
      // キックされた卓のトークンは残す。捨てると次に入り直すときに提示できず、
      // サーバーがブロックを判定できなくなる（§3.1）。resetToEntry() は
      // ふつうの退室と共通なので、ここで保存し直す
      const kickedFrom = store.load();
      resetToEntry();
      if (kickedFrom !== null) store.save(kickedFrom.code, kickedFrom.session);
      // サーバーはこの直後にソケットを閉じる（server/rooms.ts の kick 経路。
      // 閉じるコードは退室と同じ 1000 なので、onclose 側からは見分けられない）。
      // 印を立てておかないと onclose が「異常な切断」として扱い、張り直さないまま
      // 「再読み込みしてください」で終わる。一覧の画面には戻れているのに WS だけが
      // 死んでいる状態になり、以降どの卓にも入れなくなる
      state.leaving = true;
      // 上で保存し直したトークンを onopen が拾って、追い出された卓へ自動で
      // join し直してしまうのを止める（トークン自体はブロック判定のために残す）
      state.kickedOut = true;
      const kickedMessage = "ホストにお引き取りいただきました";
      showError(kickedMessage);
      // 張り直した先の onopen で消されないよう持ち越す。理由が消えると、
      // 利用者には「勝手に一覧へ戻された」ようにしか見えない
      state.messageAfterReopen = kickedMessage;
      break;
    }
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
 * 上の帯（のれんをくぐる・名札・お会計・店内を歩く・卓を建てる）の出し入れ。
 *
 * どれもお座敷一覧にいるときだけ出す。卓に着いている間は、
 * 抜ける道は「お先に失礼」の一本にしたい（帯からいきなり店を出たり、
 * 別の卓を建てたり、ゲストがログイン画面へ抜けたりできると、
 * 同席者への挨拶も VC の後始末も飛ばすことになる）。
 *
 * 名札（profile.html）もここで隠す。卓の趣味タグは入室時にコピーされたもの
 * （server/rooms.ts のコメント参照）で、卓にいる間に profile.html で編集しても
 * その場では反映されない。編集自体を卓の外でしかできないようにしておく。
 */
function renderAccountBar() {
  const inRoom = state.snapshot !== null;
  $("login-link").classList.toggle("hidden", state.loggedIn || inRoom);
  $("profile-link").classList.toggle("hidden", inRoom);
  $("logout").classList.toggle("hidden", !state.loggedIn || inRoom);
  $("corridor-link").classList.toggle("hidden", inRoom);
  // 卓を建てるにはログインが必要（§3.1）。ゲストのまま押すと login.html へ
  // 弾かれてしまうので、押せないよう見せるのではなくボタンごと隠す
  $("create-room-link").classList.toggle("hidden", !state.loggedIn || inRoom);
}

/**
 * 参加者の趣味タグの札を作る（§3.11 用途1）。1つも無ければ null。
 *
 * 表示名は GET /api/tags の対応表から引く。引けなかったときは ID をそのまま出す
 * （対応表の取得に失敗しているだけで、名前が消えるよりは手掛かりが残る）。
 * サーバーはプリセットの ID しか配らないが、いずれにせよ textContent で入れる
 */
function playerTagsRow(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return null;
  const row = el("div", undefined, "player-tags");
  for (const id of tags) {
    row.appendChild(el("span", hobbyTagLabels.get(id) ?? id, "tag"));
  }
  return row;
}

/** 画面全体を描き直す */
function renderAll() {
  const snapshot = state.snapshot;
  renderAccountBar();
  $("entry").classList.toggle("hidden", snapshot !== null);
  $("room").classList.toggle("hidden", snapshot === null);
  $("vc").classList.toggle("hidden", snapshot === null);
  $("bot").classList.toggle("hidden", snapshot === null);
  $("chat").classList.toggle("hidden", snapshot === null);
  $("phase").classList.toggle("hidden", snapshot === null);
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
    const row = el("li");
    // 名前とタグを1つの箱にまとめる。お引き取りボタンは行の右端に残したいので、
    // 縦に積むのはこの箱の中だけにする
    const main = el("div", undefined, "player-main");
    main.appendChild(el("span", `${p.nickname}${suffix} ${p.score}点`));
    const tags = playerTagsRow(p.tags);
    if (tags !== null) main.appendChild(tags);
    row.appendChild(main);
    // お引き取り（§3.1）。ホストにだけ、自分以外の行に出す。
    // 押した相手はこの卓に戻れなくなるので、確認を1枚挟む
    if (snapshot.youAreHost && p.id !== snapshot.youId) {
      // 確認中かどうかはボタン自身に出す。共有の #error に出すと、誰かが入室した
      // ときの showError("") で文言だけ消え、押せば飛ぶ状態が黙って残ってしまう
      const armed = pendingKick !== null && pendingKick.playerId === p.id;
      const kick = el(
        "button",
        armed ? "本当に？" : "お引き取り",
        armed ? "btn btn-red btn-mini is-armed" : "btn btn-red btn-mini",
      );
      kick.type = "button";
      kick.dataset.playerId = p.id;
      kick.addEventListener("click", () => confirmKick(p));
      row.appendChild(kick);
    }
    players.appendChild(row);
  }

  renderKnocks(snapshot);

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

  // あそびが動き出したら主役へ、終われば定位置へ。#phase を動かすだけなので
  // renderPhase より前でも後でもよいが、描く前に置き場所を決めておく
  syncStage();
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
 * 一覧の出どころは roomState の availableGames 1本（設計書 §4）。
 * choice が "official:<id>"（parseGameChoice で解く形をそのまま保つ）。
 */
function listGames(snapshot) {
  const games = [];
  const withHue = (game) => ({ ...game, hue: THUMB_HUES[games.length % THUMB_HUES.length] });
  for (const game of snapshot.availableGames) {
    // 専用モジュール型（設計書 §4）はラウンド数・採点方式を持たないので、人数を出す
    const scoring = SCORING_LABELS[game.scoring];
    const meta = game.kind === "module"
      ? `${game.minPlayers}〜${game.maxPlayers}人`
      : `${game.rounds}ラウンド・${scoring === undefined ? game.scoring : scoring}`;
    games.push(withHue({
      choice: `official:${game.id}`,
      id: game.id,
      title: game.title,
      description: game.description ?? "",
      meta,
      badge: "宴の余興",
      official: true,
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
 * いま並んでいる札の中身を表す文字列。組み直しが要るかの判定だけに使う。
 * 押せるかどうか（disabled）と選択状態は札を作り直さずに更新できるので入れない。
 */
let gamePlatformSignature = null;

function gameListSignature(games) {
  return JSON.stringify(
    games.map((g) => [g.choice, g.title, g.meta, g.description, g.badge, g.official, g.hue]),
  );
}

/** 既にある札の「押せるか」「選ばれているか」だけを現状に合わせる */
function syncGameCardStates() {
  const canStart = canStartGame();
  for (const card of $("game-list").children) {
    if (card.dataset === undefined || card.dataset.choice === undefined) continue;
    const pressed = card.dataset.choice === gameChoiceState.choice;
    card.setAttribute("aria-pressed", pressed ? "true" : "false");
    card.disabled = !canStart;
  }
}

/**
 * 品書き（ゲーム一覧）を組み直す。
 * 一覧は roomState のたびに届くので、何度も呼ばれる。
 *
 * 毎回 clear() して作り直すと、品書きを開いてキーボードで札を選んでいる最中に
 * 誰かが入室・退室しただけで、フォーカスしていたボタンが DOM から消えて
 * フォーカスが <body> に落ちる。人の出入りは通常の使い方なので、それだけで
 * 品書きのキーボード操作が成立しなくなる（マウスでも押す瞬間に札が入れ替わる）。
 * そこで、並ぶ中身が実際に変わったときだけ組み直し、それ以外は札を残したまま
 * 状態だけ更新する。
 */
function renderGamePlatform() {
  const list = $("game-list");
  if (state.snapshot === null) {
    clear(list);
    gamePlatformSignature = null;
    return;
  }

  const games = listGames(state.snapshot);
  const signature = gameListSignature(games);
  if (signature === gamePlatformSignature && list.children.length > 0) {
    syncGameCardStates();
    return;
  }
  gamePlatformSignature = signature;
  clear(list);

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

/** 選ばれているあそびを始める（selectGame → startGame。設計書 §4） */
function startChosenGame() {
  const choice = parseGameChoice(gameChoiceState.choice);
  if (choice === null) {
    showError("あそびを選んでください");
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
    // 専用モジュール型のあそび（設計書 §3.2）。中身はビューモジュールが描くので、
    // ここは器を置き直すだけにする。器ごと作り直すと中身が消える
    case "playing":
      body.appendChild(gameModuleHost());
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

/**
 * 回答1件の表示テキスト。
 *
 * choice のとき RevealEntry.value は選択肢の添字（server/types.ts）なので、
 * そのまま出すと「3」とだけ並んで誰が何を選んだのか読めない。選択肢のテキストに
 * 引き直して出す。選択肢が無い（open 形式）・添字でない・範囲外のときは、
 * 従来どおり文字列にしたものを返して表示を止めない。
 */
function entryValueText(view, value) {
  if (view.inputType === "choice" && Array.isArray(view.options) && Number.isInteger(value)) {
    const option = view.options[value];
    // 範囲外の添字は undefined になるので、ここで弾いてフォールバックに落とす
    if (typeof option === "string") return option;
  }
  return String(value);
}

/** 回答一覧（投票可能なら投票ボタンを付ける） */
function renderEntries(view, canVote) {
  const list = el("ul");
  for (const entry of view.entries) {
    const item = el("li");
    const text = entryValueText(view, entry.value);
    // el() は textContent で入れる。選択肢はゲーム作者が書いた文字列なので、
    // HTML として解釈させない（innerHTML は使わない）
    const label = entry.nickname === undefined ? text : `${entry.nickname}: ${text}`;
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

/** 順位表を片付ける（前のあそびの結果を次のあそびへ持ち越さない） */
function clearResult() {
  $("result").classList.add("hidden");
  $("result-title").textContent = "";
  clear($("result-list"));
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
  playing: "あそび中",
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
  // 入切の処理中は閉じる。他の通知で renderVc が走っても開き直さない
  $("vc-camera").disabled = !vc.active || vcCameraBusy;
  // 文言は「押すとどうなるか」、絵は「いまどうなっているか」を出す（Zoom と同じ流儀）
  setVcControl($("vc-mute"), !vc.muted, vc.muted ? "ミュート解除" : "ミュート");
  // 画面共有中はカメラを実際に止めている（LED を消すため）。それでも
  // 「やめたら戻る」なら入として描く。押せば約束のほうが切り替わる
  const cameraOn = vc.camera === true || vc.cameraResumes === true;
  setVcControl($("vc-camera"), cameraOn, cameraOn ? "カメラOFF" : "カメラON");
  $("vc-camera").title = vc.screen !== true
    ? ""
    : cameraOn
    ? "画面共有中はカメラを止めています。共有をやめると自動で戻します"
    : "画面共有をやめてもカメラは戻しません";
  renderVcScreen(vc);
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
 * 画面共有（docs/design/vc-screenshare.md §10）のボタンを更新する。
 *
 * 状態は必ず VC.getState() から導く（DOM から読み戻さない）。
 * 非対応の端末でもボタンは消さず、理由を title に出す。消してしまうと
 * 「自分の端末にだけ機能が無い」ことに気づけず、壊れていると誤解される。
 * 受信は常に有効なので、他の人の共有は非対応端末でも見られる。
 */
function renderVcScreen(vc) {
  const button = $("vc-screen");
  // 同時に共有できるのは1人（§4.4）。他の人が共有中は自分から始められない
  const otherSharing = vc.sharingPeerId !== null && vc.screen !== true;
  const canStart = vc.active === true && vc.screenSupported === true && !otherSharing;
  const cooling = Date.now() < vcScreenCooldownUntil;
  button.disabled = cooling || !(canStart || vc.screen === true);
  if (vc.screenSupported !== true) {
    button.title = "この端末では画面共有を始められません（他の人の共有は見られます）";
  } else if (otherSharing) {
    button.title = `${vc.sharingPeerName} さんが画面を共有中です`;
  } else if (vc.screen === true) {
    button.title = "画面共有をやめます";
  } else {
    button.title = "自分の画面を共有します（共有中はカメラを止めます）";
  }
  setVcControl(button, vc.screen === true, vc.screen === true ? "共有をやめる" : "画面共有");
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
 * VC 枠（先着6人）が空いて、自分が繰り上がった知らせかどうか。
 *
 * サーバーは「枠の割り当てが変わった本人ぶんだけ」を playerJoined（1人分の upsert）で
 * 配る（§3.6）。自分あての playerJoined はこの経路でしか来ない（入室・再接続の
 * playerJoined は本人を除いて配られる）ので、自分の ID + vcEligible で判定できる。
 */
function isSelfVcPromotion(msg) {
  if (msg.t !== "playerJoined") return false;
  if (state.snapshot === null) return false;
  return msg.player.id === state.snapshot.youId && msg.player.vcEligible === true;
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
 *
 * 枠外（7人目以降）で着席した人は入店時の join() が枠で弾かれている。あとから枠が
 * 空いて繰り上がったら、そのときに改めて声の輪へ入れる（着席＝声の輪、を保つため）。
 */
function autoJoinVc(msg) {
  if (msg.t !== "roomState" && !isSelfVcPromotion(msg)) return;
  if (VC.getState().active) return;
  // 参加処理が走っている最中の roomState では何もしない。VC 側の active は
  // マイクを掴んだ**後**にしか立たないので、許可ダイアログを見ているあいだは
  // 上の判定だけでは素通りしてしまい、マイクを二重に掴むことになる。
  // ただし黙って捨てると繰り上がりの知らせが消えるので、控えだけ残す
  if (vcJoining) {
    vcJoinPending = true;
    return;
  }
  startVcJoin();
}

/**
 * VC への参加を1回始める。autoJoinVc から、および取りこぼした知らせの
 * やり直しから呼ばれる。入るかどうかの判断は呼び出し側で済ませてある。
 */
function startVcJoin() {
  // 先に一度描き直す。renderAll() は VC.handleServerMessage より前に走るので、
  // ここで描き直さないと「VC枠外」（selfId 未設定のときの既定）が残ってしまう
  vcJoining = true;
  renderVc();
  const done = () => {
    vcJoining = false;
    renderVc();
    // 取りこぼした知らせは、やり直しを始める**前**に下ろす。ここで下ろさないと
    // 失敗するたびに同じ控えでやり直し続けてしまう（無限ループ）
    const pending = vcJoinPending;
    vcJoinPending = false;
    if (!pending) return;
    // この参加で入れていたなら、やり直す必要はない
    if (VC.getState().active) return;
    // 卓を離れたあとにやり直さない。VC 側は退出時に selfId を持ったままなので、
    // ここで止めないと「お先に失礼」の後にマイクを掴み直してしまう
    if (state.snapshot === null) return;
    startVcJoin();
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

/** 画面共有の開始・停止を押した直後、この時間はボタンを閉じる（§9-4）【暫定値】 */
const VC_SCREEN_COOLDOWN_MS = 2000;

/** そのボタンが再び押せるようになる時刻（Date.now()） */
let vcScreenCooldownUntil = 0;

// ---------------------------------------------------------------------------
// 主役エリア（#vc-stage）
//
// クリックされた人・共有画面・あそびを、卓上のいちばん大きな場所へ出す。
// 誰を主役にするかは **見ている人ごとの手元の状態**で、卓には一切送らない
// （サーバーとの契約は増えない）。以前の覆い（#vc-zoom）はここに一本化した。
// ---------------------------------------------------------------------------

/**
 * いま主役に出ているもの。
 *   kind … "none"（誰も出ていない）| "peer"（人）| "game"（あそびの面）
 *   playerId … kind が "peer" のときの相手。それ以外は null
 *   source … kind が "peer" のときの映像の出どころ。
 *            "camera" | "screen" | "none"（映像が来ていない＝名前だけを出す）
 */
const vcStage = { kind: "none", playerId: null, source: "camera" };

/** この端末が端末の全画面に対応しているか（bindVc で1回だけ調べる） */
let stageCanFullscreen = false;

/** いまあそびが動いているか（＝あそびの面を主役にしてよいか） */
function gameIsRunning() {
  return state.snapshot !== null && state.phase !== "lobby";
}

/**
 * あそびの面（#phase）を主役エリアへ移す／定位置へ戻す。
 *
 * 人の映像と違い、あそびは**セクションごと動かす**。内蔵のあそび（大喜利・
 * クイズ）は器を使わず #phase-body に直に描くので、器だけを動かしたのでは
 * 両方式を同じ扱いにできない。renderPhase は id で #phase-body を引くため、
 * #phase がどこにあっても描画は変わらない。
 *
 * 戻し先は #phase-slot（.stage-board の中の定位置）。入れ物を挟んであるので、
 * appendChild だけで #result より前という並びが必ず戻る。
 * 移す前に必ず remove() する。付け替えではなく二重に挿さるのを防ぐため。
 */
function movePhaseTo(target) {
  const phase = $("phase");
  phase.remove();
  target.appendChild(phase);
  // あそびが主役に上がっているあいだ、順位表は畳んでおく。開いたままだと
  // .stage-board に居座って、主役エリアが受け取るはずの高さを奪う（canvas を
  // 持つあそびは、そのぶん枠からはみ出して内部スクロールになる）。
  // 消すのではなく <details> を閉じるだけなので、見出しを押せばその場で読める。
  $("result").open = target !== $("vc-stage-body");
}

/** 主役エリアの中身を、いまの vcStage のとおりに描く */
function renderStage() {
  const stage = $("vc-stage");
  const video = $("vc-stage-video");
  const blank = $("vc-stage-blank");
  const title = $("vc-stage-title");
  // 人が主役でも映像が来ていないことがある（カメラ切のままでも主役にできる）
  const hasVideo = vcStage.kind === "peer" && vcStage.source !== "none";
  // CSS はここだけを見て、卓上の高さの配り方と呑み手の面の並べ方を変える
  document.body.dataset.vcStage = vcStage.kind;
  stage.hidden = vcStage.kind === "none";
  // 押し口の aria-pressed と枠の見た目を vc.js に合わせてもらう
  if (typeof VC.setSpotlight === "function") {
    VC.setSpotlight(vcStage.kind === "peer" ? vcStage.playerId : null);
  }
  video.hidden = !hasVideo;
  // 映像が来ていない人は、名前の下敷きで出す（真っ黒な箱だけにしない）
  blank.hidden = vcStage.kind !== "peer" || hasVideo;
  if (hasVideo) {
    // 共有画面は端を切らない。人の顔は枠に合わせて切ってよい（§7.3 と同じ判断）
    video.classList.toggle("vc-stage-video-screen", vcStage.source === "screen");
    const played = video.play();
    if (played !== undefined && typeof played.catch === "function") played.catch(() => {});
  } else {
    video.srcObject = null;
  }
  if (vcStage.kind === "game") {
    // あそびが主役のあいだは降りる口を出さない。降ろしても行き先が無く、
    // 次に描き直した時点でまた戻ってくるだけになる（誰かを押せば入れ替わる）
    $("vc-stage-close").classList.add("hidden");
    title.textContent = "あそび";
  } else {
    $("vc-stage-close").classList.remove("hidden");
  }
  syncStageFullscreenAvailability();
}

/**
 * 「端末の全画面」の押し口を出してよいかを引き直す。
 *
 * 名前しか出ていない主役を全画面にしても得るものが無い（真っ黒な画面に名前が
 * 一つ浮くだけで、卓の他の面はぜんぶ見えなくなる）ので、映像の無い人が主役の
 * あいだは押し口を引っ込める。見ている最中に映像が消えた場合も、そのまま
 * 全画面に閉じ込めず自分から出る。
 */
function syncStageFullscreenAvailability() {
  const usable = vcStage.kind === "game" ||
    (vcStage.kind === "peer" && vcStage.source !== "none");
  $("vc-stage-full").classList.toggle("hidden", !(stageCanFullscreen && usable));
  if (!usable && stageIsFullscreen() && typeof document.exitFullscreen === "function") {
    document.exitFullscreen().catch(() => {});
  }
}

/**
 * 人を主役にする。
 *
 * タイルの video を DOM ごと移すのではなく、主役の video に**同じ
 * MediaStream を張る**（vc-screenshare.md §7.2）。vc.js の closePeer() は
 * タイルごと要素を消すので、要素の持ち主を移すと後始末が壊れる。同じ
 * ストリームを2枚に張るのは通常の使い方で、デコードは1回・描画が2回に
 * なるだけ（受信帯域は増えない）。
 */
function spotlightPeer(view) {
  // あそびが出ていたなら定位置へ帰す。主役はひとつだけ
  if (vcStage.kind === "game") movePhaseTo($("phase-slot"));
  const stream = view.stream === undefined ? null : view.stream;
  vcStage.kind = "peer";
  vcStage.playerId = view.playerId;
  vcStage.source = stream === null ? "none" : view.source === "screen" ? "screen" : "camera";
  // ニックネームはユーザー由来なので textContent で入れる（§3.8）。
  // 名前を出すのは「映像があれば見出し・無ければ下敷き」のどちらか一方だけ。
  // 両方に出すと、細い見出しと大きな下敷きに同じ名前が二度並んで不格好になる
  $("vc-stage-blank-name").textContent = `${view.nickname} さん`;
  $("vc-stage-title").textContent = vcStage.source === "none"
    ? "映像なし"
    : vcStage.source === "screen"
    ? `${view.nickname} さんの共有画面`
    : `${view.nickname} さん`;
  // 同じストリームを張り直さない。共有⇔カメラの告知は何度も届くので、
  // そのたびに付け替えると再生が止まってちらつく
  const video = $("vc-stage-video");
  if (video.srcObject !== stream) video.srcObject = stream;
  renderStage();
}

/** あそびを主役にする */
function spotlightGame() {
  if (vcStage.kind === "game") return;
  vcStage.kind = "game";
  vcStage.playerId = null;
  movePhaseTo($("vc-stage-body"));
  renderStage();
}

/**
 * 主役を降ろす。あそびが動いていれば、そのままあそびが主役に戻る
 * （空いた大きな場所に何も出ないほうが不便なので）。
 */
function clearStage() {
  if (vcStage.kind === "game") movePhaseTo($("phase-slot"));
  vcStage.kind = "none";
  vcStage.playerId = null;
  renderStage();
  // 主役が居なくなるので、端末の全画面に渡したままにしない
  if (stageIsFullscreen() && typeof document.exitFullscreen === "function") {
    document.exitFullscreen().catch(() => {});
  }
  if (gameIsRunning()) spotlightGame();
}

/**
 * vc.js から「この人を主役にしてほしい」と頼まれたときの処理。
 * すでにその人が主役なら降ろす（同じタイルをもう一度押したときの往復）。
 */
function requestStagePeer(view) {
  if (view === null || view === undefined) return;
  if (vcStage.kind === "peer" && vcStage.playerId === view.playerId) {
    clearStage();
    return;
  }
  spotlightPeer(view);
}

/**
 * vc.js から届く、ある人の映像の状態の知らせ。
 * その人がいま主役でなければ何もしない（勝手に主役を奪わない）。
 *   view が null … その人が卓から居なくなった（退出・キック）。主役を降ろす
 *   view がある  … 映像の出入り・カメラ⇔画面の入れ替え。中身を差し替える
 *
 * **映像が消えただけでは主役を降ろさない**（名前の下敷きに戻るだけ）。
 * カメラを切るたびに主役が解けると、入れ直すたびに選び直しになるため。
 */
function updateStagePeer(view, playerId) {
  if (vcStage.kind !== "peer" || vcStage.playerId !== playerId) return;
  if (view === null) {
    clearStage();
    return;
  }
  spotlightPeer(view);
}

/**
 * あそびの動き出し・終わりに合わせて主役を入れ替える。
 * 動き出したときに主役が空いていれば、あそびが主役になる（Discord の
 * アクティビティと同じで、始めた当人が探さなくても目に入るように）。
 * 誰かが主役に出ているあいだは奪わない。
 */
function syncStage() {
  if (gameIsRunning()) {
    if (vcStage.kind === "none") spotlightGame();
    return;
  }
  if (vcStage.kind === "game") clearStage();
}

/** 卓を出たときに主役を初期化する。次に入った卓へ持ち越さない */
function resetStage() {
  if (vcStage.kind === "game") movePhaseTo($("phase-slot"));
  vcStage.kind = "none";
  vcStage.playerId = null;
  vcStage.source = "camera";
  $("vc-stage-title").textContent = "";
  $("vc-stage-blank-name").textContent = "";
  renderStage();
}

/**
 * 端末の全画面へ渡す（§7.2）。
 * iOS Safari は Element.requestFullscreen() を持たず、video の
 * webkitEnterFullscreen() しかない。どちらも無ければ主役エリアだけで完結する。
 *
 * 全画面にするのは #vc-stage-body（映像とあそびの入れ物）。video だけを
 * 渡すとあそびが主役のときに何も起きない。
 */
function toggleStageFullscreen() {
  if (stageIsFullscreen()) {
    if (typeof document.exitFullscreen === "function") document.exitFullscreen().catch(() => {});
    return;
  }
  const body = $("vc-stage-body");
  if (typeof body.requestFullscreen === "function") {
    const entered = body.requestFullscreen();
    if (entered !== undefined && typeof entered.catch === "function") entered.catch(() => {});
    return;
  }
  const video = $("vc-stage-video");
  if (typeof video.webkitEnterFullscreen === "function") video.webkitEnterFullscreen();
}

/**
 * 主役エリアが端末の全画面に出ているか。
 *
 * document.fullscreenElement が真かどうかではなく、**それが主役エリアか**
 * まで確かめる。真かどうかだけで判定すると、他の全画面（品書きなど）が
 * 出ているときの Escape まで巻き添えで抑えてしまう。
 */
function stageIsFullscreen() {
  return document.fullscreenElement === $("vc-stage-body");
}

/**
 * 全画面の押し口の文言を、いまの状態から引き直す。
 * 押したときに自前でひっくり返すのではなく状態から引くのは、F11 や
 * ブラウザの UI で外れることがあるため（そのときも文言が合う）。
 * iOS Safari の webkitEnterFullscreen() は fullscreenchange を出さないので、
 * その端末では文言が変わらない。害は無いのでそのままにしてある。
 */
function syncStageFullscreenLabel() {
  $("vc-stage-full").textContent = stageIsFullscreen() ? "全画面を終える" : "端末の全画面";
}

/** VC モジュールを組み込む。iceServers が null なら VC 側の既定を使う */
function bindVc(iceServers) {
  VC.init({
    send,
    iceServers,
    container: $("vc-people"),
    // 主役エリアはこちらの持ち物。vc.js からは出し入れだけを頼まれる（§7.2）。
    // playerId が付いていれば「その人が主役なら」という条件付きの知らせで、
    // 付いていなければ押されたという合図（vc.js の onSpotlight の契約）
    onSpotlight: (view, playerId) => {
      if (playerId === undefined) requestStagePeer(view);
      else updateStagePeer(view, playerId);
    },
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
    // 処理中はボタンを閉じる（画面共有のクールダウンと同じ趣旨）。
    // 開けたままだと連打で getUserMedia が二重に走り、先に掴んだカメラが
    // 参照を失って止められなくなる（ランプが消えない）
    if (vcCameraBusy) return;
    vcCameraBusy = true;
    renderVc();
    const done = () => {
      vcCameraBusy = false;
      renderVc();
    };
    Promise.resolve(VC.toggleCamera()).then(done, done);
  });
  $("vc-screen").addEventListener("click", () => {
    // 開始・停止の連打を抑える（§9-4）。押した直後は数秒ボタンを閉じる
    vcScreenCooldownUntil = Date.now() + VC_SCREEN_COOLDOWN_MS;
    setTimeout(renderVc, VC_SCREEN_COOLDOWN_MS);
    if (VC.getState().screen === true) {
      Promise.resolve(VC.stopScreenShare()).then(renderVc, renderVc);
      return;
    }
    // 種類は「文字」固定（vc.js の SCREEN_DEFAULT_KIND）
    Promise.resolve(VC.startScreenShare()).then(renderVc, renderVc);
  });
  $("vc-stage-close").addEventListener("click", () => clearStage());
  $("vc-stage-full").addEventListener("click", toggleStageFullscreen);
  // 映像の二度押しでも全画面に入れる（動画の作法に合わせる）
  $("vc-stage-video").addEventListener("dblclick", toggleStageFullscreen);
  // 端末の全画面に対応していなければ、その押し口は出さない（§7.2）。
  // 対応していても、出すものが映像でなければ引っ込める（renderStage が引き直す）
  stageCanFullscreen = typeof $("vc-stage-body").requestFullscreen === "function" ||
    typeof $("vc-stage-video").webkitEnterFullscreen === "function";
  syncStageFullscreenAvailability();
  // 文言は状態から引き直す。F11 やブラウザの UI で外れることがあるため。
  // bindVc は起動時に1回しか呼ばれないので、ここで登録して二重にならない
  document.addEventListener("fullscreenchange", syncStageFullscreenLabel);
  syncStageFullscreenLabel();
  // 主役はまだ居ない。CSS が見る body の data 属性を最初から入れておく
  renderStage();
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
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      // 通信できなくても、このタブに残るものの後始末はやり切って画面は進める。
      // ここで投げると「お会計を押しても何も起きない」になる
    }
    // このタブに残る「前の人の続き」を全部捨ててから離れる。
    //
    // 卓の再接続トークン（en-session）は、キックされたときだけ意図的に
    // 残している（§3.1 のブロック判定のため）。それを持ち越したまま別の
    // アカウントでログインし直すと、connect() の onopen が拾って追い出された
    // 卓へ join を送り、身に覚えのない BLOCKED が毎回出る。
    store.drop();
    // ゲストの一時プロフィール（あだ名・趣味タグ）。共用端末で前の利用者の
    // あだ名が次の人の入室欄に自動入力されてしまう
    GuestProfile.setGuestProfile({ nickname: "", tags: [] });
    // 受け渡し待ちの「これから建てる卓」「入りたい卓」。consume は読んで捨てる
    // だけなので、残っていなければ何も起きない（合言葉が平文で残るのも防ぐ）
    RoomHandoff.consumePendingCreateRoom();
    RoomHandoff.consumePendingJoinRoom();
    location.href = "/login.html";
  });
  $("queue-join").addEventListener("click", joinQueue);
  $("queue-leave").addEventListener("click", leaveQueue);

  $("join-passphrase").addEventListener("click", () => {
    state.rejoinAfterRestart = false;
    pendingRoomMeta = null;
    // コードは積まない。合言葉だけで卓を引く（§3.1）
    const msg = withMyTags({ t: "join", passphrase: $("passphrase").value });
    const nickname = $("nickname").value.trim();
    if (nickname.length > 0) msg.nickname = nickname;
    send(msg);
  });
  $("join").addEventListener("click", () => {
    pendingRoomMeta = null;
    // 自分で入り直す操作。以降の ROOM_NOT_FOUND は打ち間違いなので通常の文言に戻す
    state.rejoinAfterRestart = false;
    // 空欄なら nickname を積まない。省略するとしゅんぴが二つ名を付ける（§3.10）。
    // 空文字は「入力し忘れ」と区別できないのでサーバーが弾く（types.ts の join 参照）
    const msg = withMyTags({ t: "join", roomCode: $("code").value });
    const nickname = $("nickname").value.trim();
    if (nickname.length > 0) msg.nickname = nickname;
    // 同じ卓のトークンを持っていれば必ず積む。猶予内なら再接続として復帰でき、
    // キックされていればサーバーが BLOCKED を返せる（§3.1）。
    // 積まないと、追い出された人がコードを打ち直すだけで戻れてしまう
    const saved = store.load();
    if (saved !== null && String(saved.code) === msg.roomCode.trim()) {
      msg.session = saved.session;
    }
    send(msg);
  });
  $("game-open").addEventListener("click", () => toggleGamePlatform(true));
  $("platform-close").addEventListener("click", () => toggleGamePlatform(false));
  // 覆いの余白を押したら閉じる（札そのものを押したときは閉じない）
  $("game-platform").addEventListener("click", (event) => {
    if (event.target === $("game-platform")) toggleGamePlatform(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    toggleGamePlatform(false);
    // 端末の全画面に出ているあいだの Escape は、ブラウザが全画面を外すための
    // 押下である。ここで主役まで降ろすと、一度の Escape で共有画面そのものが
    // 消えてしまう（全画面を外しただけのつもりなのに中身が無くなる）
    if (stageIsFullscreen()) return;
    // 降ろせるのは人の主役だけ。あそびは降ろしても行き先が無く、次に描き直した
    // 時点でまた戻ってくるだけなので、#phase を無駄に付け替えない
    if (vcStage.kind !== "peer") return;
    // 主役表示も同じ作法で降ろす（vc-screenshare.md §7.2）
    clearStage();
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
}

// 一覧（rooms.js）からノックできるようにする。app.js は classic script なので、
// 同じグローバルに置くだけで届く
globalThis.knockRoom = knockRoom;

/** 起動する。ICE 設定を先に取ってから VC を初期化する */
async function start() {
  bind();
  Sound.bindButtons();
  Sound.mountControls();
  // 入室の音は鳴る間が決まっていて、その場で取りに行くと間に合わない
  Sound.preload("decide", "knock", "slidingScreen");
  // 卓に入る前に済ませておく。入室に趣味タグを持ち込む（§3.11）ので、
  // corridor.html からの自動入室に間に合わせるには connect() より前に要る。
  //
  // 並行に取るのは変えない（直列にすると起動が1往復ぶん遅くなる）。ただし
  // ここで転ぶと connect() まで届かず「アプリが起動しない」形になるので、
  // 一本ずつ受け止める。どちらも失敗しても卓への接続は独立して進める
  await Promise.all([
    refreshAccount().catch(() => {
      // refreshAccount 自身が通信断を握る。ここへ来るのは想定外の失敗
      // （DOM の欠けなど）だけだが、それでも接続は止めない
      $("account-status").textContent = "ログイン状態を確認できませんでした";
    }),
    loadHobbyTagLabels(),
  ]);
  bindVc(await fetchIceServers());
  connect();
}

start();
