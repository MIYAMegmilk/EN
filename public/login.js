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

async function callApi(path, options) {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

async function refreshMe() {
  const { ok, body } = await callApi("/api/me");
  if (ok && body && typeof body.userId === "string") {
    // ログイン済みならこの画面に留まらず入り口選択画面へ進む
    location.href = "/entrance.html";
    return;
  }
  $("me-result").textContent = "未ログイン";
}

$("register").addEventListener("click", async () => {
  const userId = $("register-userid").value;
  const password = $("register-password").value;
  const { ok, status, body } = await callApi("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, password }),
  });
  if (ok) {
    showStatus(`登録・ログインしました（userId: ${body.userId}）`);
    await playEnterAnimation();
    location.href = "/entrance.html";
  } else {
    showRegisterError(`登録に失敗しました (${status}): ${body?.error ?? "unknown error"}`);
  }
});

$("login").addEventListener("click", async () => {
  const userId = $("login-userid").value;
  const password = $("login-password").value;
  const { ok, status, body } = await callApi("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, password }),
  });
  if (ok) {
    showStatus(`ログインしました（userId: ${body.userId}）`);
    await playEnterAnimation();
    location.href = "/entrance.html";
  } else {
    showLoginError(`ログインに失敗しました (${status}): ${body?.error ?? "unknown error"}`);
  }
});

Sound.bindButtons();
Sound.mountControls();

refreshMe();
warmUpOnIdle();
