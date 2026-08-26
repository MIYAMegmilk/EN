/**
 * チキンレース（ビューモジュール。docs/design/games-unified.md §3.2 / §8-5）
 * 全員が 0〜100 の整数を他人に見えない状態で提出し、一斉公開する。
 * 他の誰とも被らなかった数字のうち、いちばん大きい数を出した人がそのラウンドの勝ち。
 * 既定3ラウンドで、勝ちラウンド数の多い順に最終順位が決まる。
 *
 * このファイルは表示専用である。ルール判定・進行・秘密の保持はすべてサーバー
 * （server/games/chicken.ts）にあり、ここは届いた view をそのまま絵にするだけ。
 *
 * サーバーとの契約（§2.2）:
 *   C2S: { t: "gameEvent", payload: { k: "submit", value: <0〜100 の整数> } }
 *        … api.send({ k: "submit", value }) で送る。送る payload はこの1種類だけ
 *   S2C: { t: "gameView", gameId: "chicken", view, deadline } … update(view, deadline)
 *
 * view の形（サーバーと確定済み。これ以外のフィールドは期待しない）:
 *   {
 *     kind: "chicken",
 *     phase: "submit" | "reveal" | "final",
 *     round, totalRounds, playerCount, submittedCount,
 *     mySubmission: number | null,      // 自分の提出値。未提出は null
 *     players: [{ playerId, nickname, submitted, connected }],  // 数字は載らない
 *     result?: {                        // phase が "reveal" / "final" のときだけ
 *       round, winnerId: string | null,
 *       entries: [{ playerId, nickname, value: number|null, unique, won }],
 *     },
 *     standings: [{ playerId, nickname, wins, rank }],           // 常に入る
 *   }
 *
 * ---- 表示規約（§3.2 / §7 / CLAUDE.md セキュリティ基準。_template.js と共通）----
 * 1. ユーザー由来テキスト（ニックネーム）は必ず textContent で描く。innerHTML は使わない。
 * 2. 音を出さない（VC の会話にかぶせない）。
 * 3. unmount() で setInterval・addEventListener をすべて解除する。
 * 4. サーバーが唯一の状態機械。勝敗・進行をクライアントで判断せず、view に書いてあることだけを描く。
 * 5. update は同じ view で何度も呼ばれうる。骨組みは mount で1度だけ作り、
 *    update では中身だけ変える。入力欄の値・フォーカスを毎回壊さない。
 * 6. 送信前に 0〜100 の整数かをここでも確かめる（サーバーでも検証されるが、無駄な往復を減らすため）。
 *
 * このファイルは index.html に専用 CSS を持たないため、見た目は要素の inline style で
 * 最小限だけ付けている（汎用クラス .btn だけは index.html 定義済みのものを使う）。
 */

/** 提出できる数字の範囲（サーバーと同じ値） */
const VALUE_MIN = 0;
const VALUE_MAX = 100;
/** 半角数字だけからなる文字列か（"1e2" や "3.0"、全角数字を弾くため正規表現で見る） */
const DIGITS_ONLY = /^[0-9]+$/;

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

  const titleEl = el("h3", "チキンレース");
  titleEl.style.margin = "0";
  root.appendChild(titleEl);

  const ruleEl = el(
    "p",
    "0〜100 の整数をひとつ、他の人に見えない状態で出す。誰とも被らなかった数字のうち、いちばん大きい数を出した人の勝ち。",
  );
  ruleEl.style.margin = "0";
  ruleEl.style.opacity = "0.8";
  root.appendChild(ruleEl);

  /** 「第N/Mラウンド」 */
  const roundEl = el("p", "");
  roundEl.style.margin = "0";
  roundEl.style.fontWeight = "700";
  root.appendChild(roundEl);

  /** 「提出 x / y 人」 */
  const statusEl = el("p", "");
  statusEl.style.margin = "0";
  root.appendChild(statusEl);

  /** 「残り約N秒」。deadline が無いときは空にする */
  const timerEl = el("p", "");
  timerEl.style.margin = "0";
  timerEl.style.opacity = "0.8";
  root.appendChild(timerEl);

  // --- 提出欄（phase "submit" のときだけ出す） ---
  const submitBox = document.createElement("div");
  submitBox.style.display = "flex";
  submitBox.style.flexDirection = "column";
  submitBox.style.gap = "6px";

  const inputRow = document.createElement("div");
  inputRow.style.display = "flex";
  inputRow.style.gap = "6px";
  inputRow.style.alignItems = "center";

  const inputEl = document.createElement("input");
  inputEl.type = "number";
  inputEl.min = String(VALUE_MIN);
  inputEl.max = String(VALUE_MAX);
  inputEl.step = "1";
  inputEl.inputMode = "numeric";
  inputEl.setAttribute("aria-label", "提出する数字（0〜100 の整数）");
  inputEl.style.width = "6em";
  inputRow.appendChild(inputEl);

  const submitBtn = el("button", "提出する");
  submitBtn.type = "button";
  submitBtn.className = "btn";
  inputRow.appendChild(submitBtn);

  submitBox.appendChild(inputRow);

  /** 入力が不正だったときの注意書き（サーバーへ送らずここで止める。規約6） */
  const noteEl = el("p", "");
  noteEl.style.margin = "0";
  noteEl.style.color = "#c0392b";
  submitBox.appendChild(noteEl);

  /** 提出済みのとき、自分が出した数字を出す（他人の数字はサーバーから届かない） */
  const mineEl = el("p", "");
  mineEl.style.margin = "0";
  mineEl.style.fontWeight = "700";
  submitBox.appendChild(mineEl);

  root.appendChild(submitBox);

  // --- 参加者一覧（提出済み／まだ。数字は出さない・そもそも持っていない） ---
  const playersBox = document.createElement("div");
  const playersHead = el("h4", "参加者");
  playersHead.style.margin = "0 0 4px";
  playersBox.appendChild(playersHead);
  const playersList = document.createElement("ul");
  playersList.style.margin = "0";
  playersList.style.paddingLeft = "1.2em";
  playersBox.appendChild(playersList);
  root.appendChild(playersBox);

  // --- 公開結果（phase "reveal" / "final"） ---
  const resultBox = document.createElement("div");
  const resultHead = el("h4", "公開結果");
  resultHead.style.margin = "0 0 4px";
  resultBox.appendChild(resultHead);
  /** 勝者なしのときの説明 */
  const resultNoteEl = el("p", "");
  resultNoteEl.style.margin = "0 0 4px";
  resultBox.appendChild(resultNoteEl);
  const resultList = document.createElement("ul");
  resultList.style.margin = "0";
  resultList.style.padding = "0";
  resultList.style.listStyle = "none";
  resultBox.appendChild(resultList);
  root.appendChild(resultBox);

  // --- 順位表（standings は常に届く） ---
  const standingsBox = document.createElement("div");
  const standingsHead = el("h4", "勝ちラウンド数");
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
  /** 直前に描いたラウンド番号。ラウンドが変わったときだけ入力欄を空に戻すため */
  let lastRound = null;
  /** 直前に描いた phase。ラウンド跨ぎの判定に使う */
  let lastPhase = null;
  /** いま提出操作を受け付けてよいか（phase が submit かつ自分が未提出） */
  let canSubmit = false;

  // ---------------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------------

  /** 入力欄の値を検証して送る。不正なら送らずにその場で注意を出す（規約6） */
  function submitValue() {
    if (!canSubmit) return;
    const raw = inputEl.value.trim();
    if (raw.length === 0) {
      noteEl.textContent = "0〜100 の整数を入力してください";
      return;
    }
    // type="number" でも "1e2" や "3.5" は通るので、半角数字だけかを明示的に見る
    if (!DIGITS_ONLY.test(raw)) {
      noteEl.textContent = "0〜100 の整数（半角）で入力してください";
      return;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < VALUE_MIN || value > VALUE_MAX) {
      noteEl.textContent = `${VALUE_MIN}〜${VALUE_MAX} の範囲で入力してください`;
      return;
    }
    noteEl.textContent = "";
    // 送っただけでは提出済みにしない。提出済みかどうかは次の view（mySubmission）で決まる（規約4）
    api.send({ k: "submit", value });
  }

  function onSubmitClick() {
    submitValue();
  }

  /** Enter でも提出できるようにする（チャット入力と同じ感覚に合わせる） */
  function onInputKeyDown(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submitValue();
  }

  submitBtn.addEventListener("click", onSubmitClick);
  inputEl.addEventListener("keydown", onInputKeyDown);

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

  /** 参加者一覧。提出済みかどうかだけを出す（他人の数字は view に載っていない） */
  function renderPlayers(players) {
    clear(playersList);
    for (const p of players) {
      if (p === null || typeof p !== "object" || typeof p.playerId !== "string") continue;
      const item = document.createElement("li");
      const isYou = p.playerId === api.youId;
      const name = el("span", nameOf(p));
      if (isYou) name.style.fontWeight = "700";
      item.appendChild(name);
      if (isYou) item.appendChild(el("span", "（あなた）"));
      item.appendChild(el("span", p.submitted === true ? "：提出済み" : "：まだ"));
      if (p.connected === false) {
        const off = el("span", "（切断中）");
        off.style.opacity = "0.6";
        item.appendChild(off);
      }
      if (p.submitted !== true) item.style.opacity = "0.75";
      playersList.appendChild(item);
    }
  }

  /** 公開結果。数字の降順（未提出は末尾）に並べ、被り・未提出・勝者を見分けられるようにする */
  function renderResult(result) {
    clear(resultList);
    const entries = Array.isArray(result.entries) ? result.entries.slice() : [];
    entries.sort((a, b) => {
      const av = numberOrNull(a && a.value);
      const bv = numberOrNull(b && b.value);
      if (av === null && bv === null) return 0;
      if (av === null) return 1; // 未提出は末尾へ
      if (bv === null) return -1;
      return bv - av; // 数字の降順
    });

    for (const e of entries) {
      if (e === null || typeof e !== "object") continue;
      const value = numberOrNull(e.value);
      const isYou = e.playerId === api.youId;
      const won = e.won === true;

      const item = document.createElement("li");
      item.style.display = "flex";
      item.style.gap = "6px";
      item.style.alignItems = "baseline";
      item.style.padding = "2px 4px";

      // 数字
      const valueEl = el("span", value === null ? "—" : String(value));
      valueEl.style.minWidth = "2.5em";
      valueEl.style.textAlign = "right";
      valueEl.style.fontWeight = "700";
      // 被り・未提出は無効なので、数字そのものに取り消し線を引いて一目で分かるようにする
      if (value === null || e.unique !== true) valueEl.style.textDecoration = "line-through";
      item.appendChild(valueEl);

      // 名前
      const name = el("span", nameOf(e));
      if (isYou) name.style.fontWeight = "700";
      item.appendChild(name);
      if (isYou) item.appendChild(el("span", "（あなた）"));

      // 判定（サーバーが付けた unique / won をそのまま出す。ここでは判定しない。規約4）
      let mark = "";
      if (value === null) mark = "未提出";
      else if (e.unique !== true) mark = "かぶり";
      else if (won) mark = "勝ち";
      else mark = "有効";
      const markEl = el("span", mark);
      markEl.style.fontSize = "0.9em";
      item.appendChild(markEl);

      if (won) {
        item.style.fontWeight = "700";
        item.style.background = "rgba(212, 175, 55, 0.25)";
        item.style.borderRadius = "4px";
        const crown = el("span", "★ 勝者");
        crown.style.fontSize = "0.9em";
        item.appendChild(crown);
      } else if (value === null || e.unique !== true) {
        item.style.opacity = "0.6";
      }

      resultList.appendChild(item);
    }

    const roundNo = numberOrNull(result.round);
    const hasWinner = typeof result.winnerId === "string" && result.winnerId.length > 0;
    if (hasWinner) {
      resultNoteEl.textContent = roundNo === null ? "公開結果" : `第${roundNo}ラウンドの結果`;
      resultNoteEl.style.color = "";
    } else {
      resultNoteEl.textContent = roundNo === null
        ? "勝者なし（全員かぶり、または全員未提出）"
        : `第${roundNo}ラウンドは勝者なし（全員かぶり、または全員未提出）`;
      resultNoteEl.style.color = "#c0392b";
    }
  }

  /** 順位表。final では優勝者（rank 1）を目立たせる */
  function renderStandings(standings, isFinal) {
    clear(standingsList);
    for (const s of standings) {
      if (s === null || typeof s !== "object") continue;
      const rank = numberOrNull(s.rank);
      const wins = numberOrNull(s.wins);
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

      item.appendChild(el("span", wins === null ? "" : `${wins}勝`));

      if (isTop) {
        item.style.fontWeight = "700";
        item.style.background = "rgba(212, 175, 55, 0.25)";
        item.style.borderRadius = "4px";
        item.appendChild(el("span", "★ 優勝"));
      }

      standingsList.appendChild(item);
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
      const round = numberOrNull(view.round);
      const totalRounds = numberOrNull(view.totalRounds);
      const playerCount = numberOrNull(view.playerCount);
      const submittedCount = numberOrNull(view.submittedCount);
      const mySubmission = numberOrNull(view.mySubmission);
      const players = Array.isArray(view.players) ? view.players : [];
      const standings = Array.isArray(view.standings) ? view.standings : [];
      const result = view.result !== null && typeof view.result === "object" ? view.result : null;

      // 見出し
      if (phase === "final") {
        roundEl.textContent = "最終結果";
      } else if (round === null || totalRounds === null) {
        roundEl.textContent = "";
      } else {
        roundEl.textContent = `第${round} / ${totalRounds}ラウンド`;
      }

      statusEl.textContent = phase === "submit"
        ? `提出 ${submittedCount ?? 0} / ${playerCount ?? 0} 人`
        : "";

      // ラウンドが変わったら入力欄を初期状態に戻す（同じラウンド中は触らない。規約5）
      const roundChanged = round !== lastRound || (lastPhase !== "submit" && phase === "submit");
      if (roundChanged) {
        inputEl.value = "";
        noteEl.textContent = "";
      }
      lastRound = round;
      lastPhase = phase;

      // 提出欄
      const submitting = phase === "submit";
      const submitted = mySubmission !== null;
      canSubmit = submitting && !submitted;
      setShown(submitBox, submitting);
      inputEl.disabled = !canSubmit;
      submitBtn.disabled = !canSubmit;
      if (submitted) {
        // 提出済みなら自分の数字を出し、入力欄も同じ値にして無効化する
        inputEl.value = String(mySubmission);
        mineEl.textContent = `あなたの提出: ${mySubmission}（変更できません）`;
        noteEl.textContent = "";
      } else {
        mineEl.textContent = "";
      }

      // 参加者一覧は提出フェーズだけ（公開後は結果一覧のほうが情報量が多い）
      setShown(playersBox, submitting);
      if (submitting) renderPlayers(players);

      // 公開結果は reveal / final のときだけ届く
      const showResult = (phase === "reveal" || phase === "final") && result !== null;
      setShown(resultBox, showResult);
      if (showResult) renderResult(result);

      // 順位表は常に届く
      setShown(standingsBox, standings.length > 0);
      if (standings.length > 0) renderStandings(standings, phase === "final");
    },

    /** タイマー・リスナを片付ける（規約3） */
    unmount() {
      clearInterval(timerId);
      submitBtn.removeEventListener("click", onSubmitClick);
      inputEl.removeEventListener("keydown", onInputKeyDown);
      clear(container);
    },
  };
}

// -----------------------------------------------------------------------------
// 小道具
// -----------------------------------------------------------------------------

/** テキストだけを持つ要素を作る（chat.js と同じ方式。innerHTML は使わない） */
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
  return typeof entry.nickname === "string" && entry.nickname.length > 0
    ? entry.nickname
    : "（名無し）";
}
