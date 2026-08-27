/**
 * 廊下ビューの入口。corridor.html と index.html の両方がこの1本を読む。
 *
 * 中身は corridor-ui.js にある。ここがやるのは次の2つだけ。
 *   1. 3D 本体をいつ読むか
 *   2. 音（足音・店のざわめき・音量つまみ）をどのページで鳴らすか
 *
 * corridor-view.js は three.js（vendor だけで約 750KB）と GLB を引き連れてくるので、
 * 静的 import にするとホームを開いた全員がそれを待たされる。ホームの既定は一覧なので、
 * 「店内を歩く」を選ばれて初めて動的 import する。
 *
 * 動的 import の先は同一オリジンの絶対パスなので、本番の CSP
 * （default-src 'self'／script-src は未指定なので default-src に従う）を通る。
 * インラインの importmap は 'unsafe-inline' が無いため使えない。
 */

import { mountCorridor } from "/assets/3d/corridor-ui.js";

/**
 * 歩いていると判定する1フレームあたりの移動量。
 * corridor-view の速度上限は 3.2/秒なので、60fps なら全速で 0.053 前後になる。
 * 0.002（≒0.12/秒）を境にすると、減速しきる直前まで足音が続いて自然に止まる。
 */
const WALK_EPSILON = 0.002;

/**
 * sound.js（classic script）が公開するグローバル。
 *
 * corridor.html と index.html はこのファイルより前に sound.js を読むが、テストや
 * 将来の別ページでは読まれていないことがある。音が無いだけでページが壊れては困るので、
 * 触る前に必ず有無を見る（corridor-ui.js が globalThis.Rooms を見ているのと同じ）。
 */
const Sound = globalThis.Sound ?? null;

/**
 * どちらのページに載っているかを見分ける。
 *
 * corridor-ui.js の detectPage と同じ見分け方（受け皿の id）を使う。ホーム
 * （index.html）は #corridor-stage、単独ページ（corridor.html）は #stage を持つ。
 * id は corridor-ui.js の PAGES 表が正なので、あちらを直すときはここも合わせること。
 */
function detectPage(doc) {
  if (doc.getElementById("corridor-stage") !== null) return "home";
  if (doc.getElementById("stage") !== null) return "standalone";
  return null;
}

/**
 * 歩いている間だけ足音を鳴らす。
 *
 * corridor-view は「歩き出した／止まった」を外へ知らせないので、公開されている
 * position を毎フレーム見て自分で判定する。3D 側に手を入れずに済ませるための形。
 */
function followFootsteps(view) {
  let last = view.position;
  const tick = () => {
    const now = view.position;
    const moved = Math.hypot(now.x - last.x, now.z - last.z);
    last = now;
    Sound.setWalking(moved > WALK_EPSILON);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * ざわめきと音量つまみは単独ページ（corridor.html）でだけ出す。
 *
 * ホーム（index.html）では app.js の start() がすでに bindButtons / mountControls を
 * 呼んでいるので、ここでも呼ぶと二重になる。ざわめきも、app.js は「卓に入ってから
 * GAYA_ROOM で鳴らす」設計なので、ここで GAYA_CORRIDOR を流すと一覧を眺めているだけで
 * 店内の音が鳴ってしまう。
 *
 * ※ ホームで「店内を歩く」に切り替えたときにざわめきをどうするかは、まだ決めていない。
 *   足音は両ページで鳴る（下の onView）。
 */
if (Sound !== null && detectPage(document) === "standalone") {
  // 廊下にいる間ずっと店のざわめきを流す。3D が使えない環境でも、この画面に
  // 立ち寄ったことは同じなので WebGL の判定より先に鳴らし始める
  Sound.bindButtons();
  Sound.mountControls();
  Sound.loop("gaya", { volume: Sound.GAYA_CORRIDOR });
}

/**
 * ログイン状態の出し入れ（index.html の app.js `refreshAccount` と同じ理屈）。
 *
 * 卓を建てるにはログインが必要（§3.1）。ゲストのまま押すと create-room.js に
 * login.html へ弾かれてしまうので、押せないよう見せるのではなくボタンごと隠す。
 * 「名札」「のれんをくぐる」「お会計」も index.html と同じ出し分けにする。
 */
async function refreshAccount() {
  const res = await fetch("/api/me", { credentials: "same-origin" });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const loggedIn = res.ok && body !== null && typeof body.userId === "string";
  document.getElementById("account-status").textContent = loggedIn
    ? `ログイン中: ${body.userId}`
    : "未ログイン";
  document.getElementById("login-link").classList.toggle("hidden", loggedIn);
  document.getElementById("profile-link").classList.toggle("hidden", !loggedIn);
  document.getElementById("create-room-link").classList.toggle("hidden", !loggedIn);
  document.getElementById("logout").classList.toggle("hidden", !loggedIn);
}

if (detectPage(document) === "standalone") {
  refreshAccount();
  document.getElementById("logout").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    location.href = "/login.html";
  });
}

/**
 * 扉が選ばれたときの入店経路。
 *
 * index.html（home）はもう corridor.js を読まない（3D をホームに埋め込むのをやめた）ため、
 * ここで実質動くのは corridor.html（standalone）だけになった。standalone は入室の
 * 送信経路を持たないので、その場で入店はできない。代わりに room-handoff.js
 * （index.html・corridor.html 双方が読み込む window のグローバル）へ「この卓に入りたい」を
 * 一度だけ書き込み、index.html に遷移する。index.html の app.js が接続確立時にこれを
 * 読み取って自動で join する。
 *
 * corridor-ui.js の既定（home: Rooms.enterRoom / standalone: 表示のみ）を
 * 上書きするため、onEnter を明示的に渡す。
 */
function handoffToIndex(code) {
  RoomHandoff.setPendingJoinRoom({ roomCode: code });
  location.href = "/index.html";
}

mountCorridor({
  createView: async () => (await import("/assets/3d/corridor-view.js")).createCorridorView,
  // 3D が出来たら足音を追い始める。view は corridor-ui.js の中で作られるので、
  // 出来た時点で渡してもらう（店内を選ばれるまで作られないページもある）
  onView: (view) => {
    if (Sound !== null) followFootsteps(view);
  },
  onEnter: handoffToIndex,
  // 「一覧で選ぶ」は卓の一覧そのものが index.html にあるので、卓の情報を
  // 何も持たずに index.html へ渡す（このページ自身では一覧を出さない）
  onModeList: () => {
    location.href = "/index.html";
  },
});
