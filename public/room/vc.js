/**
 * VC（音声）・カメラモジュール
 * 詳細仕様書 §3.6 / §3.8 / §8 に対応する。
 *
 * 責務:
 *   - ルーム内の VC 対象者（vcEligible）とのフルメッシュ P2P 接続
 *   - MDN の Perfect Negotiation パターンによるオファー衝突の解消
 *   - マイクのミュート、カメラの ON/OFF（初期 OFF・§3.6）
 *   - 画面共有の開始／停止（docs/design/vc-screenshare.md）
 *
 * 画面共有の不変条件（vc-screenshare.md §4.1）:
 *   **送出する映像トラックは常に高々1本**。カメラと画面は排他で、共有中は
 *   自分のカメラ映像は送出されない（フルメッシュではエンコードが
 *   PeerConnection ごとに独立しており、両方送ると負荷が倍になるため）。
 *   ここを崩すと、受信側の video 要素がどちらを描くかブラウザ任せになる。
 *
 * 設計:
 *   部屋ページ（room.html）と開発用ページの双方から使えるよう、
 *   送信関数・表示先の要素・状態通知を外から注入する（init）。
 *   サーバーとの契約は types.ts の rtcSignal（payload: unknown）のみで、
 *   payload の中身はこのファイル内で完結する（下記 payload 契約）。
 *
 * 表示規約（§3.8）: ユーザー由来のテキストは textContent で描画する。
 */

"use strict";

(function (global) {
  /**
   * rtcSignal payload の契約（vc.js 同士でのみ解釈する）
   *   { kind: "ready",   session }              … VC 参加中の告知。session は接続世代の識別子
   *   { kind: "bye" }                           … VC 離脱の告知
   *   { kind: "desc",    description }          … offer / answer（RTCSessionDescription）
   *   { kind: "ice",     candidate }            … ICE candidate（null は収集完了）
   *   { kind: "video",   on, source, surface }  … 自分の映像送出の ON / OFF
   *
   * video の source / surface は画面共有で足した拡張（vc-screenshare.md §4.3）。
   *   source  … "camera" | "screen"。省略時は "camera" とみなす。
   *             on の意味は変えていないので、source を知らない古いクライアントと
   *             混ざっても表示の出し入れは従来どおり動く
   *   surface … "monitor" | "window" | "browser" | null。共有者が
   *             track.getSettings().displaySurface で事後確認した自己申告値。
   *             受信側では表示にしか使わない（信頼して制御に使ってはいけない）
   * サーバーは payload を解釈せずそのまま転送するので、ここに相乗りする限り
   * server/types.ts / server/rooms.ts の契約は変えなくてよい（§4.3）。
   */

  /**
   * ICE サーバー設定。現状は公開 STUN のみ（§3.6）。
   * TURN（coturn）導入後は、サーバーが .env から読んだ認証情報を
   * roomState 等で配り、setIceServers() で差し替える想定。
   * 認証情報はクライアント配布物に埋め込まない（§3.8）。
   */
  const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

  // -------------------------------------------------------------------------
  // 品質監視のしきい値（§3.6「品質劣化時は映像を自動停止し音声優先」）
  //
  // 値の根拠について:
  //   外部の根拠を持つのは RTT のしきい値だけである。ITU-T G.114 は片道遅延
  //   150ms 以下を「ほぼすべての用途で透過的」、400ms 超を「多くの用途で
  //   許容不可」としており、これを往復に換算して 0.3 秒（片道 150ms）を回復側、
  //   0.8 秒（片道 400ms）を停止側に採った。
  //   それ以外はすべて【暫定値】である。仕様書に定めがあるわけではなく、
  //   実測（実機・§9 のボットテスト）で見直す前提の初期値でしかない。
  // -------------------------------------------------------------------------

  /** 統計を取る間隔（ミリ秒）【暫定値】 */
  const QUALITY_SAMPLE_INTERVAL_MS = 2000;
  /** 1ピアあたり保持するサンプル数。約 10 秒ぶんの観測窓になる【暫定値】 */
  const QUALITY_WINDOW_SIZE = 5;
  /** 観測窓のうち何サンプルが該当したら「劣化している」と見なすか【暫定値】 */
  const QUALITY_STOP_HITS = 3;
  /** 自動停止のあと、この時間は回復通知を出さない（ミリ秒）【暫定値】 */
  const QUALITY_MIN_HOLD_MS = 60000;
  /** ピア生成から、この時間が経つまでは判定に使わない（ミリ秒）【暫定値】 */
  const QUALITY_PEER_WARMUP_MS = 10000;
  /**
   * カメラ ON から、この時間が経つまでは判定に使わない（ミリ秒）【暫定値】。
   * 当初 5000 だったが、実測（Chrome 151 / headless / fake camera）で、
   * 送信開始から十数秒は帯域推定が立ち上がりきらず、回線が健全でも
   * qualityLimitationReason が "bandwidth" のままになることを確認した
   * （qualityLimitationDurations.bandwidth の積み上がりで 2 回計測し
   * 9.8 秒 / 18.1 秒。availableOutgoingBitrate が数百 kbps から数 Mbps に
   * 上がり、解像度が 320 → 640 に戻った時点で "none" へ遷移する）。
   * 5 秒ではカメラ ON のたびに必ず誤検知するため、ばらつきを見込んで
   * 30 秒に引き上げてある。ただしこの値で足りる保証は無く、
   * 立ち上がり中の "bandwidth" を時間だけで避けるのは本質的に脆い。
   * 恒久対策は sampleCause() の「主判定の bandwidth に裏付けを要求する」
   * 側に入れてあり、この 30 秒は多層防御として残している【暫定値】。
   */
  const QUALITY_CAMERA_WARMUP_MS = 30000;
  /** 1回の VC 参加中に自動停止してよい回数の上限【暫定値】 */
  const QUALITY_MAX_AUTO_STOPS = 2;
  /** RTT がこの秒数を超えたら劣化（ITU-T G.114 の片道 400ms を往復換算） */
  const QUALITY_RTT_STOP_SEC = 0.8;
  /** RTT がこの秒数以下なら回復（ITU-T G.114 の片道 150ms を往復換算） */
  const QUALITY_RTT_RESUME_SEC = 0.3;
  /** 送出可能帯域（bps）がこれを下回ったら劣化【暫定値】 */
  const QUALITY_BITRATE_STOP_BPS = 320000;
  /** 送出可能帯域（bps）がこれ以上なら回復【暫定値】 */
  const QUALITY_BITRATE_RESUME_BPS = 800000;
  /** 実効送信 FPS が要求値のこの比率を下回ったら劣化【暫定値】 */
  const QUALITY_FPS_STOP_RATIO = 0.5;
  /** 実効送信 FPS が要求値のこの比率以上なら回復【暫定値】 */
  const QUALITY_FPS_RESUME_RATIO = 0.75;
  /**
   * 画面共有中、framesEncoded が1フレームも増えないまま何サンプル続いたら
   * 「エンコードが成立していない」と見なすか（vc-screenshare.md §8.4）【暫定値】。
   */
  const SCREEN_STALL_SAMPLES = 3;

  // -------------------------------------------------------------------------
  // 画面共有の送出プロファイル（vc-screenshare.md §6.2 / §6.3）
  //
  // メッシュではエンコーダも輻輳制御も PeerConnection ごとに独立しているため、
  // ここで決めた1本ぶんの数字が、そのままピアの数だけ上りと CPU に乗る
  // （6人なら5本＝標準案で 3.5 Mbps・720p30 換算 1.67 倍）。
  // 単体通話の感覚で上げてはいけない。
  // -------------------------------------------------------------------------

  /**
   * 送出プロファイル。
   *   text   … 既定。資料・コードを読ませる用途。1280×720 は「拡大表示があれば
   *            1920px 幅の 14px 文字が 9.3px で読める」ことから決めた値で、
   *            拡大表示（§7）と一組で意味を持つ
   *   motion … 動画・ゲーム画面用。text のままだと解像度を守るために fps が
   *            捨てられて紙芝居になる
   *   light  … TURN リレー時と、品質劣化1回目の降格先（§6.6 / §8.2）
   */
  const SCREEN_PROFILES = {
    text: { width: 1280, height: 720, frameRate: 10, maxBitrate: 700000, contentHint: "text" },
    motion: { width: 1280, height: 720, frameRate: 24, maxBitrate: 1200000, contentHint: "motion" },
    light: { width: 640, height: 360, frameRate: 5, maxBitrate: 250000, contentHint: "text" },
  };

  /** 利用者に出す「内容の種類」の既定（§10。前回値は覚えない） */
  const SCREEN_DEFAULT_KIND = "text";

  /**
   * カメラの取り込み制約。ON にするときと、画面共有をやめて戻すときの
   * 両方から使うので1か所にまとめてある（取り直しで画質が変わらないように）。
   */
  const CAMERA_CONSTRAINTS = {
    audio: false,
    video: { width: { ideal: 640 }, height: { ideal: 360 } },
  };

  /** 外から注入される設定 */
  const config = {
    send: null,
    container: null,
    onStatus: null,
    /**
     * 拡大表示（vc-screenshare.md §7）の開閉を頼む口。
     * 覆いそのものは app.js が持つ。タイルは vc.js が作って消すので、
     * 要素の持ち主を跨がないよう「開けてほしい／閉じてほしい」だけを渡す。
     *   引数 { playerId, nickname, stream } … 開く
     *   引数 null                            … 閉じる（共有が止まったとき）
     */
    onZoom: null,
    /**
     * getStats の注入口。既定は RTCPeerConnection.getStats() をそのまま呼ぶ。
     * テストから統計を差し替えられるようにするためだけに存在する。
     */
    getStats: (pc) => pc.getStats(),
  };

  /** モジュール内の状態 */
  const state = {
    /** 自分の playerId（roomState.youId から取る） */
    selfId: null,
    /** playerId → { nickname, vcEligible, connected } */
    players: new Map(),
    /** VC に参加中か */
    active: false,
    /**
     * join() がマイクの応答を待っている最中か（多重参加よけ）。
     * state.active は getUserMedia の**後**にしか立たないので、許可ダイアログを
     * 出しているあいだ（数秒〜数十秒）は active だけでは門にならない。
     * その窓に別の roomState が届くとマイクを二重に掴んでしまう。
     */
    joining: false,
    /**
     * join() の世代。VC を畳むたびに進める。
     * 許可ダイアログを見ているあいだに退室・切断された join を、
     * await から戻った時点で見分けて掴んだマイクを捨てるために持つ。
     */
    joinGen: 0,
    /** 自分の接続世代。join のたびに新しくする */
    session: null,
    /** マイクの MediaStream */
    micStream: null,
    /** カメラの MediaStream */
    camStream: null,
    /**
     * カメラ取得の進行中管理。画面共有の screen.starting / screen.gen と同じ方式。
     * getUserMedia は許可ダイアログや他アプリとの取り合いで待たされ得るので、
     * 「待っているあいだに割り込まれたか」を await の後で必ず見分ける。
     * 見分けないと掴んだストリームが参照を失い、二度と stop() されない
     * （＝カメラのランプが点いたまま消えない）。
     */
    camera: {
      /** getUserMedia の応答待ちか（連打よけ） */
      starting: false,
      /** 取得処理の世代。カメラを手放すたびに進める */
      gen: 0,
    },
    /**
     * 画面共有の MediaStream。null でなければ「共有中」。
     * カメラと同時に持つことはある（共有中もカメラは切らない）が、
     * 送出されるのは常に画面のほうだけ（§4.1 の不変条件）。
     */
    screenStream: null,
    /** 画面共有の状態。共有していないあいだも既定値のまま残す */
    screen: {
      /** 利用者が選んだ内容の種類。"text" | "motion"（§10） */
      kind: SCREEN_DEFAULT_KIND,
      /** いま当てているプロファイル名。"text" | "motion" | "light" */
      profile: SCREEN_DEFAULT_KIND,
      /** track.getSettings().displaySurface の事後確認値（§9-1） */
      surface: null,
      /** getDisplayMedia の応答待ちか（開始の連打よけ・§9-4） */
      starting: false,
      /**
       * 開始処理の世代。開始は getDisplayMedia の選択待ちで数十秒かかり得るので、
       * その最中に停止・競合が割り込んだことを await の後で見分けるために持つ。
       * 共有を手放すたびに進める。
       */
      gen: 0,
      /** TURN リレーを検知したか（§6.6）。検知したら軽い案へ落とす */
      relay: false,
      /**
       * 共有をやめたときにカメラへ戻すか（オーナー判断）。
       * 共有中はカメラを実際に止めるので、「戻す約束」だけをここに残す。
       * 共有中のカメラ操作（setCamera）は、この約束の入り切りとして働く。
       */
      cameraWasOn: false,
      /** 品質劣化で軽い案へ降格したか（§8.2 の一段目） */
      demoted: false,
      /** 降格した時刻（Date.now()）。最小保持時間を測る */
      demotedAt: null,
    },
    /** ミュート中か */
    muted: false,
    /** playerId → ピア情報 */
    peers: new Map(),
    /** ICE サーバー設定 */
    iceServers: DEFAULT_ICE_SERVERS,
    /** 自分のカメラ映像を出す要素 */
    localVideo: null,
    /**
     * 送信側の品質監視（§3.6）。受信側の統計は使わず、
     * 「自分の送出が劣化しているか」だけを見て自分のカメラを止める。
     */
    quality: {
      /** setInterval のハンドル。カメラ ON 中と自動停止中だけ動く */
      timer: null,
      /** sampleQuality() の多重実行よけ */
      sampling: false,
      /** playerId → 前回の生サンプル（累積カウンタの差分を取るため） */
      prev: new Map(),
      /** playerId → 直近 QUALITY_WINDOW_SIZE 件の判定用サンプル */
      window: new Map(),
      /** 品質劣化で映像を自動停止した状態か */
      autoStopped: false,
      /** 自動停止の理由。"bandwidth" | "cpu" | null */
      reason: null,
      /** 自動停止した時刻（Date.now()） */
      stoppedAt: null,
      /** この VC 参加中に自動停止した回数 */
      autoStopCount: 0,
      /**
       * 映像の送出を始めた時刻（ウォームアップ判定用）。
       * カメラ⇔画面の切り替えでもエンコーダと帯域推定は立ち上げ直しになるので、
       * 映像ソースが変わるたびに打ち直す（vc-screenshare.md §8.3 / T9）。
       */
      videoOnAt: null,
      /** 映像の送出開始時の要求 FPS。実効 FPS の比率を出す分母になる */
      requestedFps: null,
      /** 回復を通知済みか（同じ回復で何度も通知しないための掛け金） */
      recovered: false,
      /** 判定方式。"primary" | "fallback" | "unknown" */
      mode: "unknown",
      /** 直近の判定で劣化していたピアの数 */
      degradedPeerCount: 0,
    },
  };

  // -------------------------------------------------------------------------
  // 通知・小道具
  // -------------------------------------------------------------------------

  /** 状態を外へ知らせる。UI の描画は呼び出し側の責務 */
  function notify(kind, message) {
    if (typeof config.onStatus !== "function") return;
    try {
      config.onStatus({ kind, message });
    } catch (e) {
      console.error("VC onStatus failed:", e);
    }
  }

  /** サーバーへ rtcSignal を送る */
  function signal(to, payload) {
    if (typeof config.send !== "function") return;
    config.send({ t: "rtcSignal", to, payload });
  }

  /** ランダムな識別子（接続世代の判定にのみ使う） */
  function randomId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return String(Date.now()) + Math.random().toString(16).slice(2);
  }

  /** 自分以外で VC 枠に入っている接続中の参加者ID */
  function eligiblePeerIds() {
    const ids = [];
    for (const [id, player] of state.players) {
      if (id === state.selfId) continue;
      if (player.vcEligible && player.connected) ids.push(id);
    }
    return ids;
  }

  /** 自分が VC 枠に入っているか */
  function selfEligible() {
    const me = state.selfId === null ? undefined : state.players.get(state.selfId);
    return me !== undefined && me.vcEligible;
  }

  /** 表示名（未知の相手は playerId の先頭を使う） */
  function nicknameOf(playerId) {
    const player = state.players.get(playerId);
    if (player !== undefined) return player.nickname;
    return playerId.slice(0, 8);
  }

  // -------------------------------------------------------------------------
  // 映像ソース（§4.1 の不変条件「送出する映像トラックは常に高々1本」）
  // -------------------------------------------------------------------------

  /** いま送出している映像の出どころ。"none" | "camera" | "screen" */
  function currentVideoSource() {
    if (state.screenStream !== null) return "screen";
    if (state.camStream !== null) return "camera";
    return "none";
  }

  /** 送出する映像の MediaStream。画面共有が優先（§4.1） */
  function activeVideoStream() {
    if (state.screenStream !== null) return state.screenStream;
    return state.camStream;
  }

  /** 送出する映像トラック。無ければ null */
  function activeVideoTrack() {
    const stream = activeVideoStream();
    if (stream === null) return null;
    const track = stream.getVideoTracks()[0];
    return track === undefined ? null : track;
  }

  /** 画面共有を始められる端末か。UA 文字列は見ない（§2） */
  function screenShareSupported() {
    const devices = global.navigator === undefined ? undefined : global.navigator.mediaDevices;
    return devices !== undefined && devices !== null &&
      typeof devices.getDisplayMedia === "function";
  }

  /**
   * 送出中のローカルトラック（マイク＋映像1本）。
   * 映像はカメラ固定ではなく activeVideoTrack() を返す。ここを直さないと、
   * 共有中に入ってきたピアにだけ画面が載らない（§5 T3）。
   */
  function localTracks() {
    const tracks = [];
    if (state.micStream !== null) tracks.push(...state.micStream.getAudioTracks());
    const video = activeVideoTrack();
    if (video !== null) tracks.push(video);
    return tracks;
  }

  // -------------------------------------------------------------------------
  // 表示（参加者ごとの audio / video）
  // -------------------------------------------------------------------------

  /** ピアの表示枠を作る */
  function createPeerView(playerId) {
    const root = document.createElement("div");
    root.className = "vc-peer";
    root.dataset.playerId = playerId;

    const label = document.createElement("p");
    label.className = "vc-peer-label";
    label.textContent = nicknameOf(playerId);

    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    // 音声は audio 要素で鳴らすため、映像側は必ずミュートする（二重再生の防止）
    video.muted = true;
    video.className = "vc-video";
    video.hidden = true;

    // 共有中の札と拡大の口（§9-3 / §7）。共有していないあいだは隠しておく
    const share = createShareBadge("画面を共有中", () => requestZoom(playerId));
    share.zoom.setAttribute("aria-label", `${nicknameOf(playerId)} さんの共有画面を拡大表示`);

    root.appendChild(label);
    root.appendChild(video);
    root.appendChild(share.root);
    root.appendChild(audio);
    if (config.container !== null) config.container.appendChild(root);
    return { root, label, audio, video, share };
  }

  /**
   * 「画面を共有中」の札を作る（§9-3）。
   * 文言は固定文字列で、ニックネームを混ぜるときも textContent で入れる（§3.8）。
   * onZoom を渡すと「拡大」の押し口が付く。拡大表示が無いとタイルの中では
   * 文字が読めない（§7.1）ので、この押し口は飾りではなく機能の一部である。
   */
  function createShareBadge(text, onZoom) {
    const root = document.createElement("div");
    root.className = "vc-share-badge";
    root.hidden = true;

    const caption = document.createElement("span");
    caption.className = "vc-share-text";
    caption.textContent = text;
    root.appendChild(caption);

    const zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "vc-share-zoom";
    zoom.textContent = "拡大";
    zoom.addEventListener("click", onZoom);
    root.appendChild(zoom);

    return { root, caption, zoom };
  }

  /** 自動再生が拒否された場合に備えて再生を試みる（iOS Safari 対策） */
  function tryPlay(element) {
    const played = element.play();
    if (played !== undefined && typeof played.catch === "function") {
      played.catch(() => {
        notify("error", "音声の自動再生がブロックされました。画面をタップしてください");
      });
    }
  }

  /**
   * 自分の枠の表示を更新する。
   *
   * VC に入っていれば、カメラが切でも枠を出す。入店した時点で VC に参加する
   * 作りなので、枠が出ないと「自分は卓に着いているのか」が画面から分からない
   * （以前はカメラを入れたときにしか枠が生えなかった）。
   * 映像が無いあいだは video を隠し、下敷き（.vc-peer::before の黒地に斜線）を
   * 見せる。
   */
  function renderLocalVideo() {
    if (config.container === null) return;
    if (!state.active) {
      if (state.localVideo !== null) {
        state.localVideo.root.remove();
        state.localVideo = null;
      }
      return;
    }
    if (state.localVideo === null) {
      const root = document.createElement("div");
      root.className = "vc-peer vc-self";
      const label = document.createElement("p");
      label.className = "vc-peer-label";
      label.textContent = "あなた";
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      // 自分の映像はハウリング防止のため必ずミュートする
      video.muted = true;
      video.className = "vc-video";
      video.hidden = true;
      // 共有中は顔が出ない（§4.1）ので、不具合と誤解されないよう札で断る（§9-3）
      const share = createShareBadge("画面を共有中（カメラは停止中）", () => {
        if (state.selfId !== null) requestZoom(state.selfId);
      });
      share.root.classList.add("vc-share-self");
      share.zoom.setAttribute("aria-label", "自分が共有している画面を拡大表示");
      // 止めるのは常に1手で済ませる（§9-1）。共有中ずっと目に入る位置に置く
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "vc-share-stop";
      stop.textContent = "共有をやめる";
      stop.addEventListener("click", () => {
        stopScreenShare({ message: "画面共有を止めました" });
      });
      share.root.appendChild(stop);
      root.appendChild(label);
      root.appendChild(video);
      root.appendChild(share.root);
      config.container.appendChild(root);
      state.localVideo = { root, video, share };
    }
    const video = state.localVideo.video;
    // 送出しているものを、そのまま自分にも見せる。共有中に「いま外に出ている
    // もの」が自分の画面から消えると、事故に気づけなくなる（§9-1）
    const stream = activeVideoStream();
    const sharing = currentVideoSource() === "screen";
    state.localVideo.share.root.hidden = !sharing;
    state.localVideo.root.classList.toggle("vc-peer-sharing", sharing);
    video.classList.toggle("vc-video-screen", sharing);
    if (stream === null) {
      video.hidden = true;
      video.srcObject = null;
      return;
    }
    video.hidden = false;
    video.srcObject = stream;
    tryPlay(video);
  }

  /**
   * 相手のタイルの共有表示を更新する（§7.3 / §9-3）。
   * 画面は端が切れると読みたい部分（ツールバー・行頭）が消えるので、
   * 共有中のタイルだけ object-fit を contain に切り替える。
   */
  function updatePeerShareView(peer) {
    const sharing = peer.remoteVideoSource === "screen";
    peer.view.share.root.hidden = !sharing;
    peer.view.root.classList.toggle("vc-peer-sharing", sharing);
    peer.view.video.classList.toggle("vc-video-screen", sharing);
    peer.view.share.zoom.setAttribute(
      "aria-label",
      `${nicknameOf(peer.id)} さんの共有画面を拡大表示`,
    );
  }

  /**
   * 拡大表示を頼む（§7.2）。覆いは app.js が持っているので、
   * ここでは「誰の・どのストリームを」だけを渡す。
   * 同じ MediaStream を2つの video に張るのは通常の使い方で、
   * デコードは1回・描画が2回になるだけ（追加の受信帯域はゼロ）。
   */
  function requestZoom(playerId) {
    if (typeof config.onZoom !== "function") return;
    const stream = playerId === state.selfId ? activeVideoStream() : peerShareStream(playerId);
    if (stream === null) return;
    try {
      config.onZoom({
        playerId,
        nickname: playerId === state.selfId ? "あなた" : nicknameOf(playerId),
        stream,
      });
    } catch (e) {
      console.error("VC onZoom failed:", e);
    }
  }

  /** 共有中のピアの受信ストリーム。共有していなければ null */
  function peerShareStream(playerId) {
    const peer = state.peers.get(playerId);
    if (peer === undefined || peer.remoteVideoSource !== "screen") return null;
    return peer.stream;
  }

  /** 拡大表示を閉じてもらう。共有が止まったら黒い枠だけを残さない（§7.2） */
  function closeZoom(playerId) {
    if (typeof config.onZoom !== "function") return;
    try {
      config.onZoom(null, playerId);
    } catch (e) {
      console.error("VC onZoom failed:", e);
    }
  }

  // -------------------------------------------------------------------------
  // ピア接続（Perfect Negotiation）
  // -------------------------------------------------------------------------

  /**
   * ピア接続を作る。
   * polite / impolite は playerId の辞書順で決める（両者が必ず逆の役になる）。
   */
  function createPeer(playerId, remoteSession) {
    const pc = new global.RTCPeerConnection({ iceServers: state.iceServers });
    const peer = {
      id: playerId,
      pc,
      polite: state.selfId > playerId,
      remoteSession: remoteSession,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      closed: false,
      stream: new MediaStream(),
      view: createPeerView(playerId),
      /** ピアを作った時刻。品質監視のウォームアップ判定に使う（§3.6） */
      createdAt: Date.now(),
      /**
       * 自分のカメラ映像を送っている sender。
       * 一度作った sender は使い回し、映像の付け外しは replaceTrack で行う
       * （removeTrack / addTrack は再ネゴシエーションを伴うため）。
       */
      videoSender: null,
      /** 直近の判定でこのピア向けの送出が劣化していたか */
      degraded: false,
      /** 相手が映像の送出を止めていると申告しているか（kind: "video"） */
      remoteVideoOff: false,
      /**
       * 相手が送っている映像の出どころ。"camera" | "screen" | null（送出なし）。
       * 届いたトラックがカメラか画面かは受信側では判別できないので、
       * 相手の告知（§4.3）だけが根拠になる。表示にしか使わない。
       */
      remoteVideoSource: null,
      /** 相手が自己申告した displaySurface。表示にしか使わない（§4.3） */
      remoteSurface: null,
      /**
       * 画面共有中に framesEncoded が増えなかった連続サンプル数（§8.4）。
       * ハードウェアエンコーダの枯渇を、通知経路に依存せず統計から拾うため。
       */
      stallCount: 0,
    };
    state.peers.set(playerId, peer);
    peer.view.audio.srcObject = peer.stream;

    for (const track of localTracks()) {
      // 映像に紐づける MediaStream は「いま送出しているほう」。camStream 固定だと
      // 共有中に null を渡してしまう（§5 T4）
      const sender = pc.addTrack(
        track,
        track.kind === "video" ? activeVideoStream() : state.micStream,
      );
      if (track.kind === "video") {
        peer.videoSender = sender;
        applyEncodingProfile(sender, profileFor(currentVideoSource()));
      }
    }

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        // 待っている間に畳まれた接続の情報は送らない
        if (!peer.closed) signal(playerId, { kind: "desc", description: pc.localDescription });
      } catch (e) {
        console.error("VC negotiation failed:", e);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = (event) => {
      if (peer.closed) return;
      signal(playerId, { kind: "ice", candidate: event.candidate });
    };

    pc.ontrack = (event) => {
      peer.stream.addTrack(event.track);
      if (event.track.kind === "video") {
        attachRemoteVideo(peer, event.track);
      } else {
        // srcObject は付け直す（トラック追加後の再設定が必要なブラウザがあるため）
        peer.view.audio.srcObject = peer.stream;
        tryPlay(peer.view.audio);
      }
      event.track.addEventListener("ended", () => {
        peer.stream.removeTrack(event.track);
        if (event.track.kind === "video") updateVideoVisibility(peer);
      });
    };

    pc.onconnectionstatechange = () => {
      notify("peerState", `${nicknameOf(playerId)}: ${pc.connectionState}`);
      if (pc.connectionState === "failed") {
        // 経路が切れた場合は ICE を張り直す（衝突は Perfect Negotiation が解消する）
        try {
          pc.restartIce();
        } catch (e) {
          console.error("VC restartIce failed:", e);
        }
      }
    };

    return peer;
  }

  /** 相手のカメラ映像を表示に反映する */
  function attachRemoteVideo(peer, track) {
    peer.view.video.srcObject = peer.stream;
    track.addEventListener("mute", () => updateVideoVisibility(peer));
    track.addEventListener("unmute", () => updateVideoVisibility(peer));
    updateVideoVisibility(peer);
  }

  /** 生きている映像トラックがあるときだけ video を表示する */
  function updateVideoVisibility(peer) {
    const live = !peer.remoteVideoOff &&
      peer.stream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);
    peer.view.video.hidden = !live;
    if (live) tryPlay(peer.view.video);
  }

  /** ピアがあれば返し、無ければ作る */
  function ensurePeer(playerId, remoteSession) {
    const existing = state.peers.get(playerId);
    if (existing !== undefined) {
      if (remoteSession !== null && existing.remoteSession === null) {
        existing.remoteSession = remoteSession;
      }
      return existing;
    }
    return createPeer(playerId, remoteSession);
  }

  /** ピアを閉じて表示も片付ける */
  function closePeer(playerId) {
    const peer = state.peers.get(playerId);
    if (peer === undefined) return;
    state.peers.delete(playerId);
    // 品質監視の作業領域も一緒に捨てる（閉じたピアのぶんが溜まらないように）
    state.quality.prev.delete(playerId);
    state.quality.window.delete(playerId);
    peer.closed = true;
    peer.videoSender = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    try {
      peer.pc.close();
    } catch (e) {
      console.error("VC close failed:", e);
    }
    peer.view.audio.srcObject = null;
    peer.view.video.srcObject = null;
    peer.view.root.remove();
    // 共有者が切断・キックされたら拡大表示も畳む。共有権はピアの状態から
    // 導いているので（§4.4）、ここでピアが消えた時点で自動的に解ける
    if (peer.remoteVideoSource === "screen") closeZoom(playerId);
  }

  /** すべてのピアを閉じる */
  function closeAllPeers() {
    for (const id of [...state.peers.keys()]) closePeer(id);
  }

  // -------------------------------------------------------------------------
  // シグナリングの受信
  // -------------------------------------------------------------------------

  /** rtcSignal を処理する。宛先の検証はサーバー側で済んでいる（§3.8） */
  function onSignal(from, payload) {
    if (typeof from !== "string" || from === state.selfId) return;
    if (typeof payload !== "object" || payload === null) return;
    if (!state.active) return;
    switch (payload.kind) {
      case "ready":
        onReady(from, typeof payload.session === "string" ? payload.session : null);
        return;
      case "bye":
        closePeer(from);
        return;
      case "desc":
        onDescription(from, payload.description);
        return;
      case "ice":
        onCandidate(from, payload.candidate);
        return;
      case "video":
        onVideoState(from, payload);
        return;
      default:
        return;
    }
  }

  /**
   * 相手の VC 参加告知。
   * 未知の相手・相手が入り直した（session が変わった）場合はピアを張り直し、
   * こちらの参加も返す。同じ session に対しては返さないので往復は有限で止まる。
   */
  function onReady(from, session) {
    const existing = state.peers.get(from);
    if (existing !== undefined) {
      if (existing.remoteSession === session) return;
      if (existing.remoteSession === null) {
        existing.remoteSession = session;
        return;
      }
      closePeer(from);
    }
    signal(from, { kind: "ready", session: state.session });
    ensurePeer(from, session);
    // ready → video の順に届く（WS は1接続を共用し、中継は順に send する）。
    // 受け手は ready でピアを同期的に作ってから戻るので取りこぼさない（§4.3）
    announceVideoStateTo(from);
  }

  /** offer / answer の処理（MDN Perfect Negotiation） */
  async function onDescription(from, description) {
    if (typeof description !== "object" || description === null) return;
    // ready を取りこぼした場合の保険。VC 枠外と分かっている相手だけは除く
    // （枠の判定はサーバーが済ませている。§3.8）
    const player = state.players.get(from);
    if (player !== undefined && !player.vcEligible) return;
    const peer = ensurePeer(from, null);
    const pc = peer.pc;
    try {
      const readyForOffer = !peer.makingOffer &&
        (pc.signalingState === "stable" || peer.settingRemoteAnswer);
      const offerCollision = description.type === "offer" && !readyForOffer;
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;
      peer.settingRemoteAnswer = description.type === "answer";
      await pc.setRemoteDescription(description);
      peer.settingRemoteAnswer = false;
      if (description.type === "offer") {
        await pc.setLocalDescription();
        // 待っている間に畳まれた接続の情報は送らない
        if (!peer.closed) signal(from, { kind: "desc", description: pc.localDescription });
      }
    } catch (e) {
      peer.settingRemoteAnswer = false;
      console.error("VC setRemoteDescription failed:", e);
    }
  }

  /**
   * 相手の映像送出の ON / OFF。
   * replaceTrack(null) は相手側のトラックを終了させず mute にもしないため
   * （Chrome 151 で実測。最後のフレームが固まったまま残り続ける）、
   * 止めたことを明示的に伝えて表示を畳む。伝わらなくても音声には影響しない。
   */
  function onVideoState(from, payload) {
    const peer = state.peers.get(from);
    if (peer === undefined) return;
    const on = payload.on === true;
    const wasSharing = peer.remoteVideoSource === "screen";
    peer.remoteVideoOff = !on;
    // source を知らない古いクライアントからの告知は "camera" とみなす（§4.3）
    peer.remoteVideoSource = on ? (payload.source === "screen" ? "screen" : "camera") : null;
    peer.remoteSurface = on && typeof payload.surface === "string" ? payload.surface : null;
    updateVideoVisibility(peer);
    updatePeerShareView(peer);
    const sharing = peer.remoteVideoSource === "screen";
    if (sharing !== wasSharing) {
      // 共有の開始・停止はログに残す。誰が何を共有していたかを後から追えるように
      notify(
        "vcState",
        sharing
          ? `${nicknameOf(from)} さんが画面共有を始めました`
          : `${nicknameOf(from)} さんが画面共有を止めました`,
      );
      if (!sharing) closeZoom(from);
      // 告知が行き違って2人が同時に共有した場合は、ここで1人に収束させる
      if (sharing) resolveShareConflict();
    }
  }

  /**
   * 自分の映像送出の状態を組み立てる（§4.3）。
   * 引数は取らず、必ず現在の state から導く。「送ったつもり」と実際の送出が
   * 食い違うと、相手のタイルの見た目だけが取り残されるため。
   */
  function videoStatePayload() {
    const source = currentVideoSource();
    return {
      kind: "video",
      on: source !== "none",
      // 送出していないときも source は "camera" にしておく（既定値と同じ扱い）
      source: source === "screen" ? "screen" : "camera",
      surface: source === "screen" ? state.screen.surface : null,
    };
  }

  /** 自分の映像送出の状態を全ピアへ伝える */
  function announceVideoState() {
    const payload = videoStatePayload();
    for (const id of state.peers.keys()) signal(id, payload);
  }

  /**
   * ピアを作った／受け入れた直後に、そのピアだけへ現在の映像状態を送る（§4.3）。
   * これが無いと「自分が映像を出した後で入ってきた相手」に source が飛ばず、
   * その人のタイルだけ object-fit も札も間違ったままになる。
   */
  function announceVideoStateTo(playerId) {
    signal(playerId, videoStatePayload());
  }

  /** 画面を共有していると告知しているピアの playerId */
  function sharingPeerIds() {
    const ids = [];
    for (const [id, peer] of state.peers) {
      if (peer.remoteVideoSource === "screen") ids.push(id);
    }
    return ids;
  }

  /**
   * 同時共有の競合を解く。★純粋関数★（§4.4）
   *
   * 告知が行き違う窓（片道 RTT ぶん）で2人が同時に開始し得る。
   * playerId の辞書順で小さい方が共有権を持つ、という規則を両者が同じように
   * 適用すれば必ず1人に収束する。時刻（Date.now()）は端末間で比較できない
   * ので使わない（両者の判定が食い違い、どちらも止まる／どちらも残る）。
   *
   * @param {string|null} selfId 自分の playerId
   * @param {string[]} peerIds 画面を共有していると分かっている相手の playerId
   * @returns {string|null} 共有権を持つ playerId
   */
  function resolveShareOwner(selfId, peerIds) {
    let owner = typeof selfId === "string" ? selfId : null;
    for (const id of peerIds) {
      if (typeof id !== "string") continue;
      if (owner === null || id < owner) owner = id;
    }
    return owner;
  }

  /** 自分が共有権を失っていたら、自分の共有だけを畳む（§4.4） */
  function resolveShareConflict() {
    if (state.screenStream === null) return;
    const rivals = sharingPeerIds();
    if (rivals.length === 0) return;
    const owner = resolveShareOwner(state.selfId, rivals);
    if (owner === state.selfId) return;
    // 負けた側には必ず理由を出す。黙って消えると不具合にしか見えない
    stopScreenShare({
      message: `${nicknameOf(owner)} さんの共有と重なったため、画面共有を止めました`,
    });
  }

  /** ICE candidate の処理。衝突で捨てたオファー由来の失敗は無視する */
  async function onCandidate(from, candidate) {
    const peer = state.peers.get(from);
    if (peer === undefined) return;
    try {
      await peer.pc.addIceCandidate(candidate === null ? undefined : candidate);
    } catch (e) {
      if (!peer.ignoreOffer) console.error("VC addIceCandidate failed:", e);
    }
  }

  // -------------------------------------------------------------------------
  // 参加者の追従
  // -------------------------------------------------------------------------

  /** RoomSnapshot.players を取り込む */
  function syncPlayers(players) {
    state.players.clear();
    for (const player of players) {
      state.players.set(player.id, {
        nickname: player.nickname,
        vcEligible: player.vcEligible === true,
        connected: player.connected === true,
      });
    }
  }

  /** 参加者1人分を取り込む */
  function upsertPlayer(player) {
    state.players.set(player.id, {
      nickname: player.nickname,
      vcEligible: player.vcEligible === true,
      connected: player.connected === true,
    });
    const peer = state.peers.get(player.id);
    if (peer !== undefined) {
      peer.view.label.textContent = player.nickname;
      // 拡大ボタンの読み上げ名も一緒に直す（古い名前が読まれないように）
      updatePeerShareView(peer);
    }
  }

  /** VC 参加中であることを対象者全員へ告知する */
  function announceReady() {
    for (const id of eligiblePeerIds()) {
      signal(id, { kind: "ready", session: state.session });
    }
  }

  /** 再接続時などにピアをすべて張り直す（§8 VC 行: 再ネゴシエーション） */
  function restartPeers() {
    closeAllPeers();
    state.session = randomId();
    announceReady();
  }

  // -------------------------------------------------------------------------
  // 映像トラックの差し替えと送出パラメータ（vc-screenshare.md §4.2 / §6.4）
  // -------------------------------------------------------------------------

  /**
   * 1ピアぶんの映像を差し替える。track は null 可（送出をやめる）。
   *
   * sender が既にあれば replaceTrack で済み、再ネゴシエーションは要らない。
   * 無い場合（カメラを一度も ON にしていないピア）は addTrack になり、
   * onnegotiationneeded から offer / answer が1往復する。これは既存の
   * カメラ ON とまったく同じ経路で、衝突は Perfect Negotiation が解消する。
   *
   * 例外は握りつぶす。1本の失敗で他のピアの差し替えまで止めないため（E7）。
   */
  async function applyVideoTrack(peer, track) {
    if (peer.closed) return;
    if (peer.videoSender !== null) {
      try {
        await peer.videoSender.replaceTrack(track);
      } catch (e) {
        console.error("VC replaceTrack failed:", e);
      }
    } else if (track !== null) {
      try {
        peer.videoSender = peer.pc.addTrack(track, activeVideoStream());
      } catch (e) {
        console.error("VC addTrack failed:", e);
        return;
      }
    }
    await applyEncodingProfile(peer.videoSender, profileFor(currentVideoSource()));
  }

  /** 全ピアの映像を差し替える。1本が失敗しても残りは進める（E7） */
  async function applyVideoTrackAll(track) {
    const peers = [...state.peers.values()];
    await Promise.all(peers.map((peer) => applyVideoTrack(peer, track)));
  }

  /**
   * sender 1個に送出パラメータを当てる（§6.4）。
   *
   * **必ず sender ごとに呼ぶ。** メッシュでは輻輳制御（BWE）も
   * PeerConnection ごとに独立しているので、まとめて1回では片側しか効かない。
   *
   * profile が null（カメラ）のときは、画面共有で入れた上限を外して
   * degradationPreference も戻す。カメラは逆に、解像度を捨ててでも
   * 滑らかさを守るほうが目的に合う。
   */
  async function applyEncodingProfile(sender, profile) {
    if (sender === null || sender === undefined) return;
    if (typeof sender.getParameters !== "function") return;
    try {
      const params = sender.getParameters();
      if (!Array.isArray(params.encodings) || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      if (profile === null) {
        // 画面共有で入れた上限と方針を「外す」。カメラ側に別の値を積極的に
        // 指定はしない（この機能の前はカメラで setParameters を呼んでおらず、
        // ブラウザの既定に任せていた。その挙動を変えないため）
        delete params.encodings[0].maxBitrate;
        delete params.encodings[0].maxFramerate;
        delete params.degradationPreference;
      } else {
        params.encodings[0].maxBitrate = profile.maxBitrate;
        params.encodings[0].maxFramerate = profile.frameRate;
        // encodings の外側に置く（W3C 仕様）。Firefox は contentHint に
        // 非対応なので、ここで明示して挙動を揃える
        params.degradationPreference = "maintain-resolution";
      }
      await sender.setParameters(params);
    } catch (e) {
      console.error("VC setParameters failed:", e);
    }
  }

  /** 映像ソースに対応する送出プロファイル。カメラ・停止中は null */
  function profileFor(source) {
    if (source !== "screen") return null;
    const profile = SCREEN_PROFILES[state.screen.profile];
    return profile === undefined ? SCREEN_PROFILES[SCREEN_DEFAULT_KIND] : profile;
  }

  /**
   * 実際に使うプロファイル名を決める。★純粋関数★（§6.6）
   *
   * TURN リレーは in と out の両方が VPS を通るので、標準案だと共有者1人で
   * VPS に 7 Mbps 乗る。ボトルネックは VPS という共有資源なので、
   * 1本でも relay があれば共有者単位で軽い案へ落とす。
   *
   * @param {{ requested:string, relay:boolean }} options
   * @returns {"text"|"motion"|"light"}
   */
  function pickProfile(options) {
    if (options.relay === true) return "light";
    const requested = options.requested;
    return requested === "motion" ? "motion" : "text";
  }

  /**
   * getDisplayMedia に渡す制約を組み立てる。★純粋関数★（§6.4）
   *
   * **ideal / max しか入れてはいけない。** min / exact / advanced を渡すと
   * TypeError で落ちる（W3C 仕様）。上限を保証したいので max を使う。
   * 制約は「利用者が画面を選んだ後」にしか効かず、Chromium の既定は
   * 2880×1800 / 最大 120fps なので、ここで絞らないとそれを掴む。
   */
  function displayConstraints(profile) {
    return {
      video: {
        width: { max: profile.width },
        height: { max: profile.height },
        frameRate: { max: profile.frameRate },
      },
      // 共有音声はスコープ外（§6.5）。Chrome / Edge しか対応しておらず、
      // フルメッシュのミキシング・エコー対策が別途要る
      audio: false,
      // EN のタブ自身を共有すると無限の入れ子になるうえ、その部屋の
      // チャットや参加者名がそのまま外へ出る（Chrome 112+。他では無視される）
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      systemAudio: "exclude",
    };
  }

  // -------------------------------------------------------------------------
  // 品質監視（§3.6 品質劣化時は映像を自動停止し音声優先）
  //
  // 方針:
  //   - 判定は「送信側」だけで行う。受信側の統計は使わない。
  //     見るのは自分の送出であり、止めるのも自分のカメラである。
  //   - 主判定は outbound-rtp(video) の qualityLimitationReason。取得できない
  //     ブラウザ（Safari 17.3 以下など）では実効 FPS ＋ RTT / 送出可能帯域の
  //     フォールバック判定に落ちる。どちらを使っているかは実行時に判定する
  //     （仕様書や対応表を信じてハードコードしない）。
  //   - 統計の多くは累積カウンタなので、必ず前回サンプルとの差分で見る。
  //   - 自動復帰は行わない。§3.6 は「カメラは全ルームで初期 OFF、本人の明示
  //     操作でのみ ON」と定めており、自動で戻すのは規定違反になる。回復した
  //     ときは通知を出すだけで、映像を戻すかどうかは本人が決める。
  // -------------------------------------------------------------------------

  /** 統計を1ピアぶん読む。失敗しても監視全体は止めない */
  async function readStats(peer) {
    try {
      return await config.getStats(peer.pc);
    } catch (e) {
      console.error("VC getStats failed:", e);
      return null;
    }
  }

  /** RTCStatsReport から使う値だけを抜き出す（判定はしない） */
  function extractRawStats(report, now) {
    const raw = {
      at: now,
      framesEncoded: null,
      statsTs: null,
      limitationReason: null,
      rtt: null,
      outgoingBitrate: null,
      /** 選ばれた経路が TURN リレーか（§6.6）。判定できなければ null */
      relay: null,
      /** エンコーダの実装名。ソフトへ落ちたのか動いていないのかの切り分け用（§8.4） */
      encoderImplementation: null,
    };
    const pairs = [];
    const candidates = new Map();
    let selectedPairId = null;
    report.forEach((s) => {
      // 音声・映像の区別は RTCRtpStreamStats.kind で行う。
      // qualityLimitationReason は映像の outbound-rtp にしか存在しない。
      if (s.type === "outbound-rtp" && s.kind === "video") {
        if (typeof s.framesEncoded === "number") {
          raw.framesEncoded = (raw.framesEncoded === null ? 0 : raw.framesEncoded) + s.framesEncoded;
        }
        if (raw.statsTs === null && typeof s.timestamp === "number") raw.statsTs = s.timestamp;
        // 実行時 feature detection。文字列で来たときだけ主判定を使う
        if (raw.limitationReason === null && typeof s.qualityLimitationReason === "string") {
          raw.limitationReason = s.qualityLimitationReason;
        }
        if (raw.encoderImplementation === null && typeof s.encoderImplementation === "string") {
          raw.encoderImplementation = s.encoderImplementation;
        }
      } else if (s.type === "transport" && typeof s.selectedCandidatePairId === "string") {
        selectedPairId = s.selectedCandidatePairId;
      } else if (s.type === "candidate-pair") {
        pairs.push(s);
      } else if (s.type === "local-candidate" || s.type === "remote-candidate") {
        if (typeof s.id === "string") candidates.set(s.id, s);
      }
    });
    const pair = pickCandidatePair(pairs, selectedPairId);
    if (pair !== null) {
      if (typeof pair.currentRoundTripTime === "number") raw.rtt = pair.currentRoundTripTime;
      if (typeof pair.availableOutgoingBitrate === "number") {
        raw.outgoingBitrate = pair.availableOutgoingBitrate;
      }
      raw.relay = pairUsesRelay(pair, candidates);
    }
    return raw;
  }

  /**
   * 選ばれた経路が TURN リレーを通っているか（§6.6）。
   * candidate-pair の local / remote を candidate 統計で引いて candidateType を見る。
   * どちらの候補も引けなければ判定不能として null を返す（推測しない）。
   */
  function pairUsesRelay(pair, candidates) {
    let known = false;
    for (const key of ["localCandidateId", "remoteCandidateId"]) {
      const id = pair[key];
      if (typeof id !== "string") continue;
      const candidate = candidates.get(id);
      if (candidate === undefined || typeof candidate.candidateType !== "string") continue;
      known = true;
      if (candidate.candidateType === "relay") return true;
    }
    return known ? false : null;
  }

  /** 実際に使われている candidate-pair を選ぶ */
  function pickCandidatePair(pairs, selectedPairId) {
    if (selectedPairId !== null) {
      for (const pair of pairs) {
        if (pair.id === selectedPairId) return pair;
      }
    }
    for (const pair of pairs) {
      // selected を出すブラウザと、nominated + succeeded で示すブラウザがある
      if (pair.selected === true) return pair;
      if (pair.nominated === true && pair.state === "succeeded") return pair;
    }
    return null;
  }

  /**
   * ウォームアップを過ぎて判定に使ってよいピアか。
   *
   * 基準はカメラ ON 時刻ではなく「映像の送出を始めた時刻」。replaceTrack で
   * カメラ→画面へ切り替えるとエンコーダも帯域推定も立ち上げ直しになり、
   * カメラ ON 直後とまったく同じ過渡状態（実測 9.8 秒 / 18.1 秒の
   * "bandwidth" 誤検知）が再現するため（vc-screenshare.md §8.3）。
   *
   * 【未実測】QUALITY_CAMERA_WARMUP_MS = 30 秒が画面共有でも足りるかは
   * 計測できていない（実機・実回線が要る）。恒久的な守りは sampleCause() の
   * 「主判定の bandwidth に裏付けを要求する」側にあり、この時間は多層防御。
   */
  function isWarmedUp(peer, now) {
    if (state.quality.videoOnAt === null) return false;
    if (now - state.quality.videoOnAt < QUALITY_CAMERA_WARMUP_MS) return false;
    return now - peer.createdAt >= QUALITY_PEER_WARMUP_MS;
  }

  /**
   * 生サンプルと前回値から、判定に使う1件ぶんのサンプルを組み立てる。
   *
   * 【既知の制約】実効 FPS の分母 requestedFps は、カメラ ON 時に
   * track.getSettings().frameRate から一度だけ控えている（setCamera 参照）。
   * getSettings() を持たない、あるいは frameRate を返さないブラウザでは
   * requestedFps が null になり、fpsRatio も常に null になる。
   * フォールバック判定は fpsRatio が閾値を下回ることを入口条件にしているため、
   * そうしたブラウザでは（主判定も取れなければ）品質監視が事実上働かない。
   * この場合でも音声は保たれるため、検知漏れに倒す方針（リスク R6）で許容する。
   */
  function buildSample(peer, raw, now) {
    const prev = state.quality.prev.get(peer.id);
    const requested = state.quality.requestedFps;
    let fpsRatio = null;
    if (
      prev !== undefined && prev.framesEncoded !== null && raw.framesEncoded !== null &&
      requested !== null && requested > 0
    ) {
      const prevTs = prev.statsTs === null ? prev.at : prev.statsTs;
      const ts = raw.statsTs === null ? now : raw.statsTs;
      const elapsedSec = (ts - prevTs) / 1000;
      const frames = raw.framesEncoded - prev.framesEncoded;
      // 累積カウンタなので必ず差分で見る。巻き戻り（統計のリセット）は捨てる
      if (elapsedSec > 0 && frames >= 0) fpsRatio = frames / elapsedSec / requested;
    }
    return {
      at: now,
      warmedUp: isWarmedUp(peer, now),
      // カメラだけを見ると、共有中に「映像を送っていない」と誤認して
      // 回復判定が RTT だけの緩い経路に落ちる（§5 T7）
      videoActive: activeVideoTrack() !== null,
      // 画面共有かどうかで fps の意味が変わるのでサンプルに持たせる（§8.1）
      screenShare: currentVideoSource() === "screen",
      limitationReason: raw.limitationReason,
      fpsRatio,
      rtt: raw.rtt,
      outgoingBitrate: raw.outgoingBitrate,
    };
  }

  /** 観測窓へ1件積む。あふれた古いサンプルは捨てる */
  function pushSample(playerId, sample) {
    let list = state.quality.window.get(playerId);
    if (list === undefined) {
      list = [];
      state.quality.window.set(playerId, list);
    }
    list.push(sample);
    while (list.length > QUALITY_WINDOW_SIZE) list.shift();
  }

  /**
   * 全ピアの統計を取り、観測窓を更新して判定・適用まで進める。
   * この関数は「生の数値を集める」だけで、劣化しているかどうかは判定しない。
   */
  async function sampleQuality() {
    if (state.quality.sampling) return;
    state.quality.sampling = true;
    try {
      const peers = [...state.peers.values()];
      const now = Date.now();
      let relay = false;
      let relayKnown = false;
      const reports = await Promise.all(peers.map((peer) => readStats(peer)));
      for (let i = 0; i < peers.length; i += 1) {
        const peer = peers[i];
        const report = reports[i];
        // 待っている間に閉じたピアのぶんは捨てる
        if (report === null || peer.closed) continue;
        const raw = extractRawStats(report, now);
        trackEncodeStall(peer, raw);
        if (raw.relay !== null) {
          relayKnown = true;
          if (raw.relay === true) relay = true;
        }
        pushSample(peer.id, buildSample(peer, raw, now));
        state.quality.prev.set(peer.id, raw);
      }
      // 判定できたときだけ更新する（取れないブラウザで勝手に落とさない）
      if (relayKnown) updateRelayState(relay);
      if (detectEncodeFailure()) return;
      applyQualityDecision(evaluateQuality(state.quality.window, state.peers.size, Date.now(), {
        autoStopped: state.quality.autoStopped,
        reason: state.quality.reason,
        stoppedAt: state.quality.stoppedAt,
        autoStopCount: state.quality.autoStopCount,
      }));
    } catch (e) {
      console.error("VC quality sampling failed:", e);
    } finally {
      state.quality.sampling = false;
    }
  }

  /**
   * 画面共有中に「1フレームもエンコードできていない」状態を数える（§8.4）。
   *
   * メッシュではエンコードが人数ぶん並ぶので、ハードウェアエンコーダの
   * セッション上限に当たり得る。【未確認】このとき
   * hardware-encoder-not-available がどの経路で通知されるか（例外か、
   * イベントか、黙ってソフトウェアへ落ちるか）はブラウザ依存で、
   * **実測できていない**。そこで通知経路に依存しない統計側の検出も持つ。
   *
   * 【設計書からの意図的なずらし】設計書 §8.4 は「framesEncoded が一定
   * サンプル増えない」ことを条件にしているが、それだけだと**静止した画面を
   * 共有しているだけの健全な状態**（資料を映して話している、が最も普通の
   * 使い方）が毎回引っかかり、共有を勝手に止めてしまう。画面共有は変化駆動で、
   * 動きが無ければフレームは出ない（§8.1 が fps を判定に使わない理由と同じ）。
   * そこで「累積 framesEncoded が 0 のまま」＝ **一度もエンコードが成立して
   * いない**場合に限って数える。エンコーダ枯渇の検出という目的は満たしつつ、
   * 静止画面の誤検知は原理的に起きない。
   */
  function trackEncodeStall(peer, raw) {
    // 接続が張れるまで（特に TURN 経由・参加直後）エンコーダは動かず
    // framesEncoded は 0 のままになる。ここに門を置かないと、回線が遅いだけの
    // 正常系で 6 秒後に共有が勝手に止まる
    const connected = peer.pc.connectionState === "connected";
    if (!connected || currentVideoSource() !== "screen" || raw.framesEncoded !== 0) {
      peer.stallCount = 0;
      return;
    }
    peer.stallCount += 1;
    if (peer.stallCount === SCREEN_STALL_SAMPLES) {
      // ソフトウェアへ落ちたのか、そもそも動いていないのかの切り分けに使う
      console.error(
        "VC screen share is not encoding:",
        raw.encoderImplementation === null ? "(encoderImplementation 不明)" : raw.encoderImplementation,
      );
    }
  }

  /** 全ピアでエンコードが成立していないか。1本でも出ていれば枯渇ではない */
  function detectEncodeFailure() {
    if (currentVideoSource() !== "screen") return false;
    let judged = 0;
    for (const peer of state.peers.values()) {
      if (peer.videoSender === null) continue;
      judged += 1;
      if (peer.stallCount < SCREEN_STALL_SAMPLES) return false;
    }
    if (judged === 0) return false;
    stopScreenShare({
      message: "この端末で画面を送り出せなかったため、画面共有を止めました",
      isError: true,
      // 送り出せない端末でカメラを掴み直しても同じことになる（音声優先・§3.6）
      restore: false,
    });
    return true;
  }

  /**
   * TURN リレーを検知したときの降格（§6.6）。
   * relay は in と out の両方が VPS を通るので、標準案のままだと
   * 共有者1人で VPS に 7 Mbps 乗る。共有者単位で軽い案へ落とす。
   */
  function updateRelayState(relay) {
    if (relay === state.screen.relay) return;
    state.screen.relay = relay;
    if (currentVideoSource() !== "screen") return;
    if (relay) {
      if (state.screen.profile === "light") return;
      applyScreenProfile("light");
      // 640×360 では文字が読めない（§6.3）。黙って落とすと「画面共有は
      // 使いものにならない」という誤った印象だけが残る
      notify("quality", "回線の都合（中継経由）で画質を落としています");
      return;
    }
    // 中継が外れたら戻す。品質劣化で落としたぶん（demoted）はそのまま
    if (state.screen.demoted || state.screen.profile !== "light") return;
    applyScreenProfile(state.screen.kind);
    notify("quality", "回線が直接つながったので、共有の画質を戻しました");
  }

  /**
   * 送出プロファイルを当て直す。取り込み側（applyConstraints）と
   * 送出側（setParameters）の二重の歯止めを両方そろえる（§6.4）。
   */
  function applyScreenProfile(name) {
    const profile = SCREEN_PROFILES[name];
    if (profile === undefined) return;
    state.screen.profile = name;
    applyCaptureProfile(activeVideoTrack(), name);
    for (const peer of state.peers.values()) {
      applyEncodingProfile(peer.videoSender, profile);
    }
  }

  /** 取り込み側だけを絞る（contentHint と applyConstraints）。§6.4 の一段目 */
  function applyCaptureProfile(track, name) {
    const profile = SCREEN_PROFILES[name];
    if (profile === undefined || track === null) return;
    try {
      track.contentHint = profile.contentHint;
    } catch (e) {
      console.error("VC contentHint failed:", e);
    }
    if (typeof track.applyConstraints !== "function") return;
    const applied = track.applyConstraints({
      width: { max: profile.width },
      height: { max: profile.height },
      frameRate: { max: profile.frameRate },
    });
    if (applied !== undefined && typeof applied.catch === "function") {
      applied.catch((e) => console.error("VC applyConstraints failed:", e));
    }
  }

  /**
   * サンプル1件の劣化原因を返す。★純粋関数★
   * 戻り値は "cpu" | "bandwidth" | "bitrate" | "rtt" | null。
   *   - limitationReason が文字列なら主判定（primary）を使う
   *   - null なら実効 FPS ＋（RTT 超過 または 送出可能帯域不足）のフォールバック
   *
   * 主判定で "bandwidth" が来たときは、そのまま原因として採らず
   * 別の指標による裏付けを要求する（下記コメント参照）。
   */
  function sampleCause(sample) {
    if (typeof sample.limitationReason === "string") {
      // "cpu" は端末側の事実の報告であり、他指標による裏付けを要さない
      if (sample.limitationReason === "cpu") return "cpu";
      if (sample.limitationReason === "bandwidth") {
        // ---------------------------------------------------------------
        // 主判定の "bandwidth" には裏付けを要求する。理由:
        //
        // 1. Chrome は送出開始直後、回線が健全でも "bandwidth" を報告し続ける。
        //    実測（Chrome 151 / headless / fake camera）で 9.8 秒 / 18.1 秒と
        //    ばらつきが大きく、帯域推定が立ち上がるまでの過渡状態にすぎない。
        //    QUALITY_CAMERA_WARMUP_MS のような時間ベースのウォームアップだけでは
        //    「何秒待てば安全か」を決められず、誤検知を防ぎきれない。
        // 2. §3.6 の目的は音声の保護である。送出可能帯域が停止閾値
        //    （QUALITY_BITRATE_STOP_BPS = 320kbps）を上回っていれば、音声
        //    （Opus 約32kbps × 最大5本 = 約160kbps）は圧迫されていない。
        //    音声が無事な状態で映像を止める理由は無い。
        // 3. 両指標とも null（取得できない）のときは原因なしとする。これは
        //    「誤検知より検知漏れに倒す」という設計のリスク R6 の方針による。
        //    見逃しても音声は残るが、誤検知は健全な映像を奪う。
        // ---------------------------------------------------------------
        // 裏付け1: 自分の上り全体が細っている。音声も危ないので d≥1 で止める
        if (
          sample.outgoingBitrate !== null && sample.outgoingBitrate < QUALITY_BITRATE_STOP_BPS
        ) {
          return "bitrate";
        }
        // 裏付け2: 経路側の遅延。自分側とは限らないので過半数（d≥⌈N/2⌉）で止める
        if (sample.rtt !== null && sample.rtt > QUALITY_RTT_STOP_SEC) return "bandwidth";
        // 裏付けが取れない（両方 null を含む）→ 原因として採らない
        return null;
      }
      return null;
    }
    // ここから下はフォールバック判定（limitationReason が取れない環境）。
    // 分母となる requestedFps を取得できないブラウザでは fpsRatio が null に
    // なり、この判定は常に「原因なし」を返す（＝フォールバックが働かない）。
    // 詳細は buildSample() / setCamera() のコメントを参照。
    //
    // ただし画面共有中は fps を入口条件にしない（vc-screenshare.md §8.1 / T10）。
    //   1. contentHint = "text" は maintain-resolution を選ばせる。つまり
    //      fps が落ちるのは設計どおりの正常動作であって、劣化ではない
    //   2. 画面共有は変化駆動で、静止した画面ではフレームがほとんど出ない。
    //      framesEncoded が増えないのは回線とは無関係
    // 代わりに RTT と送出可能帯域だけで見る。どちらも取れない環境では判定が
    // 働かないが、これは既存の「誤検知より検知漏れに倒す」方針（R6）と同じ扱い。
    if (sample.screenShare === true) {
      if (sample.outgoingBitrate !== null && sample.outgoingBitrate < QUALITY_BITRATE_STOP_BPS) {
        return "bitrate";
      }
      if (sample.rtt !== null && sample.rtt > QUALITY_RTT_STOP_SEC) return "rtt";
      return null;
    }
    if (sample.fpsRatio === null || sample.fpsRatio >= QUALITY_FPS_STOP_RATIO) return null;
    if (sample.outgoingBitrate !== null && sample.outgoingBitrate < QUALITY_BITRATE_STOP_BPS) {
      return "bitrate";
    }
    if (sample.rtt !== null && sample.rtt > QUALITY_RTT_STOP_SEC) return "rtt";
    return null;
  }

  /**
   * サンプル1件が「回復している」と言えるか。★純粋関数★
   * 映像を止めている間（videoActive が false）は送信側の帯域推定・FPS が
   * 意味を持たない（送るものが無いので推定が上がらない）ため、RTT だけで見る。
   */
  function sampleLinkHealthy(sample) {
    if (sample.rtt !== null && sample.rtt > QUALITY_RTT_RESUME_SEC) return false;
    if (sample.videoActive !== true) return true;
    if (typeof sample.limitationReason === "string" && sample.limitationReason !== "none") {
      return false;
    }
    if (sample.outgoingBitrate !== null && sample.outgoingBitrate < QUALITY_BITRATE_RESUME_BPS) {
      return false;
    }
    // 共有中の fps は劣化の指標にならない（§8.1）ので、回復の判定でも見ない。
    // ここで見ると、健全な共有がいつまでも「回復していない」ままになる
    if (
      sample.screenShare !== true && sample.fpsRatio !== null &&
      sample.fpsRatio < QUALITY_FPS_RESUME_RATIO
    ) {
      return false;
    }
    return true;
  }

  /**
   * 全ピアが回復しているか。★純粋関数★
   * ウォームアップ前のサンプルしか無いピアは判定材料が無いので無視する。
   */
  function isLinkRecovered(windowMap) {
    let judged = 0;
    let recovered = 0;
    windowMap.forEach((samples) => {
      const warmed = samples.filter((s) => s.warmedUp === true);
      if (warmed.length === 0) return;
      judged += 1;
      let healthy = 0;
      for (const sample of warmed) {
        if (sampleLinkHealthy(sample)) healthy += 1;
      }
      if (healthy >= QUALITY_STOP_HITS) recovered += 1;
    });
    if (judged === 0) return false;
    return recovered === judged;
  }

  /**
   * 観測窓から「映像を止めるべきか」「回復を知らせてよいか」を判定する。★純粋関数★
   *
   * 引数以外の状態（state / Date.now()）を一切読まない。テスト可能性のために
   * この性質を守ること。テスト用に VC.evaluateQuality として公開している。
   *
   * @param {Map<string, Array<object>>} windowMap
   *   playerId → サンプル配列（古い順）。各サンプルは buildSample() の形:
   *   { at:number, warmedUp:boolean, videoActive:boolean, screenShare:boolean,
   *     limitationReason:string|null, fpsRatio:number|null,
   *     rtt:number|null, outgoingBitrate:number|null }
   * @param {number} peerCount VC ピアの総数（N）
   * @param {number} now 現在時刻（Date.now() 相当。最小保持時間の判定に使う）
   * @param {object} ctx
   *   { autoStopped:boolean, reason:string|null, stoppedAt:number|null,
   *     autoStopCount:number }
   * @returns {{ shouldStop:boolean, reason:("bandwidth"|"cpu"|null),
   *   degradedPeerCount:number, canResume:boolean,
   *   mode:("primary"|"fallback"|"unknown"), degradedPeerIds:string[] }}
   */
  function evaluateQuality(windowMap, peerCount, now, ctx) {
    const causeKeys = ["cpu", "bandwidth", "bitrate", "rtt"];
    const causePeers = { cpu: 0, bandwidth: 0, bitrate: 0, rtt: 0 };
    const degradedPeerIds = [];
    let sawPrimary = false;
    let sawFallback = false;

    windowMap.forEach((samples, playerId) => {
      const hits = { cpu: 0, bandwidth: 0, bitrate: 0, rtt: 0 };
      for (const sample of samples) {
        // 判定方式はウォームアップ前のサンプルからも分かるので先に見る
        if (typeof sample.limitationReason === "string") sawPrimary = true;
        else if (
          sample.fpsRatio !== null || sample.rtt !== null || sample.outgoingBitrate !== null
        ) sawFallback = true;
        if (sample.warmedUp !== true) continue;
        const cause = sampleCause(sample);
        if (cause !== null) hits[cause] += 1;
      }
      let degraded = false;
      for (const key of causeKeys) {
        if (hits[key] >= QUALITY_STOP_HITS) {
          causePeers[key] += 1;
          degraded = true;
        }
      }
      if (degraded) degradedPeerIds.push(playerId);
    });

    const mode = sawPrimary ? "primary" : (sawFallback ? "fallback" : "unknown");
    // 過半数。⌈N/2⌉（ただし最低 1）
    const majority = Math.max(1, Math.ceil(peerCount / 2));

    let shouldStop = false;
    let reason = null;
    if (ctx.autoStopped !== true && ctx.autoStopCount < QUALITY_MAX_AUTO_STOPS) {
      // 端末負荷と帯域不足は1ピアでも成立すれば止める（自分側の問題であり、
      // 他のピアにも同じことが起きるため）。回線品質の推定にすぎない
      // bandwidth / RTT は、過半数のピアで見えたときだけ止める。
      if (causePeers.cpu >= 1) {
        shouldStop = true;
        reason = "cpu";
      } else if (causePeers.bitrate >= 1) {
        shouldStop = true;
        reason = "bandwidth";
      } else if (causePeers.bandwidth >= majority) {
        shouldStop = true;
        reason = "bandwidth";
      } else if (causePeers.rtt >= majority) {
        shouldStop = true;
        reason = "bandwidth";
      }
    }

    let canResume = false;
    if (
      ctx.autoStopped === true && typeof ctx.stoppedAt === "number" &&
      now - ctx.stoppedAt >= QUALITY_MIN_HOLD_MS
    ) {
      // 端末負荷の回復は回線の統計から分からないので、最小保持時間だけで判断する
      canResume = ctx.reason === "cpu" ? true : isLinkRecovered(windowMap);
    }

    return {
      shouldStop,
      reason,
      degradedPeerCount: degradedPeerIds.length,
      canResume,
      mode,
      degradedPeerIds,
    };
  }

  /** 判定結果を状態と表示に反映する（停止の実行と通知） */
  function applyQualityDecision(decision) {
    state.quality.mode = decision.mode;
    state.quality.degradedPeerCount = decision.degradedPeerCount;
    for (const [id, peer] of state.peers) {
      peer.degraded = decision.degradedPeerIds.indexOf(id) >= 0;
    }
    if (decision.shouldStop) {
      // 画面共有は会話の対象そのものなので、いきなり消すと話が成立しなくなる。
      // まず画質を落として繋ぎ、それでも直らなければ止める（§8.2 の二段構え）。
      // 終着点（停止＝音声優先）は §3.6 のまま変えていない。
      if (
        currentVideoSource() === "screen" && !state.screen.demoted &&
        state.screen.profile !== "light"
      ) {
        // 既に軽い案なら落とす先が無いので、段を挟まずに停止へ進む
        demoteScreenShare();
        return;
      }
      if (
        currentVideoSource() === "screen" && state.screen.demotedAt !== null &&
        Date.now() - state.screen.demotedAt < QUALITY_MIN_HOLD_MS
      ) {
        // 降格の効きを見るあいだは止めない（最小保持時間）
        return;
      }
      stopVideoForQuality(decision.reason);
      return;
    }
    if (decision.canResume && !state.quality.recovered) {
      state.quality.recovered = true;
      // 映像は戻さない。戻すのは本人の明示操作だけ（§3.6）。
      // 文言は停止理由に合わせる（cpu は回線の話ではないため）
      notify(
        "quality",
        state.quality.reason === "cpu"
          ? "負荷が下がりました。カメラを再開できます"
          : "回線が回復しました。カメラを再開できます",
      );
    }
  }

  /** 画面共有を軽い案へ降格する（§8.2 の一段目） */
  function demoteScreenShare() {
    state.screen.demoted = true;
    state.screen.demotedAt = Date.now();
    applyScreenProfile("light");
    // 観測窓を捨てる。降格前の劣化サンプルで即座に二段目へ進まないように
    state.quality.prev.clear();
    state.quality.window.clear();
    notify("quality", "回線が不安定なため、共有の画質を落としました");
  }

  /**
   * 品質劣化で映像だけを止める。音声は触らない（音声優先・§3.6）。
   * setCamera(false) は使わない。あちらは各ピアで removeTrack して
   * 再ネゴシエーションを起こすため、帯域が枯れている状況では逆効果になる。
   * replaceTrack(null) なら再ネゴシエーションは不要（MDN）。
   *
   * 止める対象は「いまの映像ソース」。カメラ固定にすると、共有中に品質が
   * 落ちても何も止まらず §3.6 の音声優先が効かない（§5 T8）。
   */
  function stopVideoForQuality(reason) {
    const source = currentVideoSource();
    if (source === "none") return;
    for (const peer of state.peers.values()) {
      if (peer.videoSender === null) continue;
      const replaced = peer.videoSender.replaceTrack(null);
      if (replaced !== undefined && typeof replaced.catch === "function") {
        replaced.catch((e) => console.error("VC replaceTrack failed:", e));
      }
    }
    // 送出をやめる以上、取り込みも全部やめる。画面のトラックを止め損ねると
    // ブラウザの「共有中」バーが残り、カメラを止め損ねると LED が点いたままになる。
    // 共有中はカメラを手元に持ったままのことがある（送ってはいない）ので、
    // ここで両方を落として映像ソースを "none" にそろえる
    if (source === "screen") releaseScreenStream();
    releaseCameraStream();
    renderLocalVideo();
    // 自分の共有を拡大表示していたなら、中身が死んだ枠を残さない
    if (source === "screen" && state.selfId !== null) closeZoom(state.selfId);
    state.quality.autoStopped = true;
    state.quality.reason = reason;
    state.quality.stoppedAt = Date.now();
    state.quality.autoStopCount += 1;
    state.quality.recovered = false;
    announceVideoState();
    // 停止後も監視は続ける。回復を検知して通知するため（映像は戻さない）。
    // cpu は回線の問題ではないので文言を分ける（実態と合わせるため）
    notify(
      "quality",
      reason === "cpu"
        ? "端末の負荷が高いため映像を停止しました"
        : "回線が不安定なため映像を停止しました",
    );
  }

  /** 品質監視を始める。映像の送出中と自動停止中だけ動かす（電池・CPU 対策） */
  function startQualityMonitor() {
    if (state.quality.timer !== null) return;
    state.quality.prev.clear();
    state.quality.window.clear();
    state.quality.timer = global.setInterval(sampleQuality, QUALITY_SAMPLE_INTERVAL_MS);
  }

  /** 品質監視を止める。タイマーを残さないこと（リーク防止） */
  function stopQualityMonitor() {
    if (state.quality.timer !== null) {
      global.clearInterval(state.quality.timer);
      state.quality.timer = null;
    }
    state.quality.prev.clear();
    state.quality.window.clear();
    state.quality.degradedPeerCount = 0;
    for (const peer of state.peers.values()) peer.degraded = false;
  }

  /** 自動停止の掛け金を外す（本人がカメラを操作したときの後始末） */
  function clearAutoStop() {
    state.quality.autoStopped = false;
    state.quality.reason = null;
    state.quality.stoppedAt = null;
    state.quality.recovered = false;
  }

  /** 品質監視の状態をすべて初期化する（VC 離脱時） */
  function resetQuality() {
    stopQualityMonitor();
    clearAutoStop();
    state.quality.autoStopCount = 0;
    state.quality.videoOnAt = null;
    state.quality.requestedFps = null;
    state.quality.mode = "unknown";
  }

  /**
   * 映像ソースが変わったことを品質監視に伝える（§8.3 / T9）。
   * ウォームアップを打ち直し、観測窓も捨てる。持ち越すと、切り替えた直後に
   * 立ち上がり中の "bandwidth" を拾って必ず誤検知する。
   */
  function markVideoSourceChanged(track) {
    state.quality.videoOnAt = track === null ? null : Date.now();
    state.quality.requestedFps = requestedFpsOf(track);
    state.quality.prev.clear();
    state.quality.window.clear();
    for (const peer of state.peers.values()) peer.stallCount = 0;
  }

  /**
   * 実効 FPS の分母に使う要求 FPS。
   * getSettings() を持たない／frameRate を返さないブラウザでは null になり、
   * fpsRatio も出せなくなる（buildSample() のコメント参照）。
   */
  function requestedFpsOf(track) {
    if (track === null) return null;
    const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
    return typeof settings.frameRate === "number" ? settings.frameRate : null;
  }

  /**
   * 映像ソースの有無に合わせて品質監視を入り切りする。
   * 「映像が1本も無くなったとき」だけ止めること。カメラ基準で止めると、
   * 共有中にカメラを切っただけで見張りが居なくなる（§5 T2）。
   */
  function syncQualityMonitor() {
    if (currentVideoSource() !== "none") {
      startQualityMonitor();
      return;
    }
    stopQualityMonitor();
    clearAutoStop();
    state.quality.videoOnAt = null;
    state.quality.requestedFps = null;
  }

  // -------------------------------------------------------------------------
  // 公開 API
  // -------------------------------------------------------------------------

  /** 送信関数・表示先・状態通知を注入する */
  function init(options) {
    config.send = options.send;
    config.container = options.container ?? null;
    config.onStatus = options.onStatus ?? null;
    config.onZoom = typeof options.onZoom === "function" ? options.onZoom : null;
    // getStats は省略可。既定は pc.getStats() をそのまま呼ぶ
    if (typeof options.getStats === "function") config.getStats = options.getStats;
    if (Array.isArray(options.iceServers) && options.iceServers.length > 0) {
      state.iceServers = options.iceServers;
    }
  }

  /** TURN 導入時に ICE サーバーを差し替える（§3.6） */
  function setIceServers(servers) {
    if (!Array.isArray(servers) || servers.length === 0) return;
    state.iceServers = servers;
  }

  /**
   * S2C メッセージを渡す。ルーム側の受信処理からそのまま流し込む。
   * 対象は roomState / playerJoined / playerLeft / playerKicked / kicked / rtcSignal。
   */
  function handleServerMessage(msg) {
    if (typeof msg !== "object" || msg === null) return;
    switch (msg.t) {
      case "roomState":
        state.selfId = msg.snapshot.youId;
        syncPlayers(msg.snapshot.players);
        // 再接続時は自分のピアがすべて無効になっているので張り直す
        if (state.active) restartPeers();
        return;
      case "playerJoined": {
        const known = state.peers.has(msg.player.id);
        upsertPlayer(msg.player);
        if (!state.active) return;
        // 再接続してきた相手の古いピアは使えないので畳んでから告知する
        if (known) closePeer(msg.player.id);
        if (msg.player.id !== state.selfId && msg.player.vcEligible) {
          signal(msg.player.id, { kind: "ready", session: state.session });
          // 後から入ってきた相手にも、いまの映像状態（カメラか画面か）を伝える（§4.3）
          announceVideoStateTo(msg.player.id);
        }
        return;
      }
      case "playerLeft":
        // 切断・退室のどちらでも該当ピアだけを閉じる（§8 VC 行）
        upsertPlayer(msg.player);
        closePeer(msg.player.id);
        return;
      case "playerKicked":
        // キックされた参加者との接続は即時クローズする（§3.6）
        state.players.delete(msg.playerId);
        closePeer(msg.playerId);
        return;
      case "kicked":
        leave();
        return;
      case "rtcSignal":
        onSignal(msg.from, msg.payload);
        return;
      default:
        return;
    }
  }

  /**
   * VC に参加する。マイク取得はユーザー操作の直後に行う（自動再生制限対策）。
   * 取得に失敗した場合は VC 不参加のまま入室を続ける（§3.6 のフォールバック）。
   */
  async function join() {
    if (state.active) return true;
    // ------------------------------------------------------------------
    // 多重参加よけ。roomState は入室時だけでなく得点確定やノックでも配られる
    // ので、マイクの許可ダイアログを見ているあいだに次の roomState が届く。
    // state.active は getUserMedia の**後**にしか立たないため、ここに門が
    // 無いと2本目のマイクを掴み、1本目が参照を失って二度と止まらなくなる。
    // （孤児のトラックは setMuted() の対象からも外れるのでミュートも効かない）
    // ------------------------------------------------------------------
    if (state.joining) return false;
    if (state.selfId === null) {
      notify("error", "ルームに入ってから VC に参加してください");
      return false;
    }
    if (!selfEligible()) {
      notify("error", "VC の枠（先着6人）が埋まっています。音声なしで参加します");
      return false;
    }
    if (global.navigator.mediaDevices === undefined) {
      notify("error", "このブラウザではマイクを利用できません。音声なしで参加します");
      return false;
    }
    state.joinGen += 1;
    const gen = state.joinGen;
    state.joining = true;
    let stream = null;
    try {
      stream = await global.navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (e) {
      state.joining = false;
      console.error("VC getUserMedia failed:", e);
      notify("error", "マイクを使用できませんでした。音声なしで参加します");
      return false;
    }
    state.joining = false;
    // 許可ダイアログを見ているあいだに参加が成立した／卓を離れたなら、
    // 掴んだマイクを捨てる。捨て損ねるとブラウザの「使用中」表示が消えない
    if (state.active || state.micStream !== null || state.joinGen !== gen) {
      stopStream(stream);
      return state.active;
    }
    state.micStream = stream;
    state.active = true;
    state.muted = false;
    state.session = randomId();
    // カメラが切でも自分の枠を出す（着席したことが画面で分かるように）
    renderLocalVideo();
    notify("vcState", "VC に参加しました");
    announceReady();
    return true;
  }

  /**
   * VC から抜ける。ピアもマイク・カメラもすべて止める。
   * 退室・キックはサーバーが生きているので、各ピアへ離脱を知らせてから畳む
   */
  function leave() {
    shutdownVc({ notifyPeers: true, message: "VC から退出しました" });
  }

  /**
   * ピアに知らせずに VC を畳む。サーバーが落ちている・繋ぎ直した直後に使う
   * （サーバー再起動で卓が解散したときなど）。
   *
   * bye を送らないのは、送っても落ちたサーバー経由では相手に届かないうえ、
   * 繋ぎ直した先の新しいサーバーへ宛先不明の rtcSignal を投げることになり、
   * その拒否応答で呼び出し側の案内（「サーバーが再起動したため…」）を
   * 上書きしてしまうため。
   *
   * 送るか送らないかに関わらず、マイク・カメラのトラックは必ず止める。
   * ここを止め損ねるとカメラのランプが点いたままになる（§3.6 のプライバシー配慮）
   */
  function teardown() {
    // 呼び出し側が状況を説明しているので、こちらからは状態通知を出さない
    shutdownVc({ notifyPeers: false, message: null });
  }

  /**
   * VC の後始末。leave() と teardown() の違いはピアへの通知の有無だけなので、
   * 取りこぼしが起きないよう本体は1つにまとめてある。
   *   notifyPeers … 各ピアへ bye を送るか。サーバーが生きているときだけ true
   *   message     … notify("vcState", …) に流す文言。null なら通知しない
   * VC に参加していないときは何もしない（トラックも接続も持っていないため）
   */
  function shutdownVc(options) {
    // 参加していないときでも世代だけは進める。マイクの許可ダイアログを
    // 出したまま卓を離れる場合、この時点ではまだ active が立っていないので、
    // ここで無効にしておかないと後から解決した join がマイクを掴んでしまう
    state.joinGen += 1;
    if (!state.active) return;
    // タイマーを残さないよう、ピアを畳む前に監視を止める
    resetQuality();
    if (options.notifyPeers) {
      for (const id of state.peers.keys()) signal(id, { kind: "bye" });
    }
    closeAllPeers();
    stopStream(state.micStream);
    state.micStream = null;
    releaseCameraStream();
    // 画面のトラックも必ず止める。止め損ねるとブラウザの「共有中」バーが
    // 残り続ける（カメラのランプを消すのと同じ趣旨・§5 T12）
    releaseScreenStream();
    state.screen.kind = SCREEN_DEFAULT_KIND;
    state.screen.profile = SCREEN_DEFAULT_KIND;
    state.screen.starting = false;
    state.screen.relay = false;
    if (state.selfId !== null) closeZoom(state.selfId);
    // active を先に倒してから描き直す。renderLocalVideo は「VC に入っているか」だけを
    // 見て枠を出し入れするので、順番が逆だと自分の枠だけ卓上に残る（VC を抜けた後も
    // 黒い枠と自分の名前が並んだままになり、まだ着席しているように見える）
    state.active = false;
    renderLocalVideo();
    state.muted = false;
    state.session = null;
    if (options.message !== null) notify("vcState", options.message);
  }

  /** MediaStream のトラックをすべて停止する */
  function stopStream(stream) {
    if (stream === null) return;
    for (const track of stream.getTracks()) track.stop();
  }

  /**
   * カメラのストリームを手放す。releaseScreenStream() のカメラ版で、
   * 「止める」だけでなく**選択待ちの取得を無効にする**（世代を進める）のが要点。
   *
   * 進めないと、応答待ちの getUserMedia が後から解決して state.camStream を
   * 埋め直してしまう。退室後にランプが点く・OFF にしたのに点く、という
   * 「利用者の最後の操作と逆になる」状態はここで断つ。
   */
  function releaseCameraStream() {
    state.camera.gen += 1;
    stopStream(state.camStream);
    state.camStream = null;
  }

  /** ミュートを切り替える。戻り値は切り替え後の状態 */
  function toggleMute() {
    return setMuted(!state.muted);
  }

  /** ミュート状態を設定する。track.enabled を落とすだけで接続は維持する */
  function setMuted(muted) {
    if (!state.active || state.micStream === null) return state.muted;
    state.muted = muted === true;
    for (const track of state.micStream.getAudioTracks()) {
      track.enabled = !state.muted;
    }
    notify("vcState", state.muted ? "マイクをミュートしました" : "ミュートを解除しました");
    return state.muted;
  }

  /**
   * カメラを切り替える。戻り値は切り替え後の状態。
   * 共有中はカメラを掴んでいないので、裏返すのは「やめたら戻す約束」のほう。
   */
  function toggleCamera() {
    return setCamera(!cameraIntended());
  }

  /**
   * 利用者から見た「カメラは入っているか」。
   * 共有中は実際には止めているが、やめたら戻る約束があるなら入と見なす
   * （ボタンの文言をこれで描く。§10 の「DOM から状態を読み戻さない」流儀）。
   */
  function cameraIntended() {
    if (currentVideoSource() === "screen") return state.screen.cameraWasOn;
    return state.camStream !== null;
  }

  /** acquireCamera() の結果。掴めて state.camStream に入った */
  const CAMERA_OK = "ok";
  /** 別の取得が進行中なので何もしなかった（連打・多重呼び出し） */
  const CAMERA_BUSY = "busy";
  /** 待っているあいだに割り込まれたので、掴んだものを捨てた */
  const CAMERA_STALE = "stale";
  /** getUserMedia が失敗した（拒否・デバイス無し・他アプリが占有 等） */
  const CAMERA_FAILED = "failed";
  /** 映像トラックが1本も返らなかったので捨てた */
  const CAMERA_NOTRACK = "notrack";

  /**
   * カメラを1本だけ掴む共通処理。カメラの getUserMedia はここに一本化する。
   *
   * getUserMedia は許可の問い合わせや他アプリとの取り合いで待たされ得るので、
   * 画面共有の startScreenShare と同じ **starting（連打よけ）＋ gen（世代）**
   * の二重ガードを掛ける。await から戻ったら必ず割り込みの有無を見て、
   * 割り込まれていたら掴んだストリームを stopStream() で捨てる。
   * 捨て損ねると参照を失ったまま止められなくなり、退室してもカメラの
   * ランプが消えない（§3.6 のプライバシー配慮が破れる）。
   *
   * 成功時だけ state.camStream に入れる。呼び出し側は結果コードを見て、
   * 通知を出すか・送出を組み替えるかを決める。
   */
  async function acquireCamera() {
    if (!state.active) return CAMERA_STALE;
    if (state.camStream !== null) return CAMERA_OK;
    if (state.camera.starting) return CAMERA_BUSY;
    const devices = global.navigator === undefined ? undefined : global.navigator.mediaDevices;
    if (devices === undefined || devices === null) return CAMERA_FAILED;
    state.camera.gen += 1;
    const gen = state.camera.gen;
    state.camera.starting = true;
    let stream = null;
    try {
      stream = await devices.getUserMedia(CAMERA_CONSTRAINTS);
    } catch (e) {
      state.camera.starting = false;
      console.error("VC camera failed:", e);
      return CAMERA_FAILED;
    }
    state.camera.starting = false;
    // 待っているあいだに卓を離れた・OFF にされた・画面共有が始まった・
    // 別の取得が先に入った。いずれも掴んだものはもう要らない
    if (!state.active || state.camera.gen !== gen || state.camStream !== null) {
      stopStream(stream);
      return CAMERA_STALE;
    }
    if (stream.getVideoTracks()[0] === undefined) {
      stopStream(stream);
      return CAMERA_NOTRACK;
    }
    state.camStream = stream;
    return CAMERA_OK;
  }

  /**
   * カメラの ON / OFF（初期 OFF・本人の明示操作でのみ ON、§3.6）。
   * ON は既存の全ピアへ映像を載せ、OFF は replaceTrack(null) で送出だけを外す。
   * 映像を1本でも送っているあいだは品質監視を動かす（§3.6 の映像自動停止）。
   *
   * 画面共有中はカメラの入／切が**送出に影響しない**（§4.1 の不変条件により、
   * 外へ出ているのは常に画面のほう）。sender をここで触ると共有ごと落ちるので
   * 触らない（vc-screenshare.md §5 T1 / T2）。
   */
  async function setCamera(on) {
    if (!state.active) {
      notify("error", "先に VC に参加してください");
      return false;
    }
    // ------------------------------------------------------------------
    // 画面共有中のカメラ操作は「共有をやめたらカメラに戻すか」の入り切りとして
    // 働く。共有中はカメラを実際に止めているので、ここで掴み直すと LED だけが
    // 点いて何も送らない、という利用者を欺く状態になるため触らない。
    // 戻り値は「いまカメラが動いているか」なので、どちらの操作でも false。
    // ------------------------------------------------------------------
    if (currentVideoSource() === "screen") {
      state.screen.cameraWasOn = on === true;
      notify(
        "vcState",
        on === true
          ? "画面共有をやめたらカメラに戻します"
          : "画面共有をやめてもカメラは戻しません",
      );
      return false;
    }
    if (on === true) {
      if (state.camStream !== null) return true;
      const result = await acquireCamera();
      if (result === CAMERA_FAILED) {
        notify("error", "カメラを使用できませんでした");
        return false;
      }
      // busy（別の取得が進行中）・stale（待つあいだに割り込まれた）・
      // notrack（映像トラックが無かった）は、掴んだものを acquireCamera() が
      // 既に捨てている。ここで送出をいじると割り込んだ側の状態を壊す
      if (result !== CAMERA_OK) return false;
      const stream = state.camStream;
      const track = stream.getVideoTracks()[0];
      // 自動停止で外した sender は使い回す（再ネゴシエーションを避ける）
      await applyVideoTrackAll(track);
      if (state.camStream !== stream) {
        // 差し替えを待つあいだに OFF・画面共有・退室が割り込んだ。
        // 送出を今の状態へそろえ直して抜ける（画面共有と同じ作法）
        await applyVideoTrackAll(activeVideoTrack());
        return false;
      }
      markVideoSourceChanged(track);
      announceVideoState();
      renderLocalVideo();
      syncQualityMonitor();
      notify("vcState", "カメラを ON にしました");
      return true;
    }
    if (state.camStream === null) {
      // カメラを持っていないなら、掛け金だけ外して戻る（従来どおり）。
      // ただし応答待ちの取得があるなら無効にする。利用者の最後の操作は OFF
      // なのだから、後から解決した ON でカメラが点くのは筋が通らない
      if (state.camera.starting) state.camera.gen += 1;
      if (currentVideoSource() === "none") {
        stopQualityMonitor();
        clearAutoStop();
        state.quality.videoOnAt = null;
        state.quality.requestedFps = null;
      }
      return false;
    }
    const wasSending = currentVideoSource() === "camera";
    releaseCameraStream();
    if (wasSending) {
      // removeTrack はしない。sender を残しておけば次の映像で再ネゴが要らない（T1）
      await applyVideoTrackAll(activeVideoTrack());
      markVideoSourceChanged(null);
      announceVideoState();
    }
    renderLocalVideo();
    // 映像が1本も無くなったときだけ監視を畳む（共有中は見張りを残す・T2）
    syncQualityMonitor();
    notify("vcState", "カメラを OFF にしました");
    return false;
  }

  // -------------------------------------------------------------------------
  // 画面共有（docs/design/vc-screenshare.md）
  // -------------------------------------------------------------------------

  /** 画面共有を切り替える。戻り値は切り替え後の状態 */
  function toggleScreenShare(kind) {
    if (state.screenStream !== null) {
      return stopScreenShare({ message: "画面共有を止めました" });
    }
    return startScreenShare(kind);
  }

  /**
   * 画面共有を始める（§4 / §6 / §9）。
   *
   * 開始は必ず本人の明示操作から。他の人が共有中なら **getDisplayMedia を
   * 呼ばずに**断る（呼ぶと選択ダイアログを出してから断ることになる・§4.4）。
   */
  async function startScreenShare(kind) {
    if (!state.active) {
      notify("error", "先に VC に参加してください");
      return false;
    }
    if (!screenShareSupported()) {
      notify("error", "この端末では画面共有を始められません（他の人の共有は見られます）");
      return false;
    }
    if (state.screenStream !== null) return true;
    // 開始の連打よけ（§9-4）。選択ダイアログを二重に出さない
    if (state.screen.starting) return false;
    const rivals = sharingPeerIds();
    if (rivals.length > 0) {
      notify("error", `${nicknameOf(rivals[0])} さんが画面を共有中です`);
      return false;
    }
    const requested = kind === "motion" ? "motion" : SCREEN_DEFAULT_KIND;
    const profileName = pickProfile({ requested, relay: state.screen.relay });
    // この開始処理の世代。await から戻るたびに、割り込まれていないかを見る
    state.screen.gen += 1;
    const gen = state.screen.gen;
    state.screen.starting = true;
    let stream = null;
    try {
      stream = await global.navigator.mediaDevices.getDisplayMedia(
        displayConstraints(SCREEN_PROFILES[profileName]),
      );
    } catch (e) {
      state.screen.starting = false;
      console.error("VC getDisplayMedia failed:", e);
      notify("error", shareErrorMessage(e));
      return false;
    }
    state.screen.starting = false;
    // 選択ダイアログを出しているあいだに卓を離れていたら、掴んだものを捨てる。
    // ここで取りこぼすとブラウザの「共有中」バーだけが残る
    if (!state.active || state.screen.gen !== gen) {
      stopStream(stream);
      return false;
    }
    // **もう一度**他の人の共有を見る。開始前の確認から、利用者が画面を選ぶまでの
    // 数秒〜数十秒が空いている。この窓は設計書が想定する片道 RTT よりずっと長く、
    // ここを見ないと2人が同時に共有したまま収束しない（§4.4）
    const late = sharingPeerIds();
    if (late.length > 0) {
      stopStream(stream);
      notify("error", `${nicknameOf(late[0])} さんが画面を共有中です`);
      return false;
    }
    // 音声トラックは常に0本として扱う（§6.5）。万一返ってきたら捨てる
    dropAudioTracks(stream);
    const track = stream.getVideoTracks()[0];
    if (track === undefined) {
      stopStream(stream);
      notify("error", "共有する画面を取得できませんでした");
      return false;
    }
    state.screenStream = stream;
    state.screen.kind = requested;
    state.screen.profile = profileName;
    state.screen.demoted = false;
    state.screen.demotedAt = null;
    // 実際に何が選ばれたかは事後にしか分からない（displaySurface は希望の
    // 表明にすぎず、選択を制限できない）。§9-1 の警告もこの値から出す
    state.screen.surface = readDisplaySurface(track);
    // ブラウザの共有バーから止められたときの合流点。自前の停止ボタンからは
    // stop() しても ended は発火しないので、そちらは明示的に後始末を呼ぶ（§9-1）
    if (typeof track.addEventListener === "function") {
      track.addEventListener("ended", onScreenTrackEnded);
      // 共有中に対象を切り替えられたら、申告値を読み直して伝える（surfaceSwitching）
      track.addEventListener("configurationchange", onScreenConfigurationChange);
    }
    // ------------------------------------------------------------------
    // 共有中はカメラを**実際に止める**（オーナー判断）。
    // LED は利用者にとって「撮られているかどうか」のハードウェア的な信号で、
    // 送出していないのにランプが点いたままだと、その信号が嘘をつくことになる。
    // 「カメラは停止中」と札に出しながら点灯している状態はいちばん不信感を招く。
    // 共有をやめたときに戻せるよう、ON だったことだけを覚えておく。
    // ------------------------------------------------------------------
    state.screen.cameraWasOn = state.camStream !== null;
    releaseCameraStream();
    // 取り込み側だけ先に絞る。送出パラメータは差し替えの後に当てる（§4.2 の順序）
    applyCaptureProfile(track, profileName);
    await applyVideoTrackAll(track);
    if (state.screen.gen !== gen || state.screenStream !== stream) {
      // 待っているあいだに止められた。送出を今の状態へそろえ直して抜ける
      await applyVideoTrackAll(activeVideoTrack());
      return false;
    }
    markVideoSourceChanged(track);
    renderLocalVideo();
    syncQualityMonitor();
    announceVideoState();
    // 告知が行き違って相手も同時に始めていたら、ここで1人に収束させる
    resolveShareConflict();
    if (state.screenStream === null) return false;
    notify("vcState", "画面共有を始めました");
    if (state.screen.surface === "monitor") {
      // 止めはしない（利用者の選択を機械が覆さない）。強めに知らせるだけ
      notify("error", "画面全体を共有しています。通知やパスワード入力も映ります");
    }
    return true;
  }

  /**
   * 画面共有を止める（§9-1）。
   * 自前の停止・競合による停止・ブラウザ側からの停止のすべてがここに合流する。
   * 二度呼ばれても壊れないこと（ended と停止ボタンが両方走り得る）。
   */
  async function stopScreenShare(options) {
    if (state.screenStream === null) return false;
    // 「戻す約束」は releaseScreenStream() が消すので、先に控える。
    // restore: false（エンコード不成立での停止）のときは戻さない。この端末が
    // 映像を送り出せなかったのだから、カメラを掴み直すのは筋が通らない
    const restore = options === undefined || options.restore !== false;
    const resume = restore && state.screen.cameraWasOn;
    releaseScreenStream();
    // 共有前にカメラが ON だったなら取り直す（開始時に実際に止めているため）。
    // 失敗しても VC 全体は壊さず、カメラ OFF として整合させて進む
    const restored = resume ? await reacquireCamera() : true;
    // カメラへ戻れたならそちらへ、戻れなければ replaceTrack(null)
    const next = activeVideoTrack();
    await applyVideoTrackAll(next);
    markVideoSourceChanged(next);
    renderLocalVideo();
    syncQualityMonitor();
    announceVideoState();
    if (state.selfId !== null) closeZoom(state.selfId);
    const message = options === undefined || options.message === undefined
      ? "画面共有を止めました"
      : options.message;
    notify(options !== undefined && options.isError === true ? "error" : "vcState", message);
    if (!restored) {
      // 何が起きたかを必ず出す。黙って切のままだと不具合にしか見えない
      notify("error", "カメラに戻せませんでした。カメラは切のままです");
    }
    return false;
  }

  /**
   * 画面共有をやめた後にカメラを取り直す。
   *
   * 【未実測】権限は VC 参加中に一度許可されているので、取り直しで許可の
   * 問い合わせが再び出ることはない**はず**だが、実ブラウザで確かめていない
   * （画面共有の開始にネイティブの選択ダイアログが要るため自動化できない）。
   *
   * 他のアプリがカメラを掴んでいる等で失敗し得る。呼び出し側が「カメラ OFF」
   * として整合を保てるよう、例外は外へ出さず真偽値だけを返す。
   *
   * 取得そのものは acquireCamera() に任せる。共有をやめてから取り直すまでの
   * 数百 ms は「カメラを持っていない」状態なので、その隙に利用者がカメラの
   * ボタンを押すと取得が二重に走り得る。世代管理を1か所に集めておかないと
   * どちらかのストリームが孤児になる。
   */
  async function reacquireCamera() {
    // 卓を離れた後に戻しても意味が無い（ランプだけが点く）
    if (!state.active) return false;
    // 失敗の記録は acquireCamera() が済ませている。busy / stale は
    // 「別の経路がカメラを面倒みている」ということなので、結果コードではなく
    // 「いまカメラを持っているか」で成否を返す（呼び出し側が見たいのはそれ）
    await acquireCamera();
    return state.camStream !== null;
  }

  /**
   * 画面のストリームを手放す。トラックを止め損ねると、ブラウザの
   * 「共有中」バーが残り続ける（§5 T12）。
   */
  function releaseScreenStream() {
    const stream = state.screenStream;
    state.screenStream = null;
    state.screen.surface = null;
    state.screen.profile = state.screen.kind;
    state.screen.demoted = false;
    state.screen.demotedAt = null;
    // 約束は stopScreenShare() が先に控えている。ここで消しておかないと、
    // 品質劣化による停止や退室のあとにカメラを掴み直してしまう
    state.screen.cameraWasOn = false;
    // 選択待ちの開始処理が走っていたら、それを無効にする（世代を進める）
    state.screen.gen += 1;
    if (stream === null) return;
    for (const track of stream.getTracks()) {
      if (typeof track.removeEventListener === "function") {
        track.removeEventListener("ended", onScreenTrackEnded);
        track.removeEventListener("configurationchange", onScreenConfigurationChange);
      }
    }
    stopStream(stream);
  }

  /** ブラウザ側（共有バー）から止められたときの合流点（§9-1・E6） */
  function onScreenTrackEnded() {
    stopScreenShare({ message: "画面共有を止めました" });
  }

  /**
   * 共有中に対象が切り替えられたとき（surfaceSwitching: "include"）。
   * displaySurface は開始時の一度きりでは古くなるので読み直し、
   * 画面全体へ切り替わったのなら §9-1 の警告を出し直す。
   */
  function onScreenConfigurationChange() {
    if (state.screenStream === null) return;
    const track = activeVideoTrack();
    if (track === null) return;
    const surface = readDisplaySurface(track);
    if (surface === state.screen.surface) return;
    state.screen.surface = surface;
    announceVideoState();
    if (surface === "monitor") {
      notify("error", "画面全体を共有しています。通知やパスワード入力も映ります");
    }
  }

  /** getDisplayMedia が返したストリームから音声を落とす（§6.5） */
  function dropAudioTracks(stream) {
    if (typeof stream.getAudioTracks !== "function") return;
    for (const track of stream.getAudioTracks()) {
      try {
        track.stop();
      } catch (e) {
        console.error("VC audio track stop failed:", e);
      }
      if (typeof stream.removeTrack === "function") stream.removeTrack(track);
    }
  }

  /** 実際に選ばれた共有対象。取れなければ null（表示にしか使わない・§4.3） */
  function readDisplaySurface(track) {
    if (typeof track.getSettings !== "function") return null;
    const settings = track.getSettings();
    return typeof settings.displaySurface === "string" ? settings.displaySurface : null;
  }

  /**
   * getDisplayMedia の失敗を文言にする。
   * 利用者の取り消し（NotAllowedError）は異常ではないので、責める文言にしない。
   */
  function shareErrorMessage(error) {
    const name = error === null || error === undefined ? "" : error.name;
    if (name === "NotAllowedError") return "画面共有を取り消しました";
    if (name === "NotFoundError") return "共有できる画面が見つかりませんでした";
    if (name === "AbortError") return "画面共有を始められませんでした";
    return "画面共有を始められませんでした";
  }

  /**
   * 自動停止された映像を本人の操作で再開する（§3.6 の「明示操作でのみ ON」）。
   * 自動復帰は実装しない。これを呼ぶのは UI のボタン操作だけであること。
   */
  async function resumeCamera() {
    clearAutoStop();
    state.quality.prev.clear();
    state.quality.window.clear();
    return await setCamera(true);
  }

  /** 現在の状態（UI の表示更新用） */
  function getState() {
    const peers = [];
    for (const [id, peer] of state.peers) {
      peers.push({
        id,
        nickname: nicknameOf(id),
        polite: peer.polite,
        connectionState: peer.pc.connectionState,
        iceConnectionState: peer.pc.iceConnectionState,
        degraded: peer.degraded === true,
        /** 相手が送っている映像の出どころ。"camera" | "screen" | null */
        videoSource: peer.remoteVideoSource,
      });
    }
    // 共有権はフラグで持たない。常に「今どのピアが screen を告知しているか」
    // から導く（§4.4）。こうしておけば切断・キックで自動的に解ける
    const sharingPeers = sharingPeerIds();
    return {
      active: state.active,
      muted: state.muted,
      camera: state.camStream !== null,
      /**
       * 共有をやめたらカメラに戻るか（共有中のみ意味を持つ）。
       * 共有中はカメラを実際に止めているので camera は false になる。
       * ボタンの文言はこちらを見て描く
       */
      cameraResumes: currentVideoSource() === "screen" && state.screen.cameraWasOn,
      /** 自分が画面を共有中か */
      screen: state.screenStream !== null,
      /** いま送出している映像の出どころ。"none" | "camera" | "screen" */
      videoSource: currentVideoSource(),
      /** この端末で画面共有を始められるか（特徴検出・§2） */
      screenSupported: screenShareSupported(),
      /** 他の人が共有中ならその playerId。誰も共有していなければ null */
      sharingPeerId: sharingPeers.length > 0 ? sharingPeers[0] : null,
      /** 共有中の相手の表示名（ボタンの title に出す） */
      sharingPeerName: sharingPeers.length > 0 ? nicknameOf(sharingPeers[0]) : null,
      /** 共有の内容の種類。"text" | "motion"（§10） */
      screenKind: state.screen.kind,
      eligible: selfEligible(),
      peers,
      quality: {
        autoStopped: state.quality.autoStopped,
        reason: state.quality.reason,
        degradedPeerCount: state.quality.degradedPeerCount,
        canResume: state.quality.recovered,
        mode: state.quality.mode,
        autoStopCount: state.quality.autoStopCount,
      },
    };
  }

  global.VC = {
    init,
    setIceServers,
    handleServerMessage,
    join,
    leave,
    teardown,
    toggleMute,
    setMuted,
    toggleCamera,
    setCamera,
    resumeCamera,
    toggleScreenShare,
    startScreenShare,
    stopScreenShare,
    getState,
    /** テスト用に公開する純粋関数（§3.6 の品質判定） */
    evaluateQuality,
    /** テスト用に公開する純粋関数（画面共有・vc-screenshare.md §11） */
    displayConstraints,
    pickProfile,
    resolveShareOwner,
  };
})(window);
