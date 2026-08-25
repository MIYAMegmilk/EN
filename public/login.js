/**
 * 開発用の動作確認スクリプト
 * /api/auth/* の疎通を手で確かめるための暫定実装。
 *
 * 表示規約（§3.8 / CLAUDE.md セキュリティ基準）:
 * ユーザー由来のテキストは必ず textContent で描画し、innerHTML は使わない。
 */

"use strict";

function $(id) {
  return document.getElementById(id);
}

const ENTER_ANIMATION_MS = 1300;

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

function playEnterAnimation() {
  setControlsDisabled(true);
  document.body.classList.add("entering");
  return new Promise((resolve) => setTimeout(resolve, ENTER_ANIMATION_MS));
}

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
    // ログイン済みならこの画面に留まらず index.html へ進む
    location.href = "/index.html";
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
    location.href = "/index.html";
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
    location.href = "/index.html";
  } else {
    showLoginError(`ログインに失敗しました (${status}): ${body?.error ?? "unknown error"}`);
  }
});

refreshMe();
