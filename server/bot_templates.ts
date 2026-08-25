/**
 * bot の定型文データ
 * 詳細仕様書 §3.10「話題カード・定型文はサーバー内のデータファイルで管理し、
 * 運営（チーム）だけが追加できる」に対応する。ひろし担当。
 *
 * ユーザー投稿は一切受け付けない。bot の発話はすべてこのファイルの文面から選ぶ。
 * 外部 AI API は使わない（§3.10）。
 *
 * bot の表示名はここだけを直せば変えられる。せり・ぐっちー・なべは仮称。
 */

import type { HobbyTagId } from "./hobby_tags.ts";
import type { BotId } from "./types.ts";

// ---------------------------------------------------------------------------
// bot の定義
// ---------------------------------------------------------------------------

/** bot の識別子。正本は types.ts（§4.3）。ここは再輸出するだけ */
export type { BotId };

/** bot 1体の定義 */
export type BotProfile = {
  /** 識別子。S2C の from に入る */
  id: BotId;
  /** チャットに出す表示名 */
  name: string;
  /** 役割の説明（UI のツールチップや ON/OFF トグルのラベル用） */
  role: string;
};

/**
 * ルームにいる bot 4体。参加者数にはカウントしない（§3.10）。
 *
 * ぐっちーとなべを分けているのは、以前ぐっちー1体が「挨拶・話題カード・相槌・
 * ゲーム提案・終了アンケート・締め」の6役を抱えていて、10分5発話の枠を
 * 役割どうしで食い合っていたため（大人数が同時入室すると4人目以降の挨拶が
 * 消えるなど）。「場を温める」役と「進行を仕切る」役に割り、枠も別々にした。
 */
export const BOTS: Readonly<Record<BotId, BotProfile>> = {
  shunpi: { id: "shunpi", name: "しゅんぴ", role: "あだ名をつける" },
  seri: { id: "seri", name: "せり", role: "川柳を見つける" },
  gucchi: { id: "gucchi", name: "ぐっちー", role: "場を温める" },
  nabe: { id: "nabe", name: "なべ", role: "進行を仕切る" },
};

/** 全 bot の識別子 */
export const BOT_IDS: readonly BotId[] = ["shunpi", "seri", "gucchi", "nabe"];

// ---------------------------------------------------------------------------
// しゅんぴ（あだ名bot）
// ---------------------------------------------------------------------------

/** 二つ名の前半。名詞と組み合わせて使う */
export const NICKNAME_ADJECTIVES: readonly string[] = [
  "ほろよい",
  "ごきげん",
  "しずかな",
  "あわあわ",
  "ねむたい",
  "はしゃぐ",
  "たそがれ",
  "まったり",
  "きまぐれ",
  "よふかし",
  "ひとりぼっちの",
  "つまみ食いする",
];

/** 二つ名の後半 */
export const NICKNAME_NOUNS: readonly string[] = [
  "ペンギン",
  "カピバラ",
  "ラッコ",
  "アザラシ",
  "フクロウ",
  "タヌキ",
  "ハムスター",
  "クラゲ",
  "コアラ",
  "アルパカ",
  "シマエナガ",
  "レッサーパンダ",
];

/** 命名を知らせる文。{name} を割り当てたあだ名に置き換える */
export const NAMING_TEXTS: readonly string[] = [
  "あだ名がなかったので「{name}」と呼びますね。気に入らなかったら言ってください",
  "名無しさんがいたので「{name}」にしました。今日はこれでいきましょう",
  "「{name}」さん、いらっしゃい。あだ名はこちらで勝手につけました",
];

// ---------------------------------------------------------------------------
// せり（川柳bot）
// ---------------------------------------------------------------------------

/** ちょうど 5-7-5 だったときの反応 */
export const SENRYU_EXACT_TEXTS: readonly string[] = [
  "いまの、きれいに五七五でしたよ",
  "一句できました",
  "ぴったり五七五。お見事です",
  "五七五、しっかり数えました",
];

/** 字余り・字足らずだったときの反応。{shape} に「字余り」などが入る */
export const SENRYU_LOOSE_TEXTS: readonly string[] = [
  "{shape}だけど、五七五っぽかったです",
  "おしい、{shape}の一句",
  "{shape}ですがいただきました",
];

/**
 * 通話の文字起こし（§3.6 の VC 由来）から拾ったときの反応。
 *
 * チャットと文面を分けている理由:
 *   - 「書いた」ではなく「言った」句なので、written 前提の言い回しが噛み合わない
 *   - 文字起こしには聞き違いが混ざる。断定を避け、拾い方に含みを持たせる
 *   - チャット欄を見ていない人にも「いま声を拾った」と分かるようにする
 */
export const SENRYU_VOICE_TEXTS: readonly string[] = [
  "いま、声で五七五が聞こえました",
  "口から一句こぼれましたね",
  "聞き耳を立てていました。いまの、五七五です",
  "しゃべりながらぴったり五七五。お見事です",
];

// ---------------------------------------------------------------------------
// ぐっちー（場を温めるbot）
//
// 担当は「挨拶・話題カード・相槌」。場の温度を上げる側で、進行の判断はしない。
// ---------------------------------------------------------------------------

/** 入室者への挨拶。{name} は入室者のあだ名 */
export const GREETING_TEXTS: readonly string[] = [
  "{name}さん、いらっしゃい。まずは一杯どうぞ",
  "{name}さん来ましたね。かんぱーい",
  "ようこそ{name}さん。今日はゆるくいきましょう",
];

/**
 * 沈黙したときに投げる話題カード。
 * tags は §3.11 の趣味タグID。参加者に共通タグがあれば対応するカードを優先する。
 * tags が空のカードは誰にでも使える汎用カード。
 */
export type TopicCard = {
  /** カードの一意ID。同じカードを繰り返さないために使う */
  id: string;
  /** 投げかける文 */
  text: string;
  /**
   * 対応する趣味タグID（§3.11）。空なら汎用。
   * 正本は hobby_tags.ts。string で受けると綴りのずれに気づけないため
   * HobbyTagId で縛る（実際 "sake" / "oshikatsu" と書き間違えていた）。
   */
  tags: readonly HobbyTagId[];
};

/** 話題カード一覧 */
export const TOPIC_CARDS: readonly TopicCard[] = [
  { id: "laugh", text: "最近いちばん笑ったことって何ですか？", tags: [] },
  { id: "drink", text: "いま何を飲んでます？", tags: ["alcohol"] },
  { id: "weekend", text: "次の休みの予定、決まってる人います？", tags: [] },
  { id: "buy", text: "最近買ってよかったもの、ありますか？", tags: [] },
  { id: "game", text: "最近遊んで良かったゲームは？", tags: ["game"] },
  { id: "anime", text: "いま追いかけてるアニメってあります？", tags: ["anime"] },
  { id: "music", text: "最近よく聴いてる曲、教えてください", tags: ["music"] },
  { id: "movie", text: "最後に観た映画は何でした？", tags: ["movie"] },
  { id: "food", text: "いまいちばん食べたいもの、何ですか？", tags: ["cooking"] },
  { id: "travel", text: "行ってみたい場所ってあります？", tags: ["travel"] },
  { id: "pet", text: "ペット飼ってる人います？", tags: ["pet"] },
  { id: "manga", text: "最近読んで面白かった漫画ありますか？", tags: ["manga"] },
  { id: "programming", text: "何かつくってる人います？", tags: ["programming"] },
  { id: "oshi", text: "推しの話、聞きたい人います？", tags: ["oshi"] },
  { id: "sport", text: "体動かしてますか？最近運動した人", tags: ["sports"] },
  { id: "work", text: "今日はどんな一日でした？", tags: [] },
];

/** ラウンド結果への相槌。{name} は首位のあだ名 */
export const ROUND_REACTION_TEXTS: readonly string[] = [
  "{name}さん強いですね",
  "いい勝負です。{name}さんを追いかけましょう",
  "{name}さんが抜けてますね",
];

/** 最終結果への相槌。{name} は優勝者のあだ名 */
export const FINAL_REACTION_TEXTS: readonly string[] = [
  "{name}さん優勝おめでとう。拍手",
  "お疲れさまでした。{name}さんの勝ちです",
];

// ---------------------------------------------------------------------------
// なべ（進行bot）
//
// 鍋奉行の「なべ」。担当は「ゲームに誘う・お開きを切り出す・締める」。
// 場を温めるぐっちーと違い、こちらは会の進行そのものを動かす発話しか持たない。
// ---------------------------------------------------------------------------

/** ゲーム提案の文。{title} に提案するゲーム名が入る */
export const GAME_SUGGEST_TEXTS: readonly string[] = [
  "「{title}」でもやってみます？ホストの人、よかったら選んでください",
  "間が空いたので「{title}」はどうでしょう",
  "「{title}」なら初対面でも盛り上がりますよ",
];

/** 終了アンケートの文 */
export const END_POLL_TEXTS: readonly string[] = [
  "そろそろお開きにしますか？続けたい人・帰りたい人、押してください",
  "静かになってきましたね。そろそろ締めます？",
];

/** 終了アンケートで過半数が賛成したときの締めの一言 */
export const CLOSING_TEXTS: readonly string[] = [
  "では今日はこのへんで。おつかれさまでした、またどうぞ",
  "お開きにしましょう。楽しい時間でした、おやすみなさい",
];

/** 終了アンケートで賛成が過半数に届かなかったときの文 */
export const CONTINUE_TEXTS: readonly string[] = [
  "まだいけますね。もう少し続けましょう",
  "続行です。おかわりどうぞ",
];

// ---------------------------------------------------------------------------
// 共通ユーティリティ
// ---------------------------------------------------------------------------

/**
 * 文中の {key} を置き換える。該当しないキーはそのまま残す。
 * Object.hasOwn で自前のキーだけを見る（`{toString}` と書かれたときに
 * プロトタイプのネイティブ関数が文字列化されてチャットに流れるのを防ぐ）。
 */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(
    /\{(\w+)\}/gu,
    (whole, key: string) => Object.hasOwn(values, key) ? values[key] : whole,
  );
}

/** 候補から1つ選ぶ。rng は 0 以上 1 未満を返すもの。空配列は呼び出し側で弾く */
export function pick<T>(items: readonly T[], rng: () => number): T {
  if (items.length === 0) throw new Error("pick: 候補が空です");
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length));
  return items[index];
}
