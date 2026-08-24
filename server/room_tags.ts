/**
 * プリセット部屋タグのデータ（§2 公開ルーム一覧）
 *
 * 卓の雰囲気を一覧で伝えるためのタグ。server/hobby_tags.ts（趣味タグ）と同じ設計で、
 * 自由入力は受け付けずプリセットの中からのみ選ぶ（不適切文言の混入を構造的に防ぐ）。
 * 表示名はサーバー由来のみとし、クライアントには ID→表示名の対応表として渡す。
 */

/** プリセットタグの識別子 */
export type RoomTagId =
  | "beginner_friendly"
  | "casual_chat"
  | "heavy_drinking"
  | "light_drinking"
  | "video_required"
  | "video_optional"
  | "voice_only"
  | "gaming"
  | "work_together"
  | "quiet_ok"
  | "first_time_ok"
  | "night_owl";

/** タグ1件（IDと表示名） */
export type RoomTag = { id: RoomTagId; label: string };

/** プリセットタグ一覧 */
export const ROOM_TAGS: readonly RoomTag[] = [
  { id: "beginner_friendly", label: "初心者歓迎" },
  { id: "casual_chat", label: "ゆるく雑談" },
  { id: "heavy_drinking", label: "がっつり飲む" },
  { id: "light_drinking", label: "軽く一杯" },
  { id: "video_required", label: "顔出し必須" },
  { id: "video_optional", label: "顔出し任意" },
  { id: "voice_only", label: "音声のみ" },
  { id: "gaming", label: "ゲームしながら" },
  { id: "work_together", label: "作業しながら" },
  { id: "quiet_ok", label: "無言OK" },
  { id: "first_time_ok", label: "初参加歓迎" },
  { id: "night_owl", label: "深夜まで" },
];

const ROOM_TAG_IDS: ReadonlySet<string> = new Set(ROOM_TAGS.map((t) => t.id));

/** 値がプリセットのタグIDかどうかを判定する（自由入力を弾く） */
export function isValidRoomTagId(value: unknown): value is RoomTagId {
  return typeof value === "string" && ROOM_TAG_IDS.has(value);
}
