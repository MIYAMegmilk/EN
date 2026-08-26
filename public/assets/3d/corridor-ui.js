/**
 * 廊下ビューの操作まわり（corridor.html と index.html で共通）。
 *
 * corridor-view.js が 3D そのものを受け持ち、このモジュールがその周りを受け持つ。
 *   1. 卓の札を HTML の <button> で canvas の上に重ねる（3D の木札の代わり）
 *   2. 左下のバーチャルスティックで歩く（指）。キーボードは CorridorView 側のまま
 *   3. 「店内 / 一覧」の切り替え。3D が動かない端末では一覧へ自動で退避する
 *   4. 見えていない間（VC 中・卓に着いている間・タブが隠れている間）は描画を止める
 *   5. 扉を押されたら確認を出してから、呼び出し側の入店経路へ渡す
 *
 * ■ このモジュールが import を持たない理由
 * corridor-view.js は three.js（約 750KB）を引き連れてくる。既定が一覧表示である以上、
 * ホームを開いただけの人にそれを読ませたくないので、3D の生成関数は
 * 呼び出し側（corridor.js）から動的 import で渡してもらう（options.createView）。
 * 同じ作りのおかげで、テストからは偽の生成関数を渡すだけで丸ごと動かせる。
 *
 * ■ 2つのページ
 * corridor.html … 3D だけを切り離して確かめる単独ページ。自分で /api/rooms を取りに行く
 * index.html   … 本番のホーム。データは rooms.js の購読（Rooms.subscribe）から受け取り、
 *                入店も rooms.js の enterRoom（#code に入れて #join を押す）へ渡す。
 *                ここで WS を送らないこと。送信の経路を1本に保つため
 *
 * サーバー由来の文字列は textContent でのみ書き込む（§3.8）。
 */

/** 単独ページが一覧を取り直す間隔。rooms.js に合わせてある */
const POLL_MS = 10_000;
const TIMEOUT_MS = 5_000;

/**
 * 札の段ごとの基準寸法。en.css の .tier-* と合わせる。
 * 毎フレーム offsetWidth を読むとレイアウトが走るので、実測せず定数で持つ。
 * 重なり判定にもこの寸法を使うので、CSS を触ったらこちらも合わせること。
 */
const SIGN_BOX = {
  "tier-focus": { w: 150, h: 72 },
  "tier-pill": { w: 124, h: 28 },
  "tier-dot": { w: 42, h: 20 },
};

/** 段の名前。距離が近い順（詳細・錠剤・点）。SIGN_BOX の鍵と揃える */
const TIER_NAMES = ["tier-focus", "tier-pill", "tier-dot"];

/**
 * 同時に出す札の上限。
 * visibleDoors() は壁越しの扉を落とすので平均 8.5 枚が返るが、
 * それを全部出すと廊下より札のほうが広くなる。近いものから絞る。
 */
const SIGN_MAX = 6;

/**
 * 段は距離で決める。
 *
 * 以前は focusedRoom（3.4m 以内の最近傍1枚）を詳しく出していたが、それだと
 * 扉が密集した場所でも1枚しか詳細が出ず、通路の途中では1枚も出なかった。
 * 「近ければ詳しい」を距離で言い切れば、どちらも同時に片付く。
 * FOCUS_NEAR の 3.5m は、自分のマスの扉（1.0m）と隣のマスの側面の扉（約3.2m）が
 * 入る範囲で、CorridorView 側の focusedRoom の判定（3.4m）ともほぼ揃う。
 */
const FOCUS_NEAR = 3.5;
const PILL_FAR = 5;

/**
 * 段ごとの枚数の上限。溢れたぶんは消さずに1段下へ落とす。
 * 詳細が同時に何枚も出ると、せっかく詰めた占有率が元に戻るので、詳細は2枚まで。
 */
const FOCUS_MAX = 2;
const PILL_MAX = 3;

/**
 * 同時に出す札の面積の合計の上限（px²）。
 *
 * 枚数の上限だけだと、段の組み合わせ次第で占有率が跳ねる（詳細2枚＋錠剤3枚など）。
 * 面積そのものに天井を置けば、どう並んでも画面を食う量が決まる。
 * 予算に入らない札は1段下げる。点（42×20）は数えない――点まで落とした扉を
 * さらに消すと、そこに卓があること自体が伝わらなくなるため。
 * 25,500px² は、幅390px の画面で札の置ける高さを 560px と見たときの約12%で、
 * 詳細2枚＋錠剤1枚がちょうど収まる大きさ。
 */
const SIGN_AREA_BUDGET = 25_500;

/** これより遠い扉は札を出さない。霧（FogExp2 0.10）で沈む前に切る */
const SIGN_FAR = 9;

/** 重なり判定の余白。札同士がこの分だけ離れていなければ後ろ側を捨てる */
const SIGN_GAP = 4;

/** 画面外を指す矢印の上限と、画面の縁からの寄せ幅 */
const EDGE_MAX = 3;
const EDGE_INSET = 30;

/**
 * 方位角から画面端の向きを作るときの、縦の効き具合。
 * 扉はどれも目線の高さにあるので、真横の扉を斜め上に出さないよう縦を抑える。
 */
const EDGE_VERT = 0.35;

/**
 * 札と矢印を入れ替える境目に持たせる余裕（px）。
 * 画面の縁ちょうどで切り替えると、歩いて縁を跨ぐたびに毎フレーム入れ替わって点滅する。
 * 札から矢印へは「完全に外へ出てから」、矢印から札へは「十分に内側へ入ってから」にする。
 */
const HYSTERESIS = 40;

/** スティックの遊び。指が乗っているだけでは歩き出さない */
const DEAD_ZONE = 0.16;

/** 入力の慣らし。1秒後に残る割合（小さいほど速く追従する） */
const RAMP = 0.0005;

/** 慣らしの打ち切り。狙いの値との差がこれを切ったら合わせる */
const SNAP = 0.01;

/** 「店内 / 一覧」のどちらを選んだかの控え。次に来たときも同じ側で開く */
const MODE_KEY = "en.corridor.mode";

/**
 * ページごとの要素 ID。
 *
 * index.html は #error / #vc-join / #code などを既に別の用途で使っているので、
 * ホーム側の廊下の部品はすべて corridor- を付けた ID にしてある。
 * null は「この画面にはその部品が無い」。無い部品には一切触らない。
 */
const PAGES = {
  /** corridor.html（3D だけを切り離して確かめる単独ページ） */
  standalone: {
    ids: {
      stage: "stage",
      signs: "signs",
      edges: "edges",
      note: "signs-note",
      stick: "stick",
      knob: "stick-knob",
      left: "left",
      right: "right",
      back: "back",
      fwd: "fwd",
      enter: "enter",
      count: "count",
      name: "focus-name",
      meta: "focus-meta",
      error: "error",
      walk: "walk-controls",
      mode3d: "mode-3d",
      modeList: "mode-list",
      list: "list-view",
      roomsList: "rooms-list",
      vcJoin: "vc-join",
      vcLeave: "vc-leave",
      confirm: "confirm",
      confirmName: "confirm-name",
      confirmState: "confirm-state",
      confirmMeta: "confirm-meta",
      confirmSince: "confirm-since",
      confirmOk: "confirm-ok",
      confirmCancel: "confirm-cancel",
      entry: null,
    },
    /** 一覧は自前で取りに行き、自前のカードで描く（roomsList が非 null のページ） */
    poll: true,
    /** 既定は店内。3D を確かめるためのページなので、開いた時点で 3D を出す */
    defaultMode: "3d",
    /** 選んだ側を覚えない（毎回まっさらな状態で確かめたい） */
    remember: false,
  },

  /** index.html（本番のホーム） */
  home: {
    ids: {
      stage: "corridor-stage",
      signs: "corridor-signs",
      edges: "corridor-edges",
      note: "corridor-note",
      stick: "corridor-stick",
      knob: "corridor-knob",
      left: "corridor-left",
      right: "corridor-right",
      back: "corridor-back",
      fwd: "corridor-fwd",
      enter: "corridor-enter",
      // 卓数は rooms.js が #rooms-count に出しているので、こちらからは触らない
      count: null,
      name: "corridor-focus-name",
      meta: "corridor-focus-meta",
      error: "corridor-error",
      walk: "corridor-walk",
      mode3d: "corridor-mode-3d",
      modeList: "corridor-mode-list",
      list: "corridor-list",
      // 一覧のカードは rooms.js が描く。二重に描かない
      roomsList: null,
      vcJoin: null,
      vcLeave: null,
      confirm: "corridor-confirm",
      confirmName: "corridor-confirm-name",
      confirmState: "corridor-confirm-state",
      confirmMeta: "corridor-confirm-meta",
      confirmSince: "corridor-confirm-since",
      confirmOk: "corridor-confirm-ok",
      confirmCancel: "corridor-confirm-cancel",
      entry: "entry",
    },
    /** データは rooms.js の購読から来る。同じ /api/rooms を二重に取りに行かない */
    poll: false,
    /**
     * 既定は一覧。
     * 卓を選ぶという用は一覧だけで足りるうえ、3D は three.js と GLB を引き連れてくる。
     * 開いた全員にそれを読ませないため、店内は選んだ人にだけ読み込む。
     */
    defaultMode: "list",
    remember: true,
  },
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** テキストとクラスだけを持つ要素を作る（rooms.js と同じ作り） */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className !== undefined && className !== null) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/** 子要素をすべて取り除く */
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 同じ文字なら書かない。毎フレーム呼ばれる場所で使う */
function setText(node, text) {
  if (node === null) return;
  if (node.textContent !== text) node.textContent = text;
}

/** epoch ms を HH:MM に。rooms.js と同じ書式 */
function formatTime(at) {
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

const message = (err) => (err instanceof Error ? err.message : String(err));

/**
 * 見た目を詰めるためのサンプル卓。単独ページの `?demo=1` のときだけ使う。
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
  { code: "NAGI", roomName: "凪", playerCount: 0, capacity: 6, playing: false, tags: ["quiet"], createdAt: Date.now() - 300_000 },
];

/** どちらのページに載っているかを、受け皿の有無で見分ける */
function detectPage(doc) {
  if (doc.getElementById(PAGES.home.ids.stage) !== null) return "home";
  if (doc.getElementById(PAGES.standalone.ids.stage) !== null) return "standalone";
  return null;
}

/**
 * 廊下ビューを組み立てる。
 *
 * @param {object} [options]
 * @param {() => Promise<Function>} [options.createView] createCorridorView を返す関数。
 *   three.js を引き連れてくるので、店内を選ばれるまで呼ばない
 * @param {"home"|"standalone"} [options.page] ページの種類。省略すると DOM から見分ける
 * @param {Document} [options.document] 差し替え用（テスト）
 * @param {(code: string) => void} [options.onEnter] 入店の経路。省略するとページ既定
 * @returns {object|null} 受け皿が無ければ null
 */
export function mountCorridor(options = {}) {
  const doc = options.document ?? document;
  const kind = options.page ?? detectPage(doc);
  if (kind === null) return null;
  const page = PAGES[kind];
  if (page === undefined) return null;

  const createView = options.createView ?? null;

  const $ = (key) => {
    const id = page.ids[key];
    return id === null ? null : doc.getElementById(id);
  };

  const els = {};
  for (const key of Object.keys(page.ids)) els[key] = $(key);
  if (els.stage === null) return null;

  const query = new URLSearchParams(globalThis.location?.search ?? "");

  /** サンプル卓で見た目を詰めるための逃げ道。単独ページだけ */
  const demo = page.poll && query.get("demo") === "1";

  /**
   * `?debug=1` のときだけ、注記に DOM の枚数まで出す。
   * 「出すべき枚数」と「実際に画面へ出ている DOM の数」がずれていれば
   * 枠の片付けが効いていない、と実機を見ただけで切り分けられる。
   */
  const debug = query.get("debug") === "1";

  /**
   * 揺れを嫌う設定。
   * 酔いの主因は速度そのものではなく加速なので、この設定のときは
   * 慣らしを切って（＝速度を即座に確定させて）最高速も落とす。
   */
  const motionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  let reducedMotion = motionQuery?.matches === true;

  let tagLabels = new Map();
  let view = null;
  let viewFailed = false;
  /** 3D の組み立ては1回だけ。押し直しても重ねて作らない */
  let viewPromise = null;
  let latestRooms = [];
  let focused = null;
  let pending = null;

  let mode = page.defaultMode;
  let suspended = false;
  let suspendNote = "";
  let running = false;

  /** stage の寸法。毎フレーム clientWidth を読まないよう ResizeObserver で控えておく */
  let stageW = 1;
  let stageH = 1;

  const tagLabel = (id) => tagLabels.get(id) ?? id;

  // ── 卓の見せ方 ─────────────────────────────────────

  /**
   * 卓の状態。色だけに載せず、記号と文字の両方で出す。
   * ○ 空き ／ ● 入店中 ／ ▶ ゲーム中 ／ × 満席
   */
  function roomState(room) {
    if (room.playerCount >= room.capacity) return { mark: "×", label: "満席", cls: "is-full" };
    if (room.playing === true) return { mark: "▶", label: "ゲーム中", cls: "is-playing" };
    if (room.playerCount > 0) return { mark: "●", label: "入店中", cls: "is-busy" };
    return { mark: "○", label: "空き", cls: "is-open" };
  }

  /** 何をしているか。rooms.js の room-meta と同じ言い回しに揃える */
  function gameText(room) {
    if (room.gameTitle === undefined) {
      return room.playing ? "遊んでいます" : "まだ何をするか決めていません";
    }
    return room.playing ? `${room.gameTitle} で遊んでいます` : `${room.gameTitle} を選んでいます`;
  }

  /** タグを「／和風／静か」の形に。無ければ空文字 */
  function tagText(room) {
    if (!Array.isArray(room.tags) || room.tags.length === 0) return "";
    return room.tags.map((id) => `／${tagLabel(id)}`).join("");
  }

  /**
   * 読み上げ用の一文。札は小さくて文字を削るので、耳で聞く側には全部を渡す。
   * setAttribute で入れるだけなので HTML としては解釈されない。
   */
  function describeRoom(room) {
    const st = roomState(room);
    const full = room.playerCount >= room.capacity;
    return `${room.roomName}、${room.capacity}人中${room.playerCount}人、${st.label}。` +
      `${gameText(room)}${tagText(room)}。${formatTime(room.createdAt)} から。` +
      (full ? "満席のため入れません。" : "押すと入店の確認が出ます。");
  }

  /** 中身が変わったときだけ札を書き直すための指紋 */
  function roomSig(room) {
    const tags = Array.isArray(room.tags) ? room.tags.join(",") : "";
    return [
      room.code,
      room.roomName,
      room.playerCount,
      room.capacity,
      room.gameTitle,
      room.playing,
      tags,
      room.createdAt,
    ].join("|");
  }

  // ── 入店 ───────────────────────────────────────────

  /**
   * 入店する。
   *
   * ホームでは rooms.js の enterRoom（#code に入れて #join を押す）へ渡すだけで、
   * ここから WS は一切送らない。送信の経路を1本に保つため。
   * 単独ページには入店の経路が無いので、選んだことだけを出す。
   */
  const enterRoom = options.onEnter ?? (kind === "home"
    ? (code) => globalThis.Rooms?.enterRoom?.(code)
    : (code) => {
      setText(els.count, `「${code}」を選びました（このページは表示確認用で、入店はしません）`);
    });

  /** 確認を挟んでから入る。指で歩くと札を掠めやすいので、押し間違いをここで止める */
  function askEnter(room) {
    if (room === null || typeof room !== "object") return;
    if (room.playerCount >= room.capacity) return;
    pending = room;
    resetInput();

    const st = roomState(room);
    setText(els.confirmName, `${room.roomName}（${room.code}）`);
    setText(els.confirmState, `${st.mark} ${st.label}　${room.playerCount}/${room.capacity}`);
    setText(els.confirmMeta, `${gameText(room)}${tagText(room)}`);
    setText(els.confirmSince, `${formatTime(room.createdAt)} から灯りがついています`);

    if (els.confirm !== null && typeof els.confirm.showModal === "function") {
      els.confirm.showModal();
      return;
    }
    // <dialog> を持たない環境では素の確認で代用する
    if (globalThis.confirm(`${room.roomName}（${room.code}）に入りますか？`)) enterRoom(room.code);
    pending = null;
  }

  /** 卓コードしか手元に無い経路（3D 側のタップ・Enter キー・バーのボタン）から */
  function askEnterByCode(code) {
    const room = latestRooms.find((r) => r.code === code);
    if (room === undefined) {
      enterRoom(code);
      return;
    }
    askEnter(room);
  }

  // ── 札（HTML を canvas の上に重ねる） ───────────────

  /*
   * 札は3段に分ける。全部の扉に全部の情報を出すと、幅 390px の画面では
   * 廊下より札のほうが広くなる。
   *   tier-focus  いま見ている扉。卓名・人数・状態・ゲーム名・タグ・時刻
   *   tier-pill   近い扉。卓名 ＋ 3/6 ＋ 状態の記号だけ
   *   tier-dot    遠い扉。人数だけ
   * 段は CSS 側で中身の出し入れを切り替えるので、DOM の作りは1種類で足りる。
   */

  const signPool = [];
  const edgePool = [];

  /** 札を1枚作る。使い回すので、作るのは最初の1回だけ */
  function takeSign(i) {
    let s = signPool[i];
    if (s !== undefined) return s;

    const root = el(doc, "button", "corridor-sign");
    root.type = "button";
    const mark = el(doc, "span", "corridor-sign-mark");
    const name = el(doc, "span", "corridor-sign-name");
    const seats = el(doc, "span", "corridor-sign-seats tabular");
    const label = el(doc, "span", "corridor-sign-label");
    const game = el(doc, "span", "corridor-sign-game");
    const tags = el(doc, "span", "corridor-sign-tags");
    const since = el(doc, "span", "corridor-sign-since tabular");
    root.append(mark, name, seats, label, game, tags, since);

    s = {
      root,
      mark,
      name,
      seats,
      label,
      game,
      tags,
      since,
      sig: "",
      cls: "",
      state: "",
      room: null,
    };
    root.addEventListener("click", () => askEnter(s.room));
    signPool[i] = s;
    return s;
  }

  /** 札の中身。指紋が同じなら何も触らない */
  function fillSign(s, room) {
    s.room = room;
    const sig = roomSig(room);
    if (s.sig === sig) return;
    s.sig = sig;

    const st = roomState(room);
    s.state = st.cls;
    s.root.disabled = room.playerCount >= room.capacity;
    s.root.setAttribute("aria-label", describeRoom(room));

    s.mark.textContent = st.mark;
    s.name.textContent = room.roomName ?? "";
    s.seats.textContent = `${room.playerCount}/${room.capacity}`;
    s.label.textContent = st.label;
    s.game.textContent = gameText(room);
    s.since.textContent = `${formatTime(room.createdAt)} から`;

    clear(s.tags);
    const tags = Array.isArray(room.tags) ? room.tags.slice(0, 2) : [];
    for (const id of tags) s.tags.appendChild(el(doc, "span", "tag", tagLabel(id)));
  }

  /**
   * 札を1枚置く。
   *
   * 位置は visibleDoors() の画面座標をそのまま使い、画面の中へ押し戻さない。
   * 以前は札の幅の半分だけ内側へ clamp していたが、幅 390px の画面では札の置ける幅が
   * 212px しか残らず、端に居る扉の札が縁に張り付いて動かなくなっていた
   * （実機で言われた「同じ位置にずっと出ている」の正体）。はみ出す分は stage 側で切れてよい。
   */
  function placeSign(index, room, tier, x, y, scale, dist) {
    const s = takeSign(index);
    fillSign(s, room);
    const cls = `corridor-sign ${tier} ${s.state}`;
    if (s.cls !== cls) {
      s.cls = cls;
      s.root.className = cls;
    }
    s.root.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) ` +
      `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    // いま見ている扉だけは薄くしない。押す前に読めないと困る
    s.root.style.opacity = (tier === "tier-focus" ? 1 : opacityFor(dist)).toFixed(2);
    attach(s.root, els.signs);
  }

  /** 画面外の卓を指す矢印を1つ作る */
  function takeEdge(i) {
    let e = edgePool[i];
    if (e !== undefined) return e;

    const root = el(doc, "button", "corridor-edge");
    root.type = "button";
    const arrow = el(doc, "span", "corridor-edge-arrow", "↑");
    const name = el(doc, "span", "corridor-edge-name");
    const seats = el(doc, "span", "corridor-edge-seats tabular");
    root.append(arrow, name, seats);

    e = { root, arrow, name, seats, sig: "", bearing: 0 };
    root.addEventListener("click", () => faceDoor(e.bearing));
    edgePool[i] = e;
    return e;
  }

  function fillEdge(e, room) {
    const sig = roomSig(room);
    if (e.sig === sig) return;
    e.sig = sig;

    const st = roomState(room);
    e.name.textContent = room.roomName ?? "";
    e.seats.textContent = `${st.mark}${room.playerCount}/${room.capacity}`;
    e.root.setAttribute("aria-label", `画面の外：${describeRoom(room)}押すとそちらを向きます。`);
  }

  /**
   * 画面の外にある卓のほうを向く。
   *
   * 見えていない卓にいきなり入れるより、まず向き直って札を読んでもらうほうが安全。
   * 一息で回すのは、視界が流れる時間を作らないため（VR でいうスナップターン）。
   * bearing は正面が 0 で左が + なので、いまの yaw に足すだけでその扉が正面に来る。
   */
  function faceDoor(bearing) {
    if (view === null || !Number.isFinite(bearing)) return;
    const at = view.position;
    if (at === null || typeof at !== "object" || !Number.isFinite(at.yaw)) return;
    view.position = { yaw: at.yaw + bearing };
  }

  /**
   * 画面外の卓を、画面の縁のどちらへ寄せるか。
   *
   * 向きは投影後の x, y ではなく bearing から作る。後ろの扉は投影で符号が反転していて
   * 画面座標から向きを復元できないため（corridor-view.js の注記どおり）。
   * 正面を上、左を左、真後ろを下に対応させる：(-sin θ, -cos θ)。
   * 扉はどれも目線の高さにあるので、縦の効きだけ EDGE_VERT で抑える。
   */
  function edgeDirection(bearing) {
    const dx = -Math.sin(bearing);
    const dy = -Math.cos(bearing) * EDGE_VERT;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return { x: 0, y: 1 };
    return { x: dx / len, y: dy / len };
  }

  /** 中心からの向きを保ったまま、内側に EDGE_INSET だけ入った矩形の枠に当てる */
  function toEdge(dx, dy) {
    const halfW = Math.max(20, stageW / 2 - EDGE_INSET);
    const halfH = Math.max(20, stageH / 2 - EDGE_INSET);
    const t = Math.min(halfW / Math.max(Math.abs(dx), 1e-6), halfH / Math.max(Math.abs(dy), 1e-6));
    return { x: stageW / 2 + dx * t, y: stageH / 2 + dy * t };
  }

  function placeEdge(index, room, bearing) {
    const e = takeEdge(index);
    fillEdge(e, room);
    e.bearing = bearing;
    const dir = edgeDirection(bearing);
    const at = toEdge(dir.x, dir.y);
    e.root.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0) ` +
      "translate(-50%, -50%)";
    e.arrow.style.transform = `rotate(${(Math.atan2(dir.y, dir.x) + Math.PI / 2).toFixed(3)}rad)`;
    attach(e.root, els.edges);
  }

  /**
   * 枠を出す／畳む。
   *
   * 表示・非表示は hidden 属性でもスタイルでもなく、「コンテナに繋がっているかどうか」で表す。
   *
   * hidden 属性が効くのは UA スタイルの `[hidden] { display: none }` によってだけで、
   * カスケードでは作者スタイルの通常宣言のほうが常に強い（詳細度は関係ない）。
   * .corridor-sign の display: flex がある以上 hidden は最初から効いておらず、
   * 使い終わった枠が最後の位置に残り続けていた
   * ――実機で言われた「小さいポップアップが増殖して画面に固定される」の正体。
   * （en.css に [hidden] の打ち消しを昇格させたので今は効くが、
   * 親から外すほうが読み上げとタブ送りからも確実に外れるので、この作りのまま残す。）
   *
   * 繋ぐのは必ず 0 番から順で、外すのは後ろからなので、コンテナの子はいつでも
   * 「プールの先頭から出している枚数ぶん」と同じ並びになる（近い扉が先）。
   */
  function attach(root, container) {
    if (root.parentNode === container) return;
    container.appendChild(root);
  }

  function detach(root) {
    if (root.parentNode === null) return;
    root.remove();
  }

  function hideFrom(pool, from) {
    for (let i = from; i < pool.length; i++) detach(pool[i].root);
  }

  /** プールのうち、いま画面に繋がっている枠の数。DOM が片付いているかの確認に使う */
  function countShown(pool) {
    let n = 0;
    for (const item of pool) {
      if (item.root.parentNode !== null) n++;
    }
    return n;
  }

  function hideAllDoors() {
    hideFrom(signPool, 0);
    hideFrom(edgePool, 0);
    doorModes = new Map();
  }

  /** 遠い札ほど小さく、薄く。近い扉が手前に来るように仕向ける */
  const scaleFor = (dist) => clamp(1.1 - dist / 18, 0.8, 1);
  const opacityFor = (dist) => clamp(1.15 - dist / SIGN_FAR, 0.45, 1);

  const overlaps = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

  /**
   * 扉ごとの「いま札で出しているか、矢印で出しているか」。
   *
   * 画面の縁ちょうどで切り替えると、歩いて縁を跨ぐたびに札と矢印が毎フレーム
   * 入れ替わって点滅する。前のフレームの区分を覚えておき、戻る側の敷居を
   * HYSTERESIS だけずらして、境目での往復を止める。
   *
   * 鍵は visibleDoors() が返す扉の id。視点が変わっても同じ扉なら同じ値なので、
   * 見えている扉の集合が入れ替わっても覚えたものが混ざらない。
   */
  let doorModes = new Map();

  /**
   * 扉を一意に指す鍵。
   *
   * id が無いビュー向けの繋ぎとして「卓コード ＋ 同じコードの中での近い順」も残すが、
   * これは視点を振ると順位が入れ替わって鍵が変わる（同じ卓の札が分裂して増える）。
   * id が来ている限りそちらだけを使う。
   */
  function doorKey(d, room, seen) {
    if (typeof d.id === "string" && d.id.length > 0) return d.id;
    const nth = seen.get(room.code) ?? 0;
    seen.set(room.code, nth + 1);
    return `${room.code}#${nth}`;
  }

  function modeFor(key, d) {
    // 後ろの扉は札にしない。前後の入れ替わりは画面外で起きるので点滅しない
    if (d.behind === true) return "edge";
    if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) return "edge";
    const was = doorModes.get(key);
    if (was === "sign") {
      // 完全に画面の外へ出るまでは札のまま
      const out = d.x < -HYSTERESIS || d.x > stageW + HYSTERESIS ||
        d.y < -HYSTERESIS || d.y > stageH + HYSTERESIS;
      return out ? "edge" : "sign";
    }
    if (was === "edge") {
      // 十分に画面の内側へ入ってから札へ戻す
      const deepIn = d.x >= HYSTERESIS && d.x <= stageW - HYSTERESIS &&
        d.y >= HYSTERESIS && d.y <= stageH - HYSTERESIS;
      return deepIn ? "sign" : "edge";
    }
    // 初めて見る扉は API の判定をそのまま使う
    return d.onScreen === false ? "edge" : "sign";
  }

  /** 距離だけで決まる、その扉の本来の段。0 が詳細、1 が錠剤、2 が点 */
  function tierRank(dist) {
    if (dist <= FOCUS_NEAR) return 0;
    if (dist <= PILL_FAR) return 1;
    return 2;
  }

  /** その段で置いたときに札が食う面積（px²） */
  function tierArea(rank, scale) {
    const box = SIGN_BOX[TIER_NAMES[rank]];
    return box.w * box.h * scale * scale;
  }

  /**
   * 毎フレームの札の並べ直し。
   *
   * 段は距離で決める（近いほど詳しい）。同じ距離帯に何枚あっても詳細を出すが、
   * 枚数と面積の両方に天井があり、溢れたぶんは消さずに1段下へ落とす。
   *
   * 重なりの捌き方: 近い扉から順に置き、すでに置いた札と矩形が交差するものは
   * その場では出さない（近いほうを勝たせる）。捨てた枚数は注記で出す。
   * 一歩でも動けば交差が解けて出てくるので、隠れっぱなしにはならない。
   */
  function layoutDoors() {
    if (view === null || typeof view.visibleDoors !== "function") return;

    let doors;
    try {
      doors = view.visibleDoors();
    } catch {
      doors = [];
    }
    if (!Array.isArray(doors)) doors = [];

    const near = [];   // 札で出す扉
    const away = [];   // 縁の矢印で出す扉
    const nextModes = new Map();
    const seen = new Map();

    for (const d of doors) {
      if (d === null || typeof d !== "object") continue;
      const room = d.room;
      if (room === null || typeof room !== "object") continue;
      const dist = Number.isFinite(d.distance) ? d.distance : 0;
      if (dist > SIGN_FAR) continue;

      const key = doorKey(d, room, seen);
      const mode = modeFor(key, d);
      nextModes.set(key, mode);
      // 同じ扉が札と矢印の両方に出ることはない。区分は扉ごとに1つ
      (mode === "sign" ? near : away).push({ d, room, dist });
    }
    doorModes = nextModes;

    const byDist = (a, b) => a.dist - b.dist;
    near.sort(byDist);
    away.sort(byDist);

    const placed = [];
    const counts = [0, 0, 0];
    let signCount = 0;
    let dropped = 0;
    let used = 0;

    for (const { d, room, dist } of near) {
      if (signCount >= SIGN_MAX) {
        dropped++;
        continue;
      }

      // 本来の段から、枚数の天井に当たっているぶんだけ下げる
      let rank = tierRank(dist);
      if (rank === 0 && counts[0] >= FOCUS_MAX) rank = 1;
      if (rank === 1 && counts[1] >= PILL_MAX) rank = 2;

      // 面積の予算に入るところまで、さらに下げる。点は数えないので必ずどこかで収まる
      let scale = rank === 2 ? 1 : scaleFor(dist);
      while (rank < 2 && used + tierArea(rank, scale) > SIGN_AREA_BUDGET) {
        rank++;
        scale = rank === 2 ? 1 : scaleFor(dist);
      }
      const area = rank === 2 ? 0 : tierArea(rank, scale);

      const tier = TIER_NAMES[rank];
      const box = SIGN_BOX[tier];
      const halfW = (box.w * scale) / 2 + SIGN_GAP;
      const halfH = (box.h * scale) / 2 + SIGN_GAP;
      const rect = { l: d.x - halfW, t: d.y - halfH, r: d.x + halfW, b: d.y + halfH };
      if (placed.some((p) => overlaps(p, rect))) {
        dropped++;
        continue;
      }
      placed.push(rect);

      placeSign(signCount, room, tier, d.x, d.y, scale, dist);
      counts[rank]++;
      used += area;
      signCount++;
    }

    let edgeCount = 0;
    for (const { d, room } of away) {
      if (edgeCount >= EDGE_MAX) break;
      placeEdge(edgeCount, room, Number.isFinite(d.bearing) ? d.bearing : 0);
      edgeCount++;
    }

    hideFrom(signPool, signCount);
    hideFrom(edgePool, edgeCount);

    // 何を出して何を省いたかは黙って隠さない
    const parts = [];
    if (signCount > 0) parts.push(`札 ${signCount}枚`);
    if (dropped > 0) parts.push(`省略 ${dropped}枚`);
    if (away.length > 0) parts.push(`画面外 ${away.length}卓`);
    if (debug) {
      // 「DOM 札」が「札」より多ければ、使い終わった枠が画面に残っている
      parts.push(
        `DOM 札${countShown(signPool)}/矢${countShown(edgePool)}` +
          `｜扉${doors.length}｜詳${counts[0]}錠${counts[1]}点${counts[2]}`,
      );
    }
    setText(els.note, parts.join("／"));
  }

  // ── 歩く（指の入力） ───────────────────────────────

  /** スティックの生の倒し具合。前後と左右、それぞれ -1〜1 */
  const raw = { forward: 0, strafe: 0 };
  /** 実際に渡す値。慣らしを通した後 */
  const smooth = { forward: 0, strafe: 0 };

  function resetInput() {
    raw.forward = 0;
    raw.strafe = 0;
    smooth.forward = 0;
    smooth.strafe = 0;
    if (els.knob !== null) els.knob.style.transform = "translate3d(0, 0, 0)";
    if (view !== null && typeof view.setInput === "function") {
      view.setInput({ forward: 0, strafe: 0, turn: 0 });
    }
  }

  /**
   * 毎フレーム、いまの入力をビューへ渡す。
   *
   * 揺れを嫌う設定のときは慣らしを飛ばし、最高速も落とす。
   * 加速している間が一番酔うので、速度を即座に確定させるほうが軽い。
   */
  function driveWalk(dt) {
    if (view === null) return;

    if (reducedMotion) {
      smooth.forward = raw.forward;
      smooth.strafe = raw.strafe;
    } else {
      const k = 1 - Math.pow(RAMP, dt);
      smooth.forward += (raw.forward - smooth.forward) * k;
      smooth.strafe += (raw.strafe - smooth.strafe) * k;
      // 差が最高速の1%を切ったら合わせてしまう。指を離したあと、
      // 見えないほど遅い速度を延々と送り続けないため
      if (Math.abs(smooth.forward - raw.forward) < SNAP) smooth.forward = raw.forward;
      if (Math.abs(smooth.strafe - raw.strafe) < SNAP) smooth.strafe = raw.strafe;
    }

    const gain = reducedMotion ? 0.75 : 1;
    if (typeof view.setInput !== "function") return;
    // 押しっぱなしの入力。turn は画面のボタン（撃力の turn()）に任せるので毎回 0 に戻す
    view.setInput({ forward: smooth.forward * gain, strafe: smooth.strafe * gain, turn: 0 });
  }

  /** 左下のスティック。指1本ぶんだけ拾い、canvas のドラッグ見回しとは別々に動く */
  function bindStick() {
    if (els.stick === null || els.knob === null) return;
    let pointerId = null;

    function apply(ev) {
      const rect = els.stick.getBoundingClientRect();
      const radius = rect.width / 2;
      if (radius <= 0) return;
      const vx = (ev.clientX - (rect.left + radius)) / radius;
      const vy = (ev.clientY - (rect.top + radius)) / radius;
      const len = Math.hypot(vx, vy);

      if (len < DEAD_ZONE) {
        raw.forward = 0;
        raw.strafe = 0;
        els.knob.style.transform = "translate3d(0, 0, 0)";
        return;
      }
      const ux = vx / len;
      const uy = vy / len;
      const mag = Math.min(len, 1);
      // 遊びの分を引いてから 0〜1 に伸ばし直す。境目で急に動き出さない
      const amount = (mag - DEAD_ZONE) / (1 - DEAD_ZONE);
      raw.strafe = ux * amount;
      raw.forward = -uy * amount;

      const travel = (radius - 29) * mag;
      els.knob.style.transform = `translate3d(${(ux * travel).toFixed(1)}px, ${
        (uy * travel).toFixed(1)
      }px, 0)`;
    }

    els.stick.addEventListener("pointerdown", (ev) => {
      if (pointerId !== null) return;
      pointerId = ev.pointerId;
      els.stick.setPointerCapture(pointerId);
      ev.preventDefault();
      apply(ev);
    });
    els.stick.addEventListener("pointermove", (ev) => {
      if (ev.pointerId !== pointerId) return;
      apply(ev);
    });
    const release = (ev) => {
      if (ev.pointerId !== pointerId) return;
      try {
        els.stick.releasePointerCapture(pointerId);
      } catch { /* 解放済み */ }
      pointerId = null;
      raw.forward = 0;
      raw.strafe = 0;
      els.knob.style.transform = "translate3d(0, 0, 0)";
    };
    els.stick.addEventListener("pointerup", release);
    els.stick.addEventListener("pointercancel", release);
  }

  // ── 毎フレーム ─────────────────────────────────────

  let rafId = 0;
  let lastAt = 0;

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    const dt = lastAt === 0 ? 0 : Math.min((now - lastAt) / 1000, 0.1);
    lastAt = now;
    driveWalk(dt);
    layoutDoors();
  }

  function startLoop() {
    if (rafId !== 0) return;
    lastAt = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafId === 0) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // ── 描画を止める・再開する ─────────────────────────

  /**
   * 描画を回してよい条件。
   * 卓に着いている間・VC 中・一覧を見ている間・タブが隠れている間は、画面に映らないのに
   * GPU と電池を食うだけなので止める。壊さない（dispose ではなく pause）ので戻れる。
   */
  function syncRunning() {
    const shouldRun = view !== null && mode === "3d" && !suspended && !doc.hidden;
    if (shouldRun === running) return;
    running = shouldRun;

    if (shouldRun) {
      if (typeof view.resume === "function") view.resume();
      startLoop();
      return;
    }
    stopLoop();
    resetInput();
    hideAllDoors();
    setText(els.note, suspended ? suspendNote : "");
    if (view !== null && typeof view.pause === "function") view.pause();
  }

  /** 見えていない間は止める。理由の文言は呼び出し側から渡す */
  function setSuspended(on, note) {
    suspended = on === true;
    suspendNote = suspended ? (note ?? "") : "";
    syncRunning();
  }

  // ── 表示の切り替え ─────────────────────────────────

  function setMode(next, persist = true) {
    mode = next === "3d" && !viewFailed ? "3d" : "list";
    const is3d = mode === "3d";
    els.stage.classList.toggle("hidden", !is3d);
    els.walk?.classList.toggle("hidden", !is3d);
    els.list?.classList.toggle("hidden", is3d);
    els.mode3d?.setAttribute("aria-pressed", String(is3d));
    els.modeList?.setAttribute("aria-pressed", String(!is3d));
    // 3D が動かなくて落ちてきたぶんは控えない。次の端末では店内で開きたいはず
    if (persist) remember(mode);
    if (is3d) ensureView();
    syncRunning();
  }

  /** 選んだ側を控える。使えなくても表示は続けられるので黙って諦める */
  function remember(value) {
    if (!page.remember) return;
    try {
      globalThis.localStorage?.setItem(MODE_KEY, value);
    } catch { /* プライベートモード等では書けない */ }
  }

  function remembered() {
    if (!page.remember) return null;
    try {
      const value = globalThis.localStorage?.getItem(MODE_KEY);
      return value === "3d" || value === "list" ? value : null;
    } catch {
      return null;
    }
  }

  /** 3D を諦めて一覧へ。切り替えボタンは残したまま、店内側だけ塞ぐ */
  function fallbackToList(text) {
    viewFailed = true;
    if (els.error !== null) {
      els.error.textContent = `${text}卓の一覧に切り替えました。`;
      els.error.classList.remove("hidden");
    }
    if (els.mode3d !== null) els.mode3d.disabled = true;
    setMode("list", false);
  }

  // ── 一覧（3D が動かないときの本体） ─────────────────

  /**
   * 卓1件のカード。index.html の卓カードと同じ組み立てにしてある。
   * ホームでは rooms.js が同じ役目のカードを描いているので、こちらは使わない。
   */
  function renderRoom(room) {
    const st = roomState(room);
    const full = room.playerCount >= room.capacity;

    const card = el(doc, "article", "card room");

    const head = el(doc, "div", "room-head");
    head.appendChild(el(doc, "span", room.playing ? "dot" : "dot dot-off"));
    head.appendChild(el(doc, "span", "room-code", room.code));
    head.appendChild(el(doc, "span", "spacer"));
    head.appendChild(
      el(doc, "span", full ? "badge" : "badge badge-gold", `${st.mark} ${st.label}`),
    );
    card.appendChild(head);

    card.appendChild(el(doc, "h2", null, room.roomName));
    card.appendChild(el(doc, "p", "room-meta", gameText(room)));

    if (Array.isArray(room.tags) && room.tags.length > 0) {
      const tagsRow = el(doc, "div", "room-tags");
      for (const id of room.tags) tagsRow.appendChild(el(doc, "span", "tag", tagLabel(id)));
      card.appendChild(tagsRow);
    }

    const seats = el(doc, "div", "room-seats");
    seats.appendChild(el(doc, "span", "tabular", `${room.playerCount}/${room.capacity} 名`));
    card.appendChild(seats);

    const foot = el(doc, "div", "room-foot");
    const enter = el(doc, "button", "btn btn-gold", "入店");
    enter.type = "button";
    enter.disabled = full;
    enter.setAttribute("aria-label", describeRoom(room));
    enter.addEventListener("click", () => askEnter(room));
    foot.appendChild(enter);
    foot.appendChild(el(doc, "span", "room-since tabular", `${formatTime(room.createdAt)} から`));
    card.appendChild(foot);

    return card;
  }

  function renderList(rooms) {
    if (els.roomsList === null) return;
    clear(els.roomsList);
    if (rooms.length === 0) {
      els.roomsList.appendChild(
        el(doc, "p", "rooms-empty", "いまは灯りのついた卓がありません。"),
      );
      return;
    }
    for (const room of rooms) els.roomsList.appendChild(renderRoom(room));
  }

  /** 正面の扉が変わったときの表示。カードと同じ情報を文字で出す */
  function renderFocus(room) {
    focused = room ?? null;
    if (focused === null) {
      setText(els.name, "—");
      setText(els.meta, "通りかかった扉の札がここに出ます");
      if (els.enter !== null) els.enter.disabled = true;
      return;
    }
    const st = roomState(focused);
    setText(els.name, `${focused.roomName}（${focused.code}）`);
    setText(
      els.meta,
      `${st.mark} ${st.label}／${focused.playerCount}/${focused.capacity}／` +
        `${gameText(focused)}${tagText(focused)}／${formatTime(focused.createdAt)} から`,
    );
    if (els.enter !== null) els.enter.disabled = focused.playerCount >= focused.capacity;
  }

  // ── データ ─────────────────────────────────────────

  /** 取得した一覧を、廊下と（自前の）一覧の両方へ配る */
  function applyRooms(rooms, labels, suffix) {
    latestRooms = Array.isArray(rooms) ? rooms : [];
    if (labels instanceof Map) tagLabels = labels;
    view?.setRooms(latestRooms, tagLabels);
    renderList(latestRooms);
    if (suffix !== undefined) {
      setText(
        els.count,
        latestRooms.length === 0
          ? "いまは灯りのついた卓がありません"
          : `${latestRooms.length}卓${suffix}`,
      );
    }
    // 札の中身が変わったので、次のフレームで書き直させる
    for (const s of signPool) s.sig = "";
    for (const e of edgePool) e.sig = "";
  }

  /** 単独ページだけが使う取得。ホームは rooms.js の購読から受け取る */
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

  async function refresh() {
    if (demo) {
      applyRooms(DEMO_ROOMS, null, "（サンプル）／歩き続けると同じ卓に再び出会います");
      return;
    }
    try {
      const res = await fetch("/api/rooms", {
        credentials: "same-origin",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return;
      const body = await res.json();
      applyRooms(
        Array.isArray(body?.rooms) ? body.rooms : [],
        null,
        "／歩き続けると同じ卓に再び出会います",
      );
    } catch {
      setText(els.count, "一覧を取得できませんでした");
    }
  }

  /**
   * ホームのデータ源。rooms.js が 10 秒ごとに取っている結果をそのまま貰う。
   * ここで /api/rooms を叩くと、同じ画面から二重に取りに行くことになる。
   */
  function subscribeRooms() {
    const rooms = globalThis.Rooms;
    if (rooms === undefined || typeof rooms.subscribe !== "function") return;
    rooms.subscribe((list, labels) => applyRooms(list, labels));
  }

  // ── 組み立て ───────────────────────────────────────

  /**
   * CorridorView 側にまだ入っていない API を拾って知らせる。
   * 無くてもページは動くが、動かない機能がどれかを黙って隠さない。
   */
  function noticeMissingApi() {
    const missing = ["pause", "resume", "visibleDoors", "setInput"]
      .filter((name) => typeof view[name] !== "function");
    if (missing.length === 0 || els.error === null) return;
    els.error.textContent = `corridor-view.js に ${missing.join(" / ")} がまだ無いため、` +
      "描画の停止・HTML の札・横移動は仮の動きです。";
    els.error.classList.remove("hidden");
  }

  /**
   * 3D を用意する。店内を選ばれて初めて呼ぶ。
   * 一度でも作ってあれば何もしない。失敗したら二度と試さず一覧へ倒す。
   */
  function ensureView() {
    if (viewPromise === null) viewPromise = buildView();
    return viewPromise;
  }

  async function buildView() {
    if (createView === null) return;
    if (globalThis.WebGLRenderingContext === undefined) {
      fallbackToList("この端末では 3D 表示を使えません。");
      return;
    }

    let factory;
    try {
      factory = await createView();
    } catch (err) {
      fallbackToList(`廊下を読み込めませんでした（${message(err)}）。`);
      return;
    }

    let created = null;
    try {
      created = factory(els.stage, {
        onEnter: askEnterByCode,
        onFocus: renderFocus,
        tagLabels,
      });
      await created.ready;
    } catch (err) {
      // 作りかけの canvas を残さない。dispose 自体が失敗しても一覧へは進む
      try {
        created?.dispose();
      } catch { /* 途中まで作った分だけ落とせればよい */ }
      fallbackToList(`廊下を読み込めませんでした（${message(err)}）。`);
      return;
    }

    view = created;
    // 見え方を確かめるための窓口。サンプル表示のときだけ生やす
    if (demo) globalThis.__corridorView = view;
    noticeMissingApi();
    view.setRooms(latestRooms, tagLabels);
    running = true;   // ready の時点で CorridorView 側の描画は回っている
    startLoop();
    syncRunning();
  }

  function bindUi() {
    bindStick();

    els.back?.addEventListener("click", () => view?.step(-1));
    els.fwd?.addEventListener("click", () => view?.step(1));
    els.left?.addEventListener("click", () => view?.turn(1));
    els.right?.addEventListener("click", () => view?.turn(-1));
    els.enter?.addEventListener("click", () => {
      if (focused !== null) askEnter(focused);
    });

    els.mode3d?.addEventListener("click", () => setMode("3d"));
    els.modeList?.addEventListener("click", () => setMode("list"));

    // 単独ページの VC 疑似ボタン。本番では #entry の hidden がこの役目を持つ
    els.vcJoin?.addEventListener("click", () => {
      els.vcJoin.disabled = true;
      if (els.vcLeave !== null) els.vcLeave.disabled = false;
      setSuspended(true, "VC中：描画を止めています");
    });
    els.vcLeave?.addEventListener("click", () => {
      if (els.vcJoin !== null) els.vcJoin.disabled = false;
      els.vcLeave.disabled = true;
      setSuspended(false);
    });

    els.confirmCancel?.addEventListener("click", () => els.confirm?.close());
    els.confirmOk?.addEventListener("click", () => {
      const room = pending;
      els.confirm?.close();
      if (room !== null) enterRoom(room.code);
    });
    els.confirm?.addEventListener("close", () => {
      pending = null;
    });

    doc.addEventListener("visibilitychange", syncRunning);
    motionQuery?.addEventListener("change", (ev) => {
      reducedMotion = ev.matches;
    });

    els.note?.classList.toggle("is-debug", debug);

    new ResizeObserver(() => {
      stageW = Math.max(1, els.stage.clientWidth);
      stageH = Math.max(1, els.stage.clientHeight);
    }).observe(els.stage);
    stageW = Math.max(1, els.stage.clientWidth);
    stageH = Math.max(1, els.stage.clientHeight);
  }

  /**
   * 卓に着いているあいだは描画を止める。
   *
   * app.js は入室すると #entry に hidden クラスを付けて隠す（renderAll）。
   * その付け外しを見るだけなので、app.js 側に手を入れなくて済む
   * （rooms.js が一覧の取り直しに使っているのと同じ手口）。
   */
  function watchEntry() {
    if (els.entry === null) return;
    const inRoom = () => els.entry.classList.contains("hidden");
    setSuspended(inRoom(), "卓に着いているあいだは描画を止めています");
    new MutationObserver(() => {
      setSuspended(inRoom(), "卓に着いているあいだは描画を止めています");
    }).observe(els.entry, { attributes: true, attributeFilter: ["class"] });
  }

  async function main() {
    bindUi();
    watchEntry();
    if (page.poll) {
      await loadTagLabels();
    } else {
      subscribeRooms();
    }
    // 憶えていた側で開く。店内を憶えていても、WebGL が無ければ ensureView が一覧へ倒す
    setMode(remembered() ?? page.defaultMode);
    if (viewPromise !== null) await viewPromise;
    if (page.poll) {
      await refresh();
      setInterval(refresh, POLL_MS);
    }
  }

  const ready = main();

  return {
    ready,
    setRooms: (rooms, labels) => applyRooms(rooms, labels),
    setSuspended,
    setMode,
    get mode() {
      return mode;
    },
    get view() {
      return view;
    },
  };
}
