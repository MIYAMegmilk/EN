/**
 * ワードウルフ（ビューモジュール。docs/design/games-unified.md §3.2 / §8-10）
 *
 * 参加者に「お題（単語）」が配られ、1人だけ違う単語を持っている（＝狼）。
 * 狼は自分が狼だと知らない。VC でそのお題について話し合い、投票で狼を探す。
 *
 * このファイルは表示専用である。ルール判定・進行・秘密の保持はすべてサーバー
 * （server/games/wordwolf.ts）にあり、ここは届いた view をそのまま絵にするだけ。
 * 他人の単語・狼の正体はそもそもこのクライアントに届かない。
 *
 * サーバーとの契約（§2.2）:
 *   C2S: { t: "gameEvent", payload: ... } … api.send(payload) で送る。payload は3種類だけ
 *        { k: "config", mode: "simple"|"reversal", discussionSec: number }  // 設定フェーズ
 *        { k: "vote", targetId: string }                                    // 投票フェーズ
 *        { k: "guess", word: string }                                       // 言い当て（狼のみ）
 *   S2C: { t: "gameView", gameId: "wordwolf", view, deadline } … update(view, deadline)
 *
 * 【開始操作について】ゲームを始める（設定を確定する）のはルーム UI の
 * 「スキップ（ホスト）」ボタン（C2S skipPhase）で、これはサーバー側でホストか検証される。
 * ビューモジュールから送れるのは gameEvent だけなので、開始ボタンはここには置かない。
 *
 * view の形（サーバーと確定済み。これ以外のフィールドは期待しない）:
 *   {
 *     kind: "wordwolf",
 *     phase: "config"|"discuss"|"vote"|"result"|"guess"|"final",
 *     mode, discussionSec, discussionChoices: number[], configuredBy: string|null, configLocked,
 *     playerCount, youArePlayer,
 *     players: [{ playerId, nickname, connected, voted }],   // 単語・投票先は載らない
 *     myWord: string|null,      // 自分の単語だけ
 *     myVote: string|null, votedCount,
 *     tally?: [{ playerId, nickname, votes, votedBy }],      // result 以降
 *     exiledId?, exiledNickname?, voteTie?,                  // result 以降
 *     wolfId?, youAreWolf?, guess?,                          // guess / final
 *     guessCorrect?, citizenWord?, wolfWord?, outcome?, abort?, results?, standings?,  // final
 *   }
 *
 * ---- 表示規約（§3.2 / §7 / CLAUDE.md セキュリティ基準。_template.js と共通）----
 * 1. ユーザー由来テキスト（ニックネーム・単語・狼の答え）は必ず textContent で描く。
 *    innerHTML は使わない。
 * 2. 音を出さない（VC の会話にかぶせない）。
 * 3. unmount() で setInterval・addEventListener をすべて解除する。
 * 4. サーバーが唯一の状態機械。勝敗・進行をクライアントで判断せず、view に書いてあることだけを描く。
 * 5. update は同じ view で何度も呼ばれうる。骨組みは mount で1度だけ作り、
 *    update では中身だけ変える。入力欄の値・フォーカスを毎回壊さない。
 * 6. 送信前にここでも軽く検証する（サーバーでも検証されるが、無駄な往復を減らすため）。
 *
 * このファイルは index.html に専用 CSS を持たないため、見た目は要素の inline style で
 * 最小限だけ付けている（汎用クラス .btn だけは index.html 定義済みのものを使う）。
 */

/** 狼の言い当ての最大文字数（サーバーと同じ値） */
const GUESS_MAX = 40;

/** 勝敗条件の表示名 */
const MODE_LABELS = {
  simple: "シンプル（狼を当てれば市民の勝ち）",
  reversal: "逆転あり（狼が市民のお題を言い当てれば狼の勝ち）",
};

/** フェーズの表示名 */
const PHASE_LABELS = {
  config: "設定中",
  discuss: "議論中",
  vote: "投票中",
  result: "開票",
  guess: "狼の言い当て",
  final: "最終結果",
};

/**
 * @param {HTMLElement} container 専用の空要素
 * @param {{
 *   send: (payload: unknown) => void,
 *   youId: string,
 *   isHost: boolean,
 *   serverNow: () => number,
 * }} api
 */
export function mount(container, api) {
  // ---------------------------------------------------------------------------
  // 骨組み（mount で1度だけ組み立てる。規約5）
  // ---------------------------------------------------------------------------
  const root = document.createElement("div");
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "10px";

  const titleEl = el("h3", "ワードウルフ");
  titleEl.style.margin = "0";
  root.appendChild(titleEl);

  const ruleEl = el(
    "p",
    "1人だけ違うお題を持っている。そのお題について話し合い、違う人（狼）を投票で見つけ出す。狼は自分が狼だと知らない。",
  );
  ruleEl.style.margin = "0";
  ruleEl.style.opacity = "0.8";
  root.appendChild(ruleEl);

  /** 「議論中」などのフェーズ表示 */
  const phaseEl = el("p", "");
  phaseEl.style.margin = "0";
  phaseEl.style.fontWeight = "700";
  root.appendChild(phaseEl);

  /** 「残り約N秒」。deadline が無いときは空にする */
  const timerEl = el("p", "");
  timerEl.style.margin = "0";
  timerEl.style.opacity = "0.8";
  root.appendChild(timerEl);

  // --- 自分のお題（discuss 以降。自分の分しか届かない） ---
  const wordBox = document.createElement("div");
  wordBox.style.padding = "8px 10px";
  wordBox.style.border = "1px solid rgba(128,128,128,0.4)";
  wordBox.style.borderRadius = "6px";
  const wordCaption = el("p", "あなたのお題");
  wordCaption.style.margin = "0";
  wordCaption.style.fontSize = "0.9em";
  wordCaption.style.opacity = "0.8";
  wordBox.appendChild(wordCaption);
  const wordEl = el("p", "");
  wordEl.style.margin = "2px 0 0";
  wordEl.style.fontSize = "1.4em";
  wordEl.style.fontWeight = "700";
  wordBox.appendChild(wordEl);
  const wordNoteEl = el("p", "このお題は他の人には見えません。全員が同じお題とは限りません。");
  wordNoteEl.style.margin = "4px 0 0";
  wordNoteEl.style.fontSize = "0.85em";
  wordNoteEl.style.opacity = "0.75";
  wordBox.appendChild(wordNoteEl);
  root.appendChild(wordBox);

  // --- 設定フェーズ ---
  const configBox = document.createElement("div");
  const configHead = el("h4", "設定");
  configHead.style.margin = "0 0 4px";
  configBox.appendChild(configHead);

  /** いま選ばれている設定（全員が見る） */
  const configSummaryEl = el("p", "");
  configSummaryEl.style.margin = "0 0 6px";
  configBox.appendChild(configSummaryEl);

  /** 誰が最後に設定を変えたか（透明性のため全員に見せる） */
  const configByEl = el("p", "");
  configByEl.style.margin = "0 0 6px";
  configByEl.style.fontSize = "0.85em";
  configByEl.style.opacity = "0.75";
  configBox.appendChild(configByEl);

  /** ホストだけに出す操作欄 */
  const configControls = document.createElement("div");
  configControls.style.display = "flex";
  configControls.style.flexDirection = "column";
  configControls.style.gap = "6px";

  const modeRow = document.createElement("div");
  modeRow.style.display = "flex";
  modeRow.style.flexWrap = "wrap";
  modeRow.style.gap = "6px";
  modeRow.style.alignItems = "center";
  modeRow.appendChild(el("span", "勝敗条件："));
  /** @type {Array<{ value: string, button: HTMLButtonElement }>} */
  const modeButtons = [];
  for (const value of ["simple", "reversal"]) {
    const button = el("button", value === "simple" ? "シンプル" : "逆転あり");
    button.type = "button";
    button.className = "btn";
    button.title = MODE_LABELS[value];
    modeRow.appendChild(button);
    modeButtons.push({ value, button });
  }
  configControls.appendChild(modeRow);

  const secRow = document.createElement("div");
  secRow.style.display = "flex";
  secRow.style.flexWrap = "wrap";
  secRow.style.gap = "6px";
  secRow.style.alignItems = "center";
  secRow.appendChild(el("span", "議論時間："));
  /** 議論時間のボタンは view の discussionChoices から作る（選択肢を焼き付けない） */
  const secButtonsBox = document.createElement("span");
  secButtonsBox.style.display = "flex";
  secButtonsBox.style.flexWrap = "wrap";
  secButtonsBox.style.gap = "6px";
  secRow.appendChild(secButtonsBox);
  configControls.appendChild(secRow);

  const startHintEl = el(
    "p",
    "設定を選んだら、下の「スキップ（ホスト）」ボタンで開始します。",
  );
  startHintEl.style.margin = "0";
  startHintEl.style.fontSize = "0.85em";
  startHintEl.style.opacity = "0.8";
  configControls.appendChild(startHintEl);
  configBox.appendChild(configControls);

  /** ホスト以外に出す案内 */
  const configWaitEl = el("p", "ホストが設定しています。しばらくお待ちください。");
  configWaitEl.style.margin = "0";
  configWaitEl.style.opacity = "0.8";
  configBox.appendChild(configWaitEl);
  root.appendChild(configBox);

  // --- 議論フェーズの案内 ---
  const discussEl = el(
    "p",
    "通話でこのお題について話しましょう。誰か1人だけ違うお題を持っています。",
  );
  discussEl.style.margin = "0";
  root.appendChild(discussEl);

  // --- 投票フェーズ ---
  const voteBox = document.createElement("div");
  const voteHead = el("h4", "投票（自分には入れられません）");
  voteHead.style.margin = "0 0 4px";
  voteBox.appendChild(voteHead);
  const voteStatusEl = el("p", "");
  voteStatusEl.style.margin = "0 0 6px";
  voteBox.appendChild(voteStatusEl);
  const voteList = document.createElement("div");
  voteList.style.display = "flex";
  voteList.style.flexWrap = "wrap";
  voteList.style.gap = "6px";
  voteBox.appendChild(voteList);
  root.appendChild(voteBox);

  // --- 参加者一覧（投票の進み具合。誰に入れたかは出さない） ---
  const playersBox = document.createElement("div");
  const playersHead = el("h4", "参加者");
  playersHead.style.margin = "0 0 4px";
  playersBox.appendChild(playersHead);
  const playersList = document.createElement("ul");
  playersList.style.margin = "0";
  playersList.style.paddingLeft = "1.2em";
  playersBox.appendChild(playersList);
  root.appendChild(playersBox);

  // --- 開票結果 ---
  const tallyBox = document.createElement("div");
  const tallyHead = el("h4", "開票結果");
  tallyHead.style.margin = "0 0 4px";
  tallyBox.appendChild(tallyHead);
  const exiledEl = el("p", "");
  exiledEl.style.margin = "0 0 4px";
  exiledEl.style.fontWeight = "700";
  tallyBox.appendChild(exiledEl);
  const tallyList = document.createElement("ul");
  tallyList.style.margin = "0";
  tallyList.style.padding = "0";
  tallyList.style.listStyle = "none";
  tallyBox.appendChild(tallyList);
  root.appendChild(tallyBox);

  // --- 狼の言い当て ---
  const guessBox = document.createElement("div");
  const guessHead = el("h4", "狼の言い当て");
  guessHead.style.margin = "0 0 4px";
  guessBox.appendChild(guessHead);
  const guessInfoEl = el("p", "");
  guessInfoEl.style.margin = "0 0 6px";
  guessBox.appendChild(guessInfoEl);

  const guessRow = document.createElement("div");
  guessRow.style.display = "flex";
  guessRow.style.gap = "6px";
  guessRow.style.alignItems = "center";
  const guessInput = document.createElement("input");
  guessInput.type = "text";
  guessInput.maxLength = GUESS_MAX;
  guessInput.setAttribute("aria-label", "市民のお題だと思う言葉");
  guessInput.placeholder = "市民のお題は？";
  guessInput.style.flex = "1";
  guessRow.appendChild(guessInput);
  const guessBtn = el("button", "答える");
  guessBtn.type = "button";
  guessBtn.className = "btn";
  guessRow.appendChild(guessBtn);
  guessBox.appendChild(guessRow);

  const guessNoteEl = el("p", "");
  guessNoteEl.style.margin = "4px 0 0";
  guessNoteEl.style.color = "#c0392b";
  guessBox.appendChild(guessNoteEl);
  root.appendChild(guessBox);

  // --- 最終結果 ---
  const finalBox = document.createElement("div");
  const outcomeEl = el("h4", "");
  outcomeEl.style.margin = "0 0 4px";
  finalBox.appendChild(outcomeEl);
  const wordsEl = el("p", "");
  wordsEl.style.margin = "0 0 6px";
  finalBox.appendChild(wordsEl);
  const guessResultEl = el("p", "");
  guessResultEl.style.margin = "0 0 6px";
  finalBox.appendChild(guessResultEl);
  const resultsList = document.createElement("ul");
  resultsList.style.margin = "0";
  resultsList.style.padding = "0";
  resultsList.style.listStyle = "none";
  finalBox.appendChild(resultsList);
  root.appendChild(finalBox);

  container.appendChild(root);

  // ---------------------------------------------------------------------------
  // 表示のためだけの一時値（ゲームの状態はサーバーが持つ。規約4）
  // ---------------------------------------------------------------------------
  /** 直近の deadline（epoch ms）。null なら期限なし */
  let deadline = null;
  /** 直近の view から読んだ設定。設定ボタンを押したときに片方だけ送らないため */
  let currentMode = "simple";
  let currentSec = 300;
  /** いま投票を受け付けてよいか */
  let canVote = false;
  /** いま言い当てを受け付けてよいか */
  let canGuess = false;
  /** 投票ボタンを作り直すかの判定に使う署名 */
  let voteSignature = "";
  /** 議論時間ボタンを作り直すかの判定に使う署名 */
  let secSignature = "";
  /** 議論時間ボタン（署名が変わったときだけ作り直す） */
  let secButtons = [];

  // ---------------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------------

  /** 設定を送る。片方だけ変えても、もう片方は現在値をそのまま送る */
  function sendConfig(mode, discussionSec) {
    if (mode !== "simple" && mode !== "reversal") return;
    if (!Number.isInteger(discussionSec) || discussionSec <= 0) return;
    api.send({ k: "config", mode, discussionSec });
  }

  /** @type {Array<{ target: EventTarget, type: string, fn: EventListener }>} */
  const listeners = [];

  /** リスナを登録しつつ、unmount で外せるよう控えておく（規約3） */
  function on(target, type, fn) {
    target.addEventListener(type, fn);
    listeners.push({ target, type, fn });
  }

  /**
   * 作り直しのある一覧（投票ボタン）専用のリスナ置き場。
   * 作り直すたびに古いぶんを外してから積み直すので、`listeners` のように
   * 捨てたボタンとそのリスナが溜まり続けることがない
   */
  const voteListeners = [];

  /** 投票ボタンのリスナをすべて外して空にする */
  function clearVoteListeners() {
    for (const entry of voteListeners) entry.target.removeEventListener(entry.type, entry.fn);
    voteListeners.length = 0;
  }

  for (const entry of modeButtons) {
    on(entry.button, "click", () => sendConfig(entry.value, currentSec));
  }

  function submitGuess() {
    if (!canGuess) return;
    const raw = guessInput.value.trim();
    if (raw.length === 0) {
      guessNoteEl.textContent = "答えを入力してください";
      return;
    }
    if (raw.length > GUESS_MAX) {
      guessNoteEl.textContent = `${GUESS_MAX}文字以内で入力してください`;
      return;
    }
    guessNoteEl.textContent = "";
    // 送っただけでは回答済みにしない。回答済みかどうかは次の view で決まる（規約4）
    api.send({ k: "guess", word: raw });
  }

  on(guessBtn, "click", submitGuess);
  on(guessInput, "keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submitGuess();
  });

  // ---------------------------------------------------------------------------
  // 秒読み（1秒ごと。サーバー時刻に補正した api.serverNow() を使う）
  // ---------------------------------------------------------------------------
  function renderTimer() {
    if (deadline === null) {
      timerEl.textContent = "";
      return;
    }
    const left = Math.max(0, Math.ceil((deadline - api.serverNow()) / 1000));
    timerEl.textContent = left >= 60
      ? `残り約 ${Math.floor(left / 60)} 分 ${left % 60} 秒`
      : `残り約 ${left} 秒`;
  }
  const timerId = setInterval(renderTimer, 1000);

  // ---------------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------------

  /** 議論時間の選択ボタン。選択肢は view から来る */
  function renderSecButtons(choices, selected) {
    const signature = choices.join(",");
    if (signature !== secSignature) {
      clear(secButtonsBox);
      secButtons = [];
      for (const sec of choices) {
        const button = el("button", formatSec(sec));
        button.type = "button";
        button.className = "btn";
        on(button, "click", () => sendConfig(currentMode, sec));
        secButtonsBox.appendChild(button);
        secButtons.push({ value: sec, button });
      }
      secSignature = signature;
    }
    for (const entry of secButtons) markSelected(entry.button, entry.value === selected);
  }

  /** 投票ボタン。自分は除く。投票済み・観戦中は押せない */
  function renderVoteButtons(players, myVote, enabled) {
    const signature = players
      .map((p) => `${p.playerId}:${p.connected === true ? 1 : 0}`)
      .join("|") + `#${myVote ?? ""}#${enabled ? 1 : 0}`;
    if (signature === voteSignature) return;
    voteSignature = signature;
    // 古いボタンのリスナを外してから作り直す（切り離した DOM を抱え込まない）
    clearVoteListeners();
    clear(voteList);
    for (const p of players) {
      if (p === null || typeof p !== "object" || typeof p.playerId !== "string") continue;
      if (p.playerId === api.youId) continue;
      const button = el(
        "button",
        p.connected === false ? `${nameOf(p)}（切断中）` : nameOf(p),
      );
      button.type = "button";
      button.className = "btn";
      button.disabled = !enabled;
      markSelected(button, myVote === p.playerId);
      const targetId = p.playerId;
      const onVote = () => {
        if (!canVote) return;
        api.send({ k: "vote", targetId });
      };
      button.addEventListener("click", onVote);
      voteListeners.push({ target: button, type: "click", fn: onVote });
      voteList.appendChild(button);
    }
  }

  /** 参加者一覧。投票を済ませたかどうかだけを出す（投票先は view に無い） */
  function renderPlayers(players, showVoted) {
    clear(playersList);
    for (const p of players) {
      if (p === null || typeof p !== "object" || typeof p.playerId !== "string") continue;
      const item = document.createElement("li");
      const isYou = p.playerId === api.youId;
      const name = el("span", nameOf(p));
      if (isYou) name.style.fontWeight = "700";
      item.appendChild(name);
      if (isYou) item.appendChild(el("span", "（あなた）"));
      if (showVoted) item.appendChild(el("span", p.voted === true ? "：投票済み" : "：まだ"));
      if (p.connected === false) {
        const off = el("span", "（切断中）");
        off.style.opacity = "0.6";
        item.appendChild(off);
      }
      playersList.appendChild(item);
    }
  }

  /** 開票結果。得票の多い順にサーバーが並べてくれている */
  function renderTally(tally, nameById) {
    clear(tallyList);
    for (const e of tally) {
      if (e === null || typeof e !== "object") continue;
      const item = document.createElement("li");
      item.style.display = "flex";
      item.style.gap = "6px";
      item.style.alignItems = "baseline";
      item.style.padding = "2px 4px";

      const votes = numberOrNull(e.votes) ?? 0;
      const countEl = el("span", `${votes}票`);
      countEl.style.minWidth = "3em";
      countEl.style.textAlign = "right";
      countEl.style.fontWeight = "700";
      item.appendChild(countEl);

      const name = el("span", nameOf(e));
      if (e.playerId === api.youId) name.style.fontWeight = "700";
      item.appendChild(name);

      const voters = Array.isArray(e.votedBy) ? e.votedBy : [];
      if (voters.length > 0) {
        const from = el("span", `← ${voters.map((id) => nameById.get(id) ?? "？").join("、")}`);
        from.style.fontSize = "0.9em";
        from.style.opacity = "0.8";
        item.appendChild(from);
      }
      tallyList.appendChild(item);
    }
  }

  /** 最終結果。ここで初めて全員のお題と狼が公開される */
  function renderResults(results) {
    clear(resultsList);
    for (const r of results) {
      if (r === null || typeof r !== "object") continue;
      const item = document.createElement("li");
      item.style.display = "flex";
      item.style.gap = "6px";
      item.style.alignItems = "baseline";
      item.style.padding = "2px 4px";

      const name = el("span", nameOf(r));
      if (r.playerId === api.youId) name.style.fontWeight = "700";
      item.appendChild(name);
      if (r.playerId === api.youId) item.appendChild(el("span", "（あなた）"));

      item.appendChild(el("span", `：${textOf(r.word)}`));
      item.appendChild(el("span", r.isWolf === true ? "🐺 狼" : "市民"));
      item.appendChild(el("span", `${numberOrNull(r.votes) ?? 0}票`));

      if (r.won === true) {
        item.style.fontWeight = "700";
        item.style.background = "rgba(212, 175, 55, 0.25)";
        item.style.borderRadius = "4px";
        item.appendChild(el("span", "★ 勝ち"));
      } else {
        item.style.opacity = "0.75";
      }
      resultsList.appendChild(item);
    }
  }

  return {
    /**
     * @param {unknown} view gameView.view（上のコメントの形）
     * @param {number|null} nextDeadline 期限（epoch ms）。null なら期限なし
     */
    update(view, nextDeadline) {
      deadline = typeof nextDeadline === "number" && Number.isFinite(nextDeadline)
        ? nextDeadline
        : null;
      renderTimer();

      // view は外から来るデータなので、形を確かめてから使う
      if (view === null || typeof view !== "object") return;
      const phase = typeof view.phase === "string" ? view.phase : "";
      const players = Array.isArray(view.players) ? view.players : [];
      const myWord = typeof view.myWord === "string" ? view.myWord : null;
      const myVote = typeof view.myVote === "string" ? view.myVote : null;
      const youArePlayer = view.youArePlayer === true;

      currentMode = view.mode === "reversal" ? "reversal" : "simple";
      currentSec = numberOrNull(view.discussionSec) ?? 300;

      /** playerId → 表示名（開票結果で「誰が入れたか」を名前に直すのに使う） */
      const nameById = new Map();
      for (const p of players) {
        if (p !== null && typeof p === "object" && typeof p.playerId === "string") {
          nameById.set(p.playerId, nameOf(p));
        }
      }

      // phase はサーバー由来の文字列。プロトタイプのキー（"constructor" 等）を
      // 引かないよう、自前のキーであることを確かめてから使う
      phaseEl.textContent = Object.hasOwn(PHASE_LABELS, phase) ? PHASE_LABELS[phase] : "";

      // --- 自分のお題（config 中と観戦者には無い） ---
      setShown(wordBox, myWord !== null);
      if (myWord !== null) wordEl.textContent = myWord;

      // --- 設定フェーズ ---
      const configuring = phase === "config";
      setShown(configBox, configuring);
      if (configuring) {
        configSummaryEl.textContent = `${MODE_LABELS[currentMode]} ／ 議論 ${
          formatSec(currentSec)
        }`;
        const by = typeof view.configuredBy === "string" ? view.configuredBy : null;
        configByEl.textContent = by === null ? "" : `最後に設定を変えた人: ${by}`;
        // 設定 UI はホストにだけ出す（サーバー側は「開始（skipPhase）がホスト限定」で守っている）
        setShown(configControls, api.isHost === true);
        setShown(configWaitEl, api.isHost !== true);
        for (const entry of modeButtons) markSelected(entry.button, entry.value === currentMode);
        const choices = Array.isArray(view.discussionChoices)
          ? view.discussionChoices.filter((s) => Number.isInteger(s) && s > 0)
          : [];
        renderSecButtons(choices, currentSec);
      }

      // --- 議論フェーズ ---
      setShown(discussEl, phase === "discuss");

      // --- 投票フェーズ ---
      const voting = phase === "vote";
      setShown(voteBox, voting);
      canVote = voting && youArePlayer && myVote === null;
      if (voting) {
        const votedCount = numberOrNull(view.votedCount) ?? 0;
        const playerCount = numberOrNull(view.playerCount) ?? players.length;
        const votedName = myVote === null ? null : nameById.get(myVote) ?? "？";
        voteStatusEl.textContent = !youArePlayer
          ? `観戦中です（投票 ${votedCount} / ${playerCount} 人）`
          : votedName === null
          ? `怪しい人に投票してください（投票 ${votedCount} / ${playerCount} 人）`
          : `${votedName} に投票しました（投票 ${votedCount} / ${playerCount} 人・変更できません）`;
        renderVoteButtons(players, myVote, canVote);
      }

      // --- 参加者一覧（config / discuss / vote のあいだだけ） ---
      const showPlayers = phase === "config" || phase === "discuss" || phase === "vote";
      setShown(playersBox, showPlayers);
      if (showPlayers) renderPlayers(players, voting);

      // --- 開票結果（result 以降） ---
      const tally = Array.isArray(view.tally) ? view.tally : null;
      const showTally = tally !== null &&
        (phase === "result" || phase === "guess" || phase === "final");
      setShown(tallyBox, showTally);
      if (showTally) {
        const exiledName = typeof view.exiledNickname === "string" ? view.exiledNickname : null;
        exiledEl.textContent = view.voteTie === true || exiledName === null
          ? "同票（または無投票）のため、追放なし"
          : `${exiledName} が追放されました`;
        renderTally(tally, nameById);
      }

      // --- 狼の言い当て（reversal で狼が追放されたときだけ） ---
      const guessing = phase === "guess";
      setShown(guessBox, guessing);
      const youAreWolf = view.youAreWolf === true;
      const submittedGuess = typeof view.guess === "string" && view.guess.length > 0;
      canGuess = guessing && youAreWolf && !submittedGuess;
      if (guessing) {
        guessInfoEl.textContent = youAreWolf
          ? "あなたが狼でした。市民のお題を言い当てれば逆転勝ちです。"
          : "追放されたのは狼でした。狼が市民のお題を言い当てようとしています。";
        setShown(guessRow, youAreWolf);
        guessInput.disabled = !canGuess;
        guessBtn.disabled = !canGuess;
        if (submittedGuess) guessNoteEl.textContent = "";
      }

      // --- 最終結果 ---
      const isFinal = phase === "final";
      setShown(finalBox, isFinal);
      if (isFinal) {
        const outcome = view.outcome === "citizens" || view.outcome === "wolf"
          ? view.outcome
          : null;
        if (typeof view.abort === "string") {
          outcomeEl.textContent = "ゲームは中断されました（狼が卓を離れました）";
        } else if (outcome === "citizens") {
          outcomeEl.textContent = "🎉 市民の勝ち";
        } else if (outcome === "wolf") {
          outcomeEl.textContent = "🐺 狼の勝ち";
        } else {
          outcomeEl.textContent = "決着なし";
        }

        const citizenWord = typeof view.citizenWord === "string" ? view.citizenWord : null;
        const wolfWord = typeof view.wolfWord === "string" ? view.wolfWord : null;
        wordsEl.textContent = citizenWord === null || wolfWord === null
          ? ""
          : `市民のお題「${citizenWord}」／ 狼のお題「${wolfWord}」`;

        const guess = typeof view.guess === "string" ? view.guess : null;
        guessResultEl.textContent = guess === null
          ? ""
          : `狼の答え「${guess}」… ${view.guessCorrect === true ? "正解" : "不正解"}`;

        const results = Array.isArray(view.results) ? view.results : [];
        setShown(resultsList, results.length > 0);
        if (results.length > 0) renderResults(results);
      }
    },

    /** タイマー・リスナを片付ける（規約3） */
    unmount() {
      clearInterval(timerId);
      clearVoteListeners();
      for (const entry of listeners) entry.target.removeEventListener(entry.type, entry.fn);
      listeners.length = 0;
      clear(container);
    },
  };
}

// -----------------------------------------------------------------------------
// 小道具
// -----------------------------------------------------------------------------

/** テキストだけを持つ要素を作る（chat.js / chicken.js と同じ方式。innerHTML は使わない） */
function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** 子要素をすべて取り除く */
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 表示・非表示を切り替える（index.html の .hidden に依存せず inline style で完結させる） */
function setShown(node, shown) {
  node.style.display = shown ? "" : "none";
}

/** 選択中のボタンを見分けられるようにする（専用 CSS が無いので inline style で） */
function markSelected(button, selected) {
  button.style.outline = selected ? "2px solid rgba(212, 175, 55, 0.9)" : "";
  button.setAttribute("aria-pressed", selected ? "true" : "false");
}

/** 秒数を「3分」「3分30秒」の形にする */
function formatSec(sec) {
  if (!Number.isInteger(sec) || sec <= 0) return "";
  const minutes = Math.floor(sec / 60);
  const rest = sec % 60;
  if (minutes === 0) return `${rest}秒`;
  return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`;
}

/** 有限な数値ならその値、そうでなければ null（欠けたフィールドで表示が壊れないようにする） */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 文字列ならそのまま、そうでなければ空文字（textContent で描く前提） */
function textOf(value) {
  return typeof value === "string" ? value : "";
}

/** 表示用のニックネーム。空・欠損でも行が崩れないようにする（textContent で描く） */
function nameOf(entry) {
  return typeof entry.nickname === "string" && entry.nickname.length > 0
    ? entry.nickname
    : "（名無し）";
}
