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
    { kind: "open", text: "実はロボットだったと発覚した上司。その決定的な証拠は？" },
    { kind: "open", text: "占い師が急に歯切れ悪くなった一言とは？" },
    { kind: "open", text: "過去に戻れるタイムマシンなのに、誰も驚いてくれない理由は？" },
    { kind: "open", text: "「それ、言っちゃう!?」な結婚式のスピーチとは？" },
    { kind: "open", text: "コンビニ店員が本当は言いたい一言は？" },
    { kind: "open", text: "サンタクロースがこっそりズルしていることとは？" },
    { kind: "open", text: "入った瞬間ちょっと後悔する温泉の特徴とは？" },
    { kind: "open", text: "「そこまでやるか」と引かれた記念日の祝い方とは？" },
    { kind: "open", text: "「二度と行かない」と誓ったお店の特徴は？" },
    { kind: "open", text: "ロボットが反抗期に言いそうなセリフは？" },
    { kind: "open", text: "透明人間になれる薬を手に入れた人が最初にした、しょうもないこととは？" },
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
    { kind: "open", text: "銭湯で風呂上がりに飲みたいものといえば？" },
    { kind: "open", text: "冷やし中華に絶対のっている定番の具といえば？" },
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
      options: ["春分", "秋分", "冬至", "夏至"],
      answer: 3,
    },
    {
      kind: "choice",
      text: "オリンピックが原則として開催される間隔は？",
      options: ["4年ごと", "2年ごと", "3年ごと", "5年ごと"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "水が氷になる温度は摂氏で何度？",
      options: ["4度", "0度", "-10度", "10度"],
      answer: 1,
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
      options: ["1つ", "2つ", "4つ", "3つ"],
      answer: 3,
    },
    {
      kind: "choice",
      text: "スカイツリーの高さは？",
      options: ["634m", "333m", "555m", "808m"],
      answer: 0,
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
      options: ["106本", "306本", "206本", "406本"],
      answer: 2,
    },
    {
      kind: "choice",
      text: "ヒトの心臓にある部屋（心房・心室）の数は？",
      options: ["2つ", "3つ", "5つ", "4つ"],
      answer: 3,
    },
    {
      kind: "choice",
      text: "光の速さは秒速およそ何km？",
      options: ["30万km", "3万km", "300万km", "3000万km"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "うるう年をのぞく1年は何日？",
      options: ["360日", "365日", "364日", "366日"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "DNAの構造の形は？",
      options: ["一重らせん", "三重らせん", "二重らせん", "正六角形"],
      answer: 2,
    },
    {
      kind: "choice",
      text: "富士山の標高は約何m？",
      options: ["2776m", "4776m", "5776m", "3776m"],
      answer: 3,
    },
    {
      kind: "choice",
      text: "日本でいちばん長い川は？",
      options: ["信濃川", "利根川", "石狩川", "北上川"],
      answer: 0,
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
      options: ["硬骨", "甲羅と同じ殻", "軟骨", "外骨格"],
      answer: 2,
    },
    {
      kind: "choice",
      text: "ラクダのこぶに入っているものは？",
      options: ["水", "筋肉", "空気", "脂肪"],
      answer: 3,
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
      options: ["金星", "地球", "水星", "火星"],
      answer: 2,
    },
    {
      kind: "choice",
      text: "人体でいちばん大きい器官は？",
      options: ["肝臓", "肺", "腸", "皮膚"],
      answer: 3,
    },
    {
      kind: "choice",
      text: "コアラの主食は？",
      options: ["ユーカリの葉", "笹の葉", "どんぐり", "バナナの葉"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "いちばん小さい素数はどれ？",
      options: ["0", "2", "1", "3"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "「生ビール」の定義に当てはまるのは？",
      options: [
        "アルコール度数が低いビール",
        "樽に入ったビール",
        "熱処理をしていないビール",
        "できたてを店で飲むビール",
      ],
      answer: 2,
    },
    {
      kind: "choice",
      text: "世界でいちばん面積が大きい海は？",
      options: ["大西洋", "インド洋", "北極海", "太平洋"],
      answer: 3,
    },
  ],
};

/** 格付けクイズ: 事実にもとづく比較で「正しいのはどっち」を当てる目利きクイズ */
export const KAKUZUKE: GameDefinition = {
  id: "official-kakuzuke",
  ownerId: OFFICIAL_OWNER_ID,
  title: "格付けクイズ",
  description: "2つのうち、事実として正しいのはどっち？ 目利き力を試す2択クイズです。",
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
      text: "原料が米・米麹・水だけなのはどっち？",
      options: ["純米酒", "普通酒"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "モース硬度が高い（傷つきにくい）のはどっち？",
      options: ["水晶", "ルビー"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "一般にアルコール度数が高いのはどっち？",
      options: ["ワイン", "日本酒"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "沸点が高いのはどっち？",
      options: ["エタノール", "水"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "融点が高いのはどっち？",
      options: ["銅", "鉄"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "同じ体積で重い（密度が高い）のはどっち？金と銀では？",
      options: ["銀", "金"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "同じ体積で重い（密度が高い）のはどっち？鉄とアルミニウムでは？",
      options: ["アルミニウム", "鉄"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "安静時の心拍数が多いのはどっち？",
      options: ["ネズミ", "ゾウ"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "精米歩合の数値が低い（より磨かれている）のはどっち？",
      options: ["本醸造酒", "大吟醸酒"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "世界のコーヒー生産量が多いのはどっち？",
      options: ["アラビカ種", "ロブスタ種"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "繊維がより細いのはどっち？",
      options: ["ウール", "カシミヤ"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "果汁の含有量が多いのはどっち？",
      options: ["果汁100%のジュース", "果汁10%の飲料"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "和牛として認められる品種はどっち？",
      options: ["ホルスタイン種", "黒毛和牛"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "水の沸点が低いのはどっち？",
      options: ["富士山の山頂", "海抜0mの平地"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "密度が高い（同じ体積で重い）のはどっち？",
      options: ["氷", "水"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "同じ量あたりのカフェインが多いのはどっち？",
      options: ["コーヒー", "緑茶"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "体温が高いのはどっち？",
      options: ["人間", "鳥類"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "体の大きさに対して腸が長いのはどっち？",
      options: ["牛", "ライオン"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "妊娠期間が長いのはどっち？",
      options: ["ネコ", "ゾウ"],
      answer: 1,
    },
    {
      kind: "choice",
      text: "1日の睡眠時間が長いのはどっち？",
      options: ["ナマケモノ", "ウマ"],
      answer: 0,
    },
    {
      kind: "choice",
      text: "日本の再販制度で定価販売が義務づけられているのはどっち？",
      options: ["中古の書籍", "新刊の書籍"],
      answer: 1,
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
