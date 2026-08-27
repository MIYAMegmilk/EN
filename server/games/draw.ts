/**
 * お絵かき当て（設計書 docs/design/games-unified.md §8 #17 / §2.7）
 *
 * 出題者1人にお題（単語）を**秘密で**配り、出題者は canvas に絵を描く。
 * 他の人はその絵を見て、**既存のチャットに書いて早い者勝ち**で当てる。
 * 出題者は交代制で、参加者全員が1回ずつ描いたら終わり。
 *
 * このゲームの肝は2つある。
 *   1. **お題は出題者の view にしか載せない**（§2.6）。回答者に見えたら即破綻するので、
 *      view(state, viewerId) の分岐をテストで固定してある。
 *   2. **描画はサーバーが履歴を持つ**（§2.7）。描き手がストロークのチャンク（点列）を
 *      gameEvent で送り、モジュールが検証して state に積み、viewChanged で配る。
 *      サーバーが正本を持つので、途中参加・再接続でも履歴から全再描画できる。
 *
 * 規約は _template.ts / module.ts の冒頭にまとめてある（純粋関数・Math.random() 禁止・
 * Date.now() 禁止・payload は先頭で型検証・schedule の後始末・score は1ゲーム1回）。
 *
 * ---- 帯域についての正直な注記（【暫定値】の根拠） ----
 * view には描画履歴を**全量**載せる。受信者ごとの差分をサーバーが作る仕組みは
 * モジュール介面に無い（view は state と viewerId だけから決まる純粋関数）ため、
 * 「描くたびに履歴全部を配る」= 点数に対して O(n^2) の通信量になる。
 * そこで次の2つで上限を押さえている。
 *   - 1ターンの点数上限 DRAW_MAX_POINTS（2,500点。設計書の【暫定値】4,000点より小さくした）
 *   - 履歴が育つほど配信間隔を延ばす間引き（viewIntervalMs: 120ms → 250ms → 400ms）
 * これで「1回の配信量 × 配信頻度」がほぼ一定になり、【実測】1ルーム 0.5MB/秒前後で頭打ちになる。
 */

import {
  type GameModule,
  isRecord,
  type ModuleEvent,
  moduleFail,
  type ModuleInitInput,
  moduleNoop,
  moduleOk,
  type ModuleResult,
  nextSeed,
  randomInt,
  readInt,
  readKind,
  shuffle,
} from "./module.ts";
import type { ScoreEntry } from "../types.ts";

/** カタログ上のモジュールID */
export const DRAW_MODULE_ID = "draw";

// ---------------------------------------------------------------------------
// ルール・上限の定数（すべて【暫定値】。実プレイで調整する）
// ---------------------------------------------------------------------------

/** 論理座標の範囲。0..DRAW_COORD_MAX の整数だけを受理する（§2.7） */
export const DRAW_COORD_MAX = 479;

/** 1チャンクに載せられる点数の上限（§2.7 の【暫定値】64点） */
export const DRAW_MAX_CHUNK_POINTS = 64;

/**
 * 1ターンに積める点数の上限。超過は**受理拒否**する（間引きではない）。
 *
 * 間引き（古い点を捨てる）を選ばなかった理由: クライアントは手元でも即座にインクを
 * 引いており、サーバーが黙って古い点を消すと「描いたはずの線が消える」ことになる。
 * どこが消えるかは描き手に予測できず、絵として破綻する。拒否ならエラーが本人に返り、
 * 「もう描けない」ことがはっきり分かる（消しゴム＝clear でやり直せる）。
 */
export const DRAW_MAX_POINTS = 2_500;

/** 1ターンに積めるストローク数の上限（点数上限とは別に、配列の膨張を止める） */
export const DRAW_MAX_STROKES = 400;

/** 色の数（ビュー側のパレットと同じ）。payload には 0..DRAW_COLORS-1 の番号だけを載せる */
export const DRAW_COLORS = 8;

/** 線の太さの段階数。payload には 0..DRAW_WIDTHS-1 の番号だけを載せる */
export const DRAW_WIDTHS = 3;

/** 描画フェーズの制限時間（ミリ秒） */
const DRAW_MS = 90_000;

/** 答え合わせの表示時間（ミリ秒） */
const REVEAL_MS = 8_000;

/** 最終結果の表示時間（ミリ秒） */
const FINAL_MS = 10_000;

/**
 * 描画中に viewChanged を出す最短間隔（ミリ秒）を、**履歴の大きさに応じて**決める。
 * これより短い間隔で届いたチャンクは state には積むが配信しない（changed:false で返す）。
 * 取りこぼしが起きないよう、ストロークの終わり（k:"end"）・undo・clear・
 * フェーズ変化では必ず配信する。
 *
 * 履歴が大きくなるほど間隔を延ばすのは、view に履歴を全量載せるためである（冒頭の注記）。
 * 1回の配信量 × 配信頻度がほぼ一定になり、1ルームあたりの帯域が
 * 【実測】0.5MB/秒前後で頭打ちになる（白紙に近いうちは滑らかに、描き込むほど粗く）。
 * 描き手本人の手元のインクは即時に出るので、粗くなるのは見る側の更新だけ。
 */
function viewIntervalMs(pointCount: number): number {
  if (pointCount < 800) return 120;
  if (pointCount < 1_600) return 250;
  return 400;
}

/** viewIntervalMs が返しうる最大値（ターン開始時に間引きの窓を開けておくために使う） */
const MAX_VIEW_INTERVAL_MS = 400;

/** 正解の得点（早い順）。4番目以降は末尾の値 */
const CORRECT_POINTS = [3, 2, 1];

/** 出題者が得る得点（正解者1人につき1点、この値が上限） */
const DRAWER_POINT_CAP = 3;

// ---------------------------------------------------------------------------
// お題
// ---------------------------------------------------------------------------

/**
 * お題1件。word が出題者に見える表記で、alts は正解として受理する別表記。
 * 照合は normalizeAnswer() を通した後の完全一致で行う（カタカナ→ひらがな・
 * 全角半角・記号除去まではそこで吸収されるので、alts には漢字表記などだけを書く）
 */
export type DrawTopic = { word: string; alts?: readonly string[] };

/**
 * お題の一覧（誰でも描ける具体物だけ。差別的・性的な内容は入れない）。
 * ひらがな・カタカナ表記を正とし、漢字表記は alts で受ける
 */
export const DRAW_TOPICS: readonly DrawTopic[] = [
  { word: "りんご", alts: ["林檎"] },
  { word: "バナナ" },
  { word: "いちご", alts: ["苺"] },
  { word: "すいか", alts: ["西瓜"] },
  { word: "にんじん", alts: ["人参"] },
  { word: "たまご", alts: ["卵", "玉子"] },
  { word: "おにぎり", alts: ["お握り"] },
  { word: "おすし", alts: ["寿司", "すし"] },
  { word: "ラーメン" },
  { word: "ケーキ" },
  { word: "アイスクリーム", alts: ["アイス"] },
  { word: "ねこ", alts: ["猫"] },
  { word: "いぬ", alts: ["犬"] },
  { word: "ぞう", alts: ["象"] },
  { word: "きりん", alts: ["麒麟"] },
  { word: "パンダ" },
  { word: "うさぎ", alts: ["兎"] },
  { word: "かめ", alts: ["亀"] },
  { word: "ペンギン" },
  { word: "さかな", alts: ["魚"] },
  { word: "ちょうちょ", alts: ["蝶", "ちょう"] },
  { word: "でんしゃ", alts: ["電車"] },
  { word: "ひこうき", alts: ["飛行機"] },
  { word: "じてんしゃ", alts: ["自転車"] },
  { word: "くるま", alts: ["車"] },
  { word: "ふね", alts: ["船"] },
  { word: "ロケット" },
  { word: "かさ", alts: ["傘"] },
  { word: "とけい", alts: ["時計"] },
  { word: "めがね", alts: ["眼鏡", "メガネ"] },
  { word: "かばん", alts: ["鞄"] },
  { word: "ぼうし", alts: ["帽子"] },
  { word: "くつ", alts: ["靴"] },
  { word: "はブラシ", alts: ["歯ブラシ", "はぶらし"] },
  { word: "いす", alts: ["椅子"] },
  { word: "つくえ", alts: ["机"] },
  { word: "でんわ", alts: ["電話"] },
  { word: "テレビ" },
  { word: "かぎ", alts: ["鍵"] },
  { word: "ゆきだるま", alts: ["雪だるま"] },
  { word: "たいよう", alts: ["太陽"] },
  { word: "にじ", alts: ["虹"] },
  { word: "やま", alts: ["山"] },
  { word: "うみ", alts: ["海"] },
  { word: "ほし", alts: ["星"] },
  { word: "つき", alts: ["月"] },
  { word: "かみなり", alts: ["雷"] },
  { word: "ふじさん", alts: ["富士山"] },
  { word: "しんごう", alts: ["信号"] },
  { word: "はさみ", alts: ["鋏"] },
];

/**
 * 照合用に文字列を正規化する。
 *   NFKC（全角英数・半角カナを揃える）→ 小文字化 → 空白と記号を除去 →
 *   カタカナをひらがなへ
 * これで「バナナ / ばなな / ﾊﾞﾅﾅ / ば な な」がすべて同じ形になる
 */
export function normalizeAnswer(text: string): string {
  const folded = text.normalize("NFKC").toLowerCase()
    // 空白（半角・全角）と、区切りに使われがちな記号を落とす
    .replace(/[\s　]/g, "")
    .replace(/[-‐-‒–—―ー~〜_.,!?()[\]{}"'`、。・「」『』（）]/g, "");
  // カタカナ（ァ..ヶ）をひらがなへ。長音符はすでに落としてある
  return folded.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/**
 * 表示上の文字数を数える。サロゲートペア（絵文字など）を1文字として数えるため、
 * UTF-16 のコード単位（String.length）ではなくコードポイントで数える。
 * 回答者向けのヒントは**出題者に見える表記そのもの**を数えるので、
 * normalizeAnswer()（長音符や記号を落とす照合用の処理）は通さない
 */
function charCount(text: string): number {
  return [...text].length;
}

/** そのお題の正解として受理する、正規化済み文字列の一覧 */
function acceptedForms(topic: DrawTopic): string[] {
  const forms = [topic.word, ...(topic.alts ?? [])].map(normalizeAnswer);
  return forms.filter((f) => f.length > 0);
}

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

/** 進行フェーズ。draw=お絵かき中 / reveal=答え合わせ / final=最終結果 */
export type DrawPhase = "draw" | "reveal" | "final";

/** 1本のストローク。points は [x0,y0,x1,y1,...] の平坦な整数配列 */
export type DrawStroke = {
  /** 描き手が付けた通し番号。同じ id への追記でストロークが伸びる */
  id: number;
  /** 色番号（0..DRAW_COLORS-1） */
  color: number;
  /** 太さ番号（0..DRAW_WIDTHS-1） */
  width: number;
  /** 平坦な座標列 */
  points: number[];
};

/** 参加者1人の状態 */
type DrawPlayer = {
  id: string;
  nickname: string;
  /** 接続中か */
  connected: boolean;
};

/** 正解した1人分の記録 */
export type DrawCorrectEntry = {
  playerId: string;
  nickname: string;
  /** 何番目に正解したか（1 始まり） */
  order: number;
  /** そのターンで得た点 */
  points: number;
};

/** 1ターンの結果（答え合わせで全員に見せる） */
export type DrawTurnResult = {
  /** 何ターン目か（1 始まり） */
  turn: number;
  /** 出題者 */
  drawerId: string;
  drawerName: string;
  /** お題。**ここに載るのは reveal 以降だけ**（view 側で制御する） */
  topic: string;
  /** 正解者（早い順） */
  correct: DrawCorrectEntry[];
  /** 出題者が得た点 */
  drawerPoints: number;
  /** 打ち切りの理由。通常終了は null */
  aborted: "drawerLeft" | "drawerKicked" | null;
};

/** 順位表の1行 */
export type DrawStanding = {
  playerId: string;
  nickname: string;
  score: number;
  /** 1 始まりの順位。同点は同順位 */
  rank: number;
};

/** お絵かき当ての全状態。ルーム層はこの中身を知らない */
export type DrawState = {
  /** 乱数の種（お題抽選・出題順に使う。Math.random() は使わない。§2.5） */
  seed: number;
  /** 進行中か */
  running: boolean;
  phase: DrawPhase;
  /** いま何ターン目か（0 始まりの turnOrder への添字） */
  turnIndex: number;
  /** 出題順（init でシャッフルして決める）。全員が1回ずつ描く */
  turnOrder: string[];
  /** 在籍順（順位表の並びを安定させるために保持する） */
  order: string[];
  /** playerId → 参加者 */
  players: Record<string, DrawPlayer>;
  /** **秘密**: 現ターンのお題。view は出題者にしか載せない（§2.6） */
  topic: string;
  /** **秘密**: 正解として受理する正規化済み文字列 */
  answers: string[];
  /** まだ使っていないお題の添字（同じゲーム中に同じお題を出さない） */
  remainingTopics: number[];
  /** 現ターンの描画履歴 */
  strokes: DrawStroke[];
  /** strokes に含まれる点の総数（毎回数え直さずに上限判定するため持つ） */
  pointCount: number;
  /** 描画履歴の版番号。ビュー側はこれが変わったときだけ全再描画する */
  rev: number;
  /** 直近に viewChanged を出した時刻（配信の間引きに使う） */
  lastViewAt: number;
  /** 現ターンの正解者（早い順） */
  correct: DrawCorrectEntry[];
  /** 累計得点（playerId → 点） */
  scores: Record<string, number>;
  /** 直近に確定したターンの結果。draw 中は null */
  lastResult: DrawTurnResult | null;
  /** 現フェーズの期限（epoch ms） */
  deadline: number | null;
};

/** 受信者へ配る表示データ。**お題を出題者以外に載せないこと** */
export type DrawView = {
  kind: "draw";
  phase: DrawPhase;
  /** 何ターン目か（1 始まり） */
  turn: number;
  /** 全部で何ターンか */
  totalTurns: number;
  /** 出題者 */
  drawerId: string;
  drawerName: string;
  /** 自分が出題者か */
  youAreDrawer: boolean;
  /**
   * お題。**draw 中は出題者にだけ入る。**回答者には null。
   * reveal / final では全員に入る（答え合わせ）
   */
  topic: string | null;
  /**
   * お題の文字数。**出題者に見える表記（topic）そのものの文字数**で、
   * 照合用の正規化（normalizeAnswer）は通さない。「ケーキ」は 3、「ラーメン」は 4。
   * 回答者向けのヒントとして使う。お題そのものは含まない
   */
  topicLength: number;
  /** 描画履歴（全員に配る。これが再描画の正本） */
  strokes: DrawStroke[];
  /** 描画履歴の版番号 */
  rev: number;
  /** いま積まれている点数 */
  pointCount: number;
  /** 点数の上限 */
  pointMax: number;
  /** 正解者（早い順）。誰が当てたかは伏せない（お題そのものは伏せる） */
  correct: DrawCorrectEntry[];
  /** 回答できる人数（出題者を除く在籍者） */
  guesserCount: number;
  /**
   * 自分が何番目に正解したか。未正解・出題者は null。
   * **正解の発言はチャットから消える**ので、本人へのフィードバックはこれで返す
   */
  myCorrectOrder: number | null;
  /** 自分がそのターンで得た点。未正解は 0 */
  myTurnPoints: number;
  /** 直近ターンの結果。reveal / final のときだけ入る */
  result?: DrawTurnResult;
  /** 参加者一覧 */
  players: Array<{
    playerId: string;
    nickname: string;
    connected: boolean;
    /** そのターンで正解済みか */
    correct: boolean;
    /** 出題者か */
    drawer: boolean;
  }>;
  /** 順位表 */
  standings: DrawStanding[];
};

/** 状態を浅く複製する（入力 state を変更しない） */
function clone(state: DrawState): DrawState {
  return {
    ...state,
    turnOrder: [...state.turnOrder],
    order: [...state.order],
    players: { ...state.players },
    answers: [...state.answers],
    remainingTopics: [...state.remainingTopics],
    // strokes は「配列と、書き換える1本」だけを複製する（残りは不変なので使い回す）
    strokes: [...state.strokes],
    correct: [...state.correct],
    scores: { ...state.scores },
  };
}

/**
 * 状態は進めるが配信はしない結果。描画チャンクの間引き（VIEW_INTERVAL_MS）に使う。
 * ルーム層は changed:false のとき何も送らないので、次の配信までインクは溜まる
 */
function moduleQuiet<S>(state: S): ModuleResult<S> {
  return { state, changed: false, effects: [] };
}

// ---------------------------------------------------------------------------
// モジュール本体
// ---------------------------------------------------------------------------

export const drawModule: GameModule<DrawState, DrawView> = {
  id: DRAW_MODULE_ID,
  kind: "module",
  meta: {
    title: "お絵かき当て",
    description: "出題者だけに配られたお題を絵で伝える。ほかの人はチャットに答えを書いて早い者勝ち",
    minPlayers: 2,
    maxPlayers: 10,
  },

  init(input: ModuleInitInput): ModuleResult<DrawState> {
    const order: string[] = [];
    const players: Record<string, DrawPlayer> = {};
    const scores: Record<string, number> = {};
    for (const p of input.players) {
      if (players[p.id] !== undefined) continue;
      order.push(p.id);
      players[p.id] = { id: p.id, nickname: p.nickname, connected: p.connected };
      scores[p.id] = 0;
    }
    // 出題順は seed から決定的にシャッフルする（Math.random() 禁止。§2.5）
    const shuffled = shuffle(nextSeed(input.seed), order);
    const base: DrawState = {
      seed: shuffled.seed,
      running: true,
      phase: "draw",
      turnIndex: 0,
      turnOrder: shuffled.value,
      order,
      players,
      topic: "",
      answers: [],
      remainingTopics: DRAW_TOPICS.map((_, i) => i),
      strokes: [],
      pointCount: 0,
      rev: 0,
      lastViewAt: input.now,
      correct: [],
      scores,
      lastResult: null,
      deadline: null,
    };
    // 最初のターンを開始する。接続していない人は飛ばす
    return beginTurn(base, 0, input.now);
  },

  reduce(state: DrawState, event: ModuleEvent): ModuleResult<DrawState> {
    // 終了後に届いたイベントは黙って捨てる。在籍から消える playerKicked だけは反映する
    // （終了後の最終結果に、卓を去った人の名前を残さないため）
    if (!state.running && event.t !== "playerKicked") return moduleNoop(state);

    switch (event.t) {
      case "clientEvent":
        return handleClientEvent(state, event.playerId, event.payload, event.now);
      case "chatMessage":
        return handleGuess(state, event.playerId, event.text, event.now);
      case "timeout": {
        // 期限に達していなければ何もしない（早すぎる発火への防御）
        if (state.deadline === null || event.now < state.deadline) return moduleNoop(state);
        return advance(state, event.now);
      }
      case "playerJoined":
        // 既定は観戦（§5）。途中から回答者に加えると、そのターンの「全員正解」の
        // 分母が動いて進行がぶれる。出題順にも入れない
        return moduleNoop(state);
      case "playerLeft": {
        const player = state.players[event.playerId];
        if (player === undefined || !player.connected) return moduleNoop(state);
        const next = clone(state);
        next.players[event.playerId] = { ...player, connected: false };
        // **出題者が切断したらそのターンは打ち切る。**待っても描き手がいないので
        // 卓が90秒止まるだけになる。答えを見せてから次の人へ回す
        if (currentDrawerId(next) === event.playerId && next.phase === "draw") {
          return endTurn(next, event.now, "drawerLeft");
        }
        // 残った回答者が全員正解済みなら、切断者を待たずに答え合わせへ進む
        return advanceIfAllCorrect(next, event.now) ?? moduleOk(next, [{ t: "viewChanged" }]);
      }
      case "playerRejoined": {
        const player = state.players[event.playerId];
        if (player === undefined || player.connected) return moduleNoop(state);
        const next = clone(state);
        next.players[event.playerId] = { ...player, connected: true };
        return moduleOk(next, [{ t: "viewChanged" }]);
      }
      case "playerKicked": {
        const kicked = state.players[event.playerId];
        if (kicked === undefined) return moduleNoop(state);
        const wasDrawer = currentDrawerId(state) === event.playerId;
        const next = clone(state);
        next.order = next.order.filter((id) => id !== event.playerId);
        // turnOrder からは**消さない**。消すと turnIndex がずれて「いま誰が描いているか」が
        // 変わってしまう。在籍から消えた人は beginTurn の接続チェックで自然に飛ばされる
        delete next.players[event.playerId];
        delete next.scores[event.playerId];
        next.correct = renumberCorrect(next.correct.filter((c) => c.playerId !== event.playerId));
        if (next.lastResult !== null) {
          next.lastResult = {
            ...next.lastResult,
            correct: renumberCorrect(
              next.lastResult.correct.filter((c) => c.playerId !== event.playerId),
            ),
          };
        }
        if (!next.running) return moduleOk(next, [{ t: "viewChanged" }]);
        // 在籍が minPlayers を割ったら中断する（§5）
        if (next.order.length < drawModule.meta.minPlayers) {
          return finish(next, "tooFewPlayers");
        }
        if (wasDrawer && next.phase === "draw") {
          // 出題者がキックされたらそのターンは打ち切る。名前は消す前の値を渡す
          return endTurn(next, event.now, "drawerKicked", {
            id: event.playerId,
            name: kicked.nickname,
          });
        }
        return advanceIfAllCorrect(next, event.now) ?? moduleOk(next, [{ t: "viewChanged" }]);
      }
      case "skipPhase":
        // ホストの操作で現フェーズを打ち切る。期限前でも進める
        return advance(state, event.now);
      case "endGame":
        return finish(state, "hostEnded");
    }
  },

  view(state: DrawState, viewerId: string): DrawView {
    const revealed = state.phase !== "draw";
    // 答え合わせ中は、確定した結果のほうを出題者の正本にする。
    // 出題者がキックされた直後は players から消えており、名前が引けないため
    const drawerId = revealed && state.lastResult !== null
      ? state.lastResult.drawerId
      : currentDrawerId(state);
    const drawerName = revealed && state.lastResult !== null
      ? state.lastResult.drawerName
      : state.players[drawerId]?.nickname ?? "";
    const youAreDrawer = drawerId === viewerId;
    const mine = state.correct.find((c) => c.playerId === viewerId) ?? null;
    const view: DrawView = {
      kind: "draw",
      phase: state.phase,
      turn: state.turnIndex + 1,
      totalTurns: state.turnOrder.length,
      drawerId,
      drawerName,
      youAreDrawer,
      // ---- ここが本ゲームの生命線 ----
      // draw 中にお題が載るのは出題者の view だけ。回答者には null を入れる。
      // reveal / final は答え合わせなので全員に見せる（§2.6）
      topic: youAreDrawer || revealed ? state.topic : null,
      topicLength: charCount(state.topic),
      strokes: state.strokes,
      rev: state.rev,
      pointCount: state.pointCount,
      pointMax: DRAW_MAX_POINTS,
      correct: state.correct,
      guesserCount: guesserIds(state).length,
      myCorrectOrder: mine?.order ?? null,
      myTurnPoints: mine?.points ?? 0,
      players: state.order.map((id) => {
        const player = state.players[id];
        return {
          playerId: id,
          nickname: player?.nickname ?? "",
          connected: player?.connected ?? false,
          correct: state.correct.some((c) => c.playerId === id),
          drawer: id === drawerId,
        };
      }),
      standings: buildStandings(state),
    };
    if (revealed && state.lastResult !== null) view.result = state.lastResult;
    return view;
  },
};

// ---------------------------------------------------------------------------
// clientEvent（描画）
// ---------------------------------------------------------------------------

/**
 * 描き手からの gameEvent を処理する。受理する payload は次の4種類だけ（§9.1）。
 *   { k:"draw",  s:<ストロークID>, c:<色番号>, w:<太さ番号>, p:[x,y,...] }
 *   { k:"end" }    … ストロークの終わり。間引きを飛ばして必ず配信する
 *   { k:"undo" }   … 直近のストロークを消す
 *   { k:"clear" }  … 全部消す
 * **描き手以外は一切描けない**ことをここで保証する
 */
function handleClientEvent(
  state: DrawState,
  playerId: string,
  payload: unknown,
  now: number,
): ModuleResult<DrawState> {
  if (!isRecord(payload)) {
    return moduleFail(state, "INVALID_INPUT", "ゲーム内イベントの形式が正しくありません");
  }
  const kind = readKind(payload);
  if (kind !== "draw" && kind !== "end" && kind !== "undo" && kind !== "clear") {
    return moduleFail(state, "INVALID_INPUT", "未知のゲーム内イベントです");
  }
  if (state.phase !== "draw") {
    return moduleFail(state, "PHASE_MISMATCH", "いまは描く時間ではありません");
  }
  // 描き手以外は描けない（サーバー側の保証。改造クライアントでも通らない）
  if (currentDrawerId(state) !== playerId) {
    return moduleFail(state, "PHASE_MISMATCH", "いまは出題者だけが描けます");
  }
  switch (kind) {
    case "draw":
      return applyChunk(state, payload, now);
    case "end":
      // 間引きで溜まった分を確実に配る（描き終わりが欠けたまま止まらないように）
      return flush(state, now);
    case "undo": {
      if (state.strokes.length === 0) return moduleNoop(state);
      const next = clone(state);
      const removed = next.strokes.pop();
      next.pointCount -= (removed?.points.length ?? 0) / 2;
      next.rev += 1;
      next.lastViewAt = now;
      return moduleOk(next, [{ t: "viewChanged" }]);
    }
    case "clear": {
      if (state.strokes.length === 0) return moduleNoop(state);
      const next = clone(state);
      next.strokes = [];
      next.pointCount = 0;
      next.rev += 1;
      next.lastViewAt = now;
      return moduleOk(next, [{ t: "viewChanged" }]);
    }
  }
}

/**
 * ストロークのチャンクを検証して履歴に積む（§2.7）。
 * 検証する項目: ストロークID・色・太さ・点列の型と長さ・座標の範囲・履歴の上限
 */
function applyChunk(state: DrawState, payload: unknown, now: number): ModuleResult<DrawState> {
  const strokeId = readInt(payload, "s", 0, DRAW_MAX_STROKES * 4);
  if (strokeId === null) {
    return moduleFail(state, "INVALID_INPUT", "ストロークの指定が正しくありません");
  }
  const color = readInt(payload, "c", 0, DRAW_COLORS - 1);
  if (color === null) return moduleFail(state, "INVALID_INPUT", "色の指定が正しくありません");
  const width = readInt(payload, "w", 0, DRAW_WIDTHS - 1);
  if (width === null) return moduleFail(state, "INVALID_INPUT", "太さの指定が正しくありません");

  const points = readPoints(payload);
  if (points === null) {
    return moduleFail(
      state,
      "INVALID_INPUT",
      `座標は 0〜${DRAW_COORD_MAX} の整数で、1回につき ${DRAW_MAX_CHUNK_POINTS} 点までです`,
    );
  }
  const added = points.length / 2;
  if (state.pointCount + added > DRAW_MAX_POINTS) {
    return moduleFail(
      state,
      "INVALID_INPUT",
      `このターンで描ける量の上限（${DRAW_MAX_POINTS}点）に達しました`,
    );
  }

  const last = state.strokes.length > 0 ? state.strokes[state.strokes.length - 1] : null;
  const next = clone(state);
  if (last !== null && last.id === strokeId) {
    // 同じIDへの追記。色・太さは最初に決めたものを正とする（途中で変えさせない）
    next.strokes[next.strokes.length - 1] = { ...last, points: [...last.points, ...points] };
  } else {
    // 新しいストローク。IDは必ず増えていく（過去のストロークの書き換えを防ぐ）
    if (last !== null && strokeId <= last.id) {
      return moduleFail(state, "INVALID_INPUT", "ストロークの順序が正しくありません");
    }
    if (next.strokes.length >= DRAW_MAX_STROKES) {
      return moduleFail(
        state,
        "INVALID_INPUT",
        `このターンで描ける本数の上限（${DRAW_MAX_STROKES}本）に達しました`,
      );
    }
    next.strokes.push({ id: strokeId, color, width, points });
  }
  next.pointCount += added;
  next.rev += 1;
  // 配信は間引く（全履歴を毎回配るため。冒頭の注記と viewIntervalMs を参照）
  if (now - state.lastViewAt < viewIntervalMs(next.pointCount)) return moduleQuiet(next);
  next.lastViewAt = now;
  return moduleOk(next, [{ t: "viewChanged" }]);
}

/** 間引きで溜まった描画を配る。まだ1本も描いていなければ配る意味が無いので何もしない */
function flush(state: DrawState, now: number): ModuleResult<DrawState> {
  if (state.strokes.length === 0) return moduleNoop(state);
  const next = clone(state);
  next.lastViewAt = now;
  return moduleOk(next, [{ t: "viewChanged" }]);
}

/**
 * 点列（payload.p）を検証して取り出す。
 * 平坦な配列 [x0,y0,x1,y1,...] で、長さは偶数・1〜DRAW_MAX_CHUNK_POINTS 点、
 * 各値は 0〜DRAW_COORD_MAX の整数であること。1つでも外れたら null
 */
function readPoints(payload: unknown): number[] | null {
  if (!isRecord(payload)) return null;
  const raw = payload.p;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0 || raw.length % 2 !== 0) return null;
  if (raw.length > DRAW_MAX_CHUNK_POINTS * 2) return null;
  const out: number[] = [];
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isInteger(value)) return null;
    if (value < 0 || value > DRAW_COORD_MAX) return null;
    out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// chatMessage（回答の判定）
// ---------------------------------------------------------------------------

/**
 * チャット発言を回答として判定する（ユーザー決定の回答方式）。
 *
 * 返す effects に `suppressChat` を入れると、ルーム層はその発言を
 * **履歴に積まず・配信せず・bot にも渡さない**。答えが卓に見えると総取りになるため、
 *   - 回答者の**正解**は隠す（本人には view の myCorrectOrder でフィードバックする）
 *   - **出題者の発言にお題が含まれていたら**隠す（お題の漏洩防止）
 * ハズレの発言はそのまま流す（当てっこの盛り上がりはチャットに出てほしい）
 */
function handleGuess(
  state: DrawState,
  playerId: string,
  text: string,
  now: number,
): ModuleResult<DrawState> {
  if (state.phase !== "draw") return moduleNoop(state);
  const normalized = normalizeAnswer(text);
  if (normalized.length === 0) return moduleNoop(state);
  const drawerId = currentDrawerId(state);

  // 出題者がお題を書いてしまったら、その発言ごと隠す（部分一致で見る）
  if (playerId === drawerId) {
    const leaks = state.answers.some((a) => a.length > 0 && normalized.includes(a));
    return leaks ? { state, changed: false, effects: [{ t: "suppressChat" }] } : moduleNoop(state);
  }
  // 観戦者（途中参加）と、すでに正解した人は判定しない。発言はそのまま流す
  if (state.players[playerId] === undefined) return moduleNoop(state);
  if (state.correct.some((c) => c.playerId === playerId)) return moduleNoop(state);
  // 完全一致だけを正解にする。部分一致にすると「りんごかな？」のような
  // 独り言まで正解になり、逆に文中に答えを混ぜた発言で他人に答えが見えてしまう
  if (!state.answers.includes(normalized)) return moduleNoop(state);

  const order = state.correct.length + 1;
  const points = CORRECT_POINTS[Math.min(order - 1, CORRECT_POINTS.length - 1)];
  const next = clone(state);
  next.correct.push({
    playerId,
    nickname: next.players[playerId]?.nickname ?? "",
    order,
    points,
  });
  next.scores[playerId] = (next.scores[playerId] ?? 0) + points;
  // 全員当てたら期限を待たずに答え合わせへ
  const advanced = advanceIfAllCorrect(next, now);
  if (advanced !== null) {
    return { ...advanced, effects: [...advanced.effects, { t: "suppressChat" }] };
  }
  return moduleOk(next, [{ t: "viewChanged" }, { t: "suppressChat" }]);
}

// ---------------------------------------------------------------------------
// 進行
// ---------------------------------------------------------------------------

/** 現ターンの出題者。turnOrder が空なら空文字 */
function currentDrawerId(state: DrawState): string {
  return state.turnOrder[state.turnIndex] ?? "";
}

/** 現ターンに回答できる人（出題者以外の在籍者） */
function guesserIds(state: DrawState): string[] {
  const drawerId = currentDrawerId(state);
  return state.order.filter((id) => id !== drawerId);
}

/** 接続している回答者が全員正解していれば答え合わせへ進める。まだなら null */
function advanceIfAllCorrect(state: DrawState, now: number): ModuleResult<DrawState> | null {
  if (state.phase !== "draw") return null;
  const waiting = guesserIds(state).filter((id) =>
    state.players[id]?.connected === true && !state.correct.some((c) => c.playerId === id)
  );
  if (waiting.length > 0) return null;
  // 回答できる人が誰も居ない（全員切断など）ときも、待つ意味が無いので進める
  return endTurn(state, now, null);
}

/** 現フェーズを終えて次へ進める */
function advance(state: DrawState, now: number): ModuleResult<DrawState> {
  switch (state.phase) {
    case "draw":
      return endTurn(state, now, null);
    case "reveal":
      return beginTurn(state, state.turnIndex + 1, now);
    case "final":
      return finish(state, "completed");
  }
}

/**
 * ターンを終えて答え合わせへ。出題者には正解者1人につき1点（上限あり）。
 * aborted は出題者が居なくなって打ち切ったときの理由
 */
function endTurn(
  state: DrawState,
  now: number,
  aborted: "drawerLeft" | "drawerKicked" | null,
  drawerOverride?: { id: string; name: string },
): ModuleResult<DrawState> {
  const next = clone(state);
  const drawerId = drawerOverride?.id ?? currentDrawerId(state);
  const drawerName = drawerOverride?.name ?? state.players[drawerId]?.nickname ?? "";
  // 打ち切りのときは出題者に点を入れない（描き切っていないため）
  const drawerPoints = aborted === null ? Math.min(next.correct.length, DRAWER_POINT_CAP) : 0;
  if (drawerPoints > 0 && next.scores[drawerId] !== undefined) {
    next.scores[drawerId] += drawerPoints;
  }
  next.lastResult = {
    turn: next.turnIndex + 1,
    drawerId,
    drawerName,
    topic: next.topic,
    correct: [...next.correct],
    drawerPoints,
    aborted,
  };
  next.phase = "reveal";
  next.deadline = now + REVEAL_MS;
  next.lastViewAt = now;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: next.deadline },
  ]);
}

/**
 * index 番目のターンを始める。接続していない人は出題者に立てず飛ばす
 * （60秒の猶予いっぱい卓が止まるのを避ける）。描ける人が居なくなったら最終結果へ
 */
function beginTurn(state: DrawState, index: number, now: number): ModuleResult<DrawState> {
  let i = index;
  while (i < state.turnOrder.length && state.players[state.turnOrder[i]]?.connected !== true) {
    i++;
  }
  if (i >= state.turnOrder.length) return toFinal(state, now);

  const next = clone(state);
  next.turnIndex = i;
  next.phase = "draw";
  next.strokes = [];
  next.pointCount = 0;
  next.rev = 0;
  next.correct = [];
  // ターンの最初のチャンクは必ず配信したいので、間引きの窓を開けた状態から始める
  next.lastViewAt = now - MAX_VIEW_INTERVAL_MS;
  next.deadline = now + DRAW_MS;

  // お題を決める。使い切ったら一巡させる（同じゲーム中の重複を避けるため）
  const pool = next.remainingTopics.length > 0
    ? next.remainingTopics
    : DRAW_TOPICS.map((_, k) => k);
  const pick = randomInt(next.seed, 0, pool.length);
  next.seed = pick.seed;
  const topicIndex = pool[pick.value];
  next.remainingTopics = pool.filter((k) => k !== topicIndex);
  const topic = DRAW_TOPICS[topicIndex];
  next.topic = topic.word;
  next.answers = acceptedForms(topic);

  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: next.deadline },
  ]);
}

/** 最終結果の表示へ。FINAL_MS 後の timeout で終了する */
function toFinal(state: DrawState, now: number): ModuleResult<DrawState> {
  const next = clone(state);
  next.phase = "final";
  next.deadline = now + FINAL_MS;
  next.lastViewAt = now;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: next.deadline },
  ]);
}

/**
 * ゲームを終える。score は1ゲーム1回、schedule は必ず解除する。
 * 終了後も state は捨てず、最終結果を表示したままにする（running のみ false）
 */
function finish(
  state: DrawState,
  reason: "completed" | "tooFewPlayers" | "hostEnded",
): ModuleResult<DrawState> {
  const next = clone(state);
  next.running = false;
  next.phase = "final";
  next.deadline = null;
  return moduleOk(next, [
    { t: "viewChanged" },
    { t: "schedule", at: null },
    { t: "score", totals: buildScoreEntries(next) },
    { t: "ended", reason },
  ]);
}

/** 正解者の並びから抜けが出たとき、order を1から振り直す（点はそのまま） */
function renumberCorrect(entries: DrawCorrectEntry[]): DrawCorrectEntry[] {
  return entries.map((entry, index) => ({ ...entry, order: index + 1 }));
}

/** 得点の順位表。同点は同順位（engine.ts の順位付けと同じ規則） */
function buildStandings(state: DrawState): DrawStanding[] {
  const rows = state.order.map((id) => ({
    playerId: id,
    nickname: state.players[id]?.nickname ?? "",
    score: state.scores[id] ?? 0,
    rank: 0,
  }));
  rows.sort((a, b) => b.score - a.score);
  let rank = 0;
  let previous: number | null = null;
  rows.forEach((row, index) => {
    if (previous === null || row.score !== previous) {
      rank = index + 1;
      previous = row.score;
    }
    row.rank = rank;
  });
  return rows;
}

/** 公式スコアへ渡す1ゲーム分の得点 */
function buildScoreEntries(state: DrawState): ScoreEntry[] {
  return buildStandings(state).map((row) => ({
    playerId: row.playerId,
    nickname: row.nickname,
    roundScore: 0,
    totalScore: row.score,
    rank: row.rank,
  }));
}
