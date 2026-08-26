/**
 * ゲーム1本の雛形（設計書 docs/design/games-unified.md §7）
 * 新しいゲームを作るときは、このファイルを `public/room/games/<ゲームID>.js` へ
 * コピーして書き換える。
 * （このファイル自体はカタログ（server/games/index.ts）に載せない。読み込まれることは無い）
 *
 * =========================================================================
 *  ★ 最初に読む: このファイルだけで作るか、サーバーにも書くか
 * =========================================================================
 *
 * 既定は **このファイル1つだけ**（クライアント専用ゲーム）。
 * `server/games/index.ts` の GAME_MODULES に `clientGame({ id: "<ゲームID>", ... })` を
 * 1行足せば、それで一覧に出て開始・終了できる。サーバーのコードは書かない。
 *
 * **次の3つのどれかに当てはまるときだけ**、`server/games/<id>.ts`（専用モジュール）が要る。
 *
 *   ① 参加者ごとに **違う情報を配る**（＝秘密がある）
 *      → ワードウルフの役職、出題者だけが知っているお題、伏せた回答 など
 *   ② その点を **宴の公式スコア**（参加者一覧に出る得点）に載せたい
 *   ③ 途中参加・再接続した人に **それまでの経過を完全に復元**して見せたい
 *
 * どれにも当てはまらないなら、このファイル1つで書く。
 *
 * ---- ★★ クライアント専用ゲームは「秘密」を一切持てない ★★ ----
 *
 * `api.send(payload)` で送ったものは、**同じ卓の全員にそのまま配られる**。
 * サーバーは中身を読まないし、受信者ごとに絞り込みもしない。
 * つまり:
 *
 *   - 「正解を隠す」……できない（隠したつもりでも全員の view に載る）
 *   - 「役職を配る」……できない（配った先以外にも見える）
 *   - 「自分だけが知っている情報」……作れない
 *
 * **これは制約ではなく、この経路の定義そのもの。**
 * 「これは他の人に見えたら成立しないな」と一瞬でも思ったら、その時点で
 * `server/games/<id>.ts` を書く（＝上の①）。
 * ごまかそうとしない。難読化・暗号化・「クライアントで隠す」はすべて破られる。
 *
 * ---- 通信が要るときに、まず考えること ----
 *
 * `view.seed` と `view.startedAt` は **卓の全員に同じ値**が配られる。
 * 「出題の順番」「何秒後に合図するか」「盤面の並び」は、`createRng(view.seed)` から
 * 各自が同じ計算で導けば **通信ゼロで一致する**（reflex.js / emoawase.js がその例）。
 * 中継は「人に見せたい結果」（自分の得点・自分のタイム）だけに絞ると、格段に軽い。
 *
 * ---- 位置づけ（サーバーモジュール付きの場合）----
 *
 * ①〜③ に当てはまってサーバーモジュールを書いた場合、ゲームの状態機械はすべて
 * サーバー（server/games/<id>.ts）にある。このファイルは「サーバーから届いた view を
 * そのまま絵にする」だけの表示専用モジュールになる。
 *
 * サーバーとの契約（§2.2。どちらの作り方でも同じ）:
 *   C2S: { t: "gameEvent", payload }        … api.send(payload) が payload を包んで送る
 *   S2C: { t: "gameView", gameId, view, deadline } … update(view, deadline) に渡ってくる
 *
 * =========================================================================
 *  このディレクトリ共通の規約（§3.2 / §7 / CLAUDE.md セキュリティ基準）
 * =========================================================================
 *
 * 1. 【表示】ユーザー由来のテキスト（ニックネーム・回答・お題など）は必ず textContent で描く。
 *    innerHTML は使わない。要素は document.createElement で組み立てる（_client.js の el()）。
 * 2. 【音】音を出さない。ルームでは VC の会話が同時に流れているため、
 *    効果音・BGM で会話にかぶせない。
 * 3. 【後始末】unmount() で setInterval / setTimeout / addEventListener /
 *    requestAnimationFrame をすべて解除する。ゲームは何度でも開始・終了されうるので、
 *    残ったタイマーはそのまま二重動作になる。
 * 4. 【状態の持ち主】サーバーモジュールを書いたなら、勝敗・進行をクライアントで判断しない
 *    （view に書いてあることだけを描く）。クライアント専用ゲームは逆に、進行を自分で持つ。
 *    どちらなのかを混ぜない。
 * 5. 【update は何度でも呼ばれる】同じ view で再度呼ばれることがある。
 *    毎回まるごと作り直すと入力欄の値やフォーカスが飛ぶので、
 *    骨組みは mount() で1度だけ作り、update() では中身（textContent・disabled 等）だけ変える。
 * 6. 【送信の検証】送る前にクライアント側でも値を検証する（無駄な往復を減らすため）。
 *    ただし本当の検証はサーバーの責務であり、ここでの検証は防御ではない。
 * 7. 【★ 他人から届く payload は必ず形を確かめる ★】
 *    クライアント専用ゲームの中継 payload は、**サーバーが素通しする**。
 *    出どころは他の参加者のブラウザであり、改造クライアントは任意の値を送れる。
 *    受け取る側で `kindOf()` / `intField()` などで形を確かめ、**想定外なら黙って捨てる**。
 *    `view.events[].payload` を検証せずに使うと、1人の細工で卓の全員の画面が固まる。
 *    これが最悪の壊れ方なので、ここだけは手を抜かない。
 * 8. 【画像】画像は `public/assets/games/<ゲームID>/` に置き、
 *    `/assets/games/<ゲームID>/<名前>.svg` で読む。本体の CSP は `img-src 'self' data:` なので
 *    追加設定は要らない。素材を足したら `public/assets/games/CREDITS.md` の表に必ず1行足す
 *    （再配布の可否が確認できない素材は置かない）。
 * 9. 【点は付かない】クライアント専用ゲームの得点は自己申告なので、宴の公式スコアには
 *    入らない。_client.js の createShell() を使えば、その断り書きが自動で出る。
 */

import {
  clear,
  createRelayReader,
  createRng,
  createShell,
  el,
  intField,
  kindOf,
  nameOf,
  readNumber,
} from "./_client.js";

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
  // createShell は見出し・「点は付かない」の断り書き・状態行を用意してくれる（規約9）
  const shell = createShell(container, "ゲーム名");

  const actionBtn = el("button", "おす");
  actionBtn.type = "button";
  actionBtn.className = "btn"; // index.html 定義済みの汎用クラス
  shell.body.appendChild(actionBtn);

  /** 卓に流れた出来事の一覧（表示用） */
  const logList = el("ul");
  logList.style.margin = "6px 0 0";
  logList.style.paddingLeft = "1.2em";
  shell.root.appendChild(logList);

  // --- 状態（クライアント専用ゲームなら、進行はここが持つ） ---
  /** 中継ログの差分だけを取り出す器 */
  const relay = createRelayReader();
  /** 直近の deadline（epoch ms）。null なら期限なし（サーバーモジュール併用時のみ来る） */
  let deadline = null;
  /** 最後に受け取った view（名簿を引くのに使う） */
  let lastView = null;
  /** 卓に流れた出来事 [{ name, value }] */
  const entries = [];

  // --- 操作 -----------------------------------------------------------------
  function onAction() {
    // 送る payload の形は「このゲームの中だけの取り決め」。サーバーは中身を見ない。
    // 短いキー名にすると中継ログ（view）が太らず、配信量が減る
    api.send({ k: "tap", v: 1 });
  }
  actionBtn.addEventListener("click", onAction);

  // --- 秒読み（1秒ごとに残りを描き直す。api.serverNow() を使う） ---
  function renderTimer() {
    if (deadline === null) {
      shell.status.textContent = `${entries.length}件`;
      return;
    }
    const left = Math.max(0, Math.ceil((deadline - api.serverNow()) / 1000));
    shell.status.textContent = `残り約 ${left} 秒`;
  }
  const timerId = setInterval(renderTimer, 1000);

  /** 出来事の一覧を描き直す。名前はユーザー由来なので textContent（規約1） */
  function renderLog() {
    clear(logList);
    for (const entry of entries) {
      logList.appendChild(el("li", `${entry.name}: ${entry.value}`));
    }
  }

  return {
    /**
     * サーバーから届いた view を描く。
     * @param {unknown} view gameView.view
     * @param {number|null} nextDeadline 期限（epoch ms）。null なら期限なし
     */
    update(view, nextDeadline) {
      deadline = typeof nextDeadline === "number" ? nextDeadline : null;
      lastView = view;

      // 全員で揃えたい進行は seed から導く（通信しない）。使わないなら消してよい
      const rng = createRng(readNumber(view, "seed", 0));
      void rng;

      // ★ 他人から届く payload は必ず形を確かめる（規約7）★
      let changed = false;
      for (const event of relay.take(view)) {
        if (event.from === api.youId) continue; // 自分のぶんは送った時点で反映済み
        if (kindOf(event.payload) !== "tap") continue; // 知らない種別は黙って捨てる
        const value = intField(event.payload, "v", 0, 9999); // 範囲外・型違いも捨てる
        if (value === null) continue;
        entries.push({ name: nameOf(view, event.from), value });
        changed = true;
      }
      if (changed) renderLog();
      renderTimer();
    },

    /** タイマー・リスナを片付ける（規約3） */
    unmount() {
      clearInterval(timerId);
      actionBtn.removeEventListener("click", onAction);
      void lastView;
      clear(container);
    },
  };
}
