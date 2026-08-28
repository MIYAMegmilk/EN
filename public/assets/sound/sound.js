/**
 * 効果音・環境音の再生と音量調整（宴 -EN-）
 *
 * 素材は public/assets/sound/ 配下。出典と利用条件は同じ場所の CREDITS.md を参照。
 * classic script として読み込み側より前に読み込み、グローバルに Sound だけを公開する
 * （chat.js / bot.js が Chat / Bot を公開するのと同じ方式）。app.js が classic script
 * なので、ES module にすると読み込み順が後ろにずれて start() から呼べなくなる。
 *
 * 方針:
 *   - Web Audio を使う。<audio> だと「環境音だけ音量を絞る」「歩き出しで足音を
 *     滑らかに入れる」がやりにくい
 *   - 効果音（sfx）と環境音（ambience）でゲインを分ける。卓の中で絞るのは環境音だけで、
 *     ボタンの決定音まで小さくなっては困るため。利用者の音量つまみもこの2系統に分ける
 *   - 音が出ないことでページが壊れてはいけない。読み込みも再生も失敗は握りつぶし、
 *     無音のまま先へ進む。3D と違ってフォールバック表示は要らない
 *   - ブラウザの自動再生制限により、最初の操作があるまで音は出せない。待ち受けは
 *     このファイルの中で張るので、呼び出し側は気にしなくてよい
 *
 * 音量の決まり方（3段）:
 *   ① 素材ごとの既定値（GAYA_ROOM など）… 場面としてどう聞かせたいか
 *   ② 利用者のつまみ（sfx / ambience）  … このファイルが localStorage に覚える
 *   ③ タブが裏に回ったら環境音は 0     … 音の出どころが分からないタブは迷惑なので
 */

"use strict";

(function (global) {
  /** 素材の置き場。ディレクトリ名もファイル名も日本語なので URL 用に必ずエンコードする */
  const BASE = "/assets/sound";
  const src = (dir, file) => `${BASE}/${encodeURIComponent(dir)}/${encodeURIComponent(file)}`;

  const SOURCES = {
    /** 暖簾をくぐるときの衣ずれ */
    noren: src("効果音辞書", "clothes-rustling-1.mp3"),
    /** 廊下を歩いている間（ループ） */
    footsteps: src("効果音ラボ", "フローリングの上を歩く1.mp3"),
    /** 店内のざわめき（ループ） */
    gaya: src("ポケットサウンド", "izakayagaya.mp3"),
    /** 卓の戸を叩く */
    knock: src("効果音辞書", "knocking-three-times-on-wooden-door-1.mp3"),
    /** ふすまが開く */
    slidingScreen: src("効果音辞書", "opening-sliding-screen-1.mp3"),
    /** ボタンの決定音 */
    decide: src("効果音ラボ", "決定ボタンを押す50.mp3"),
    /** 誰かが卓に入ってきたときの呼び鈴 */
    arrival: src("効果音ラボ", "chime-1.mp3"),
  };

  /**
   * ざわめきの既定音量（上の①）。
   * 廊下では店の気配として聞かせ、卓の中では VC の会話に被らないところまで絞る。
   */
  const GAYA_CORRIDOR = 0.32;
  const GAYA_ROOM = 0.06;

  /** 足音の音量。歩いている間ずっと鳴るので控えめにする */
  const FOOTSTEPS_VOLUME = 0.5;

  /** ループの出入りにかける時間（秒）。ぶつ切りにするとクリックノイズが出る */
  const FADE_SEC = 0.35;

  /** つまみの保存先。版を付けてあるので、項目が増えても古い値で壊れない */
  const STORAGE_KEY = "en.sound.v1";
  const DEFAULTS = { muted: false, sfx: 0.8, ambience: 0.6 };

  let ctx = null;
  let masterGain = null;
  let sfxGain = null;
  let ambienceGain = null;

  /** key -> AudioBuffer。復号は一度だけ */
  const buffers = new Map();
  /** key -> Promise。同じ音の同時読み込みを1本にまとめる */
  const loading = new Map();
  /** key -> { source, gain, volume }。鳴っているループ。読み込み待ちの席取りは null */
  const loops = new Map();

  let settings = { ...DEFAULTS };
  let unlockArmed = false;
  let buttonsBound = false;
  let walking = false;
  let controls = null;

  // -------------------------------------------------------------------------
  // つまみの保存
  // -------------------------------------------------------------------------

  /** 0〜1 に収める。壊れた値・古い値が入っていても既定へ倒す */
  function clamp01(value, fallback) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1, Math.max(0, n));
  }

  /**
   * 覚えてあるつまみを読む。
   * プライベートウィンドウなど localStorage 自体が例外を投げる環境があるので、
   * 読み書きは必ず try で包む（読めなければ既定値で動かす）。
   */
  function loadSettings() {
    try {
      const raw = global.localStorage?.getItem(STORAGE_KEY);
      if (typeof raw !== "string") return;
      const saved = JSON.parse(raw);
      if (saved === null || typeof saved !== "object") return;
      settings = {
        muted: saved.muted === true,
        sfx: clamp01(saved.sfx, DEFAULTS.sfx),
        ambience: clamp01(saved.ambience, DEFAULTS.ambience),
      };
    } catch {
      // 読めない・壊れている。既定値のまま
    }
  }

  function saveSettings() {
    try {
      global.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // 保存できなくても、このセッションの間は効いている
    }
  }

  // -------------------------------------------------------------------------
  // 土台
  // -------------------------------------------------------------------------

  /**
   * AudioContext を用意する。非対応環境では null を返し、以降すべて無音で素通りする。
   * 生成自体は操作前でも許されるが、状態は suspended から始まる（unlock 参照）。
   */
  function ensureContext() {
    if (ctx !== null) return ctx;
    const Ctor = global.AudioContext ?? global.webkitAudioContext;
    if (Ctor === undefined) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
    masterGain = ctx.createGain();
    masterGain.connect(ctx.destination);
    sfxGain = ctx.createGain();
    sfxGain.connect(masterGain);
    ambienceGain = ctx.createGain();
    ambienceGain.connect(masterGain);
    applySettings(0);
    return ctx;
  }

  /** 目標値へ滑らかに動かす。いきなり変えるとクリックノイズが出る */
  function rampTo(param, value, sec) {
    const c = ctx;
    if (c === null) return;
    const now = c.currentTime;
    const seconds = sec ?? FADE_SEC;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    if (seconds <= 0) param.setValueAtTime(value, now);
    else param.linearRampToValueAtTime(value, now + seconds);
  }

  /**
   * いまのつまみを3つのゲインへ反映する。
   * ミュートは master で切る。個別のつまみの値はそのまま残るので、
   * ミュートを解除したときに元の音量へ戻る。
   */
  function applySettings(sec = 0.12) {
    if (ctx === null) return;
    rampTo(masterGain.gain, settings.muted ? 0 : 1, sec);
    rampTo(sfxGain.gain, settings.sfx, sec);
    rampTo(ambienceGain.gain, document.hidden ? 0 : settings.ambience, sec);
  }

  /**
   * 自動再生制限の解除。
   * すでに操作済みなら即座に resume され、まだなら次の操作を一度だけ待つ。
   * play / loop から自動で呼ぶので、呼び出し側から明示的に呼ぶ必要はない。
   */
  function unlock() {
    const c = ensureContext();
    if (c === null) return;
    if (c.state !== "suspended") return;
    c.resume().catch(() => {});
    if (unlockArmed) return;
    unlockArmed = true;
    const types = ["pointerdown", "keydown", "touchstart"];
    const onGesture = () => {
      c.resume().catch(() => {});
      if (c.state === "suspended") return;
      for (const type of types) global.removeEventListener(type, onGesture, true);
      unlockArmed = false;
    };
    for (const type of types) global.addEventListener(type, onGesture, true);
  }

  /** 素材を取って復号する。失敗しても投げず null を返す */
  function load(key) {
    const cached = buffers.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = loading.get(key);
    if (inflight !== undefined) return inflight;

    const url = SOURCES[key];
    const c = ensureContext();
    if (url === undefined || c === null) return Promise.resolve(null);

    const task = fetch(url, { credentials: "same-origin" })
      .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(String(res.status)))))
      .then((raw) => c.decodeAudioData(raw))
      .then((buffer) => {
        buffers.set(key, buffer);
        loading.delete(key);
        return buffer;
      })
      .catch(() => {
        // 素材が無い・壊れている・復号できない。無音のまま続ける
        loading.delete(key);
        return null;
      });
    loading.set(key, task);
    return task;
  }

  /**
   * 先に読み込んでおく。
   * 入室のノックのように鳴ってほしい瞬間が決まっている音は、その場で取りに行くと
   * 間に合わないことがあるので、画面を開いた時点で温めておく。
   */
  function preload() {
    for (const key of arguments) load(key);
  }

  // -------------------------------------------------------------------------
  // 単発
  // -------------------------------------------------------------------------

  /**
   * 一度だけ鳴らす。
   * 戻り値は音の長さ（秒）。鳴らせなかった場合は 0。
   */
  async function play(key, options) {
    unlock();
    const buffer = await load(key);
    const c = ctx;
    if (buffer === null || c === null) return 0;
    try {
      const source = c.createBufferSource();
      source.buffer = buffer;
      const gain = c.createGain();
      gain.gain.value = options?.volume ?? 1;
      source.connect(gain);
      gain.connect(sfxGain);
      source.start();
      return buffer.duration;
    } catch {
      return 0;
    }
  }

  /**
   * 順に鳴らす。前の音が鳴り終わってから次を始める。
   * 卓に入るときの「戸を叩く → ふすまが開く」のように、重ねると意味が壊れる組で使う。
   */
  async function sequence() {
    for (const key of arguments) {
      const seconds = await play(key);
      if (seconds <= 0) continue;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
  }

  // -------------------------------------------------------------------------
  // ループ
  // -------------------------------------------------------------------------

  /** 鳴らし続ける。すでに鳴っていれば音量だけ合わせる */
  async function loop(key, options) {
    const volume = options?.volume ?? 1;
    unlock();
    const running = loops.get(key);
    if (running !== undefined) {
      if (running !== null) {
        running.volume = volume;
        rampTo(running.gain.gain, volume);
      }
      return;
    }
    // 読み込みの最中に stop されても鳴り出さないよう、席だけ先に取っておく
    loops.set(key, null);
    const buffer = await load(key);
    const c = ctx;
    if (buffer === null || c === null) {
      loops.delete(key);
      return;
    }
    // 待っている間に stop されていたら（席が消えている）、ここで作った音は捨てる
    if (loops.get(key) !== null) return;
    try {
      const source = c.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = c.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(key === "gaya" ? ambienceGain : sfxGain);
      source.start();
      loops.set(key, { source, gain, volume });
      rampTo(gain.gain, volume);
    } catch {
      loops.delete(key);
    }
  }

  /** 止める。フェードしてから切るのでクリックノイズが出ない */
  function stop(key) {
    const running = loops.get(key);
    loops.delete(key);
    if (running === undefined || running === null) return;
    rampTo(running.gain.gain, 0);
    const source = running.source;
    setTimeout(() => {
      try {
        source.stop();
      } catch {
        // すでに止まっている
      }
    }, FADE_SEC * 1000 + 50);
  }

  /** 鳴っているループの音量だけ変える（卓に入ったらざわめきを絞る、など） */
  function setVolume(key, volume) {
    const running = loops.get(key);
    if (running === undefined || running === null) return;
    running.volume = volume;
    rampTo(running.gain.gain, volume);
  }

  /**
   * 歩いているかどうかを伝える。true の間だけ足音が鳴る。
   * 毎フレーム呼んでよい（変わったときだけ処理する）。
   */
  function setWalking(next) {
    const value = next === true;
    if (value === walking) return;
    walking = value;
    if (value) loop("footsteps", { volume: FOOTSTEPS_VOLUME });
    else stop("footsteps");
  }

  // -------------------------------------------------------------------------
  // 利用者のつまみ
  // -------------------------------------------------------------------------

  /** いまの設定を返す（表示・テスト用） */
  function getSettings() {
    return { ...settings };
  }

  /**
   * つまみを動かす。{ muted, sfx, ambience } のうち渡したものだけ変える。
   * 画面の部品からも、外から直接呼んでも同じところを通る。
   */
  function setSettings(next) {
    if (next === null || typeof next !== "object") return;
    if ("muted" in next) settings.muted = next.muted === true;
    if ("sfx" in next) settings.sfx = clamp01(next.sfx, settings.sfx);
    if ("ambience" in next) settings.ambience = clamp01(next.ambience, settings.ambience);
    ensureContext();
    applySettings();
    saveSettings();
    syncControls();
    return getSettings();
  }

  function toggleMuted() {
    return setSettings({ muted: !settings.muted });
  }

  // -------------------------------------------------------------------------
  // 画面との配線
  // -------------------------------------------------------------------------

  /**
   * ボタンの決定音。
   * 個々のボタンに足すと付け忘れるので document で一括して拾う。
   * capture 段で聞くのは、途中で stopPropagation する handler があっても鳴らすため。
   * 鳴らしたくないボタンには data-no-sound を付ける。
   */
  function bindButtons() {
    if (buttonsBound) return;
    buttonsBound = true;
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const el = target.closest("button, .btn");
      if (el === null || el.disabled === true) return;
      if (el.hasAttribute("data-no-sound")) return;
      play("decide");
    }, true);
  }

  const CONTROLS_CSS = `
.sound-controls {
  position: fixed;
  right: 14px;
  bottom: 14px;
  z-index: 30;
  font-family: var(--sans, system-ui, sans-serif);
}
.sound-controls__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 13px;
  border: 1px solid var(--line, #3d2c1c);
  border-radius: var(--r-pill, 999px);
  background: var(--panel, #241a11);
  color: var(--text, #ece0cf);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--shadow, 0 12px 32px rgba(0, 0, 0, 0.45));
}
.sound-controls__toggle:hover { border-color: var(--gold-3, #c8862a); }
.sound-controls__toggle:focus-visible { outline: 2px solid var(--gold, #e6a63f); outline-offset: 2px; }
.sound-controls__toggle[aria-expanded="true"] { border-color: var(--gold, #e6a63f); }
.sound-controls__panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  width: 208px;
  padding: 12px 14px 14px;
  border: 1px solid var(--line, #3d2c1c);
  border-radius: var(--r-md, 8px);
  background: var(--panel-2, #2b2016);
  box-shadow: var(--shadow, 0 12px 32px rgba(0, 0, 0, 0.45));
}
.sound-controls__panel[hidden] { display: none; }
.sound-controls__row { margin-top: 12px; }
.sound-controls__row:first-child { margin-top: 0; }
.sound-controls__label {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--muted, #a48d70);
  margin-bottom: 5px;
}
.sound-controls__slider { width: 100%; accent-color: var(--gold, #e6a63f); }
.sound-controls__mute {
  width: 100%;
  padding: 6px;
  border: 1px solid var(--line, #3d2c1c);
  border-radius: var(--r-sm, 4px);
  background: var(--panel-3, #33261a);
  color: var(--text, #ece0cf);
  font-size: 12px;
  cursor: pointer;
}
.sound-controls__mute[aria-pressed="true"] {
  border-color: var(--gold, #e6a63f);
  color: var(--gold-2, #f3c368);
}
.sound-controls__note { margin: 10px 0 0; font-size: 11px; color: var(--dim, #7b6750); }
`;

  function injectCss() {
    if (document.getElementById("sound-controls-css") !== null) return;
    const style = document.createElement("style");
    style.id = "sound-controls-css";
    style.textContent = CONTROLS_CSS;
    document.head.appendChild(style);
  }

  /** つまみ1本ぶん。ラベル・現在値・スライダーをまとめて作る */
  function buildSlider(labelText, key, onCommit) {
    const row = document.createElement("div");
    row.className = "sound-controls__row";

    const label = document.createElement("label");
    label.className = "sound-controls__label";
    const name = document.createElement("span");
    name.textContent = labelText;
    const value = document.createElement("span");
    label.append(name, value);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "sound-controls__slider";
    slider.min = "0";
    slider.max = "100";
    slider.step = "5";
    // label で包むと range のドラッグを label に取られる環境があるので、
    // 入れ子にせず htmlFor で繋ぐ
    slider.id = `sound-controls-${key}`;
    label.htmlFor = slider.id;

    slider.addEventListener("input", () => {
      setSettings({ [key]: Number(slider.value) / 100 });
    });
    if (onCommit !== undefined) slider.addEventListener("change", onCommit);

    row.append(label, slider);
    return { row, slider, value };
  }

  /** 表示をいまの設定に合わせる。設定が外から変わっても崩れないよう一箇所にまとめる */
  function syncControls() {
    if (controls === null) return;
    controls.sfx.slider.value = String(Math.round(settings.sfx * 100));
    controls.sfx.value.textContent = `${Math.round(settings.sfx * 100)}`;
    controls.ambience.slider.value = String(Math.round(settings.ambience * 100));
    controls.ambience.value.textContent = `${Math.round(settings.ambience * 100)}`;
    controls.mute.setAttribute("aria-pressed", settings.muted ? "true" : "false");
    controls.mute.textContent = settings.muted ? "音を戻す" : "音を消す";
    controls.toggleText.textContent = settings.muted ? "音（消音中）" : "音";
  }

  /**
   * 音量つまみを画面に出す。
   *
   * 部品は全部ここで組み立てて body に置く。各ページの HTML に手を入れずに済ませ、
   * どの画面でも同じ場所・同じ操作にするため（設定は localStorage 共有なので、
   * どこで変えても全ページに効く）。container を渡せばそこに差し込む。
   */
  function mountControls(container) {
    if (controls !== null) return;
    injectCss();

    const root = document.createElement("div");
    root.className = "sound-controls";

    const panel = document.createElement("div");
    panel.className = "sound-controls__panel";
    panel.hidden = true;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "sound-controls__toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "音の大きさを変える");
    // つまみ自体の操作で決定音は鳴らさない（消そうとして鳴るのは筋が悪い）
    toggle.setAttribute("data-no-sound", "");
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "🔊";
    const toggleText = document.createTextNode("音");
    toggle.append(icon, toggleText);

    // 効果音は動かした手を離したときに鳴らす。どのくらいの大きさかその場で分かる
    const sfx = buildSlider("効果音", "sfx", () => play("decide"));
    const ambience = buildSlider("店のざわめき", "ambience");

    const muteRow = document.createElement("div");
    muteRow.className = "sound-controls__row";
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "sound-controls__mute";
    mute.setAttribute("data-no-sound", "");
    mute.addEventListener("click", () => toggleMuted());
    muteRow.appendChild(mute);

    const note = document.createElement("p");
    note.className = "sound-controls__note";
    note.textContent = "通話中はざわめきを小さめに。設定はこの端末に残ります。";

    panel.append(sfx.row, ambience.row, muteRow, note);
    root.append(panel, toggle);

    const setOpen = (open) => {
      panel.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    };
    toggle.addEventListener("click", () => setOpen(panel.hidden));
    document.addEventListener("click", (event) => {
      if (panel.hidden) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || panel.hidden) return;
      setOpen(false);
      toggle.focus();
    });

    (container ?? document.body).appendChild(root);
    controls = { toggle, toggleText, panel, sfx, ambience, mute };
    syncControls();
  }

  /**
   * 裏に回ったタブでざわめきを鳴らし続けない。
   * 音の出どころが分からないタブは単純に迷惑なので。
   */
  document.addEventListener("visibilitychange", () => {
    if (ctx === null) return;
    rampTo(ambienceGain.gain, document.hidden ? 0 : settings.ambience, 0.25);
  });

  loadSettings();

  global.Sound = {
    unlock,
    preload,
    play,
    sequence,
    loop,
    stop,
    setVolume,
    setWalking,
    bindButtons,
    mountControls,
    getSettings,
    setSettings,
    toggleMuted,
    GAYA_CORRIDOR,
    GAYA_ROOM,
  };
})(window);
