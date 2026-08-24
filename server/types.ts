/**
 * 宴 -EN- サーバー共通型定義
 * 詳細仕様書 v0.3 の §3.5 / §4 / §5 に対応する。
 * §4.3 で「コア実装で確定」とされた型（Phase / RoomSnapshot / PhaseView /
 * ScoreEntry / PlayerPublic / GameState）はこのファイルで確定させる。
 */

// ---------------------------------------------------------------------------
// 定数（仕様書に明記された上限値）
// ---------------------------------------------------------------------------

/** ルーム定員（§3.1） */
export const ROOM_CAPACITY = 10;
/** VC に参加できる最大人数。7人目以降は VC なし（§3.1） */
export const VC_CAPACITY = 6;
/** ニックネームの最大文字数（§3.1） */
export const NICKNAME_MAX = 20;
/** 公開ルーム名の最大文字数（§3.1） */
export const ROOM_NAME_MAX = 20;
/** ルームコードの桁数（§1） */
export const ROOM_CODE_LENGTH = 6;
/** 共有コードの桁数（§3.5） */
export const SHARE_CODE_LENGTH = 8;
/** 1アカウントが保存できるゲーム定義の上限（§3.5） */
export const GAMES_PER_USER_MAX = 50;
/** ゲーム定義1件の直列化サイズ上限（バイト、§3.8） */
export const GAME_DEFINITION_BYTES_MAX = 64 * 1024;
/** ノック承認〜入室の猶予（ミリ秒、§3.1.1） */
export const ENTRY_TOKEN_TTL_MS = 60_000;
/** ノック申請の自動拒否までの時間（ミリ秒、§3.1 / §8） */
export const KNOCK_TTL_MS = 60_000;
/** 切断からセッションを破棄するまでの猶予（ミリ秒、§3.2） */
export const DISCONNECT_GRACE_MS = 60_000;
/** 1ルームで保留にできるノックの最大件数（§3.8） */
export const PENDING_KNOCK_MAX = 5;
/** チャット1件の最大文字数（§3.9） */
export const CHAT_TEXT_MAX = 200;
/** ルームが保持するチャット履歴の最大件数（§3.9） */
export const CHAT_HISTORY_MAX = 100;
/** チャットのレート制限: 判定窓（ミリ秒、§3.9） */
export const CHAT_RATE_WINDOW_MS = 10_000;
/** チャットのレート制限: 判定窓内に送れる最大件数（§3.9） */
export const CHAT_RATE_MAX = 5;

// ---------------------------------------------------------------------------
// §5 データモデル
// ---------------------------------------------------------------------------

/** アカウント。パスワードは PBKDF2-HMAC-SHA256 でハッシュ化して保存する（§3.0） */
export type User = {
  /** 半角英数 4..20 文字。一意 */
  userId: string;
  /** PBKDF2-HMAC-SHA256 600,000回のハッシュ（Base64） */
  passwordHash: string;
  /** ユーザーごとのランダム salt（Base64、16バイト以上） */
  salt: string;
  /** 登録時刻（epoch ms） */
  createdAt: number;
};

/** 認証セッション。KV `authSession:{token}` に保存する（§3.0） */
export type AuthSession = {
  /** セッションの所有者 */
  userId: string;
  /** 失効時刻（epoch ms、発行から30日） */
  expiresAt: number;
};

/** ルーム内の参加者（サーバーのメモリ上のみ、§5） */
export type Player = {
  /** ルーム内で一意な参加者ID（サーバー採番） */
  id: string;
  /** 表示名。20文字以内 */
  nickname: string;
  /** WebSocket が接続中か */
  connected: boolean;
  /** 切断時刻（epoch ms）。再接続猶予の判定に使う */
  disconnectedAt?: number;
  /** 再接続の本人確認に使うセッショントークン */
  sessionToken: string;
  /** 累計スコア（ゲーム横断の表示用） */
  score: number;
  /** ログイン済みの場合のアカウントID（他者には公開しない） */
  userId?: string;
};

/** 公開ルームへの入室申請（§3.1.1） */
export type Knock = {
  /** 申請の一意ID */
  knockId: string;
  /** 申請先ルームの6桁コード */
  roomCode: string;
  /** 申請者が名乗ったニックネーム。join 時に一致検証する */
  nickname: string;
  /** 申請者のセッショントークン（ブロック判定に使う） */
  sessionToken: string;
  /** 申請時刻（epoch ms） */
  createdAt: number;
  /** 自動拒否される時刻（epoch ms、createdAt + 60秒） */
  expiresAt: number;
};

/** ノック承認時に発行するワンタイム入室許可（§3.1.1） */
export type PendingEntry = {
  /** 16バイト以上のランダム値を16進化したトークン */
  entryToken: string;
  /** 承認時のニックネーム。join 時に一致検証する */
  nickname: string;
  /** 承認された申請者のセッショントークン */
  sessionToken: string;
  /** 発行時刻（epoch ms） */
  issuedAt: number;
  /** 失効時刻（epoch ms、issuedAt + 60秒） */
  expiresAt: number;
  /** 消費済みフラグ（使用は1回限り） */
  used: boolean;
};

/** チャット1件（§3.9）。bot 発言は playerId が null で bot: true */
export type ChatMessage = {
  /** 発言の一意ID */
  id: string;
  /** 発言者の playerId。bot 発言は null */
  playerId: string | null;
  /** 発言時点の表示名 */
  nickname: string;
  /** 本文。200文字以内・制御文字なし */
  text: string;
  /** 発言時刻（epoch ms） */
  at: number;
  /** bot の発言か（§3.10） */
  bot: boolean;
};

/** ルーム。プロセスメモリ上のみで保持し KV には置かない（§5） */
export type Room = {
  /** 6桁の参加コード */
  code: string;
  /** 公開 / 招待制。作成後は変更不可 */
  visibility: RoomVisibility;
  /** ルーム名（公開ルームのみ必須、20文字以内） */
  roomName?: string;
  /** 作成者のアカウントID */
  ownerUserId: string;
  /** 現在のホストの playerId */
  hostId: string;
  /** 参加者一覧（playerId → Player） */
  players: Map<string, Player>;
  /** 保留中のノック（公開ルームのみ、knockId → Knock） */
  pendingKnocks: Map<string, Knock>;
  /** 未使用の入室許可（entryToken → PendingEntry） */
  pendingEntries: Map<string, PendingEntry>;
  /** キック済み sessionToken。再入室・再ノックを拒否する */
  blockedSessions: Set<string>;
  /** ルームで選択できるゲーム定義（公式＋インポート分、gameId → 定義） */
  availableGames: Map<string, GameDefinition>;
  /** 選択中のゲームID */
  selectedGameId: string | null;
  /** 進行中のゲーム状態。未開始は null */
  game: GameState | null;
  /** チャット履歴。直近 CHAT_HISTORY_MAX 件のみ・古い順（§3.9） */
  chatHistory: ChatMessage[];
  /** 作成時刻（epoch ms） */
  createdAt: number;
  /** 最終アクティビティ時刻（epoch ms、24時間で自動削除） */
  lastActiveAt: number;
};

/** ルームの公開設定 */
export type RoomVisibility = "public" | "private";

// ---------------------------------------------------------------------------
// §3.5 ゲーム定義
// ---------------------------------------------------------------------------

/** 入力方式。text は自由記述、choice は選択肢 */
export type InputType = "text" | "choice";
/** reveal の表示方式。anonymous は匿名シャッフル、named は実名 */
export type RevealMode = "anonymous" | "named";
/** 採点方式（§3.4） */
export type ScoringMode = "vote" | "match" | "correct";

/** 出題1件。inputType に対応する kind のみ使える */
export type Prompt =
  | { kind: "open"; text: string }
  | { kind: "choice"; text: string; options: string[]; answer?: number };

/** ゲーム1本を宣言的に記述したデータ。実行可能スクリプトは含まない（§3.5） */
export type GameDefinition = {
  /** ゲームID（uuid。公式ゲームは固定ID） */
  id: string;
  /** 作成者のアカウントID。サーバーが付与しクライアント指定は不可 */
  ownerId: string;
  /** タイトル。20文字以内 */
  title: string;
  /** 説明。100文字以内 */
  description?: string;
  /** ラウンド数。1..10 */
  rounds: number;
  /** 入力方式 */
  inputType: InputType;
  /** 入力フェーズの制限秒数。10..180 */
  inputTimeSec: number;
  /** reveal の表示方式 */
  reveal: RevealMode;
  /** 採点方式 */
  scoring: ScoringMode;
  /** 出題。1..50件 */
  prompts: Prompt[];
};

/** ゲーム定義から id / ownerId を除いた入稿データ（クライアントが送る形） */
export type GameDefinitionDraft = Omit<GameDefinition, "id" | "ownerId">;

/** 一覧・選択 UI 向けの要約。prompts を含まない */
export type GameSummary = {
  /** ゲームID */
  id: string;
  /** タイトル */
  title: string;
  /** 説明 */
  description?: string;
  /** ラウンド数 */
  rounds: number;
  /** 入力方式 */
  inputType: InputType;
  /** 採点方式 */
  scoring: ScoringMode;
  /** 出題件数 */
  promptCount: number;
  /** 公式ゲームかどうか */
  official: boolean;
};

// ---------------------------------------------------------------------------
// §3.3 フェーズとゲーム状態（§4.3 の確定分）
// ---------------------------------------------------------------------------

/** ゲーム進行のフェーズ。遷移はサーバーのみが決定する（§3.3） */
export type Phase =
  | "lobby"
  | "intro"
  | "prompt"
  | "input"
  | "reveal"
  | "judge"
  | "roundResult"
  | "finalResult";

/** ゲーム内での役割。途中参加者はそのラウンド中は観戦のみ（§8） */
export type ParticipantRole = "player" | "spectator";

/** ゲームに紐づく参加者の状態。エンジンが保持する最小情報 */
export type GameParticipant = {
  /** playerId */
  id: string;
  /** 表示名 */
  nickname: string;
  /** player は採点対象、spectator は観戦のみ */
  role: ParticipantRole;
  /** 接続中か。false の間は完了判定から除外する（§8） */
  connected: boolean;
};

/** 1ラウンド分の提出内容 */
export type Submission = {
  /** 提出者の playerId */
  playerId: string;
  /** text は文字列、choice は選択肢の添字 */
  value: string | number;
  /** 提出時刻（epoch ms）。correct の早さボーナスに使う */
  at: number;
};

/** 各フェーズの既定表示秒数。input のみゲーム定義の inputTimeSec を使う */
export type PhaseDurations = {
  /** intro の表示秒数 */
  introSec: number;
  /** prompt（お題提示）の表示秒数 */
  promptSec: number;
  /** reveal（回答公開）の表示秒数 */
  revealSec: number;
  /** judge の秒数。vote 方式ではこの時間が投票時間になる */
  judgeSec: number;
  /** roundResult の表示秒数 */
  roundResultSec: number;
  /** finalResult の表示秒数 */
  finalResultSec: number;
};

/** ゲーム進行の全状態。エンジンはこの値を不変オブジェクトとして扱う */
export type GameState = {
  /** 進行中のゲーム定義 */
  definition: GameDefinition;
  /** 現在のフェーズ */
  phase: Phase;
  /** 現在のラウンド。1..definition.rounds（開始前は 0） */
  round: number;
  /** 現在の出題の添字。prompts.length を超える分は巡回する */
  promptIndex: number;
  /** 現フェーズの期限（epoch ms）。期限なしは null */
  deadline: number | null;
  /** フェーズ秒数の設定 */
  durations: PhaseDurations;
  /** 参加者（playerId → 状態） */
  participants: Record<string, GameParticipant>;
  /** 参加者の並び順。同点時の順位を安定させるために保持する */
  order: string[];
  /** 当ラウンドの提出（playerId → Submission） */
  submissions: Record<string, Submission>;
  /** 当ラウンドの投票（投票者 playerId → 投票先 playerId） */
  votes: Record<string, string>;
  /** 当ラウンドの得点（playerId → 点） */
  roundScores: Record<string, number>;
  /** 累計得点（playerId → 点） */
  totalScores: Record<string, number>;
  /** 直近に確定した順位表。roundResult / finalResult の表示に使う */
  lastScores: ScoreEntry[];
  /** ゲーム開始時刻（epoch ms） */
  startedAt: number;
};

/** 得点の内訳。採点方式ごとに使うフィールドが異なる */
export type ScoreDetail = {
  /** vote: 獲得した票数 */
  votes?: number;
  /** match: 自分以外に同じ回答をした人数 */
  matchCount?: number;
  /** match: 全員一致ボーナスを得たか */
  allMatchBonus?: boolean;
  /** correct: 正解したか */
  correct?: boolean;
  /** correct: 早さボーナスの点 */
  speedBonus?: number;
};

/** 順位表の1行（§4.1 roundResult / finalResult） */
export type ScoreEntry = {
  /** 対象の playerId */
  playerId: string;
  /** 表示名 */
  nickname: string;
  /** 当ラウンドの得点 */
  roundScore: number;
  /** 累計得点 */
  totalScore: number;
  /** 累計得点による順位（同点は同順位） */
  rank: number;
  /** 得点の内訳 */
  detail?: ScoreDetail;
};

// ---------------------------------------------------------------------------
// §4 クライアントへ送る公開表現
// ---------------------------------------------------------------------------

/** 他の参加者にも見せてよい参加者情報。sessionToken / userId は含めない（§3.2 原則3） */
export type PlayerPublic = {
  /** playerId */
  id: string;
  /** 表示名 */
  nickname: string;
  /** 接続中か */
  connected: boolean;
  /** ホストか */
  isHost: boolean;
  /** 累計得点 */
  score: number;
  /** VC 枠に入っているか。7人目以降は false（§3.1） */
  vcEligible: boolean;
};

/** ホストにのみ送るノック申請の公開表現（§3.2 原則3） */
export type KnockPublic = {
  /** 申請の一意ID */
  knockId: string;
  /** 申請者のニックネーム */
  nickname: string;
  /** 申請時刻（epoch ms） */
  createdAt: number;
  /** 自動拒否される時刻（epoch ms） */
  expiresAt: number;
};

/** reveal / judge で表示する回答1件 */
export type RevealEntry = {
  /** 投票先の指定に使う不透明ID。匿名時もクライアントは表示に使わない */
  playerId: string;
  /** 回答本体。choice の場合は選択肢の添字 */
  value: string | number;
  /** reveal:"named" のときだけ入る表示名 */
  nickname?: string;
};

/** lobby: ゲーム未開始 */
export type LobbyPhaseView = {
  phase: "lobby";
  /** 選択中のゲームID */
  selectedGameId: string | null;
};

/** intro: ゲームの説明表示 */
export type IntroPhaseView = {
  phase: "intro";
  /** ゲームのタイトル */
  title: string;
  /** ゲームの説明 */
  description?: string;
  /** 総ラウンド数 */
  totalRounds: number;
  /** 入力方式 */
  inputType: InputType;
  /** 採点方式 */
  scoring: ScoringMode;
  /** reveal の表示方式 */
  reveal: RevealMode;
  /** 入力の制限秒数 */
  inputTimeSec: number;
};

/** prompt: お題の提示のみ。choice の正解は含めない */
export type PromptPhaseView = {
  phase: "prompt";
  /** 現在のラウンド */
  round: number;
  /** 総ラウンド数 */
  totalRounds: number;
  /** お題本文 */
  promptText: string;
  /** choice のときの選択肢 */
  options?: string[];
};

/** input: 回答入力。正解は隠し、他人の回答内容も送らない */
export type InputPhaseView = {
  phase: "input";
  /** 現在のラウンド */
  round: number;
  /** 総ラウンド数 */
  totalRounds: number;
  /** お題本文 */
  promptText: string;
  /** 入力方式 */
  inputType: InputType;
  /** choice のときの選択肢 */
  options?: string[];
  /** 受信者が提出済みか */
  submitted: boolean;
  /** 受信者が提出できるか（観戦者・切断者は false） */
  canSubmit: boolean;
  /** 提出済み人数（進捗表示用。内容は含めない） */
  submittedCount: number;
  /** 提出対象の人数 */
  participantCount: number;
};

/** reveal: 回答の公開。correct 方式のみここで正解も開示する */
export type RevealPhaseView = {
  phase: "reveal";
  /** 現在のラウンド */
  round: number;
  /** 総ラウンド数 */
  totalRounds: number;
  /** お題本文 */
  promptText: string;
  /** 入力方式 */
  inputType: InputType;
  /** choice のときの選択肢 */
  options?: string[];
  /** 表示方式 */
  reveal: RevealMode;
  /** 公開する回答。匿名時は毎ラウンド安定な擬似ランダム順 */
  entries: RevealEntry[];
  /** scoring:"correct" のときの正解の添字。ここで初めて開示する */
  answerIndex?: number;
};

/** judge: 採点フェーズ。vote 方式ではここで投票を受け付ける */
export type JudgePhaseView = {
  phase: "judge";
  /** 現在のラウンド */
  round: number;
  /** 総ラウンド数 */
  totalRounds: number;
  /** 採点方式 */
  scoring: ScoringMode;
  /** 表示方式 */
  reveal: RevealMode;
  /** 対象の回答一覧 */
  entries: RevealEntry[];
  /** 受信者が投票できるか（vote 方式かつ提出対象者のみ true） */
  canVote: boolean;
  /** 受信者の投票先。未投票は undefined */
  myVoteTargetId?: string;
  /** 投票済み人数（誰が誰に入れたかは送らない） */
  votedCount: number;
  /** 投票対象の人数 */
  participantCount: number;
};

/** roundResult: ラウンド結果 */
export type RoundResultPhaseView = {
  phase: "roundResult";
  /** 集計対象のラウンド */
  round: number;
  /** 総ラウンド数 */
  totalRounds: number;
  /** 順位表 */
  scores: ScoreEntry[];
  /** 最終ラウンドだったか */
  isFinalRound: boolean;
};

/** finalResult: 最終結果 */
export type FinalResultPhaseView = {
  phase: "finalResult";
  /** 総ラウンド数 */
  totalRounds: number;
  /** 順位表 */
  scores: ScoreEntry[];
};

/** フェーズごとの表示データ。受信者ごとに内容が変わる（§3.2 原則3） */
export type PhaseView =
  | LobbyPhaseView
  | IntroPhaseView
  | PromptPhaseView
  | InputPhaseView
  | RevealPhaseView
  | JudgePhaseView
  | RoundResultPhaseView
  | FinalResultPhaseView;

/** 参加・再接続時に送るフル状態（§4.1 roomState） */
export type RoomSnapshot = {
  /** 6桁の参加コード */
  code: string;
  /** 公開設定 */
  visibility: RoomVisibility;
  /** ルーム名（公開ルームのみ） */
  roomName?: string;
  /** 定員 */
  capacity: number;
  /** 現在のホストの playerId */
  hostId: string;
  /** 受信者自身の playerId */
  youId: string;
  /** 受信者がホストか */
  youAreHost: boolean;
  /** 受信者がこのゲームで観戦扱いか */
  youAreSpectator: boolean;
  /** 参加者一覧 */
  players: PlayerPublic[];
  /** ルームで選択できるゲーム */
  availableGames: GameSummary[];
  /** 選択中のゲームID */
  selectedGameId: string | null;
  /** 現在のフェーズ */
  phase: Phase;
  /** 現フェーズの期限（epoch ms）。期限なしは null */
  deadline: number | null;
  /** 現フェーズの表示データ */
  view: PhaseView;
  /** チャット履歴。直近 CHAT_HISTORY_MAX 件のみ・古い順（§3.9） */
  chat: ChatMessage[];
  /** 保留中のノック。ホストにのみ入る（§3.2 原則3） */
  pendingKnocks?: KnockPublic[];
  /** 受信者自身のセッショントークン。再接続時に join.session として送り返す（§3.2） */
  session?: string;
  /** サーバー時刻（epoch ms）。クライアントの時計ずれ補正用 */
  serverTime: number;
};

// ---------------------------------------------------------------------------
// §4.1 WS メッセージ / §4.2 ErrorCode
// ---------------------------------------------------------------------------

/** エラーコード（§4.2） */
export type ErrorCode =
  | "AUTH_REQUIRED"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "NOT_HOST"
  | "INVALID_TOKEN"
  | "BLOCKED"
  | "RATE_LIMITED"
  | "PHASE_MISMATCH"
  | "INVALID_INPUT"
  | "DUPLICATE";

/** クライアント → サーバー（§4.1） */
export type C2S =
  | {
    t: "createRoom";
    nickname: string;
    visibility: RoomVisibility;
    roomName?: string;
  }
  | {
    t: "join";
    roomCode: string;
    nickname: string;
    session?: string;
    entryToken?: string;
  }
  | { t: "knock"; roomCode: string; nickname: string }
  | { t: "approveKnock"; knockId: string }
  | { t: "rejectKnock"; knockId: string }
  | { t: "kick"; playerId: string }
  | { t: "selectGame"; gameId: string }
  | { t: "startGame" }
  | { t: "skipPhase" }
  | { t: "submitInput"; value: string | number }
  | { t: "submitVote"; targetPlayerId: string }
  | { t: "importGame"; shareCode: string }
  | { t: "chat"; text: string }
  | { t: "rtcSignal"; to: string; payload: unknown }
  | { t: "leave" };

/** サーバー → クライアント（§4.1） */
export type S2C =
  | { t: "roomState"; snapshot: RoomSnapshot }
  | { t: "playerJoined"; player: PlayerPublic }
  | { t: "playerLeft"; player: PlayerPublic }
  | { t: "knockRequest"; knockId: string; nickname: string }
  | {
    t: "knockResult";
    accepted: boolean;
    roomCode?: string;
    entryToken?: string;
  }
  | { t: "kicked" }
  | { t: "playerKicked"; playerId: string }
  | { t: "phase"; phase: Phase; deadline?: number; view: PhaseView }
  | { t: "roundResult"; scores: ScoreEntry[] }
  | { t: "finalResult"; scores: ScoreEntry[] }
  | { t: "hostChanged"; playerId: string }
  | { t: "chat"; message: ChatMessage }
  | { t: "rtcSignal"; from: string; payload: unknown }
  | { t: "error"; code: ErrorCode; message: string };

// ---------------------------------------------------------------------------
// 共通の戻り値
// ---------------------------------------------------------------------------

/** 成否を値で返すための結果型。例外に頼らず ErrorCode を伝える */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; message: string };

/** 成功結果を作る */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** 失敗結果を作る */
export function err<T>(code: ErrorCode, message: string): Result<T> {
  return { ok: false, code, message };
}
