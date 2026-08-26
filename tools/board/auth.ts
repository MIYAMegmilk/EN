/**
 * 作業ボード（board）の認証基盤（docs/design/board.md §7）
 *
 *   - トークンの発行（§7-1: メンバーごとの個別トークン）
 *   - SHA-256 ハッシュ化と KV への保存（§7-2: 平文は保存しない）
 *   - 定数時間比較による照合（§7-2: タイミング攻撃対策）
 *   - 認証失敗のレート制限（§7-8: 総当たり対策）
 *   - 自由文に混ざったトークン形式の文字列の検出（§7-7）
 *
 * **トークンの値を一切ログ・エラーメッセージ・API 応答に出さないこと**（§7-4）。
 * このモジュールは値を返す（呼び出し側に渡す）以外の出力を一切行わない。
 * 認証失敗時も「失敗した理由の種別」しか返さず、入力された値は保持も記録もしない。
 *
 * §3 のとおり board は EN 本体と完全に独立させるため、`server/` からは何も import しない。
 * `RateLimiter` は `server/auth.ts` の実装と同じ流儀で書いた写しである（後述）。
 */

import { encodeBase64Url } from "@std/encoding/base64url";
import { KV_PREFIX, type Member, type MemberPublic } from "./types.ts";

const ENCODER = new TextEncoder();

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/**
 * トークンの乱数部の長さ（バイト）。
 * EN 本体の `SESSION_TOKEN_BYTES`（詳細仕様書 §3.0 の「32バイト」）に合わせた。
 * 256 ビットの乱数であり、総当たりは現実的でない。
 */
export const TOKEN_BYTES = 32;

/**
 * トークンの接頭辞。
 *
 * GitHub の `ghp_` などと同じく、**トークンだと一目で分かるようにするため**に付ける。
 * これにより §7-7 の秘密検出で「ボード自身のトークンをうっかり表明の本文に貼った」場合も
 * 機械的に弾ける。接頭辞が無い 43 文字の base64url は普通の文字列と区別できない。
 * `_` 区切りで、日本語の文中や識別子に偶然現れない綴りを選んである。
 */
export const BOARD_TOKEN_PREFIX = "enboard_";

/**
 * 発行されるトークンの文字数。接頭辞 + 32バイトを base64url（パディング無し）にした 43 文字。
 * 検証・テスト用に公開する。
 */
export const TOKEN_LENGTH = BOARD_TOKEN_PREFIX.length + 43;

/**
 * 認証失敗のレート制限（§7-8「認証失敗にレート制限をかける（総当たり対策）。
 * EN 本体の `RateLimiter` と同じ流儀」）。
 * 値は EN 本体のログイン試行（詳細仕様書 §3.8: IPごとに5回/分）に揃えた。
 */
export const AUTH_FAIL_LIMIT = 5;
export const AUTH_FAIL_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// トークンの発行・ハッシュ化・照合
// ---------------------------------------------------------------------------

/**
 * 新しいトークンを発行する（§7-1 / §7-2）。
 *
 * `crypto.getRandomValues` の 32 バイト（256 ビット）を base64url にして返す。
 * base64url を使うのは、この値が `Authorization: Bearer` ヘッダー・`.env` の1行・URL の
 * いずれに置かれても安全な文字集合だからである（`+` `/` `=` を含まない）。
 *
 * **戻り値は平文のトークンで、これを保存してはならない。** 呼び出し側は発行直後に
 * 1回だけ本人へ表示し、KV には `hashToken()` の結果だけを入れる（§7-2）。
 */
export function issueToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return BOARD_TOKEN_PREFIX + encodeBase64Url(bytes);
}

/**
 * トークンを SHA-256 でハッシュ化し、base64url にして返す（§7-2）。
 *
 * パスワードと違い、トークンは 256 ビットの一様乱数なので辞書攻撃・総当たりが成立しない。
 * そのため EN 本体のパスワード（PBKDF2 60万回 + salt）のようなストレッチングは行わず、
 * 単純な SHA-256 とする。salt も置かない（同じ平文が2度発行されることが無いため）。
 *
 * 出力は常に 43 文字の固定長になる。これが定数時間比較の前提でもある。
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(token));
  return encodeBase64Url(new Uint8Array(digest));
}

/**
 * 定数時間比較の中核（§7-2 タイミング攻撃対策）。
 * 一致したかどうかに加えて、**比較したバイト数** `steps` も返す。
 *
 * 性質:
 *   - 途中で `return` / `break` しない。長さが違っても長い方の全バイトを必ず走査する
 *   - 長さの違いは `diff` に畳み込むだけで、走査を打ち切る理由にしない
 *   - したがって `steps` は「両者の長さ」だけで決まり、**中身（最初に食い違う位置）には
 *     依存しない**。これが早期 return していないことの機械的な証拠になる
 *
 * `steps` を返すのは、時間計測に頼らず**ロジックでこの性質を検証する**ためである
 * （auth_test.ts が `steps` の一致を確認している）。時間計測は GC や JIT の影響で不安定。
 */
export function timingSafeEqualSteps(a: string, b: string): { equal: boolean; steps: number } {
  const bytesA = ENCODER.encode(a);
  const bytesB = ENCODER.encode(b);
  const steps = Math.max(bytesA.length, bytesB.length);
  // 長さの差もここで畳み込む。長さが違えば diff は必ず 0 以外になる
  let diff = bytesA.length ^ bytesB.length;
  for (let i = 0; i < steps; i++) {
    diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  }
  return { equal: diff === 0, steps };
}

/**
 * 定数時間でのバイト列比較（タイミング攻撃対策、§7-2）。
 * 実体は `timingSafeEqualSteps` で、こちらは真偽値だけが要る呼び出し側のための薄い包み。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  return timingSafeEqualSteps(a, b).equal;
}

/**
 * `Authorization: Bearer <token>` からトークンを取り出す（§6「すべてトークン必須」）。
 * ヘッダーが無い・スキームが違う・値が空のときは `undefined` を返す。
 *
 * **壊れたヘッダーで例外を投げない。** EN 本体の `sessionToken()` と同じ考え方で、
 * 取り出せないときは「トークンが無い」のと同じ扱いにし、呼び出し側で 401 にする。
 * スキーム名の照合は RFC 7235 に従い大文字小文字を区別しない。
 */
export function bearerToken(req: Request): string | undefined {
  const raw = req.headers.get("authorization");
  if (raw === null) return undefined;
  const space = raw.indexOf(" ");
  if (space < 0) return undefined;
  if (raw.slice(0, space).toLowerCase() !== "bearer") return undefined;
  const value = raw.slice(space + 1).trim();
  return value === "" ? undefined : value;
}

// ---------------------------------------------------------------------------
// §7-7 秘密文字列の検出
// ---------------------------------------------------------------------------

/** 検出した秘密の種別。**値そのものは決して持たない**（§7-4） */
export type SecretKind =
  /** GitHub の従来型トークン（`ghp_` / `gho_` / `ghs_` / `ghu_` / `ghr_`） */
  | "githubToken"
  /** GitHub の fine-grained PAT（`github_pat_`） */
  | "githubFineGrainedPat"
  /** このボード自身が発行したトークン（`enboard_`） */
  | "boardToken";

/**
 * 秘密らしき文字列を見つけた結果。
 * **一致した文字列そのものは返さない。** 返してしまうと呼び出し側がログや
 * エラー応答に載せてしまい、§7-4「ログに残さない」が壊れるため（種別だけで用は足りる）。
 */
export type SecretFinding = {
  /** 何のトークン形式に一致したか */
  kind: SecretKind;
};

/**
 * 検出パターン。接頭辞のあとに**1文字以上の本体**が続くことを要求する。
 *
 * 接頭辞だけ（`ghp_` 単体）を弾かないのは意図的である。設計書 §7-7 も CLI の注意書きも
 * 「`ghp_` で始まる文字列は書かないこと」と**接頭辞そのものに言及する**必要があり、
 * 単体で弾くとそのルールについて表明・タスクに書けなくなる。本体が1文字でも続けば弾く。
 *
 * 語境界は要求しない。前後に文字がくっついていても（例: `see:ghp_abcd`）検出する方が
 * 安全側に倒れるため。`g` フラグは付けない（`lastIndex` が残って結果がぶれるのを避ける）。
 */
const SECRET_PATTERNS: readonly { readonly kind: SecretKind; readonly pattern: RegExp }[] = [
  // fine-grained PAT を先に見る。`github_pat_` は `gh[pousr]_` と綴りが重ならないが、
  // より具体的なものから順に判定する方が種別を取り違えにくい
  { kind: "githubFineGrainedPat", pattern: /github_pat_[A-Za-z0-9_]+/ },
  { kind: "githubToken", pattern: /gh[pousr]_[A-Za-z0-9]+/ },
  { kind: "boardToken", pattern: new RegExp(`${BOARD_TOKEN_PREFIX}[A-Za-z0-9_-]+`) },
];

/**
 * 自由文にトークン形式の文字列が含まれていないか調べる（§7-7）。
 * 見つかれば種別を、見つからなければ `null` を返す。
 *
 * **この関数は判定するだけで、どこで使うかは呼び出し側（server）に委ねる。**
 * 表明の `title` / `note`、タスクの `title` / `body`、PR 宛メッセージの本文など、
 * 利用者が入力する自由文すべてが対象になりうる。
 */
export function findSecretLike(text: string): SecretFinding | null {
  for (const { kind, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) return { kind };
  }
  return null;
}

/** `findSecretLike` の真偽値版。種別が要らない呼び出し側のための薄い包み */
export function containsSecretLike(text: string): boolean {
  return findSecretLike(text) !== null;
}

// ---------------------------------------------------------------------------
// §7-8 レート制限
// ---------------------------------------------------------------------------

/**
 * 固定窓カウンタ方式の簡易レート制限（§7-8）。プロセスメモリのみで永続化しない。
 * 二度とアクセスが来ない key の記録が残り続けないよう、windowMs 周期で全体を掃除する。
 *
 * `server/auth.ts` の同名クラスと同じ流儀で書いてある。import で共有しないのは、
 * §3 のとおり board を EN 本体から完全に独立させる（EN が落ちてもボードは動く）ためで、
 * 重複を承知のうえで写している。EN 側にしか要らないデバッグ用の口は持たせていない。
 */
export class RateLimiter {
  #hits = new Map<string, number[]>();
  #sweepTimer: ReturnType<typeof setInterval>;

  constructor(private readonly limit: number, private readonly windowMs: number) {
    this.#sweepTimer = setInterval(() => this.#sweep(), this.windowMs);
  }

  /** 呼び出しを1回計上し、上限を超えていれば false を返す */
  tryConsume(key: string, now: number): boolean {
    const cutoff = now - this.windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    if (hits.length >= this.limit) {
      this.#hits.set(key, hits);
      return false;
    }
    hits.push(now);
    this.#hits.set(key, hits);
    return true;
  }

  /**
   * 計上せずに、いま上限に達しているかだけを見る。
   * 認証は**失敗したときだけ**枠を消費する（後述の `authenticate` を参照）ので、
   * 「判定」と「計上」を分ける必要があり、EN 本体の RateLimiter に対してこれだけ足した。
   */
  isExceeded(key: string, now: number): boolean {
    const cutoff = now - this.windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    return hits.length >= this.limit;
  }

  /** 期限切れの記録だけになった key を削除する */
  #sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, hits] of this.#hits) {
      const fresh = hits.filter((t) => t > cutoff);
      if (fresh.length === 0) this.#hits.delete(key);
      else this.#hits.set(key, fresh);
    }
  }

  /** 定期掃除タイマーを止める */
  dispose(): void {
    clearInterval(this.#sweepTimer);
  }
}

// ---------------------------------------------------------------------------
// メンバーの登録・解決・認証
// ---------------------------------------------------------------------------

/** メンバー登録の結果。既に同じ id がいれば `duplicate`（例外に頼らず値で返す） */
export type RegisterOutcome =
  | {
    ok: true;
    /** 登録されたメンバー（ハッシュを含まない公開部分） */
    member: MemberPublic;
    /**
     * 発行された平文のトークン。**ここでしか手に入らない**（§7-2「その場で1回だけ表示」）。
     * 保存も再表示もできないので、呼び出し側は本人に渡したら捨てること。
     */
    token: string;
  }
  | { ok: false; reason: "duplicate" };

/** トークン再発行の結果（§7-2「紛失したら再発行（回復はできない）」） */
export type ReissueOutcome =
  | { ok: true; member: MemberPublic; token: string }
  /** 該当 id のメンバーがいない */
  | { ok: false; reason: "notFound" }
  /** 同時に別の再発行が入って書き込めなかった。やり直せばよい */
  | { ok: false; reason: "conflict" };

/** 認証が通らなかった理由。**入力された値は一切含めない**（§7-4） */
export type AuthFailureReason =
  /** `Authorization: Bearer` が無い、または空 */
  | "missing"
  /** トークンがどのメンバーとも一致しない */
  | "invalid"
  /** 認証失敗の連打で上限に達した（§7-8） */
  | "rateLimited";

/** 認証の結果 */
export type AuthOutcome =
  | { ok: true; member: MemberPublic }
  | { ok: false; reason: AuthFailureReason };

/**
 * 作業ボードの認証。Deno KV への読み書きをカプセル化する（§7）。
 *
 * KV に置くのは `Member`（識別子・表示名・**トークンのハッシュ**・発行時刻）だけで、
 * 平文のトークンはどこにも残さない（§7-2 / §7-3「トークン→メンバーの対応表は VPS の KV のみ」）。
 */
export class BoardAuth {
  #kv: Deno.Kv;
  #failLimiter = new RateLimiter(AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW_MS);

  constructor(kv: Deno.Kv) {
    this.#kv = kv;
  }

  /** レート制限の定期掃除タイマーを止める。サーバー停止時に呼ぶ */
  dispose(): void {
    this.#failLimiter.dispose();
  }

  /**
   * メンバーを登録し、トークンを1回だけ発行して返す（§7-1 / §7-2）。
   * KV には SHA-256 ハッシュと表示名（と識別子・発行時刻）だけを書き込む。
   *
   * 既に同じ id が居れば何も書かずに `duplicate` を返す。「登録し直し」を
   * 黙って上書きにすると、既存メンバーのトークンが無言で無効化されるため。
   * 意図的に付け替えたいときは `reissueToken()` を使う。
   */
  async registerMember(id: string, displayName: string): Promise<RegisterOutcome> {
    const token = issueToken();
    const member: Member = {
      id,
      displayName,
      tokenHash: await hashToken(token),
      createdAt: Date.now(),
    };
    const key = [KV_PREFIX.member, id];
    const commit = await this.#kv.atomic().check({ key, versionstamp: null }).set(key, member)
      .commit();
    if (!commit.ok) return { ok: false, reason: "duplicate" };
    return { ok: true, member: { id: member.id, displayName: member.displayName }, token };
  }

  /**
   * 既存メンバーのトークンを新しく発行し直す（§7-2「紛失したら再発行」）。
   * 古いトークンのハッシュは上書きされ、その時点で使えなくなる。
   *
   * 読んでから書くまでに別の再発行が入ると後勝ちで一方のトークンが無言で死ぬので、
   * versionstamp を照合し、変わっていたら書かずに `conflict` を返す
   * （EN 本体の `saveProfile` と同じ考え方）。
   */
  async reissueToken(id: string): Promise<ReissueOutcome> {
    const key = [KV_PREFIX.member, id];
    const entry = await this.#kv.get<Member>(key);
    if (entry.value === null) return { ok: false, reason: "notFound" };
    const token = issueToken();
    const updated: Member = { ...entry.value, tokenHash: await hashToken(token) };
    const commit = await this.#kv.atomic().check(entry).set(key, updated).commit();
    if (!commit.ok) return { ok: false, reason: "conflict" };
    return { ok: true, member: { id: updated.id, displayName: updated.displayName }, token };
  }

  /** 登録済みメンバーの一覧（公開部分のみ）。ハッシュは返さない */
  async listMembers(): Promise<MemberPublic[]> {
    const members: MemberPublic[] = [];
    for await (const entry of this.#kv.list<Member>({ prefix: [KV_PREFIX.member] })) {
      members.push({ id: entry.value.id, displayName: entry.value.displayName });
    }
    return members;
  }

  /**
   * 平文のトークンからメンバーを解決する（§7-1「認証と識別が同時に済む」）。
   * 一致しなければ `null`。
   *
   * 照合はハッシュ同士の**定数時間比較**で行い、**一致しても走査を打ち切らない**。
   * 打ち切ると「何番目のメンバーのトークンか」が応答時間に出てしまうため、
   * 常に全メンバーと比較する（チームは数人規模なので全走査の費用は無視できる）。
   */
  async resolveMember(token: string): Promise<MemberPublic | null> {
    if (token === "") return null;
    const tokenHash = await hashToken(token);
    let found: MemberPublic | null = null;
    for await (const entry of this.#kv.list<Member>({ prefix: [KV_PREFIX.member] })) {
      const member = entry.value;
      if (timingSafeEqual(member.tokenHash, tokenHash)) {
        found = { id: member.id, displayName: member.displayName };
      }
    }
    return found;
  }

  /**
   * リクエストを認証する（§6「すべてトークン必須」/ §7-8）。
   *
   * レート制限は**認証に失敗したときだけ**枠を消費する。CLI はハートビートのたびに
   * 正しいトークンで API を叩く（§5）ので、成功も数えると正規利用が自分で自分を締め出す。
   * §7-8 が求めているのは総当たり対策なので、失敗だけを数えれば目的を達する。
   *
   * **失敗しても値は記録しない。** 戻り値は理由の種別だけで、トークンの中身は
   * 呼び出し側に渡らない（§7-4）。このメソッドは一切ログ出力を行わない。
   */
  async authenticate(
    req: Request,
    clientIp: string,
    now: number = Date.now(),
  ): Promise<AuthOutcome> {
    if (this.#failLimiter.isExceeded(clientIp, now)) {
      return { ok: false, reason: "rateLimited" };
    }
    const token = bearerToken(req);
    if (token === undefined) {
      this.#failLimiter.tryConsume(clientIp, now);
      return { ok: false, reason: "missing" };
    }
    const member = await this.resolveMember(token);
    if (member === null) {
      this.#failLimiter.tryConsume(clientIp, now);
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, member };
  }
}
