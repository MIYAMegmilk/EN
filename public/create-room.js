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

/**
 * 卓に付けられるタグの上限。server/types.ts の ROOM_TAGS_MAX と必ず同じにする
 * （ビルド無しの構成なので値を二重に持つ）。
 *
 * 超えたまま送ると、卓そのものは WebSocket で建つのに、説明文とタグを載せる
 * PATCH /api/rooms/:code だけが 400 で弾かれる。結果「卓はできたのに説明文が
 * 丸ごと消えた」ように見えるので、遷移する前にここで止める
 */
const TAGS_MAX = 5;

/**
 * 合言葉の下限。server/types.ts の PASSPHRASE_MIN と必ず同じにする。
 *
 * ここで弾かないと、サーバーの validatePassphrase が INVALID_INPUT を返して
 * **卓の作成そのものが失敗する**。しかもその頃には index.html へ遷移している
 * ので、利用者は卓が無いまま、原因の分からないエラーだけを見ることになる
 */
const PASSPHRASE_MIN = 4;

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
    checkbox.addEventListener("change", syncTagCount);
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(tag.label));
    container.appendChild(label);
  }
  syncTagCount();
}

/**
 * 選んだタグの数を見出しに出す。
 *
 * タグの一覧は既定で畳んである（縦に長いため）ので、畳んだままだと何を選んだか
 * 分からなくなる。数だけでも見えていれば、開かずに済む場面が増える。
 */
function syncTagCount() {
  const count = checkedTagIds().length;
  $("create-room-tags-count").textContent = count === 0 ? "" : `：${count}個 選択中`;
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
  // 説明文とタグは PATCH /api/rooms/:code で載せるもので、その PATCH は
  // 一覧に出す卓にしか飛ばない（app.js の doCreateRoom が private のときは
  // pendingRoomMeta を null にする）。出したままにすると、書いた説明文とタグが
  // 警告も無しに捨てられるので、合言葉欄と同じく出し入れする
  $("create-room-description-field").classList.toggle("hidden", isPrivate);
  $("create-room-tags-field").classList.toggle("hidden", isPrivate);
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
  const isPublic = visibility === "public";
  const roomName = $("create-room-name").value;
  if (isPublic && roomName.trim() === "") {
    showError("お座敷一覧に出す卓には名前が必要です");
    return;
  }
  // 説明文とタグは一覧に出す卓だけのもの（syncVisibilityFields 参照）。
  // 一覧に出さない卓では欄ごと隠れているが、public で書いてから private に
  // 切り替えた場合は値が残る。そのまま積むと送られないものを送ったことになるので、
  // 積むかどうかはここで決め切る
  const tags = isPublic ? checkedTagIds() : [];
  // サーバーと同じ上限をここでも見る。遷移してしまうと、弾かれたことに気づける
  // 場所が卓の中の小さなエラー表示だけになり、書いた説明文も戻ってこない
  if (tags.length > TAGS_MAX) {
    showError(`タグは${TAGS_MAX}個以内で選んでください`);
    return;
  }
  // 合言葉は招待制の卓にだけ付く。空欄なら「付けない」なので通す
  const passphrase = $("create-room-passphrase").value;
  if (!isPublic) {
    const trimmed = passphrase.trim();
    if (trimmed.length > 0 && [...trimmed].length < PASSPHRASE_MIN) {
      showError(`合言葉は${PASSPHRASE_MIN}文字以上で入力してください`);
      return;
    }
  }
  RoomHandoff.setPendingCreateRoom({
    nickname,
    visibility,
    roomName,
    description: isPublic ? $("create-room-description").value : "",
    tags,
    entryMode: $("create-room-entry-mode").value === "knock" ? "knock" : "open",
    passphrase,
  });
  location.href = "/index.html";
});

$("create-room-visibility").addEventListener("change", syncVisibilityFields);
syncVisibilityFields();

init();
