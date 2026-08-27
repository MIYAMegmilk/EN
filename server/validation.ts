/**
 * 汎用の文字列検証ヘルパー（§3.0 / §3.1）
 *
 * rooms.ts（ルーム/ゲーム/bot サブシステム全体を巻き込む大きなモジュール）と
 * auth.ts（アカウントAPI）の双方から使われる、依存の軽い検証ロジックだけを集める。
 * auth.ts が rooms.ts に依存する（＝より高レイヤーのモジュールに依存する）のを避けるため、
 * このファイルはどちらからも独立して読み込める最小限の外部依存に留める。
 */

import { HOBBY_TAGS_MAX, type HobbyTagId, isValidHobbyTagId } from "./hobby_tags.ts";
import { err, NICKNAME_MAX, ok, type Result } from "./types.ts";

/** 文字数はコードポイント単位で数える（サロゲートペア対策） */
export function charLength(s: string): number {
  return [...s].length;
}

/** 制御文字を含むか */
export function hasControlChar(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && (cp < 0x20 || cp === 0x7f)) return true;
  }
  return false;
}

/** ニックネームを検証して正規化する（1..20文字・制御文字禁止、§3.1） */
export function validateNickname(input: unknown): Result<string> {
  if (typeof input !== "string") {
    return err("INVALID_INPUT", "ニックネームを入力してください");
  }
  const trimmed = input.trim();
  const length = charLength(trimmed);
  if (length === 0) {
    return err("INVALID_INPUT", "ニックネームを入力してください");
  }
  if (length > NICKNAME_MAX) {
    return err("INVALID_INPUT", `ニックネームは${NICKNAME_MAX}文字以内で入力してください`);
  }
  if (hasControlChar(trimmed)) {
    return err("INVALID_INPUT", "ニックネームに使用できない文字が含まれています");
  }
  return ok(trimmed);
}

/**
 * 参加者の趣味タグを検証する（§3.11）。
 *
 * 自由入力は受け付けない。プリセットにない ID が1つでも混じっていれば丸ごと弾く
 * （黙って捨てると、選んだはずのタグが出ない理由が利用者に分からない）。
 * 重複は取り除いてから上限を見る。省略（undefined）は「タグ無し」として空配列を返す
 */
export function validateHobbyTags(input: unknown): Result<HobbyTagId[]> {
  if (input === undefined) return ok([]);
  if (!Array.isArray(input)) {
    return err("INVALID_INPUT", "趣味タグの形式が不正です");
  }
  if (!input.every(isValidHobbyTagId)) {
    return err("INVALID_INPUT", "趣味タグの指定が不正です");
  }
  const unique = [...new Set(input as HobbyTagId[])];
  if (unique.length > HOBBY_TAGS_MAX) {
    return err("INVALID_INPUT", `趣味タグは${HOBBY_TAGS_MAX}個以内で選んでください`);
  }
  return ok(unique);
}
