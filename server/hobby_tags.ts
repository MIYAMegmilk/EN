/**
 * プリセット趣味タグのデータ（§3.11）
 *
 * VRChat のタグのように「人となりが少し見える」ための興味関心タグ。
 * 自由入力は受け付けず、運営が用意したプリセット一覧から選ぶ（不適切文言の混入を
 * 構造的に防ぐ）。追加はチームがこのファイルを更新する。
 *
 * タグの表示名はサーバー由来のみとし、クライアントには ID→表示名の対応表として渡す
 * （§3.11「表示テキストはサーバー由来のみ＝XSS面の入力経路にしない」）。
 */

/** プリセットタグの識別子 */
export type HobbyTagId =
  | "game"
  | "anime"
  | "manga"
  | "music"
  | "movie"
  | "sports"
  | "cooking"
  | "travel"
  | "alcohol"
  | "oshi"
  | "programming"
  | "pet"
  | "reading"
  | "camping"
  | "fashion"
  | "photo"
  | "fitness"
  | "cafe"
  | "boardgame"
  | "gardening";

/** タグ1件（IDと表示名） */
export type HobbyTag = { id: HobbyTagId; label: string };

/** プリセットタグ一覧（初期20種、§3.11） */
export const HOBBY_TAGS: readonly HobbyTag[] = [
  { id: "game", label: "ゲーム" },
  { id: "anime", label: "アニメ" },
  { id: "manga", label: "漫画" },
  { id: "music", label: "音楽" },
  { id: "movie", label: "映画" },
  { id: "sports", label: "スポーツ" },
  { id: "cooking", label: "料理" },
  { id: "travel", label: "旅行" },
  { id: "alcohol", label: "お酒" },
  { id: "oshi", label: "推し活" },
  { id: "programming", label: "プログラミング" },
  { id: "pet", label: "ペット" },
  { id: "reading", label: "読書" },
  { id: "camping", label: "キャンプ" },
  { id: "fashion", label: "ファッション" },
  { id: "photo", label: "写真" },
  { id: "fitness", label: "筋トレ" },
  { id: "cafe", label: "カフェ巡り" },
  { id: "boardgame", label: "ボードゲーム" },
  { id: "gardening", label: "ガーデニング" },
];

/**
 * 1人が選べるタグの上限（§3.11「入室・マッチ待機時に最大5個選択」）。
 *
 * プロフィール保存（auth.ts）と卓への持ち込み（rooms.ts）で同じ上限を使う。
 * 片方だけ緩いと「保存はできたのに卓に入れない」が起きるので、正本はここ1か所にする
 */
export const HOBBY_TAGS_MAX = 5;

const HOBBY_TAG_IDS: ReadonlySet<string> = new Set(HOBBY_TAGS.map((t) => t.id));

/** 値がプリセットのタグIDかどうかを判定する（自由入力を弾く） */
export function isValidHobbyTagId(value: unknown): value is HobbyTagId {
  return typeof value === "string" && HOBBY_TAG_IDS.has(value);
}

const HOBBY_TAG_LABELS: ReadonlyMap<HobbyTagId, string> = new Map(
  HOBBY_TAGS.map((t) => [t.id, t.label]),
);

/**
 * タグIDを表示名に直す（例: "reading" → "読書"）。
 *
 * ID→表示名の対応はここが正本（§3.11「表示テキストはサーバー由来のみ」）。
 * bot の発話で「読書がお好きとのことなので」と言うときにも使うので、
 * bot 側に対応表を写さずにこの関数を呼ぶこと。
 */
export function hobbyTagLabel(id: HobbyTagId): string {
  return HOBBY_TAG_LABELS.get(id) ?? id;
}
