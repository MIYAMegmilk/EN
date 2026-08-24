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
   */

  /**
   * ICE サーバー設定。現状は公開 STUN のみ（§3.6）。
   * TURN（coturn）導入後は、サーバーが .env から読んだ認証情報を
   * roomState 等で配り、setIceServers() で差し替える想定。
   * 認証情報はクライアント配布物に埋め込まない（§3.8）。
   */
  const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

  /** 外から注入される設定 */
  const config = {
    send: null,
    container: null,
    onStatus: null,
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

  /** 自分のカメラ映像の表示を更新する */
  function renderLocalVideo() {
    if (config.container === null) return;
    if (state.camStream === null) {
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
      label.textContent = "あなた（カメラ）";
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      // 自分の映像はハウリング防止のため必ずミュートする
      video.muted = true;
      video.className = "vc-video";
      root.appendChild(label);
      root.appendChild(video);
      config.container.appendChild(root);
      state.localVideo = { root, video };
    }
    state.localVideo.video.srcObject = state.camStream;
    tryPlay(state.localVideo.video);
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
    };
    state.peers.set(playerId, peer);
    peer.view.audio.srcObject = peer.stream;

    for (const track of localTracks()) {
      pc.addTrack(track, track.kind === "video" ? state.camStream : state.micStream);
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
    const live = peer.stream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);
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
    peer.closed = true;
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
  // 公開 API
  // -------------------------------------------------------------------------

  /** 送信関数・表示先・状態通知を注入する */
  function init(options) {
    config.send = options.send;
    config.container = options.container ?? null;
    config.onStatus = options.onStatus ?? null;
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
    notify("vcState", "VC に参加しました");
    announceReady();
    return true;
  }

  /** VC から抜ける。ピアもマイク・カメラもすべて止める */
  function leave() {
    if (!state.active) return;
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
   * ON は既存の全ピアに addTrack、OFF は removeTrack して再ネゴシエーションする。
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
        peer.pc.addTrack(track, state.camStream);
      }
      renderLocalVideo();
      notify("vcState", "カメラを ON にしました");
      return true;
    }
    if (state.camStream === null) return false;
    for (const peer of state.peers.values()) {
      for (const sender of peer.pc.getSenders()) {
        if (sender.track !== null && sender.track.kind === "video") {
          peer.pc.removeTrack(sender);
        }
      }
    }
    stopStream(state.camStream);
    state.camStream = null;
    renderLocalVideo();
    notify("vcState", "カメラを OFF にしました");
    return false;
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
      });
    }
    return {
      active: state.active,
      muted: state.muted,
      camera: state.camStream !== null,
      eligible: selfEligible(),
      peers,
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
    getState,
  };
})(window);
