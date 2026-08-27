/**
 * 宴 -EN- サーバー共通型定義
 * 詳細仕様書 v0.3 の §3.5 / §4 / §5 に対応する。
 * §4.3 で「コア実装で確定」とされた型（Phase / RoomSnapshot / PhaseView /
 * ScoreEntry / PlayerPublic / GameState）はこのファイルで確定させる。
 */

import type { RoomTagId } from "./room_tags.ts";

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

/** 合言葉の長さ（§3.1）。口頭で伝える前提なので短すぎず長すぎない範囲にする */
export const PASSPHRASE_MIN = 4;
export const PASSPHRASE_MAX = 20;
/** 卓の説明文の最大文字数 */
export const ROOM_DESCRIPTION_MAX = 100;
/** 卓に付けられるプリセットタグの上限数 */
export const ROOM_TAGS_MAX = 5;
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
/** WS メッセージのレート制限: 判定窓（ミリ秒、§3.8） */
export const WS_RATE_WINDOW_MS = 1_000;
/** WS メッセージのレート制限: 判定窓内に受理できる最大件数。超過で切断（§3.8） */
export const WS_RATE_MAX = 20;
/**
 * WS メッセージのレート制限: rtcSignal（VC シグナリング）の判定窓内最大件数（§3.6 / §3.8）。
 * フルメッシュ5本 × candidate 約10件 + offer/answer で最悪50件程度のバーストを想定し、
 * その2倍の余裕を取った値。判定窓は WS_RATE_WINDOW_MS を一般枠と共用する。
 * 超過分は破棄する（切断しない）。WS は全用途1本共用（§3.2）のため、シグナリングの
 * 超過で切断するとゲーム進行ごと落ちてしまうが、VC は §3.6 のとおりフォールバックできる。
 */
export const WS_SIGNAL_RATE_MAX = 100;
/**
 * WS メッセージのレート制限: rtcSignal のハードキャップ（§3.6 / §3.8）。
 * WS_SIGNAL_RATE_MAX の超過は破棄で済ませるが、これを超える連投は乱用とみなして切断する。
 */
export const WS_SIGNAL_HARD_MAX = 500;

/**
 * WS メッセージのレート制限: gameEvent（docs/design/games-unified.md §2.2 / §9.3）の
 * 判定窓内最大件数。超過分は破棄する（切断しない）。判定窓は WS_RATE_WINDOW_MS を共用する。
 * 【暫定値】。根拠: 廃止した sandboxSignal 用の上限（30件/秒）をそのまま引き継いだもの
 * （設計書 §2.2）。サーバー側の負荷試験は未実施（設計書 §10-2）。
 *
 * main.ts の専用枠（rtcSignal と同構造）へ**適用済み**。
 * 一般枠（WS_RATE_MAX = 20件/秒）のままだと、描画中継（設計書 §2.7 は 10チャンク/秒 を想定）で
 * 描いている本人が切断されてしまうため、お絵かき当ての実装に合わせて配線した。
 */
export const WS_GAME_EVENT_RATE_MAX = 30;
/**
 * gameEvent のハードキャップ。これを超える連投は乱用とみなして切断する。
 * 【暫定値】。根拠は WS_GAME_EVENT_RATE_MAX と同じ（廃止した sandboxSignal の上限の引き継ぎ）。
 * main.ts へ適用済み。
 */
export const WS_GAME_EVENT_HARD_MAX = 150;
/**
 * gameEvent の payload の直列化サイズ上限（バイト、設計書 §9.3）。超過は棄却する。
 * 【暫定値】。根拠は廃止した sandboxSignal の payload 上限（4KB）の引き継ぎ。
 * 元の根拠: MAX_MESSAGE_BYTES（64KB）のままだと 64KB × 30件/秒 × 10人 の受信 →
 * fan-out 9倍 で非現実的な帯域になる。4KB なら1ルームあたり最大 約1.2MB/秒 に収まる。
 * こちらは rooms.ts の gameEvent ハンドラで**すでに適用している**（レート枠と違い、
 * ルーム層だけで完結するため）。
 */
export const GAME_EVENT_PAYLOAD_MAX_BYTES = 4 * 1024;

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
  /** 軽量プロフィールのあだ名。未保存なら undefined（§3.0） */
  nickname?: string;
  /** 軽量プロフィールの趣味タグID配列。最大5個・未保存なら undefined（§3.11） */
  tags?: string[];
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

// ---------------------------------------------------------------------------
// §3.10 場回し bot
// ---------------------------------------------------------------------------

/** bot の識別子（§3.10）。ルームには役割の違う4体がいる */
export type BotId = "shunpi" | "seri" | "gucchi" | "nabe";

/** bot ごとの ON/OFF（§3.10） */
export type BotSwitches = Record<BotId, boolean>;

/**
 * bot 発話の種類（§3.10）。クライアントは表示の出し分けに使う。
 * 文面そのものはサーバー内のデータファイルが持つ（ユーザー投稿は受け付けない）。
 */
export type BotKind =
  | "naming"
  | "senryu"
  | "greeting"
  | "topic"
  | "gameSuggest"
  | "endPoll"
  | "closing"
  | "pollContinue"
  | "reaction"
  | "finalReaction";

/** bot 発話に添えるテロップ演出用のデータ（§3.10） */
export type BotCard =
  | {
    c: "senryu";
    /** 上句・中句・下句 */
    lines: [string, string, string];
    /** 各句の実モーラ数 */
    morae: [number, number, number];
    /** ちょうど 5-7-5 だったか */
    exact: boolean;
    /** 詠んだ人のあだ名 */
    author: string;
  }
  | { c: "gameSuggest"; gameId: string; gameTitle: string }
  | { c: "endPoll"; pollId: string; deadline: number };

/** 集計中の終了アンケート（§3.10）。スナップショットで再接続時に復元する */
export type BotPollPublic = {
  /** 投票を紐づけるID */
  pollId: string;
  /** 締切（epoch ms） */
  deadline: number;
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
  /** どの bot の発言か（§3.10）。bot が false の発言には入らない */
  botId?: BotId;
  /** 発話の種類（§3.10）。表示の出し分けに使う */
  botKind?: BotKind;
  /** テロップ演出用の付加情報（§3.10） */
  card?: BotCard;
};

/**
 * 通話の文字起こし1行（§3.6 + docs/design/bot-voice.md）。
 * チャット（§3.9）とは別枠。履歴（chatHistory）には積まず、永続化もしない。
 */
export type VoiceLine = {
  /** 発言の一意ID */
  id: string;
  /** 喋った人の playerId */
  playerId: string;
  /** 発言時点の表示名 */
  nickname: string;
  /** 認識結果。200文字以内・制御文字なし */
  text: string;
  /** 受信時刻（epoch ms） */
  at: number;
};

/**
 * 進行中のゲーム1本（docs/design/games-unified.md §2.1）。
 *
 * state の中身はモジュールごとに異なるため、ルーム層は unknown のまま持ち運び、
 * 解釈は必ず moduleId で引いたモジュール（server/games/index.ts）に任せる。
 * ここを特定の型（かつて GameState だった）に固定すると、専用モジュールの state を
 * 載せるたびに型の嘘（キャスト）が要るため、意図的に unknown にしてある
 */
export type ActiveGame = {
  /** カタログ上のモジュールID（server/games/index.ts の正本） */
  moduleId: string;
  /** モジュールが持つ状態。ルーム層は中身を解釈しない */
  state: unknown;
  /**
   * 進行中か。モジュールが `ended` 効果を出した時点で false になる。
   * 終了後も state を捨てないのは、最終結果の表示（view）を配り続けるため
   */
  running: boolean;
};

/** ルーム。プロセスメモリ上のみで保持し KV には置かない（§5） */
export type Room = {
  /** 6桁の参加コード */
  code: string;
  /** 公開 / 招待制。作成後は変更不可 */
  visibility: RoomVisibility;
  /**
   * 公開ルームの入室方式（§3.1）。作成後は変更不可。
   * open  … 一覧から選んで承認なしで即入室
   * knock … ノック → ホスト承認 → entryToken で入室（§3.1.1）
   * 招待制ルームでは使わない（常に open 相当）
   */
  entryMode: RoomEntryMode;
  /** ルーム名（公開ルームのみ必須、20文字以内） */
  roomName?: string;
  /**
   * 合言葉（合言葉ルームのみ・4〜20文字、§3.1）。
   * **クライアントへは絶対に送らない**（§4.3 で明記された制約）。
   * 知っている人だけが入れる、という性質そのものが合言葉の価値なので、
   * スナップショットにも公開一覧にも載せてはならない。
   */
  passphrase?: string;
  /** 卓の説明文（100文字以内・任意） */
  description?: string;
  /** プリセットタグ（最大5個・任意） */
  tags?: RoomTagId[];
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
  /** 進行中のゲーム。未開始は null（docs/design/games-unified.md §2.1） */
  game: ActiveGame | null;
  /** チャット履歴。直近 CHAT_HISTORY_MAX 件のみ・古い順（§3.9） */
  chatHistory: ChatMessage[];
  /** 作成時刻（epoch ms） */
  createdAt: number;
  /** 最終アクティビティ時刻（epoch ms、24時間で自動削除） */
  lastActiveAt: number;
};

/** ルームの公開設定 */
export type RoomVisibility = "public" | "private";

/** 公開ルームの入室方式（§3.1）。既定は open */
export type RoomEntryMode = "open" | "knock";

/** 同一セッションから同一ルームへノックできる間隔（ミリ秒、§3.8） */
export const KNOCK_RATE_WINDOW_MS = 10_000;

/** ランダムマッチの成立判定の周期（ミリ秒、§3.1.2） */
export const MATCH_INTERVAL_MS = 30_000;
/** 1グループの上限人数（§3.1.2）。これを超える待機は次の周期へ回る */
export const MATCH_GROUP_MAX = 4;
/** 成立に必要な最少人数（§3.1.2） */
export const MATCH_GROUP_MIN = 2;
/** 待機列に並べる人数の上限（§3.1.2） */
export const MATCH_QUEUE_MAX = 100;

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
  /** ラウンド数。kind:"prompt" のみ */
  rounds?: number;
  /** 入力方式。kind:"prompt" のみ */
  inputType?: InputType;
  /** 採点方式。kind:"prompt" のみ */
  scoring?: ScoringMode;
  /** 出題件数。kind:"prompt" のみ */
  promptCount?: number;
  /** 開始に必要な最少人数。kind:"module" のみ（prompt はエンジン共通の MIN_PLAYERS） */
  minPlayers?: number;
  /** 参加できる最大人数。kind:"module" のみ */
  maxPlayers?: number;
  /** 公式ゲームかどうか */
  official: boolean;
  /**
   * どの基盤で動くゲームか（docs/design/games-unified.md §4）。
   * prompt … 宣言的データ（GameDefinition）を prompt モジュールが進行させる
   * module … 専用のゲームモジュール（server/games/<id>.ts）
   *
   * 省略時は prompt とみなす。必須にすると gamedef.ts の toSummary（宣言的データ専用で、
   * 常に prompt になる）まで書き換えが要るため、当面は任意フィールドにしてある。
   * ルーム層（rooms.ts の buildSnapshot）は両方の種別に必ず明示して載せる
   */
  kind?: "prompt" | "module";
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

/**
 * 卓としてのフェーズ（docs/design/games-unified.md §3.2）。
 *
 * 専用モジュール型のゲームは内訳のフェーズを自前で持ち、表示は S2C `gameView` が担うので、
 * 卓の外からは "playing"（遊んでいる最中）としか見えない。
 * エンジン（engine.ts）が扱うのはあくまで上の Phase であり、この語彙は
 * ルーム層とクライアントの間だけで使う
 */
export type RoomPhase = Phase | "playing";

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
  /**
   * 匿名 reveal 用の不透明トークン（**現在のラウンド分だけ**）。playerId → トークン。
   * ラウンド開始時に revealTokenPool から配り直すため、同じ人でもラウンドごとに別の値になる。
   * **サーバー内部専用で、いかなる view にも載せてはならない**（§3.2 原則3）。
   */
  revealTokens: Record<string, string>;
  /**
   * ラウンドごとに配るトークンの束（添字 = round-1、各ラウンド ROOM_CAPACITY 個）。
   * ゲーム開始時に暗号乱数でまとめて作り、ゲーム全体で値が重複しないことを保証する。
   * reduce を純粋関数のままにするため、乱数生成は startGame に閉じ込めている。
   */
  revealTokenPool: string[][];
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
  /**
   * 投票先の指定に使う識別子。クライアントは中身を解釈せず、そのまま submitVote へ返す。
   * reveal:"named" のときは本物の playerId、それ以外（匿名）のときは
   * **そのラウンドだけ有効な不透明トークン**が入る（回答者を特定できない）。
   */
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

/**
 * playing: 専用モジュール型ゲームの進行中（docs/design/games-unified.md §3.2）。
 * 中身の表示データは S2C `gameView` / `RoomSnapshot.game` で別に配るため、
 * ここには「どのゲームが動いているか」だけを載せる
 */
export type PlayingPhaseView = {
  phase: "playing";
  /** 進行中のモジュールID（ビューモジュールの読み込みに使う） */
  gameId: string;
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
  | FinalResultPhaseView
  | PlayingPhaseView;

/**
 * 公開ルーム一覧の1行（§2 公開ルーム一覧 / §4.0 `GET /api/rooms`）。
 * 未ログインでも取得できるため、部屋の中身が漏れる情報は入れない。
 * あだ名・チャット・ゲームの進行内容は含めず、人数と灯りの有無だけを見せる。
 */
export type PublicRoomSummary = {
  /** 6桁の参加コード。公開ルームはこのコードでそのまま入室できる（オープン入室） */
  code: string;
  /** ルーム名。公開ルームは必須（20文字以内） */
  roomName: string;
  /** 現在の在室人数（切断猶予中の人も含む） */
  playerCount: number;
  /** 定員 */
  capacity: number;
  /** 遊んでいるゲームのタイトル。ロビーで未選択なら入らない */
  gameTitle?: string;
  /** 卓の説明文（設定されていれば） */
  description?: string;
  /** プリセットタグ（設定されていれば） */
  tags?: string[];
  /** ゲーム進行中か（lobby 以外） */
  playing: boolean;
  /**
   * 入室方式（§3.1）。knock ならホストの承認が要る。
   * 一覧の「入店」を「ノックする」に出し分けるために載せる
   */
  entryMode: RoomEntryMode;
  /** 作成時刻（epoch ms）。「何時から灯りがついているか」の表示に使う */
  createdAt: number;
};

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
  phase: RoomPhase;
  /** 現フェーズの期限（epoch ms）。期限なしは null */
  deadline: number | null;
  /** 現フェーズの表示データ */
  view: PhaseView;
  /** チャット履歴。直近 CHAT_HISTORY_MAX 件のみ・古い順（§3.9） */
  chat: ChatMessage[];
  /** bot ごとの ON/OFF（§3.10） */
  bots: BotSwitches;
  /** 集計中の終了アンケート（§3.10）。無ければ入らない */
  botPoll?: BotPollPublic;
  /** 保留中のノック。ホストにのみ入る（§3.2 原則3） */
  pendingKnocks?: KnockPublic[];
  /** 受信者自身のセッショントークン。再接続時に join.session として送り返す（§3.2） */
  session?: string;
  /** サーバー時刻（epoch ms）。クライアントの時計ずれ補正用 */
  serverTime: number;
  /**
   * 進行中のモジュール型ゲームの表示データ（docs/design/games-unified.md §2.2）。
   * 途中参加・再接続でフル状態を配るために載せる。既存の `phase` / `view` と並存する。
   * kind:"prompt" のゲーム（＝現行の全ゲーム）では入らない
   */
  game?: {
    /** カタログ上のゲームID */
    gameId: string;
    /** 受信者ごとの表示データ */
    view: unknown;
    /** カウントダウン表示用の期限（epoch ms）。期限なしは null */
    deadline: number | null;
  };
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
    /** 公開ルームの入室方式（§3.1）。省略すると open */
    entryMode?: RoomEntryMode;
    /**
     * 合言葉（招待制ルームのみ・4〜20文字、§3.1）。
     * 全ルーム横断で一意。すでに使われていれば DUPLICATE で作成に失敗する
     */
    passphrase?: string;
  }
  | {
    t: "join";
    /** 6桁の参加コード。passphrase を渡す場合は省略できる */
    roomCode?: string;
    /** 合言葉（§3.1）。roomCode の代わりに使える。両方あれば roomCode を優先する */
    passphrase?: string;
    /**
     * あだ名。省略するとサーバーがしゅんぴの二つ名を付ける（§3.0 / §3.10）。
     * 空文字は「入力し忘れ」と区別できないので従来どおりエラーにする
     */
    nickname?: string;
    session?: string;
    entryToken?: string;
  }
  /**
   * 公開・承認制ルームへの入室申請（§3.1.1）。ゲスト可。
   * session は前に同じ卓へ関わったときのトークン。あればブロック判定に使う
   */
  | { t: "knock"; roomCode: string; nickname: string; session?: string }
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
  /** 通話の文字起こし1行（docs/design/bot-voice.md）。VC 枠内の参加者のみ受理される */
  | { t: "voice"; text: string }
  /** bot の ON/OFF（ホストのみ、§3.10）。botId 省略で3体まとめて切り替える */
  | { t: "setBot"; botId?: BotId; enabled: boolean }
  /** 終了アンケートへの投票（§3.10） */
  | { t: "endPollVote"; pollId: string; agree: boolean }
  | { t: "rtcSignal"; to: string; payload: unknown }
  /**
   * ゲーム内イベント（docs/design/games-unified.md §2.2）。
   * サーバーが受け取り、卓の状態として保持・配信する。
   * 専用モジュール型のゲームは payload を**検証・解釈**して状態を進め、
   * クライアント専用ゲーム（server/games/client.ts）は解釈せず中継ログに積む
   */
  | { t: "gameEvent"; payload: unknown }
  /**
   * ランダムマッチの待機列に並ぶ（§3.1.2）。ゲスト可。
   * あだ名を省略するとサーバーが しゅんぴ の二つ名を付ける（join と同じ扱い）
   */
  | { t: "joinQueue"; nickname?: string }
  /** 待機列から抜ける（§3.1.2） */
  | { t: "leaveQueue" }
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
  /**
   * 待機列の様子（§3.1.2）。並んだ直後と、成立判定のたびに本人へ送る。
   * waiting は自分を含む待機人数の目安
   */
  | { t: "queueStatus"; waiting: number; nextCheckAt: number }
  /** マッチが成立した（§3.1.2）。直後に roomState が続く */
  | { t: "matched"; roomCode: string }
  | { t: "kicked" }
  | { t: "playerKicked"; playerId: string }
  | { t: "phase"; phase: RoomPhase; deadline?: number; view: PhaseView }
  | { t: "roundResult"; scores: ScoreEntry[] }
  | { t: "finalResult"; scores: ScoreEntry[] }
  | { t: "hostChanged"; playerId: string }
  | { t: "chat"; message: ChatMessage }
  /** 通話の文字起こし1行が確定した（docs/design/bot-voice.md） */
  | { t: "voice"; line: VoiceLine }
  /** bot の ON/OFF が変わった（§3.10） */
  | { t: "botState"; bots: BotSwitches }
  /** 終了アンケートが締まった（§3.10）。agreed が true ならお開きの合意が取れた */
  | { t: "botPollClosed"; pollId: string; agreed: boolean }
  | { t: "rtcSignal"; from: string; payload: unknown }
  /**
   * モジュール型ゲームの表示データ（docs/design/games-unified.md §2.2）。
   * 受信者ごとに内容が変わる（§3.2 原則3）。deadline はカウントダウン表示用
   */
  | { t: "gameView"; gameId: string; view: unknown; deadline: number | null }
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
