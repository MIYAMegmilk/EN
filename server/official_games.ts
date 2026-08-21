/**
 * 公式収録ゲーム（§3.4）
 * 公式も自作と同一の GameDefinition 形式で記述する。
 * エンジン側に公式ゲームの特別扱いは置かない。
 */

import type { GameDefinition } from "./types.ts";

/** 公式ゲームの ownerId。実在アカウントとは衝突しない値にする */
export const OFFICIAL_OWNER_ID = "@official";

/** 大喜利: お題に自由記述で答え、面白かった回答に投票する */
export const OGIRI: GameDefinition = {
  id: "official-ogiri",
  ownerId: OFFICIAL_OWNER_ID,
  title: "大喜利",
  description: "お題に自由に答えて、面白かった回答に投票します。自分には投票できません。",
  rounds: 3,
  inputType: "text",
  inputTimeSec: 60,
  reveal: "anonymous",
  scoring: "vote",
  prompts: [
    { kind: "open", text: "こんな居酒屋は嫌だ。どんな居酒屋？" },
    { kind: "open", text: "使い道がまったく思いつかない発明品を教えてください" },
    { kind: "open", text: "自動販売機に入っていたら驚く商品とは？" },
    { kind: "open", text: "上司がうっかり口を滑らせた一言を教えてください" },
    { kind: "open", text: "宇宙人が地球に来て最初に言ったセリフは？" },
    { kind: "open", text: "とても丁寧だけど内容がまったく伝わらない案内文とは？" },
    { kind: "open", text: "「その手があったか」と言われた冷蔵庫の使い方は？" },
    { kind: "open", text: "誰の記憶にも残らないニュース速報のテロップを作ってください" },
    { kind: "open", text: "うっかり買ってしまった通販商品のキャッチコピーは？" },
    { kind: "open", text: "犬が人間の言葉を話せたら、最初に文句を言いそうなことは？" },
  ],
};

/** 以心伝心: 同じ答えを書いた人が多いほど得点になる */
export const ISHIN_DENSHIN: GameDefinition = {
  id: "official-ishindenshin",
  ownerId: OFFICIAL_OWNER_ID,
  title: "以心伝心",
  description: "みんなと同じ答えを目指します。一致した人数が得点、全員一致でボーナス。",
  rounds: 3,
  inputType: "text",
  inputTimeSec: 45,
  reveal: "named",
  scoring: "match",
  prompts: [
    { kind: "open", text: "赤い食べものといえば？" },
    { kind: "open", text: "コンビニで最後まで残っていそうなおにぎりの具は？" },
    { kind: "open", text: "旅行に必ず持っていくものといえば？" },
    { kind: "open", text: "冬にあたたまる飲みものといえば？" },
    { kind: "open", text: "学校の授業でいちばん眠くなる科目といえば？" },
    { kind: "open", text: "動物園で最初に見に行く動物は？" },
    { kind: "open", text: "カレーに入れる野菜といえば？" },
    { kind: "open", text: "休みの日の朝いちばんにすることは？" },
    { kind: "open", text: "夏祭りの屋台で食べたいものは？" },
    { kind: "open", text: "スマホのホーム画面の1つ目に置いているアプリの種類は？" },
  ],
};

/** クイズ: 4択の雑学。正解の速さでボーナスが付く */
export const QUIZ: GameDefinition = {
  id: "official-quiz",
  ownerId: OFFICIAL_OWNER_ID,
  title: "雑学クイズ",
  description: "4択の雑学クイズ。正解すると得点、早く答えるほどボーナスが付きます。",
  rounds: 5,
  inputType: "choice",
  inputTimeSec: 20,
  reveal: "anonymous",
  scoring: "correct",
  prompts: [
    {
      kind: "choice",
      text: "日本でいちばん面積が大きい湖は？",
      options: ["琵琶湖", "霞ヶ浦", "サロマ湖", "猪苗代湖"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "世界でいちばん標高が高い山は？",
      options: ["K2", "エベレスト", "キリマンジャロ", "モンブラン"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "パンダの主食として知られる植物は？",
      options: ["ススキ", "サトウキビ", "竹（笹）", "トウモロコシ"],
      answer: 2,
    },
    {
      kind: "choice",
      text: "1年でいちばん日照時間が長くなる日を何という？",
      options: ["春分", "夏至", "秋分", "冬至"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "オリンピックが原則として開催される間隔は？",
      options: ["2年ごと", "3年ごと", "4年ごと", "5年ごと"],
      answer: 2,
    },
    {
      kind: "choice",
      text: "水が氷になる温度は摂氏で何度？",
      options: ["0度", "4度", "-10度", "10度"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "日本の都道府県の数はいくつ？",
      options: ["43", "45", "47", "49"],
      answer: 2,
    },
    {
      kind: "choice",
      text: "タコの心臓はいくつある？",
      options: ["1つ", "2つ", "3つ", "4つ"],
      answer: 2,
    },
    {
      kind: "choice",
      text: "スカイツリーの高さは？",
      options: ["333m", "555m", "634m", "808m"],
      answer: 2,
    },
    {
      kind: "choice",
      text: "コーヒー豆はもともと何の一部？",
      options: ["木の根", "果実の種", "葉っぱ", "花びら"],
      answer: 1,
    },
  ],
};

/** 収録済みの公式ゲーム一覧 */
export const OFFICIAL_GAMES: GameDefinition[] = [OGIRI, ISHIN_DENSHIN, QUIZ];

/** 公式ゲームかどうかを判定する */
export function isOfficialGame(id: string): boolean {
  return OFFICIAL_GAMES.some((g) => g.id === id);
}

/** 公式ゲームを ID で取得する */
export function getOfficialGame(id: string): GameDefinition | null {
  return OFFICIAL_GAMES.find((g) => g.id === id) ?? null;
}
