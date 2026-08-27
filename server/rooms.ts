/**
 * ルーム管理層
 * 詳細仕様書 §3.1 / §3.2 / §3.9 / §8 に対応する。
 *
 * 責務:
 *   - ルームのメモリ保持と6桁コードの採番
 *   - 参加 / 再接続 / 切断 / 退室化 / ホスト委譲
 *   - C2S メッセージを EngineEvent に変換し、EngineEffect を S2C として配信
 *   - フェーズタイマーの設置と無効化
 *   - テキストチャットの検証・レート制限・履歴保持・配信（§3.9）
 *   - ルームの出来事を BotEvent に変換し、bot の発話をチャットへ配信（§3.10）
 *
 * 規約（§3.2 規約2）: ルームごとに1本のキューでイベントを直列処理し、
 * 状態遷移関数（engine.reduce）の呼び出しは同期文脈で行う。このファイルには
 * await を書かない。
 *
 * 軽量スコープ: createRoom の認証必須化（AUTH_REQUIRED）は実装済み。
 * 公開ルームはオープン入室と承認制（ノック・§3.1.1）の両方に対応する。
 * 招待制ルームは6桁コードと合言葉（§3.1）のどちらでも入れる。
 * ランダムマッチ（§3.1.2）の待機列もここで持つ。
 * ホストによるキック（§3.1）も実装済み。importGame・24時間自動削除は未実装。
 * 接続点は `TODO(チーム分担)` として記してある。
 * VC は rtcSignal の中継のみを受け持つ（§3.6。接続の確立はクライアント側）。
 * §3.8 の WS レート制限（1接続あたり 20件/秒）は main.ts の WebSocket 層で実装済み。
 */

import {
  type C2S,
  CHAT_HISTORY_MAX,
  CHAT_RATE_MAX,
  CHAT_RATE_WINDOW_MS,
  CHAT_TEXT_MAX,
  type ChatMessage,
  DISCONNECT_GRACE_MS,
  ENTRY_TOKEN_TTL_MS,
  err,
  type ErrorCode,
  type GameState,
  type GameSummary,
  type Knock,
  KNOCK_RATE_WINDOW_MS,
  KNOCK_TTL_MS,
  type KnockPublic,
  MATCH_GROUP_MAX,
  MATCH_GROUP_MIN,
  MATCH_INTERVAL_MS,
  MATCH_QUEUE_MAX,
  ok,
  PASSPHRASE_MAX,
  PASSPHRASE_MIN,
  PENDING_KNOCK_MAX,
  type Phase,
  type PhaseDurations,
  type PhaseView,
  type Player,
  type PlayerPublic,
  type PublicRoomSummary,
  type Result,
  type Room,
  ROOM_CAPACITY,
  ROOM_CODE_LENGTH,
  ROOM_DESCRIPTION_MAX,
  ROOM_NAME_MAX,
  type RoomEntryMode,
  type RoomPhase,
  type RoomSnapshot,
  type S2C,
  type ScoreEntry,
  type ScoringMode,
  VC_CAPACITY,
  type VoiceLine,
} from "./types.ts";
import { DEFAULT_PHASE_DURATIONS, type EnginePlayerInput } from "./engine.ts";
import { findGameModule, findModuleGame, MODULE_GAMES } from "./games/index.ts";
import {
  gameEventPayloadExceedsLimit,
  type GameModule,
  type ModuleEffect,
  type ModuleEvent,
  type ModuleResult,
} from "./games/module.ts";
import { PROMPT_MODULE_ID, type PromptConfig, promptModule } from "./games/prompt.ts";
import {
  BOT_IDS,
  type BotEffect,
  type BotEvent,
  BOTS,
  type BotState,
  type BotUtterance,
  createBotState,
  END_POLL_MS,
  pickNickname,
  reduce as botReduce,
} from "./bot.ts";
import { createKanaProvider, detectSenryuAny, SENRYU_TOLERANCE } from "./senryu.ts";
import type { SenryuMatch, YomiProvider } from "./senryu.ts";
import { toSummary } from "./gamedef.ts";
import { isOfficialGame, OFFICIAL_GAMES } from "./official_games.ts";
import { charLength, hasControlChar, validateHobbyTags, validateNickname } from "./validation.ts";
import { type HobbyTagId } from "./hobby_tags.ts";
import { type RoomTagId } from "./room_tags.ts";

/** ニックネームの検証ロジックの本体は validation.ts にある（auth.ts からも使うため）。
 * 既存のインポート元（server/tests/rooms_test.ts など）を壊さないよう、ここから再エクスポートする */
export { validateNickname } from "./validation.ts";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** 未実装の C2S を受けたときに返す説明文 */
export const NOT_IMPLEMENTED_MESSAGE = "この機能は未実装です";

/** 投票を行わないゲームの judge フェーズ秒数。表示だけなので短くする */
export const NON_VOTE_JUDGE_SEC = 5;

/** ルームコード採番のリトライ上限 */
const ROOM_CODE_ATTEMPTS = 50;

/**
 * 文字起こし1行の上限は CHAT_TEXT_MAX と同じ（§3.9 / docs/design/bot-voice.md）。
 * 検証はチャットと同じ validateChatText を共用するため、専用の定数は持たない。
 */
/** 文字起こしのレート制限: 判定窓（ミリ秒）。喋り続けても止まらない程度に緩くとる */
export const VOICE_RATE_WINDOW_MS = 10_000;
/** 文字起こしのレート制限: 判定窓内に受理できる最大件数 */
export const VOICE_RATE_MAX = 12;

/**
 * bot に定期イベント（tick）を送る間隔（ミリ秒）。
 * bot.ts の沈黙判定はこの粒度で呼ばれる前提で閾値を決めている。
 */
export const BOT_TICK_MS = 60_000;

/** bot の沈黙判定を止める「人がまだ触っている」操作（§3.10） */
const GAME_ACTION_TYPES: ReadonlySet<C2S["t"]> = new Set<C2S["t"]>([
  "selectGame",
  "startGame",
  "skipPhase",
  "submitInput",
  "submitVote",
  "gameEvent",
]);

/** 順位表から1位のあだ名を拾って bot の結果イベントにする。同点1位は先頭を採る */
function botResultEvent(
  t: "roundResult" | "finalResult",
  scores: readonly ScoreEntry[],
): BotEvent {
  const top = scores.find((row) => row.rank === 1);
  return top === undefined ? { t } : { t, topNickname: top.nickname };
}

// ---------------------------------------------------------------------------
// 外部との接点
// ---------------------------------------------------------------------------

/** タイマーの識別子。差し替え可能にするため number で扱う */
export type TimerHandle = number;

/** 1本の WebSocket 接続を抽象化したもの。テストはモックを渡す */
export interface ClientLink {
  /** 接続ごとに一意なID */
  readonly id: string;
  /** WS アップグレード時に Cookie から検証済みのアカウントID。未ログインなら null（§3.0） */
  readonly userId: string | null;
  /** S2C メッセージを送る */
  send(msg: S2C): void;
  /**
   * 接続を閉じる。code / reason を省略した場合は実装側の既定（1000 = 正常終了）に倒す。
   * 引数を任意にしてあるのは、サーバー停止時だけ 1001（going away）で閉じ分けたいため
   * （SHUTDOWN_CLOSE_CODE 参照）。引数を取らない既存の実装・モックもそのまま使える
   */
  close(code?: number, reason?: string): void;
}

/**
 * サーバー停止時にソケットを閉じるクローズコード。1001 = going away は
 * 「サーバーが停止する／離脱する」ための標準コード（RFC 6455 §7.4.1）。
 * 退室・キックの 1000（正常終了）と分けておかないと、クライアント側で
 * 「再起動なので自動で繋ぎ直してよい」と判断できない
 */
export const SHUTDOWN_CLOSE_CODE = 1001;

/**
 * サーバー停止時のクローズ理由。
 * RFC 6455 §5.5.1 によりクローズ理由は UTF-8 で 123 バイト以内でなければならず、
 * 超えると close() が例外を投げる。日本語は1文字3バイトで簡単に膨らむので ASCII で短く保つ
 * （この文字列は画面には出さない。利用者への案内はクライアントがコードを見て出す）
 */
export const SHUTDOWN_CLOSE_REASON = "server going away";

/** クローズ理由の上限バイト数（RFC 6455 §5.5.1） */
export const CLOSE_REASON_MAX_BYTES = 123;

/** 時刻・タイマーを差し替えるための設定（テスト用） */
export type RoomManagerOptions = {
  /** 現在時刻（epoch ms）を返す */
  now?: () => number;
  /** タイマーを設置する */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** タイマーを解除する */
  clearTimer?: (handle: TimerHandle) => void;
  /** 0 以上 1 未満の乱数（bot の文面選択・二つ名。テストでは固定値を渡す） */
  rng?: () => number;
  /**
   * ゲーム開始時にモジュールへ渡す乱数の種（§2.5）を作る。
   * 省略時は暗号論的乱数（`randomGameSeed`）。**本番では必ず省略すること。**
   * 種から狼・お題・正解が決定的に導けるため、公開情報から作れる種を渡すと
   * 改造クライアントに秘密を先読みされる。決定的な進行が要るテストだけが
   * ここに固定値を返す関数を渡す。
   */
  gameSeed?: () => number;
  /**
   * 川柳判定（§3.10 せり）。省略時はかなプロバイダのみで判定する。
   * kuromoji（漢字混じり対応）は読み込みが非同期なので、使う場合は
   * 起動時に作ったものを main.ts からここへ渡す。
   */
  senryu?: (text: string) => SenryuMatch | null;
};

/** かなプロバイダだけで川柳を判定する既定の実装。辞書を持たない環境でも動く */
export function createDefaultSenryuDetector(
  providers: readonly YomiProvider[] = [createKanaProvider()],
): (text: string) => SenryuMatch | null {
  return (text) => detectSenryuAny(text, providers, { tolerance: SENRYU_TOLERANCE });
}

// ---------------------------------------------------------------------------
// 内部の保持データ
// ---------------------------------------------------------------------------

/** ルーム本体に付随する実行時の状態 */
type RoomEntry = {
  /** ルーム本体（§5） */
  room: Room;
  /** 接続中の参加者（playerId → 接続） */
  links: Map<string, ClientLink>;
  /** 直列処理用のキュー */
  queue: Array<() => void>;
  /** キューを処理中か */
  draining: boolean;
  /** 現フェーズの期限タイマー */
  phaseTimer: TimerHandle | null;
  /**
   * モジュールが予約した次の timeout 時刻（epoch ms、docs/design/games-unified.md §2.4）。
   * schedule 効果で更新し、syncPhaseTimer がこの値に合わせてタイマーを張り直す。
   * 既存エンジンの GameState.deadline を一般化したもので、prompt モジュールでは
   * 常に GameState.deadline と同じ値になる
   */
  scheduledAt: number | null;
  /** 切断猶予タイマー（playerId → ハンドル） */
  graceTimers: Map<string, TimerHandle>;
  /** チャットのレート制限用。playerId → 判定窓内の発言時刻（古い順、§3.9） */
  chatTimes: Map<string, number[]>;
  /** ノックのレート制限（§3.8）。接続ID → 直近のノック時刻 */
  knockTimes: Map<string, number>;
  /** 文字起こしのレート制限用。playerId → 判定窓内の受信時刻（古い順、docs/design/bot-voice.md） */
  voiceTimes: Map<string, number[]>;
  /** bot 3体の状態（§3.10） */
  bot: BotState;
  /** bot への定期 tick タイマー */
  botTimer: TimerHandle | null;
  /** 終了アンケートの締切タイマー（§3.10） */
  botPollTimer: TimerHandle | null;
};

/** 接続がどのルームの誰に紐づいているか */
type LinkState = {
  /** 接続 */
  link: ClientLink;
  /** ルームコード */
  roomCode: string;
  /** playerId */
  playerId: string;
};

/** 参加者をルームから外す理由 */
type RemoveReason = "leave" | "graceExpired" | "kick";

/** 相席を待っている人（§3.1.2） */
type Waiting = {
  link: ClientLink;
  /** 省略された場合は undefined。成立時に しゅんぴ が二つ名を付ける */
  nickname: string | undefined;
  /** 趣味タグ（§3.11）。検証済みのものを持ち、成立した卓の参加者にそのまま渡す */
  tags: HobbyTagId[];
  joinedAt: number;
};

/** ノック中の申請者。返事を届けるのと、時間切れを畳むために持つ */
type KnockerState = {
  link: ClientLink;
  roomCode: string;
  /** 申請者に割り当てたセッショントークン。承認されたらそのまま入室に使う */
  sessionToken: string;
  /** 自動拒否のタイマー */
  timer: TimerHandle;
};

// ---------------------------------------------------------------------------
// 入力検証
// ---------------------------------------------------------------------------

/** チャット本文を検証して正規化する（1..200文字・制御文字禁止、§3.9）。改行も拒否する */
export function validateChatText(input: unknown): Result<string> {
  if (typeof input !== "string") {
    return err("INVALID_INPUT", "メッセージを入力してください");
  }
  const trimmed = input.trim();
  const length = charLength(trimmed);
  if (length === 0) {
    return err("INVALID_INPUT", "メッセージを入力してください");
  }
  if (length > CHAT_TEXT_MAX) {
    return err("INVALID_INPUT", `メッセージは${CHAT_TEXT_MAX}文字以内で入力してください`);
  }
  if (hasControlChar(trimmed)) {
    return err("INVALID_INPUT", "メッセージに使用できない文字が含まれています");
  }
  return ok(trimmed);
}

/**
 * 公開ルームのルーム名を検証して正規化する（1..20文字・制御文字禁止、§3.1）。
 * 一覧は未ログインでも見えるので、ここを通った文字列だけが外に出る。
 */
/**
 * 合言葉を検証して正規化する（4〜20文字・制御文字禁止、§3.1）。
 *
 * 口頭やチャットで伝えられる前提なので、前後の空白は落とす。
 * 中の空白は残す（「さくら 三番」のような合言葉を許すため）。
 */
export function validatePassphrase(input: unknown): Result<string> {
  if (typeof input !== "string") {
    return err("INVALID_INPUT", "合言葉を入力してください");
  }
  const trimmed = input.trim();
  const length = charLength(trimmed);
  if (length < PASSPHRASE_MIN) {
    return err("INVALID_INPUT", `合言葉は${PASSPHRASE_MIN}文字以上で入力してください`);
  }
  if (length > PASSPHRASE_MAX) {
    return err("INVALID_INPUT", `合言葉は${PASSPHRASE_MAX}文字以内で入力してください`);
  }
  if (hasControlChar(trimmed)) {
    return err("INVALID_INPUT", "合言葉に使用できない文字が含まれています");
  }
  return ok(trimmed);
}

/**
 * 合言葉の突き合わせに使う鍵。
 *
 * 大文字小文字の違いで別の卓になると、口頭で伝えたときに入れない事故が起きる。
 * 一意判定も入室の照合も、この鍵で行う。
 */
export function passphraseKey(passphrase: string): string {
  return passphrase.toLowerCase();
}

export function validateRoomName(input: unknown): Result<string> {
  if (typeof input !== "string") {
    return err("INVALID_INPUT", "ルーム名を入力してください");
  }
  const trimmed = input.trim();
  const length = charLength(trimmed);
  if (length === 0) {
    return err("INVALID_INPUT", "ルーム名を入力してください");
  }
  if (length > ROOM_NAME_MAX) {
    return err("INVALID_INPUT", `ルーム名は${ROOM_NAME_MAX}文字以内で入力してください`);
  }
  if (hasControlChar(trimmed)) {
    return err("INVALID_INPUT", "ルーム名に使用できない文字が含まれています");
  }
  return ok(trimmed);
}

/**
 * 卓の説明文を検証して正規化する（100文字以内・制御文字禁止）。
 * 空文字は「説明文なし」として許可する（PATCH /api/rooms/:code での更新用）。
 */
export function validateRoomDescription(input: unknown): Result<string> {
  if (typeof input !== "string") {
    return err("INVALID_INPUT", "説明文の形式が正しくありません");
  }
  const trimmed = input.trim();
  const length = charLength(trimmed);
  if (length > ROOM_DESCRIPTION_MAX) {
    return err("INVALID_INPUT", `説明文は${ROOM_DESCRIPTION_MAX}文字以内で入力してください`);
  }
  if (hasControlChar(trimmed)) {
    return err("INVALID_INPUT", "説明文に使用できない文字が含まれています");
  }
  return ok(trimmed);
}

/** ルームコードを正規化する。6桁の数字でなければ null */
export function normalizeRoomCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!/^[0-9]{6}$/.test(trimmed)) return null;
  return trimmed;
}

/** 6桁のルームコードを暗号論的乱数で作る（剰余バイアスを避けるため再抽選する） */
function randomRoomCode(): string {
  const range = 10 ** ROOM_CODE_LENGTH;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) {
      return String(buf[0] % range).padStart(ROOM_CODE_LENGTH, "0");
    }
  }
}

/**
 * ゲーム開始時にモジュールへ渡す乱数の種（設計書 §2.5）を暗号論的乱数で作る。
 *
 * **公開情報から種を作ってはならない。** かつてはルームコードと開始時刻の
 * ハッシュ（FNV-1a）を種にしていたが、ルームコードは全参加者が知っており、
 * 開始時刻も最初の `gameView` の `deadline` から厳密に逆算できる
 * （wordwolf なら `deadline - 120000`）。種が割れるとモジュールの乱数列は
 * すべて決定的なので、改造クライアントが議論開始前に狼・お題・クイズの正解を
 * 算出できてしまう。ここで推測不能な種にすることで、その経路を塞ぐ。
 *
 * 進行の再現性が要るのはテストだけなので、決定的な種は
 * `RoomManagerOptions.gameSeed` から注入する（`rng` と同じ形）。
 */
function randomGameSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] >>> 0;
}

// ---------------------------------------------------------------------------
// ルーム管理
// ---------------------------------------------------------------------------

/** setRoomMeta の結果（PATCH /api/rooms/:code のステータス決定に使う） */
export type SetRoomMetaResult =
  | { ok: true; description?: string; tags?: RoomTagId[] }
  | { ok: false; status: 404 | 403 };

/** ルームの生成・参加・進行をまとめて受け持つ */
export class RoomManager {
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly links = new Map<string, LinkState>();
  /**
   * 合言葉 → 6桁コードの索引（§3.1）。
   * 全ルーム横断で一意にするためと、入室時に卓を引くために持つ。
   * 鍵は passphraseKey（小文字化）で、卓を消すときに必ず解放する
   */
  private readonly passphrases = new Map<string, string>();
  /**
   * ノック中の申請者（§3.1.1）。knockId → 申請者の接続。
   * 申請者はまだ卓に居ないので links には載らない。承認・拒否・時間切れの返事を
   * 届けるためにここで持つ。返事を送ったら必ず消す
   */
  private readonly knockers = new Map<string, KnockerState>();
  /** ランダムマッチの待機列（§3.1.2）。並んだ順を保つので配列で持つ */
  private readonly queue: Waiting[] = [];
  /** 成立判定のタイマー。誰も待っていない間は張らない */
  private matchTimer: TimerHandle | null = null;
  /** 次の成立判定の時刻。待っている人への表示に使う */
  private matchDeadline: number | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly rng: () => number;
  /** ゲーム開始時の乱数の種を作る（テストだけが固定値を注入する） */
  private readonly gameSeed: () => number;
  private readonly senryu: (text: string) => SenryuMatch | null;

  constructor(options: RoomManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ??
      ((fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle);
    this.clearTimer = options.clearTimer ??
      ((handle) => clearTimeout(handle as unknown as number));
    this.rng = options.rng ?? Math.random;
    this.gameSeed = options.gameSeed ?? randomGameSeed;
    this.senryu = options.senryu ?? createDefaultSenryuDetector();
  }

  /** 稼働中のルーム数（テスト・監視用） */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** ルームを取得する（テスト用。返り値は内部状態そのもの） */
  getRoom(code: string): Room | undefined {
    return this.rooms.get(code)?.room;
  }

  /**
   * 卓の説明文・タグをオーナー本人が更新する（§4.0 `PATCH /api/rooms/:code`）。
   * 入力の検証（文字数・タグの妥当性）は呼び出し側（main.ts）の責務とし、
   * ここではオーナー確認と反映だけを行う。
   */
  setRoomMeta(
    code: string,
    userId: string,
    meta: { description: string; tags: RoomTagId[] },
  ): SetRoomMetaResult {
    const entry = this.rooms.get(code);
    if (entry === undefined) return { ok: false, status: 404 };
    if (entry.room.ownerUserId !== userId) return { ok: false, status: 403 };
    if (meta.description === "") {
      delete entry.room.description;
    } else {
      entry.room.description = meta.description;
    }
    if (meta.tags.length === 0) {
      delete entry.room.tags;
    } else {
      entry.room.tags = meta.tags;
    }
    return { ok: true, description: entry.room.description, tags: entry.room.tags };
  }

  /**
   * 稼働中の公開ルーム一覧（§2 公開ルーム一覧 / §4.0 `GET /api/rooms`）。
   * 招待制ルームは載せない。コードを知らない人に漏らさないため（§3.1）。
   * 新しく立った卓が上に来るよう createdAt の降順で返す。
   */
  listPublicRooms(): PublicRoomSummary[] {
    const list: PublicRoomSummary[] = [];
    for (const entry of this.rooms.values()) {
      const room = entry.room;
      if (room.visibility !== "public" || room.roomName === undefined) continue;
      const summary: PublicRoomSummary = {
        code: room.code,
        roomName: room.roomName,
        playerCount: room.players.size,
        capacity: ROOM_CAPACITY,
        playing: this.roomPhase(entry) !== "lobby",
        entryMode: room.entryMode,
        createdAt: room.createdAt,
      };
      // 選択中のゲームは「何をして遊んでいる卓か」の手がかりとして出す。
      // 進行内容（お題・回答・得点）は一覧には一切含めない
      const title = room.selectedGameId === null ? undefined : selectedGameTitle(room);
      if (title !== undefined) summary.gameTitle = title;
      if (room.description !== undefined) summary.description = room.description;
      if (room.tags !== undefined && room.tags.length > 0) summary.tags = room.tags;
      list.push(summary);
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }

  /** C2S メッセージを1件処理する */
  handle(link: ClientLink, msg: C2S): void {
    if (msg.t === "createRoom") {
      this.handleCreateRoom(link, msg);
      return;
    }
    if (msg.t === "join") {
      this.handleJoin(link, msg);
      return;
    }
    // ノックは卓の外から届く（§3.1.1）。links に載っていないので join と同じ扱いにする
    if (msg.t === "knock") {
      this.handleKnock(link, msg);
      return;
    }
    // 相席の待機列も卓の外の話（§3.1.2）
    if (msg.t === "joinQueue") {
      this.handleJoinQueue(link, msg);
      return;
    }
    if (msg.t === "leaveQueue") {
      this.handleLeaveQueue(link);
      return;
    }
    const state = this.links.get(link.id);
    if (state === undefined) {
      sendError(link, "ROOM_NOT_FOUND", "ルームに参加していません");
      return;
    }
    this.enqueue(state.roomCode, () => this.handleInRoom(state, msg));
  }

  /** WebSocket が閉じたときの処理（§3.2: 60秒はセッションを保持する） */
  disconnect(link: ClientLink): void {
    // 待機列に並んだまま切れた人を残さない（§3.1.2）
    if (this.removeFromQueue(link)) this.sendQueueStatus();
    // ノックしたまま切れた人も残さない（§3.1.1）
    this.dropKnocksFrom(link);
    const state = this.links.get(link.id);
    if (state === undefined) return;
    this.links.delete(link.id);
    this.enqueue(state.roomCode, () => {
      const entry = this.rooms.get(state.roomCode);
      if (entry === undefined) return;
      // すでに再接続で別の接続に置き換わっている場合は何もしない
      if (entry.links.get(state.playerId) !== link) return;
      entry.links.delete(state.playerId);
      const player = entry.room.players.get(state.playerId);
      if (player === undefined) return;
      const now = this.now();
      player.connected = false;
      player.disconnectedAt = now;
      entry.room.lastActiveAt = now;
      this.applyModuleEvent(entry, { t: "playerLeft", playerId: player.id, now });
      this.applyBotEvent(entry, { t: "playerDisconnected", playerId: player.id });
      this.broadcast(entry, { t: "playerLeft", player: this.toPublic(entry, player) });
      this.armGraceTimer(entry, player.id);
    });
  }

  /**
   * すべてのタイマーを解除し、接続中のソケットを閉じてルームを破棄する
   * （サーバー停止時・テスト後始末）。
   *
   * ソケットを閉じずにプロセスが死ぬと、繋いでいる人には理由の分からない異常切断
   * （1006）として届く。1001 を明示して閉じることで、クライアントは「再起動だから
   * 少し待って繋ぎ直す」と判断できる。
   * 2回呼んでも安全（2回目は rooms / links とも空なので何もしない）
   */
  dispose(): void {
    for (const link of this.connectedLinks()) {
      // 1本の close() が失敗しても残りの切断を止めない。
      // 既に閉じかけのソケットや、閉じたソケットへの close() は例外になり得る
      try {
        link.close(SHUTDOWN_CLOSE_CODE, SHUTDOWN_CLOSE_REASON);
      } catch {
        // 閉じられなくてもこの後プロセスごと終了するので、ここでは何もしない
      }
    }
    for (const entry of [...this.rooms.values()]) {
      this.clearRoomTimers(entry);
    }
    // ノックの自動拒否タイマーは卓ではなく knockers 側にぶら下がっている。
    // 残すとテストが「タイマーが片付いていない」で落ちるし、本番でも漏れになる
    for (const knocker of this.knockers.values()) this.clearTimer(knocker.timer);
    this.knockers.clear();
    this.cancelMatchTimer();
    this.queue.length = 0;
    this.rooms.clear();
    this.links.clear();
    this.passphrases.clear();
  }

  /**
   * 現在つながっている接続を重複なく列挙する。
   * this.links（接続ID → 状態）と entry.links（playerId → 接続）は通常は同期している
   * が、片方にしか残っていない接続を取りこぼさないよう両方から集めて id で重複を除く
   */
  private connectedLinks(): ClientLink[] {
    const found = new Map<string, ClientLink>();
    for (const state of this.links.values()) found.set(state.link.id, state.link);
    for (const entry of this.rooms.values()) {
      for (const link of entry.links.values()) found.set(link.id, link);
    }
    return [...found.values()];
  }

  // -------------------------------------------------------------------------
  // 直列処理（§3.2 規約2）
  // -------------------------------------------------------------------------

  /** ルームのキューに積んで順番に実行する。ルーム未確定の処理は即時実行する */
  private enqueue(code: string, task: () => void): void {
    const entry = this.rooms.get(code);
    if (entry === undefined) {
      runTask(task);
      return;
    }
    entry.queue.push(task);
    if (entry.draining) return;
    entry.draining = true;
    try {
      for (;;) {
        const next = entry.queue.shift();
        if (next === undefined) break;
        runTask(next);
      }
    } finally {
      entry.draining = false;
    }
  }

  // -------------------------------------------------------------------------
  // ルーム作成 / 参加
  // -------------------------------------------------------------------------

  /** ルームを作成し、作成者をホストとして入室させる（§3.1） */
  private handleCreateRoom(link: ClientLink, msg: Extract<C2S, { t: "createRoom" }>): void {
    if (this.links.has(link.id)) {
      sendError(link, "INVALID_INPUT", "すでにルームに参加しています");
      return;
    }
    if (link.userId === null) {
      sendError(link, "AUTH_REQUIRED", "ルーム作成にはログインが必要です");
      return;
    }
    if (msg.visibility !== "public" && msg.visibility !== "private") {
      sendError(link, "INVALID_INPUT", "公開設定が不正です");
      return;
    }
    // 公開ルームはルーム名必須（§3.1）。一覧に出る唯一のユーザー由来テキストなのでここで検証する
    let roomName: string | undefined;
    if (msg.visibility === "public") {
      const validated = validateRoomName(msg.roomName);
      if (!validated.ok) {
        sendError(link, validated.code, validated.message);
        return;
      }
      roomName = validated.value;
    }
    // 入室方式は公開ルームだけの概念（§3.1）。招待制はコードか合言葉で入るので、
    // 承認を挟む余地がない
    let entryMode: RoomEntryMode = "open";
    if (msg.entryMode !== undefined) {
      if (msg.entryMode !== "open" && msg.entryMode !== "knock") {
        sendError(link, "INVALID_INPUT", "入室方式が不正です");
        return;
      }
      if (msg.visibility !== "public" && msg.entryMode === "knock") {
        sendError(link, "INVALID_INPUT", "承認制は一覧に出す卓にのみ設定できます");
        return;
      }
      entryMode = msg.entryMode;
    }
    // 合言葉は招待制ルームのみ（§3.1）。公開ルームは一覧から入れるので意味がない
    let passphrase: string | undefined;
    if (msg.passphrase !== undefined) {
      if (msg.visibility !== "private") {
        sendError(link, "INVALID_INPUT", "合言葉は招待制の卓にのみ付けられます");
        return;
      }
      const validated = validatePassphrase(msg.passphrase);
      if (!validated.ok) {
        sendError(link, validated.code, validated.message);
        return;
      }
      if (this.passphrases.has(passphraseKey(validated.value))) {
        // 一意でないと、入力した合言葉がどの卓を指すのか決まらない（§3.1）
        sendError(link, "DUPLICATE", "その合言葉はすでに使われています");
        return;
      }
      passphrase = validated.value;
    }
    const nickname = validateNickname(msg.nickname);
    if (!nickname.ok) {
      sendError(link, nickname.code, nickname.message);
      return;
    }
    // 建てた本人の趣味タグ（§3.11）。卓に付けるルームタグとは別物
    const hostTags = validateHobbyTags(msg.tags);
    if (!hostTags.ok) {
      sendError(link, hostTags.code, hostTags.message);
      return;
    }
    const code = this.allocateRoomCode();
    if (code === null) {
      sendError(
        link,
        "INVALID_INPUT",
        "ルームを作成できませんでした。時間をおいて再試行してください",
      );
      return;
    }
    const now = this.now();
    const host = this.newPlayer(nickname.value, hostTags.value);
    host.userId = link.userId;
    const room: Room = {
      code,
      visibility: msg.visibility,
      entryMode,
      ownerUserId: link.userId,
      hostId: host.id,
      players: new Map([[host.id, host]]),
      pendingKnocks: new Map(),
      pendingEntries: new Map(),
      blockedSessions: new Set(),
      availableGames: new Map(OFFICIAL_GAMES.map((g) => [g.id, g])),
      selectedGameId: null,
      game: null,
      chatHistory: [],
      createdAt: now,
      lastActiveAt: now,
      ...(roomName === undefined ? {} : { roomName }),
      ...(passphrase === undefined ? {} : { passphrase }),
    };
    const entry: RoomEntry = {
      room,
      links: new Map([[host.id, link]]),
      queue: [],
      draining: false,
      phaseTimer: null,
      scheduledAt: null,
      graceTimers: new Map(),
      chatTimes: new Map(),
      knockTimes: new Map(),
      voiceTimes: new Map(),
      bot: createBotState(now),
      botTimer: null,
      botPollTimer: null,
    };
    this.rooms.set(code, entry);
    if (passphrase !== undefined) this.passphrases.set(passphraseKey(passphrase), code);
    this.armBotTimer(entry);
    this.links.set(link.id, { link, roomCode: code, playerId: host.id });
    // TODO(チーム分担): §3.1 最終アクティビティから24時間で自動削除する掃除処理
    this.sendSnapshot(entry, host);
  }

  /**
   * join の宛先を決める（§3.1）。
   *
   * 6桁コードと合言葉のどちらでも入れる。両方あればコードを優先する
   * （URL や QR から来た人は、合言葉を知らなくても入れるべきなので）。
   * どちらでも引けなければ null を返し、呼び出し側が ROOM_NOT_FOUND にする。
   * 合言葉が違うのか卓が無いのかは区別せずに返す。区別できると、合言葉を
   * 総当たりで試したときに「当たり」が分かってしまう
   */
  private resolveRoomCode(msg: Extract<C2S, { t: "join" }>): string | null {
    const code = normalizeRoomCode(msg.roomCode);
    if (code !== null) return code;
    if (typeof msg.passphrase !== "string") return null;
    const validated = validatePassphrase(msg.passphrase);
    if (!validated.ok) return null;
    return this.passphrases.get(passphraseKey(validated.value)) ?? null;
  }

  /** 招待制ルームへの参加。session 指定時は再接続として扱う（§3.2） */
  private handleJoin(link: ClientLink, msg: Extract<C2S, { t: "join" }>): void {
    if (this.links.has(link.id)) {
      sendError(link, "INVALID_INPUT", "すでにルームに参加しています");
      return;
    }
    const code = this.resolveRoomCode(msg);
    if (code === null || !this.rooms.has(code)) {
      sendError(link, "ROOM_NOT_FOUND", "ルームが見つかりません");
      return;
    }
    this.enqueue(code, () => {
      const entry = this.rooms.get(code);
      if (entry === undefined) {
        sendError(link, "ROOM_NOT_FOUND", "ルームが見つかりません");
        return;
      }
      this.doJoin(entry, link, msg);
    });
  }

  /**
   * 入室許可（entryToken）を検証して使い切る（§3.1.1）。
   *
   * 使用は1回限り・60秒で失効。ノック時のあだ名と一致していることも見る
   * （承認された名前と違う名前で入られると、ホストが通した相手と別人になる）。
   * 成功したら、その申請者に割り当ててあったセッショントークンを返す
   */
  private consumeEntryToken(
    room: Room,
    token: unknown,
    nickname: string,
    now: number,
  ): Result<string> {
    if (typeof token !== "string") {
      return err("INVALID_TOKEN", "この卓に入るにはホストの承認が要ります");
    }
    const pending = room.pendingEntries.get(token);
    if (pending === undefined || pending.used) {
      return err("INVALID_TOKEN", "入室の許可が見つかりません。もう一度ノックしてください");
    }
    if (pending.expiresAt <= now) {
      room.pendingEntries.delete(token);
      return err("INVALID_TOKEN", "入室の許可の期限が切れました。もう一度ノックしてください");
    }
    if (pending.nickname !== nickname) {
      return err("INVALID_TOKEN", "ノックしたときのあだ名と違います");
    }
    // 1回限り。使ったものは残さない
    room.pendingEntries.delete(token);
    return ok(pending.sessionToken);
  }

  /** 参加の本体。キューの中から呼ばれる */
  private doJoin(entry: RoomEntry, link: ClientLink, msg: Extract<C2S, { t: "join" }>): void {
    const room = entry.room;
    const now = this.now();
    const session = typeof msg.session === "string" ? msg.session : undefined;
    if (session !== undefined) {
      const existing = findBySession(room, session);
      if (existing !== null) {
        this.reconnect(entry, link, existing, now);
        return;
      }
      // 猶予超過で退室済みなど、既知でないセッションは新規参加として扱う
    }
    // キックされたセッションは戻れない（§3.1）。session は本人しか知らないサーバー発行の
    // 値なので、これで「同じブラウザのまま入り直す」を塞げる。ブラウザを変えられると
    // 抜けられるのは仕様どおりの割り切り（§3.1 に明記）
    if (session !== undefined && room.blockedSessions.has(session)) {
      sendError(link, "BLOCKED", "この卓には入れません");
      return;
    }
    // 公開ルームは「オープン入室」として扱い、コードだけで入れる（§3.1）。
    // TODO(チーム分担): §3.1.1 承認制（ノック → entryToken の検証・消費）。
    // 入室方式（open / knock）を Room に持たせたうえで、knock の側だけ必須にする
    // あだ名を省略した参加者にはしゅんぴが二つ名を付ける（§3.0 / §3.10）。
    // 空文字は「入力し忘れ」と区別できないので、従来どおり検証で弾く
    let assignedNickname: string | undefined;
    let nicknameValue: string;
    if (msg.nickname === undefined) {
      const taken = new Set([...room.players.values()].map((p) => p.nickname));
      assignedNickname = pickNickname(taken, this.rng);
      nicknameValue = assignedNickname;
    } else {
      const nickname = validateNickname(msg.nickname);
      if (!nickname.ok) {
        sendError(link, nickname.code, nickname.message);
        return;
      }
      nicknameValue = nickname.value;
    }
    // 趣味タグ（§3.11）。再接続はこの手前で return しているので、ここに来るのは
    // 新規入室だけ。復帰した人のタグは卓が覚えているものをそのまま使う
    const tags = validateHobbyTags(msg.tags);
    if (!tags.ok) {
      sendError(link, tags.code, tags.message);
      return;
    }
    if (room.players.size >= ROOM_CAPACITY) {
      sendError(link, "ROOM_FULL", `このルームは満員です（定員${ROOM_CAPACITY}人）`);
      return;
    }
    // 承認制の卓は、承認の証（entryToken）が無いと入れない（§3.1.1）。
    // 公開ルームは6桁コードを一覧に出さないので、コードだけでは通さない
    let approvedSession: string | undefined;
    if (room.visibility === "public" && room.entryMode === "knock") {
      const consumed = this.consumeEntryToken(room, msg.entryToken, nicknameValue, now);
      if (!consumed.ok) {
        sendError(link, consumed.code, consumed.message);
        return;
      }
      approvedSession = consumed.value;
    }
    const player = this.newPlayer(nicknameValue, tags.value);
    // 承認された人には、ノック時に割り当てたトークンをそのまま持たせる。
    // こうしておくと、キックされたあとに再ノックしてもブロックが効く
    if (approvedSession !== undefined) player.sessionToken = approvedSession;
    // 新しい ID は Map の末尾に足されるだけなので、既存の参加者の参加順インデックス
    // （＝ VC 枠の割り当て）は動かない。人が増える向きでは繰り上がりの配信は要らない
    // （繰り上がりが起きるのは在籍から人が消える removePlayer だけ）
    room.players.set(player.id, player);
    room.lastActiveAt = now;
    entry.links.set(player.id, link);
    this.links.set(link.id, { link, roomCode: room.code, playerId: player.id });
    this.applyModuleEvent(entry, {
      t: "playerJoined",
      playerId: player.id,
      nickname: player.nickname,
      now,
    });
    this.sendSnapshot(entry, player);
    // 入室者本人にスナップショットを送ってから bot に喋らせる。
    // 逆順だと挨拶が履歴に載る前のスナップショットを掴んで、本人にだけ見えない
    this.applyBotEvent(
      entry,
      assignedNickname === undefined
        ? { t: "playerJoined", playerId: player.id, nickname: player.nickname }
        : { t: "playerJoined", playerId: player.id, nickname: player.nickname, assignedNickname },
    );
    this.broadcastExcept(entry, player.id, {
      t: "playerJoined",
      player: this.toPublic(entry, player),
    });
  }

  /** 同一 sessionToken での再接続。フルスナップショットを送って復帰させる（§3.2） */
  private reconnect(entry: RoomEntry, link: ClientLink, player: Player, now: number): void {
    this.cancelGraceTimer(entry, player.id);
    const previous = entry.links.get(player.id);
    if (previous !== undefined && previous !== link) {
      this.links.delete(previous.id);
      previous.close();
    }
    player.connected = true;
    delete player.disconnectedAt;
    entry.room.lastActiveAt = now;
    entry.links.set(player.id, link);
    this.links.set(link.id, { link, roomCode: entry.room.code, playerId: player.id });
    this.applyModuleEvent(entry, { t: "playerRejoined", playerId: player.id, now });
    this.applyBotEvent(entry, {
      t: "playerRejoined",
      playerId: player.id,
      nickname: player.nickname,
    });
    this.sendSnapshot(entry, player);
    this.broadcastExcept(entry, player.id, {
      t: "playerJoined",
      player: this.toPublic(entry, player),
    });
  }

  /** 未使用の6桁コードを採番する */
  private allocateRoomCode(): string | null {
    for (let i = 0; i < ROOM_CODE_ATTEMPTS; i++) {
      const code = randomRoomCode();
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  /**
   * 新しい参加者を作る。sessionToken は再接続の本人確認に使う。
   * tags は検証済みの趣味タグ（§3.11）。1つも無い人には持たせない
   */
  private newPlayer(nickname: string, tags: HobbyTagId[] = []): Player {
    return {
      id: crypto.randomUUID(),
      nickname,
      connected: true,
      sessionToken: crypto.randomUUID(),
      score: 0,
      ...(tags.length === 0 ? {} : { tags }),
    };
  }

  // -------------------------------------------------------------------------
  // ルーム内メッセージ
  // -------------------------------------------------------------------------

  /** ルームに所属している接続からのメッセージを処理する */
  private handleInRoom(state: LinkState, msg: C2S): void {
    const entry = this.rooms.get(state.roomCode);
    if (entry === undefined) {
      sendError(state.link, "ROOM_NOT_FOUND", "ルームが見つかりません");
      return;
    }
    const player = entry.room.players.get(state.playerId);
    if (player === undefined) {
      sendError(state.link, "ROOM_NOT_FOUND", "ルームから退室済みです");
      return;
    }
    const now = this.now();
    entry.room.lastActiveAt = now;
    // §3.8 の WS レート制限（1接続あたり 20件/秒 を超えたら切断）は接続単位の規定のため、
    // main.ts の WebSocket 層で実装済み（ここには置かない）
    //
    // ゲーム操作は沈黙判定の起点になるので、受理・却下にかかわらず bot に伝える（§3.10）。
    // 却下された操作も「人がまだ触っている」証拠であり、bot が話題を投下する理由にはならない
    if (GAME_ACTION_TYPES.has(msg.t)) this.applyBotEvent(entry, { t: "gameAction" });
    switch (msg.t) {
      case "leave":
        this.removePlayer(entry, player.id, "leave");
        return;
      case "selectGame":
        this.handleSelectGame(entry, state, msg.gameId);
        return;
      case "startGame":
        this.handleStartGame(entry, state, now);
        return;
      case "skipPhase":
        if (!this.requireHost(entry, state)) return;
        this.applyModuleEvent(entry, { t: "skipPhase", now }, state.link);
        return;
      case "submitInput":
        if (typeof msg.value !== "string" && typeof msg.value !== "number") {
          sendError(state.link, "INVALID_INPUT", "回答の形式が正しくありません");
          return;
        }
        // 既存の submitInput は prompt モジュールの clientEvent へ写像する。
        // クライアントの見た目は変えず、サーバー側の経路だけを1本にする（§2.2）
        this.applyModuleEvent(
          entry,
          {
            t: "clientEvent",
            playerId: player.id,
            payload: { k: "submitInput", value: msg.value },
            now,
          },
          state.link,
        );
        return;
      case "submitVote":
        if (typeof msg.targetPlayerId !== "string") {
          sendError(state.link, "INVALID_INPUT", "投票先の形式が正しくありません");
          return;
        }
        this.applyModuleEvent(
          entry,
          {
            t: "clientEvent",
            playerId: player.id,
            payload: { k: "submitVote", targetPlayerId: msg.targetPlayerId },
            now,
          },
          state.link,
        );
        return;
      case "rtcSignal":
        // 中継条件を満たさない場合は黙って破棄する（§3.6 / §3.8）
        this.relayRtcSignal(entry, player, msg);
        return;
      case "gameEvent":
        this.handleGameEvent(entry, state, player, msg, now);
        return;
      case "chat":
        this.handleChat(entry, state, player, msg.text, now);
        return;
      case "voice":
        // 中継条件（VC 枠内のみ）を満たさない場合は黙って破棄する（docs/design/bot-voice.md）
        this.handleVoice(entry, state, player, msg.text, now);
        return;
      case "setBot":
        this.handleSetBot(entry, state, msg);
        return;
      case "endPollVote":
        this.handleEndPollVote(entry, state, player, msg);
        return;
      case "kick":
        this.handleKick(entry, state, msg);
        return;
      case "approveKnock":
        this.handleApproveKnock(entry, state, msg);
        return;
      case "rejectKnock":
        this.handleRejectKnock(entry, state, msg);
        return;
      // knock は卓の外から届くので handle() の入口で処理する。ここへは来ない
      case "knock":
      // TODO(チーム分担): §3.5 importGame（共有コードから availableGames に追加）
      case "importGame":
        sendError(state.link, "INVALID_INPUT", NOT_IMPLEMENTED_MESSAGE);
        return;
      default:
        sendError(state.link, "INVALID_INPUT", NOT_IMPLEMENTED_MESSAGE);
        return;
    }
  }

  /**
   * VC シグナリングを宛先へ中継する（§3.6 / §3.8）。
   * 中継するのは「送信者と同一ルームに在籍し、接続中で、双方が VC 枠に入っている」相手のみ。
   * それ以外（自分宛・不在・切断中・VC 枠外・型不正）は黙って破棄する。
   * シグナリングは競合で宛先が消えることが正常系のため、エラーは返さない。
   * payload はサーバーでは解釈せずそのまま転送する。
   */
  private relayRtcSignal(
    entry: RoomEntry,
    sender: Player,
    msg: Extract<C2S, { t: "rtcSignal" }>,
  ): void {
    if (typeof msg.to !== "string" || msg.to === sender.id) return;
    if (!entry.room.players.has(msg.to)) return;
    const target = entry.links.get(msg.to);
    if (target === undefined) return;
    if (!this.isVcEligible(entry, sender.id)) return;
    if (!this.isVcEligible(entry, msg.to)) return;
    target.send({ t: "rtcSignal", from: sender.id, payload: msg.payload });
  }

  /** VC 枠（参加順 6 人まで）に入っているか（§3.1） */
  private isVcEligible(entry: RoomEntry, playerId: string): boolean {
    const index = [...entry.room.players.keys()].indexOf(playerId);
    return index >= 0 && index < VC_CAPACITY;
  }

  /** いま VC 枠に入っている参加者IDの集合（参加順の先頭 VC_CAPACITY 人） */
  private vcEligibleIds(entry: RoomEntry): Set<string> {
    const ids = new Set<string>();
    for (const id of entry.room.players.keys()) {
      if (ids.size >= VC_CAPACITY) break;
      ids.add(id);
    }
    return ids;
  }

  /**
   * VC 枠の割り当てが変わった参加者についてだけ、新しい `PlayerPublic` を配り直す（§3.6）。
   *
   * VC 枠は `room.players` の参加順インデックスで決まるため、枠内の誰かが在籍から外れると
   * 7人目以降が繰り上がる。ところが退室時に配るのは「抜けた本人」の `playerLeft` /
   * `playerKicked` だけで、繰り上がった本人の `vcEligible` を伝える便が1通も無かった。
   * クライアントは `state.players` の `vcEligible` しか見ないので、繰り上がった人は
   * 「枠が埋まっています」のまま VC に入れず、既に VC にいる側も相手を対象と見なさない。
   *
   * 全員へ `roomState` を配り直せば直るが、クライアントは `roomState` を受けるたびに
   * ピアを張り直す（`public/room/vc.js` の `restartPeers()`）ため、誰かが抜けるたびに
   * 卓全員の通話が切れる。そこで「割り当てが変わった本人ぶんだけ」を `playerJoined`
   * （＝ 1人分の upsert。受け手は `upsertPlayer` するだけで新規入室の演出はしない）で配る。
   *
   * 変化が無いときは 1 通も出さない。無駄な配信はピア張り直しの引き金になる。
   */
  private broadcastVcEligibilityChanges(entry: RoomEntry, before: Set<string>): void {
    const after = this.vcEligibleIds(entry);
    for (const playerId of after) {
      if (before.has(playerId)) continue;
      const player = entry.room.players.get(playerId);
      if (player === undefined) continue;
      this.broadcast(entry, { t: "playerJoined", player: this.toPublic(entry, player) });
    }
    // 枠から外れる向きは現状の並び（Map の挿入順・削除は前詰め）では起きないが、
    // 起きたときに黙って取り残されないよう対称に配る。在籍から外れた本人は対象外
    // （その人の退席は playerLeft / playerKicked が伝える）
    for (const playerId of before) {
      if (after.has(playerId)) continue;
      const player = entry.room.players.get(playerId);
      if (player === undefined) continue;
      this.broadcast(entry, { t: "playerJoined", player: this.toPublic(entry, player) });
    }
  }

  /** ホストかどうかを検証する。非ホストには NOT_HOST を返す */
  private requireHost(entry: RoomEntry, state: LinkState): boolean {
    if (entry.room.hostId === state.playerId) return true;
    sendError(state.link, "NOT_HOST", "ホストのみが操作できます");
    return false;
  }

  /** ゲーム選択（ホストのみ・lobby のみ） */
  private handleSelectGame(entry: RoomEntry, state: LinkState, gameId: unknown): void {
    if (!this.requireHost(entry, state)) return;
    const room = entry.room;
    if (this.roomPhase(entry) !== "lobby") {
      sendError(state.link, "PHASE_MISMATCH", "ゲームの進行中は変更できません");
      return;
    }
    // 宣言的データのゲーム（availableGames）と専用モジュール型のゲームを同じ経路で選ぶ（§4）
    if (typeof gameId !== "string" || !isSelectableGame(room, gameId)) {
      sendError(state.link, "INVALID_INPUT", "選択できるゲームではありません");
      return;
    }
    room.selectedGameId = gameId;
    this.broadcastPhase(entry);
  }

  /** ゲーム開始（ホストのみ） */
  private handleStartGame(entry: RoomEntry, state: LinkState, now: number): void {
    if (!this.requireHost(entry, state)) return;
    const room = entry.room;
    if (this.roomPhase(entry) !== "lobby") {
      sendError(state.link, "PHASE_MISMATCH", "すでにゲームが進行中です");
      return;
    }
    if (room.selectedGameId === null) {
      sendError(state.link, "INVALID_INPUT", "ゲームが選択されていません");
      return;
    }
    const definition = room.availableGames.get(room.selectedGameId);
    const moduleGame = findModuleGame(room.selectedGameId);
    if (definition === undefined && moduleGame === null) {
      sendError(state.link, "INVALID_INPUT", "選択できるゲームではありません");
      return;
    }
    const players: EnginePlayerInput[] = [...room.players.values()].map((p) => ({
      id: p.id,
      nickname: p.nickname,
      connected: p.connected,
    }));
    // 宣言的データのゲームは prompt モジュールが、それ以外は専用モジュールが進行させる（§2.1 / §4）
    const module: GameModule = moduleGame ?? promptModule;
    const config: PromptConfig | undefined = definition === undefined ? undefined : {
      definition,
      durations: phaseDurationsFor(definition.scoring),
    };
    if (module.kind === "module" && players.length < module.meta.minPlayers) {
      sendError(
        state.link,
        "PHASE_MISMATCH",
        `このあそびは${module.meta.minPlayers}人から始められます`,
      );
      return;
    }
    const phaseBefore: RoomPhase = this.roomPhase(entry);
    const result = module.init({
      players,
      now,
      // 種は推測不能でなければならない（randomGameSeed のコメント参照）。
      // ルームコードや now から作らないこと
      seed: this.gameSeed(),
      config,
    });
    if (result.error !== undefined) {
      sendError(state.link, result.error, result.message ?? "ゲームを開始できません");
      return;
    }
    this.startModule(entry, module.id, result.state);
    this.applyEffects(entry, result.effects, phaseBefore);
    this.syncPhaseTimer(entry);
  }

  /**
   * ゲーム内イベント（設計書 §2.2）。進行中のモジュールが payload を検証・解釈する。
   * 上限超過は黙って捨てず INVALID_INPUT で返す（送信側に非があることを伝えるため。§2.3）
   */
  private handleGameEvent(
    entry: RoomEntry,
    state: LinkState,
    player: Player,
    msg: Extract<C2S, { t: "gameEvent" }>,
    now: number,
  ): void {
    if (gameEventPayloadExceedsLimit(msg.payload)) {
      sendError(state.link, "INVALID_INPUT", "ゲーム内イベントが大きすぎます");
      return;
    }
    this.applyModuleEvent(
      entry,
      { t: "clientEvent", playerId: player.id, payload: msg.payload, now },
      state.link,
    );
  }

  // -------------------------------------------------------------------------
  // チャット（§3.9）
  // -------------------------------------------------------------------------

  /**
   * チャット発言を処理する。フェーズによる制限は設けず、観戦者も発言できる（§3.9）。
   * 受理したら履歴に積み、発言者本人を含むルーム内の全接続へ配信する。
   */
  private handleChat(
    entry: RoomEntry,
    state: LinkState,
    player: Player,
    text: unknown,
    now: number,
  ): void {
    const validated = validateChatText(text);
    if (!validated.ok) {
      sendError(state.link, validated.code, validated.message);
      return;
    }
    // レート制限（1参加者 5件/10秒、§3.9）。窓から外れた時刻は捨ててメモリを増やさない
    const times = (entry.chatTimes.get(player.id) ?? [])
      .filter((at) => now - at < CHAT_RATE_WINDOW_MS);
    if (times.length >= CHAT_RATE_MAX) {
      entry.chatTimes.set(player.id, times);
      sendError(
        state.link,
        "RATE_LIMITED",
        `発言が多すぎます（${CHAT_RATE_WINDOW_MS / 1000}秒に${CHAT_RATE_MAX}件まで）`,
      );
      return;
    }
    times.push(now);
    entry.chatTimes.set(player.id, times);
    // 進行中のゲームモジュールへ発言を渡す（設計書 §2.7「回答をチャットで受け取る」）。
    // 進行していなければ applyModuleEvent が null を返すだけで、卓の挙動は今までどおり。
    // origin を渡さないのは、チャットはゲーム操作ではないため。チャットを使わない
    // モジュールが返すエラーを発言者へ見せてはいけない
    const judged = this.applyModuleEvent(entry, {
      t: "chatMessage",
      playerId: player.id,
      text: validated.value,
      now,
    });
    // モジュールが suppressChat を返した発言は卓に出さない（履歴にも積まず、bot にも渡さない）。
    // 当てゲームで正解の発言が見えると答えが総取りになるため。発言者本人へのフィードバックは
    // モジュールの view が返す（お絵かき当ての myCorrectOrder）
    if (judged !== null && judged.effects.some((e) => e.t === "suppressChat")) return;
    // TODO(チーム分担): §3.10 bot 発言の投稿口
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      playerId: player.id,
      nickname: player.nickname,
      text: validated.value,
      at: now,
      bot: false,
    };
    entry.room.chatHistory.push(message);
    // 履歴は直近 CHAT_HISTORY_MAX 件のみ保持する（古い方から捨てる、§3.9）
    if (entry.room.chatHistory.length > CHAT_HISTORY_MAX) {
      entry.room.chatHistory.splice(0, entry.room.chatHistory.length - CHAT_HISTORY_MAX);
    }
    this.broadcast(entry, { t: "chat", message });
    // 発言を配信してから bot に渡す。せりの川柳返しが元の発言より先に出ないようにする
    this.applyBotEvent(entry, {
      t: "message",
      playerId: player.id,
      nickname: player.nickname,
      text: message.text,
      source: "chat",
    });
  }

  /**
   * 通話の文字起こしを処理する（docs/design/bot-voice.md）。
   * chatHistory には積まない。喋り言葉は量が多く、積むと §3.9 の直近100件が
   * 文字起こしで埋まってチャットの履歴が押し出されるため。
   *
   * 受理は VC 枠に入っている参加者からのみ（isVcEligible）。voice は「喋った」という
   * 属性そのものの主張であり、VC 枠外の人はそもそも通話に参加できないので受理すると
   * 偽装になる。偽の voice は配信後に applyBotEvent を通じて bot を駆動できてしまう
   * （せりの川柳検出を任意のタイミングで誤爆させる／ぐっちーの沈黙タイマーをリセットして
   * 話題振りを封じる／喋っていない人の発言を捏造する）。§3.8 が rtcSignal に定める
   * 「双方が VC 枠に入っているときのみ中継する」という前例（relayRtcSignal）に揃える。
   * 枠外なら黙って破棄する（エラーは返さない。rtcSignal と同じ扱い）。
   *
   * 限界: isVcEligible は「VC 枠を持っているか（先着6人か）」であって「実際に VC に
   * 参加しているか」ではない。サーバーは VC の参加状態を持たない（§3.6 で payload は
   * サーバーが解釈しない設計）ため、枠内にいて VC 未参加の人による偽装は防げない。
   * 厳密化には §3.6 の設計変更（サーバーが VC 参加状態を追跡する）が必要な別課題とする。
   */
  private handleVoice(
    entry: RoomEntry,
    state: LinkState,
    player: Player,
    text: unknown,
    now: number,
  ): void {
    if (!this.isVcEligible(entry, player.id)) return;
    const validated = validateChatText(text); // 200文字・制御文字の基準は共通
    if (!validated.ok) {
      sendError(state.link, validated.code, validated.message);
      return;
    }
    // レート制限。窓から外れた時刻は捨ててメモリを増やさない（chatTimes と同じ扱い）
    const times = (entry.voiceTimes.get(player.id) ?? [])
      .filter((at) => now - at < VOICE_RATE_WINDOW_MS);
    if (times.length >= VOICE_RATE_MAX) {
      entry.voiceTimes.set(player.id, times);
      // 超過は黙って捨てる。喋っている最中にエラーを出しても本人には止めようがなく、
      // rtcSignal（§3.8）と同じ「破棄するだけ」の扱いにする
      return;
    }
    times.push(now);
    entry.voiceTimes.set(player.id, times);
    const line: VoiceLine = {
      id: crypto.randomUUID(),
      playerId: player.id,
      nickname: player.nickname,
      text: validated.value,
      at: now,
    };
    this.broadcast(entry, { t: "voice", line });
    // 配信してから bot に渡す。せりの返しが元の発言より先に出ないようにする
    this.applyBotEvent(entry, {
      t: "message",
      playerId: player.id,
      nickname: player.nickname,
      text: line.text,
      source: "voice",
    });
  }

  /**
   * 公開・承認制ルームへの入室申請（§3.1.1）。
   *
   * 申請者はまだ卓に居ないので、返事は knockers 経由で直接その接続へ送る。
   * 申請者にはここでセッショントークンを割り当て、承認されたらそのまま入室に使う。
   * こうしておくと、キックされた相手が再ノックしてきたときにブロックが効く。
   */
  private handleKnock(link: ClientLink, msg: Extract<C2S, { t: "knock" }>): void {
    if (this.links.has(link.id)) {
      sendError(link, "INVALID_INPUT", "すでにルームに参加しています");
      return;
    }
    const code = normalizeRoomCode(msg.roomCode);
    if (code === null) {
      sendError(link, "ROOM_NOT_FOUND", "ルームが見つかりません");
      return;
    }
    this.enqueue(code, () => {
      const entry = this.rooms.get(code);
      if (entry === undefined) {
        sendError(link, "ROOM_NOT_FOUND", "ルームが見つかりません");
        return;
      }
      const room = entry.room;
      if (room.visibility !== "public" || room.entryMode !== "knock") {
        // 承認を待つ必要がない卓。ノックではなく join で入ってもらう
        sendError(link, "INVALID_INPUT", "この卓はノックなしで入れます");
        return;
      }
      const nickname = validateNickname(msg.nickname);
      if (!nickname.ok) {
        sendError(link, nickname.code, nickname.message);
        return;
      }
      // 名乗られた session は「前にこの卓へ関わった証」の自己申告でしかない。
      // クライアントが自由に決められる値なので、**ブロックの照合にだけ**使う。
      // 空文字は名乗っていないのと同じ扱いにする
      const known = typeof msg.session === "string" && msg.session.length > 0
        ? msg.session
        : undefined;
      if (known !== undefined && room.blockedSessions.has(known)) {
        sendError(link, "BLOCKED", "この卓には入れません");
        return;
      }
      // 1つの接続が同じ卓へ何度も申請しないよう、先の申請を数える（§3.8）
      for (const knocker of this.knockers.values()) {
        if (knocker.link.id === link.id && knocker.roomCode === code) {
          sendError(link, "DUPLICATE", "すでにこの卓をノックしています");
          return;
        }
      }
      const now = this.now();
      const recent = entry.knockTimes.get(link.id);
      if (recent !== undefined && now - recent < KNOCK_RATE_WINDOW_MS) {
        sendError(link, "RATE_LIMITED", "続けてノックはできません。少し待ってください");
        return;
      }
      if (room.pendingKnocks.size >= PENDING_KNOCK_MAX) {
        // ホストが捌ききれない数を溜めない（§3.8）
        sendError(link, "RATE_LIMITED", "この卓は取り込み中です。時間をおいてください");
        return;
      }
      const knockId = crypto.randomUUID();
      const knock: Knock = {
        knockId,
        roomCode: code,
        nickname: nickname.value,
        // 必ずサーバーが新規発行する。名乗られた値を採ると、その値を知る第三者が
        // join の session から reconnect でき、entryToken もホストの承認も無しに
        // 入室できてしまう（doJoin は findBySession を entryToken 検査より前に見る）
        sessionToken: crypto.randomUUID(),
        createdAt: now,
        expiresAt: now + KNOCK_TTL_MS,
      };
      room.pendingKnocks.set(knockId, knock);
      entry.knockTimes.set(link.id, now);
      this.knockers.set(knockId, {
        link,
        roomCode: code,
        sessionToken: knock.sessionToken,
        timer: this.setTimer(() => {
          this.enqueue(code, () => this.expireKnock(code, knockId));
        }, KNOCK_TTL_MS),
      });
      // 申請者一覧はホストにだけ見せる（§3.2 原則3）
      this.sendToHost(entry, { t: "knockRequest", knockId, nickname: knock.nickname });
      this.sendHostSnapshotRefresh(entry);
    });
  }

  /** ホストが申請を通す（§3.1.1）。entryToken を発行して申請者へ渡す */
  private handleApproveKnock(
    entry: RoomEntry,
    state: LinkState,
    msg: Extract<C2S, { t: "approveKnock" }>,
  ): void {
    if (!this.requireHost(entry, state)) return;
    const knock = this.takeKnockForHost(entry, state, msg.knockId, false);
    if (knock === null) return;
    // 満員の間は通せないが、申請は保留のまま残す（§3.1 の「満員時のノック承認」）。
    // 誰かが抜けたら、そのまま承認し直せる
    if (entry.room.players.size >= ROOM_CAPACITY) {
      sendError(state.link, "ROOM_FULL", `このルームは満員です（定員${ROOM_CAPACITY}人）`);
      return;
    }
    const knocker = this.knockers.get(msg.knockId);
    entry.room.pendingKnocks.delete(msg.knockId);
    if (knocker !== undefined) {
      this.clearTimer(knocker.timer);
      this.knockers.delete(msg.knockId);
    }
    const now = this.now();
    const entryToken = crypto.randomUUID().replaceAll("-", "");
    entry.room.pendingEntries.set(entryToken, {
      entryToken,
      nickname: knock.nickname,
      sessionToken: knock.sessionToken,
      issuedAt: now,
      expiresAt: now + ENTRY_TOKEN_TTL_MS,
      used: false,
    });
    knocker?.link.send({
      t: "knockResult",
      accepted: true,
      roomCode: entry.room.code,
      entryToken,
    });
    this.sendHostSnapshotRefresh(entry);
  }

  /** ホストが申請を断る（§3.1.1） */
  private handleRejectKnock(
    entry: RoomEntry,
    state: LinkState,
    msg: Extract<C2S, { t: "rejectKnock" }>,
  ): void {
    if (!this.requireHost(entry, state)) return;
    if (this.takeKnockForHost(entry, state, msg.knockId, true) === null) return;
    this.sendHostSnapshotRefresh(entry);
  }

  /**
   * 保留中の申請を引く。remove が true なら取り下げて申請者へ拒否を返す。
   * 見つからない場合はホストへエラーを返して null を返す
   */
  private takeKnockForHost(
    entry: RoomEntry,
    state: LinkState,
    knockId: unknown,
    remove: boolean,
  ): Knock | null {
    if (typeof knockId !== "string") {
      sendError(state.link, "INVALID_INPUT", "申請の指定が正しくありません");
      return null;
    }
    const knock = entry.room.pendingKnocks.get(knockId);
    if (knock === undefined) {
      // 時間切れ・取り下げ済み。ホストの手元の表示が古いだけなので静かに知らせる
      sendError(state.link, "INVALID_INPUT", "その申請はすでにありません");
      return null;
    }
    if (remove) {
      entry.room.pendingKnocks.delete(knockId);
      this.settleKnocker(knockId, { t: "knockResult", accepted: false });
    }
    return knock;
  }

  /** 60秒で自動的に断る（§3.1.1）。申請者には拒否と同じ返事を返す */
  private expireKnock(code: string, knockId: string): void {
    const entry = this.rooms.get(code);
    entry?.room.pendingKnocks.delete(knockId);
    this.settleKnocker(knockId, { t: "knockResult", accepted: false });
    if (entry !== undefined) this.sendHostSnapshotRefresh(entry);
  }

  /**
   * 切れた接続が出していたノックを畳む（§3.1.1）。
   *
   * 申請者は卓に入っていないので links に載らず、disconnect() の通常経路では
   * 掃除されない。放置すると保留枠（PENDING_KNOCK_MAX）を占めたまま60秒残り、
   * 使い捨ての接続から繰り返されると、承認制の卓へ誰も申請できなくなる。
   * ホストの手元にも「承認しても届かない幽霊」が並び続ける。
   */
  private dropKnocksFrom(link: ClientLink): void {
    for (const [knockId, knocker] of [...this.knockers]) {
      if (knocker.link.id !== link.id) continue;
      this.clearTimer(knocker.timer);
      this.knockers.delete(knockId);
      const code = knocker.roomCode;
      this.enqueue(code, () => {
        const entry = this.rooms.get(code);
        if (entry === undefined) return;
        // レート制限の記録も一緒に捨てる。接続IDごとに増えるだけで刈られないため
        entry.knockTimes.delete(link.id);
        if (!entry.room.pendingKnocks.delete(knockId)) return;
        this.sendHostSnapshotRefresh(entry);
      });
    }
  }

  /** 申請者へ返事を送り、待ち受けを畳む */
  private settleKnocker(knockId: string, msg: S2C): void {
    const knocker = this.knockers.get(knockId);
    if (knocker === undefined) return;
    this.clearTimer(knocker.timer);
    this.knockers.delete(knockId);
    knocker.link.send(msg);
  }

  /**
   * ランダムマッチの待機列に並ぶ（§3.1.2）。
   *
   * 卓の外から届くので join と同じ扱いにする。あだ名の扱いも join に合わせ、
   * 省略されたら しゅんぴ の二つ名をマッチ成立時に付ける。
   */
  private handleJoinQueue(link: ClientLink, msg: Extract<C2S, { t: "joinQueue" }>): void {
    if (this.links.has(link.id)) {
      sendError(link, "INVALID_INPUT", "すでにルームに参加しています");
      return;
    }
    if (this.queue.some((w) => w.link.id === link.id)) {
      sendError(link, "DUPLICATE", "すでに相席を待っています");
      return;
    }
    if (this.queue.length >= MATCH_QUEUE_MAX) {
      sendError(link, "RATE_LIMITED", "いまは相席の待ちが多すぎます。時間をおいてください");
      return;
    }
    let nickname: string | undefined;
    if (msg.nickname !== undefined) {
      const validated = validateNickname(msg.nickname);
      if (!validated.ok) {
        sendError(link, validated.code, validated.message);
        return;
      }
      nickname = validated.value;
    }
    // 趣味タグ（§3.11）。成立した卓までそのまま持ち回る
    const tags = validateHobbyTags(msg.tags);
    if (!tags.ok) {
      sendError(link, tags.code, tags.message);
      return;
    }
    this.queue.push({ link, nickname, tags: tags.value, joinedAt: this.now() });
    this.armMatchTimer();
    this.sendQueueStatus();
  }

  /** 待機列から抜ける（§3.1.2）。並んでいなければ何もしない */
  private handleLeaveQueue(link: ClientLink): void {
    if (!this.removeFromQueue(link)) return;
    this.sendQueueStatus();
  }

  /**
   * 待機列から外す。切断時にも呼ぶ（§3.1.2「WS 切断で自動的に列から外れる」）。
   * 実際に外れたときだけ true を返す
   */
  private removeFromQueue(link: ClientLink): boolean {
    const at = this.queue.findIndex((w) => w.link.id === link.id);
    if (at < 0) return false;
    this.queue.splice(at, 1);
    if (this.queue.length === 0) this.cancelMatchTimer();
    return true;
  }

  /** 待っている人へいまの様子を配る。人数が変わるたびに送る */
  private sendQueueStatus(): void {
    const waiting = this.queue.length;
    const nextCheckAt = this.matchDeadline ?? this.now() + MATCH_INTERVAL_MS;
    for (const waiter of this.queue) {
      waiter.link.send({ t: "queueStatus", waiting, nextCheckAt });
    }
  }

  /** 成立判定のタイマーを張る。すでに動いていれば何もしない */
  private armMatchTimer(): void {
    if (this.matchTimer !== null) return;
    this.matchDeadline = this.now() + MATCH_INTERVAL_MS;
    this.matchTimer = this.setTimer(() => {
      this.matchTimer = null;
      this.matchDeadline = null;
      this.runMatching();
    }, MATCH_INTERVAL_MS);
  }

  private cancelMatchTimer(): void {
    if (this.matchTimer === null) return;
    this.clearTimer(this.matchTimer);
    this.matchTimer = null;
    this.matchDeadline = null;
  }

  /**
   * 成立判定（§3.1.2）。
   *
   * 並んだ順に最大4人ずつ切り出し、2人以上そろったグループを成立させる。
   * 端数（1人）は列に残して次の周期へ回す。待っている人が居る限りタイマーを張り直す。
   */
  private runMatching(): void {
    while (this.queue.length >= MATCH_GROUP_MIN) {
      const group = this.queue.splice(0, MATCH_GROUP_MAX);
      // 途中で切れた接続を捨てる。捨てた結果1人になったら成立させない
      // 待っている間に卓へ入った人は列から外す（切断は disconnect で外れている）
      const alive = group.filter((w) => !this.links.has(w.link.id));
      if (alive.length < MATCH_GROUP_MIN) {
        // 生き残りは列の先頭へ戻して、次の周期でもう一度合わせる
        this.queue.unshift(...alive);
        break;
      }
      this.createMatchRoom(alive);
    }
    if (this.queue.length > 0) this.armMatchTimer();
    this.sendQueueStatus();
  }

  /**
   * マッチ専用ルームを作って全員を入れる（§3.1.2）。
   *
   * 一覧に載せず合言葉も持たないので、後から他人は入れない。ホストは先頭の1人。
   * ownerUserId は空（システム生成）。それ以外は通常の卓と同じに扱う
   */
  private createMatchRoom(group: Waiting[]): void {
    const code = this.allocateRoomCode();
    if (code === null) {
      for (const waiter of group) {
        sendError(waiter.link, "INVALID_INPUT", "相席の席を用意できませんでした");
      }
      return;
    }
    const now = this.now();
    const taken = new Set<string>();
    const players = new Map<string, Player>();
    const links = new Map<string, ClientLink>();
    let hostId = "";
    for (const waiter of group) {
      // あだ名を省いた人には、ここで しゅんぴ の二つ名を付ける（§3.0 / §3.10）
      const nickname = waiter.nickname ?? pickNickname(taken, this.rng);
      taken.add(nickname);
      const player = this.newPlayer(nickname, waiter.tags);
      if (hostId === "") hostId = player.id;
      players.set(player.id, player);
      links.set(player.id, waiter.link);
    }
    const room: Room = {
      code,
      // 一覧に載せない。載せると「後から他人が入れない」が守れない
      visibility: "private",
      entryMode: "open",
      ownerUserId: "",
      hostId,
      players,
      pendingKnocks: new Map(),
      pendingEntries: new Map(),
      blockedSessions: new Set(),
      availableGames: new Map(OFFICIAL_GAMES.map((g) => [g.id, g])),
      selectedGameId: null,
      game: null,
      chatHistory: [],
      createdAt: now,
      lastActiveAt: now,
    };
    const entry: RoomEntry = {
      room,
      links,
      queue: [],
      draining: false,
      phaseTimer: null,
      scheduledAt: null,
      graceTimers: new Map(),
      chatTimes: new Map(),
      knockTimes: new Map(),
      voiceTimes: new Map(),
      bot: createBotState(now),
      botTimer: null,
      botPollTimer: null,
    };
    this.rooms.set(code, entry);
    this.armBotTimer(entry);
    for (const [playerId, link] of links) {
      this.links.set(link.id, { link, roomCode: code, playerId });
    }
    // 先に成立を知らせてから中身を配る。roomState だけだと、待っていた人の画面で
    // 「いつのまにか卓に居る」ことになって何が起きたか分からない
    for (const link of links.values()) link.send({ t: "matched", roomCode: code });
    for (const player of players.values()) {
      this.sendSnapshot(entry, player);
      this.applyBotEvent(entry, {
        t: "playerJoined",
        playerId: player.id,
        nickname: player.nickname,
      });
    }
  }

  /** ホストの接続へ1件送る */
  private sendToHost(entry: RoomEntry, msg: S2C): void {
    entry.links.get(entry.room.hostId)?.send(msg);
  }

  /**
   * 申請者一覧が変わったので、ホストにだけスナップショットを送り直す。
   * pendingKnocks はホスト以外には載らないため、全員へ配る必要がない（§3.2 原則3）
   */
  private sendHostSnapshotRefresh(entry: RoomEntry): void {
    const host = entry.room.players.get(entry.room.hostId);
    if (host !== undefined) this.sendSnapshot(entry, host);
  }

  /**
   * ホストが参加者を退出させる（§3.1）。
   *
   * 相手の sessionToken をブロックリストへ入れ、あわせて「発行済みで未使用の入室許可
   * （entryToken）」と「保留中のノック」も潰す。ブロックだけでは、承認済みの許可を
   * 握ったままの相手がすり抜けて入り直せてしまうため（§3.1.1 の最後の項）。
   *
   * ブラウザを変えられると抜けられるのは仕様どおりの割り切り（§3.1 に明記）。
   * ここで守れるのは「同じブラウザのまま戻ってくる」経路だけ。
   */
  private handleKick(
    entry: RoomEntry,
    state: LinkState,
    msg: Extract<C2S, { t: "kick" }>,
  ): void {
    if (!this.requireHost(entry, state)) return;
    if (typeof msg.playerId !== "string") {
      sendError(state.link, "INVALID_INPUT", "退出させる相手を指定してください");
      return;
    }
    const room = entry.room;
    const target = room.players.get(msg.playerId);
    if (target === undefined) {
      sendError(state.link, "INVALID_INPUT", "その人はこの卓にいません");
      return;
    }
    if (target.id === state.playerId) {
      // 自分を追い出す道は用意しない。ホストが抜けたいなら退室（leave）で、
      // ホスト委譲まで含めた既存の経路を通す
      sendError(state.link, "INVALID_INPUT", "自分は退出させられません");
      return;
    }
    room.blockedSessions.add(target.sessionToken);
    // 下の2つの掃除は sessionToken の突き合わせで動く。ノック（§3.1.1）は
    // 承認時に配ったトークンを入室した参加者へそのまま引き継ぐので
    // （doJoin の approvedSession → player.sessionToken）、ここが正しく当たる。
    // newPlayer() は毎回新しい値を発行するため、その引き継ぎをやめると
    // ここが何にもマッチせず、キックされた人が元のノック用トークンで
    // 再ノックできてしまう
    for (const [token, pending] of room.pendingEntries) {
      if (pending.sessionToken === target.sessionToken) room.pendingEntries.delete(token);
    }
    for (const [knockId, knock] of room.pendingKnocks) {
      if (knock.sessionToken === target.sessionToken) room.pendingKnocks.delete(knockId);
    }
    this.removePlayer(entry, target.id, "kick");
  }

  /** bot の ON/OFF（ホストのみ、§3.10）。botId 省略で3体まとめて切り替える */
  private handleSetBot(
    entry: RoomEntry,
    state: LinkState,
    msg: Extract<C2S, { t: "setBot" }>,
  ): void {
    if (!this.requireHost(entry, state)) return;
    if (typeof msg.enabled !== "boolean") {
      sendError(state.link, "INVALID_INPUT", "bot の指定が正しくありません");
      return;
    }
    if (msg.botId !== undefined && !BOT_IDS.includes(msg.botId)) {
      sendError(state.link, "INVALID_INPUT", "そのような bot はいません");
      return;
    }
    const event: BotEvent = msg.botId === undefined
      ? { t: "setBot", enabled: msg.enabled }
      : { t: "setBot", botId: msg.botId, enabled: msg.enabled };
    this.applyBotEvent(entry, event, state.link);
    this.broadcast(entry, { t: "botState", bots: { ...entry.bot.enabled } });
  }

  /** 終了アンケートへの投票（§3.10）。過半数が揃えば締切前でも締まる */
  private handleEndPollVote(
    entry: RoomEntry,
    state: LinkState,
    player: Player,
    msg: Extract<C2S, { t: "endPollVote" }>,
  ): void {
    if (typeof msg.pollId !== "string" || typeof msg.agree !== "boolean") {
      sendError(state.link, "INVALID_INPUT", "投票の形式が正しくありません");
      return;
    }
    this.applyBotEvent(
      entry,
      { t: "endPollVote", pollId: msg.pollId, playerId: player.id, agree: msg.agree },
      state.link,
    );
  }

  // -------------------------------------------------------------------------
  // bot 連携（§3.10）
  // -------------------------------------------------------------------------

  /**
   * ルームの出来事を bot に流し、発話と副作用を反映する。
   * bot は engine と同じく純粋関数なので、配信・タイマーはすべてここが持つ。
   * origin を渡した呼び出し（投票など）だけ、拒否理由を送信元に返す。
   */
  private applyBotEvent(entry: RoomEntry, event: BotEvent, origin?: ClientLink): void {
    const result = botReduce(entry.bot, event, this.botContext(entry));
    entry.bot = result.state;
    if (result.error !== undefined) {
      if (origin !== undefined) {
        sendError(origin, result.error, result.message ?? "処理できませんでした");
      }
      return;
    }
    this.publishBotUtterances(entry, result.utterances);
    this.applyBotEffects(entry, result.effects);
  }

  /**
   * いま卓を囲んでいる面々が分け合っている趣味タグを、多い順に並べる（§3.11 用途4）。
   *
   * 「共通」は**2人以上が持っていること**とする。全員一致にすると、1人5個までの
   * タグで全員が重なる場面はほとんど無く、ぐっちーの話題カードが永久に汎用のまま
   * になる。逆に1人でも数えると「共通」の意味が消える。
   * ただし接続中が1人しか居ない卓だけは、その人のタグをそのまま使う
   * （相手が居ないので「共通」を問う意味がなく、その人に合う話題を振る方がよい）。
   *
   * 数えるのは接続中の人だけ（一時切断中の人の趣味で話題を振っても相手が居ない）。
   * 同数のタグは、卓に現れた順を保つ（Map の挿入順 + 安定ソート）ので、
   * 同じ顔ぶれなら毎回同じ並びになる
   */
  private commonTags(entry: RoomEntry): string[] {
    const counts = new Map<string, number>();
    for (const playerId of entry.links.keys()) {
      const player = entry.room.players.get(playerId);
      if (player === undefined) continue;
      for (const tag of player.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    const required = entry.links.size >= 2 ? 2 : 1;
    return [...counts.entries()]
      .filter(([, count]) => count >= required)
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag);
  }

  /** bot に渡す外部依存を組み立てる */
  private botContext(entry: RoomEntry) {
    return {
      now: this.now(),
      // 過半数の母数は「接続中の参加者」。一時切断は entry.links から外れる
      connectedPlayerIds: [...entry.links.keys()],
      // 参加者の共通タグ（§3.11 用途4）。ぐっちーが話題カードを選ぶのに使う
      commonTags: this.commonTags(entry),
      rng: this.rng,
      senryu: this.senryu,
      games: [...entry.room.availableGames.values()].map((g) => ({ id: g.id, title: g.title })),
      newPollId: () => crypto.randomUUID(),
    };
  }

  /** bot の発話をチャット履歴に積んで配信する。発話はチャットのみ（§3.10） */
  private publishBotUtterances(entry: RoomEntry, utterances: readonly BotUtterance[]): void {
    if (utterances.length === 0) return;
    const now = this.now();
    for (const utterance of utterances) {
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        playerId: null,
        nickname: BOTS[utterance.botId].name,
        text: utterance.text,
        at: now,
        bot: true,
        botId: utterance.botId,
        botKind: utterance.kind,
      };
      if (utterance.card !== undefined) message.card = utterance.card;
      entry.room.chatHistory.push(message);
      this.broadcast(entry, { t: "chat", message });
    }
    // 履歴の上限は人の発言と同じ扱い（§3.9）
    if (entry.room.chatHistory.length > CHAT_HISTORY_MAX) {
      entry.room.chatHistory.splice(0, entry.room.chatHistory.length - CHAT_HISTORY_MAX);
    }
  }

  /** bot が要求した副作用を実行する */
  private applyBotEffects(entry: RoomEntry, effects: readonly BotEffect[]): void {
    for (const effect of effects) {
      switch (effect.t) {
        case "pollStarted":
          this.armBotPollTimer(entry, effect.deadline);
          break;
        case "pollClosed":
          this.cancelBotPollTimer(entry);
          // お開きの合意が取れても部屋は自動では閉じない。解散するかはホストの判断（§3.10）
          this.broadcast(entry, {
            t: "botPollClosed",
            pollId: effect.pollId,
            agreed: effect.agreed,
          });
          break;
      }
    }
  }

  /** bot への定期 tick を張り直す。沈黙検知・ゲーム提案はこれで動く */
  private armBotTimer(entry: RoomEntry): void {
    const code = entry.room.code;
    entry.botTimer = this.setTimer(() => {
      this.enqueue(code, () => {
        if (this.rooms.get(code) !== entry) return;
        entry.botTimer = null;
        this.applyBotEvent(entry, { t: "tick" });
        // tick でルームが消えることはないが、念のため生存を確認してから張り直す
        if (this.rooms.get(code) === entry) this.armBotTimer(entry);
      });
    }, BOT_TICK_MS);
  }

  /** 終了アンケートの締切にタイマーを張る。tick 任せだと最大60秒ずれるため */
  private armBotPollTimer(entry: RoomEntry, deadline: number): void {
    this.cancelBotPollTimer(entry);
    const code = entry.room.code;
    const delay = Math.max(0, deadline - this.now());
    entry.botPollTimer = this.setTimer(() => {
      this.enqueue(code, () => {
        if (this.rooms.get(code) !== entry) return;
        entry.botPollTimer = null;
        // 締切に達したアンケートは tick が締める
        this.applyBotEvent(entry, { t: "tick" });
      });
    }, delay);
  }

  /** 終了アンケートの締切タイマーを解除する */
  private cancelBotPollTimer(entry: RoomEntry): void {
    if (entry.botPollTimer === null) return;
    this.clearTimer(entry.botPollTimer);
    entry.botPollTimer = null;
  }

  // -------------------------------------------------------------------------
  // ゲームモジュール連携（docs/design/games-unified.md §2.1）
  // -------------------------------------------------------------------------

  /**
   * 進行中のゲームモジュールを引く。未開始・未知のIDは null。
   *
   * state の実体は `Room.game.state`（unknown）で、その解釈はここで引いた
   * モジュールだけが行う。ルーム層が state の中身を型として知る必要があるのは
   * prompt（既存のフェーズ UI を配るため）だけで、その1点は promptState() に閉じてある
   */
  private activeModule(entry: RoomEntry): GameModule | null {
    const game = entry.room.game;
    if (game === null) return null;
    return findGameModule(game.moduleId);
  }

  /** 進行中のモジュールの state。未開始は null */
  private activeState(entry: RoomEntry): unknown {
    return entry.room.game?.state ?? null;
  }

  /** 進行中が prompt モジュールなら、その state を返す。prompt 以外は null（promptStateOf） */
  private promptState(entry: RoomEntry): GameState | null {
    return promptStateOf(entry.room);
  }

  /** 卓としてのフェーズ（roomPhaseOf） */
  private roomPhase(entry: RoomEntry): RoomPhase {
    return roomPhaseOf(entry.room);
  }

  /**
   * カウントダウン表示用の期限。prompt はエンジンの deadline、専用モジュールは
   * schedule 効果で予約された時刻（＝次に進む時刻）を使う
   */
  private gameDeadline(entry: RoomEntry): number | null {
    const prompt = this.promptState(entry);
    if (prompt !== null) return prompt.deadline;
    if (entry.room.game === null || !entry.room.game.running) return null;
    return entry.scheduledAt;
  }

  /** ゲームを開始し、モジュールと初期 state を卓に載せる（Room.game = ActiveGame） */
  private startModule(entry: RoomEntry, moduleId: string, state: unknown): void {
    entry.room.game = { moduleId, state, running: true };
  }

  /** モジュールが返した新しい state を保存する。開始前（game が無い）なら何もしない */
  private storeState(entry: RoomEntry, state: unknown): void {
    const game = entry.room.game;
    if (game === null) return;
    game.state = state;
  }

  /**
   * 進行中のモジュールにイベントを流し、結果を配信する。エラーは送信元にだけ返す。
   * 変換は行わず、モジュールの語彙（ModuleEvent / ModuleEffect）のまま受け渡す
   */
  private applyModuleEvent(
    entry: RoomEntry,
    event: ModuleEvent,
    origin?: ClientLink,
  ): ModuleResult<unknown> | null {
    const module = this.activeModule(entry);
    if (module === null) {
      if (origin !== undefined && isPlayerAction(event)) {
        sendError(origin, "PHASE_MISMATCH", "ゲームが進行していません");
      }
      return null;
    }
    const phaseBefore = this.roomPhase(entry);
    const result = module.reduce(this.activeState(entry), event);
    this.storeState(entry, result.state);
    if (result.error !== undefined) {
      if (origin !== undefined) {
        sendError(origin, result.error, result.message ?? "処理できませんでした");
      }
      return result;
    }
    this.applyEffects(entry, result.effects, phaseBefore);
    // 表示の作り直しを伴わない変化（提出数・投票数・参加者の増減）も画面に反映する
    if (result.changed && !result.effects.some((e) => e.t === "viewChanged")) {
      this.broadcastPhase(entry);
    }
    this.syncPhaseTimer(entry);
    return result;
  }

  /**
   * ModuleEffect を S2C・タイマー・加点に変換する。
   * phaseBefore は効果を適用する前のフェーズ。bot への phaseChanged 通知を
   * 「実際にフェーズが変わったときだけ」に絞るために使う（§3.10）
   */
  private applyEffects(entry: RoomEntry, effects: ModuleEffect[], phaseBefore: RoomPhase): void {
    // schedule は「次にいつ起こすか」の予約であると同時に、専用モジュール型ゲームの
    // カウントダウン表示（gameView の deadline）の出どころでもある。viewChanged より
    // 先に反映しておかないと、画面に1つ前の期限が出てしまうので、まとめて先に消化する。
    //
    // score も同じ理由で先に消化する。score は Player.score（配信されるスナップショット
    // の一部）を書き換える効果だが、モジュールが返す効果の順序は viewChanged → schedule
    // → score → ended のように score が viewChanged より後ろに来ることがある
    // （例: chicken.ts の finish()）。効果を配列順に処理すると、その viewChanged の時点
    // ではまだ score が未反映のまま配信されてしまい、しかもゲーム終了直後は
    // running=false になった影響で ended 側の再配信（phase 変化がある場合のみ）も
    // 起きないため、更新後の得点が一度もクライアントへ届かない、という不具合が起きる
    // （実機で確認済み: チキンレース終了後、参加者一覧の得点が反映されないまま）。
    // 「モジュールが返す効果の順序に依存しない」ようにするため、score は broadcastPhase
    // より前に必ず適用してしまう。
    //
    // さらに、score が変えるのは Player.score（RoomSnapshot.players の一部）であって、
    // broadcastPhase が配る S2C "phase"（および gameView）のどちらにも Player.score は
    // 乗らない。つまり順序を直しても、そのままでは誰にも roomState が配り直されず、
    // 卓の参加者一覧の得点はいつまでも初回 join 時の値のままになる
    // （これも実機で確認済み: score 適用後に "phase" は届くが "roomState" は届かない）。
    // score は「ゲーム1本につき1回」しか来ない効果なので、score を消化したときに
    // 全員へ roomState を配り直し、参加者一覧を最新の得点で更新する
    let scoreApplied = false;
    for (const effect of effects) {
      if (effect.t === "schedule") entry.scheduledAt = effect.at;
      if (effect.t === "score") {
        scoreApplied = true;
        // Player.score はゲーム横断の累計。1ゲーム分の合計をここで加算する
        for (const row of effect.totals) {
          const player = entry.room.players.get(row.playerId);
          if (player !== undefined) player.score += row.totalScore;
        }
      }
    }
    if (scoreApplied) {
      for (const player of entry.room.players.values()) {
        this.sendSnapshot(entry, player);
      }
    }
    let previousPhase = phaseBefore;
    for (const effect of effects) {
      switch (effect.t) {
        case "viewChanged": {
          this.broadcastPhase(entry);
          const phase = this.roomPhase(entry);
          if (phase !== previousPhase) {
            this.applyBotEvent(entry, { t: "phaseChanged", phase: botPhase(phase) });
            previousPhase = phase;
          }
          break;
        }
        case "schedule":
          // 上で先に消化済み
          break;
        case "score":
          // 上で先に消化済み（viewChanged より前に反映しておく必要があるため）
          break;
        case "roundResult":
          this.broadcast(entry, { t: "roundResult", scores: effect.scores });
          this.applyBotEvent(entry, botResultEvent("roundResult", effect.scores));
          break;
        case "finalResult":
          this.broadcast(entry, { t: "finalResult", scores: effect.scores });
          this.applyBotEvent(entry, botResultEvent("finalResult", effect.scores));
          break;
        case "suppressChat":
          // 発言を伏せるかどうかは handleChat が結果から直接読む（配信前に決める必要がある）。
          // ここでは何もしない
          break;
        case "ended": {
          // state は捨てずに残す（最終結果を表示したままにするため）。
          // 卓としては lobby に戻り、次のゲームを選べるようになる
          if (entry.room.game !== null) entry.room.game.running = false;
          // 専用モジュールは「終わった」ことがフェーズにしか出ないので、ここで配り直す。
          // prompt はエンジンが lobby への phaseChanged を先に出しているため、
          // この時点では既に previousPhase が lobby で、二重配信にはならない
          const phase = this.roomPhase(entry);
          if (phase !== previousPhase) {
            this.broadcastPhase(entry);
            this.applyBotEvent(entry, { t: "phaseChanged", phase: botPhase(phase) });
            previousPhase = phase;
          }
          break;
        }
      }
    }
  }

  /**
   * モジュールが予約した時刻に合わせてタイマーを張り直す。古いタイマーは無効化する。
   * 予約が無ければ（schedule の at が null なら）タイマーを持たない
   */
  private syncPhaseTimer(entry: RoomEntry): void {
    if (entry.phaseTimer !== null) {
      this.clearTimer(entry.phaseTimer);
      entry.phaseTimer = null;
    }
    if (entry.room.game === null) entry.scheduledAt = null;
    const at = entry.scheduledAt;
    if (at === null) return;
    const code = entry.room.code;
    const delay = Math.max(0, at - this.now());
    entry.phaseTimer = this.setTimer(() => {
      this.enqueue(code, () => {
        if (this.rooms.get(code) !== entry) return;
        entry.phaseTimer = null;
        this.applyModuleEvent(entry, { t: "timeout", now: this.now() });
      });
    }, delay);
  }

  // -------------------------------------------------------------------------
  // 切断・退室・ホスト委譲
  // -------------------------------------------------------------------------

  /** 切断から60秒で退室化するタイマーを張る（§3.2） */
  private armGraceTimer(entry: RoomEntry, playerId: string): void {
    this.cancelGraceTimer(entry, playerId);
    const code = entry.room.code;
    const handle = this.setTimer(() => {
      this.enqueue(code, () => {
        if (this.rooms.get(code) !== entry) return;
        entry.graceTimers.delete(playerId);
        const player = entry.room.players.get(playerId);
        if (player === undefined || player.connected) return;
        this.removePlayer(entry, playerId, "graceExpired");
      });
    }, DISCONNECT_GRACE_MS);
    entry.graceTimers.set(playerId, handle);
  }

  /** 切断猶予タイマーを解除する */
  private cancelGraceTimer(entry: RoomEntry, playerId: string): void {
    const handle = entry.graceTimers.get(playerId);
    if (handle === undefined) return;
    this.clearTimer(handle);
    entry.graceTimers.delete(playerId);
  }

  /**
   * 参加者をルームから外す。
   * エンジンには playerKicked（在籍からの完全除外）を流す。ブロックリストには入れない。
   */
  private removePlayer(entry: RoomEntry, playerId: string, reason: RemoveReason): void {
    const room = entry.room;
    const player = room.players.get(playerId);
    if (player === undefined) return;
    const now = this.now();
    // 抜ける前の VC 枠を控えておく。抜けたあとの枠と突き合わせて、
    // 繰り上がった人にだけ更新を配る（broadcastVcEligibilityChanges）
    const vcBefore = this.vcEligibleIds(entry);
    this.cancelGraceTimer(entry, playerId);
    // レート制限の記録も参加者と一緒に破棄する
    entry.chatTimes.delete(playerId);
    entry.voiceTimes.delete(playerId);
    const link = entry.links.get(playerId);
    entry.links.delete(playerId);
    if (link !== undefined) {
      this.links.delete(link.id);
      // キックされた本人には理由を伝えてから切る。黙って切ると通信不良と区別が付かない。
      // 退室は本人の操作なので、そのまま閉じるだけでよい
      if (reason === "kick") link.send({ t: "kicked" });
      if (reason === "leave" || reason === "kick") link.close();
    }
    room.players.delete(playerId);
    room.lastActiveAt = now;
    this.applyModuleEvent(entry, { t: "playerKicked", playerId, now });
    // 退室が確定したので終了アンケートの票も無効にする（§3.10）
    this.applyBotEvent(entry, { t: "playerLeft", playerId });
    // キックは playerKicked で伝える。受け取った各クライアントは、その相手との
    // ピア接続を即座に閉じる（§3.6）。ふつうの退室と混ぜると切断の指示にならない
    if (reason === "kick") {
      this.broadcast(entry, { t: "playerKicked", playerId });
    } else {
      this.broadcast(entry, { t: "playerLeft", player: this.toPublic(entry, player) });
    }
    if (room.hostId === playerId) {
      const successor = [...room.players.keys()][0];
      if (successor !== undefined) {
        room.hostId = successor;
        this.broadcast(entry, { t: "hostChanged", playerId: successor });
      }
    }
    // ホストの委譲まで済ませてから配る。先に配ると PlayerPublic.isHost が古いままになる
    this.broadcastVcEligibilityChanges(entry, vcBefore);
    if (room.players.size === 0) this.deleteRoom(entry);
  }

  /** ルームを破棄する。残っているタイマーもすべて解除する */
  private deleteRoom(entry: RoomEntry): void {
    this.clearRoomTimers(entry);
    for (const link of entry.links.values()) this.links.delete(link.id);
    entry.links.clear();
    entry.chatTimes.clear();
    entry.voiceTimes.clear();
    // 待っている申請者を放置しない。卓が消えたのだから断りを返して畳む
    for (const knockId of [...entry.room.pendingKnocks.keys()]) {
      this.settleKnocker(knockId, { t: "knockResult", accepted: false });
    }
    entry.room.pendingKnocks.clear();
    entry.knockTimes.clear();
    // 合言葉を解放する。残したままだと、消えた卓の合言葉が永久に使えなくなる
    const passphrase = entry.room.passphrase;
    if (passphrase !== undefined) this.passphrases.delete(passphraseKey(passphrase));
    this.rooms.delete(entry.room.code);
  }

  /** ルームに紐づくタイマーをすべて解除する */
  private clearRoomTimers(entry: RoomEntry): void {
    if (entry.phaseTimer !== null) {
      this.clearTimer(entry.phaseTimer);
      entry.phaseTimer = null;
    }
    for (const handle of entry.graceTimers.values()) this.clearTimer(handle);
    entry.graceTimers.clear();
    if (entry.botTimer !== null) {
      this.clearTimer(entry.botTimer);
      entry.botTimer = null;
    }
    this.cancelBotPollTimer(entry);
  }

  // -------------------------------------------------------------------------
  // 配信
  // -------------------------------------------------------------------------

  /** ルーム内の全接続へ送る */
  private broadcast(entry: RoomEntry, msg: S2C): void {
    for (const link of entry.links.values()) link.send(msg);
  }

  /** 指定の参加者以外へ送る */
  private broadcastExcept(entry: RoomEntry, playerId: string, msg: S2C): void {
    for (const [id, link] of entry.links) {
      if (id !== playerId) link.send(msg);
    }
  }

  /**
   * phase は受信者ごとに view を作り分ける（§3.2 原則3）。
   * 専用モジュール型のゲームが動いている間は、続けて gameView も受信者ごとに配る
   * （表示の本体はビューモジュールが描く。設計書 §2.2 / §3.2）
   */
  private broadcastPhase(entry: RoomEntry): void {
    const phase = this.roomPhase(entry);
    const deadline = this.gameDeadline(entry);
    const moduleView = this.moduleViewSource(entry);
    for (const [playerId, link] of entry.links) {
      const msg: Extract<S2C, { t: "phase" }> = {
        t: "phase",
        phase,
        view: this.viewFor(entry, playerId),
      };
      if (deadline !== null) msg.deadline = deadline;
      link.send(msg);
      if (moduleView !== null) {
        link.send({
          t: "gameView",
          gameId: moduleView.id,
          view: moduleView.view(this.activeState(entry), playerId),
          deadline,
        });
      }
    }
  }

  /**
   * 進行中が専用モジュール型のゲームならそのモジュールを返す。
   * prompt・未開始・終了後は null（＝ gameView を配らない）
   */
  private moduleViewSource(entry: RoomEntry): GameModule | null {
    const game = entry.room.game;
    if (game === null || !game.running) return null;
    const module = this.activeModule(entry);
    if (module === null || module.kind !== "module") return null;
    return module;
  }

  /**
   * 受信者向けの PhaseView。lobby は選択中ゲームをルーム層の値で埋める。
   * 専用モジュール型のゲームの中身は PhaseView では表せないので、
   * ここには「どのゲームが動いているか」だけを載せ、本体は gameView で配る
   */
  private viewFor(entry: RoomEntry, playerId: string): PhaseView {
    const phase = this.roomPhase(entry);
    if (phase === "lobby") {
      return { phase: "lobby", selectedGameId: entry.room.selectedGameId };
    }
    if (phase === "playing") {
      return { phase: "playing", gameId: entry.room.game?.moduleId ?? "" };
    }
    // ここまで来るのは prompt モジュールだけ（roomPhase の分岐と対応する）
    const prompt = this.promptState(entry);
    if (prompt === null) {
      return { phase: "lobby", selectedGameId: entry.room.selectedGameId };
    }
    return promptModule.view(prompt, playerId);
  }

  /** 参加者にフルスナップショットを送る（§4.1 roomState） */
  private sendSnapshot(entry: RoomEntry, player: Player): void {
    const link = entry.links.get(player.id);
    if (link === undefined) return;
    link.send({ t: "roomState", snapshot: this.buildSnapshot(entry, player) });
  }

  /** RoomSnapshot を組み立てる。session は本人にのみ入れる */
  private buildSnapshot(entry: RoomEntry, viewer: Player): RoomSnapshot {
    const room = entry.room;
    const prompt = this.promptState(entry);
    const snapshot: RoomSnapshot = {
      code: room.code,
      visibility: room.visibility,
      capacity: ROOM_CAPACITY,
      hostId: room.hostId,
      youId: viewer.id,
      youAreHost: room.hostId === viewer.id,
      youAreSpectator: prompt?.participants[viewer.id]?.role === "spectator",
      players: [...room.players.values()].map((p) => this.toPublic(entry, p)),
      availableGames: availableGameSummaries(room),
      selectedGameId: room.selectedGameId,
      phase: this.roomPhase(entry),
      deadline: this.gameDeadline(entry),
      view: this.viewFor(entry, viewer.id),
      chat: [...room.chatHistory],
      bots: { ...entry.bot.enabled },
      session: viewer.sessionToken,
      serverTime: this.now(),
    };
    // 進行中の専用モジュール型ゲームは、途中参加・再接続でも view を全量配って復元する（§5）
    const moduleView = this.moduleViewSource(entry);
    if (moduleView !== null) {
      snapshot.game = {
        gameId: moduleView.id,
        view: moduleView.view(this.activeState(entry), viewer.id),
        deadline: snapshot.deadline,
      };
    }
    if (room.roomName !== undefined) snapshot.roomName = room.roomName;
    // 集計中のアンケートは再接続でも復元する。締切だけ渡し、投票済みかは持たせない
    const poll = entry.bot.nabe.poll;
    if (poll !== null) {
      snapshot.botPoll = { pollId: poll.id, deadline: poll.startedAt + END_POLL_MS };
    }
    // 申請者一覧はホストにだけ載せる（§3.2 原則3）。
    // 他の参加者に「誰が入りたがっているか」を見せる理由がない
    if (snapshot.youAreHost && room.pendingKnocks.size > 0) {
      snapshot.pendingKnocks = [...room.pendingKnocks.values()].map((k): KnockPublic => ({
        knockId: k.knockId,
        nickname: k.nickname,
        createdAt: k.createdAt,
        expiresAt: k.expiresAt,
      }));
    }
    return snapshot;
  }

  /** 他の参加者にも見せてよい形に変換する（§3.2 原則3） */
  private toPublic(entry: RoomEntry, player: Player): PlayerPublic {
    return {
      id: player.id,
      nickname: player.nickname,
      connected: player.connected,
      isHost: entry.room.hostId === player.id,
      score: player.score,
      vcEligible: this.isVcEligible(entry, player.id),
      // 選んでいない人の分までキーを増やさない（§3.11 用途1）。
      // 配るのは ID だけで、表示名はクライアントが GET /api/tags で引く
      ...(player.tags === undefined || player.tags.length === 0 ? {} : { tags: [...player.tags] }),
    };
  }
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/**
 * 一覧に出すゲーム（設計書 §4）。宣言的データのゲームに続けて専用モジュール型を並べる。
 * 並び順を「宣言的 → モジュール」で固定しているのは、既存の卓・既存テストが見ている
 * 先頭の並びを動かさないため
 */
export function availableGameSummaries(room: Room): GameSummary[] {
  const summaries: GameSummary[] = [...room.availableGames.values()].map((g) => ({
    ...toSummary(g, isOfficialGame(g.id)),
    kind: "prompt" as const,
  }));
  for (const module of MODULE_GAMES) {
    summaries.push({
      id: module.id,
      title: module.meta.title,
      description: module.meta.description,
      minPlayers: module.meta.minPlayers,
      maxPlayers: module.meta.maxPlayers,
      // モジュール型のゲームはリポジトリ入りのコードなので、常に公式扱い（§4）
      official: true,
      kind: "module",
    });
  }
  return summaries;
}

/**
 * 進行中が prompt モジュールなら、その state を GameState として返す。prompt 以外は null。
 *
 * ルーム層に残る唯一の「モジュールの state の中身を知っている」場所。
 * prompt の state がエンジンの GameState であることは prompt.ts の実装が保証しており、
 * moduleId で絞ってから読むことで、その前提をこの1関数に閉じ込めている。
 * 他のモジュールの state は unknown のまま持ち回り、解釈はモジュール自身に任せる
 */
export function promptStateOf(room: Room): GameState | null {
  const game = room.game;
  if (game === null || game.moduleId !== PROMPT_MODULE_ID) return null;
  return game.state as GameState;
}

/**
 * 卓としてのフェーズ。prompt はエンジンのフェーズをそのまま、
 * 専用モジュールは進行中かどうかだけを "playing" / "lobby" で表す（設計書 §3.2）。
 *
 * **ルーム層の外（main.ts のデバッグ表示など）から「いま遊んでいるか」を知りたいときは、
 * `room.game` の中身を直接読まずに必ずこの関数を通すこと。** `Room.game.state` の形は
 * モジュールごとに違い、ルーム層とモジュールしか解釈できない（かつて main.ts が
 * `room.game.phase`＝エンジン固有の形を直接読んでいたのが、層の乱れの元だった）
 */
export function roomPhaseOf(room: Room): RoomPhase {
  const game = room.game;
  if (game === null) return "lobby";
  const prompt = promptStateOf(room);
  if (prompt !== null) return prompt.phase;
  return game.running ? "playing" : "lobby";
}

/**
 * bot へ伝えるフェーズ（bot.ts の BotEvent はエンジンの語彙 Phase を使う）。
 * bot が見ているのは「ロビーへ戻ったか」だけなので、専用モジュール型の "playing" は
 * 進行中を表す intro に寄せて渡す。bot の判定（backToLobby）はこれで変わらない
 */
function botPhase(phase: RoomPhase): Phase {
  return phase === "playing" ? "intro" : phase;
}

/** その gameId を選べるか（宣言的データのゲーム、または専用モジュール型のゲーム） */
function isSelectableGame(room: Room, gameId: string): boolean {
  return room.availableGames.has(gameId) || findModuleGame(gameId) !== null;
}

/**
 * 選択中のゲームのタイトル。選ばれていない・引けない場合は undefined。
 * 万一IDがぶつかったときは専用モジュールを優先する（handleStartGame と同じ順序にする）
 */
function selectedGameTitle(room: Room): string | undefined {
  const id = room.selectedGameId;
  if (id === null) return undefined;
  const module = findModuleGame(id);
  if (module !== null) return module.meta.title;
  return room.availableGames.get(id)?.title;
}

/** ゲームの採点方式に応じたフェーズ秒数。vote 以外の judge は表示のみなので短い */
export function phaseDurationsFor(scoring: ScoringMode): PhaseDurations {
  if (scoring === "vote") return DEFAULT_PHASE_DURATIONS;
  return { ...DEFAULT_PHASE_DURATIONS, judgeSec: NON_VOTE_JUDGE_SEC };
}

/** sessionToken から参加者を探す */
function findBySession(room: Room, session: string): Player | null {
  for (const player of room.players.values()) {
    if (player.sessionToken === session) return player;
  }
  return null;
}

// かつてここに `gameSeed(roomCode, startedAt)`（FNV-1a）があったが、
// 公開情報だけから種が再現できてしまうため削除した。
// 種の作り方は `randomGameSeed` を、テストでの差し替えは
// `RoomManagerOptions.gameSeed` を参照すること。

/** 参加者本人の操作によるイベントか（エラーを返すべき相手がいるか） */
function isPlayerAction(event: ModuleEvent): boolean {
  return event.t === "clientEvent" || event.t === "skipPhase";
}

/** エラーを1件送る */
function sendError(link: ClientLink, code: ErrorCode, message: string): void {
  link.send({ t: "error", code, message });
}

/** 1件の処理中に例外が出ても他の処理を止めない */
function runTask(task: () => void): void {
  try {
    task();
  } catch (e) {
    console.error("room task failed:", e);
  }
}
