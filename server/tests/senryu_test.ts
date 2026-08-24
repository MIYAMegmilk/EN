/**
 * senryu.ts のユニットテスト
 * 詳細仕様書 §9-1（bot 発話トリガー）に対応する。ひろし担当。
 *
 * kuromoji が読み込めない環境では、漢字混じり文のテストは自動でスキップする。
 */

import { assert, assertEquals } from "@std/assert";
import {
  countMora,
  createKanaProvider,
  createKuromojiProvider,
  createSenryuDetector,
  detectSenryu,
  detectSenryuAny,
  findSenryu,
  normalizeForSenryu,
  SENRYU_LINE_MAX,
  SENRYU_TOLERANCE,
  toKatakana,
  type YomiProvider,
  type YomiToken,
} from "../senryu.ts";

const kana = createKanaProvider();

/** 漢字混じり文のテスト用。読めなければ null（テストはスキップされる） */
const kuromoji: YomiProvider | null = await createKuromojiProvider();

// ---------------------------------------------------------------------------
// モーラ計算
// ---------------------------------------------------------------------------

Deno.test("countMora: 拗音は前のモーラに含めて数えない", () => {
  assertEquals(countMora("キョウ"), 2);
  assertEquals(countMora("シャシン"), 3);
  assertEquals(countMora("チョコレート"), 5);
});

Deno.test("countMora: 促音・撥音・長音は1モーラ", () => {
  assertEquals(countMora("ガッコウ"), 4);
  assertEquals(countMora("ホン"), 2);
  assertEquals(countMora("ラーメン"), 4);
});

Deno.test("countMora: カナ以外が混ざったら null", () => {
  assertEquals(countMora("ABC"), null);
  assertEquals(countMora("カナ漢字"), null);
  assertEquals(countMora(""), null);
});

Deno.test("toKatakana: ひらがなだけをカタカナへ寄せる", () => {
  assertEquals(toKatakana("ふるいけや"), "フルイケヤ");
  assertEquals(toKatakana("カタカナABC"), "カタカナABC");
});

// ---------------------------------------------------------------------------
// 前処理
// ---------------------------------------------------------------------------

Deno.test("normalizeForSenryu: URL とメンションを落とす", () => {
  assertEquals(normalizeForSenryu("これ見て https://example.com/a すごい"), "これ見て すごい");
  assertEquals(normalizeForSenryu("@taro おはよう"), "おはよう");
});

Deno.test("normalizeForSenryu: 長すぎる発言と空文字は対象外", () => {
  assertEquals(normalizeForSenryu("あ".repeat(201)), null);
  assertEquals(normalizeForSenryu("   "), null);
  assertEquals(normalizeForSenryu("https://example.com/only"), null);
});

// ---------------------------------------------------------------------------
// かなプロバイダでの検出
// ---------------------------------------------------------------------------

Deno.test("detectSenryu: かなだけのちょうど 5-7-5 を拾う", () => {
  const match = detectSenryu("ふるいけやかわずとびこむみずのおと", kana);
  assert(match !== null);
  assertEquals(match.morae, [5, 7, 5]);
  assertEquals(match.exactPattern, true);
  assertEquals(match.coversWhole, true);
  assertEquals(match.lines.join(""), "ふるいけやかわずとびこむみずのおと");
});

Deno.test("detectSenryu: 拗音を含んでも正しく数える", () => {
  // しゃしんをね(5) / きょうとにいこう(7) / あしたから(5)
  // 拗音を1モーラと誤って数えると区切り位置がずれるので、lines で検証する
  const match = detectSenryu("しゃしんをねきょうとにいこうあしたから", kana);
  assert(match !== null);
  assertEquals(match.morae, [5, 7, 5]);
  assertEquals(match.lines, ["しゃしんをね", "きょうとにいこう", "あしたから"]);
});

Deno.test("detectSenryu: 漢字が混ざるとかなプロバイダは判定しない", () => {
  assertEquals(detectSenryu("古池や蛙飛び込む水の音", kana), null);
});

Deno.test("detectSenryu: モーラが足りなければ拾わない", () => {
  assertEquals(detectSenryu("おつかれさま", kana), null);
});

// ---------------------------------------------------------------------------
// 字余り・字足らず（許容幅）
// ---------------------------------------------------------------------------

// かなプロバイダは1モーラ1トークンで区切りがどこにでも来られるため、
// 17モーラ以上のかな文はほぼ必ず 5-7-5 が成立する。許容幅の検証は
// 17モーラに届かない長さ（字足らず側）で行う。

Deno.test("findSenryu: tolerance=0 では字足らずを拾わない", () => {
  // 16モーラ。5-7-5 = 17 に1つ足りない
  assertEquals(detectSenryu("あいうえおかきくけこさしすせそた", kana), null);
});

Deno.test("findSenryu: tolerance=1 なら各句 ±1 まで拾う", () => {
  const match = detectSenryu("あいうえおかきくけこさしすせそた", kana, {
    tolerance: SENRYU_TOLERANCE,
  });
  assert(match !== null);
  assertEquals(match.exactPattern, false);
  assertEquals(match.morae.reduce((a, b) => a + b, 0), 16);
});

Deno.test("findSenryu: tolerance=1 でも各句 ±2 は拾わない", () => {
  // 13モーラ。±1 で作れる最小は 4+6+4 = 14 なので、どう区切っても不成立
  assertEquals(detectSenryu("あいうえおかきくけこさしす", kana, { tolerance: 1 }), null);
});

Deno.test("findSenryu: ちょうど 5-7-5 を字余り候補より優先する", () => {
  // ちょうど 5-7-5 で成立する文に tolerance を付けても exactPattern を返す
  const match = detectSenryu("ふるいけやかわずとびこむみずのおと", kana, { tolerance: 1 });
  assert(match !== null);
  assertEquals(match.exactPattern, true);
  assertEquals(match.morae, [5, 7, 5]);
});

Deno.test("findSenryu: wholeOnly なら発言全体が収まるときだけ拾う", () => {
  const tokens: YomiToken[] = kana.analyze("ふるいけやかわずとびこむみずのおとだよ");
  assertEquals(findSenryu(tokens, { wholeOnly: true }), null);
  const loose = findSenryu(tokens);
  assert(loose !== null);
  assertEquals(loose.coversWhole, false);
});

// ---------------------------------------------------------------------------
// 品詞フィルタ（読みを直接与えて検証）
// ---------------------------------------------------------------------------

Deno.test("findSenryu: 句が助詞で始まるものは既定で弾く", () => {
  const tokens: YomiToken[] = [
    { surface: "を", yomi: "ヲ", pos: "助詞" },
    { surface: "あいうえ", yomi: "アイウエ", pos: "名詞" },
    { surface: "かきくけこさき", yomi: "カキクケコサキ", pos: "名詞" },
    { surface: "たちつてと", yomi: "タチツテト", pos: "名詞" },
  ];
  assertEquals(findSenryu(tokens), null);
  const allowed = findSenryu(tokens, { allowWeakHead: true });
  assert(allowed !== null);
  assertEquals(allowed.morae, [5, 7, 5]);
});

Deno.test("findSenryu: 読めない語は句の切れ目になる", () => {
  const tokens: YomiToken[] = [
    { surface: "あいうえお", yomi: "アイウエオ", pos: "名詞" },
    { surface: "LGTM", yomi: null, pos: "名詞" },
    { surface: "かきくけこさし", yomi: "カキクケコサシ", pos: "名詞" },
    { surface: "たちつてと", yomi: "タチツテト", pos: "名詞" },
  ];
  assertEquals(findSenryu(tokens), null);
});

// ---------------------------------------------------------------------------
// kuromoji（漢字混じり文）
// ---------------------------------------------------------------------------

Deno.test({
  name: "kuromoji: 漢字混じりのちょうど 5-7-5 を拾う",
  ignore: kuromoji === null,
  fn: () => {
    assert(kuromoji !== null);
    const match = detectSenryu("古池や蛙飛び込む水の音", kuromoji);
    assert(match !== null);
    assertEquals(match.morae, [5, 7, 5]);
    assertEquals(match.exactPattern, true);
    assertEquals(match.lines, ["古池や", "蛙飛び込む", "水の音"]);
  },
});

Deno.test({
  name: "kuromoji: 別の有名句も拾える",
  ignore: kuromoji === null,
  fn: () => {
    assert(kuromoji !== null);
    const match = detectSenryu("柿食えば鐘が鳴るなり法隆寺", kuromoji);
    assert(match !== null);
    assertEquals(match.exactPattern, true);
    assertEquals(match.lines, ["柿食えば", "鐘が鳴るなり", "法隆寺"]);
  },
});

Deno.test({
  name: "kuromoji: 川柳になっていない短い発言は拾わない",
  ignore: kuromoji === null,
  fn: () => {
    assert(kuromoji !== null);
    assertEquals(detectSenryu("了解です", kuromoji, { tolerance: 1 }), null);
  },
});

// ---------------------------------------------------------------------------
// 回帰: レビューで見つかった不具合
// ---------------------------------------------------------------------------

Deno.test("回帰: 句と句のあいだの空白・読点があっても検出する", () => {
  const expected = ["ふるいけや", "かわずとびこむ", "みずのおと"];
  for (
    const text of [
      "ふるいけや かわずとびこむ みずのおと",
      "ふるいけや、かわずとびこむ、みずのおと",
      "ふるいけや。かわずとびこむ。みずのおと",
    ]
  ) {
    const match = detectSenryu(text, kana);
    assert(match !== null, `検出できていない: ${text}`);
    assertEquals(match.morae, [5, 7, 5]);
    assertEquals(match.lines, expected, "句末の区切り記号が残っている");
  }
});

Deno.test("回帰: 読めない語は区切り記号と違って連鎖を切る", () => {
  // 空白は 0 モーラで通過するが、英字はそこで句が切れる
  assert(detectSenryu("あいうえお かきくけこさし すせそたち", kana) !== null);
  assertEquals(detectSenryu("あいうえおLGTMかきくけこさしすせそたち", kana), null);
});

Deno.test({
  name: "回帰: kuromoji は漢字なしの句を取りこぼすので、かなへフォールバックする",
  ignore: kuromoji === null,
  fn: () => {
    assert(kuromoji !== null);
    const text = "ふるいけやかわずとびこむみずのおと";
    // kuromoji 単体では形態素解析が破綻して拾えない
    assertEquals(detectSenryu(text, kuromoji), null);
    // フォールバックを挟めば拾える
    const match = detectSenryuAny(text, [kuromoji, kana]);
    assert(match !== null);
    assertEquals(match.morae, [5, 7, 5]);
  },
});

Deno.test({
  name: "回帰: 漢字混じりの分かち書きも検出する",
  ignore: kuromoji === null,
  fn: () => {
    assert(kuromoji !== null);
    const match = detectSenryu("古池や 蛙飛び込む 水の音", kuromoji);
    assert(match !== null);
    assertEquals(match.lines, ["古池や", "蛙飛び込む", "水の音"]);
  },
});

Deno.test("回帰: 許容幅は合計ではなく句ごとに効く", () => {
  // 3-7-7（合計17だが上句が -2、下句が +2）は tolerance=1 では拾わない
  const tokens: YomiToken[] = [
    { surface: "あいう", yomi: "アイウ", pos: "名詞" },
    { surface: "かきくけこさし", yomi: "カキクケコサシ", pos: "名詞" },
    { surface: "たちつてとなに", yomi: "タチツテトナニ", pos: "名詞" },
  ];
  assertEquals(findSenryu(tokens, { tolerance: 1 }), null);
  // 4-7-6（各句 ±1 以内）なら拾う
  const ok: YomiToken[] = [
    { surface: "あいうえ", yomi: "アイウエ", pos: "名詞" },
    { surface: "かきくけこさし", yomi: "カキクケコサシ", pos: "名詞" },
    { surface: "たちつてとな", yomi: "タチツテトナ", pos: "名詞" },
  ];
  const match = findSenryu(ok, { tolerance: 1 });
  assert(match !== null);
  assertEquals(match.morae, [4, 7, 6]);
});

Deno.test({
  name: "回帰: 投稿者が区切った句を勝手に切り直さない",
  ignore: kuromoji === null,
  fn: () => {
    assert(kuromoji !== null);
    // かなプロバイダは1モーラ1トークンなのでどこでも切れてしまう。
    // ちょうど 5-7-5 になるからといって原文の途中で切った候補を選ぶと、
    // せりが「ぴったり五七五」と言いながら末尾の落ちた句を引用してしまう
    for (
      const [text, expected] of [
        ["あきのよる こんびにべんとう あたためて", [
          "あきのよる",
          "こんびにべんとう",
          "あたためて",
        ]],
        ["なつのひに つめたいびーるが うまいなあ", [
          "なつのひに",
          "つめたいびーるが",
          "うまいなあ",
        ]],
        ["あめのひは かさをわすれて ぬれてかえる", [
          "あめのひは",
          "かさをわすれて",
          "ぬれてかえる",
        ]],
      ] as const
    ) {
      const match = detectSenryuAny(text, [kuromoji, kana], { tolerance: 1 });
      assert(match !== null, `検出できていない: ${text}`);
      assertEquals(match.coversWhole, true, `発言全体を句にしていない: ${text}`);
      assertEquals(match.lines, [...expected], `原文と違う位置で切っている: ${text}`);
    }
  },
});

Deno.test("回帰: ちょうど 5-7-5 でも途中で切れた候補より、全体を覆う候補を選ぶ", () => {
  // 18モーラ。前3トークンだけなら 5-7-5 ちょうどだが、末尾1モーラが余る。
  // 末尾まで含めた 5-7-6 は字余りだが発言全体を覆う
  const tokens: YomiToken[] = [
    { surface: "あいうえお", yomi: "アイウエオ", pos: "名詞" },
    { surface: "かきくけこさし", yomi: "カキクケコサシ", pos: "名詞" },
    { surface: "たちつてと", yomi: "タチツテト", pos: "名詞" },
    { surface: "な", yomi: "ナ", pos: "名詞" },
  ];
  // 前提: ちょうど 5-7-5 の候補は存在するが、途中で切れている
  const exactOnly = findSenryu(tokens, { tolerance: 0 });
  assert(exactOnly !== null);
  assertEquals(exactOnly.exactPattern, true);
  assertEquals(exactOnly.coversWhole, false);
  // 許容幅があれば、全体を覆う 5-7-6 のほうを選ぶ
  const match = findSenryu(tokens, { tolerance: 1 });
  assert(match !== null);
  assertEquals(match.coversWhole, true, "末尾を捨てた候補を選んでいる");
  assertEquals(match.morae, [5, 7, 6]);
});

Deno.test("回帰: 記号を詰め込んで表層形だけ伸ばした句は認めない", () => {
  const padded = "あ" + "・".repeat(60) + "いうえお かきくけこさし たちつてと";
  const match = detectSenryu(padded, kana, { tolerance: 1 });
  if (match !== null) {
    for (const line of match.lines) {
      assert(
        [...line].length <= SENRYU_LINE_MAX,
        `記号だらけの句を拾っている: ${[...line].length}字`,
      );
    }
  }
});

Deno.test("回帰: かなプロバイダは許容幅を 0 に制限する", () => {
  // かなは1モーラ1トークンなので、許容幅を与えると日常の発言がほぼすべて
  // 川柳になってしまう。プロバイダ側で 0 に抑え込む
  assertEquals(kana.maxTolerance, 0);
  const loose = "あいうえおかきくけこさしすせそた"; // 16モーラ（字足らず）
  assertEquals(detectSenryuAny(loose, [kana], { tolerance: 1 }), null, "字足らずを拾っている");
  // findSenryu を直接呼べば許容幅は効く（制限はプロバイダ経由のときだけ）
  assert(findSenryu(kana.analyze(loose), { tolerance: 1 }) !== null);
});

Deno.test("回帰: ひらがなの日常発言を川柳と誤判定しない", () => {
  const daily = [
    "きょうはつかれたのでもうねますね",
    "もういっかいいってもらえますか",
    "そうなんですねしらなかったです",
    "そろそろかえろうかなとおもう",
  ];
  for (const text of daily) {
    assertEquals(detectSenryuAny(text, [kana], { tolerance: 1 }), null, `誤検出: ${text}`);
  }
  // ちょうど 5-7-5 で書かれた句は拾う
  assert(detectSenryuAny("ふるいけやかわずとびこむみずのおと", [kana], { tolerance: 1 }) !== null);
  assert(
    detectSenryuAny("ふるいけや かわずとびこむ みずのおと", [kana], { tolerance: 1 }) !== null,
  );
});

Deno.test("回帰: 記号だらけの長文でも組み合わせ爆発しない", () => {
  // 区切り記号は 0 モーラなので、候補の作り方を誤ると3重ループが爆発する。
  // 上限いっぱい（200字）の敵対的入力でも実用的な時間で返ること
  const hostile = "あ・".repeat(100);
  const started = performance.now();
  for (let i = 0; i < 20; i++) detectSenryu(hostile, kana, { tolerance: 1 });
  const perCall = (performance.now() - started) / 20;
  assert(perCall < 30, `1件あたり ${perCall.toFixed(1)}ms かかっている`);
});

Deno.test("回帰: 同じ音の繰り返しだけの文字列は川柳にしない", () => {
  for (
    const text of [
      "ーーーーーーーーーーーーーーーーー",
      "っっっっっっっっっっっっっっっっっ",
      "ん ん ん ん ん ん ん ん ん ん ん ん ん ん ん ん ん",
      "あああああ あああああああ あああああ",
    ]
  ) {
    assertEquals(detectSenryu(text, kana, { tolerance: 1 }), null, `誤検出: ${text}`);
  }
  // 音の種類が足りていれば拾う
  assert(detectSenryu("ふるいけやかわずとびこむみずのおと", kana) !== null);
});

// ---------------------------------------------------------------------------
// createSenryuDetector（サーバーが使う組み立て）
// ---------------------------------------------------------------------------

Deno.test("createSenryuDetector: 辞書を待たずに、かなの句はすぐ拾う", () => {
  const detect = createSenryuDetector();
  // 同期で答えが返ること自体が要件（bot.reduce は純粋関数で await できない）
  const match = detect("ふるいけやかわずとびこむみずのおと");
  assert(match !== null);
  assertEquals(match.lines, ["ふるいけや", "かわずとびこむ", "みずのおと"]);
});

Deno.test("createSenryuDetector: 呼ばれるまで辞書を読まない", () => {
  let ready = 0;
  createSenryuDetector({ onReady: () => ready++ });
  // 判定を1度も求めていないので読み込みは始まっていない
  assertEquals(ready, 0);
});

Deno.test({
  name: "createSenryuDetector: 辞書が読めたら漢字混じりも拾うようになる",
  // 読み込み完了を待つので、他のテストと時間を取り合わないよう単独で走らせる
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const kanji = "古池や蛙飛び込む水の音";
    let resolve: (provider: YomiProvider | null) => void;
    const ready = new Promise<YomiProvider | null>((r) => {
      resolve = r;
    });
    const detect = createSenryuDetector({ onReady: (p) => resolve(p) });

    // 1回目の呼び出しが読み込みの引き金。この時点ではまだ かな のみ
    assertEquals(detect(kanji), null, "読み込み前に漢字混じりを拾えてしまっている");

    const provider = await ready;
    if (provider === null) {
      console.log("kuromoji を読み込めないためスキップ");
      return;
    }
    const match = detect(kanji);
    assert(match !== null, "辞書を読んだのに漢字混じりを拾えていない");
    assertEquals(match.lines, ["古池や", "蛙飛び込む", "水の音"]);
    // かなの句も引き続き拾える（kuromoji はかなだけの文で解析が破綻するため）
    assert(detect("ふるいけやかわずとびこむみずのおと") !== null);
  },
});
