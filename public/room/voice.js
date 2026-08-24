/**
 * 通話の文字起こし（VC → テキスト）
 * 詳細仕様書 §3.6（VC）/ §3.9（チャット）/ §3.10（bot）にまたがる。ひろし担当。
 * 設計は docs/design/bot-voice.md。
 *
 * 何のためにあるか:
 *   呑み会の会話は VC で進む。チャットは静かなままなので、このままでは
 *   （1）せりが「声で詠まれた川柳」を拾えず、（2）ぐっちーが盛り上がっている
 *   部屋を沈黙と誤判定して話題カードやお開きの打診を投げてしまう。
 *   自分のマイクの内容をテキストにしてサーバーへ送り、bot の入力にする。
 *
 * 責務の境界:
 *   - このモジュールは「自分のマイクを認識して送る」だけを行う
 *   - 認識結果の配信・bot への受け渡しはサーバー（rooms.ts）の役目
 *   - **bot に喋らせることはしない**。せりの発話面はチャットのみ（§3.10）。
 *     音声合成（speechSynthesis）はこのファイルでも一切使わない
 *
 * プライバシー（§3.7 安全設計）:
 *   - 既定 OFF。本人の明示操作でのみ ON にする（カメラと同じ扱い）
 *   - 認識するのは自分のマイクだけ。他人の声を勝手に文字起こしはしない
 *   - ブラウザの音声認識はエンジンによっては音声をブラウザベンダのサーバーへ
 *     送る。ON にする前に必ず本人へその旨を示すこと（UI 側の責務）
 *
 * サーバーとの契約（docs/design/bot-voice.md、types.ts への追加はちいかわ依頼中）:
 *   C2S: { t: "voice", text }        … 確定した認識結果1件（200文字以内）
 *   S2C: { t: "voice", line }        … ルーム内へ配信される文字起こし1行
 *
 * 表示規約（§3.8）: ユーザー由来のテキストは textContent で描画する。
 */

"use strict";

(function (global) {
  /** 認識言語 */
  const LANG = "ja-JP";

  /** 1件の本文の上限（コードポイント数。チャットと同じ、§3.9） */
  const MAX_TEXT_LENGTH = 200;

  /**
   * 送る最小の長さ（コードポイント数）。
   * 「あ」「ん」だけの確定結果は環境音の誤認識であることが多く、
   * 拾っても川柳にならないうえ全員のチャット欄を汚す。
   */
  const MIN_TEXT_LENGTH = 2;

  /** 制御文字（C0・DEL）。サーバーの hasControlChar と同じ基準 */
  const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

  /**
   * 送信レートの自主規制（窓とその中の件数）。
   * サーバー側にも制限を置くが、超過して RATE_LIMITED を浴びるより
   * 手元で間引くほうが体験がよい。喋り続けても止まらない程度に緩くとる。
   */
  const RATE_WINDOW_MS = 10_000;
  const RATE_MAX = 10;

  /**
   * onend からの自動再開の待ち時間（ミリ秒）。
   * SpeechRecognition は continuous でも無音や内部エラーで勝手に終わる。
   * 失敗が続くときは待ち時間を伸ばし、再開ループが暴走しないようにする。
   */
  const RESTART_BASE_MS = 300;
  const RESTART_MAX_MS = 10_000;

  /** 連続で再開に失敗したらあきらめる回数 */
  const RESTART_MAX_FAILURES = 5;

  /** 外から注入される設定 */
  const config = {
    /** サーバーへ送る関数（app 側から注入） */
    send: null,
    /** 状態を知らせる関数。(kind, message) => void */
    onStatus: null,
    /** 認識中の文（未確定）を出す要素。null なら表示しない */
    captionEl: null,
    /** 認識言語。テストや将来の多言語化のために差し替え可能にしておく */
    lang: LANG,
  };

  const state = {
    /** 本人が ON にしているか（既定 OFF） */
    enabled: false,
    /** SpeechRecognition のインスタンス。OFF のあいだは null */
    recognition: null,
    /** 認識セッションが動いているか */
    running: false,
    /** 自動再開の setTimeout ハンドル */
    restartTimer: null,
    /** 連続再開失敗の回数 */
    restartFailures: 0,
    /** 直近に送った時刻（RATE_WINDOW_MS の窓で数える） */
    sentTimes: [],
    /** 直近に送った本文。同じ確定結果の二重送信を防ぐ */
    lastSentText: "",
    /** 未確定の認識結果（字幕表示用。サーバーへは送らない） */
    interim: "",
    /** 送った件数・間引いた件数（動作確認用） */
    stats: { sent: 0, dropped: 0 },
  };

  // -------------------------------------------------------------------------
  // 小道具
  // -------------------------------------------------------------------------

  /** 状態を外へ知らせる。UI の描画は呼び出し側の責務（vc.js の notify と同じ方式） */
  function notify(kind, message) {
    if (typeof config.onStatus === "function") {
      config.onStatus({ kind, message });
    }
  }

  /** このブラウザの SpeechRecognition コンストラクタ。無ければ null */
  function recognitionCtor() {
    return global.SpeechRecognition ?? global.webkitSpeechRecognition ?? null;
  }

  /** 文字起こしを使えるブラウザか（iOS Safari・Firefox では使えないことがある） */
  function isSupported() {
    return recognitionCtor() !== null;
  }

  /** コードポイント単位で数える（サーバーの charLength と同じ基準） */
  function charLength(text) {
    return [...text].length;
  }

  /** 字幕（未確定文）を描き直す */
  function renderCaption() {
    if (config.captionEl === null) return;
    config.captionEl.textContent = state.interim;
  }

  // -------------------------------------------------------------------------
  // 送信
  // -------------------------------------------------------------------------

  /**
   * 確定した認識結果を送れる形に整える。
   * 制御文字を落とし、長すぎるものは 200 文字ごとに割る（切り捨てない）。
   * 認識結果は句読点なしの一本の長い文になりやすく、末尾を捨てると
   * そこにあった 5-7-5 ごと消えてしまうため。
   */
  function sanitize(raw) {
    const text = String(raw).replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
    if (charLength(text) < MIN_TEXT_LENGTH) return [];
    const chars = [...text];
    if (chars.length <= MAX_TEXT_LENGTH) return [text];
    const chunks = [];
    for (let i = 0; i < chars.length; i += MAX_TEXT_LENGTH) {
      chunks.push(chars.slice(i, i + MAX_TEXT_LENGTH).join(""));
    }
    return chunks;
  }

  /** 自主規制の窓に空きがあるか。あれば送信時刻を1件積む */
  function takeRateSlot(now) {
    state.sentTimes = state.sentTimes.filter((at) => now - at < RATE_WINDOW_MS);
    if (state.sentTimes.length >= RATE_MAX) return false;
    state.sentTimes.push(now);
    return true;
  }

  /** 確定した認識結果を1件送る */
  function sendFinal(raw) {
    if (!state.enabled || typeof config.send !== "function") return;
    for (const text of sanitize(raw)) {
      // 同じ文が続けて確定することがある（エンジンが結果を出し直す）。1回だけ送る
      if (text === state.lastSentText) {
        state.stats.dropped++;
        continue;
      }
      if (!takeRateSlot(Date.now())) {
        state.stats.dropped++;
        continue;
      }
      state.lastSentText = text;
      state.stats.sent++;
      config.send({ t: "voice", text });
    }
  }

  // -------------------------------------------------------------------------
  // 認識セッション
  // -------------------------------------------------------------------------

  /** 認識イベントから確定分と未確定分を取り出す */
  function onResult(event) {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const alternative = result[0];
      if (alternative === undefined) continue;
      if (result.isFinal) {
        // 確定した＝認識は生きている。再開の失敗カウンタを戻す
        state.restartFailures = 0;
        sendFinal(alternative.transcript);
      } else {
        interim += alternative.transcript;
      }
    }
    state.interim = interim.trim();
    renderCaption();
  }

  /**
   * エラー処理。
   * 権限拒否だけは自動再開しても無駄なので OFF に倒す。
   * no-speech / aborted / network は呑み会中に日常的に起きるので黙って再開する。
   */
  function onError(event) {
    const code = event?.error ?? "unknown";
    if (code === "not-allowed" || code === "service-not-allowed") {
      notify("error", "マイクの利用が許可されていないため文字起こしを止めました");
      setEnabled(false);
      return;
    }
    if (code === "language-not-supported") {
      notify("error", "このブラウザは日本語の音声認識に対応していません");
      setEnabled(false);
      return;
    }
    if (code !== "no-speech" && code !== "aborted") {
      state.restartFailures++;
    }
  }

  /** セッションが終わったとき。ON のあいだは間隔を空けて張り直す */
  function onEnd() {
    state.running = false;
    state.interim = "";
    renderCaption();
    if (!state.enabled) return;
    if (state.restartFailures >= RESTART_MAX_FAILURES) {
      notify("error", "文字起こしを再開できませんでした。もう一度 ON にしてください");
      setEnabled(false);
      return;
    }
    const wait = Math.min(RESTART_BASE_MS * 2 ** state.restartFailures, RESTART_MAX_MS);
    state.restartTimer = global.setTimeout(() => {
      state.restartTimer = null;
      startSession();
    }, wait);
  }

  /** 認識セッションを開始する */
  function startSession() {
    if (!state.enabled || state.running) return;
    const Ctor = recognitionCtor();
    if (Ctor === null) return;
    const recognition = new Ctor();
    recognition.lang = config.lang;
    // 一発言ごとに止まらないようにする。呑み会は喋り続けるため
    recognition.continuous = true;
    // 未確定文は字幕にだけ使う。送るのは isFinal のものだけ
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = onResult;
    recognition.onerror = onError;
    recognition.onend = onEnd;
    state.recognition = recognition;
    try {
      recognition.start();
      state.running = true;
    } catch (e) {
      // すでに開始済みの場合などに投げる。再開は onend にまかせる
      console.error("Voice recognition start failed:", e);
      state.running = false;
      state.restartFailures++;
    }
  }

  /** 認識セッションを止める。onend での自動再開も打ち切る */
  function stopSession() {
    if (state.restartTimer !== null) {
      global.clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    const recognition = state.recognition;
    state.recognition = null;
    state.running = false;
    state.interim = "";
    renderCaption();
    if (recognition === null) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch (e) {
      console.error("Voice recognition abort failed:", e);
    }
  }

  // -------------------------------------------------------------------------
  // 公開 API
  // -------------------------------------------------------------------------

  /** 送信関数・表示先・状態通知を注入する（vc.js / chat.js と同じ init 方式） */
  function init(options) {
    config.send = options.send;
    config.onStatus = options.onStatus ?? null;
    config.captionEl = options.captionEl ?? null;
    if (typeof options.lang === "string" && options.lang.length > 0) {
      config.lang = options.lang;
    }
  }

  /**
   * 文字起こしの ON / OFF。既定 OFF・本人の明示操作でのみ ON（§3.7）。
   * 戻り値は切り替え後の状態。
   */
  function setEnabled(on) {
    const next = on === true;
    if (next === state.enabled) return state.enabled;
    if (next && !isSupported()) {
      notify("error", "このブラウザは文字起こしに対応していません");
      return false;
    }
    state.enabled = next;
    if (next) {
      state.restartFailures = 0;
      state.lastSentText = "";
      startSession();
      notify("voiceState", "文字起こしを開始しました（自分の声のみ）");
    } else {
      stopSession();
      notify("voiceState", "文字起こしを止めました");
    }
    return state.enabled;
  }

  /** ON / OFF を切り替える。戻り値は切り替え後の状態 */
  function toggle() {
    return setEnabled(!state.enabled);
  }

  /**
   * S2C メッセージを渡す。ルーム側の受信処理からそのまま流し込む。
   * 見るのは「もう喋る相手がいない」ことが分かるものだけ。
   */
  function handleServerMessage(msg) {
    if (typeof msg !== "object" || msg === null) return;
    if (msg.t === "kicked") setEnabled(false);
  }

  /** 退室時に状態を捨てる */
  function reset() {
    setEnabled(false);
    state.sentTimes = [];
    state.lastSentText = "";
    state.stats = { sent: 0, dropped: 0 };
  }

  /** デバッグ・テスト用に内部状態を返す */
  function getState() {
    return {
      supported: isSupported(),
      enabled: state.enabled,
      running: state.running,
      interim: state.interim,
      sent: state.stats.sent,
      dropped: state.stats.dropped,
    };
  }

  global.Voice = {
    init,
    isSupported,
    setEnabled,
    toggle,
    handleServerMessage,
    reset,
    getState,
    /** テスト用に公開する純粋関数 */
    sanitize,
  };
})(window);
