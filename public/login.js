/**
 * 開発用の動作確認スクリプト
 * /api/auth/* の疎通を手で確かめるための暫定実装。
 *
 * 表示規約（§3.8 / CLAUDE.md セキュリティ基準）:
 * ユーザー由来のテキストは必ず textContent で描画し、innerHTML は使わない。
 */

"use strict";

import { playNorenIntro, preloadNorenIntro } from "./noren-scene.js";

function $(id) {
  return document.getElementById(id);
}

/**
 * #enter-overlay の transition と同じ長さ。
 * ここが transition より短いと、暗転しきる前に location.href が走って
 * 遷移の瞬間に元の画面が一瞬見える（フラッシュする）。
 */
const COVER_MS = 400;

/** CSS フォールバックの尺。login.html の zoom-forward と同じ */
const CSS_FALLBACK_MS = 1100;

/** 揺れを嫌う設定のとき、静止した絵を見せている時間 */
const STILL_HOLD_MS = 700;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function prefersReducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

const CONTROL_IDS = [
  "login-userid",
  "login-password",
  "login",
  "register-userid",
  "register-password",
  "register",
];

function setControlsDisabled(disabled) {
  for (const id of CONTROL_IDS) {
    $(id).disabled = disabled;
  }
  const guestLink = $("guest-link");
  guestLink.style.pointerEvents = disabled ? "none" : "";
  if (disabled) {
    guestLink.setAttribute("aria-disabled", "true");
  } else {
    guestLink.removeAttribute("aria-disabled");
  }
}

// ---------------------------------------------------------------------------
// 暖簾をくぐる演出
// ---------------------------------------------------------------------------

/**
 * 3D 一式（three と glb）の先読み。
 *
 * ボタンを押してから取りに行くと「押した → 無反応 → 唐突に 3D」になる。
 * 画面を開いた後のヒマな時間に温めておいて、押した瞬間から動き出すようにする。
 * 落とせなかった場合は false が返るので、そのまま CSS 版へ倒す。
 */
let norenReady = null;

function warmUpNoren() {
  if (norenReady === null) norenReady = preloadNorenIntro();
  return norenReady;
}

function warmUpOnIdle() {
  const idle = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, 400));
  idle(() => {
    void warmUpNoren();
    // 鳴ってほしい瞬間が決まっている音なので、その場で取りに行くと間に合わない
    Sound.preload("noren", "slidingScreen", "gaya");
  });
}

/**
 * 演出の節目で鳴らす。
 *
 * 秒数を書かずに noren-scene.js の合図に乗せているのがこの関数の肝。
 * 以前は「衣ずれを t=0 に鳴らす」と決め打ちしていたが、実際に布が動くのは
 * 3.85 秒後だったので、絵と音が 3.8 秒ずれていた。カメラが布の面を跨いだ
 * 事実で鳴らせば、あちらの間を変えてもここは触らなくてよい。
 */
function onBeat(name, cover) {
  switch (name) {
    case "doorOpen":
      void Sound.play("slidingScreen");
      // 戸が開いた先の店内のざわめき。0 から立ち上がるので「中へ入っていく」音になる
      void Sound.loop("gaya", { volume: Sound.GAYA_CORRIDOR });
      break;
    case "norenSplit":
      void Sound.play("noren");
      break;
    case "walkEnd":
      // 立ち止まったところから暗転を重ねはじめる。演出が終わる頃には
      // 暗転しきっているので、遷移の瞬間にフラッシュしない
      cover();
      break;
  }
}

async function playEnterAnimation() {
  setControlsDisabled(true);
  // 押した拍子に音の許可を取る。この後の音は非同期の先で鳴るので、
  // そこまで待つとユーザー操作から離れて鳴らせなくなる端末がある
  Sound.unlock();

  const reduced = prefersReducedMotion();
  const stage = $("noren-stage");

  // 先読みが効いていればここは 0ms で抜ける。まだ落とし終わっていないときだけ
  // 待つことになるので、そのあいだは「押したのに無反応」に見せない
  const waiting = setTimeout(() => showStatus("暖簾の支度をしています…"), 150);
  const has3d = await warmUpNoren();
  clearTimeout(waiting);
  showStatus("暖簾をくぐっています");

  // 遷移して消えるとは限らない（演出だけ見て留まる経路がありうる）ので、
  // 画面を離れるときに 3D の後片付けを走らせる。WebGL のコンテキストは
  // ブラウザ全体で 16 個ほどしか持てない
  const controller = new AbortController();
  globalThis.addEventListener("pagehide", () => controller.abort(), { once: true });

  let coverAt = 0;
  const cover = () => {
    if (coverAt !== 0) return;
    coverAt = performance.now();
    document.body.classList.add("cover");
    // 暗転と同じ間でざわめきを引く（Sound.stop はフェードしてから切る）
    Sound.stop("gaya");
  };

  let result = "unsupported";
  if (has3d && stage !== null) {
    try {
      result = await playNorenIntro(stage, {
        reducedMotion: reduced,
        signal: controller.signal,
        onBeat: (name) => onBeat(name, cover),
      });
    } catch (err) {
      // deno-lint-ignore no-console
      console.error("noren 3d intro failed, falling back to CSS animation", err);
      result = "unsupported";
    }
  }

  if (result === "unsupported") {
    // WebGL 非対応・読み込み失敗。CSS のキーフレーム版に任せる
    document.body.classList.add("entering");
    if (reduced) {
      void Sound.play("noren");
      await wait(STILL_HOLD_MS);
    } else {
      void Sound.play("slidingScreen");
      // 布が割れきる頃に衣ずれを重ねる（login.html の noren-part-* が 700ms）
      setTimeout(() => void Sound.play("noren"), 420);
      await wait(CSS_FALLBACK_MS);
    }
  } else if (result === "still") {
    // 揺れを嫌う設定。3D はくぐり終えた一コマで止まっているので、
    // 衣ずれだけ鳴らして少し見せる
    void Sound.play("noren");
    await wait(STILL_HOLD_MS);
  }

  cover();
  // "played" のときは walkEnd で暗転が始まっているので、残りだけ待つ
  const remain = COVER_MS - (performance.now() - coverAt);
  if (remain > 0) await wait(remain);
}

function showPanel(panelId) {
  $("login-panel").hidden = panelId !== "login-panel";
  $("register-panel").hidden = panelId !== "register-panel";
  $("login-error").textContent = "";
  $("register-error").textContent = "";
  $("status").textContent = "";
}

$("show-register").addEventListener("click", () => showPanel("register-panel"));
$("show-login").addEventListener("click", () => showPanel("login-panel"));

$("guest-link").addEventListener("click", async (e) => {
  e.preventDefault();
  await playEnterAnimation();
  location.href = "/entrance.html";
});

function showLoginError(message) {
  $("login-error").textContent = message;
  $("register-error").textContent = "";
  $("status").textContent = "";
}

function showRegisterError(message) {
  $("register-error").textContent = message;
  $("login-error").textContent = "";
  $("status").textContent = "";
}

function showStatus(message) {
  $("status").textContent = message;
  $("login-error").textContent = "";
  $("register-error").textContent = "";
}

/**
 * API を叩く。entrance.js / create-room.js / debug.js と同じ形に揃えてある。
 *
 * fetch を try で包むのが要。包まないと、サーバー停止・圏外のときに
 * 呼び出し側の async 関数がそのまま reject し、画面には何も出ないまま
 * 未処理の Promise 拒否がコンソールに出るだけになる。押しても無反応だと
 * 「効いていない」と思ってまた押すので、連打の入り口にもなる。
 *
 * 通信できなかったことは status: 0 で伝える（HTTP には無い値なので、
 * 本物の応答と取り違えない）。
 */
async function callApi(path, options) {
  let res;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      ...options,
    });
  } catch {
    return { ok: false, status: 0, body: null };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

async function refreshMe() {
  const { ok, status, body } = await callApi("/api/me");
  if (ok && body && typeof body.userId === "string") {
    // ログイン済みならこの画面に留まらず入り口選択画面へ進む
    location.href = "/entrance.html";
    return;
  }
  // 繋がらなかっただけのときに「未ログイン」と言い切らない。ログインしている
  // 人に落ち度があるように読める（この画面はそのまま操作できる）
  $("me-result").textContent = status === 0 ? "ログイン状態を確認できませんでした" : "未ログイン";
}

/**
 * 送信中かどうか。二重送信の番人。
 *
 * サーバー側の上限は登録が3件/時、ログインが5回/分（server/auth.ts の
 * REGISTER_LIMIT / LOGIN_LIMIT）。応答が遅いときに押し直すのはごく普通の操作
 * なので、塞がないと3回連打しただけでその IP が1時間登録できなくなる。
 * ボタンの disabled だけに頼らずフラグも持つのは、handler が直接呼ばれる経路
 * （Enter キーの配線や自動化）でも1回に抑えるため（hayaoshi.js の buzzSent と同じ作法）
 */
let submitting = false;

/**
 * ログイン・登録の送信をまとめる。押した瞬間に塞ぐのがこの関数の役目。
 *
 * 成功したらそのまま暖簾をくぐる演出に入り、ページを離れる。その経路では
 * 塞いだままにする（戻すと、遷移が始まるまでの間にもう一度押せてしまう）。
 * 失敗・通信断のときだけ finally で戻す（debug.js の reset-limits と同じ形）
 */
async function submitCredentials({ path, userId, password, successText, failLabel, onFail }) {
  if (submitting) return;
  submitting = true;
  setControlsDisabled(true);
  showStatus("送信しています…");
  let leaving = false;
  try {
    const { ok, status, body } = await callApi(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, password }),
    });
    if (!ok) {
      // status 0 は callApi が「通信できなかった」を表すのに使う値。
      // 「(0): unknown error」と出しても何も伝わらないので言い換える
      onFail(
        status === 0
          ? `${failLabel}に失敗しました。サーバーに繋がりませんでした`
          : `${failLabel}に失敗しました (${status}): ${body?.error ?? "unknown error"}`,
      );
      return;
    }
    showStatus(`${successText}（userId: ${body?.userId}）`);
    try {
      await playEnterAnimation();
    } catch (err) {
      // 演出が転んでも入店は止めない。ここで投げると塞いだまま戻れなくなる
      // deno-lint-ignore no-console
      console.error("enter animation failed", err);
    }
    // ここから先はページを離れるだけなので、塞ぎは戻さない。
    // 途中で転んだときは戻す側に倒れるよう、印を立てるのは最後にする
    leaving = true;
    location.href = "/entrance.html";
  } catch {
    // 通信断は callApi が status 0 として返すので、通常ここへは来ない。
    // それでも残すのは、想定外の失敗（演出まわりなど）で塞いだまま
    // 戻れなくなるのを防ぐため。黙って終わると「押したのに無反応」になり、
    // まさに連打を誘う
    onFail(`${failLabel}に失敗しました。サーバーに繋がりませんでした`);
  } finally {
    if (!leaving) {
      submitting = false;
      setControlsDisabled(false);
    }
  }
}

function doRegister() {
  return submitCredentials({
    path: "/api/auth/register",
    userId: $("register-userid").value,
    password: $("register-password").value,
    successText: "登録・ログインしました",
    failLabel: "登録",
    onFail: showRegisterError,
  });
}

function doLogin() {
  return submitCredentials({
    path: "/api/auth/login",
    userId: $("login-userid").value,
    password: $("login-password").value,
    successText: "ログインしました",
    failLabel: "ログイン",
    onFail: showLoginError,
  });
}

/**
 * 送信の入口を3つとも同じ関数に繋ぐ（room/chat.js の init と同じ形）。
 *
 * ID とパスワードを打ち込んで Enter、はログイン画面でいちばん多い操作なのに、
 * これまではマウスで押すしか手が無かった。二重送信は submitCredentials の
 * submitting が止めるので、経路が増えても送信は1回に保たれる。
 *
 * ボタンは type="button" のまま（暗黙の送信でページが再読み込みされない）。
 * それでも form の submit を拾うのは、パスワードマネージャの自動入力＋自動送信
 * のようにブラウザ側から submit が飛んでくる経路があるため。
 */
function bindSubmit(formId, inputIds, buttonId, run) {
  $(formId).addEventListener("submit", (event) => {
    event.preventDefault();
    void run();
  });
  $(buttonId).addEventListener("click", () => void run());
  for (const id of inputIds) {
    $(id).addEventListener("keydown", (event) => {
      // IME の変換確定の Enter では送らない（chat.js の keydown と同じ判定）
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      void run();
    });
  }
}

bindSubmit("login-form", ["login-userid", "login-password"], "login", doLogin);
bindSubmit("register-form", ["register-userid", "register-password"], "register", doRegister);

/**
 * ブラウザの「戻る」で bfcache から復元されたときの後始末。
 *
 * playEnterAnimation() は「このままリロードされずに戻ってくる」ことを
 * 想定しておらず、遷移前提でボタンを disabled にしたり body に
 * entering/cover を付けたり #noren-stage を visible にしたりする。
 * bfcache 復元はスクリプトを再実行せず離脱時の DOM をそのまま蘇らせるため、
 * これらを戻さないと「暗転しきった画面で固まって何も押せない」状態になる。
 *
 * ここで refreshMe() を呼んで entrance.html へ転送し直すこともできるが、
 * それだと「戻るボタンを押した瞬間に画面がチラついて別の画面に飛ぶ」形に
 * なってしまう。ログイン中でもこの画面のまま操作可能に戻すだけにしておけば、
 * 素直な「戻る」の見た目になる（もう一度ログインしても実害はない）
 */
globalThis.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  document.body.classList.remove("entering", "cover");
  $("noren-stage").classList.remove("visible");
  setControlsDisabled(false);
  $("status").textContent = "";
  $("login-error").textContent = "";
  $("register-error").textContent = "";
});

Sound.bindButtons();
Sound.mountControls();

refreshMe();
warmUpOnIdle();
