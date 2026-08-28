/**
 * entrance.html の配線。
 *
 * ここは「入口の選択」だけを担う画面で、名札（あだ名・趣味タグ）の編集は
 * profile.html に一本化した（ログイン中・ゲストのどちらも profile.html で編集する）。
 * このファイルがやるのはログイン状態を確認し、ゲストなら「卓を立てる」を
 * 無効化することだけ。
 */

"use strict";

function $(id) {
  return document.getElementById(id);
}

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

/** ゲストなら「卓を立てる」カードをリンクとして機能させず、その旨を表示する */
function applyCreateCardState(loggedIn) {
  if (loggedIn) return;
  const card = $("entrance-create");
  card.removeAttribute("href");
  card.classList.add("entrance-card-disabled");
  card.setAttribute("aria-disabled", "true");
  $("entrance-create-desc").textContent = "ログインすると卓を立てられます。";
}

async function init() {
  const me = await callApi("/api/me");
  const isLoggedIn = me.ok && me.body !== null && typeof me.body.userId === "string";
  applyCreateCardState(isLoggedIn);
}

init();
