/**
 * prompt モジュール（設計書 docs/design/games-unified.md §2.1）
 *
 * 既存の宣言的フロー（大喜利・以心伝心・雑学クイズ・スタジオ投稿ゲーム）を
 * GameModule 介面へ載せるための薄いアダプタ。状態機械の中身は既存エンジン
 * （server/engine.ts）のままで、このファイルは
 *   - ModuleEvent → EngineEvent の写像
 *   - EngineEffect → ModuleEffect の写像
 *   - clientEvent.payload → submitInput / submitVote の写像と型検証
 * だけを行う。engine.ts 本体とその既存テストは一切変更していない。
 *
 * state はエンジンの GameState をそのまま使う。ルーム層が持つ `Room.game` に
 * 載せたままにできるので、既存クライアント・既存テストを壊さずに介面だけ差し替えられる。
 */

import {
  buildPhaseView,
  DEFAULT_PHASE_DURATIONS,
  type EngineEffect,
  type EngineEvent,
  type EngineResult,
  MIN_PLAYERS,
  reduce as engineReduce,
  startGame as engineStartGame,
} from "../engine.ts";
import { ROOM_CAPACITY } from "../types.ts";
import type { GameDefinition, GameState, PhaseDurations, PhaseView } from "../types.ts";
import {
  type GameModule,
  isRecord,
  type ModuleEffect,
  type ModuleEvent,
  type ModuleInitInput,
  moduleNoop,
  type ModuleResult,
  readKind,
} from "./module.ts";

/** カタログ上のモジュールID */
export const PROMPT_MODULE_ID = "prompt";

/**
 * prompt モジュールの init に渡す設定（ModuleInitInput.config）。
 * 宣言的データ（GameDefinition）とフェーズ秒数はルーム層が決めて渡す
 */
export type PromptConfig = {
  /** 進行させるゲーム定義 */
  definition: GameDefinition;
  /** フェーズ秒数。省略するとエンジンの既定値 */
  durations?: PhaseDurations;
};

/** config が PromptConfig の形をしているか。中身の妥当性は gamedef.ts が検証済み */
function asPromptConfig(config: unknown): PromptConfig | null {
  if (!isRecord(config)) return null;
  const definition = config.definition;
  if (!isRecord(definition)) return null;
  if (typeof definition.id !== "string") return null;
  if (!Array.isArray(definition.prompts)) return null;
  return config as PromptConfig;
}

/**
 * clientEvent.payload を EngineEvent へ写像する（§9.1: 先頭で型検証する）。
 * 受理する形は次の2つだけで、未知の k は棄却する。
 *   { k: "submitInput", value: string | number }
 *   { k: "submitVote", targetPlayerId: string }
 * 値そのものの妥当性（文字数・選択肢の範囲・自票禁止など）は既存エンジンが判定するため、
 * ここでは型だけを見て素通しする。二重に判定するとエラー文言が既存経路とずれる
 */
export function toEngineEvent(
  playerId: string,
  payload: unknown,
  now: number,
): EngineEvent | null {
  switch (readKind(payload)) {
    case "submitInput": {
      if (!isRecord(payload)) return null;
      const value = payload.value;
      if (typeof value !== "string" && typeof value !== "number") return null;
      return { t: "submitInput", playerId, value, now };
    }
    case "submitVote": {
      if (!isRecord(payload)) return null;
      const targetPlayerId = payload.targetPlayerId;
      if (typeof targetPlayerId !== "string") return null;
      return { t: "submitVote", voterId: playerId, targetPlayerId, now };
    }
    default:
      return null;
  }
}

/** ModuleEvent のうち clientEvent 以外を EngineEvent へ写像する。語彙は1対1で対応する */
function toEngineLifecycleEvent(
  event: Exclude<ModuleEvent, { t: "clientEvent" } | { t: "chatMessage" }>,
): EngineEvent {
  switch (event.t) {
    case "timeout":
      return { t: "timeout", now: event.now };
    case "playerJoined":
      return {
        t: "playerJoined",
        playerId: event.playerId,
        nickname: event.nickname,
        now: event.now,
      };
    case "playerLeft":
      return { t: "playerLeft", playerId: event.playerId, now: event.now };
    case "playerRejoined":
      return { t: "playerRejoined", playerId: event.playerId, now: event.now };
    case "playerKicked":
      return { t: "playerKicked", playerId: event.playerId, now: event.now };
    case "skipPhase":
      return { t: "skipPhase", now: event.now };
    case "endGame":
      return { t: "endGame", now: event.now };
  }
}

/**
 * EngineResult を ModuleResult へ写像する。
 *
 * 効果の対応:
 *   phaseChanged → viewChanged（期限は末尾の schedule 効果でまとめて伝える）
 *   roundResult  → roundResult（prompt 互換の効果。既存 S2C をそのまま配る）
 *   finalResult  → score + finalResult（Player.score への加算を score 効果へ切り出した。
 *                  加算を先に置くのは、既存実装での bot 通知の順序を変えないため）
 *   ended        → ended
 * 変化があったときは最後に schedule を1つ足し、次に timeout を起こす時刻
 * （＝新しい state の deadline）をルーム層へ伝える（§2.4）
 */
function toModuleResult(result: EngineResult): ModuleResult<GameState> {
  if (result.error !== undefined) {
    return {
      state: result.state,
      changed: false,
      error: result.error,
      message: result.message,
      effects: [],
    };
  }
  const effects: ModuleEffect[] = [];
  for (const effect of result.effects) {
    effects.push(...toModuleEffects(effect));
  }
  if (result.changed) effects.push({ t: "schedule", at: result.state.deadline });
  return { state: result.state, changed: result.changed, effects };
}

/** EngineEffect 1件を ModuleEffect へ写像する */
function toModuleEffects(effect: EngineEffect): ModuleEffect[] {
  switch (effect.t) {
    case "phaseChanged":
      return [{ t: "viewChanged" }];
    case "roundResult":
      return [{ t: "roundResult", scores: effect.scores }];
    case "finalResult":
      return [
        { t: "score", totals: effect.scores },
        { t: "finalResult", scores: effect.scores },
      ];
    case "ended":
      return [{ t: "ended", reason: effect.reason }];
  }
}

/** 宣言的フロー（GameDefinition）を進行させるモジュール */
export const promptModule: GameModule<GameState, PhaseView> = {
  id: PROMPT_MODULE_ID,
  kind: "prompt",
  meta: {
    // ここのメタは「モジュール自体」の説明。一覧に出るタイトル・説明は
    // ゲーム定義（Room.availableGames → GameSummary）側の値を使う
    title: "宣言的ゲーム",
    description: "お題に答えて投票・一致・正解で採点する、データで記述されたゲーム",
    minPlayers: MIN_PLAYERS,
    maxPlayers: ROOM_CAPACITY,
  },

  init(input: ModuleInitInput): ModuleResult<GameState> {
    const config = asPromptConfig(input.config);
    if (config === null) {
      // ルーム層の呼び出し誤り。ここに来るのは実装バグなので、状態は作らない
      return {
        state: emptyState(input.now),
        changed: false,
        error: "INVALID_INPUT",
        message: "ゲーム定義が渡されていません",
        effects: [],
      };
    }
    const result = engineStartGame(
      config.definition,
      input.players,
      input.now,
      config.durations ?? DEFAULT_PHASE_DURATIONS,
    );
    return toModuleResult(result);
  },

  reduce(state: GameState, event: ModuleEvent): ModuleResult<GameState> {
    if (event.t === "clientEvent") {
      const engineEvent = toEngineEvent(event.playerId, event.payload, event.now);
      if (engineEvent === null) {
        return {
          state,
          changed: false,
          error: "INVALID_INPUT",
          message: "ゲーム内イベントの形式が正しくありません",
          effects: [],
        };
      }
      return toModuleResult(engineReduce(state, engineEvent));
    }
    // 宣言的フローのゲームはチャットを使わない（回答は submitInput / submitVote）
    if (event.t === "chatMessage") return moduleNoop(state);
    return toModuleResult(engineReduce(state, toEngineLifecycleEvent(event)));
  },

  view(state: GameState, viewerId: string): PhaseView {
    return buildPhaseView(state, viewerId);
  },
};

/**
 * init が失敗したときに返す空の状態。
 * ModuleResult は state を必ず1つ返す約束なので、呼び出し側が触らない前提の
 * 空ゲームを置く（error が入っている結果の state をルーム層は保存しない）
 */
function emptyState(now: number): GameState {
  const definition: GameDefinition = {
    id: "",
    ownerId: "",
    title: "",
    rounds: 1,
    inputType: "text",
    inputTimeSec: 60,
    reveal: "anonymous",
    scoring: "vote",
    prompts: [],
  };
  return {
    definition,
    phase: "lobby",
    round: 0,
    promptIndex: 0,
    deadline: null,
    durations: DEFAULT_PHASE_DURATIONS,
    participants: {},
    order: [],
    submissions: {},
    votes: {},
    roundScores: {},
    totalScores: {},
    lastScores: [],
    startedAt: now,
  };
}
