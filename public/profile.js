/**
 * 開発用の動作確認スクリプト
 * /api/tags・/api/me・/api/profile の疎通を手で確かめるための暫定実装。
 *
 * 表示規約（§3.8）: ユーザー由来・サーバー由来を問わずテキストは必ず textContent
 * で描画し、innerHTML は使わない。タグの表示名も /api/tags から取得したサーバー由来
 * の値のみを使う（§3.11）。
 */

"use strict";

const TAGS_MAX = 5;

/** プリセット趣味タグの一覧（/api/tags の結果）。保存成功後の再描画にも使う */
let presetTags = [];

function $(id) {
  return document.getElementById(id);
}

function showError(message) {
  $("error").textContent = message;
  $("status").textContent = "";
}

function showStatus(message) {
  $("status").textContent = message;
  $("error").textContent = "";
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
  const me = await callApi("/api/me");
  if (!me.ok) {
    // 未ログインならログイン画面へ誘導する
    location.href = "/login.html";
    return;
  }

  const tagsRes = await callApi("/api/tags");
  presetTags = tagsRes.ok && tagsRes.body !== null ? tagsRes.body.tags : [];
  if (!tagsRes.ok || tagsRes.body === null) {
    showError("趣味タグ一覧の取得に失敗しました");
  }
  const selectedIds = Array.isArray(me.body.tags) ? me.body.tags : [];
  renderTags(presetTags, selectedIds);
  $("profile-nickname").value = typeof me.body.nickname === "string" ? me.body.nickname : "";
}

$("profile-save").addEventListener("click", async () => {
  const nickname = $("profile-nickname").value;
  const tags = checkedTagIds();
  if (tags.length > TAGS_MAX) {
    showError(`趣味タグは${TAGS_MAX}個以内で選んでください`);
    return;
  }
  const { ok, status, body } = await callApi("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname, tags }),
  });
  if (ok) {
    // サーバー側でトリム・重複除去された正本の値（body.nickname/tags）を画面に反映する
    if (typeof body?.nickname === "string") {
      $("profile-nickname").value = body.nickname;
    }
    if (Array.isArray(body?.tags)) {
      renderTags(presetTags, body.tags);
    }
    showStatus("プロフィールを保存しました");
  } else {
    showError(`保存に失敗しました (${status}): ${body?.error ?? "unknown error"}`);
  }
});

init();
