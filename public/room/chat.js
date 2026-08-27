/**
 * テキストチャット UI（§3.9）
 * 開発用動作確認ページ（index.html / app.js）に組み込むチャット表示・送信モジュール。
 * classic script として app.js より前に読み込み、グローバルに Chat だけを公開する
 * （vc.js が VC を公開するのと同じ方式）。
 *
 * 表示規約（§3.8 / CLAUDE.md セキュリティ基準）:
 * ユーザー由来のテキスト（ニックネーム・本文）は必ず textContent で描画し、innerHTML は使わない。
 *
 * サーバーとの契約:
 *   C2S: { t: "chat", text }
 *   S2C: { t: "chat", message: ChatMessage }
 *   roomState のスナップショットに chat: ChatMessage[]（直近100件・古い順）が入る。
 */

"use strict";

(function (global) {
  /** 1件の本文の上限（コードポイント数。サーバーと同じ値） */
  const MAX_TEXT_LENGTH = 200;
  /** クライアント側で保持する履歴の上限（サーバーと同じ値） */
  const MAX_MESSAGES = 100;
  /** 制御文字（C0・DEL）。含む本文は送らない（サーバーの hasControlChar と同じ基準） */
  const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

  /** init で注入される依存 */
  const deps = {
    send: null,
    listEl: null,
    inputEl: null,
    formEl: null,
    onError: null,
    /**
     * bot の付加情報（ChatMessage.card）を描く差し込み口。
     * (message, item) => void。何を出すか・誰が押せるかは呼び出し側が決める
     * （ホストかどうかを知っているのは app.js 側のため）。
     */
    renderCard: null,
  };

  /** 表示中の履歴（古い順） */
  let messages = [];
  /** 自分の playerId（roomState 受信時に app.js から渡される） */
  let selfId = null;

  /** テキストだけを持つ要素を作る（chat.js 単体で動くよう app.js とは別に持つ） */
  function el(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  /** 子要素をすべて取り除く */
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** epoch ms を HH:MM に整形する */
  function formatTime(at) {
    const date = new Date(at);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  /** 入力欄の本文を検証して送信する */
  function submit() {
    const text = deps.inputEl.value.trim();
    if (text.length === 0) return;
    if ([...text].length > MAX_TEXT_LENGTH) {
      deps.onError(`チャットは${MAX_TEXT_LENGTH}文字以内で入力してください`);
      return;
    }
    if (CONTROL_CHARS.test(text)) {
      deps.onError("チャットに制御文字は使えません");
      return;
    }
    // 送れたときだけ入力欄を空にする。app.js の send() は、WebSocket が
    // 繋がっていなければ「サーバーに接続していません」を出して false を返す。
    // そこで消してしまうと、切断・サーバー再起動の最中に打った長文がそのまま
    // 消える（打ち直しになる）。
    //
    // 見るのは「はっきり false だったか」だけにしておく。戻り値を返さない
    // send を渡す呼び出し側（テストの偽物など）では、これまでどおり消える
    if (deps.send({ t: "chat", text }) === false) return;
    deps.inputEl.value = "";
  }

  /** 履歴を描き直し、最下部までスクロールする */
  function render() {
    const list = deps.listEl;
    if (list === null) return;
    clear(list);
    for (const message of messages) {
      const item = el("li");
      if (message.bot) item.classList.add("chat-bot");
      if (selfId !== null && message.playerId === selfId) {
        item.classList.add("chat-self");
      }
      const time = el("span", formatTime(message.at));
      time.className = "chat-time";
      item.appendChild(time);
      if (message.bot) {
        const badge = el("span", "bot");
        badge.className = "chat-badge-bot";
        item.appendChild(badge);
      }
      const nickname = el("span", message.nickname);
      nickname.className = "chat-nickname";
      item.appendChild(nickname);
      const body = el("span", message.text);
      // 本文であることを class で示す。カードを後ろに足すと :last-child では
      // 拾えなくなるため（index.html の #chat-log .chat-text）
      body.className = "chat-text";
      item.appendChild(body);
      // bot のカード（川柳の句・ゲームの提案）はこの行の中に続けて描く
      if (message.card !== undefined && message.card !== null && deps.renderCard !== null) {
        deps.renderCard(message, item);
      }
      list.appendChild(item);
    }
    list.scrollTop = list.scrollHeight;
  }

  /** 依存を注入し、送信操作（ボタン / Enter / form submit）を配線する */
  function init(options) {
    deps.send = options.send;
    deps.listEl = options.listEl;
    deps.inputEl = options.inputEl;
    deps.formEl = options.formEl;
    deps.onError = options.onError;
    deps.renderCard = options.renderCard ?? null;

    // form submit（Enter の暗黙送信を含む）
    deps.formEl.addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });
    // 送信ボタン（type="button" のため form submit は起きない）
    const button = deps.formEl.querySelector("button");
    if (button !== null) button.addEventListener("click", submit);
    // Enter キー。IME の変換確定（isComposing）では送らない
    deps.inputEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      submit();
    });
  }

  /** S2C メッセージを処理する（roomState / chat 以外は無視） */
  function handleServerMessage(msg) {
    switch (msg.t) {
      case "roomState": {
        const history = msg.snapshot?.chat;
        messages = Array.isArray(history) ? history.slice(-MAX_MESSAGES) : [];
        render();
        break;
      }
      case "chat": {
        if (typeof msg.message !== "object" || msg.message === null) return;
        messages.push(msg.message);
        if (messages.length > MAX_MESSAGES) {
          messages = messages.slice(-MAX_MESSAGES);
        }
        render();
        break;
      }
      default:
        break;
    }
  }

  /** 自分の playerId を設定する（自分の発言の見分け用） */
  function setSelfId(playerId) {
    selfId = playerId;
  }

  /** 履歴を空にして描き直す（退室・キック時に使う） */
  function reset() {
    messages = [];
    render();
  }

  /** デバッグ・テスト用に内部状態を返す */
  function getState() {
    return { messages: messages.slice() };
  }

  global.Chat = { init, handleServerMessage, setSelfId, refresh: render, reset, getState };
})(window);
