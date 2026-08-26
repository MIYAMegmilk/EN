/**
 * 廊下ビュー（corridor.html）の配線。
 *
 * やることは3つだけ。
 *   1. /api/rooms と /api/room-tags を取って CorridorView に渡す
 *   2. 正面の扉が変わったら、その卓を文字でも出す（canvas は読み上げられないため）
 *   3. 扉を押されたら入店する
 *
 * 一覧の取得間隔・タイムアウトは rooms.js に合わせてある。
 * サーバー由来の文字列は textContent でのみ書き込む（§3.8）。
 */

import { createCorridorView } from "/assets/3d/corridor-view.js";

const POLL_MS = 10_000;
const TIMEOUT_MS = 5_000;

/**
 * 歩いていると判定する1フレームあたりの移動量。
 * corridor-view の速度上限は 3.2/秒なので、60fps なら全速で 0.053 前後になる。
 * 0.002（≒0.12/秒）を境にすると、減速しきる直前まで足音が続いて自然に止まる。
 */
const WALK_EPSILON = 0.002;

const $ = (id) => document.getElementById(id);
const els = {
  stage: $("stage"),
  left: $("left"),
  right: $("right"),
  count: $("count"),
  name: $("focus-name"),
  meta: $("focus-meta"),
  enter: $("enter"),
  back: $("back"),
  fwd: $("fwd"),
  error: $("error"),
};

let tagLabels = new Map();
let view = null;

function showError(text) {
  els.error.textContent = text;
  els.error.classList.remove("hidden");
}

/**
 * 扉が選ばれたとき。
 *
 * このページは廊下の見え方を確かめるための単体ページで、入店の経路は持っていない。
 * index.html は URL の ?code= を読まないので、ここから遷移しても何も起きない。
 * 本番で繋ぐときは index.html にこのビューを載せて、onEnter から
 * rooms.js と同じ道（#code に入れて #join を押す）を通す。README に手順を書いてある。
 */
function enterRoom(code) {
  els.count.textContent = `「${code}」を選びました（このページは表示確認用で、入店はしません）`;
}

/** 正面の扉が変わったときの表示。カードと同じ情報を文字で出す */
function renderFocus(room) {
  if (room === null || room === undefined) {
    els.name.textContent = "—";
    els.meta.textContent = "通りかかった扉の札がここに出ます";
    els.enter.disabled = true;
    return;
  }
  const full = room.playerCount >= room.capacity;
  const doing = room.gameTitle === undefined
    ? (room.playing ? "遊んでいます" : "まだ何をするか決めていません")
    : `${room.gameTitle} ${room.playing ? "で遊んでいます" : "を選んでいます"}`;
  const tag = Array.isArray(room.tags) && room.tags.length > 0
    ? `／${tagLabels.get(room.tags[0]) ?? room.tags[0]}`
    : "";

  els.name.textContent = `${room.roomName}（${room.code}）`;
  els.meta.textContent =
    `${doing}／${room.playerCount} / ${room.capacity} 名${full ? "・満席" : "・空きあり"}${tag}`;
  els.enter.disabled = full;
}

async function loadTagLabels() {
  try {
    const res = await fetch("/api/room-tags", { credentials: "same-origin" });
    if (!res.ok) return;
    const body = await res.json();
    const tags = Array.isArray(body?.tags) ? body.tags : [];
    tagLabels = new Map(tags.map((t) => [t.id, t.label]));
  } catch {
    // タグが引けなくても廊下は歩ける。IDのまま出す
  }
}

/**
 * 見た目を詰めるためのサンプル卓。`?demo=1` のときだけ使う。
 * 実データが1件も無い状態では札の作りを確かめられないので置いてある。
 * クエリが無ければ一切参照されない。
 */
const DEMO_ROOMS = [
  { code: "AKANE", roomName: "茜屋の奥座敷", playerCount: 3, capacity: 6, playing: true, gameTitle: "人狼", tags: ["board"], createdAt: Date.now() - 3_600_000 },
  { code: "HOTARU", roomName: "蛍", playerCount: 6, capacity: 6, playing: true, gameTitle: "大喜利", tags: ["party"], createdAt: Date.now() - 1_800_000 },
  { code: "SUZU", roomName: "鈴の間", playerCount: 1, capacity: 4, playing: false, tags: ["quiet"], createdAt: Date.now() - 600_000 },
  { code: "KIRI", roomName: "霧しぐれ二番卓", playerCount: 4, capacity: 8, playing: false, gameTitle: "ワードウルフ", tags: ["board"], createdAt: Date.now() - 7_200_000 },
  { code: "YOImachi", roomName: "宵待", playerCount: 2, capacity: 4, playing: true, gameTitle: "しりとり", tags: ["casual"], createdAt: Date.now() - 900_000 },
  { code: "TSUKI", roomName: "月見台", playerCount: 5, capacity: 5, playing: false, tags: ["party"], createdAt: Date.now() - 5_400_000 },
  { code: "NAGI", roomName: "凪", playerCount: 2, capacity: 6, playing: true, gameTitle: "絵しりとり", tags: ["quiet"], createdAt: Date.now() - 300_000 },
];

function useDemoData() {
  return new URLSearchParams(globalThis.location.search).get("demo") === "1";
}

async function refresh() {
  if (useDemoData()) {
    view?.setRooms(DEMO_ROOMS, tagLabels);
    els.count.textContent = `${DEMO_ROOMS.length}卓（サンプル）／歩き続けると同じ卓に再び出会います`;
    return;
  }
  try {
    const res = await fetch("/api/rooms", {
      credentials: "same-origin",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return;
    const body = await res.json();
    const rooms = Array.isArray(body?.rooms) ? body.rooms : [];
    view?.setRooms(rooms, tagLabels);
    els.count.textContent = rooms.length === 0
      ? "いまは灯りのついた卓がありません"
      : `${rooms.length}卓／歩き続けると同じ卓に再び出会います`;
  } catch {
    els.count.textContent = "一覧を取得できませんでした";
  }
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

async function main() {
  // 廊下にいる間ずっと店のざわめきを流す。3D が使えない環境でも、この画面に
  // 立ち寄ったことは同じなので WebGL の判定より先に鳴らし始める
  Sound.bindButtons();
  Sound.mountControls();
  Sound.loop("gaya", { volume: Sound.GAYA_CORRIDOR });

  if (globalThis.WebGLRenderingContext === undefined) {
    showError("この環境では 3D 表示を使えません。卓の一覧からお選びください。");
    return;
  }
  try {
    view = createCorridorView(els.stage, {
      onEnter: enterRoom,
      onFocus: renderFocus,
      tagLabels,
    });
    await view.ready;
  } catch (err) {
    showError(`廊下を読み込めませんでした：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  followFootsteps(view);

  // 見え方を確かめるための窓口。サンプル表示のときだけ生やす。
  if (useDemoData()) globalThis.__corridorView = view;

  els.back.addEventListener("click", () => view.step(-1));
  els.fwd.addEventListener("click", () => view.step(1));
  els.left.addEventListener("click", () => view.turn(1));
  els.right.addEventListener("click", () => view.turn(-1));
  els.enter.addEventListener("click", () => {
    const room = view.focusedRoom;
    if (room !== null) enterRoom(room.code);
  });

  await loadTagLabels();
  await refresh();
  setInterval(refresh, POLL_MS);
}

main();
