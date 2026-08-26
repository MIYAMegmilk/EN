/**
 * entrance.html の簡易プロフィール編集（帯状UI）の配線。
 *
 * ログイン中はアカウントの軽量プロフィール（GET /api/me・PUT /api/profile）を、
 * ゲストはブラウザセッション限定の一時プロフィール（guest-profile.js）を編集する。
 *
 * 表示規約（§3.8）: ユーザー由来・サーバー由来を問わずテキストは必ず textContent
 * で描画し、innerHTML は使わない。
 */

"use strict";

const TAGS_MAX = 5;

/** プリセット趣味タグの一覧（/api/tags の結果）。保存成功後の再描画にも使う */
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
  $("entrance-profile-error").textContent = message;
  $("entrance-profile-status").textContent = "";
}

function showStatus(message) {
  $("entrance-profile-status").textContent = message;
  $("entrance-profile-error").textContent = "";
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

function checkedTagIds() {
  return [...document.querySelectorAll('#entrance-tags input[type="checkbox"]:checked')]
    .map((el) => el.value);
}

/** ゲストなら「卓を建てる」カードをリンクとして機能させず、その旨を表示する */
function applyCreateCardState(loggedIn) {
  if (loggedIn) return;
  const card = $("entrance-create");
  card.removeAttribute("href");
  card.classList.add("entrance-card-disabled");
  card.setAttribute("aria-disabled", "true");
  $("entrance-create-desc").textContent = "ログインすると卓を建てられます。";
}

function renderTags(tags, selectedIds) {
  const container = $("entrance-tags");
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

function updateSummary(nickname) {
  $("entrance-profile-summary").textContent = `あだ名: ${nickname === "" ? "未設定" : nickname}`;
}

function setToggleLabel(opening) {
  $("entrance-profile-toggle").textContent = opening ? "戻る ▴" : "名札を整える ▾";
}

function closeProfileForm() {
  $("entrance-profile-form").hidden = true;
  $("entrance-profile-toggle").setAttribute("aria-expanded", "false");
  setToggleLabel(false);
}

$("entrance-profile-toggle").addEventListener("click", () => {
  const form = $("entrance-profile-form");
  const opening = form.hidden;
  form.hidden = !opening;
  $("entrance-profile-toggle").setAttribute("aria-expanded", String(opening));
  setToggleLabel(opening);
});

async function init() {
  const tagsRes = await callApi("/api/tags");
  presetTags = tagsRes.ok && tagsRes.body !== null ? tagsRes.body.tags : [];
  tagsLoadFailed = !tagsRes.ok || tagsRes.body === null;
  if (tagsLoadFailed) {
    showError("趣味タグ一覧の取得に失敗しました");
  }

  const me = await callApi("/api/me");
  isLoggedIn = me.ok && me.body !== null && typeof me.body.userId === "string";
  applyCreateCardState(isLoggedIn);

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

  $("entrance-nickname").value = nickname;
  renderTags(presetTags, tags);
  updateSummary(nickname);
}

$("entrance-profile-save").addEventListener("click", async () => {
  const nickname = $("entrance-nickname").value;
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
      const savedNickname = typeof body?.nickname === "string" ? body.nickname : nickname;
      const savedTags = Array.isArray(body?.tags) ? body.tags : tags;
      $("entrance-nickname").value = savedNickname;
      renderTags(presetTags, savedTags);
      updateSummary(savedNickname);
      showStatus("プロフィールを保存しました");
      closeProfileForm();
    } else {
      showError(`保存に失敗しました (${status}): ${body?.error ?? "unknown error"}`);
    }
    return;
  }

  const trimmed = nickname.trim();
  GuestProfile.setGuestProfile({ nickname: trimmed, tags });
  $("entrance-nickname").value = trimmed;
  updateSummary(trimmed);
  showStatus("名札を保存しました");
  closeProfileForm();
});

init();
