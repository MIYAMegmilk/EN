/**
 * 公開ルーム一覧（§2 公開ルーム一覧 / §4.0 `GET /api/rooms`）
 *
 * ホーム（index.html）の「今夜、灯りのついている卓」を描画する。
 * WebSocket は使わず HTTP のポーリングだけで完結するため、app.js とは独立して動く。
 * 入店は #code に卓コードを入れて #join を押す形にし、WS 送信は app.js に任せる。
 *
 * 表示規約（§3.8 / CLAUDE.md セキュリティ基準）:
 * サーバー由来のテキスト（卓の名前・ゲーム名）は必ず textContent で描画し、innerHTML は使わない。
 */

"use strict";

(function (global) {
  /** 一覧の更新間隔（ミリ秒、§2: 10秒ポーリング） */
  const POLL_MS = 10_000;

  /** 取得のタイムアウト（ミリ秒） */
  const TIMEOUT_MS = 5_000;

  /** 依存する要素。init で解決する */
  const els = {
    entry: null,
    list: null,
    count: null,
    code: null,
    join: null,
    nickname: null,
    error: null,
  };

  /** ポーリングのタイマー */
  let timer = null;

  /** タグID → 表示名。GET /api/room-tags の結果から作る */
  let tagLabels = new Map();

  /** 要素を取得する */
  function $(id) {
    return document.getElementById(id);
  }

  /** 子要素をすべて取り除く */
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** テキストとクラスだけを持つ要素を作る */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className !== undefined && className !== null) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  /** epoch ms を HH:MM に整形する */
  function formatTime(at) {
    const date = new Date(at);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  /** 卓1件のカードを作る */
  function renderRoom(room) {
    const full = room.playerCount >= room.capacity;

    const card = el("article", "card room");

    const head = el("div", "room-head");
    head.appendChild(el("span", room.playing ? "dot" : "dot dot-off"));
    head.appendChild(el("span", "room-code", room.code));
    head.appendChild(el("span", "spacer"));
    head.appendChild(el("span", full ? "badge" : "badge badge-gold", full ? "満席" : "空きあり"));
    card.appendChild(head);

    card.appendChild(el("h2", null, room.roomName));

    if (typeof room.description === "string" && room.description.length > 0) {
      card.appendChild(el("p", "room-desc", room.description));
    }

    const meta = el("p", "room-meta");
    if (room.gameTitle === undefined) {
      meta.textContent = room.playing ? "遊んでいます" : "まだ何をするか決めていません";
    } else {
      meta.textContent = room.playing
        ? `${room.gameTitle} で遊んでいます`
        : `${room.gameTitle} を選んでいます`;
    }
    card.appendChild(meta);

    if (Array.isArray(room.tags) && room.tags.length > 0) {
      const tagsRow = el("div", "room-tags");
      for (const tagId of room.tags) {
        tagsRow.appendChild(el("span", "tag", tagLabels.get(tagId) ?? tagId));
      }
      card.appendChild(tagsRow);
    }

    const seats = el("div", "room-seats");
    seats.appendChild(el("span", "tabular", `${room.playerCount} / ${room.capacity} 名`));
    card.appendChild(seats);

    const foot = el("div", "room-foot");
    const enter = el("button", "btn btn-gold", "入店");
    enter.type = "button";
    enter.disabled = full;
    enter.addEventListener("click", () => enterRoom(room.code));
    foot.appendChild(enter);
    foot.appendChild(el("span", "room-since tabular", `${formatTime(room.createdAt)} から`));
    card.appendChild(foot);

    return card;
  }

  /**
   * 入店できない理由を出す。app.js の showError と同じ #error の枠を使う。
   * 読み込み順に依存しないよう、app.js の関数は呼ばず自分で書き込む。
   */
  function showEntryError(text) {
    if (els.error !== null) els.error.textContent = text;
  }

  /**
   * 一覧から入店する。
   * 参加コード欄を埋めて既存の入店ボタンを押すだけにして、WS の送信経路を1本に保つ。
   *
   * あだ名欄はページ上部にあり、一覧まで下がっていると画面外になる。
   * 黙って戻ると「押しても無反応」に見えるので、理由を出して入力欄まで運ぶ。
   */
  function enterRoom(code) {
    els.code.value = code;
    if (els.nickname.value.trim().length === 0) {
      showEntryError("入店するにはあだ名を入れてください");
      // focus() 自身のスクロールと scrollIntoView がぶつからないよう、スクロールは後で一度だけ行う
      els.nickname.focus({ preventScroll: true });
      // #error はあだ名欄のすぐ上にあるので、中央に寄せればエラー文も一緒に見える
      els.nickname.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    showEntryError("");
    els.join.click();
  }

  /** 取得結果を描画する */
  function render(rooms) {
    clear(els.list);
    els.count.textContent = rooms.length === 0
      ? "いまは灯りのついた卓がありません"
      : `${rooms.length}卓 ／ ${rooms.reduce((n, r) => n + r.playerCount, 0)}名が呑んでいます`;
    if (rooms.length === 0) {
      els.list.appendChild(
        el(
          "p",
          "rooms-empty",
          "最初の一卓を立ててみてください。卓を立てるにはログインが必要です。",
        ),
      );
      return;
    }
    for (const room of rooms) els.list.appendChild(renderRoom(room));
  }

  /** 取得に失敗したときの表示。前回の一覧は消さず、注記だけを出す */
  function renderError() {
    els.count.textContent = "一覧を取得できませんでした";
  }

  /** 一覧を取り直す。卓に入っている間（#entry が hidden）は何もしない */
  async function refresh() {
    if (els.entry.classList.contains("hidden")) return;
    try {
      const res = await fetch("/api/rooms", {
        credentials: "same-origin",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        renderError();
        return;
      }
      const body = await res.json();
      render(Array.isArray(body?.rooms) ? body.rooms : []);
    } catch {
      renderError();
    }
  }

  async function loadTagLabels() {
    try {
      const res = await fetch("/api/room-tags", { credentials: "same-origin" });
      if (!res.ok) return;
      const body = await res.json();
      const tags = Array.isArray(body?.tags) ? body.tags : [];
      tagLabels = new Map(tags.map((t) => [t.id, t.label]));
    } catch {
      // 読み込めなくても一覧自体は表示できるので無視する（タグはIDのまま出す）
    }
  }

  /** 要素を解決してポーリングを始める */
  function init() {
    els.entry = $("entry");
    els.list = $("rooms-list");
    els.count = $("rooms-count");
    els.code = $("code");
    els.join = $("join");
    els.nickname = $("nickname");
    els.error = $("error");
    if (els.entry === null || els.list === null) return;
    // 退室して一覧に戻ってきた瞬間に取り直す（次のポーリングまで古い一覧を見せない）。
    // app.js が #entry の hidden を外すのを監視するだけなので、app.js 側の変更は要らない
    let wasHidden = els.entry.classList.contains("hidden");
    new MutationObserver(() => {
      const hidden = els.entry.classList.contains("hidden");
      if (wasHidden && !hidden) refresh();
      wasHidden = hidden;
    }).observe(els.entry, { attributes: true, attributeFilter: ["class"] });
    loadTagLabels();
    refresh();
    timer = setInterval(refresh, POLL_MS);
  }

  /** ポーリングを止める（テスト・後始末用） */
  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  global.Rooms = { init, refresh, stop };

  init();
})(window);
