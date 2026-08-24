/**
 * サンドボックス runner（docs/design/game-sandbox.md §3 / §7 / 付録A）
 *
 * プロトタイプ（proto/game-sandbox ブランチ `proto/public/sandbox/runner.js`）を
 * ベースに、設計書 v0.1 で確定した点に合わせて移植したもの。プロトタイプからの
 * 主な変更点は付録Aのとおり:
 *   - 別オリジン（?appOrigin= クエリ）ではなく同一オリジンの別パスを前提にする
 *     （§2.6 の推奨案 B）。親オリジンは自分の location.href から導出する。
 *   - 自己防衛ガードを追加（§2.6 補償措置3）。
 *   - EN.setScore を廃止し EN.setStatus に一本化（方針3・§3.1）。
 *   - EN.onEnd / EN.now を追加（§3.1）。
 *   - onInput に pointermove（60Hz間引き）/ keyup を追加（§3.2）。
 *   - onStart に joinedLate を追加（§5.3）。
 *   - onStart / EN.youNickname に自分のニックネームを追加（§3.2。peers が自分を含まないため、
 *     ゲームが自分の表示名を知る手段が無かった問題への対応）。
 *
 * 役割はただ一つ、「ユーザーが書いたゲームコードをこの隔離された文書の中で実行すること」。
 * このページは親（アプリ本体）と同一オリジンで配信されるが、
 *   <iframe sandbox="allow-scripts">
 * として埋め込まれる（allow-same-origin を付けない）。そのため、配信元オリジンが
 * 親と同じであっても、この文書自身は「一意の不透明オリジン（opaque origin）」になり、
 *   - 親の DOM / window の中身
 *   - Cookie
 *   - localStorage / sessionStorage / IndexedDB
 * のいずれにも触れない。加えて本ページの CSP で connect-src 'none' を指定しているため、
 * ゲームコードは fetch / WebSocket で外に出ることもできない（§2.1〜§2.4）。
 *
 * したがってゲームコードから外界に届く経路は
 *   「EN.send() → 親への postMessage → 親の WebSocket（sandboxSignal）」
 * だけになる。親はこの経路に来るメッセージをスキーマ検証してから中継する（§4）。
 *
 * 【最重要】ゲームコードを評価するのはこのファイルの loadGame() 1か所だけ。
 * 親（public/room/sandbox.js）は文字列のまま渡すだけで、絶対に評価しない。
 */

"use strict";

(function () {
  /**
   * 親オリジンを自力で導出する（§2.6 の推奨B。/config も ?appOrigin= も使わない）。
   *
   * この文書自身の self.origin / document.origin は sandbox 属性により "null"
   * （不透明オリジン）になるが、location.href はブラウザがこの文書を読み込んだ
   * 実際の URL 文字列を保持しており、その文字列を new URL() で解析して得る origin は
   * 「不透明オリジン」とは無関係な、URL としての scheme+host+port である。
   * 同一オリジン配信（本実装）なら、これは常に親アプリのオリジンと一致する。
   */
  var APP_ORIGIN = new URL(location.href).origin;

  /**
   * 自己防衛ガード（§2.6 補償措置3）。
   * 「この文書が不透明オリジンの子フレームに置かれているか」を確認する。
   * - self.origin === "null"（ブラウザによっては null 値そのもの）: sandbox 属性が
   *   効いていて opaque origin になっていることの確認。sandbox 属性を忘れて
   *   自オリジンでこのページが開かれた場合はここが実オリジンの文字列になり、false になる。
   * - window.parent !== window: 単独のトップレベルとして開かれていないことの確認
   *   （§8.2 #18: /sandbox/runner.html を直接開いた場合はここが false になる）。
   * どちらも満たさない限り、loadGame() はゲームコードを一切評価しない。
   */
  var isolated = (self.origin === "null" || self.origin === null) &&
    window.parent !== window;

  var canvas = document.getElementById("stage");
  var ctx = canvas.getContext("2d");
  var statusEl = document.getElementById("status");

  /** ゲームが登録したコールバック */
  var hooks = {
    start: null,
    peer: null,
    message: null,
    input: null,
    end: null,
    draw: null,
  };

  /** runner の状態 */
  var state = {
    loaded: false, // ゲームコードを評価済みか
    started: false, // onStart を呼んだか
    youId: null,
    youNickname: "", // 自分のニックネーム。start が来るまでは空文字（onStart 発火時には必ず埋まっている）
    isHost: false,
    peers: [],
    joinedLate: false,
    serverOffsetMs: 0, // EN.now() 用。サーバー時刻 - Date.now()（受け取った瞬間の値）
    rafId: null,
    lastFrame: 0,
    lastPointerMoveAt: 0, // pointermove を 60Hz に間引くための直近転送時刻
  };

  /** EN.send のレート制限（トークンバケット）。サーバー側ソフト上限（§4.3 30件/秒）より内側 */
  var RATE_LIMIT_PER_SEC = 30;
  var rate = { tokens: RATE_LIMIT_PER_SEC, last: performance.now(), dropped: 0 };

  /** EN.send の payload サイズ上限（バイト）。サーバー側 SANDBOX_PAYLOAD_MAX_BYTES と同じ値（§4.3） */
  var PAYLOAD_MAX_BYTES = 4 * 1024;

  /** 画面下の状態表示（textContent のみ。innerHTML は使わない。§3.8） */
  function setStatus(text) {
    statusEl.textContent = String(text);
  }

  /** 親へメッセージを送る */
  function toParent(msg) {
    if (window.parent === window) return; // 孤立している場合は送らない
    window.parent.postMessage(msg, APP_ORIGIN);
  }

  /** 親へエラーを伝える。runner 自体は止めない（次のメッセージは受け付ける） */
  function reportError(where, err) {
    var message = where + ": " + (err && err.message ? err.message : String(err));
    setStatus("エラー " + message);
    toParent({ t: "error", message: message });
  }

  /**
   * ゲームコード由来の関数呼び出しを必ずこれで包む（§3.3）。
   * ゲームの例外で runner ごと落ちないようにするのが目的。
   */
  function safeCall(where, fn, args) {
    if (typeof fn !== "function") return;
    try {
      fn.apply(null, args);
    } catch (err) {
      reportError(where, err);
    }
  }

  /** UTF-8 に直したときのバイト数を数える（TextEncoder が無い環境向けの簡易フォールバックは不要。Deno/主要ブラウザは対応済み） */
  function utf8ByteLength(str) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(str).length;
    // フォールバック（実行できない想定だが、無い場合でも例外にはしない）
    return str.length;
  }

  // ---------------------------------------------------------------------------
  // ゲームへ渡す API（グローバル EN。§3.2 確定版）
  // ---------------------------------------------------------------------------

  var EN = {
    /** ゲーム開始時に1回だけ呼ばれる。fn({ youId, youNickname, isHost, peers, joinedLate }) */
    onStart: function (fn) {
      hooks.start = fn;
      // 既に start 情報が来ていた場合（load より先に start が届いたとき）は即座に発火する
      if (state.started && state.youId !== null) {
        safeCall("onStart", fn, [{
          youId: state.youId,
          youNickname: state.youNickname,
          isHost: state.isHost,
          peers: state.peers.slice(),
          joinedLate: state.joinedLate,
        }]);
      }
    },

    /** 参加者の増減。fn({ kind:"join"|"leave", id, nickname }) */
    onPeer: function (fn) {
      hooks.peer = fn;
    },

    /** 他の参加者からのメッセージ。fn(from, msg) */
    onMessage: function (fn) {
      hooks.message = fn;
    },

    /** 入力。fn({ type, x, y, key }) */
    onInput: function (fn) {
      hooks.input = fn;
    },

    /** ホストが終了した / 親が iframe を畳む直前に呼ばれる。fn() */
    onEnd: function (fn) {
      hooks.end = fn;
    },

    /** 毎フレーム呼ばれる描画関数。fn(ctx, dt) dt は秒 */
    draw: function (fn) {
      hooks.draw = fn;
      startLoop();
    },

    /** 同室の全員へ送る（自分には返ってこない）。true=送れた / false=破棄された */
    send: function (msg) {
      if (!allowSend()) return false;
      // 構造化複製できない値（関数・DOM 等）を渡されたときに落ちないようにする
      var encoded;
      try {
        encoded = JSON.stringify(msg);
      } catch (err) {
        reportError("EN.send", err);
        return false;
      }
      if (encoded !== undefined && utf8ByteLength(encoded) > PAYLOAD_MAX_BYTES) {
        // サーバー側も同じ上限（§4.3）で黙って破棄するが、ここで気づけたほうが早い
        toParent({
          t: "log",
          message: "EN.send: payload が " + PAYLOAD_MAX_BYTES + " バイトを超えたため送信しませんでした",
        });
        return false;
      }
      try {
        toParent({ t: "send", msg: msg });
      } catch (err) {
        reportError("EN.send", err);
        return false;
      }
      return true;
    },

    /** 親のヘッダーに短い状態文字列を出す（textContent 描画。80文字で切る） */
    setStatus: function (text) {
      var value = String(text).slice(0, 80);
      toParent({ t: "status", text: value });
    },

    /** 親のログ欄に出す（デバッグ用。500文字で切る） */
    log: function (msg) {
      var text;
      try {
        text = typeof msg === "string" ? msg : JSON.stringify(msg);
      } catch (_err) {
        text = String(msg);
      }
      toParent({ t: "log", message: String(text).slice(0, 500) });
    },

    /** サーバー時刻に補正した epoch ms（全員でほぼ一致する。§3.2） */
    now: function () {
      return Date.now() + state.serverOffsetMs;
    },

    /** canvas の論理サイズ */
    size: { width: canvas.width, height: canvas.height },
  };

  // 自分がホストかどうかは途中で変わりうる（ホスト交代）ので、常に最新を読めるようにする
  Object.defineProperty(EN, "isHost", {
    get: function () {
      return state.isHost;
    },
    enumerable: true,
  });
  Object.defineProperty(EN, "youId", {
    get: function () {
      return state.youId;
    },
    enumerable: true,
  });
  // youId と同じ流儀でプロパティとしても読めるようにする（onStart の引数と二重に持たせる）
  Object.defineProperty(EN, "youNickname", {
    get: function () {
      return state.youNickname;
    },
    enumerable: true,
  });

  /** レート制限。1秒あたり RATE_LIMIT_PER_SEC 件まで */
  function allowSend() {
    var now = performance.now();
    rate.tokens = Math.min(
      RATE_LIMIT_PER_SEC,
      rate.tokens + ((now - rate.last) / 1000) * RATE_LIMIT_PER_SEC,
    );
    rate.last = now;
    if (rate.tokens < 1) {
      rate.dropped += 1;
      // 通知そのものが洪水にならないよう、しきい値を跨いだ時だけ知らせる
      if (rate.dropped === 1 || rate.dropped % 60 === 0) {
        toParent({
          t: "log",
          message: "送信レート上限（" + RATE_LIMIT_PER_SEC + "件/秒）で破棄: " +
            rate.dropped + "件",
        });
      }
      return false;
    }
    rate.tokens -= 1;
    return true;
  }

  // ---------------------------------------------------------------------------
  // 描画ループ
  // ---------------------------------------------------------------------------

  function startLoop() {
    if (state.rafId !== null) return;
    state.lastFrame = performance.now();
    var step = function (now) {
      state.rafId = requestAnimationFrame(step);
      var dt = (now - state.lastFrame) / 1000;
      state.lastFrame = now;
      // dt が跳ねる（タブ復帰など）とゲーム側の計算が壊れやすいので上限を設ける
      if (dt > 0.1) dt = 0.1;
      safeCall("draw", hooks.draw, [ctx, dt]);
    };
    state.rafId = requestAnimationFrame(step);
  }

  function stopLoop() {
    if (state.rafId === null) return;
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }

  // ---------------------------------------------------------------------------
  // 入力
  // ---------------------------------------------------------------------------

  /** マウス／タッチ座標を canvas の論理座標へ直す */
  function toCanvasPoint(event) {
    var rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  canvas.addEventListener("pointerdown", function (event) {
    event.preventDefault();
    var p = toCanvasPoint(event);
    safeCall("onInput", hooks.input, [{ type: "pointerdown", x: p.x, y: p.y, key: null }]);
  });

  canvas.addEventListener("pointerup", function (event) {
    event.preventDefault();
    var p = toCanvasPoint(event);
    safeCall("onInput", hooks.input, [{ type: "pointerup", x: p.x, y: p.y, key: null }]);
  });

  // pointermove は 60Hz（約16.7ms間隔）に間引く（§3.2）。素通しすると高頻度になりすぎる
  canvas.addEventListener("pointermove", function (event) {
    var now = performance.now();
    if (now - state.lastPointerMoveAt < 16) return;
    state.lastPointerMoveAt = now;
    var p = toCanvasPoint(event);
    safeCall("onInput", hooks.input, [{ type: "pointermove", x: p.x, y: p.y, key: null }]);
  });

  window.addEventListener("keydown", function (event) {
    // ブラウザのショートカットまで奪わないよう、修飾キー付きは無視する
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === " ") event.preventDefault();
    safeCall("onInput", hooks.input, [{ type: "key", x: 0, y: 0, key: event.key }]);
  });

  window.addEventListener("keyup", function (event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    safeCall("onInput", hooks.input, [{ type: "keyup", x: 0, y: 0, key: event.key }]);
  });

  // ---------------------------------------------------------------------------
  // 親からのメッセージ
  // ---------------------------------------------------------------------------

  /**
   * 送信元の検証（§3.3）。判定の主は event.source（同一性検証。偽装できない）。
   * 同一オリジン構成では event.origin も自オリジンと一致するはずなので、
   * 追加の多層防御として合わせて確認する（片方だけより強い）。
   */
  function verifySource(event) {
    if (event.source !== window.parent) return false;
    return event.origin === APP_ORIGIN;
  }

  /** peers 配列のスキーマ検証。壊れた要素は落とす */
  function normalizePeers(value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    for (var i = 0; i < value.length; i += 1) {
      var p = value[i];
      if (p === null || typeof p !== "object") continue;
      if (typeof p.id !== "string") continue;
      out.push({ id: p.id, nickname: typeof p.nickname === "string" ? p.nickname : "" });
    }
    return out;
  }

  window.addEventListener("message", function (event) {
    if (!verifySource(event)) return;
    var data = event.data;
    if (data === null || typeof data !== "object") return;
    if (typeof data.t !== "string") return;

    switch (data.t) {
      case "load":
        if (typeof data.code !== "string") return;
        loadGame(data.code);
        break;

      case "start":
        if (typeof data.youId !== "string") return;
        state.youId = data.youId;
        // 親から来なかった／型が違う場合は既存ゲームと同じ「playerId 先頭6文字」にフォールバックする
        state.youNickname = typeof data.youNickname === "string" && data.youNickname.length > 0
          ? data.youNickname
          : state.youId.slice(0, 6);
        state.isHost = data.isHost === true;
        state.peers = normalizePeers(data.peers);
        state.joinedLate = data.joinedLate === true;
        if (typeof data.serverTimeOffsetMs === "number" && Number.isFinite(data.serverTimeOffsetMs)) {
          state.serverOffsetMs = data.serverTimeOffsetMs;
        }
        if (!state.started) {
          state.started = true;
          setStatus("開始: " + (state.isHost ? "あなたはホストです" : "参加者") +
            (state.joinedLate ? "（途中参加）" : ""));
          safeCall("onStart", hooks.start, [{
            youId: state.youId,
            youNickname: state.youNickname,
            isHost: state.isHost,
            peers: state.peers.slice(),
            joinedLate: state.joinedLate,
          }]);
        }
        break;

      // サーバー時刻補正の更新（再接続時などに親から送られる。EN.now() 用）
      case "time":
        if (typeof data.offsetMs !== "number" || !Number.isFinite(data.offsetMs)) return;
        state.serverOffsetMs = data.offsetMs;
        break;

      case "peer":
        if (data.kind !== "join" && data.kind !== "leave") return;
        if (typeof data.id !== "string") return;
        var nickname = typeof data.nickname === "string" ? data.nickname : "";
        if (data.kind === "join") {
          if (!state.peers.some(function (p) { return p.id === data.id; })) {
            state.peers.push({ id: data.id, nickname: nickname });
          }
        } else {
          state.peers = state.peers.filter(function (p) { return p.id !== data.id; });
        }
        safeCall("onPeer", hooks.peer, [{ kind: data.kind, id: data.id, nickname: nickname }]);
        break;

      case "host":
        // ホスト交代。ゲーム側は EN.isHost を読めば常に最新が取れる
        if (typeof data.id !== "string") return;
        state.isHost = data.id === state.youId;
        setStatus(state.isHost ? "ホストになりました" : "ホストが交代しました");
        break;

      case "message":
        if (typeof data.from !== "string") return;
        safeCall("onMessage", hooks.message, [data.from, data.msg]);
        break;

      case "end":
        // ホストが終了した／親がこの iframe を畳む直前の通知。ゲーム側の後片付けの機会を与える
        safeCall("onEnd", hooks.end, []);
        stopLoop();
        break;

      default:
        break;
    }
  });

  /**
   * ゲームコードを評価する。
   * new Function を使うのはこの1か所だけ。親は絶対にコードを評価しない（§10-5）。
   *
   * 注意: new Function はスコープを閉じない（§7.2）。ゲームは window にも触れるが、
   * その window は不透明オリジンの空の文書のものなので実害は無い、という前提。
   * ここでの隔離はあくまで「オリジン境界（opaque origin）」と CSP によるもので、
   * 「EN しか見えない」という変数スコープの隔離ではない。
   */
  function loadGame(code) {
    // 自己防衛ガード（§2.6 補償措置3）。隔離された子フレームでなければ一切評価しない
    if (!isolated) {
      setStatus("隔離されていない文脈では実行しません");
      return;
    }
    if (state.loaded) {
      // 二重読み込みは描画ループやリスナが二重になるので拒否する（iframe を作り直すのが正しい手順）
      toParent({ t: "log", message: "ゲームは既に読み込み済みです（再読込は iframe を作り直してください）" });
      return;
    }
    state.loaded = true;
    setStatus("ゲーム読み込み中…");
    try {
      var factory = new Function("EN", '"use strict";\n' + code + "\n//# sourceURL=user-game.js");
      factory(EN);
      setStatus("ゲーム読み込み完了");
      toParent({ t: "log", message: "runner: ゲームコードを読み込みました" });
    } catch (err) {
      reportError("ゲームコードの読み込み", err);
    }
  }

  // ゲームコードが投げっぱなしにした非同期例外も拾って親に伝える（§3.3）
  window.addEventListener("error", function (event) {
    reportError("未捕捉の例外", event.error || event.message);
  });
  window.addEventListener("unhandledrejection", function (event) {
    reportError("未処理の Promise 拒否", event.reason);
  });

  // 準備完了を親に伝える。隔離されていない場合はその旨を表示するだけで、
  // 何もできることは無い（親からの load を待たない）
  if (isolated) {
    setStatus("待機中（ゲーム未読み込み）");
    toParent({ t: "ready" });
  } else {
    setStatus("隔離されていない文脈です（sandbox 属性なしで埋め込まれた可能性があります）");
  }
})();
