/**
 * 作業ボードの認証基盤のテスト（docs/design/board.md §7 / §11）
 *
 * §11 の「テスト観点」のうち、認証・秘密検出・レート制限・ログ漏れに対応する。
 *   - 正しいトークン / 誤ったトークン / トークン無し
 *   - ハッシュの安定性と、KV に平文が残っていないこと
 *   - ハッシュ照合が定数時間か（**時間計測ではなくロジックで検証する**）
 *   - 認証失敗の連打を止められるか
 *   - `ghp_` で始まる文字列を検出できるか（境界を含む）
 */

import { assert, assertEquals, assertFalse, assertNotEquals } from "@std/assert";
import {
  AUTH_FAIL_LIMIT,
  AUTH_FAIL_WINDOW_MS,
  bearerToken,
  BOARD_TOKEN_PREFIX,
  BoardAuth,
  containsSecretLike,
  findSecretLike,
  hashToken,
  issueToken,
  RateLimiter,
  timingSafeEqual,
  timingSafeEqualSteps,
  TOKEN_LENGTH,
} from "./auth.ts";
import { KV_PREFIX, type Member } from "./types.ts";

/** テスト用の Deno KV と BoardAuth を用意し、後始末（タイマー・KV）まで面倒を見る */
async function withAuth(
  fn: (auth: BoardAuth, kv: Deno.Kv) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const auth = new BoardAuth(kv);
  try {
    await fn(auth, kv);
  } finally {
    auth.dispose();
    kv.close();
  }
}

/** `Authorization: Bearer <token>` 付きのリクエストを作る。token 省略でヘッダー無し */
function requestWithToken(token?: string): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://board.test/api/claims", { headers });
}

/** テストの前提: BoardAuth に1人だけ登録し、公開情報と平文トークンを受け取る */
async function registerOne(
  auth: BoardAuth,
  id = "chiikawa",
  displayName = "ちいかわ",
): Promise<string> {
  const result = await auth.registerMember(id, displayName);
  assert(result.ok, "登録が成功すること");
  return result.token;
}

// ---------------------------------------------------------------------------
// トークンの発行
// ---------------------------------------------------------------------------

Deno.test("issueToken: 接頭辞付きの固定長で、base64url の文字だけからなる", () => {
  const token = issueToken();
  assertEquals(token.length, TOKEN_LENGTH);
  assert(token.startsWith(BOARD_TOKEN_PREFIX), "接頭辞が付くこと");
  const body = token.slice(BOARD_TOKEN_PREFIX.length);
  // 32バイトを base64url（パディング無し）にすると 43 文字になる
  assertEquals(body.length, 43);
  assert(/^[A-Za-z0-9_-]+$/.test(body), "URL 安全な文字だけからなること");
});

Deno.test("issueToken: 呼ぶたびに違う値になる", () => {
  const tokens = new Set<string>();
  for (let i = 0; i < 200; i++) tokens.add(issueToken());
  assertEquals(tokens.size, 200, "200回発行して重複が無いこと");
});

// ---------------------------------------------------------------------------
// ハッシュ化（§7-2）
// ---------------------------------------------------------------------------

Deno.test("hashToken: 同じ入力に対してハッシュが安定している", async () => {
  const token = issueToken();
  const first = await hashToken(token);
  const second = await hashToken(token);
  assertEquals(first, second);
});

Deno.test("hashToken: 異なる入力は異なるハッシュになる", async () => {
  const a = await hashToken("enboard_aaaa");
  const b = await hashToken("enboard_aaab");
  assertNotEquals(a, b);
});

Deno.test("hashToken: 出力は入力の長さによらず 43 文字の base64url（SHA-256 の固定長）", async () => {
  for (const input of ["", "a", issueToken(), "あ".repeat(1000)]) {
    const hash = await hashToken(input);
    assertEquals(hash.length, 43, "SHA-256 の 32 バイトは base64url で 43 文字");
    assert(/^[A-Za-z0-9_-]+$/.test(hash));
  }
});

Deno.test("hashToken: ハッシュから平文は読み取れない（平文を含まない）", async () => {
  const token = issueToken();
  const hash = await hashToken(token);
  assertFalse(hash.includes(token));
  assertFalse(hash.includes(token.slice(BOARD_TOKEN_PREFIX.length)));
});

// ---------------------------------------------------------------------------
// 定数時間比較（§7-2）
//
// 時間計測は GC / JIT の影響でぶれるので使わない。代わりに timingSafeEqualSteps が返す
// 「比較したバイト数」を見る。早期 return する素朴な実装なら steps は食い違う位置や
// 長さの違いで変わってしまうので、変わらないことが実装の性質の証拠になる。
// ---------------------------------------------------------------------------

Deno.test("timingSafeEqual: 同じ文字列は true、違えば false", () => {
  const hash = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
  assert(timingSafeEqual(hash, hash));
  assertFalse(timingSafeEqual(hash, hash.slice(0, 42) + "Z"));
});

Deno.test("timingSafeEqual: 不一致の位置が変わっても比較したバイト数が変わらない", () => {
  const base = "A".repeat(43);
  const diffAtHead = "B" + "A".repeat(42);
  const diffAtMiddle = "A".repeat(21) + "B" + "A".repeat(21);
  const diffAtTail = "A".repeat(42) + "B";

  const equalCase = timingSafeEqualSteps(base, base);
  const head = timingSafeEqualSteps(base, diffAtHead);
  const middle = timingSafeEqualSteps(base, diffAtMiddle);
  const tail = timingSafeEqualSteps(base, diffAtTail);

  assert(equalCase.equal);
  assertFalse(head.equal);
  assertFalse(middle.equal);
  assertFalse(tail.equal);

  // 先頭で食い違った時点で打ち切る実装なら head.steps は 1 になるはず。
  // 全ケースで 43 なのは、最初の不一致で抜けていないことを意味する
  assertEquals(equalCase.steps, 43);
  assertEquals(head.steps, 43);
  assertEquals(middle.steps, 43);
  assertEquals(tail.steps, 43);
});

Deno.test("timingSafeEqual: 長さが違っても早期 return していない", () => {
  const short = "a";
  const long = "b".repeat(64);

  const forward = timingSafeEqualSteps(short, long);
  const backward = timingSafeEqualSteps(long, short);

  assertFalse(forward.equal);
  assertFalse(backward.equal);
  // 長さ違いを見た時点で return する実装なら steps は 0 になる。
  // 長い方の全バイトを走査していることを確認する
  assertEquals(forward.steps, 64);
  assertEquals(backward.steps, 64, "引数の順番によらず同じ回数だけ比較すること");
});

Deno.test("timingSafeEqual: 一方が他方の前方一致でも false（長さの差を畳み込んでいる）", () => {
  assertFalse(timingSafeEqual("abc", "abcd"));
  assertFalse(timingSafeEqual("abcd", "abc"));
  assertEquals(timingSafeEqualSteps("abc", "abcd").steps, 4);
});

Deno.test("timingSafeEqual: 空文字どうしは true、空文字と非空は false", () => {
  const both = timingSafeEqualSteps("", "");
  assert(both.equal);
  assertEquals(both.steps, 0);
  assertFalse(timingSafeEqual("", "a"));
  assertEquals(timingSafeEqualSteps("", "a").steps, 1);
});

Deno.test("timingSafeEqual: マルチバイト文字も UTF-8 バイト単位で比較する", () => {
  assert(timingSafeEqual("ちいかわ", "ちいかわ"));
  assertFalse(timingSafeEqual("ちいかわ", "ひろし"));
  // 「ちいかわ」は UTF-8 で 12 バイト、「ひろし」は 9 バイト → 長い方の 12 回
  assertEquals(timingSafeEqualSteps("ちいかわ", "ひろし").steps, 12);
});

// ---------------------------------------------------------------------------
// Authorization ヘッダーの取り出し
// ---------------------------------------------------------------------------

Deno.test("bearerToken: Bearer からトークンを取り出す（スキームは大文字小文字を問わない）", () => {
  assertEquals(bearerToken(requestWithToken("enboard_abc")), "enboard_abc");
  const headers = new Headers({ authorization: "bearer enboard_abc" });
  assertEquals(bearerToken(new Request("http://board.test/", { headers })), "enboard_abc");
});

Deno.test("bearerToken: 壊れたヘッダーは undefined を返し、例外を投げない", () => {
  const cases = ["", "Bearer", "Bearer ", "Basic enboard_abc", "enboard_abc", "   "];
  for (const raw of cases) {
    const headers = new Headers({ authorization: raw });
    const req = new Request("http://board.test/", { headers });
    assertEquals(bearerToken(req), undefined, `"${raw}" は取り出せないこと`);
  }
  assertEquals(bearerToken(new Request("http://board.test/")), undefined);
});

// ---------------------------------------------------------------------------
// メンバーの登録・解決・認証（§7-1）
// ---------------------------------------------------------------------------

Deno.test("認証: 発行したトークンで認証が通り、メンバーが解決される", async () => {
  await withAuth(async (auth) => {
    const token = await registerOne(auth, "chiikawa", "ちいかわ");
    const result = await auth.authenticate(requestWithToken(token), "192.0.2.1");
    assert(result.ok, "認証が通ること");
    assertEquals(result.member, { id: "chiikawa", displayName: "ちいかわ" });
  });
});

Deno.test("認証: 誤ったトークンでは通らない", async () => {
  await withAuth(async (auth) => {
    await registerOne(auth);
    const result = await auth.authenticate(requestWithToken(issueToken()), "192.0.2.1");
    assertFalse(result.ok);
    assert(!result.ok && result.reason === "invalid");
  });
});

Deno.test("認証: 1文字だけ違うトークンでも通らない", async () => {
  await withAuth(async (auth) => {
    const token = await registerOne(auth);
    const last = token.slice(-1) === "A" ? "B" : "A";
    const tampered = token.slice(0, -1) + last;
    const result = await auth.authenticate(requestWithToken(tampered), "192.0.2.1");
    assert(!result.ok && result.reason === "invalid");
  });
});

Deno.test("認証: トークン無し（ヘッダーが無い）では通らない", async () => {
  await withAuth(async (auth) => {
    await registerOne(auth);
    const result = await auth.authenticate(requestWithToken(), "192.0.2.1");
    assert(!result.ok && result.reason === "missing");
  });
});

Deno.test("認証: 空のトークンでは通らない", async () => {
  await withAuth(async (auth) => {
    await registerOne(auth);
    assertEquals(await auth.resolveMember(""), null);
    const headers = new Headers({ authorization: "Bearer " });
    const result = await auth.authenticate(new Request("http://board.test/", { headers }), "ip");
    assert(!result.ok && result.reason === "missing");
  });
});

Deno.test("認証: メンバーが1人も居なければ、どのトークンでも通らない", async () => {
  await withAuth(async (auth) => {
    const result = await auth.authenticate(requestWithToken(issueToken()), "192.0.2.1");
    assert(!result.ok && result.reason === "invalid");
  });
});

Deno.test("認証: 複数メンバーでもトークンごとに正しい本人が解決される", async () => {
  await withAuth(async (auth) => {
    const chiikawa = await registerOne(auth, "chiikawa", "ちいかわ");
    const hiroshi = await registerOne(auth, "hiroshi", "ひろし");
    const mitsuo = await registerOne(auth, "mitsuo", "みつお");

    assertEquals((await auth.resolveMember(chiikawa))?.displayName, "ちいかわ");
    assertEquals((await auth.resolveMember(hiroshi))?.displayName, "ひろし");
    assertEquals((await auth.resolveMember(mitsuo))?.displayName, "みつお");
  });
});

Deno.test("登録: 同じ id は二重登録できず、既存のトークンも無効化されない", async () => {
  await withAuth(async (auth) => {
    const token = await registerOne(auth, "chiikawa", "ちいかわ");
    const again = await auth.registerMember("chiikawa", "にせもの");
    assert(!again.ok && again.reason === "duplicate");
    // 上書きされていないので、最初のトークンはそのまま使える
    assertEquals((await auth.resolveMember(token))?.displayName, "ちいかわ");
  });
});

Deno.test("再発行: 新しいトークンが通り、古いトークンは通らなくなる（§7-2）", async () => {
  await withAuth(async (auth) => {
    const oldToken = await registerOne(auth, "chiikawa", "ちいかわ");
    const reissued = await auth.reissueToken("chiikawa");
    assert(reissued.ok, "再発行が成功すること");
    assertNotEquals(reissued.token, oldToken);

    assertEquals((await auth.resolveMember(reissued.token))?.id, "chiikawa");
    assertEquals(await auth.resolveMember(oldToken), null, "古いトークンは失効すること");
  });
});

Deno.test("再発行: 居ないメンバーには notFound を返す", async () => {
  await withAuth(async (auth) => {
    const result = await auth.reissueToken("nobody");
    assert(!result.ok && result.reason === "notFound");
  });
});

Deno.test("listMembers: 表示名は返すがハッシュは返さない", async () => {
  await withAuth(async (auth) => {
    await registerOne(auth, "chiikawa", "ちいかわ");
    await registerOne(auth, "hiroshi", "ひろし");
    const members = await auth.listMembers();
    assertEquals(members.length, 2);
    for (const member of members) {
      assertEquals(Object.keys(member).sort(), ["displayName", "id"]);
    }
  });
});

// ---------------------------------------------------------------------------
// KV に平文が残らないこと（§7-2 / §7-4）
// ---------------------------------------------------------------------------

Deno.test("KV には平文のトークンが保存されていない（KV を直接読んで確認）", async () => {
  await withAuth(async (auth, kv) => {
    const token = await registerOne(auth, "chiikawa", "ちいかわ");
    const body = token.slice(BOARD_TOKEN_PREFIX.length);

    let scanned = 0;
    for await (const entry of kv.list({ prefix: [] })) {
      scanned++;
      const dump = JSON.stringify({ key: entry.key, value: entry.value });
      assertFalse(dump.includes(token), "KV のどこにも平文トークンが無いこと");
      assertFalse(dump.includes(body), "接頭辞を外した乱数部も無いこと");
    }
    assert(scanned > 0, "そもそも KV に何か書かれていること（走査の失敗を成功と誤認しない）");
  });
});

Deno.test("KV に入っているのはハッシュと表示名（と識別子・発行時刻）だけ", async () => {
  await withAuth(async (auth, kv) => {
    const token = await registerOne(auth, "chiikawa", "ちいかわ");
    const entry = await kv.get<Member>([KV_PREFIX.member, "chiikawa"]);
    assert(entry.value !== null, "メンバーが保存されていること");

    assertEquals(Object.keys(entry.value).sort(), [
      "createdAt",
      "displayName",
      "id",
      "tokenHash",
    ]);
    assertEquals(entry.value.tokenHash, await hashToken(token), "保存値は SHA-256 ハッシュ");
    assertNotEquals(entry.value.tokenHash, token);
  });
});

// ---------------------------------------------------------------------------
// レート制限（§7-8）
// ---------------------------------------------------------------------------

Deno.test("RateLimiter: 上限まで通し、超過を拒否し、窓が明けたら回復する", () => {
  const limiter = new RateLimiter(3, 1_000);
  try {
    const t0 = 10_000;
    assert(limiter.tryConsume("ip", t0));
    assert(limiter.tryConsume("ip", t0));
    assert(limiter.tryConsume("ip", t0));
    assertFalse(limiter.tryConsume("ip", t0), "上限超過は拒否");
    assert(limiter.isExceeded("ip", t0));

    // 窓の判定は `記録時刻 > now - windowMs`（EN 本体の RateLimiter と同じ）。
    // windowMs の1ミリ秒手前まではまだ窓の内側で、拒否が続く
    assert(limiter.isExceeded("ip", t0 + 999));
    assertFalse(limiter.tryConsume("ip", t0 + 999));
    // ちょうど windowMs 後に古い記録が外れ、回復する
    assertFalse(limiter.isExceeded("ip", t0 + 1_000));
    assert(limiter.tryConsume("ip", t0 + 1_000));
  } finally {
    limiter.dispose();
  }
});

Deno.test("RateLimiter: key（IP）ごとに独立している", () => {
  const limiter = new RateLimiter(1, 1_000);
  try {
    assert(limiter.tryConsume("192.0.2.1", 0));
    assertFalse(limiter.tryConsume("192.0.2.1", 0));
    assert(limiter.tryConsume("192.0.2.2", 0), "別 IP は巻き添えにならない");
  } finally {
    limiter.dispose();
  }
});

Deno.test("認証: 失敗を連打すると上限で止まり、窓が明けたら回復する", async () => {
  await withAuth(async (auth) => {
    const token = await registerOne(auth);
    const ip = "198.51.100.7";
    const t0 = 1_000_000;

    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) {
      const result = await auth.authenticate(requestWithToken(issueToken()), ip, t0);
      assert(!result.ok && result.reason === "invalid", `${i + 1}回目までは通常の失敗`);
    }

    const blocked = await auth.authenticate(requestWithToken(issueToken()), ip, t0);
    assert(!blocked.ok && blocked.reason === "rateLimited", "上限超過は rateLimited");

    // 締め出されている間は正しいトークンでも通さない（総当たり中の IP をまとめて止める）
    const correctButBlocked = await auth.authenticate(requestWithToken(token), ip, t0);
    assert(!correctButBlocked.ok && correctButBlocked.reason === "rateLimited");

    // 窓の境界: windowMs の1ミリ秒手前まではまだ締め出されたまま
    const atBoundary = await auth.authenticate(
      requestWithToken(token),
      ip,
      t0 + AUTH_FAIL_WINDOW_MS - 1,
    );
    assert(!atBoundary.ok && atBoundary.reason === "rateLimited");

    // 窓が明けたら回復する
    const recovered = await auth.authenticate(
      requestWithToken(token),
      ip,
      t0 + AUTH_FAIL_WINDOW_MS,
    );
    assert(recovered.ok, "窓が明ければ正しいトークンで通る");
  });
});

Deno.test("認証: トークン無しの連打もレート制限の対象になる", async () => {
  await withAuth(async (auth) => {
    await registerOne(auth);
    const ip = "198.51.100.8";
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) {
      const result = await auth.authenticate(requestWithToken(), ip, 5_000);
      assert(!result.ok && result.reason === "missing");
    }
    const blocked = await auth.authenticate(requestWithToken(), ip, 5_000);
    assert(!blocked.ok && blocked.reason === "rateLimited");
  });
});

Deno.test("認証: 成功はレート制限の枠を消費しない（ハートビートで自滅しない）", async () => {
  await withAuth(async (auth) => {
    const token = await registerOne(auth);
    const ip = "198.51.100.9";
    // §5 のハートビートを想定した連続成功。上限の何倍叩いても締め出されない
    for (let i = 0; i < AUTH_FAIL_LIMIT * 4; i++) {
      const result = await auth.authenticate(requestWithToken(token), ip, 2_000);
      assert(result.ok, `${i + 1}回目の成功が通ること`);
    }
    // そのあと1回失敗しても、まだ枠は残っている
    const failed = await auth.authenticate(requestWithToken(issueToken()), ip, 2_000);
    assert(!failed.ok && failed.reason === "invalid");
  });
});

Deno.test("認証: レート制限は IP ごとで、他メンバーを巻き添えにしない", async () => {
  await withAuth(async (auth) => {
    const token = await registerOne(auth);
    for (let i = 0; i <= AUTH_FAIL_LIMIT; i++) {
      await auth.authenticate(requestWithToken(issueToken()), "198.51.100.10", 3_000);
    }
    const other = await auth.authenticate(requestWithToken(token), "198.51.100.11", 3_000);
    assert(other.ok, "別 IP の正規利用は妨げられない");
  });
});

// ---------------------------------------------------------------------------
// 秘密文字列の検出（§7-7）
// ---------------------------------------------------------------------------

Deno.test("秘密検出: ghp_ で始まるトークン形式を弾く", () => {
  assert(containsSecretLike("ghp_xxxx"));
  assert(containsSecretLike("ghp_0123456789abcdefghijklmnopqrstuvwx"));
  assertEquals(findSecretLike("ghp_xxxx")?.kind, "githubToken");
});

Deno.test("秘密検出: gho_ / ghs_ / ghu_ / ghr_ も弾く", () => {
  for (const prefix of ["gho_", "ghs_", "ghu_", "ghr_"]) {
    assert(containsSecretLike(`${prefix}abcd1234`), `${prefix} を検出すること`);
  }
});

Deno.test("秘密検出: github_pat_（fine-grained PAT）を弾く", () => {
  const text = "github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789";
  assert(containsSecretLike(text));
  assertEquals(findSecretLike(text)?.kind, "githubFineGrainedPat");
});

Deno.test("秘密検出: ボード自身のトークンを貼った場合も弾く", () => {
  const token = issueToken();
  assert(containsSecretLike(token));
  assertEquals(findSecretLike(token)?.kind, "boardToken");
  assert(containsSecretLike(`.env に ${token} を入れました`));
});

Deno.test("秘密検出: 普通の日本語の文は通す", () => {
  const texts = [
    "VC ルームの画面共有を作る",
    "corridor.js の当たり判定を直す。ついでにレイアウトも見直す",
    "server/auth.ts の saveProfile を触ります（PR #35 と重なるかも）",
    "タスク: ひろしに PR のレビューを頼む",
    "",
  ];
  for (const text of texts) {
    assertFalse(containsSecretLike(text), `"${text}" は通ること`);
  }
});

Deno.test("秘密検出（境界）: 接頭辞だけなら通す（ルール自体を書けなくなるため）", () => {
  assertFalse(containsSecretLike("ghp_"));
  assertFalse(containsSecretLike("ghp_ で始まる文字列は書かないこと"));
  assertFalse(containsSecretLike("github_pat_"));
  assertFalse(containsSecretLike("表明の本文に ghp_ / gho_ を書かない"));
  assertFalse(containsSecretLike(BOARD_TOKEN_PREFIX));
});

Deno.test("秘密検出（境界）: 本体が1文字でも続けば弾く", () => {
  assert(containsSecretLike("ghp_a"));
  assert(containsSecretLike("github_pat_1"));
});

Deno.test("秘密検出（境界）: 前後に文字がくっついていても弾く（安全側に倒す）", () => {
  assert(containsSecretLike("トークンはghp_abcd1234です"), "前に文字がある場合");
  assert(containsSecretLike("xghp_abcd1234"), "語の途中でも検出する");
  assert(containsSecretLike("ghp_abcd1234。"), "後ろに文字がある場合");
  assert(containsSecretLike("見て → `ghp_abcd1234`"), "引用符に囲まれている場合");
  assert(containsSecretLike("1行目\nghp_abcd1234\n3行目"), "改行を挟んだ場合");
});

Deno.test("秘密検出（境界）: 似ているが別物の綴りは通す", () => {
  assertFalse(containsSecretLike("ghi_abcd1234"), "gh のあとが p/o/u/s/r 以外");
  assertFalse(containsSecretLike("ghpabcd1234"), "アンダースコアが無い");
  assertFalse(containsSecretLike("github_pat"), "末尾のアンダースコアが無い");
  assertFalse(containsSecretLike("https://github.com/MIYAMegmilk/EN/pull/36"));
});

Deno.test("秘密検出: 結果に一致した値そのものを含めない（§7-4）", () => {
  const secret = "ghp_0123456789abcdefghijklmnopqrstuvwx";
  const finding = findSecretLike(secret);
  assert(finding !== null);
  assertEquals(Object.keys(finding), ["kind"], "返すのは種別だけ");
  assertFalse(JSON.stringify(finding).includes(secret));
});

Deno.test("秘密検出: 判定は繰り返しても安定する（正規表現の状態が残らない）", () => {
  const text = "ghp_abcd1234";
  for (let i = 0; i < 5; i++) {
    assert(containsSecretLike(text), `${i + 1}回目も検出すること`);
  }
});
