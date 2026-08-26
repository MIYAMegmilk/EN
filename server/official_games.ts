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
    { kind: "open", text: "感じの悪い店員が絶対にやりそうなこととは？" },
    { kind: "open", text: "占い師が急に歯切れ悪くなった一言とは？" },
    { kind: "open", text: "過去に戻れるタイムマシンなのに、誰も驚いてくれない理由は？" },
    { kind: "open", text: "「それ、言っちゃう!?」な結婚式のスピーチとは？" },
    { kind: "open", text: "コンビニ店員が本当は言いたい一言は？" },
    { kind: "open", text: "サンタクロースがこっそりズルしていることとは？" },
    { kind: "open", text: "入った瞬間ちょっと後悔する温泉の特徴とは？" },
    { kind: "open", text: "新人研修でいきなり心が折れた出来事とは？" },
    { kind: "open", text: "「二度と行かない」と誓ったお店の特徴は？" },
    { kind: "open", text: "ロボットが反抗期に言いそうなセリフは？" },
    { kind: "open", text: "面接官が本当に見ているポイントとは？" },
    { kind: "open", text: "「もうやめよう」と言われた飲み会の余興とは？" },
    { kind: "open", text: "宝くじに当たった人がやった、しょぼすぎる贅沢とは？" },
    { kind: "open", text: "ホテルの部屋にあったら気まずい張り紙とは？" },
    { kind: "open", text: "目が覚めたら知らない国にいた。まずやることは？" },
    { kind: "open", text: "「安いのには理由がある」お土産とは？" },
    { kind: "open", text: "探偵が現場で見つけた、どうでもいい手がかりとは？" },
    { kind: "open", text: "幽体離脱してわかった、自分の意外なクセとは？" },
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
    { kind: "open", text: "白い食べものといえば？" },
    { kind: "open", text: "黄色い果物といえば？" },
    { kind: "open", text: "お寿司ネタで一番人気なのは？" },
    { kind: "open", text: "雨の日にいちばん欲しいものは？" },
    { kind: "open", text: "朝ごはんの定番といえば？" },
    { kind: "open", text: "お花見に持っていく食べものといえば？" },
    { kind: "open", text: "水族館で一番人気の生き物といえば？" },
    { kind: "open", text: "遠足のおやつの定番といえば？" },
    { kind: "open", text: "温泉に行ったら食べたいものは？" },
    { kind: "open", text: "誕生日にもらって嬉しい定番プレゼントは？" },
    { kind: "open", text: "給食で人気だったメニューといえば？" },
    { kind: "open", text: "コンビニスイーツの定番といえば？" },
    { kind: "open", text: "焼肉で最初に頼む肉といえば？" },
    { kind: "open", text: "お正月に食べるものといえば？" },
    { kind: "open", text: "海に行ったら食べたいものといえば？" },
    { kind: "open", text: "冷蔵庫に必ず入っているものといえば？" },
    { kind: "open", text: "修学旅行の思い出の定番といえば？" },
    { kind: "open", text: "カラオケで盛り上がる曲のジャンルといえば？" },
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
    {
      kind: "choice",
      text: "健康な成人の骨の数はいくつ？",
      options: ["106本", "206本", "306本", "406本"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "ヒトの心臓にある部屋（心房・心室）の数は？",
      options: ["2つ", "3つ", "4つ", "5つ"],
      answer: 2,
    },
    {
      kind: "choice",
      text: "光の速さは秒速およそ何km？",
      options: ["3万km", "30万km", "300万km", "3000万km"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "うるう年をのぞく1年は何日？",
      options: ["360日", "364日", "365日", "366日"],
      answer: 2,
    },
    {
      kind: "choice",
      text: "DNAの構造の形は？",
      options: ["一重らせん", "二重らせん", "三重らせん", "正六角形"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "富士山の標高は約何m？",
      options: ["2776m", "3776m", "4776m", "5776m"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "日本でいちばん長い川は？",
      options: ["利根川", "信濃川", "石狩川", "北上川"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "成長したニワトリの歯は？",
      options: ["生えている", "生えていない", "ヒナの時だけ生えている", "上あごだけ生えている"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "サメの骨格は何でできている？",
      options: ["硬骨", "軟骨", "甲羅と同じ殻", "外骨格"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "ラクダのこぶに入っているものは？",
      options: ["水", "脂肪", "筋肉", "空気"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "世界でいちばん面積が大きい国は？",
      options: ["ロシア", "カナダ", "中国", "アメリカ"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "太陽系でいちばん大きい惑星は？",
      options: ["土星", "木星", "天王星", "海王星"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "太陽に一番近い惑星は？",
      options: ["金星", "水星", "地球", "火星"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "人体でいちばん大きい臓器は？",
      options: ["肝臓", "皮膚", "肺", "腸"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "コアラの主食は？",
      options: ["笹の葉", "ユーカリの葉", "どんぐり", "バナナの葉"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "1週間は何日？",
      options: ["5日", "6日", "7日", "8日"],
      answer: 2,
    },
    {
      kind: "choice",
      text: "いちばん小さい素数はどれ？",
      options: ["0", "1", "2", "3"],
      answer: 2,
    },
    {
      kind: "choice",
      text: "「生ビール」の定義に当てはまるのは？",
      options: [
        "熱処理をしていないビール",
        "アルコール度数が低いビール",
        "樽に入ったビール",
        "できたてを店で飲むビール",
      ],
      answer: 0,
    },
  ],
};

/** 格付けクイズ: 2択で「本物・正式なのはどっち」を当てる目利きクイズ */
export const KAKUZUKE: GameDefinition = {
  id: "official-kakuzuke",
  ownerId: OFFICIAL_OWNER_ID,
  title: "格付けクイズ",
  description: "2つのうち、正式・本物と呼べるのはどっち？ 目利き力を試す2択クイズです。",
  rounds: 5,
  inputType: "choice",
  inputTimeSec: 20,
  reveal: "anonymous",
  scoring: "correct",
  prompts: [
    {
      kind: "choice",
      text: "法律上「シャンパン」と名乗れるのはどっち？",
      options: [
        "フランス・シャンパーニュ地方産のスパークリングワイン",
        "イタリア産のスパークリングワイン",
      ],
      answer: 0,
    },
    {
      kind: "choice",
      text: "金の純度（含有率）が高いのはどっち？",
      options: ["24金", "18金"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "硬度が高いのはどっち？",
      options: ["ダイヤモンド", "ガラス"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "動物の皮からできているのはどっち？",
      options: ["本革", "合成皮革"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "地中から湧き出た温泉水をそのまま使うのはどっち？",
      options: ["天然温泉", "循環風呂（人工温泉）"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "アルコール分を含むのはどっち？",
      options: ["本みりん", "みりん風調味料"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "お餅の原料になるのはどっち？",
      options: ["うるち米", "もち米"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "蚕の繭からとれるのはどっち？",
      options: ["シルク（絹）", "ポリエステル"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "血統書が発行されるのはどっち？",
      options: ["純血種の犬", "雑種の犬"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "ゴムの木の樹液から作られるのはどっち？",
      options: ["天然ゴム", "合成ゴム"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "天然の樹液を精製して作るのはどっち？",
      options: ["うるし塗りの器", "プラスチック製の器"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "職人が1枚ずつ手作業ですくって作るのはどっち？",
      options: ["手漉き和紙", "機械漉きの紙"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "ウミガメ（タイマイ）の甲羅からできているのはどっち？",
      options: ["本鼈甲（べっ甲）", "プラスチック製の模造品"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "生き物（サンゴ虫）からできているのはどっち？",
      options: ["天然のサンゴ", "ガラス製のイミテーション"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "繊維がより細いのはどっち？",
      options: ["カシミヤ", "ウール"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "地中で数十億年かけて自然にできるのはどっち？",
      options: ["天然ダイヤモンド", "人工（合成）ダイヤモンド"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "果汁の含有量が多いのはどっち？",
      options: ["果汁100%のジュース", "果汁10%の飲料"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "貝の中で作られるのはどっち？",
      options: ["天然真珠", "模造真珠（イミテーションパール）"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "世界のコーヒー生産量が多いのはどっち？",
      options: ["アラビカ種", "ロブスタ種"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "和牛として認められる品種はどっち？",
      options: ["黒毛和牛", "ホルスタイン種"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "日本酒造りに特化して育てられた米はどっち？",
      options: ["酒米（山田錦など）", "食用のうるち米"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "生まれた時から人の管理下で育つのはどっち？",
      options: ["天然うなぎ", "養殖うなぎ"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "羊の毛からできているのはどっち？",
      options: ["純毛（ウール100%）", "アクリル"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "樹脂の化石からできているのはどっち？",
      options: ["天然の琥珀", "プラスチック製のイミテーション"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "水鳥の胸の羽毛を使っているのはどっち？",
      options: ["天然ダウンの羽毛布団", "化学繊維の布団"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "原料が米・米麹・水だけなのはどっち？",
      options: ["純米酒", "普通酒"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "化学的な精製処理をしていないのはどっち？",
      options: ["エキストラバージンオリーブオイル", "ピュアオリーブオイル"],
      answer: 0,
    },
  ],
};

/** 収録済みの公式ゲーム一覧 */
export const OFFICIAL_GAMES: GameDefinition[] = [OGIRI, ISHIN_DENSHIN, QUIZ, KAKUZUKE];

/** 公式ゲームかどうかを判定する */
export function isOfficialGame(id: string): boolean {
  return OFFICIAL_GAMES.some((g) => g.id === id);
}

/** 公式ゲームを ID で取得する */
export function getOfficialGame(id: string): GameDefinition | null {
  return OFFICIAL_GAMES.find((g) => g.id === id) ?? null;
}
