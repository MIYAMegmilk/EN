/**
 * profile.html のプロフィール編集の配線。
 *
 * ログイン中はアカウントの軽量プロフィール（GET /api/me・PUT /api/profile）を、
 * ゲストはブラウザセッション限定の一時プロフィール（guest-profile.js）を編集する。
 * かつては entrance.html にもゲスト向けの簡易編集があったが、名札の編集は
 * この画面に一本化した（entrance.html は入口の選択だけを担う）。
 *
 * 表示規約（§3.8）: ユーザー由来・サーバー由来を問わずテキストは必ず textContent
 * で描画し、innerHTML は使わない。タグの表示名も /api/tags から取得したサーバー由来
 * の値のみを使う（§3.11）。
 */

"use strict";

const TAGS_MAX = 5;

/** プリセット趣味タグの一覧（/api/tags の結果） */
let presetTags = [];

/** ログイン中かどうか。保存ボタンの送信先（PUT /api/profile か sessionStorage か）の分岐に使う */
let isLoggedIn = false;

/** GET /api/tags の取得に失敗したかどうか。true の間はチェックボックスが描画できないため、保存時に checkedTagIds() を使わない */
let tagsLoadFailed = false;

/** init() 時点でユーザー/ゲストが持っていたタグ一覧。tagsLoadFailed が true のときの保存に使う */
let loadedTags = [];

function $(id) {
  return document.getElementById(id);
}

function showError(message) {
  $("error").textContent = message;
  $("status").textContent = "";
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

function checkedTagIds() {
  return [...document.querySelectorAll('#profile-tags input[type="checkbox"]:checked')]
    .map((el) => el.value);
}

function renderTags(tags, selectedIds) {
  const container = $("profile-tags");
  container.textContent = "";
  for (const tag of tags) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = tag.id;
    checkbox.checked = selectedIds.includes(tag.id);
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(tag.label));
    container.appendChild(label);
  }
}

async function init() {
  const tagsRes = await callApi("/api/tags");
  presetTags = tagsRes.ok && tagsRes.body !== null ? tagsRes.body.tags : [];
  tagsLoadFailed = !tagsRes.ok || tagsRes.body === null;
  if (tagsLoadFailed) {
    showError("趣味タグ一覧の取得に失敗しました");
  }

  const me = await callApi("/api/me");
  isLoggedIn = me.ok && me.body !== null && typeof me.body.userId === "string";

  let nickname = "";
  let tags = [];
  if (isLoggedIn) {
    nickname = typeof me.body.nickname === "string" ? me.body.nickname : "";
    tags = Array.isArray(me.body.tags) ? me.body.tags : [];
  } else {
    const guest = GuestProfile.getGuestProfile();
    nickname = guest.nickname;
    tags = guest.tags;
  }

  loadedTags = tags;
  $("profile-nickname").value = nickname;
  renderTags(presetTags, tags);
}

$("profile-save").addEventListener("click", async () => {
  const nickname = $("profile-nickname").value;
  // /api/tags の取得に失敗している間はチェックボックスが1つも描画されておらず、
  // checkedTagIds() は常に空配列になる。それをそのまま保存すると既存のタグを
  // 消してしまうため、その場合は init() 時点で読み込んだタグをそのまま使う。
  const tags = tagsLoadFailed ? loadedTags : checkedTagIds();
  if (tags.length > TAGS_MAX) {
    showError(`趣味タグは${TAGS_MAX}個以内で選んでください`);
    return;
  }

  if (isLoggedIn) {
    const { ok, status, body } = await callApi("/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname, tags }),
    });
    if (ok) {
      location.href = "/index.html";
    } else {
      showError(`保存に失敗しました (${status}): ${body?.error ?? "unknown error"}`);
    }
    return;
  }

  const trimmed = nickname.trim();
  GuestProfile.setGuestProfile({ nickname: trimmed, tags });
  location.href = "/index.html";
});

init();
