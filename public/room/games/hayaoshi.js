/**
 * 早押しクイズ（ビューモジュール。docs/design/games-unified.md §3.2 / §9.2）
 *
 * 4択問題が出たら早押しボタンを押す。最初にサーバーへ届いた1人だけが答えられる。
 * 正解で1点。誤答するとその問だけお休み（減点なし）で、残った人の早押しが再開する。
 *
 * このファイルは表示専用である。ルール判定・進行・正解の秘匿はすべてサーバー
 * （server/games/hayaoshi.ts）にあり、ここは届いた view をそのまま絵にするだけ。
 * **正解は reveal フェーズになるまでそもそも配信されない**ので、
 * このファイルが正解を隠す責任を負うことは無い（隠せる情報を持っていない）。
 *
 * サーバーとの契約（§2.2）:
 *   C2S: { t: "gameEvent", payload: { k: "buzz" } }                  … 早押し
 *        { t: "gameEvent", payload: { k: "answer", choice: 0..3 } }  … 回答
 *        … api.send(payload) で送る。送る payload はこの2種類だけ
 *   S2C: { t: "gameView", gameId: "hayaoshi", view, deadline } … update(view, deadline)
 *
 * view の形（サーバーと確定済み。これ以外のフィールドは期待しない）:
 *   {
 *     kind: "hayaoshi",
 *     phase: "ready" | "buzz" | "answer" | "reveal" | "final",
 *     questionNo, totalQuestions,
 *     question: { text, options: string[] } | null,   // 正解番号は入らない
 *     answererId: string | null, answererNickname: string | null,
 *     iAmAnswerer, canBuzz, amBlocked,                // すべてサーバーの判定
 *     players: [{ playerId, nickname, connected, score, blocked, answering }],
 *     reveal?: { questionNo, correct, correctText, winnerId, winnerNickname, missedIds },
 *     standings: [{ playerId, nickname, score, rank }],
 *   }
 *
 * ---- 表示規約（§3.2 / §7 / CLAUDE.md セキュリティ基準。_template.js と共通）----
 * 1. ユーザー由来テキスト（ニックネーム・問題文・選択肢）は必ず textContent で描く。
 *    innerHTML は使わない。
 * 2. 音を出さない（VC の会話にかぶせない）。
 * 3. unmount() で setInterval・addEventListener をすべて解除する。
 * 4. サーバーが唯一の状態機械。押せるかどうか・正誤・進行を自前で判断せず、
 *    view.canBuzz / view.iAmAnswerer など届いた値だけを見る。
 * 5. update は同じ view で何度も呼ばれうる。骨組みは mount で1度だけ作り、
 *    update では中身だけ変える。
 * 6. 【連打対策】早押しは連打されうる。gameEvent には共通のレート枠しか無い（§9.3）ので、
 *    連打で自分が切断されないよう、送ったら即ボタンを無効化し、
 *    「同じ問題では二度と送らない」ことをクライアント側でも保証する。
 *    回答（answer）も同様に1問1回しか送らない。
 *
 * このファイルは index.html に専用 CSS を持たないため、見た目は要素の inline style で
 * 最小限だけ付けている（汎用クラス .btn だけは index.html 定義済みのものを使う）。
 */

/** 選択肢の数（サーバーと同じ値） */
const OPTION_COUNT = 4;

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

  const titleEl = el("h3", "早押しクイズ");
  titleEl.style.margin = "0";
  root.appendChild(titleEl);

  const ruleEl = el(
    "p",
    "4択問題が出たら早押し。最初に押した人だけが答えられる。正解で1点、間違えるとその問題はお休み（減点なし）。",
  );
  ruleEl.style.margin = "0";
  ruleEl.style.opacity = "0.8";
  root.appendChild(ruleEl);

  /**
   * 公平性の注記（設計書 §9.2 / §10-6）。
   * 押し順はサーバーへの到着順で決めるため、回線が速い人ほど有利になる。
   * これは仕様上の限界なので、隠さず画面に出しておく
   */
  const fairnessEl = el(
    "p",
    "※ 押した順番はサーバーに届いた順で決まります。回線が速いほうが有利です。",
  );
  fairnessEl.style.margin = "0";
  fairnessEl.style.fontSize = "0.9em";
  fairnessEl.style.opacity = "0.7";
  root.appendChild(fairnessEl);

  /** 「第N / M問」 */
  const progressEl = el("p", "");
  progressEl.style.margin = "0";
  progressEl.style.fontWeight = "700";
  root.appendChild(progressEl);

  /** 「残り約N秒」。deadline が無いときは空にする */
  const timerEl = el("p", "");
  timerEl.style.margin = "0";
  timerEl.style.opacity = "0.8";
  root.appendChild(timerEl);

  /** いま何が起きているか（読む時間／早押し受付中／誰々が回答中……） */
  const statusEl = el("p", "");
  statusEl.style.margin = "0";
  root.appendChild(statusEl);

  // --- 問題文と選択肢 ---
  const questionBox = document.createElement("div");
  const questionEl = el("p", "");
  questionEl.style.margin = "0 0 6px";
  questionEl.style.fontSize = "1.1em";
  questionEl.style.fontWeight = "700";
  questionBox.appendChild(questionEl);

  const optionList = document.createElement("div");
  optionList.style.display = "flex";
  optionList.style.flexDirection = "column";
  optionList.style.gap = "6px";
  questionBox.appendChild(optionList);

  /** 選択肢のボタン。個数は固定なので mount で作り切る（規約5） */
  const optionButtons = [];
  for (let i = 0; i < OPTION_COUNT; i++) {
    const btn = el("button", "");
    btn.type = "button";
    btn.className = "btn";
    btn.style.textAlign = "left";
    btn.dataset.choice = String(i);
    optionList.appendChild(btn);
    optionButtons.push(btn);
  }
  root.appendChild(questionBox);

  // --- 早押しボタン ---
  const buzzBtn = el("button", "早押し！");
  buzzBtn.type = "button";
  buzzBtn.className = "btn";
  buzzBtn.style.alignSelf = "flex-start";
  buzzBtn.style.fontSize = "1.2em";
  buzzBtn.style.padding = "10px 24px";
  root.appendChild(buzzBtn);

  /** 押せない理由・誤答の知らせなど */
  const noteEl = el("p", "");
  noteEl.style.margin = "0";
  noteEl.style.color = "#c0392b";
  root.appendChild(noteEl);

  // --- 正解発表 ---
  const revealBox = document.createElement("div");
  const revealEl = el("p", "");
  revealEl.style.margin = "0";
  revealEl.style.fontWeight = "700";
  revealBox.appendChild(revealEl);
  const revealWinnerEl = el("p", "");
  revealWinnerEl.style.margin = "0";
  revealBox.appendChild(revealWinnerEl);
  root.appendChild(revealBox);

  // --- 得点表 ---
  const standingsBox = document.createElement("div");
  const standingsHead = el("h4", "得点");
  standingsHead.style.margin = "0 0 4px";
  standingsBox.appendChild(standingsHead);
  const standingsList = document.createElement("ul");
  standingsList.style.margin = "0";
  standingsList.style.padding = "0";
  standingsList.style.listStyle = "none";
  standingsBox.appendChild(standingsList);
  root.appendChild(standingsBox);

  container.appendChild(root);

  // ---------------------------------------------------------------------------
  // 表示のためだけの一時値（ゲームの状態はサーバーが持つ。規約4）
  // ---------------------------------------------------------------------------
  /** 直近の deadline（epoch ms）。null なら期限なし */
  let deadline = null;
  /** 直近の view.canBuzz。押せないときは送らない（規約6） */
  let canBuzz = false;
  /** 自分が回答権を持っているか */
  let canAnswer = false;
  /** 直前に描いた問題番号。問題が変わったら送信抑止を解除する */
  let lastQuestionNo = null;
  /** 直前に描いた phase。早押しが「開き直した」瞬間を見分けるために持つ */
  let lastPhase = null;
  /**
   * いまの早押し受付ですでに buzz を送ったか（連打でサーバーへ何度も投げないため。規約6）。
   * 「1問1回」ではなく「1回の受付につき1回」で区切る。誤答で回答権が空くと
   * サーバー側の受付が開き直るので、そこでは押し直せないと困るため
   */
  let buzzSent = false;
  /** いまの回答権ですでに answer を送ったか */
  let answerSent = false;

  // ---------------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------------

  /**
   * 早押しを送る。1つの問題につき1回だけ。
   * 送った時点でボタンを無効化し、次の view が来るまで戻さない
   * （サーバーが受理したかどうかは view でしか分からない。規約4）
   */
  function onBuzz() {
    if (!canBuzz || buzzSent) return;
    buzzSent = true;
    buzzBtn.disabled = true;
    noteEl.textContent = "";
    api.send({ k: "buzz" });
  }

  /** 回答を送る。1つの問題につき1回だけ */
  function onOptionClick(event) {
    if (!canAnswer || answerSent) return;
    const raw = event.currentTarget.dataset.choice;
    const choice = Number(raw);
    if (!Number.isInteger(choice) || choice < 0 || choice >= OPTION_COUNT) return;
    answerSent = true;
    setOptionsEnabled(false);
    api.send({ k: "answer", choice });
  }

  buzzBtn.addEventListener("click", onBuzz);
  for (const btn of optionButtons) btn.addEventListener("click", onOptionClick);

  /** 選択肢ボタンの有効・無効をまとめて切り替える */
  function setOptionsEnabled(enabled) {
    for (const btn of optionButtons) btn.disabled = !enabled;
  }

  // ---------------------------------------------------------------------------
  // 秒読み（1秒ごと。サーバー時刻に補正した api.serverNow() を使う）
  // ---------------------------------------------------------------------------
  function renderTimer() {
    if (deadline === null) {
      timerEl.textContent = "";
      return;
    }
    const left = Math.max(0, Math.ceil((deadline - api.serverNow()) / 1000));
    timerEl.textContent = `残り約 ${left} 秒`;
  }
  const timerId = setInterval(renderTimer, 1000);

  // ---------------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------------

  /** 得点表。final では1位を目立たせる */
  function renderStandings(standings, isFinal) {
    clear(standingsList);
    for (const s of standings) {
      if (s === null || typeof s !== "object") continue;
      const rank = numberOrNull(s.rank);
      const score = numberOrNull(s.score);
      const isYou = s.playerId === api.youId;
      const isTop = isFinal && rank === 1;

      const item = document.createElement("li");
      item.style.display = "flex";
      item.style.gap = "6px";
      item.style.alignItems = "baseline";
      item.style.padding = "2px 4px";

      const rankEl = el("span", rank === null ? "-" : `${rank}位`);
      rankEl.style.minWidth = "3em";
      item.appendChild(rankEl);

      const name = el("span", nameOf(s));
      if (isYou) name.style.fontWeight = "700";
      item.appendChild(name);
      if (isYou) item.appendChild(el("span", "（あなた）"));

      item.appendChild(el("span", score === null ? "" : `${score}問正解`));

      if (isTop) {
        item.style.fontWeight = "700";
        item.style.background = "rgba(212, 175, 55, 0.25)";
        item.style.borderRadius = "4px";
        item.appendChild(el("span", "★ 優勝"));
      }
      standingsList.appendChild(item);
    }
  }

  /** いま何が起きているかの1行。サーバーの phase をそのまま言葉にするだけ（規約4） */
  function statusTextOf(view, phase) {
    switch (phase) {
      case "ready":
        return "問題を読む時間です（まだ押せません）";
      case "buzz":
        return view.amBlocked === true
          ? "この問題ではもう回答できません。次の問題までお待ちください"
          : "早押し受付中！";
      case "answer":
        return view.iAmAnswerer === true
          ? "あなたに回答権があります。選択肢を選んでください"
          : `${nameOf({ nickname: view.answererNickname })} さんが回答中です`;
      case "reveal":
        return "正解発表";
      case "final":
        return "最終結果";
      default:
        return "";
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
      const questionNo = numberOrNull(view.questionNo);
      const totalQuestions = numberOrNull(view.totalQuestions);
      const question = view.question !== null && typeof view.question === "object"
        ? view.question
        : null;
      const standings = Array.isArray(view.standings) ? view.standings : [];
      const reveal = view.reveal !== null && typeof view.reveal === "object" ? view.reveal : null;

      // 送信抑止を解除する区切り（規約6）。
      //   - 問題が変わった
      //   - 早押し受付が開き直した（読み時間→受付、誤答で権利が空いて受付が再開）
      //   - 自分に回答権が回ってきた
      // 同じ view が2度届いただけでは解除しない（連打を通してしまうため）
      // なお、期限超過などでサーバーに弾かれても phase が buzz のままなら抑止は解けない。
      // その受付枠では押し直せなくなるが、連投を防ぐ安全側なので意図的にこうしている
      const questionChanged = questionNo !== lastQuestionNo;
      if (questionChanged || (lastPhase !== "buzz" && phase === "buzz")) buzzSent = false;
      if (questionChanged || (lastPhase !== "answer" && phase === "answer")) answerSent = false;
      if (questionChanged) noteEl.textContent = "";
      lastQuestionNo = questionNo;
      lastPhase = phase;

      // 見出し
      if (phase === "final") {
        progressEl.textContent = "最終結果";
      } else if (questionNo === null || totalQuestions === null) {
        progressEl.textContent = "";
      } else {
        progressEl.textContent = `第${questionNo} / ${totalQuestions}問`;
      }
      statusEl.textContent = statusTextOf(view, phase);

      // 問題文と選択肢
      const options = question !== null && Array.isArray(question.options) ? question.options : [];
      setShown(questionBox, question !== null);
      if (question !== null) {
        questionEl.textContent = typeof question.text === "string" ? question.text : "";
        optionButtons.forEach((btn, i) => {
          const label = typeof options[i] === "string" ? options[i] : "";
          btn.textContent = label === "" ? "" : `${i + 1}. ${label}`;
          setShown(btn, label !== "");
          // 正解発表では、サーバーが教えてくれた正解番号だけを目印にする
          const isCorrect = reveal !== null && numberOrNull(reveal.correct) === i;
          btn.style.background = phase === "reveal" && isCorrect ? "rgba(46, 160, 67, 0.25)" : "";
          btn.style.fontWeight = phase === "reveal" && isCorrect ? "700" : "";
        });
      }

      // 早押しボタン。押せるかどうかはサーバーの canBuzz が唯一の根拠（規約4）
      canBuzz = view.canBuzz === true;
      setShown(buzzBtn, phase === "ready" || phase === "buzz" || phase === "answer");
      buzzBtn.disabled = !canBuzz || buzzSent;

      // 回答ボタン。回答権が自分にあるときだけ有効
      canAnswer = view.iAmAnswerer === true && phase === "answer";
      setOptionsEnabled(canAnswer && !answerSent);

      // 自分がこの問題で回答不可になったことを1行で知らせる（減点は無い）
      if (view.amBlocked === true && phase !== "reveal" && phase !== "final") {
        noteEl.textContent = "この問題ではもう回答できません（減点はありません）";
      } else if (phase === "reveal" || phase === "final") {
        noteEl.textContent = "";
      }

      // 正解発表
      const showReveal = phase === "reveal" && reveal !== null;
      setShown(revealBox, showReveal);
      if (showReveal) {
        const correctNo = numberOrNull(reveal.correct);
        const correctText = typeof reveal.correctText === "string" ? reveal.correctText : "";
        // 番号が欠けている・範囲外のときは番号を付けずに文言だけ出す
        // （サーバー側の防御分岐が -1 を返しても「正解: 0.」にならないように）
        revealEl.textContent = correctNo === null || correctNo < 0 || correctNo >= OPTION_COUNT
          ? `正解: ${correctText}`
          : `正解: ${correctNo + 1}. ${correctText}`;
        const winnerName = typeof reveal.winnerNickname === "string" ? reveal.winnerNickname : "";
        if (winnerName === "") {
          revealWinnerEl.textContent = "正解者なし";
          revealWinnerEl.style.color = "#c0392b";
        } else {
          revealWinnerEl.textContent = reveal.winnerId === api.youId
            ? "あなたの正解！ +1点"
            : `${winnerName} さんの正解！ +1点`;
          revealWinnerEl.style.color = "";
        }
      }

      // 得点表は常に届く
      setShown(standingsBox, standings.length > 0);
      if (standings.length > 0) renderStandings(standings, phase === "final");
    },

    /** タイマー・リスナを片付ける（規約3） */
    unmount() {
      clearInterval(timerId);
      buzzBtn.removeEventListener("click", onBuzz);
      for (const btn of optionButtons) btn.removeEventListener("click", onOptionClick);
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

/** 有限な数値ならその値、そうでなければ null（欠けたフィールドで表示が壊れないようにする） */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 表示用のニックネーム。空・欠損でも行が崩れないようにする（textContent で描く） */
function nameOf(entry) {
  return entry !== null && typeof entry === "object" && typeof entry.nickname === "string" &&
      entry.nickname.length > 0
    ? entry.nickname
    : "（名無し）";
}
