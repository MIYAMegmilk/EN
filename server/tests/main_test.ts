/**
 * server/main.ts のテスト。
 * /api/ice が TURN 認証情報の有無で正しく応答を変えることを確認する（§3.6 / §3.8）。
 * §6: 本番はリバースプロキシ経由のため、TCP接続元だけでは実クライアントIPが分からない。
 * clientIp は X-Forwarded-For を優先して実クライアントIPを判定する。
 * /api/rooms は稼働中の公開ルームだけを返す（§2 / §4.0）。
 * asC2S は types.ts の C2S 型と同じ t を受理しなければならない（§4.1、末尾の照合テスト）。
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import {
  asC2S,
  C2S_TYPES,
  clientIp,
  filterSandboxGames,
  MessageRateLimiter,
  parseSandboxManifest,
  startServer,
  useKuromojiSenryu,
} from "../main.ts";
import type { ClientLink } from "../rooms.ts";
import {
  type C2S,
  type ErrorCode,
  type PublicRoomSummary,
  type S2C,
  type SandboxGameInfo,
  WS_RATE_MAX,
  WS_SANDBOX_HARD_MAX,
  WS_SANDBOX_RATE_MAX,
} from "../types.ts";

/** 受信内容を捨てるだけの接続。ルームを立てる副作用だけが要るテストで使う */
class MockLink implements ClientLink {
  readonly id = crypto.randomUUID();
  constructor(readonly userId: string | null = "testUser") {}
  send(_msg: S2C): void {}
  close(): void {}
}

/** 読み取る環境変数 */
const TURN_KEYS = ["TURN_URL", "TURN_USER", "TURN_PASS"] as const;

/** kuromoji を有効にする環境変数。名前が変わると .env.example と §6 が食い違う */
const KUROMOJI_ENV_KEY = "EN_SENRYU_KUROMOJI";

/** 応答に載る ICE サーバー1件 */
type IceServer = { urls: string; username?: string; credential?: string };

/** 既定で必ず載る STUN */
const STUN: IceServer = { urls: "stun:stun.l.google.com:19302" };

/**
 * 指定した環境変数だけを立てた状態でサーバーを起動し、/api/ice を叩く。
 * 作業ディレクトリを空の一時ディレクトリへ移し、開発者の `.env` に影響されないようにする。
 */
async function fetchIce(
  values: Partial<Record<(typeof TURN_KEYS)[number], string>>,
  method = "GET",
): Promise<{ status: number; headers: Headers; body: string }> {
  const saved = TURN_KEYS.map((key) => [key, Deno.env.get(key)] as const);
  const cwd = Deno.cwd();
  const temp = await Deno.makeTempDir();
  Deno.chdir(temp);
  for (const key of TURN_KEYS) Deno.env.delete(key);
  for (const [key, value] of Object.entries(values)) Deno.env.set(key, value);
  const handle = startServer(0);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/ice`, { method });
    return { status: res.status, headers: res.headers, body: await res.text() };
  } finally {
    await handle.shutdown();
    Deno.chdir(cwd);
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(temp, { recursive: true });
  }
}

Deno.test("/api/ice: TURN 未設定なら STUN のみを返す", async () => {
  const res = await fetchIce({});
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/json; charset=utf-8");
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(JSON.parse(res.body), { iceServers: [STUN] });
});

Deno.test("/api/ice: TURN が3つ揃えば TURN も返す", async () => {
  const res = await fetchIce({
    TURN_URL: "turn:turn.example.test:3478",
    TURN_USER: "en-user",
    TURN_PASS: "en-pass",
  });
  assertEquals(res.status, 200);
  assertEquals(JSON.parse(res.body), {
    iceServers: [
      STUN,
      {
        urls: "turn:turn.example.test:3478",
        username: "en-user",
        credential: "en-pass",
      },
    ],
  });
});

Deno.test("/api/ice: TURN が一部だけなら載せない", async () => {
  const res = await fetchIce({ TURN_URL: "turn:turn.example.test:3478", TURN_USER: "en-user" });
  assertEquals(JSON.parse(res.body), { iceServers: [STUN] });
});

Deno.test("/api/ice: 空文字の TURN 設定は無視する", async () => {
  const res = await fetchIce({ TURN_URL: "  ", TURN_USER: "en-user", TURN_PASS: "en-pass" });
  assertEquals(JSON.parse(res.body), { iceServers: [STUN] });
});

Deno.test("/api/ice: GET 以外は 405", async () => {
  const res = await fetchIce({}, "POST");
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "GET");
});

Deno.test("clientIp: X-Forwarded-For があれば先頭のIPを使う（リバースプロキシ配下）", () => {
  const req = new Request("http://example.com/", {
    headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
  });
  assertEquals(clientIp(req, "127.0.0.1"), "203.0.113.5");
});

Deno.test("clientIp: X-Forwarded-For が無ければ TCP 接続元を使う", () => {
  const req = new Request("http://example.com/");
  assertEquals(clientIp(req, "127.0.0.1"), "127.0.0.1");
});

Deno.test("clientIp: 空文字の X-Forwarded-For は TCP 接続元にフォールバックする", () => {
  const req = new Request("http://example.com/", {
    headers: { "x-forwarded-for": "" },
  });
  assertEquals(clientIp(req, "127.0.0.1"), "127.0.0.1");
});

Deno.test("clientIp: 先頭要素の前後の空白を取り除く", () => {
  const req = new Request("http://example.com/", {
    headers: { "x-forwarded-for": "  203.0.113.5  , 10.0.0.1" },
  });
  assertEquals(clientIp(req, "127.0.0.1"), "203.0.113.5");
});

Deno.test("clientIp: ::1 からの接続も信頼済みプロキシとして扱う", () => {
  const req = new Request("http://example.com/", {
    headers: { "x-forwarded-for": "203.0.113.5" },
  });
  assertEquals(clientIp(req, "::1"), "203.0.113.5");
});

Deno.test("clientIp: プロキシ（localhost）以外からの直接接続は X-Forwarded-For を偽装されても無視する", () => {
  const req = new Request("http://example.com/", {
    headers: { "x-forwarded-for": "203.0.113.5" },
  });
  assertEquals(clientIp(req, "198.51.100.9"), "198.51.100.9");
});

// ---------------------------------------------------------------------------
// 公開ルーム一覧（§4.0 GET /api/rooms）
// ---------------------------------------------------------------------------

Deno.test("/api/rooms: 公開ルームが無ければ空配列を返す", async () => {
  const handle = startServer(0);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/rooms`);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("cache-control"), "no-store");
    assertEquals(await res.json(), { rooms: [] });
  } finally {
    await handle.shutdown();
  }
});

Deno.test("/api/rooms: 稼働中の公開ルームを返し、招待制は載せない", async () => {
  const handle = startServer(0);
  const link = new MockLink("owner1");
  try {
    handle.manager.handle(link, {
      t: "createRoom",
      nickname: "ホスト",
      visibility: "public",
      roomName: "とりあえず生",
    });
    handle.manager.handle(new MockLink("owner2"), {
      t: "createRoom",
      nickname: "ホスト",
      visibility: "private",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/rooms`);
    const body = await res.json() as { rooms: PublicRoomSummary[] };
    assertEquals(body.rooms.length, 1);
    assertEquals(body.rooms[0].roomName, "とりあえず生");
    assertEquals(body.rooms[0].playerCount, 1);
    assert(/^[0-9]{6}$/.test(body.rooms[0].code));
  } finally {
    await handle.shutdown();
  }
});

Deno.test("/api/rooms: GET 以外は 405", async () => {
  const handle = startServer(0);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/rooms`, { method: "POST" });
    assertEquals(res.status, 405);
    await res.body?.cancel();
  } finally {
    await handle.shutdown();
  }
});

// ---------------------------------------------------------------------------
// C2S の受理集合の照合（§4.1）
//
// 過去に C2S_TYPES から setBot / endPollVote が抜け落ち、rooms.ts にハンドラがあるのに
// 実際の WebSocket 経由では asC2S に弾かれて機能しない、という不具合が出た。
// rooms_bot_test.ts は RoomManager を直接叩くため main.ts の asC2S を通らず、この齟齬を
// 検出できなかった。TypeScript の型は実行時に列挙できないので、types.ts のソースから
// C2S 型の t を抜き出して C2S_TYPES と集合として突き合わせ、過不足を機械的に検出する。
// ---------------------------------------------------------------------------

/**
 * types.ts のソースから C2S 型の union に現れる t のリテラルを抽出する。
 * S2C 等の t を拾わないよう、`export type C2S =` から次の `export` までに範囲を限定する。
 */
async function c2sTypesFromSource(): Promise<Set<string>> {
  const source = await Deno.readTextFile(new URL("../types.ts", import.meta.url));
  const start = source.indexOf("export type C2S =");
  assert(start >= 0, "types.ts に `export type C2S =` が見つからない（実装変更で抽出が空振り）");
  const after = source.indexOf("\nexport ", start + 1);
  const block = after >= 0 ? source.slice(start, after) : source.slice(start);
  const found = new Set<string>();
  for (const m of block.matchAll(/\bt:\s*"([^"]+)"/g)) found.add(m[1]);
  assert(found.size > 0, "C2S 型から t を1件も抽出できなかった（抽出の正規表現が空振り）");
  return found;
}

Deno.test("C2S_TYPES: types.ts の C2S 型と過不足なく一致する", async () => {
  const declared = await c2sTypesFromSource();
  const missing = [...declared].filter((t) => !C2S_TYPES.has(t));
  const extra = [...C2S_TYPES].filter((t) => !declared.has(t));
  assertEquals(missing, [], `C2S_TYPES に不足している t: ${missing.join(", ")}`);
  assertEquals(extra, [], `C2S 型に存在しないのに C2S_TYPES にある t: ${extra.join(", ")}`);
});

Deno.test("asC2S: types.ts の C2S 型に載っている t はすべて受理する", async () => {
  for (const t of await c2sTypesFromSource()) {
    assert(asC2S({ t }) !== null, `asC2S が ${t} を弾いた（C2S_TYPES に足りていない）`);
  }
});

Deno.test("asC2S: bot の ON/OFF と終了アンケートの投票を受理する（§3.10）", () => {
  assertEquals(asC2S({ t: "setBot", botId: "shunpi", enabled: true }), {
    t: "setBot",
    botId: "shunpi",
    enabled: true,
  });
  assertEquals(asC2S({ t: "setBot", enabled: false }), { t: "setBot", enabled: false });
  assertEquals(asC2S({ t: "endPollVote", pollId: "p1", agree: true }), {
    t: "endPollVote",
    pollId: "p1",
    agree: true,
  });
});

Deno.test("asC2S: 未知の t や t 以外の形は弾く", () => {
  assertEquals(asC2S({ t: "nonexistent" }), null);
  assertEquals(asC2S({ t: 1 }), null);
  assertEquals(asC2S({}), null);
  assertEquals(asC2S(null), null);
  assertEquals(asC2S([{ t: "chat", text: "こんばんは" }]), null);
  assertEquals(asC2S("chat"), null);
});

// ---------------------------------------------------------------------------
// kuromoji のゲート（§3.10 / §6）
// ---------------------------------------------------------------------------

/**
 * 環境変数だけを差し替えて useKuromojiSenryu() を読む。
 * fetchIce と同じく、作業ディレクトリを空の一時ディレクトリへ移して
 * 開発者の `.env` に影響されないようにする。
 */
async function readKuromojiGate(value: string | undefined): Promise<boolean> {
  const saved = Deno.env.get(KUROMOJI_ENV_KEY);
  const cwd = Deno.cwd();
  const temp = await Deno.makeTempDir();
  Deno.chdir(temp);
  if (value === undefined) Deno.env.delete(KUROMOJI_ENV_KEY);
  else Deno.env.set(KUROMOJI_ENV_KEY, value);
  try {
    return useKuromojiSenryu();
  } finally {
    Deno.chdir(cwd);
    if (saved === undefined) Deno.env.delete(KUROMOJI_ENV_KEY);
    else Deno.env.set(KUROMOJI_ENV_KEY, saved);
    await Deno.remove(temp, { recursive: true });
  }
}

Deno.test("useKuromojiSenryu: 未設定なら true（既定 ON。§6 に見積りを明記）", async () => {
  assertEquals(await readKuromojiGate(undefined), true);
  // .env に空で置かれている状態も既定のまま
  assertEquals(await readKuromojiGate(""), true);
});

Deno.test("useKuromojiSenryu: 0 / false / off / no で倒せる（逃げ道）", async () => {
  assertEquals(await readKuromojiGate("0"), false);
  assertEquals(await readKuromojiGate("false"), false);
  assertEquals(await readKuromojiGate("FALSE"), false);
  assertEquals(await readKuromojiGate("off"), false);
  assertEquals(await readKuromojiGate("no"), false);
  assertEquals(await readKuromojiGate(" 0 "), false);
});

Deno.test("useKuromojiSenryu: 意図の読めない値では倒さない（誤記で機能が死なない）", async () => {
  assertEquals(await readKuromojiGate("1"), true);
  assertEquals(await readKuromojiGate("true"), true);
  assertEquals(await readKuromojiGate("disable"), true);
  assertEquals(await readKuromojiGate("offf"), true);
});

/** 受け取った S2C を溜める接続。bot の発話を確かめるのに使う */
class RecordingLink implements ClientLink {
  readonly id = crypto.randomUUID();
  readonly received: S2C[] = [];
  constructor(readonly userId: string | null = "testUser") {}
  send(msg: S2C): void {
    this.received.push(msg);
  }
  close(): void {}
}

/** せりが出した川柳の発話だけを取り出す */
function senryuChats(link: RecordingLink): number {
  return link.received.filter((m) => m.t === "chat" && m.message.botKind === "senryu").length;
}

Deno.test("startServer: EN_SENRYU_KUROMOJI=0 なら せり は かなのみで判定する", async () => {
  const saved = Deno.env.get(KUROMOJI_ENV_KEY);
  Deno.env.set(KUROMOJI_ENV_KEY, "0");
  const cwd = Deno.cwd();
  const temp = await Deno.makeTempDir();
  Deno.chdir(temp);
  const handle = startServer(0);
  const link = new RecordingLink("senryuOwner");
  try {
    handle.manager.handle(link, { t: "createRoom", nickname: "ホスト", visibility: "private" });
    // 倒してあるので漢字混じりは拾えない。辞書を読み込まないことがこの分岐の目的
    handle.manager.handle(link, { t: "chat", text: "古池や蛙飛び込む水の音" });
    assertEquals(senryuChats(link), 0, "倒してあるのに漢字混じりを拾っている");
    // かなの句は拾う。判定そのものは startServer に配線されている
    handle.manager.handle(link, { t: "chat", text: "ふるいけやかわずとびこむみずのおと" });
    assertEquals(senryuChats(link), 1, "せりが startServer に配線されていない");
  } finally {
    await handle.shutdown();
    Deno.chdir(cwd);
    if (saved === undefined) Deno.env.delete(KUROMOJI_ENV_KEY);
    else Deno.env.set(KUROMOJI_ENV_KEY, saved);
    await Deno.remove(temp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// サンドボックスゲーム（docs/design/game-sandbox.md）
// ---------------------------------------------------------------------------

/** 検証を通る最小のマニフェスト1件分 */
function validManifestGame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "reflex",
    title: "反射神経バトル",
    description: "緑になったら押す",
    file: "reflex.js",
    minPlayers: 2,
    maxPlayers: 10,
    author: "ちいかわ",
    ...overrides,
  };
}

/** 検証を通る最小のマニフェスト本体 */
function validManifest(games: Record<string, unknown>[] = [validManifestGame()]) {
  return { version: 1, games };
}

Deno.test("parseSandboxManifest: 正しいマニフェストを解釈できる（§6.2）", () => {
  const parsed = parseSandboxManifest(JSON.stringify(validManifest()));
  assertExists(parsed);
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0], {
    id: "reflex",
    title: "反射神経バトル",
    description: "緑になったら押す",
    file: "reflex.js",
    minPlayers: 2,
    maxPlayers: 10,
    author: "ちいかわ",
    dev: false,
  });
});

Deno.test("parseSandboxManifest: dev を省略すると false 扱い、true も受理する", () => {
  const parsed = parseSandboxManifest(
    JSON.stringify(validManifest([validManifestGame({ dev: true })])),
  );
  assertExists(parsed);
  assertEquals(parsed[0].dev, true);
});

Deno.test("parseSandboxManifest: JSON として壊れている・オブジェクトでないと null", () => {
  assertEquals(parseSandboxManifest("{ invalid json"), null);
  assertEquals(parseSandboxManifest("[]"), null);
  assertEquals(parseSandboxManifest("null"), null);
  assertEquals(parseSandboxManifest('"string"'), null);
});

Deno.test("parseSandboxManifest: version が 1 以外なら null（§6.2）", () => {
  assertEquals(parseSandboxManifest(JSON.stringify({ ...validManifest(), version: 2 })), null);
  assertEquals(parseSandboxManifest(JSON.stringify({ games: [validManifestGame()] })), null);
});

Deno.test("parseSandboxManifest: games が空配列・51件以上・配列以外なら null（1..50件、§6.2）", () => {
  assertEquals(parseSandboxManifest(JSON.stringify(validManifest([]))), null);
  assertEquals(
    parseSandboxManifest(JSON.stringify({ ...validManifest(), games: "not-array" })),
    null,
  );
  const many = Array.from(
    { length: 51 },
    (_v, i) => validManifestGame({ id: `game${i}`, file: `game${i}.js` }),
  );
  assertEquals(parseSandboxManifest(JSON.stringify(validManifest(many))), null);
  // 50件ちょうどは受理される
  const fifty = many.slice(0, 50);
  assertExists(parseSandboxManifest(JSON.stringify(validManifest(fifty))));
});

Deno.test("parseSandboxManifest: id が正規表現に違反する・重複すると null（§6.2）", () => {
  assertEquals(
    parseSandboxManifest(JSON.stringify(validManifest([validManifestGame({ id: "Reflex" })]))),
    null,
    "大文字は id の正規表現に違反する",
  );
  assertEquals(
    parseSandboxManifest(
      JSON.stringify(validManifest([validManifestGame({ id: "a".repeat(33) })])),
    ),
    null,
    "32文字を超える id は違反する",
  );
  assertEquals(
    parseSandboxManifest(
      JSON.stringify(
        validManifest([
          validManifestGame({ id: "dup", file: "dup.js" }),
          validManifestGame({ id: "dup", file: "dup.js", title: "別タイトル" }),
        ]),
      ),
    ),
    null,
    "id の重複は違反する",
  );
});

Deno.test("parseSandboxManifest: file が id + '.js' と一致しないと null（§6.2 パストラバーサル対策）", () => {
  assertEquals(
    parseSandboxManifest(
      JSON.stringify(validManifest([validManifestGame({ file: "../evil.js" })])),
    ),
    null,
  );
});

Deno.test("parseSandboxManifest: title/description/author の文字数・制御文字を検証する（§6.2）", () => {
  assertEquals(
    parseSandboxManifest(JSON.stringify(validManifest([validManifestGame({ title: "" })]))),
    null,
    "title は1文字以上",
  );
  assertEquals(
    parseSandboxManifest(
      JSON.stringify(validManifest([validManifestGame({ title: "あ".repeat(21) })])),
    ),
    null,
    "title は20文字以内",
  );
  assertEquals(
    parseSandboxManifest(
      JSON.stringify(validManifest([validManifestGame({ description: "あ".repeat(101) })])),
    ),
    null,
    "description は100文字以内",
  );
  assertEquals(
    parseSandboxManifest(JSON.stringify(validManifest([validManifestGame({ author: "" })]))),
    null,
    "author は1文字以上",
  );
  assertEquals(
    parseSandboxManifest(
      JSON.stringify(validManifest([validManifestGame({ title: "た\nろう" })])),
    ),
    null,
    "制御文字は拒否",
  );
  // description は 0 文字（空文字）を許す
  assertExists(
    parseSandboxManifest(JSON.stringify(validManifest([validManifestGame({ description: "" })]))),
  );
});

Deno.test("parseSandboxManifest: minPlayers/maxPlayers の範囲を検証する（§6.2、§7 定員10人）", () => {
  assertEquals(
    parseSandboxManifest(
      JSON.stringify(validManifest([validManifestGame({ minPlayers: 0 })])),
    ),
    null,
    "minPlayers は1以上",
  );
  assertEquals(
    parseSandboxManifest(
      JSON.stringify(validManifest([validManifestGame({ maxPlayers: 11 })])),
    ),
    null,
    "maxPlayers は10以下",
  );
  assertEquals(
    parseSandboxManifest(
      JSON.stringify(validManifest([validManifestGame({ minPlayers: 5, maxPlayers: 4 })])),
    ),
    null,
    "maxPlayers は minPlayers 以上",
  );
  assertEquals(
    parseSandboxManifest(
      JSON.stringify(validManifest([validManifestGame({ minPlayers: 2.5 })])),
    ),
    null,
    "整数以外は拒否",
  );
});

Deno.test("filterSandboxGames: dev:true は devEnabled のときだけ残り、dev フラグ自体は公開型に出ない", () => {
  const games = [
    { ...validManifestGame(), dev: false } as SandboxGameInfo & { dev: boolean },
    { ...validManifestGame({ id: "hidden", file: "hidden.js" }), dev: true } as
      & SandboxGameInfo
      & { dev: boolean },
  ];
  const prod = filterSandboxGames(games, false);
  assertEquals(prod.map((g) => g.id), ["reflex"]);
  assertEquals(Object.hasOwn(prod[0], "dev"), false);

  const dev = filterSandboxGames(games, true);
  assertEquals(dev.map((g) => g.id).sort(), ["hidden", "reflex"]);
});

/** 一時ファイルにマニフェストを書き、パスを返す。cleanup で必ず消す */
async function withTempManifest(
  content: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(path, content);
  return { path, cleanup: () => Deno.remove(path) };
}

Deno.test("GET /api/sandboxGames: マニフェストが存在しなくても 500 にせず空配列を返す", async () => {
  // public/games/manifest.json は別担当（フロント）の作業対象で、存在するかは本テストの
  // 実行タイミングに依存してしまう（実際、本セッション中に作成された）。既定パスの有無に
  // 依存せず「ファイルが無い」状態を再現するため、実在しない一時パスを明示的に渡す
  const missingDir = await Deno.makeTempDir();
  const missingPath = `${missingDir}/manifest.json`;
  const handle = startServer(0, "127.0.0.1", undefined, missingPath);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sandboxGames`);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { games: [] });
  } finally {
    await handle.shutdown();
    await Deno.remove(missingDir, { recursive: true });
  }
});

Deno.test("GET /api/sandboxGames: 既定パス（public/games/manifest.json）を読んでも 500 にならない", async () => {
  // 実在してもしなくても 200 を返すことだけを確認する（中身は上のテストで別途検証済み）
  const handle = startServer(0);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sandboxGames`);
    assertEquals(res.status, 200);
    const body = await res.json() as { games: unknown[] };
    assert(Array.isArray(body.games));
  } finally {
    await handle.shutdown();
  }
});

Deno.test("GET /api/sandboxGames: 壊れたマニフェストも 500 にせず空配列を返す", async () => {
  const { path, cleanup } = await withTempManifest("{ not valid json");
  const handle = startServer(0, "127.0.0.1", undefined, path);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sandboxGames`);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { games: [] });
  } finally {
    await handle.shutdown();
    await cleanup();
  }
});

Deno.test("GET /api/sandboxGames: 正しいマニフェストの内容を返し、dev:true は既定で隠す（§6.2 / §8.2）", async () => {
  const manifest = validManifest([
    validManifestGame(),
    validManifestGame({ id: "_probe", file: "_probe.js", title: "検証用", dev: true }),
  ]);
  const { path, cleanup } = await withTempManifest(JSON.stringify(manifest));
  const savedDev = Deno.env.get("EN_SANDBOX_DEV");
  Deno.env.delete("EN_SANDBOX_DEV");
  const handle = startServer(0, "127.0.0.1", undefined, path);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sandboxGames`);
    assertEquals(res.status, 200);
    const body = await res.json() as { games: SandboxGameInfo[] };
    assertEquals(body.games.map((g) => g.id), ["reflex"]);
    assertEquals(body.games[0].file, "reflex.js");
  } finally {
    await handle.shutdown();
    await cleanup();
    if (savedDev === undefined) Deno.env.delete("EN_SANDBOX_DEV");
    else Deno.env.set("EN_SANDBOX_DEV", savedDev);
  }
});

Deno.test("GET /api/sandboxGames: EN_SANDBOX_DEV=1 のときだけ dev:true が現れる（§8.2）", async () => {
  const manifest = validManifest([
    validManifestGame(),
    validManifestGame({ id: "_probe", file: "_probe.js", title: "検証用", dev: true }),
  ]);
  const { path, cleanup } = await withTempManifest(JSON.stringify(manifest));
  const savedDev = Deno.env.get("EN_SANDBOX_DEV");
  Deno.env.set("EN_SANDBOX_DEV", "1");
  const handle = startServer(0, "127.0.0.1", undefined, path);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sandboxGames`);
    const body = await res.json() as { games: SandboxGameInfo[] };
    assertEquals(body.games.map((g) => g.id).sort(), ["_probe", "reflex"]);
  } finally {
    await handle.shutdown();
    await cleanup();
    if (savedDev === undefined) Deno.env.delete("EN_SANDBOX_DEV");
    else Deno.env.set("EN_SANDBOX_DEV", savedDev);
  }
});

Deno.test("GET /api/sandboxGames: GET 以外は 405", async () => {
  const handle = startServer(0);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sandboxGames`, {
      method: "POST",
    });
    assertEquals(res.status, 405);
    await res.body?.cancel();
  } finally {
    await handle.shutdown();
  }
});

// ---------------------------------------------------------------------------
// /sandbox/ 専用の CSP・frame-ancestors（docs/design/game-sandbox.md §2.6 / §7.4）
// ---------------------------------------------------------------------------

Deno.test("GET /sandbox/runner.html: runner 専用の CSP が付く（§2.3 / §2.4 / §2.6）", async () => {
  const handle = startServer(0);
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/sandbox/runner.html`);
    const csp = res.headers.get("content-security-policy");
    assertExists(csp);
    for (
      const directive of [
        "default-src 'none'",
        "connect-src 'none'",
        "worker-src 'none'",
        "'unsafe-eval'",
        "frame-ancestors 'self'",
      ]
    ) {
      assert(csp.includes(directive), `CSP に ${directive} が含まれていない: ${csp}`);
    }
    await res.body?.cancel();
  } finally {
    await handle.shutdown();
  }
});

Deno.test("GET /（アプリ本体）: frame-ancestors は 'none' のまま変わらない（既存への影響なし）", async () => {
  const kv = await Deno.openKv(":memory:");
  const handle = startServer(0, "127.0.0.1", kv);
  try {
    for (const path of ["/", "/room/chat.js"]) {
      const res = await fetch(`http://127.0.0.1:${handle.port}${path}`);
      const csp = res.headers.get("content-security-policy");
      assertExists(csp, `${path} に CSP が付いていない`);
      assert(
        csp.includes("frame-ancestors 'none'"),
        `${path} の frame-ancestors が変わっている: ${csp}`,
      );
      assert(!csp.includes("worker-src 'none'"), `${path} に runner 用 CSP が漏れている: ${csp}`);
      await res.body?.cancel();
    }
  } finally {
    await handle.shutdown();
    kv.close();
  }
});

// ---------------------------------------------------------------------------
// sandboxSignal のレート制限（docs/design/game-sandbox.md §4.3）
// ---------------------------------------------------------------------------

Deno.test("ユニット: sandboxSignal のレート上限はコンストラクタで受け取った値になる", () => {
  const now = 1_000_000;
  const soft = new MessageRateLimiter(WS_SANDBOX_RATE_MAX, () => now);
  for (let i = 1; i <= WS_SANDBOX_RATE_MAX; i++) {
    assertEquals(soft.accept(), true, `sandbox ソフト枠の${i}件目は受理される`);
  }
  assertEquals(soft.accept(), false, `sandbox ソフト枠の${WS_SANDBOX_RATE_MAX + 1}件目は違反`);

  assert(
    WS_SANDBOX_RATE_MAX < WS_SANDBOX_HARD_MAX,
    "破棄で済ませる上限より切断の上限が大きくなければ破棄の余地がない",
  );
  const hard = new MessageRateLimiter(WS_SANDBOX_HARD_MAX, () => now);
  for (let i = 1; i <= WS_SANDBOX_HARD_MAX; i++) {
    assertEquals(hard.accept(), true, `sandbox ハード枠の${i}件目は受理される`);
  }
  assertEquals(hard.accept(), false, `sandbox ハード枠の${WS_SANDBOX_HARD_MAX + 1}件目は違反`);
});

/** 1メッセージを待つ上限（ミリ秒） */
const WS_WAIT_TIMEOUT_MS = 5_000;

/** 指定ミリ秒待つ */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 条件が満たされるまでポーリングで待つ */
async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WS_WAIT_TIMEOUT_MS;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`${label} を待機中にタイムアウトしました`);
    await delay(10);
  }
}

/**
 * 簡易 WebSocket クライアント（レート制限の結合テスト専用）。
 * integration_test.ts の TestClient は担当外ファイルのため、ここでは必要最小限だけ持つ。
 */
class WsTestClient {
  private readonly socket: WebSocket;
  private readonly messages: S2C[] = [];
  closeCode: number | null = null;
  readonly closed: Promise<void>;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.onmessage = (event) => {
      this.messages.push(JSON.parse(event.data) as S2C);
    };
    this.closed = new Promise<void>((resolve) => {
      this.socket.addEventListener("close", (event) => {
        this.closeCode = event.code;
        resolve();
      }, { once: true });
    });
  }

  static connect(port: number): Promise<WsTestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const client = new WsTestClient(socket);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(client), { once: true });
      socket.addEventListener("error", () => reject(new Error("接続に失敗しました")), {
        once: true,
      });
    });
  }

  send(msg: C2S): void {
    this.socket.send(JSON.stringify(msg));
  }

  received(): S2C[] {
    return [...this.messages];
  }

  countError(code: ErrorCode): number {
    return this.messages.filter((m) => m.t === "error" && m.code === code).length;
  }

  countByType(t: S2C["t"]): number {
    return this.messages.filter((m) => m.t === t).length;
  }
}

Deno.test("結合: sandboxSignal はソフト上限を超えても切断されず、超過分だけ破棄される（別枠・§4.3）", async () => {
  const handle = startServer(0);
  const client = await WsTestClient.connect(handle.port);
  try {
    // ルーム未参加なので受理された分だけ ROOM_NOT_FOUND が返る。これで受理件数を数えられる
    const burst = WS_SANDBOX_RATE_MAX + 20;
    for (let i = 0; i < burst; i++) client.send({ t: "sandboxSignal", payload: { i } });

    await waitUntil(
      () => client.countError("ROOM_NOT_FOUND") >= WS_SANDBOX_RATE_MAX,
      "sandboxSignal ソフト上限までの受理",
    );
    // バースト後も通常メッセージは処理される（切断されていないことの確認）
    client.send({ t: "join", roomCode: "000000", nickname: "x" });
    await waitUntil(
      () => client.countError("ROOM_NOT_FOUND") >= WS_SANDBOX_RATE_MAX + 1,
      "バースト後のメッセージ処理",
    );

    assertEquals(client.closeCode, null, "ソフト上限の超過では切断されない");
    assertEquals(
      client.countError("ROOM_NOT_FOUND"),
      WS_SANDBOX_RATE_MAX + 1,
      "sandboxSignal はソフト上限までのみ受理され、後続の join 1件が加わる",
    );
    assertEquals(client.countError("RATE_LIMITED"), 1, "RATE_LIMITED の通知は判定窓につき1回");
  } finally {
    if (client.closeCode === null) {
      client.send({ t: "leave" });
    }
    await handle.shutdown();
  }
});

Deno.test("結合: sandboxSignal はハードキャップを超えると乱用とみなして切断される（§4.3）", async () => {
  const handle = startServer(0);
  const client = await WsTestClient.connect(handle.port);
  try {
    const burst = WS_SANDBOX_HARD_MAX + 1;
    for (let i = 0; i < burst; i++) client.send({ t: "sandboxSignal", payload: { i } });

    await Promise.race([client.closed, delay(WS_WAIT_TIMEOUT_MS)]);
    assertEquals(client.closeCode, 1008, "policy violation の 1008 で切断される");
    const last = client.received()[client.received().length - 1];
    assertExists(last);
    assert(last.t === "error" && last.code === "RATE_LIMITED", "切断前に RATE_LIMITED が届く");
  } finally {
    await handle.shutdown();
  }
});

Deno.test("結合: sandboxSignal の連投は一般枠（20件/秒）を消費しない（§4.3）", async () => {
  const handle = startServer(0);
  const client = await WsTestClient.connect(handle.port);
  try {
    // 一般枠の上限を超える件数を sandboxSignal として送っても、一般枠は減らない
    const burst = WS_RATE_MAX * 2;
    for (let i = 0; i < burst; i++) client.send({ t: "sandboxSignal", payload: { i } });
    await waitUntil(
      () => client.countByType("error") >= WS_SANDBOX_RATE_MAX,
      "sandboxSignal バーストの処理完了",
    );
    assertEquals(client.closeCode, null, "一般枠の 20件/秒 では切断されていない");
  } finally {
    await handle.shutdown();
  }
});
