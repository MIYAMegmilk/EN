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
 *   - **マイクをミュートしているあいだは認識そのものを止める**（setMuted）。
 *     SpeechRecognition は getUserMedia とは別に自前でマイクを開くので、
 *     VC 側で track.enabled を落としても認識は動き続けてしまう。ミュートは
 *     「いまの声を誰にも渡さない」という意思表示なので、字幕にも bot にも
 *     渡してはいけない。止め方は abort()（stopSession）にする。stop() だと
 *     溜まっていた音声が確定結果として吐き出され、解除後にミュート中の
 *     発言がまとめて出てしまう
 *   - ブラウザの音声認識はエンジンによっては音声をブラウザベンダのサーバーへ
 *     送る。ON にする前に必ず本人へその旨を示すこと（UI 側の責務）
 *
 * サーバーとの契約（docs/design/bot-voice.md、types.ts への追加はちいかわ依頼中）:
 *   C2S: { t: "voice", text }        … 確定した認識結果1件（200文字以内）
 *   S2C: { t: "voice", line }        … ルーム内へ配信される文字起こし1行
 *
 * 表示規約（§3.8）: ユーザー由来のテキストは textContent で描画する。
 *
 * 受信側（同室の他人・自分の文字起こしの表示）:
 *   チーム合意（docs/design/bot-voice.md 決定事項）どおり、受信した確定行は
 *   字幕行に最新1〜2行だけ出す。chatHistory に積まない設計（サーバー側）に
 *   合わせ、チャット欄には混ぜない。captionEl（自分の未確定文専用）とは別の
 *   要素（init の linesEl）に描く。
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

  /**
   * 受信して表示する確定行の保持件数（字幕行に最新1〜2行、チーム合意）。
   * 古いものから捨てる。チャット欄には混ぜない（chatHistory に積まれないため）。
   */
  const MAX_RECEIVED_LINES = 2;

  /** 外から注入される設定 */
  const config = {
    /** サーバーへ送る関数（app 側から注入） */
    send: null,
    /** 状態を知らせる関数。(kind, message) => void */
    onStatus: null,
    /** 認識中の文（未確定）を出す要素。null なら表示しない */
    captionEl: null,
    /** 受信した確定行（他人・自分）を出す要素。null なら表示しない */
    linesEl: null,
    /** 認識言語。テストや将来の多言語化のために差し替え可能にしておく */
    lang: LANG,
  };

  const state = {
    /** 本人が ON にしているか（既定 OFF） */
    enabled: false,
    /**
     * VC 側でマイクをミュートしているか（vc.js の state.muted の写し）。
     * enabled とは別に持つ。ミュートは一時停止であって、本人が入れた
     * 「文字起こし ON」を取り消すものではない（解除したらそのまま再開する）。
     */
    micMuted: false,
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
    /** 受信した確定行（直近 MAX_RECEIVED_LINES 件・古い順。自分の発言も含む） */
    lines: [],
    /** 自分の playerId（受信行の自分/他人の見分け用。分からなければ null） */
    selfId: null,
  };

  // -------------------------------------------------------------------------
  // 小道具
  // -------------------------------------------------------------------------

  /**
   * いま認識を動かしてよいか。
   * 本人が ON にしていて、かつマイクがミュートされていないときだけ。
   * 開始・再開・送信のすべてがこの1か所を見る（見落としを作らないため）。
   */
  function listening() {
    return state.enabled && !state.micMuted;
  }

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

  /** 子要素をすべて取り除く（chat.js と同じ方式） */
  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /**
   * 受信した VoiceLine の形を確認する（docs/design/bot-voice.md §5.1）。
   * サーバーからの S2C だが、想定外の形が来たら描画せず黙って捨てる。
   */
  function isValidLine(line) {
    return (
      typeof line === "object" &&
      line !== null &&
      typeof line.id === "string" &&
      typeof line.playerId === "string" &&
      typeof line.nickname === "string" &&
      typeof line.text === "string" &&
      typeof line.at === "number"
    );
  }

  /**
   * 受信した確定行（直近 MAX_RECEIVED_LINES 件）を描き直す。
   * ニックネーム・本文はユーザー由来のため textContent のみで描画する（§3.8）。
   * 自分の発言は控えめな見分け用にクラスを付ける。
   */
  function renderLines() {
    const container = config.linesEl;
    if (container === null) return;
    clearChildren(container);
    for (const line of state.lines) {
      const item = document.createElement("li");
      item.className = "voice-line";
      if (state.selfId !== null && line.playerId === state.selfId) {
        item.classList.add("voice-line-self");
      }
      const nickname = document.createElement("span");
      nickname.className = "voice-line-nickname";
      nickname.textContent = line.nickname;
      item.appendChild(nickname);
      const text = document.createElement("span");
      text.className = "voice-line-text";
      text.textContent = line.text;
      item.appendChild(text);
      container.appendChild(item);
    }
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
    // ミュート中の確定結果は捨てる。セッションは止めてあるはずだが、
    // 止める直前に発火した onresult がここへ来ることがある
    if (!listening() || typeof config.send !== "function") return;
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
    // ミュートと入れ違いに届いた結果は字幕にも出さない
    if (!listening()) return;
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
    if (!listening()) return;
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
    if (!listening() || state.running) return;
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
    // 受信した確定行（他人・自分）を出す要素。渡さなければ従来どおり非表示（後方互換）
    config.linesEl = options.linesEl ?? null;
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
      // ミュート中は startSession が動かない。「開始しました」とだけ出すと
      // 何も拾わない理由が画面から分からないので、そのときは理由を出す
      notify(
        "voiceState",
        state.micMuted
          ? "文字起こしを ON にしました（ミュート中は止めています）"
          : "文字起こしを開始しました（自分の声のみ）",
      );
    } else {
      stopSession();
      notify("voiceState", "文字起こしを止めました");
    }
    return state.enabled;
  }

  /**
   * VC 側のマイクのミュート状態を受け取る（vc.js の init に渡した onMicMute から）。
   *
   * ここで認識セッションごと止めるのが要点。SpeechRecognition は VC の
   * getUserMedia とは別に自前でマイクを開くため、VC 側で track.enabled を
   * 落としても認識は動き続け、ミュートしたつもりの声が字幕にも bot にも
   * 流れてしまう（このモジュールに muted の参照が1つも無かった不具合）。
   *
   * 止め方は stopSession()＝abort()。stop() だと、それまでに溜まっていた音声が
   * 最後の確定結果として吐き出され、「ミュート中に喋った内容が解除後に
   * まとめて出る」ことになる。abort() は溜まっている結果ごと捨てる。
   *
   * 本人が入れた「文字起こし ON」（state.enabled）は倒さない。倒すと解除後に
   * もう一度ボタンを押させることになるうえ、ボタンの文言も勝手に変わる。
   *
   * 戻り値は反映後のミュート状態。
   */
  function setMuted(muted) {
    const next = muted === true;
    if (next === state.micMuted) return state.micMuted;
    state.micMuted = next;
    // OFF のあいだは触るものが無い。ON に戻したときに startSession が走らない
    // よう、state だけ書き換えて帰る
    if (!state.enabled) return state.micMuted;
    if (next) {
      stopSession();
      return state.micMuted;
    }
    // 解除。ミュート中に積み上がった失敗回数は持ち越さない（待ち時間が
    // 指数で伸びたまま再開すると、解除しても数秒間なにも拾わない）
    state.restartFailures = 0;
    // ミュートの前後で同じ文が確定しても落とさないよう、重複よけも戻す
    state.lastSentText = "";
    startSession();
    return state.micMuted;
  }

  /** ON / OFF を切り替える。戻り値は切り替え後の状態 */
  function toggle() {
    return setEnabled(!state.enabled);
  }

  /**
   * S2C メッセージを渡す。ルーム側の受信処理からそのまま流し込む。
   * 見るのは「もう喋る相手がいない」（kicked）と「同室の文字起こし1行」（voice）。
   */
  function handleServerMessage(msg) {
    if (typeof msg !== "object" || msg === null) return;
    if (msg.t === "kicked") {
      setEnabled(false);
      return;
    }
    if (msg.t === "voice") {
      // スキーマ検証してから使う。想定外の形は捨てる
      if (!isValidLine(msg.line)) return;
      state.lines.push(msg.line);
      if (state.lines.length > MAX_RECEIVED_LINES) {
        state.lines = state.lines.slice(-MAX_RECEIVED_LINES);
      }
      renderLines();
    }
  }

  /** 自分の playerId を設定する（受信行の自分/他人の見分け用。chat.js の setSelfId と同じ方式） */
  function setSelfId(playerId) {
    state.selfId = playerId;
    renderLines();
  }

  /** 退室時に状態を捨てる */
  function reset() {
    setEnabled(false);
    // ミュートは VC の状態。卓を離れたら持ち越さない（次に入った卓で
    // 「文字起こしが ON なのに何も拾わない」になるのを防ぐ）
    state.micMuted = false;
    state.sentTimes = [];
    state.lastSentText = "";
    state.stats = { sent: 0, dropped: 0 };
    state.lines = [];
    renderLines();
  }

  /** デバッグ・テスト用に内部状態を返す */
  function getState() {
    return {
      supported: isSupported(),
      enabled: state.enabled,
      /** VC のマイクがミュートされているか（ON のまま一時停止しているか） */
      muted: state.micMuted,
      /** 実際にいま認識を動かしてよい状態か（enabled かつミュートでない） */
      listening: listening(),
      running: state.running,
      interim: state.interim,
      sent: state.stats.sent,
      dropped: state.stats.dropped,
      lines: state.lines.slice(),
    };
  }

  global.Voice = {
    init,
    isSupported,
    setEnabled,
    setMuted,
    toggle,
    handleServerMessage,
    setSelfId,
    reset,
    getState,
    /** テスト用に公開する純粋関数 */
    sanitize,
  };
})(window);
