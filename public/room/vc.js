/**
 * VC（音声）・カメラモジュール
 * 詳細仕様書 §3.6 / §3.8 / §8 に対応する。
 *
 * 責務:
 *   - ルーム内の VC 対象者（vcEligible）とのフルメッシュ P2P 接続
 *   - MDN の Perfect Negotiation パターンによるオファー衝突の解消
 *   - マイクのミュート、カメラの ON/OFF（初期 OFF・§3.6）
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
   *   { kind: "video",   on }                    … 自分の映像送出の ON / OFF
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

  /** 外から注入される設定 */
  const config = {
    send: null,
    container: null,
    onStatus: null,
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
    /** 自分の接続世代。join のたびに新しくする */
    session: null,
    /** マイクの MediaStream */
    micStream: null,
    /** カメラの MediaStream */
    camStream: null,
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
      /** カメラを ON にした時刻（ウォームアップ判定用） */
      camOnAt: null,
      /** カメラ ON 時の要求 FPS。実効 FPS の比率を出す分母になる */
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

  /** 送出中のローカルトラック（マイク＋カメラ） */
  function localTracks() {
    const tracks = [];
    if (state.micStream !== null) tracks.push(...state.micStream.getAudioTracks());
    if (state.camStream !== null) tracks.push(...state.camStream.getVideoTracks());
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

    root.appendChild(label);
    root.appendChild(video);
    root.appendChild(audio);
    if (config.container !== null) config.container.appendChild(root);
    return { root, label, audio, video };
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
      root.appendChild(label);
      root.appendChild(video);
      config.container.appendChild(root);
      state.localVideo = { root, video };
    }
    const video = state.localVideo.video;
    if (state.camStream === null) {
      video.hidden = true;
      video.srcObject = null;
      return;
    }
    video.hidden = false;
    video.srcObject = state.camStream;
    tryPlay(video);
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
    };
    state.peers.set(playerId, peer);
    peer.view.audio.srcObject = peer.stream;

    for (const track of localTracks()) {
      const sender = pc.addTrack(track, track.kind === "video" ? state.camStream : state.micStream);
      if (track.kind === "video") peer.videoSender = sender;
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
        onVideoState(from, payload.on === true);
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
  function onVideoState(from, on) {
    const peer = state.peers.get(from);
    if (peer === undefined) return;
    peer.remoteVideoOff = !on;
    updateVideoVisibility(peer);
  }

  /** 自分の映像送出の ON / OFF を全ピアへ伝える */
  function announceVideoState(on) {
    for (const id of state.peers.keys()) signal(id, { kind: "video", on });
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
    if (peer !== undefined) peer.view.label.textContent = player.nickname;
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
    };
    const pairs = [];
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
      } else if (s.type === "transport" && typeof s.selectedCandidatePairId === "string") {
        selectedPairId = s.selectedCandidatePairId;
      } else if (s.type === "candidate-pair") {
        pairs.push(s);
      }
    });
    const pair = pickCandidatePair(pairs, selectedPairId);
    if (pair !== null) {
      if (typeof pair.currentRoundTripTime === "number") raw.rtt = pair.currentRoundTripTime;
      if (typeof pair.availableOutgoingBitrate === "number") {
        raw.outgoingBitrate = pair.availableOutgoingBitrate;
      }
    }
    return raw;
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

  /** ウォームアップを過ぎて判定に使ってよいピアか */
  function isWarmedUp(peer, now) {
    if (state.quality.camOnAt === null) return false;
    if (now - state.quality.camOnAt < QUALITY_CAMERA_WARMUP_MS) return false;
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
      videoActive: state.camStream !== null,
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
      const reports = await Promise.all(peers.map((peer) => readStats(peer)));
      for (let i = 0; i < peers.length; i += 1) {
        const peer = peers[i];
        const report = reports[i];
        // 待っている間に閉じたピアのぶんは捨てる
        if (report === null || peer.closed) continue;
        const raw = extractRawStats(report, now);
        pushSample(peer.id, buildSample(peer, raw, now));
        state.quality.prev.set(peer.id, raw);
      }
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
    if (sample.fpsRatio !== null && sample.fpsRatio < QUALITY_FPS_RESUME_RATIO) return false;
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
   *   { at:number, warmedUp:boolean, videoActive:boolean,
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

  /**
   * 品質劣化で映像だけを止める。音声は触らない（音声優先・§3.6）。
   * setCamera(false) は使わない。あちらは各ピアで removeTrack して
   * 再ネゴシエーションを起こすため、帯域が枯れている状況では逆効果になる。
   * replaceTrack(null) なら再ネゴシエーションは不要（MDN）。
   */
  function stopVideoForQuality(reason) {
    if (state.camStream === null) return;
    for (const peer of state.peers.values()) {
      if (peer.videoSender === null) continue;
      const replaced = peer.videoSender.replaceTrack(null);
      if (replaced !== undefined && typeof replaced.catch === "function") {
        replaced.catch((e) => console.error("VC replaceTrack failed:", e));
      }
    }
    // カメラの LED を消すためにトラック自体も止める（§3.7 の趣旨）
    stopStream(state.camStream);
    state.camStream = null;
    renderLocalVideo();
    state.quality.autoStopped = true;
    state.quality.reason = reason;
    state.quality.stoppedAt = Date.now();
    state.quality.autoStopCount += 1;
    state.quality.recovered = false;
    announceVideoState(false);
    // 停止後も監視は続ける。回復を検知して通知するため（映像は戻さない）。
    // cpu は回線の問題ではないので文言を分ける（実態と合わせるため）
    notify(
      "quality",
      reason === "cpu"
        ? "端末の負荷が高いため映像を停止しました"
        : "回線が不安定なため映像を停止しました",
    );
  }

  /** 品質監視を始める。カメラ ON 中と自動停止中だけ動かす（電池・CPU 対策） */
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
    state.quality.camOnAt = null;
    state.quality.requestedFps = null;
    state.quality.mode = "unknown";
  }

  // -------------------------------------------------------------------------
  // 公開 API
  // -------------------------------------------------------------------------

  /** 送信関数・表示先・状態通知を注入する */
  function init(options) {
    config.send = options.send;
    config.container = options.container ?? null;
    config.onStatus = options.onStatus ?? null;
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
    try {
      state.micStream = await global.navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (e) {
      console.error("VC getUserMedia failed:", e);
      notify("error", "マイクを使用できませんでした。音声なしで参加します");
      return false;
    }
    state.active = true;
    state.muted = false;
    state.session = randomId();
    // カメラが切でも自分の枠を出す（着席したことが画面で分かるように）
    renderLocalVideo();
    notify("vcState", "VC に参加しました");
    announceReady();
    return true;
  }

  /** VC から抜ける。ピアもマイク・カメラもすべて止める */
  function leave() {
    if (!state.active) return;
    // タイマーを残さないよう、ピアを畳む前に監視を止める
    resetQuality();
    for (const id of state.peers.keys()) signal(id, { kind: "bye" });
    closeAllPeers();
    stopStream(state.micStream);
    state.micStream = null;
    stopStream(state.camStream);
    state.camStream = null;
    renderLocalVideo();
    state.active = false;
    state.muted = false;
    state.session = null;
    notify("vcState", "VC から退出しました");
  }

  /** MediaStream のトラックをすべて停止する */
  function stopStream(stream) {
    if (stream === null) return;
    for (const track of stream.getTracks()) track.stop();
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

  /** カメラを切り替える。戻り値は切り替え後の状態 */
  function toggleCamera() {
    return setCamera(state.camStream === null);
  }

  /**
   * カメラの ON / OFF（初期 OFF・本人の明示操作でのみ ON、§3.6）。
   * ON は既存の全ピアへ映像を載せ、OFF は removeTrack して再ネゴシエーションする。
   * ON 中は品質監視を動かす（§3.6 の映像自動停止）。
   */
  async function setCamera(on) {
    if (!state.active) {
      notify("error", "先に VC に参加してください");
      return false;
    }
    if (on === true) {
      if (state.camStream !== null) return true;
      try {
        state.camStream = await global.navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { width: { ideal: 640 }, height: { ideal: 360 } },
        });
      } catch (e) {
        console.error("VC camera failed:", e);
        notify("error", "カメラを使用できませんでした");
        return false;
      }
      const track = state.camStream.getVideoTracks()[0];
      if (track === undefined) {
        stopStream(state.camStream);
        state.camStream = null;
        return false;
      }
      for (const peer of state.peers.values()) {
        if (peer.videoSender !== null) {
          // 自動停止で外した sender は使い回す（再ネゴシエーションを避ける）
          try {
            await peer.videoSender.replaceTrack(track);
          } catch (e) {
            console.error("VC replaceTrack failed:", e);
          }
        } else {
          peer.videoSender = peer.pc.addTrack(track, state.camStream);
        }
      }
      renderLocalVideo();
      // 要求 FPS は ON の時点で一度だけ控える。以後の実効 FPS の分母になる。
      // getSettings() を持たない／frameRate を返さないブラウザではここが null になり、
      // fpsRatio が出せずフォールバック判定が働かなくなる（buildSample のコメント参照）
      const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
      state.quality.requestedFps = typeof settings.frameRate === "number" ? settings.frameRate : null;
      state.quality.camOnAt = Date.now();
      startQualityMonitor();
      announceVideoState(true);
      notify("vcState", "カメラを ON にしました");
      return true;
    }
    // 本人が明示的に OFF にしたので、自動停止の追跡も終わらせる
    stopQualityMonitor();
    clearAutoStop();
    state.quality.camOnAt = null;
    state.quality.requestedFps = null;
    if (state.camStream === null) return false;
    for (const peer of state.peers.values()) {
      for (const sender of peer.pc.getSenders()) {
        if (sender.track !== null && sender.track.kind === "video") {
          peer.pc.removeTrack(sender);
          if (peer.videoSender === sender) peer.videoSender = null;
        }
      }
    }
    stopStream(state.camStream);
    state.camStream = null;
    renderLocalVideo();
    announceVideoState(false);
    notify("vcState", "カメラを OFF にしました");
    return false;
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
      });
    }
    return {
      active: state.active,
      muted: state.muted,
      camera: state.camStream !== null,
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
    toggleMute,
    setMuted,
    toggleCamera,
    setCamera,
    resumeCamera,
    getState,
    /** テスト用に公開する純粋関数（§3.6 の品質判定） */
    evaluateQuality,
  };
})(window);
