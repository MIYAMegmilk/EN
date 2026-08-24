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
 * 公開ルームは「オープン入室」まで実装済み（作成・一覧・コードだけでの入室）。
 * 承認制（ノック）・キック・importGame・24時間自動削除は未実装。
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
  err,
  type ErrorCode,
  ok,
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
  type RoomSnapshot,
  type S2C,
  SANDBOX_PAYLOAD_MAX_BYTES,
  type ScoreEntry,
  type ScoringMode,
  VC_CAPACITY,
  type VoiceLine,
} from "./types.ts";
import {
  buildPhaseView,
  DEFAULT_PHASE_DURATIONS,
  type EngineEffect,
  type EngineEvent,
  type EnginePlayerInput,
  type EngineResult,
  reduce,
  startGame,
} from "./engine.ts";
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
import { charLength, hasControlChar, validateNickname } from "./validation.ts";
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
  /** 接続を閉じる */
  close(): void;
}

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
   * 川柳判定（§3.10 せり）。省略時はかなプロバイダのみで判定する。
   * kuromoji（漢字混じり対応）は読み込みが非同期なので、使う場合は
   * 起動時に作ったものを main.ts からここへ渡す。
   */
  senryu?: (text: string) => SenryuMatch | null;
  /**
   * サンドボックスゲームとして開始を許可する gameId のホワイトリスト
   * （docs/design/game-sandbox.md §4.2 / §6.2）。public/games/manifest.json をサーバー
   * 起動時に main.ts が読み込み、EN_SANDBOX_DEV 環境変数によるフィルタ後の値をここへ渡す。
   * rooms.ts はファイル I/O を持たない（§3.2 規約2: await を書かない）ため、
   * ホワイトリストの正本は main.ts 側にある。省略時は空集合
   * （サンドボックスゲームを一切開始できない）
   */
  sandboxGameIds?: ReadonlySet<string>;
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
  /** 切断猶予タイマー（playerId → ハンドル） */
  graceTimers: Map<string, TimerHandle>;
  /** チャットのレート制限用。playerId → 判定窓内の発言時刻（古い順、§3.9） */
  chatTimes: Map<string, number[]>;
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
type RemoveReason = "leave" | "graceExpired";

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
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly rng: () => number;
  private readonly senryu: (text: string) => SenryuMatch | null;
  private readonly sandboxGameIds: ReadonlySet<string>;

  constructor(options: RoomManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ??
      ((fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle);
    this.clearTimer = options.clearTimer ??
      ((handle) => clearTimeout(handle as unknown as number));
    this.rng = options.rng ?? Math.random;
    this.senryu = options.senryu ?? createDefaultSenryuDetector();
    this.sandboxGameIds = options.sandboxGameIds ?? new Set();
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
      const game = room.game;
      const summary: PublicRoomSummary = {
        code: room.code,
        roomName: room.roomName,
        playerCount: room.players.size,
        capacity: ROOM_CAPACITY,
        playing: game !== null && game.phase !== "lobby",
        createdAt: room.createdAt,
      };
      // 選択中のゲームは「何をして遊んでいる卓か」の手がかりとして出す。
      // 進行内容（お題・回答・得点）は一覧には一切含めない
      const selected = room.selectedGameId === null
        ? undefined
        : room.availableGames.get(room.selectedGameId);
      if (selected !== undefined) summary.gameTitle = selected.title;
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
    const state = this.links.get(link.id);
    if (state === undefined) {
      sendError(link, "ROOM_NOT_FOUND", "ルームに参加していません");
      return;
    }
    this.enqueue(state.roomCode, () => this.handleInRoom(state, msg));
  }

  /** WebSocket が閉じたときの処理（§3.2: 60秒はセッションを保持する） */
  disconnect(link: ClientLink): void {
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
      this.applyEngineEvent(entry, { t: "playerLeft", playerId: player.id, now });
      this.applyBotEvent(entry, { t: "playerDisconnected", playerId: player.id });
      this.broadcast(entry, { t: "playerLeft", player: this.toPublic(entry, player) });
      this.armGraceTimer(entry, player.id);
    });
  }

  /** すべてのタイマーを解除してルームを破棄する（サーバー停止時・テスト後始末） */
  dispose(): void {
    for (const entry of [...this.rooms.values()]) {
      this.clearRoomTimers(entry);
    }
    this.rooms.clear();
    this.links.clear();
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
    const nickname = validateNickname(msg.nickname);
    if (!nickname.ok) {
      sendError(link, nickname.code, nickname.message);
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
    const host = this.newPlayer(nickname.value);
    host.userId = link.userId;
    const room: Room = {
      code,
      visibility: msg.visibility,
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
      sandbox: null,
      createdAt: now,
      lastActiveAt: now,
      ...(roomName === undefined ? {} : { roomName }),
    };
    const entry: RoomEntry = {
      room,
      links: new Map([[host.id, link]]),
      queue: [],
      draining: false,
      phaseTimer: null,
      graceTimers: new Map(),
      chatTimes: new Map(),
      voiceTimes: new Map(),
      bot: createBotState(now),
      botTimer: null,
      botPollTimer: null,
    };
    this.rooms.set(code, entry);
    this.armBotTimer(entry);
    this.links.set(link.id, { link, roomCode: code, playerId: host.id });
    // TODO(チーム分担): §3.1 最終アクティビティから24時間で自動削除する掃除処理
    this.sendSnapshot(entry, host);
  }

  /** 招待制ルームへの参加。session 指定時は再接続として扱う（§3.2） */
  private handleJoin(link: ClientLink, msg: Extract<C2S, { t: "join" }>): void {
    if (this.links.has(link.id)) {
      sendError(link, "INVALID_INPUT", "すでにルームに参加しています");
      return;
    }
    const code = normalizeRoomCode(msg.roomCode);
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
    // TODO(チーム分担): §3.1 キック済み sessionToken（room.blockedSessions）の拒否（BLOCKED）
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
    if (room.players.size >= ROOM_CAPACITY) {
      sendError(link, "ROOM_FULL", `このルームは満員です（定員${ROOM_CAPACITY}人）`);
      return;
    }
    const player = this.newPlayer(nicknameValue);
    room.players.set(player.id, player);
    room.lastActiveAt = now;
    entry.links.set(player.id, link);
    this.links.set(link.id, { link, roomCode: room.code, playerId: player.id });
    this.applyEngineEvent(entry, {
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
    this.applyEngineEvent(entry, { t: "playerRejoined", playerId: player.id, now });
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

  /** 新しい参加者を作る。sessionToken は再接続の本人確認に使う */
  private newPlayer(nickname: string): Player {
    return {
      id: crypto.randomUUID(),
      nickname,
      connected: true,
      sessionToken: crypto.randomUUID(),
      score: 0,
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
        this.applyEngineEvent(entry, { t: "skipPhase", now }, state.link);
        return;
      case "submitInput":
        if (typeof msg.value !== "string" && typeof msg.value !== "number") {
          sendError(state.link, "INVALID_INPUT", "回答の形式が正しくありません");
          return;
        }
        this.applyEngineEvent(
          entry,
          { t: "submitInput", playerId: player.id, value: msg.value, now },
          state.link,
        );
        return;
      case "submitVote":
        if (typeof msg.targetPlayerId !== "string") {
          sendError(state.link, "INVALID_INPUT", "投票先の形式が正しくありません");
          return;
        }
        this.applyEngineEvent(
          entry,
          { t: "submitVote", voterId: player.id, targetPlayerId: msg.targetPlayerId, now },
          state.link,
        );
        return;
      case "rtcSignal":
        // 中継条件を満たさない場合は黙って破棄する（§3.6 / §3.8）
        this.relayRtcSignal(entry, player, msg);
        return;
      case "sandboxStart":
        this.handleSandboxStart(entry, state, msg, now);
        return;
      case "sandboxEnd":
        this.handleSandboxEnd(entry, state);
        return;
      case "sandboxSignal":
        // 中継条件を満たさない場合は黙って破棄する（docs/design/game-sandbox.md §4.4）
        this.relaySandboxSignal(entry, player, msg);
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
      // TODO(チーム分担): §3.1.1 knock / approveKnock / rejectKnock（公開ルーム）
      case "knock":
      case "approveKnock":
      case "rejectKnock":
      // TODO(チーム分担): §3.1 kick（blockedSessions への追加と entryToken 無効化を含む）
      case "kick":
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
    // 既存エンジンとサンドボックスは相互排他（docs/design/game-sandbox.md §5.2）
    if (room.sandbox !== null) {
      sendError(state.link, "PHASE_MISMATCH", "サンドボックスゲームの稼働中は変更できません");
      return;
    }
    if (room.game !== null && room.game.phase !== "lobby") {
      sendError(state.link, "PHASE_MISMATCH", "ゲームの進行中は変更できません");
      return;
    }
    if (typeof gameId !== "string" || !room.availableGames.has(gameId)) {
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
    // 既存エンジンとサンドボックスは相互排他（docs/design/game-sandbox.md §5.2）
    if (room.sandbox !== null) {
      sendError(state.link, "PHASE_MISMATCH", "サンドボックスゲームの稼働中は開始できません");
      return;
    }
    if (room.game !== null && room.game.phase !== "lobby") {
      sendError(state.link, "PHASE_MISMATCH", "すでにゲームが進行中です");
      return;
    }
    if (room.selectedGameId === null) {
      sendError(state.link, "INVALID_INPUT", "ゲームが選択されていません");
      return;
    }
    const definition = room.availableGames.get(room.selectedGameId);
    if (definition === undefined) {
      sendError(state.link, "INVALID_INPUT", "選択できるゲームではありません");
      return;
    }
    const players: EnginePlayerInput[] = [...room.players.values()].map((p) => ({
      id: p.id,
      nickname: p.nickname,
      connected: p.connected,
    }));
    const result = startGame(definition, players, now, phaseDurationsFor(definition.scoring));
    if (result.error !== undefined) {
      sendError(state.link, result.error, result.message ?? "ゲームを開始できません");
      return;
    }
    room.game = result.state;
    this.applyEffects(entry, result.effects);
    this.syncPhaseTimer(entry);
  }

  // -------------------------------------------------------------------------
  // サンドボックスゲーム（docs/design/game-sandbox.md §4 / §5）
  // -------------------------------------------------------------------------

  /**
   * サンドボックスゲームの開始（ホストのみ、§5.1）。
   * 既存エンジンのゲームが進行中なら PHASE_MISMATCH（§5.2）。
   * 既にサンドボックスゲームが稼働中なら、同じ gameId の再送であっても状態を変えず
   * DUPLICATE を返す（§5.2 の「冪等に無視」＝再開始や再ブロードキャストをしないという意味で
   * 冪等であり、エラー自体は都度返す。§8.1 の「二重 sandboxStart は DUPLICATE」に対応）。
   * gameId は sandboxGameIds のホワイトリスト（main.ts がマニフェストから起動時に構築）に
   * 無ければ INVALID_INPUT（未知の gameId・dev ゲームの本番指定を含む、§6.2）。
   */
  private handleSandboxStart(
    entry: RoomEntry,
    state: LinkState,
    msg: Extract<C2S, { t: "sandboxStart" }>,
    now: number,
  ): void {
    if (!this.requireHost(entry, state)) return;
    const room = entry.room;
    if (room.game !== null && room.game.phase !== "lobby") {
      sendError(
        state.link,
        "PHASE_MISMATCH",
        "既存ゲームの進行中はサンドボックスゲームを開始できません",
      );
      return;
    }
    if (room.sandbox !== null) {
      sendError(state.link, "DUPLICATE", "サンドボックスゲームはすでに開始されています");
      return;
    }
    if (typeof msg.gameId !== "string" || !this.sandboxGameIds.has(msg.gameId)) {
      sendError(state.link, "INVALID_INPUT", "選択できるサンドボックスゲームではありません");
      return;
    }
    room.sandbox = { gameId: msg.gameId, startedBy: state.playerId, startedAt: now };
    this.broadcast(entry, { t: "sandboxState", game: room.sandbox });
  }

  /**
   * サンドボックスゲームの終了（ホストのみ、§5.1）。
   * 稼働していないときは何もしない（冪等。仕様書に明記が無いため報告に記載する判断）。
   */
  private handleSandboxEnd(entry: RoomEntry, state: LinkState): void {
    if (!this.requireHost(entry, state)) return;
    const room = entry.room;
    if (room.sandbox === null) return;
    room.sandbox = null;
    this.broadcast(entry, { t: "sandboxState", game: null });
  }

  /**
   * サンドボックスゲーム内メッセージを同室の送信者以外へ中継する（§4.4）。
   * サーバーは payload を解釈しない。中継先に to は無く、常に全員配信（§4.4 の理由）。
   * 中継条件（稼働中・サイズ以内）を満たさない場合は rtcSignal と同じく黙って破棄する。
   * レート制限（ソフト30/秒・ハード150/秒、§4.3）は main.ts の WebSocket 層で行う
   * （rtcSignal と同じ構造。ここに来た時点でレートは通過済み）。
   */
  private relaySandboxSignal(
    entry: RoomEntry,
    sender: Player,
    msg: Extract<C2S, { t: "sandboxSignal" }>,
  ): void {
    if (entry.room.sandbox === null) return;
    if (sandboxPayloadExceedsLimit(msg.payload)) return;
    this.broadcastExcept(entry, sender.id, {
      t: "sandboxSignal",
      from: sender.id,
      payload: msg.payload,
    });
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

  /** bot に渡す外部依存を組み立てる */
  private botContext(entry: RoomEntry) {
    return {
      now: this.now(),
      // 過半数の母数は「接続中の参加者」。一時切断は entry.links から外れる
      connectedPlayerIds: [...entry.links.keys()],
      // TODO(チーム分担): §3.11 趣味タグが入ったら参加者の共通タグを渡す
      commonTags: [] as readonly string[],
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
  // エンジン連携
  // -------------------------------------------------------------------------

  /** エンジンにイベントを流し、結果を配信する。エラーは送信元にだけ返す */
  private applyEngineEvent(
    entry: RoomEntry,
    event: EngineEvent,
    origin?: ClientLink,
  ): EngineResult | null {
    const room = entry.room;
    if (room.game === null) {
      if (origin !== undefined && isPlayerAction(event)) {
        sendError(origin, "PHASE_MISMATCH", "ゲームが進行していません");
      }
      return null;
    }
    const result = reduce(room.game, event);
    room.game = result.state;
    if (result.error !== undefined) {
      if (origin !== undefined) {
        sendError(origin, result.error, result.message ?? "処理できませんでした");
      }
      return result;
    }
    this.applyEffects(entry, result.effects);
    // フェーズが変わらない変化（提出数・投票数・参加者の増減）も画面に反映する
    if (result.changed && !result.effects.some((e) => e.t === "phaseChanged")) {
      this.broadcastPhase(entry);
    }
    this.syncPhaseTimer(entry);
    return result;
  }

  /** EngineEffect を S2C に変換して配信する */
  private applyEffects(entry: RoomEntry, effects: EngineEffect[]): void {
    for (const effect of effects) {
      switch (effect.t) {
        case "phaseChanged":
          this.broadcastPhase(entry);
          this.applyBotEvent(entry, { t: "phaseChanged", phase: effect.phase });
          break;
        case "roundResult":
          this.broadcast(entry, { t: "roundResult", scores: effect.scores });
          this.applyBotEvent(entry, botResultEvent("roundResult", effect.scores));
          break;
        case "finalResult":
          this.broadcast(entry, { t: "finalResult", scores: effect.scores });
          // Player.score はゲーム横断の累計。1ゲーム分の合計をここで加算する
          for (const row of effect.scores) {
            const player = entry.room.players.get(row.playerId);
            if (player !== undefined) player.score += row.totalScore;
          }
          this.applyBotEvent(entry, botResultEvent("finalResult", effect.scores));
          break;
        case "ended":
          break;
      }
    }
  }

  /** 現フェーズの期限に合わせてタイマーを張り直す。古いタイマーは無効化する */
  private syncPhaseTimer(entry: RoomEntry): void {
    if (entry.phaseTimer !== null) {
      this.clearTimer(entry.phaseTimer);
      entry.phaseTimer = null;
    }
    const game = entry.room.game;
    if (game === null || game.deadline === null) return;
    const code = entry.room.code;
    const delay = Math.max(0, game.deadline - this.now());
    entry.phaseTimer = this.setTimer(() => {
      this.enqueue(code, () => {
        if (this.rooms.get(code) !== entry) return;
        entry.phaseTimer = null;
        this.applyEngineEvent(entry, { t: "timeout", now: this.now() });
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
    this.cancelGraceTimer(entry, playerId);
    // レート制限の記録も参加者と一緒に破棄する
    entry.chatTimes.delete(playerId);
    entry.voiceTimes.delete(playerId);
    const link = entry.links.get(playerId);
    entry.links.delete(playerId);
    if (link !== undefined) {
      this.links.delete(link.id);
      if (reason === "leave") link.close();
    }
    room.players.delete(playerId);
    room.lastActiveAt = now;
    this.applyEngineEvent(entry, { t: "playerKicked", playerId, now });
    // 退室が確定したので終了アンケートの票も無効にする（§3.10）
    this.applyBotEvent(entry, { t: "playerLeft", playerId });
    this.broadcast(entry, { t: "playerLeft", player: this.toPublic(entry, player) });
    if (room.hostId === playerId) {
      const successor = [...room.players.keys()][0];
      if (successor !== undefined) {
        room.hostId = successor;
        this.broadcast(entry, { t: "hostChanged", playerId: successor });
      }
    }
    if (room.players.size === 0) this.deleteRoom(entry);
  }

  /** ルームを破棄する。残っているタイマーもすべて解除する */
  private deleteRoom(entry: RoomEntry): void {
    this.clearRoomTimers(entry);
    for (const link of entry.links.values()) this.links.delete(link.id);
    entry.links.clear();
    entry.chatTimes.clear();
    entry.voiceTimes.clear();
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

  /** phase は受信者ごとに view を作り分ける（§3.2 原則3） */
  private broadcastPhase(entry: RoomEntry): void {
    const game = entry.room.game;
    const phase: Phase = game?.phase ?? "lobby";
    const deadline = game?.deadline ?? null;
    for (const [playerId, link] of entry.links) {
      const msg: Extract<S2C, { t: "phase" }> = {
        t: "phase",
        phase,
        view: this.viewFor(entry, playerId),
      };
      if (deadline !== null) msg.deadline = deadline;
      link.send(msg);
    }
  }

  /** 受信者向けの PhaseView。lobby は選択中ゲームをルーム層の値で埋める */
  private viewFor(entry: RoomEntry, playerId: string): PhaseView {
    const game = entry.room.game;
    if (game === null || game.phase === "lobby") {
      return { phase: "lobby", selectedGameId: entry.room.selectedGameId };
    }
    return buildPhaseView(game, playerId);
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
    const game = room.game;
    const snapshot: RoomSnapshot = {
      code: room.code,
      visibility: room.visibility,
      capacity: ROOM_CAPACITY,
      hostId: room.hostId,
      youId: viewer.id,
      youAreHost: room.hostId === viewer.id,
      youAreSpectator: game?.participants[viewer.id]?.role === "spectator",
      players: [...room.players.values()].map((p) => this.toPublic(entry, p)),
      availableGames: [...room.availableGames.values()].map((g) =>
        toSummary(g, isOfficialGame(g.id))
      ),
      selectedGameId: room.selectedGameId,
      phase: game?.phase ?? "lobby",
      deadline: game?.deadline ?? null,
      view: this.viewFor(entry, viewer.id),
      chat: [...room.chatHistory],
      bots: { ...entry.bot.enabled },
      session: viewer.sessionToken,
      serverTime: this.now(),
      sandbox: room.sandbox,
    };
    if (room.roomName !== undefined) snapshot.roomName = room.roomName;
    // 集計中のアンケートは再接続でも復元する。締切だけ渡し、投票済みかは持たせない
    const poll = entry.bot.gucchi.poll;
    if (poll !== null) {
      snapshot.botPoll = { pollId: poll.id, deadline: poll.startedAt + END_POLL_MS };
    }
    // TODO(チーム分担): §3.1.1 公開ルームではホストにのみ pendingKnocks を載せる
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
    };
  }
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

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

/**
 * サンドボックス signal の payload が直列化サイズ上限を超えるか（docs/design/game-sandbox.md §4.4）。
 * 直列化できない値（undefined・関数・symbol 等。JSON 経由で届くメッセージでは通常発生しないが、
 * 型は unknown のため防御的に扱う）は上限超過と同じ扱いで破棄する。
 */
export function sandboxPayloadExceedsLimit(payload: unknown): boolean {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    return true;
  }
  if (typeof json !== "string") return true;
  return new TextEncoder().encode(json).length > SANDBOX_PAYLOAD_MAX_BYTES;
}

/** 参加者本人の操作によるイベントか（エラーを返すべき相手がいるか） */
function isPlayerAction(event: EngineEvent): boolean {
  return event.t === "submitInput" || event.t === "submitVote" || event.t === "skipPhase";
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
