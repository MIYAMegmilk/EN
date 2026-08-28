/**
 * bot の表示（しゅんぴ / せり / ぐっちー / なべ）
 * 詳細仕様書 §3.10 に対応する。ひろし担当。
 *
 * 責務:
 *   - 川柳テロップ・ゲーム提案カードの演出（ChatMessage.card、§4.3）
 *   - 終了アンケートの投票 UI（endPollVote）
 *   - bot ごとの ON/OFF トグル（setBot。ホストのみ）
 *
 * 責務でないもの:
 *   - bot の**発話そのもの**はチャット欄に出る（chat.js の仕事）。ここは演出面だけを持つ
 *   - **読み上げ（音声合成）はしない**。bot の発話はチャットのみ（§3.10 / 全体設計書 §3）
 *
 * 設計:
 *   chat.js / vc.js と同じく classic script として読み込み、グローバルに Bot だけを
 *   公開する。表示先の要素・送信関数は init で外から注入する。
 *   DOM は空のコンテナに自前で組み立てるので、呼び出し側が用意するのは
 *   `<div id="bot"></div>` 1つでよい。
 *
 * 表示規約（§3.8 / CLAUDE.md セキュリティ基準）:
 *   ユーザー由来のテキスト（あだ名・句の本文・ゲーム名）は必ず textContent で描画し、
 *   innerHTML は使わない。句はサーバー側で QUOTE_LINE_MAX に切り詰め済み。
 *
 * サーバーとの契約:
 *   C2S: { t: "setBot", botId?, enabled } / { t: "endPollVote", pollId, agree }
 *        { t: "selectGame", gameId }（ゲーム提案カードの「これで遊ぶ」）
 *   S2C: { t: "chat", message }（message.card を見る）
 *        { t: "botState", bots } / { t: "botPollClosed", pollId, agreed }
 *        roomState のスナップショットに bots・botPoll が入る
 */

"use strict";

(function (global) {
  // 表示名と役割はここには持たない。ON/OFF のボタンが卓上の bot 列へ移り、
  // 名前も役も app.js の BOT_VC_INFO が持つようになったため（二重管理を避ける）。
  // このモジュールが知っているのは state.bots の4つの ID だけでよい。

  /** 川柳の定型のモーラ数。表示のラベル（五七五 / 字余り）を出し分ける */
  const SENRYU_PATTERN = [5, 7, 5];

  /** アンケートの残り時間を描き直す間隔（ミリ秒） */
  const COUNTDOWN_INTERVAL_MS = 1000;

  /** 外から注入される設定 */
  const config = {
    /** サーバーへ送る関数 */
    send: null,
    /** 表示先（空の要素を1つ渡す） */
    container: null,
    /** エラー文言の表示 */
    onError: null,
  };

  const state = {
    /** 自分の playerId（roomState 受信時に呼び出し側から渡される） */
    selfId: null,
    /** bot ごとの ON/OFF */
    bots: { shunpi: true, seri: true, gucchi: true, nabe: true },
    /** 自分がホストか。トグルはホストのみ操作できる（§3.10） */
    isHost: false,
    /** 集計中のアンケート { pollId, deadline } */
    poll: null,
    /** 自分が投じた票。null なら未投票 */
    myVote: null,
    /** アンケートの残り時間を描き直すタイマー */
    countdown: null,
    /**
     * サーバー時刻との差（ミリ秒）。roomState の serverTime から求める。
     * 端末の時計がずれていると残り秒数がそのぶんずれるため、締切の判定は
     * 素の Date.now() ではなくこれを足した値で行う（ゲーム側の api.serverNow()
     * と同じ考え方）。
     */
    serverOffsetMs: 0,
    /** 組み立て済みの要素 */
    el: { poll: null },
  };

  // -------------------------------------------------------------------------
  // 小道具
  // -------------------------------------------------------------------------

  /** テキストだけを持つ要素を作る（chat.js と同じ方式） */
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className !== undefined) node.className = className;
    return node;
  }

  /** 子要素をすべて取り除く */
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** エラー文言を出す */
  function fail(message) {
    if (typeof config.onError === "function") config.onError(message);
  }

  /** サーバーへ送る */
  function send(msg) {
    if (typeof config.send === "function") config.send(msg);
  }

  // -------------------------------------------------------------------------
  // bot の ON / OFF（§3.10）
  // -------------------------------------------------------------------------

  /**
   * bot の ON / OFF を切り替える。
   *
   * ボタンそのものは卓上の bot 列（app.js の createBotVcTile）が持つ。
   * ここは「誰が押せるか」と「何を送るか」だけを受け持つ。
   * 楽観更新はしない。反映はサーバーの botState で返ってくる（§3.10）。
   */
  function toggle(botId) {
    if (!state.isHost) return false;
    if (!Object.prototype.hasOwnProperty.call(state.bots, botId)) return false;
    send({ t: "setBot", botId, enabled: state.bots[botId] === false });
    return true;
  }

  // -------------------------------------------------------------------------
  // 川柳の形（表示は chat.js の行の中・app.js の renderChatCard が描く）
  // -------------------------------------------------------------------------

  /** 字余り・字足らずの呼び名（サーバーの shapeLabel と同じ基準） */
  function shapeLabel(morae) {
    const over = morae.some((mora, i) => mora > SENRYU_PATTERN[i]);
    const under = morae.some((mora, i) => mora < SENRYU_PATTERN[i]);
    if (over && under) return "字余り字足らず";
    if (over) return "字余り";
    if (under) return "字足らず";
    return "五七五";
  }

  // -------------------------------------------------------------------------
  // 終了アンケート（§3.10）
  // -------------------------------------------------------------------------

  /** サーバー時刻に補正した現在時刻（epoch ms） */
  function serverNow() {
    return Date.now() + state.serverOffsetMs;
  }

  /** 残り秒数。締切を過ぎていたら 0 */
  function remainingSec(deadline) {
    return Math.max(0, Math.ceil((deadline - serverNow()) / 1000));
  }

  /** カウントダウンを止める（タイマーを残さない） */
  function stopCountdown() {
    if (state.countdown === null) return;
    global.clearInterval(state.countdown);
    state.countdown = null;
  }

  /** アンケートの表示を描き直す */
  function renderPoll() {
    const root = state.el.poll;
    if (root === null) return;
    clear(root);
    const poll = state.poll;
    if (poll === null) {
      stopCountdown();
      root.classList.add("hidden");
      return;
    }
    root.classList.remove("hidden");
    root.appendChild(el("p", "そろそろお開きにしますか？", "bot-poll-title"));

    const row = el("div", undefined, "bot-poll-actions");
    for (const choice of [{ agree: true, label: "お開き" }, { agree: false, label: "まだ続ける" }]) {
      const button = el("button", choice.label, "btn bot-poll-button");
      button.type = "button";
      const chosen = state.myVote === choice.agree;
      button.classList.toggle("bot-poll-chosen", chosen);
      button.setAttribute("aria-pressed", chosen ? "true" : "false");
      button.addEventListener("click", () => {
        // 投票し直せる。締切までは何度でも上書きできる（サーバーが最後の票を採る）
        state.myVote = choice.agree;
        send({ t: "endPollVote", pollId: poll.pollId, agree: choice.agree });
        renderPoll();
      });
      row.appendChild(button);
    }
    root.appendChild(row);
    root.appendChild(el("p", `残り ${remainingSec(poll.deadline)} 秒`, "bot-poll-remaining"));
  }

  /** アンケートを開く。締切までカウントダウンを回す */
  function openPoll(poll) {
    stopCountdown();
    state.poll = poll;
    state.myVote = null;
    renderPoll();
    state.countdown = global.setInterval(() => {
      if (state.poll === null || remainingSec(state.poll.deadline) <= 0) {
        // 締めるのはサーバー（botPollClosed）。こちらは表示を止めるだけ
        stopCountdown();
        renderPoll();
        return;
      }
      renderPoll();
    }, COUNTDOWN_INTERVAL_MS);
  }

  /**
   * アンケートを閉じ、結果を出す。
   * テロップ面は廃止した（川柳・提案はチャットの行に出る）ので、
   * 結果はアンケートの枠をそのまま使って出す。
   */
  function closePoll(agreed) {
    stopCountdown();
    state.poll = null;
    state.myVote = null;
    renderPoll();
    const root = state.el.poll;
    if (root === null) return;
    clear(root);
    root.classList.remove("hidden");
    root.appendChild(
      el("p", agreed ? "お開きに決まりました" : "まだ続けることになりました", "bot-poll-title"),
    );
  }

  // -------------------------------------------------------------------------
  // 受信
  // -------------------------------------------------------------------------

  /** bot の発話に付いてきたカードを処理する */
  function handleChatMessage(message) {
    if (typeof message !== "object" || message === null) return;
    if (message.bot !== true) return;
    const card = message.card;
    if (typeof card !== "object" || card === null) return;
    if (card.c === "endPoll") {
      openPoll({ pollId: card.pollId, deadline: card.deadline });
      return;
    }
    // 川柳・ゲーム提案はチャットの行の中に出る（app.js の renderChatCard）。
    // このモジュールが面倒を見るのはアンケートだけ。
  }

  /**
   * S2C メッセージを渡す。ルーム側の受信処理からそのまま流し込む。
   * 対象は roomState / chat / botState / botPollClosed / kicked。
   */
  function handleServerMessage(msg) {
    if (typeof msg !== "object" || msg === null) return;
    switch (msg.t) {
      case "roomState": {
        const snapshot = msg.snapshot;
        // 締切の残り秒数を端末の時計ずれに引きずられないようにする。
        // スナップショットは再接続でも届くので、そのたびに測り直す
        if (typeof snapshot.serverTime === "number") {
          state.serverOffsetMs = snapshot.serverTime - Date.now();
        }
        state.isHost = snapshot.youAreHost === true;
        if (typeof snapshot.bots === "object" && snapshot.bots !== null) {
          state.bots = { ...state.bots, ...snapshot.bots };
        }
        // 再接続・途中入室でも集計中のアンケートに参加できる（§3.2）
        if (typeof snapshot.botPoll === "object" && snapshot.botPoll !== null) {
          openPoll(snapshot.botPoll);
        } else {
          stopCountdown();
          state.poll = null;
          renderPoll();
        }
        // カードの復元は要らない。チャット履歴ごと chat.js が描き直す
        return;
      }
      case "chat":
        handleChatMessage(msg.message);
        return;
      case "botState":
        if (typeof msg.bots === "object" && msg.bots !== null) {
          state.bots = { ...state.bots, ...msg.bots };
        }
        return;
      case "botPollClosed":
        // 遅れて届いた別アンケートの結果は無視する
        if (state.poll !== null && state.poll.pollId !== msg.pollId) return;
        closePoll(msg.agreed === true);
        return;
      case "hostChanged":
        state.isHost = msg.playerId === state.selfId;
        return;
      case "kicked":
        reset();
        return;
      case "error":
        // bot 由来の拒否（投票の締切後など）は本人に伝える
        if (msg.code === "PHASE_MISMATCH" && state.poll !== null) fail(msg.message);
        return;
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // 公開 API
  // -------------------------------------------------------------------------

  /** 表示先・送信関数を注入し、コンテナに DOM を組み立てる */
  function init(options) {
    config.send = options.send;
    config.container = options.container ?? null;
    config.onError = options.onError ?? null;
    const root = config.container;
    if (root === null) return;
    clear(root);
    state.el.poll = el("div", undefined, "bot-poll hidden");
    state.el.poll.setAttribute("role", "status");
    root.appendChild(state.el.poll);
  }

  /** 自分の playerId を設定する（hostChanged の判定に使う） */
  function setSelfId(playerId) {
    state.selfId = playerId;
  }

  /** 退室・キック時に表示と状態を捨てる */
  function reset() {
    stopCountdown();
    state.poll = null;
    state.myVote = null;
    state.isHost = false;
    state.bots = { shunpi: true, seri: true, gucchi: true, nabe: true };
    renderPoll();
  }

  /** デバッグ・テスト用に内部状態を返す */
  function getState() {
    return {
      bots: { ...state.bots },
      isHost: state.isHost,
      poll: state.poll === null ? null : { ...state.poll },
      myVote: state.myVote,
    };
  }

  global.Bot = {
    init,
    handleServerMessage,
    setSelfId,
    reset,
    getState,
    toggle,
    /** テスト用に公開する純粋関数 */
    shapeLabel,
  };
})(window);
