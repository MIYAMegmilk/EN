/**
 * ビューモジュールの雛形（docs/design/games-unified.md §3.2 / §7-5）
 * 新しいゲームの表示を作るときは、このファイルを
 * `public/room/games/<ゲームID>.js` へコピーして書き換える。
 * （このファイル自体はカタログ（server/games/index.ts）に載せない。読み込まれることは無い）
 *
 * 位置づけ:
 * ゲームの状態機械はすべてサーバー（server/games/<id>.ts）にある。
 * このファイルは「サーバーから届いた view をそのまま絵にする」だけの表示専用モジュールで、
 * ルーム UI（app.js）がゲーム開始時に動的 import して mount() を呼ぶ。
 *
 * サーバーとの契約（§2.2）:
 *   C2S: { t: "gameEvent", payload }        … api.send(payload) が payload を包んで送る
 *   S2C: { t: "gameView", gameId, view, deadline } … update(view, deadline) に渡ってくる
 *
 * ---- このディレクトリ共通の規約（§3.2 / §7 / CLAUDE.md セキュリティ基準）----
 *
 * 1. 【表示】ユーザー由来のテキスト（ニックネーム・回答・お題など）は必ず textContent で描く。
 *    innerHTML は使わない。要素は document.createElement で組み立てる。
 * 2. 【音】音を出さない。ルームでは VC の会話が同時に流れているため、
 *    効果音・BGM で会話にかぶせない（game-sandbox.md §5.4 の方針を引き継ぐ）。
 * 3. 【後始末】unmount() で setInterval / setTimeout / addEventListener /
 *    requestAnimationFrame をすべて解除する。ゲームは何度でも開始・終了されうるので、
 *    残ったタイマーはそのまま二重動作になる。
 * 4. 【サーバーが唯一の状態機械】勝敗・進行・残り人数などをクライアントで判断しない。
 *    view に書いてあることだけを描く。ローカルに「たぶんこうなるはず」の状態を持たない。
 *    （入力欄の中身のような、純粋に表示上の一時値だけは持ってよい）
 * 5. 【update は何度でも呼ばれる】同じ view で再度呼ばれることがある。
 *    毎回まるごと作り直すと入力欄の値やフォーカスが飛ぶので、
 *    骨組みは mount() で1度だけ作り、update() では中身（textContent・disabled 等）だけ変える。
 * 6. 【送信の検証】送る前にクライアント側でも値を検証する（無駄な往復を減らすため）。
 *    ただし本当の検証はサーバーの責務であり、ここでの検証は防御ではない。
 */

/**
 * ビューを組み立てる。
 * @param {HTMLElement} container 専用の空要素（この中だけを触ってよい）
 * @param {{
 *   send: (payload: unknown) => void,   // C2S gameEvent の payload を送る
 *   youId: string,                      // 自分の playerId
 *   isHost: boolean,                    // 自分がホストか（mount 時点の値）
 *   serverNow: () => number,            // サーバー時刻に補正した現在時刻（epoch ms）
 * }} api
 */
export function mount(container, api) {
  // --- 骨組みは1度だけ作る（規約5） ---
  const root = document.createElement("div");
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "8px";

  const titleEl = el("h3", "ゲーム名");
  titleEl.style.margin = "0";
  root.appendChild(titleEl);

  /** サーバーの view から作る状態表示 */
  const statusEl = el("p", "");
  statusEl.style.margin = "0";
  root.appendChild(statusEl);

  /** 残り時間（deadline が来ているときだけ出す） */
  const timerEl = el("p", "");
  timerEl.style.margin = "0";
  timerEl.style.opacity = "0.8";
  root.appendChild(timerEl);

  const actionBtn = el("button", "おす");
  actionBtn.type = "button";
  actionBtn.className = "btn"; // index.html 定義済みの汎用クラス
  actionBtn.style.alignSelf = "flex-start";
  root.appendChild(actionBtn);

  container.appendChild(root);

  // --- 状態（表示のためだけの一時値。ゲームの状態はサーバーが持つ。規約4） ---
  /** 直近の deadline（epoch ms）。null なら期限なし */
  let deadline = null;

  // --- 操作（リスナは unmount で外せるよう名前付き関数にする。規約3） ---
  function onAction() {
    // 送る payload の形はサーバーモジュールとの取り決め。
    // 検証（範囲・型）はここでも軽く行い、不正ならその場で知らせて送らない（規約6）
    api.send({ k: "tap" });
  }
  actionBtn.addEventListener("click", onAction);

  // --- 秒読み（1秒ごとに残りを描き直す。api.serverNow() を使う） ---
  function renderTimer() {
    if (deadline === null) {
      timerEl.textContent = "";
      return;
    }
    const left = Math.max(0, Math.ceil((deadline - api.serverNow()) / 1000));
    timerEl.textContent = `残り約 ${left} 秒`;
  }
  const timerId = setInterval(renderTimer, 1000);

  return {
    /**
     * サーバーから届いた view を描く。
     * @param {unknown} view gameView.view（形はゲームごとの取り決め）
     * @param {number|null} nextDeadline 期限（epoch ms）。null なら期限なし
     */
    update(view, nextDeadline) {
      deadline = typeof nextDeadline === "number" ? nextDeadline : null;
      // view は外から来るデータなので、形を確かめてから使う
      const phase = view !== null && typeof view === "object" && typeof view.phase === "string"
        ? view.phase
        : "";
      statusEl.textContent = `フェーズ: ${phase}`;
      renderTimer();
    },

    /** タイマー・リスナを片付ける（規約3） */
    unmount() {
      clearInterval(timerId);
      actionBtn.removeEventListener("click", onAction);
      clear(container);
    },
  };
}

/** テキストだけを持つ要素を作る（chat.js / sandbox.js と同じ方式。innerHTML は使わない） */
function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** 子要素をすべて取り除く */
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
