/**
 * ゲームモジュール介面（設計書 docs/design/games-unified.md §2.1）
 *
 * ゲーム1本 = このファイルの GameModule を1つ実装したもの、と規約を固定する。
 * 既存エンジン（server/engine.ts）の3関数（startGame / reduce / buildPhaseView）を
 * そのまま一般化した形であり、宣言的フロー（大喜利・以心伝心・クイズ・投稿ゲーム）は
 * prompt モジュール（server/games/prompt.ts）1実装として吸収する。
 *
 * 規約（詳細仕様書 §3.2 規約2 / 設計書 §7）:
 *   - init / reduce / view はすべて純粋関数。I/O を持たず内部で await を使わない
 *   - 入力の state は変更せず、新しい state を返す
 *   - Math.random() / Date.now() を呼ばない。乱数は init で受け取った seed から
 *     このファイルの PRNG ヘルパーで決定的に進める（§2.5）
 *   - clientEvent.payload は必ず先頭で型検証し、不正は INVALID_INPUT で棄却する（§9.1）
 */

import type { EnginePlayerInput } from "../engine.ts";
import { GAME_EVENT_PAYLOAD_MAX_BYTES } from "../types.ts";
import type { ErrorCode, ScoreEntry } from "../types.ts";

// ---------------------------------------------------------------------------
// 介面
// ---------------------------------------------------------------------------

/**
 * ゲームの表示経路。ルーム層が S2C の形を選ぶために使う。
 * prompt … 既存のフェーズ UI（S2C `phase` / `roundResult` / `finalResult`）で表示する
 * module … 専用のビューモジュールへ S2C `gameView` を配る（設計書 §3.2）
 */
export type GameModuleKind = "prompt" | "module";

/** 一覧表示用のメタ情報 */
export type GameModuleMeta = {
  /** タイトル。20文字以内（gamedef.ts の TITLE_MAX に合わせる） */
  title: string;
  /** 説明。100文字以内 */
  description: string;
  /** 開始に必要な最少人数。1..10（設計書 §10-5） */
  minPlayers: number;
  /** 参加できる最大人数。minPlayers..10 */
  maxPlayers: number;
};

/** init に渡す入力 */
export type ModuleInitInput = {
  /** 開始時点の参加者 */
  players: EnginePlayerInput[];
  /** 開始時刻（epoch ms） */
  now: number;
  /** 乱数の種。モジュールはこれ以外の乱数源を使わない（§2.5） */
  seed: number;
  /**
   * 宣言的データで駆動するモジュール（prompt）へ渡す設定。
   * 専用モジュールは使わない。型が unknown なのは、prompt 固有の型（GameDefinition）を
   * 介面へ持ち込まないため。受け取った側が先頭で型検証する
   */
  config?: unknown;
};

/** モジュールへの入力イベント。すべて外部（ルーム層）が確定させて渡す */
export type ModuleEvent =
  /** クライアントからのゲーム内イベント。payload の検証はモジュールの責務（§9.1） */
  | { t: "clientEvent"; playerId: string; payload: unknown; now: number }
  /** schedule 効果で予約した時刻に達した */
  | { t: "timeout"; now: number }
  /** 途中参加。進行中はそのゲームの観戦者として扱うのが既定（§5） */
  | { t: "playerJoined"; playerId: string; nickname: string; now: number }
  /** 切断・退室 */
  | { t: "playerLeft"; playerId: string; now: number }
  /** 再接続 */
  | { t: "playerRejoined"; playerId: string; now: number }
  /** キック。在籍からの完全除外 */
  | { t: "playerKicked"; playerId: string; now: number }
  /** ホストによるスキップ（ルーム層がホストか検証してから流す） */
  | { t: "skipPhase"; now: number }
  /** ホストによるゲーム終了 */
  | { t: "endGame"; now: number };

/** モジュールが返す副作用の指示。実際の送信・加点はルーム層が行う */
export type ModuleEffect =
  /** 全接続へ view を配り直す（受信者ごとに view() を呼ぶ） */
  | { t: "viewChanged" }
  /** 次に timeout を起こしてほしい時刻（epoch ms）。null で解除（§2.4） */
  | { t: "schedule"; at: number | null }
  /** 公式スコアへの加算（ゲーム終了時に1回）。Player.score への反映はルーム層が行う */
  | { t: "score"; totals: ScoreEntry[] }
  /** ゲームが終わった */
  | { t: "ended"; reason: "completed" | "tooFewPlayers" | "hostEnded" }
  /**
   * prompt モジュール互換の効果。既存 S2C（roundResult / finalResult）をそのまま配る。
   * kind:"prompt" 以外のモジュールは使わない。既存クライアントを壊さないための経過措置で、
   * `gameView` へ寄せるかは未決（設計書 §10-4）
   */
  | { t: "roundResult"; scores: ScoreEntry[] }
  | { t: "finalResult"; scores: ScoreEntry[] };

/** モジュール呼び出しの結果 */
export type ModuleResult<S> = {
  /** 更新後の状態。エラー時は入力と同じ状態を返す */
  state: S;
  /** 状態が変化したか */
  changed: boolean;
  /** 受理できなかった場合のエラーコード */
  error?: ErrorCode;
  /** エラーの説明 */
  message?: string;
  /** ルーム層が実行すべき副作用 */
  effects: ModuleEffect[];
};

/** ゲーム1本のサーバー側実装 */
export type GameModule<S = unknown> = {
  /** モジュールID。カタログ（server/games/index.ts）の正本 */
  id: string;
  /** 表示経路 */
  kind: GameModuleKind;
  /** 一覧表示用のメタ情報 */
  meta: GameModuleMeta;
  /** 開始して初期状態を作る */
  init(input: ModuleInitInput): ModuleResult<S>;
  /** イベントを1件処理する */
  reduce(state: S, event: ModuleEvent): ModuleResult<S>;
  /** 受信者ごとの表示データ。秘密はここで絞る（§2.6） */
  view(state: S, viewerId: string): unknown;
};

// ---------------------------------------------------------------------------
// 結果の組み立て
// ---------------------------------------------------------------------------

/** 変化ありの結果を作る */
export function moduleOk<S>(state: S, effects: ModuleEffect[] = []): ModuleResult<S> {
  return { state, changed: true, effects };
}

/** 変化なしの結果を作る */
export function moduleNoop<S>(state: S): ModuleResult<S> {
  return { state, changed: false, effects: [] };
}

/** エラー結果を作る。state は入力のまま返す */
export function moduleFail<S>(state: S, code: ErrorCode, message: string): ModuleResult<S> {
  return { state, changed: false, error: code, message, effects: [] };
}

// ---------------------------------------------------------------------------
// seed PRNG（§2.5）
// ---------------------------------------------------------------------------

/**
 * 種が 0 のときに使う代替値。xorshift は 0 を入れると 0 のまま止まるため、
 * 0 だけは黄金比由来の定数へ逃がす（値そのものに意味は無く、0 でなければよい）。
 */
const SEED_FALLBACK = 0x9e3779b9;

/**
 * xorshift32 で次の種を作る（決定的）。
 * Math.random() の代わりにこれを使い、種を state に持って進める。
 */
export function nextSeed(seed: number): number {
  let x = (seed >>> 0) === 0 ? SEED_FALLBACK : seed >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return x;
}

/** 0 以上 1 未満の擬似乱数と、次の種を返す */
export function randomFloat(seed: number): { seed: number; value: number } {
  const next = nextSeed(seed);
  return { seed: next, value: next / 0x1_0000_0000 };
}

/**
 * min 以上 max 未満の整数と、次の種を返す。
 * 範囲が空（max <= min）なら min をそのまま返す（呼び出し側の分岐を減らすため）。
 */
export function randomInt(
  seed: number,
  min: number,
  max: number,
): { seed: number; value: number } {
  const span = Math.floor(max) - Math.floor(min);
  if (span <= 0) return { seed: nextSeed(seed), value: Math.floor(min) };
  const r = randomFloat(seed);
  return { seed: r.seed, value: Math.floor(min) + Math.floor(r.value * span) };
}

/** 配列を決定的にシャッフルした新しい配列と、次の種を返す（Fisher-Yates） */
export function shuffle<T>(seed: number, items: readonly T[]): { seed: number; value: T[] } {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    const r = randomInt(s, 0, i + 1);
    s = r.seed;
    const j = r.value;
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return { seed: s, value: out };
}

// ---------------------------------------------------------------------------
// payload の型検証（§9.1）
// ---------------------------------------------------------------------------

/** payload が素のオブジェクトか（配列・null は除く） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * payload の種別（`k`）を取り出す。オブジェクトでない・k が文字列でないなら null。
 * モジュールは受理する k を列挙して突き合わせる（未知の k は棄却する）
 */
export function readKind(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const k = payload.k;
  return typeof k === "string" ? k : null;
}

/** 文字列フィールドを取り出す。型違い・空・長さ超過は null */
export function readString(
  payload: unknown,
  key: string,
  maxLength: number,
): string | null {
  if (!isRecord(payload)) return null;
  const value = payload[key];
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > maxLength) return null;
  return value;
}

/** 整数フィールドを取り出す。型違い・非整数・範囲外は null（min / max とも含む） */
export function readInt(
  payload: unknown,
  key: string,
  min: number,
  max: number,
): number | null {
  if (!isRecord(payload)) return null;
  const value = payload[key];
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

/** 真偽値フィールドを取り出す。型違いは null */
export function readBoolean(payload: unknown, key: string): boolean | null {
  if (!isRecord(payload)) return null;
  const value = payload[key];
  return typeof value === "boolean" ? value : null;
}

/**
 * gameEvent の payload が直列化サイズ上限を超えるか（設計書 §9.3）。
 * 直列化できない値（undefined・関数・symbol 等。JSON 経由で届くメッセージでは通常
 * 発生しないが、型は unknown のため防御的に扱う）は上限超過と同じ扱いにする。
 */
export function gameEventPayloadExceedsLimit(payload: unknown): boolean {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    return true;
  }
  if (typeof json !== "string") return true;
  return new TextEncoder().encode(json).length > GAME_EVENT_PAYLOAD_MAX_BYTES;
}
