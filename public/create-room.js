/**
 * create-room.html の配線。
 *
 * 未ログインなら /login.html へ誘導する（卓の作成はログイン必須、§3.1）。
 * 送信内容は room-handoff.js 経由で index.html に渡し、index.html 側の
 * app.js が WebSocket 接続確立時に自動で createRoom を送る。
 *
 * 表示規約（§3.8）: サーバー由来のテキスト（タグ表示名等）は必ず textContent
 * で描画し、innerHTML は使わない。
 */

"use strict";

function $(id) {
  return document.getElementById(id);
}

function showError(message) {
  $("error").textContent = message;
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

function renderTags(tags) {
  const container = $("create-room-tags");
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

function checkedTagIds() {
  return [...document.querySelectorAll('#create-room-tags input[type="checkbox"]:checked')]
    .map((el) => el.value);
}

/**
 * 誰に見せるかに合わせて、承認制と合言葉の欄を出し入れする。
 *
 * 承認制（§3.1.1）は一覧に出す卓だけの話で、招待制ではコードか合言葉で入る。
 * 合言葉（§3.1）は逆に招待制の卓にだけ付く。どちらも出したままにすると
 * 付けられるように見えてサーバーに弾かれるだけになる。
 */
function syncVisibilityFields() {
  const isPrivate = $("create-room-visibility").value === "private";
  $("create-room-entry-mode-field").classList.toggle("hidden", isPrivate);
  $("create-room-passphrase-field").classList.toggle("hidden", !isPrivate);
}

async function init() {
  const me = await callApi("/api/me");
  if (!me.ok) {
    location.href = "/login.html";
    return;
  }
  if (typeof me.body?.nickname === "string") {
    $("create-room-nickname").value = me.body.nickname;
  }

  const tagsRes = await callApi("/api/room-tags");
  const tags = tagsRes.ok && tagsRes.body !== null ? tagsRes.body.tags : [];
  renderTags(tags);
}

$("create-room-submit").addEventListener("click", () => {
  const nickname = $("create-room-nickname").value;
  // createRoom は join と違い、サーバー側であだ名が必須（server/rooms.ts の
  // handleCreateRoom が validateNickname を通す。空欄は INVALID_INPUT で拒否される）。
  // 送信後は index.html に遷移してしまいエラーが分かりにくくなるので、ここで先に弾く
  if (nickname.trim() === "") {
    showError("あだ名を入力してください");
    return;
  }
  const visibility = $("create-room-visibility").value === "public" ? "public" : "private";
  const roomName = $("create-room-name").value;
  if (visibility === "public" && roomName.trim() === "") {
    showError("お座敷一覧に出す卓には名前が必要です");
    return;
  }
  RoomHandoff.setPendingCreateRoom({
    nickname,
    visibility,
    roomName,
    description: $("create-room-description").value,
    tags: checkedTagIds(),
    entryMode: $("create-room-entry-mode").value === "knock" ? "knock" : "open",
    passphrase: $("create-room-passphrase").value,
  });
  location.href = "/index.html";
});

$("create-room-visibility").addEventListener("change", syncVisibilityFields);
syncVisibilityFields();

init();
