/**
 * ゲーム定義のバリデーションと Deno KV への永続化
 * 詳細仕様書 §3.5 / §3.8 に対応する。
 *
 * KV キー（§3.5）:
 *   ["game", id]              → GameDefinition 本体
 *   ["gameShare", shareCode]  → gameId（共有コード→id のマップ）
 *   ["userGames", userId]     → gameId[]（所有一覧。50件上限の判定に使う）
 *
 * KV インスタンスは引数で受け取る。テストは Deno.openKv(":memory:") を渡す。
 */

import {
  err,
  GAME_DEFINITION_BYTES_MAX,
  type GameDefinition,
  type GameDefinitionDraft,
  GAMES_PER_USER_MAX,
  type GameSummary,
  type InputType,
  ok,
  type Prompt,
  type Result,
  type RevealMode,
  type ScoringMode,
  SHARE_CODE_LENGTH,
} from "./types.ts";

// ---------------------------------------------------------------------------
// バリデーション定数
// ---------------------------------------------------------------------------

/** タイトルの最大文字数（§3.5） */
export const TITLE_MAX = 20;
/** 説明の最大文字数（§3.5） */
export const DESCRIPTION_MAX = 100;
/** ラウンド数の範囲（§3.5） */
export const ROUNDS_MIN = 1;
export const ROUNDS_MAX = 10;
/** 入力時間の範囲（秒、§3.5） */
export const INPUT_TIME_MIN = 10;
export const INPUT_TIME_MAX = 180;
/** 出題件数の範囲（§3.5） */
export const PROMPTS_MIN = 1;
export const PROMPTS_MAX = 50;
/** お題本文の最大文字数（仕様書に明記が無いためコア実装で確定） */
export const PROMPT_TEXT_MAX = 120;
/** 選択肢1件の最大文字数（同上） */
export const OPTION_TEXT_MAX = 40;
/** 選択肢の件数範囲（同上） */
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 6;

/** 共有コードに使う文字。見間違えやすい I/O/0/1 を除いた英数 */
const SHARE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 採点方式ごとに許可される入力方式（§3.4） */
const ALLOWED_INPUT_BY_SCORING: Record<ScoringMode, InputType[]> = {
  vote: ["text"],
  match: ["text"],
  correct: ["choice"],
};

const INPUT_TYPES: InputType[] = ["text", "choice"];
const REVEAL_MODES: RevealMode[] = ["anonymous", "named"];
const SCORING_MODES: ScoringMode[] = ["vote", "match", "correct"];

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------

/** 値が素のオブジェクトか */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 文字数はコードポイント単位で数える（サロゲートペア対策） */
function charLength(s: string): number {
  return [...s].length;
}

/** 制御文字を含むか。表示テキストには許可しない */
function hasControlChar(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && (cp < 0x20 || cp === 0x7f)) return true;
  }
  return false;
}

/** 表示テキストの共通検証 */
function validateText(
  value: unknown,
  label: string,
  max: number,
  errors: string[],
  required: boolean,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) errors.push(`${label}は必須です`);
    return undefined;
  }
  if (typeof value !== "string") {
    errors.push(`${label}は文字列で指定してください`);
    return undefined;
  }
  const trimmed = value.trim();
  if (required && trimmed.length === 0) {
    errors.push(`${label}は必須です`);
    return undefined;
  }
  if (charLength(trimmed) > max) {
    errors.push(`${label}は${max}文字以内で指定してください`);
    return undefined;
  }
  if (hasControlChar(trimmed)) {
    errors.push(`${label}に使用できない文字が含まれています`);
    return undefined;
  }
  return trimmed;
}

/** 整数の範囲検証 */
function validateInt(
  value: unknown,
  label: string,
  min: number,
  max: number,
  errors: string[],
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push(`${label}は整数で指定してください`);
    return undefined;
  }
  if (value < min || value > max) {
    errors.push(`${label}は${min}〜${max}の範囲で指定してください`);
    return undefined;
  }
  return value;
}

/** 出題1件の検証 */
function validatePrompt(
  raw: unknown,
  index: number,
  inputType: InputType,
  scoring: ScoringMode,
  errors: string[],
): Prompt | undefined {
  const label = `お題${index + 1}`;
  if (!isRecord(raw)) {
    errors.push(`${label}の形式が正しくありません`);
    return undefined;
  }
  const expectedKind = inputType === "text" ? "open" : "choice";
  if (raw.kind !== expectedKind) {
    errors.push(`${label}の kind は "${expectedKind}" である必要があります`);
    return undefined;
  }
  const text = validateText(raw.text, `${label}の本文`, PROMPT_TEXT_MAX, errors, true);
  if (text === undefined) return undefined;
  if (expectedKind === "open") {
    if (raw.options !== undefined || raw.answer !== undefined) {
      errors.push(`${label}には選択肢を指定できません`);
      return undefined;
    }
    return { kind: "open", text };
  }
  if (!Array.isArray(raw.options)) {
    errors.push(`${label}の選択肢は配列で指定してください`);
    return undefined;
  }
  if (raw.options.length < OPTIONS_MIN || raw.options.length > OPTIONS_MAX) {
    errors.push(`${label}の選択肢は${OPTIONS_MIN}〜${OPTIONS_MAX}件で指定してください`);
    return undefined;
  }
  const options: string[] = [];
  for (let i = 0; i < raw.options.length; i++) {
    const opt = validateText(
      raw.options[i],
      `${label}の選択肢${i + 1}`,
      OPTION_TEXT_MAX,
      errors,
      true,
    );
    if (opt === undefined) return undefined;
    options.push(opt);
  }
  if (new Set(options).size !== options.length) {
    errors.push(`${label}の選択肢が重複しています`);
    return undefined;
  }
  if (scoring === "correct") {
    const answer = validateInt(raw.answer, `${label}の正解`, 0, options.length - 1, errors);
    if (answer === undefined) return undefined;
    return { kind: "choice", text, options, answer };
  }
  if (raw.answer !== undefined) {
    errors.push(`${label}に正解を指定できるのは採点方式が correct のときだけです`);
    return undefined;
  }
  return { kind: "choice", text, options };
}

/** バリデーション結果 */
export type ValidationResult =
  | { ok: true; value: GameDefinitionDraft }
  | { ok: false; errors: string[] };

/** クライアントから受け取ったゲーム定義（id / ownerId を除く）を検証する */
export function validateGameDefinitionDraft(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["ゲーム定義の形式が正しくありません"] };
  }
  const title = validateText(input.title, "タイトル", TITLE_MAX, errors, true);
  const description = validateText(input.description, "説明", DESCRIPTION_MAX, errors, false);
  const rounds = validateInt(input.rounds, "ラウンド数", ROUNDS_MIN, ROUNDS_MAX, errors);
  const inputTimeSec = validateInt(
    input.inputTimeSec,
    "入力時間",
    INPUT_TIME_MIN,
    INPUT_TIME_MAX,
    errors,
  );
  const inputType = INPUT_TYPES.includes(input.inputType as InputType)
    ? (input.inputType as InputType)
    : undefined;
  if (inputType === undefined) errors.push("入力方式が正しくありません");
  const reveal = REVEAL_MODES.includes(input.reveal as RevealMode)
    ? (input.reveal as RevealMode)
    : undefined;
  if (reveal === undefined) errors.push("公開方式が正しくありません");
  const scoring = SCORING_MODES.includes(input.scoring as ScoringMode)
    ? (input.scoring as ScoringMode)
    : undefined;
  if (scoring === undefined) errors.push("採点方式が正しくありません");

  if (inputType !== undefined && scoring !== undefined) {
    if (!ALLOWED_INPUT_BY_SCORING[scoring].includes(inputType)) {
      errors.push(
        `採点方式 ${scoring} で使えるのは入力方式 ${
          ALLOWED_INPUT_BY_SCORING[scoring].join(" / ")
        } のみです`,
      );
    }
  }

  const prompts: Prompt[] = [];
  if (!Array.isArray(input.prompts)) {
    errors.push("お題は配列で指定してください");
  } else if (input.prompts.length < PROMPTS_MIN || input.prompts.length > PROMPTS_MAX) {
    errors.push(`お題は${PROMPTS_MIN}〜${PROMPTS_MAX}件で指定してください`);
  } else if (inputType !== undefined && scoring !== undefined) {
    for (let i = 0; i < input.prompts.length; i++) {
      const p = validatePrompt(input.prompts[i], i, inputType, scoring, errors);
      if (p !== undefined) prompts.push(p);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const value: GameDefinitionDraft = {
    title: title as string,
    rounds: rounds as number,
    inputType: inputType as InputType,
    inputTimeSec: inputTimeSec as number,
    reveal: reveal as RevealMode,
    scoring: scoring as ScoringMode,
    prompts,
  };
  if (description !== undefined && description.length > 0) value.description = description;
  return { ok: true, value };
}

/** 保存済み・公式のゲーム定義（id / ownerId 付き）を検証する */
export function validateGameDefinition(input: unknown): ValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ["ゲーム定義の形式が正しくありません"] };
  }
  const errors: string[] = [];
  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    errors.push("id が正しくありません");
  }
  if (typeof input.ownerId !== "string" || input.ownerId.trim().length === 0) {
    errors.push("ownerId が正しくありません");
  }
  const draft = validateGameDefinitionDraft(input);
  if (!draft.ok) errors.push(...draft.errors);
  if (errors.length > 0) return { ok: false, errors };
  return draft;
}

/** 直列化サイズが 64KB を超えないか（§3.8） */
export function serializedSize(def: GameDefinition): number {
  return new TextEncoder().encode(JSON.stringify(def)).length;
}

/** 一覧表示用の要約に変換する */
export function toSummary(def: GameDefinition, official = false): GameSummary {
  const summary: GameSummary = {
    id: def.id,
    title: def.title,
    rounds: def.rounds,
    inputType: def.inputType,
    scoring: def.scoring,
    promptCount: def.prompts.length,
    official,
  };
  if (def.description !== undefined) summary.description = def.description;
  return summary;
}

// ---------------------------------------------------------------------------
// KV キー
// ---------------------------------------------------------------------------

/** ゲーム定義本体のキー */
export function gameKey(id: string): Deno.KvKey {
  return ["game", id];
}

/** 共有コード → ゲームID のキー */
export function shareCodeKey(shareCode: string): Deno.KvKey {
  return ["gameShare", shareCode];
}

/** ユーザーの所有ゲーム一覧のキー */
export function userGamesKey(userId: string): Deno.KvKey {
  return ["userGames", userId];
}

// ---------------------------------------------------------------------------
// 共有コード
// ---------------------------------------------------------------------------

/** 8桁英数の共有コードを生成する（暗号論的乱数） */
export function generateShareCode(): string {
  const bytes = new Uint8Array(SHARE_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) {
    code += SHARE_CODE_ALPHABET[b % SHARE_CODE_ALPHABET.length];
  }
  return code;
}

/** 入力された共有コードを正規化する（大文字化・空白除去） */
export function normalizeShareCode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}

/** 共有コードの形式が正しいか */
export function isValidShareCode(code: string): boolean {
  if (code.length !== SHARE_CODE_LENGTH) return false;
  for (const ch of code) {
    if (!SHARE_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// KV 操作
// ---------------------------------------------------------------------------

/** ユーザーの所有ゲームID一覧を取得する */
export async function listUserGameIds(kv: Deno.Kv, userId: string): Promise<string[]> {
  const entry = await kv.get<string[]>(userGamesKey(userId));
  return entry.value ?? [];
}

/** ユーザーの所有ゲーム定義を取得する（存在しない ID は無視する） */
export async function listUserGames(kv: Deno.Kv, userId: string): Promise<GameDefinition[]> {
  const ids = await listUserGameIds(kv, userId);
  if (ids.length === 0) return [];
  const entries = await kv.getMany<GameDefinition[]>(ids.map((id) => gameKey(id)));
  const games: GameDefinition[] = [];
  for (const e of entries) {
    if (e.value !== null) games.push(e.value as GameDefinition);
  }
  return games;
}

/** ゲーム定義を1件取得する */
export async function getGame(kv: Deno.Kv, id: string): Promise<GameDefinition | null> {
  const entry = await kv.get<GameDefinition>(gameKey(id));
  return entry.value;
}

/** ゲーム定義を新規保存する（要ログイン相当。ownerId はサーバーが付与する） */
export async function createGame(
  kv: Deno.Kv,
  ownerId: string,
  draftInput: unknown,
): Promise<Result<GameDefinition>> {
  const validated = validateGameDefinitionDraft(draftInput);
  if (!validated.ok) {
    return err("INVALID_INPUT", validated.errors.join(" / "));
  }
  const def: GameDefinition = {
    id: crypto.randomUUID(),
    ownerId,
    ...validated.value,
  };
  const size = serializedSize(def);
  if (size > GAME_DEFINITION_BYTES_MAX) {
    return err("INVALID_INPUT", "ゲーム定義のサイズが上限（64KB）を超えています");
  }
  // 所有一覧の同時更新を弾くため atomic の check を使う
  for (let attempt = 0; attempt < 5; attempt++) {
    const listEntry = await kv.get<string[]>(userGamesKey(ownerId));
    const ids = listEntry.value ?? [];
    if (ids.length >= GAMES_PER_USER_MAX) {
      return err(
        "INVALID_INPUT",
        `保存できるゲームは${GAMES_PER_USER_MAX}件までです。不要な定義を削除してください`,
      );
    }
    const res = await kv.atomic()
      .check(listEntry)
      .set(gameKey(def.id), def)
      .set(userGamesKey(ownerId), [...ids, def.id])
      .commit();
    if (res.ok) return ok(def);
  }
  return err("DUPLICATE", "保存が競合しました。もう一度お試しください");
}

/** ゲーム定義を更新する（所有者のみ） */
export async function updateGame(
  kv: Deno.Kv,
  ownerId: string,
  id: string,
  draftInput: unknown,
): Promise<Result<GameDefinition>> {
  const existing = await kv.get<GameDefinition>(gameKey(id));
  if (existing.value === null) {
    return err("ROOM_NOT_FOUND", "ゲーム定義が見つかりません");
  }
  if (existing.value.ownerId !== ownerId) {
    return err("AUTH_REQUIRED", "自分が作成したゲームのみ編集できます");
  }
  const validated = validateGameDefinitionDraft(draftInput);
  if (!validated.ok) {
    return err("INVALID_INPUT", validated.errors.join(" / "));
  }
  const def: GameDefinition = { id, ownerId, ...validated.value };
  if (serializedSize(def) > GAME_DEFINITION_BYTES_MAX) {
    return err("INVALID_INPUT", "ゲーム定義のサイズが上限（64KB）を超えています");
  }
  const res = await kv.atomic().check(existing).set(gameKey(id), def).commit();
  if (!res.ok) return err("DUPLICATE", "保存が競合しました。もう一度お試しください");
  return ok(def);
}

/** ゲーム定義を削除する（所有者のみ）。共有コードも同時に破棄する */
export async function deleteGame(
  kv: Deno.Kv,
  ownerId: string,
  id: string,
): Promise<Result<true>> {
  const existing = await kv.get<GameDefinition>(gameKey(id));
  if (existing.value === null) {
    return err("ROOM_NOT_FOUND", "ゲーム定義が見つかりません");
  }
  if (existing.value.ownerId !== ownerId) {
    return err("AUTH_REQUIRED", "自分が作成したゲームのみ削除できます");
  }
  const shareCodes: string[] = [];
  const iter = kv.list<string>({ prefix: ["gameShare"] });
  for await (const e of iter) {
    if (e.value === id) shareCodes.push(String(e.key[1]));
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const listEntry = await kv.get<string[]>(userGamesKey(ownerId));
    const ids = (listEntry.value ?? []).filter((x) => x !== id);
    const op = kv.atomic().check(listEntry).delete(gameKey(id)).set(userGamesKey(ownerId), ids);
    for (const code of shareCodes) op.delete(shareCodeKey(code));
    const res = await op.commit();
    if (res.ok) return ok(true);
  }
  return err("DUPLICATE", "削除が競合しました。もう一度お試しください");
}

/** 共有コードを発行する（所有者のみ）。既に発行済みならそのコードを返す */
export async function issueShareCode(
  kv: Deno.Kv,
  ownerId: string,
  gameId: string,
): Promise<Result<string>> {
  const existing = await kv.get<GameDefinition>(gameKey(gameId));
  if (existing.value === null) {
    return err("ROOM_NOT_FOUND", "ゲーム定義が見つかりません");
  }
  if (existing.value.ownerId !== ownerId) {
    return err("AUTH_REQUIRED", "自分が作成したゲームのみ共有できます");
  }
  const iter = kv.list<string>({ prefix: ["gameShare"] });
  for await (const e of iter) {
    if (e.value === gameId) return ok(String(e.key[1]));
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateShareCode();
    const slot = await kv.get<string>(shareCodeKey(code));
    if (slot.value !== null) continue;
    const res = await kv.atomic().check(slot).set(shareCodeKey(code), gameId).commit();
    if (res.ok) return ok(code);
  }
  return err("DUPLICATE", "共有コードの発行に失敗しました。もう一度お試しください");
}

/** 共有コードからゲーム定義を取得する（ゲスト可） */
export async function resolveShareCode(
  kv: Deno.Kv,
  rawCode: string,
): Promise<Result<GameDefinition>> {
  const code = normalizeShareCode(rawCode);
  if (!isValidShareCode(code)) {
    return err("INVALID_INPUT", "共有コードの形式が正しくありません");
  }
  const mapped = await kv.get<string>(shareCodeKey(code));
  if (mapped.value === null) {
    return err("ROOM_NOT_FOUND", "共有コードに対応するゲームが見つかりません");
  }
  const def = await getGame(kv, mapped.value);
  if (def === null) {
    return err("ROOM_NOT_FOUND", "共有コードに対応するゲームが見つかりません");
  }
  return ok(def);
}
