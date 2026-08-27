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
  findSenryuWithStats,
  normalizeForSenryu,
  SENRYU_LINE_MAX,
  SENRYU_SEARCH_MAX_STEPS,
  SENRYU_TEXT_MAX,
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

/**
 * 「あ・あ・…」の敵対的トークン列を作る。区切り記号の `separator` 参照を数えて、
 * 探索量（＝3重ループを回した回数）を実時間に頼らず測れるようにする。
 *
 * 以前はこの回帰テストを performance.now() で測っていたが、単体では 17〜20ms
 * なのに閾値が 30ms しかなく、フルスイートの並列実行で 40〜57ms まで伸びて
 * ランダムに落ちていた。計算量の回帰を見たいのであって、実行機の負荷を
 * 見たいわけではないので、決定論的に数えられる指標に変える。
 */
function hostileTokens(pairs: number, counter: { reads: number }): YomiToken[] {
  const tokens: YomiToken[] = [];
  for (let i = 0; i < pairs; i++) {
    tokens.push({ surface: "あ", yomi: "ア" });
    const separator: YomiToken = { surface: "・", yomi: null };
    // 探索が触るたびに数える。値そのものは常に true（区切り記号）
    Object.defineProperty(separator, "separator", {
      get: () => {
        counter.reads++;
        return true;
      },
    });
    tokens.push(separator);
  }
  return tokens;
}

/** 敵対的入力を1回探索し、区切り記号を何回見たかを返す */
function searchCost(pairs: number): number {
  const counter = { reads: 0 };
  findSenryu(hostileTokens(pairs, counter), { tolerance: 1 });
  return counter.reads;
}

Deno.test("回帰: 記号だらけの長文でも組み合わせ爆発しない", () => {
  // 区切り記号は 0 モーラなので、候補の作り方を誤ると3重ループが爆発する。
  // 入力を倍にしたとき、探索量が4倍を超えない（＝3乗のオーダーになっていない）こと。
  // 実装当時の実測は 7,552 → 16,252 回（2.15倍）。
  const single = searchCost(100);
  const double = searchCost(200);
  assert(
    double < single * 4,
    `入力を倍にしたら探索が ${(double / single).toFixed(1)} 倍になった（${single} → ${double}）`,
  );
  // 絶対量の歯止め。上限いっぱい（200字 ≒ 200トークン）の敵対的入力で、
  // 実測 7,552 回の4倍を超えたら何かが起きている
  assert(single < 30_000, `200トークンの探索に ${single} 回かかっている`);
});

Deno.test("回帰: 上限いっぱいの敵対的入力でも detectSenryu が返る", () => {
  // 200字（SENRYU_TEXT_MAX）ちょうどの記号だらけの入力。
  // 落ちず、誤検出もしないこと（時間は測らない。上の回帰テストが計算量を見ている）
  assertEquals(detectSenryu("あ・".repeat(100), kana, { tolerance: 1 }), null);
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
// 探索の上限（H-9: 1発言の判定が単一スレッドを占有できる問題）
// ---------------------------------------------------------------------------

/**
 * 「あ・あ・…」の敵対的トークン列。hostileTokens と同じ形だが、
 * separator の参照回数ではなく findSenryuWithStats の steps で測る。
 */
function hostilePairs(pairs: number): YomiToken[] {
  const tokens: YomiToken[] = [];
  for (let i = 0; i < pairs; i++) {
    tokens.push({ surface: "あ", yomi: "ア" });
    tokens.push({ surface: "・", yomi: null, separator: true });
  }
  return tokens;
}

/** かなプロバイダでトークン化して、許容幅を明示して探索する */
function searchStats(text: string, tolerance: number) {
  const normalized = normalizeForSenryu(text);
  assert(normalized !== null, `判定対象外になった: ${text}`);
  const tokens = kana.analyze(normalized);
  assert(tokens.length > 0, `トークン化できなかった: ${text}`);
  return findSenryuWithStats(tokens, { tolerance });
}

Deno.test("探索の上限: 実在の句は上限に遠く届かない（精度の番人）", () => {
  // 許容幅つきの探索は「候補の3重ループ」なので、上限を入れると精度を削りかねない。
  // 実在の句が使う検査回数は1桁〜十数回で、上限（1,000）とは2桁ぶんの開きがある。
  const cases: Array<[string, [string, string, string]]> = [
    ["ふるいけやかわずとびこむみずのおと", ["ふるいけや", "かわずとびこむ", "みずのおと"]],
    ["せみのこえいわにしみいるしずけさや", ["せみのこえ", "いわにしみいる", "しずけさや"]],
    ["あいうえおかきくけこさしすせそた", ["あいうえお", "かきくけこさし", "すせそた"]],
  ];
  for (const [text, lines] of cases) {
    const { match, stats } = searchStats(text, SENRYU_TOLERANCE);
    assert(match !== null, `拾えなくなった: ${text}`);
    assertEquals(match.lines, lines, `切り方が変わった: ${text}`);
    assertEquals(stats.truncated, false, `実在の句で打ち切られた: ${text}`);
    assert(
      stats.steps <= 50,
      `実在の句が ${stats.steps} 回も検査している（上限 ${SENRYU_SEARCH_MAX_STEPS} に近づきすぎ）`,
    );
  }
});

Deno.test("探索の上限: 境界値（上限に届かない入力は打ち切らない / 超える入力は打ち切る）", () => {
  // 40対（80トークン）… 上限内。最後まで探索しきる
  const under = findSenryuWithStats(hostilePairs(40), { tolerance: 1 });
  assertEquals(under.stats.truncated, false, "上限に届いていないのに打ち切った");
  assert(
    under.stats.steps < SENRYU_SEARCH_MAX_STEPS,
    `上限内のはずが ${under.stats.steps} 回検査している`,
  );
  // 60対（120トークン）… 上限を超える。打ち切って best-so-far を返す
  const over = findSenryuWithStats(hostilePairs(60), { tolerance: 1 });
  assertEquals(over.stats.truncated, true, "上限を超えたのに打ち切っていない");
  assertEquals(
    over.stats.steps,
    SENRYU_SEARCH_MAX_STEPS,
    "打ち切ったのに上限ちょうどで止まっていない",
  );
});

Deno.test("探索の上限: 上限いっぱいの敵対的入力でも検査回数は上限を超えない", () => {
  // SENRYU_TEXT_MAX（200字）ちょうどの、5-7-5 の切れ目を大量に含む入力を並べる。
  // どれも検査回数が上限で頭打ちになり、3重ループが伸びきらないこと。
  for (
    const text of [
      "あ・".repeat(100),
      "あ、い、う、え、お、".repeat(20),
      "あいう".repeat(66) + "あい",
      "あいうえおかきくけこさしすせそたちつてと".repeat(10),
      "あ い ".repeat(50),
    ]
  ) {
    assertEquals(text.length, SENRYU_TEXT_MAX, `入力が200字ちょうどでない: ${text.length}字`);
    const { stats } = searchStats(text, 1);
    assert(
      stats.steps <= SENRYU_SEARCH_MAX_STEPS,
      `検査回数が上限を超えた: ${stats.steps} > ${SENRYU_SEARCH_MAX_STEPS}`,
    );
  }
});

Deno.test("探索の上限: 打ち切っても、先頭にある句はこれまでどおり拾う", () => {
  // 探索は発言の先頭から進むので、句のうしろにゴミを詰めても best は先に立つ。
  // 「上限を入れたせいで句を落とす」ことが起きていないことの番人。
  const text = "ふるいけやかわずとびこむみずのおと" + "あ・".repeat(91);
  assertEquals(text.length, 199);
  const { match, stats } = searchStats(text, SENRYU_TOLERANCE);
  assertEquals(stats.truncated, true, "この入力は打ち切られる前提のテスト");
  assert(match !== null, "打ち切りのせいで句を落とした");
  assertEquals(match.lines, ["ふるいけや", "かわずとびこむ", "みずのおと"]);
});

Deno.test("探索の上限: 異常な入力でも落ちない（空・記号だけ・長さの境界）", () => {
  // 空文字・空白だけ → 前処理の時点で対象外
  for (const text of ["", "   ", "\n\n"]) {
    assertEquals(normalizeForSenryu(text), null, `対象外にならなかった: ${JSON.stringify(text)}`);
    assertEquals(detectSenryu(text, kana, { tolerance: SENRYU_TOLERANCE }), null);
  }
  // 記号だけ → トークンは全部 separator。モーラが1つも無いので拾わない
  for (const text of ["。。。。。", "・・・・・・・・・・", "!?!?!?", "、。・「」（）"]) {
    assertEquals(
      detectSenryu(text, kana, { tolerance: SENRYU_TOLERANCE }),
      null,
      `誤検出: ${text}`,
    );
  }
  // 長さの境界: 200字ちょうどは判定する / 201字は前処理で捨てる
  const at = "あ".repeat(SENRYU_TEXT_MAX);
  const over = "あ".repeat(SENRYU_TEXT_MAX + 1);
  assert(normalizeForSenryu(at) !== null, "200字ちょうどが対象外になった");
  assertEquals(normalizeForSenryu(over), null, "201字が対象になっている");
  assertEquals(detectSenryu(over, kana, { tolerance: SENRYU_TOLERANCE }), null);
  // トークンが空でも例外にならない
  assertEquals(findSenryuWithStats([], { tolerance: 1 }).match, null);
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

Deno.test("createSenryuDetector: kuromoji: false なら辞書を読まない（逃げ道。§6）", () => {
  const detect = createSenryuDetector({ kuromoji: false });
  // かなの句は従来どおり拾う
  assert(detect("ふるいけやかわずとびこむみずのおと") !== null);
  // 漢字混じりは拾わない。これが倒したときの代償
  assertEquals(detect("古池や蛙飛び込む水の音"), null, "倒してあるのに漢字混じりを拾っている");
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
    // 倒した側。同時に作って、読み込みの引き金も同じだけ引く。
    // 実時間で測るのではなく「既定の側が読み終わった」を基準に、
    // 倒した側が読み込みを始めていないことを確かめる
    let offReady = 0;
    const detectOff = createSenryuDetector({ kuromoji: false, onReady: () => offReady++ });

    // 1回目の呼び出しが読み込みの引き金。この時点ではまだ かな のみ
    assertEquals(detect(kanji), null, "読み込み前に漢字混じりを拾えてしまっている");
    assertEquals(detectOff(kanji), null);

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

    // 既定の側が読み終わったあとでも、倒した側は かな のまま
    assertEquals(offReady, 0, "倒してあるのに辞書の読み込みが始まっている");
    assertEquals(detectOff(kanji), null, "倒してあるのに漢字混じりを拾っている");
    assert(detectOff("ふるいけやかわずとびこむみずのおと") !== null);
  },
});
