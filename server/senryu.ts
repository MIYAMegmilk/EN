/**
 * 川柳（5-7-5）検出
 * 詳細仕様書 §3.10（場回し bot）の拡張。ひろし担当。
 *
 * 責務:
 *   - 発言テキストから 5-7-5 のモーラ区切りを見つける
 *   - 各句 ±tolerance の字余り・字足らずも拾う（せりボットは tolerance=1）
 *   - 読み（ヨミ）の取得方法は YomiProvider として差し替え可能にする
 *
 * 設計上の要点:
 *   - 漢字混じり文の 5-7-5 判定には「読み」が要るため、形態素解析辞書
 *     （kuromoji）を使う。辞書はローカル同梱であり、§3.10 の
 *     「外部 AI API を使わない」制約には抵触しない。
 *   - 辞書を載せられない環境（テスト・CI）でも動くよう、かなだけの発言を
 *     判定する軽量プロバイダを用意し、検出ロジック本体は共通にする。
 *   - このファイルに副作用はない。bot.ts から純粋関数として呼ぶ。
 */

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** 川柳の各句のモーラ数 */
export const SENRYU_PATTERN: readonly [number, number, number] = [5, 7, 5];

/** せりボットが使う許容幅。各句 ±1 まで字余り・字足らずとして拾う */
export const SENRYU_TOLERANCE = 1;

/** 判定にかける発言の最大文字数。長文は解析コストが読めないので捨てる */
export const SENRYU_TEXT_MAX = 200;

/**
 * 1句の表層形の最大文字数。
 * 区切り記号は 0 モーラで通過するため、句のなかに記号を大量に詰めると
 * モーラ数は 5-7-5 のまま表層形だけ何十文字にも伸ばせてしまう。
 * 引用がそのままテロップに載るので、不自然に長い句は川柳と認めない。
 */
export const SENRYU_LINE_MAX = 30;

/**
 * 句全体で必要な「読みの異なり数」の下限。
 * 「ーーーー…」「っっっっ…」のように同じ音を並べただけの文字列は
 * ちょうど17モーラでも川柳ではないので弾く。
 */
export const SENRYU_MIN_DISTINCT = 5;

/** モーラに数えない小書きのカナ（拗音） */
const SMALL_KANA = new Set("ァィゥェォヵヶャュョヮ");

/** 句の先頭に来ると川柳として不格好になる品詞（kuromoji 使用時のみ効く） */
const WEAK_HEAD_POS = new Set(["助詞", "助動詞", "記号"]);

/**
 * 読みを持たない記号類。句の区切りとして 0 モーラで読み飛ばす。
 *
 * normalizeForSenryu が NFKC をかけたあとの字形で書く。NFKC は
 * `，→,` `．→.` `…→...` `／→/` のように半角へ寄せるので、全角だけを
 * 並べても実際には一度も一致しない。
 */
const PUNCTUATION = /^[\s、。・!?！？「」『』（）()【】〜~,./:;\-]+$/u;

// ---------------------------------------------------------------------------
// 読みの取得（差し替え可能）
// ---------------------------------------------------------------------------

/**
 * 形態素1つ分。yomi はカタカナ。読めない語は yomi を null にする。
 *
 * yomi が null のトークンには2種類あり、川柳判定での扱いが違う:
 *   - separator=true（空白・句読点・記号）… 0モーラ。句と句のあいだに来てよい
 *   - separator=false（英数字・絵文字・未知語）… そこで 5-7-5 の連鎖を切る
 */
export type YomiToken = {
  /** 表層形（もとの文字列） */
  surface: string;
  /** 読み（カタカナ）。取得できないときは null */
  yomi: string | null;
  /** 品詞大分類。取得できる場合のみ入る */
  pos?: string;
  /** 区切り記号か。true なら 0 モーラとして読み飛ばす */
  separator?: boolean;
};

/** テキストを YomiToken 列に分解するもの */
export interface YomiProvider {
  /** 実装の識別名（ログ用） */
  readonly name: string;
  /**
   * このプロバイダで許してよい字余り・字足らずの上限。
   * 省略すると呼び出し側の指定をそのまま使う。
   *
   * かなプロバイダのようにトークンが細かい実装では、許容幅を与えると
   * 任意の発言が 4-6/6-8/4-6 に割れて誤検出だらけになるため 0 に固定する。
   */
  readonly maxTolerance?: number;
  /** 分解する。対象外のテキストは空配列を返す */
  analyze(text: string): YomiToken[];
}

// ---------------------------------------------------------------------------
// モーラ計算
// ---------------------------------------------------------------------------

/** カタカナ1文字か（長音符・小書きを含む） */
function isKatakana(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x30a1 && code <= 0x30fa;
}

/** ひらがなをカタカナに寄せる。それ以外の文字はそのまま返す */
export function toKatakana(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : ch;
  }
  return out;
}

/**
 * 読みのモーラ数を数える。
 * 拗音（小書きのカナ）は前のモーラに含めて数えず、促音「ッ」・撥音「ン」・
 * 長音「ー」は1モーラとして数える。カナ以外が混ざっていたら null を返す。
 */
export function countMora(yomi: string): number | null {
  let count = 0;
  for (const ch of yomi) {
    if (SMALL_KANA.has(ch)) continue;
    if (ch === "ー" || isKatakana(ch)) {
      count++;
      continue;
    }
    return null;
  }
  return count === 0 ? null : count;
}

// ---------------------------------------------------------------------------
// 前処理
// ---------------------------------------------------------------------------

/** URL・メンション・連続空白を取り除く。判定対象外なら null */
export function normalizeForSenryu(text: string): string | null {
  if (text.length > SENRYU_TEXT_MAX) return null;
  const stripped = text
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[@＠]\S+/gu, " ")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  return stripped.length === 0 ? null : stripped;
}

// ---------------------------------------------------------------------------
// 検出本体
// ---------------------------------------------------------------------------

/** 見つかった川柳 */
export type SenryuMatch = {
  /** 上句・中句・下句の表層形 */
  lines: [string, string, string];
  /** 上句・中句・下句の読み（カタカナ） */
  yomi: [string, string, string];
  /** 各句の実モーラ数。字余り・字足らずの判定に使う */
  morae: [number, number, number];
  /** ちょうど 5-7-5 だったか。false なら字余りまたは字足らず */
  exactPattern: boolean;
  /** 発言全体がこの川柳だったか（前後に余りがない） */
  coversWhole: boolean;
};

/**
 * 候補の良さ。大きいほど良い。
 *
 * 「発言全体が句になっている」を最優先する。かなプロバイダは1モーラ1トークンで
 * どこでも切れるため、投稿者が自分で空白区切りにした句を無視して切り直し、
 * ちょうど 5-7-5 にはなるが原文の途中で切れた候補を作ってしまう。
 * 字余りでも原文どおりに引用するほうが、せりの発言として正しい。
 */
function quality(match: SenryuMatch): number {
  return (match.coversWhole ? 2 : 0) + (match.exactPattern ? 1 : 0);
}

/** quality の最大値（全体をカバーし、かつちょうど 5-7-5） */
const QUALITY_MAX = 3;

/** 内部用。トークンにモーラ数を添えたもの */
type Counted = { token: YomiToken; mora: number | null };

/** 句の終端候補 */
type Candidate = { end: number; mora: number };

/**
 * モーラ数を数えて添える。
 * 区切り記号は 0 モーラ（句をまたげる）、読めない語は null（そこで句が切れる）。
 */
function count(tokens: readonly YomiToken[]): Counted[] {
  return tokens.map((token) => {
    if (token.separator === true) return { token, mora: 0 };
    return { token, mora: token.yomi === null ? null : countMora(toKatakana(token.yomi)) };
  });
}

/**
 * from から数えて target±tolerance モーラに収まる終端候補を返す。
 * ちょうど target に近いものを先に返すので、呼び出し側は先頭から試せばよい。
 * 読めないトークンに当たったら、そこで打ち切る。
 */
function endCandidates(
  counted: readonly Counted[],
  from: number,
  target: number,
  tolerance: number,
): Candidate[] {
  const found: Candidate[] = [];
  let sum = 0;
  for (let i = from; i < counted.length; i++) {
    const mora = counted[i].mora;
    if (mora === null) break;
    sum += mora;
    if (sum > target + tolerance) break;
    if (sum < target - tolerance) continue;
    // 区切り記号は 0 モーラなので、そこで句を終えても直前と同じ候補にしかならない。
    // 記号が連続すると同一モーラの候補が量産され、3重ループが組み合わせ爆発する
    if (counted[i].token.separator === true) continue;
    // 句の終端は後続の区切り記号まで飲み込む（末尾が記号でも coversWhole になる）
    found.push({ end: skipSeparators(counted, i + 1), mora: sum });
  }
  found.sort((a, b) => Math.abs(a.mora - target) - Math.abs(b.mora - target) || a.end - b.end);
  return found;
}

/** from から続く区切り記号を読み飛ばした位置を返す */
function skipSeparators(counted: readonly Counted[], from: number): number {
  let i = from;
  while (i < counted.length && counted[i].token.separator === true) i++;
  return i;
}

/** 句の先頭として不格好か（助詞・助動詞・記号始まり） */
function hasWeakHead(counted: readonly Counted[], index: number): boolean {
  const pos = counted[index]?.token.pos;
  return pos !== undefined && WEAK_HEAD_POS.has(pos);
}

/** 表層形をつなげる。句の前後についた区切り記号は表示用に落とす */
function join(counted: readonly Counted[], from: number, to: number): string {
  let out = "";
  for (let i = from; i < to; i++) out += counted[i].token.surface;
  return trimSeparators(out);
}

/** 文字列の前後から区切り記号を取り除く */
function trimSeparators(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && PUNCTUATION.test(text[start])) start++;
  while (end > start && PUNCTUATION.test(text[end - 1])) end--;
  return text.slice(start, end);
}

/** 読みをつなげる */
function joinYomi(counted: readonly Counted[], from: number, to: number): string {
  let out = "";
  for (let i = from; i < to; i++) out += toKatakana(counted[i].token.yomi ?? "");
  return out;
}

/** findSenryu の調整項目 */
export type SenryuOptions = {
  /** 各句の許容幅。0 でちょうど 5-7-5 のみ、1 で字余り・字足らずも拾う（既定 0） */
  tolerance?: number;
  /** 発言全体がちょうど収まるときだけ拾う（既定 false = 文中から拾う） */
  wholeOnly?: boolean;
  /** 助詞・助動詞で始まる句を許す（既定 false） */
  allowWeakHead?: boolean;
};

/**
 * 指定した許容幅で 5-7-5 を探す。バックトラックで3句そろう組み合わせを見つける。
 * 許容幅があると1つの句の終端候補が複数出るため、候補を順に試す必要がある。
 *
 * 見つかった候補のうち quality() が最良のものを返す。「発言全体が句になっている」
 * ものを、途中で切れた候補より優先するため（投稿者が自分で区切った句を
 * 勝手に切り直さない）。最良（全体をカバーし、かつちょうど 5-7-5）に達したら
 * その時点で打ち切る。
 */
function searchWithTolerance(
  counted: readonly Counted[],
  tolerance: number,
  options: SenryuOptions,
): SenryuMatch | null {
  const [upper, middle, lower] = SENRYU_PATTERN;
  const strictHead = options.allowWeakHead !== true;
  // 発言の実質的な先頭。「…」のように区切り記号で始まる発言でも
  // coversWhole が成立するようにする（記号は句の一部として数えない）
  const head = skipSeparators(counted, 0);
  let best: SenryuMatch | null = null;
  for (let start = 0; start < counted.length; start++) {
    // 発言全体を覆う候補は start === 0 からしか作れない。
    // すでに quality 2 以上（= coversWhole）の候補があるなら、
    // start を進めても超えられないので打ち切る
    if (start > 0 && best !== null && quality(best) >= 2) break;
    // 記号から句を始めない（同じ句の重複候補になるだけ）
    if (counted[start].token.separator === true) continue;
    if (strictHead && hasWeakHead(counted, start)) continue;
    for (const a of endCandidates(counted, start, upper, tolerance)) {
      if (strictHead && hasWeakHead(counted, a.end)) continue;
      for (const b of endCandidates(counted, a.end, middle, tolerance)) {
        if (strictHead && hasWeakHead(counted, b.end)) continue;
        for (const c of endCandidates(counted, b.end, lower, tolerance)) {
          const coversWhole = start === head && c.end === counted.length;
          if (options.wholeOnly === true && !coversWhole) continue;
          const lines: [string, string, string] = [
            join(counted, start, a.end),
            join(counted, a.end, b.end),
            join(counted, b.end, c.end),
          ];
          // 記号を詰め込んで表層形だけ伸ばした句は川柳と認めない
          if (lines.some((line) => [...line].length > SENRYU_LINE_MAX)) continue;
          // 同じ音の繰り返しだけの文字列は句として扱わない
          const reading = joinYomi(counted, start, c.end);
          if (new Set(reading).size < SENRYU_MIN_DISTINCT) continue;
          const candidate: SenryuMatch = {
            lines,
            yomi: [
              joinYomi(counted, start, a.end),
              joinYomi(counted, a.end, b.end),
              joinYomi(counted, b.end, c.end),
            ],
            morae: [a.mora, b.mora, c.mora],
            exactPattern: a.mora === upper && b.mora === middle && c.mora === lower,
            coversWhole,
          };
          if (best === null || quality(candidate) > quality(best)) best = candidate;
          // 全体をカバーし、かつちょうど 5-7-5。これ以上の候補はない
          if (quality(candidate) === QUALITY_MAX) return candidate;
        }
      }
    }
  }
  return best;
}

/**
 * トークン列から 5-7-5 を探す。見つからなければ null。
 * ちょうど 5-7-5 を優先し、無ければ許容幅を広げてもう一度探す。
 */
export function findSenryu(
  tokens: readonly YomiToken[],
  options: SenryuOptions = {},
): SenryuMatch | null {
  const counted = count(tokens);
  const exact = searchWithTolerance(counted, 0, options);
  if (exact !== null && quality(exact) === QUALITY_MAX) return exact;
  const tolerance = options.tolerance ?? 0;
  if (tolerance <= 0) return exact;
  // 許容幅を広げると「発言全体がちょうど収まる」候補が見つかることがある。
  // ちょうど 5-7-5 でも途中で切れている候補より、そちらを優先する
  const loose = searchWithTolerance(counted, tolerance, options);
  if (exact === null) return loose;
  if (loose === null) return exact;
  return quality(loose) > quality(exact) ? loose : exact;
}

/** テキスト1件を判定する入口。前処理から検出までをまとめる */
export function detectSenryu(
  text: string,
  provider: YomiProvider,
  options: SenryuOptions = {},
): SenryuMatch | null {
  const normalized = normalizeForSenryu(text);
  if (normalized === null) return null;
  const tokens = provider.analyze(normalized);
  if (tokens.length === 0) return null;
  return findSenryu(tokens, options);
}

/**
 * 複数のプロバイダを順に試し、最初に見つかった川柳を返す。
 *
 * kuromoji は漢字混じり文に強い一方、**ひらがなだけの文では形態素解析が破綻**して
 * 大きなトークンにまとまり 5-7-5 を作れなくなる（例:「ふるいけやかわず…」→
 * 「びこむみずのおと」で8モーラ）。かなプロバイダはその逆なので、
 * [kuromoji, kana] の順で渡して互いの穴を埋める。
 */
export function detectSenryuAny(
  text: string,
  providers: readonly YomiProvider[],
  options: SenryuOptions = {},
): SenryuMatch | null {
  const normalized = normalizeForSenryu(text);
  if (normalized === null) return null;
  let best: SenryuMatch | null = null;
  for (const provider of providers) {
    // analyze はプロバイダごとに1回だけ（トークナイズが解析コストの大半）
    const tokens = provider.analyze(normalized);
    if (tokens.length === 0) continue;
    const limit = provider.maxTolerance;
    const tolerance = limit === undefined
      ? options.tolerance
      : Math.min(options.tolerance ?? 0, limit);
    const match = findSenryu(tokens, { ...options, tolerance });
    if (match !== null && (best === null || quality(match) > quality(best))) best = match;
  }
  return best;
}

// ---------------------------------------------------------------------------
// プロバイダ実装
// ---------------------------------------------------------------------------

/**
 * かなだけの発言を判定する軽量プロバイダ。辞書を持たない環境の既定。
 * 1モーラ=1トークンに割るため、句の切れ目はどこにでも来られる（判定はゆるい）。
 * 漢字・英数字が混ざる発言は判定対象外（空配列）にする。
 */
export function createKanaProvider(): YomiProvider {
  return {
    name: "kana",
    // 1モーラ1トークンなので句の切れ目がどこにでも来られる。許容幅を与えると
    // かなだけ14モーラ以上の発言がほぼすべて川柳になってしまうため 0 に固定する
    maxTolerance: 0,
    analyze(text: string): YomiToken[] {
      const tokens: YomiToken[] = [];
      let pending: string | null = null;
      const flush = () => {
        if (pending !== null) tokens.push({ surface: pending, yomi: pending });
        pending = null;
      };
      for (const ch of text) {
        if (ch !== "ー" && PUNCTUATION.test(ch)) {
          flush();
          tokens.push({ surface: ch, yomi: null, separator: true });
          continue;
        }
        const kata = toKatakana(ch);
        if (!isKatakana(kata) && kata !== "ー") return []; // かな以外が混ざる = 対象外
        if (SMALL_KANA.has(kata) && pending !== null) {
          pending += ch;
          continue;
        }
        flush();
        pending = ch;
      }
      flush();
      return tokens;
    },
  };
}

/** kuromoji が返すトークンのうち使う部分だけ */
type KuromojiTokenizer = {
  tokenize: (text: string) => Array<{ surface_form: string; reading?: string; pos: string }>;
};

/**
 * kuromoji（ローカル辞書）を使うプロバイダ。漢字混じり文を判定できる。
 *
 * 実測（Deno 2.9 / Windows）: 初期化 約390ms、常駐 約+385MB、辞書 17MB。
 * サーバープロセスを共有するため、本番投入は §6 のメモリ見積りとあわせて
 * チーム合意のうえで行う。読み込めない場合は null を返すので、
 * 呼び出し側は createKanaProvider() にフォールバックすること。
 *
 * npm 依存は deno.json に固定せず動的 import で解決する（未合意の共有設定を
 * 変更しないため）。合意後に deno.json の imports へ移す。
 */
export async function createKuromojiProvider(dicPath?: string): Promise<YomiProvider | null> {
  try {
    // 静的解析されると型定義なしで deno check が落ちるため、指定子を組み立てる
    const packageName = "kuromoji";
    const specifier = ["npm:", packageName, "@0.1.2"].join("");
    const mod = await import(specifier);
    const kuromoji = (mod.default ?? mod) as {
      builder: (opts: { dicPath: string }) => {
        build: (cb: (err: unknown, tokenizer: unknown) => void) => void;
      };
    };
    const path = dicPath ?? (await resolveKuromojiDict(packageName));
    if (path === null) return null;
    const tokenizer = await new Promise<KuromojiTokenizer>((resolve, reject) => {
      kuromoji.builder({ dicPath: path }).build((error, built) => {
        if (error) reject(error);
        else resolve(built as KuromojiTokenizer);
      });
    });
    return {
      name: "kuromoji",
      analyze(text: string): YomiToken[] {
        return tokenizer.tokenize(text).map((t) => ({
          surface: t.surface_form,
          yomi: t.reading ?? (isAllKana(t.surface_form) ? toKatakana(t.surface_form) : null),
          pos: t.pos,
          separator: t.pos === "記号" || PUNCTUATION.test(t.surface_form),
        }));
      },
    };
  } catch {
    return null;
  }
}

/** 同梱辞書のパスを解決する。見つからなければ null */
async function resolveKuromojiDict(packageName: string): Promise<string | null> {
  try {
    const nodeModule = await import("node:module");
    const require = nodeModule.createRequire(import.meta.url);
    const pkg = require.resolve(`${packageName}/package.json`);
    return pkg.replace(/package\.json$/, "dict");
  } catch {
    return null;
  }
}

/** すべてかな（＋長音）か */
function isAllKana(text: string): boolean {
  for (const ch of toKatakana(text)) {
    if (!isKatakana(ch) && ch !== "ー") return false;
  }
  return text.length > 0;
}

// ---------------------------------------------------------------------------
// 起動時の組み立て
// ---------------------------------------------------------------------------

/**
 * サーバーが使う川柳判定を作る（§3.10 せり）。
 *
 * kuromoji の辞書は読み込みに数百ミリ秒かかり、常駐メモリも大きい。一方で
 * かなプロバイダだけでは**漢字が1文字でも混ざると拾えない**（「古池や蛙飛び込む
 * 水の音」が検出できない）。音声認識の出力は漢字かな混じりで返ってくるので、
 * 文字起こし（docs/design/bot-voice.md）では kuromoji がないと実質発火しない。
 *
 * そこで「使うまで読まない、読めたら差し替える」ことにした:
 *   - 最初の判定要求で辞書の読み込みを**開始する**（プロセスで1回だけ）
 *   - 読み終わるまでは かな のみで判定する（待たせない。§3.10 の bot は同期）
 *   - 読み終わったら [kuromoji, kana] で判定する（互いの穴を埋める。detectSenryuAny 参照）
 *   - 読み込めない環境（辞書なし・npm 不通）では かな のまま動き続ける
 *
 * 一度も発言のないルームや、川柳判定を使わないテストでは辞書を読まない。
 *
 * このファイルで副作用を持つのはこの関数と createKuromojiProvider だけで、
 * 検出ロジック本体（detectSenryu / findSenryu 等）は純粋なままである。
 */
export function createSenryuDetector(options: {
  /** 読み込み結果を知らせる。ログ出力の方針を呼び出し側に委ねるため */
  onReady?: (provider: YomiProvider | null) => void;
  /** 許容幅。既定は せり の tolerance */
  tolerance?: number;
} = {}): (text: string) => SenryuMatch | null {
  const kana = createKanaProvider();
  const tolerance = options.tolerance ?? SENRYU_TOLERANCE;
  // 読み込みが終わるまでは かな のみ。終わったら差し替える
  let providers: readonly YomiProvider[] = [kana];
  let started = false;
  return (text) => {
    if (!started) {
      started = true;
      createKuromojiProvider()
        .then((kuromoji) => {
          // kuromoji を先に置く。かなだけの文では kuromoji の解析が破綻するので
          // うしろに kana を残して互いの穴を埋める（detectSenryuAny のコメント参照）
          if (kuromoji !== null) providers = [kuromoji, kana];
          options.onReady?.(kuromoji);
        })
        .catch(() => options.onReady?.(null));
    }
    return detectSenryuAny(text, providers, { tolerance });
  };
}
