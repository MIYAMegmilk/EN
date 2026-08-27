/**
 * public/app.js / public/room/chat.js の「壊れかけたときに何が起きるか」のテスト。
 *
 * 見張るのは次の5つ。どれも通常の操作や、ごく普通に起きる通信の失敗で踏む。
 *
 *   1. 起動（M-04）: GET /api/me が失敗しても、卓への接続（connect）まで必ず到達すること。
 *      refreshAccount() の fetch が裸だと、start() の Promise.all ごと転んで
 *      connect() が呼ばれない。利用者から見ると「アプリが起動しない」形になり、
 *      原因が /api/me にあるとは気づけない。サーバーの再起動直後は全要求が
 *      一瞬こけるので、そのタイミングで開いた人が必ず踏む
 *   2. お会計（M-06）: ログアウトがこのタブの sessionStorage を残さないこと。
 *      卓の再接続トークンを持ち越すと、別アカウントでログインし直した直後に
 *      前の卓へ join を送ってしまう（キック経路ではトークンを意図的に残すため）
 *   3. チャット（M-13）: 送れなかったときに入力欄を消さないこと
 *   4. 品書き（M-08）: 中身が変わっていない間は札を作り直さないこと。
 *      作り直すと、選んでいる最中に誰かが入室しただけでフォーカスが飛ぶ
 *   5. ビューモジュールへ渡す api（監査 07 の Medium）: mount した瞬間の値で固まらないこと。
 *      進行中の卓へ途中参加すると roomState より先に gameView が届くことがあり、
 *      そのとき api.youId が null のまま二度と更新されない
 *   6. 受け渡し（M-05 の一部）: 再接続が勝って、廊下で選んだ卓が使われなかったときに、
 *      黙って別の結果にせず案内を出すこと
 *
 * クライアントのファイルだが、app.js が触るブラウザ API は DOM・fetch・WebSocket・
 * sessionStorage・タイマーだけなので、偽物を渡せば Deno から素の JavaScript として
 * 動かせる（app_reconnect_test.ts / app_kick_result_test.ts と同じ手口）。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createFakeDocument, type FakeElement } from "./fake_dom.ts";

const read = (rel: string) => Deno.readTextFile(fromFileUrl(new URL(rel, import.meta.url)));
const appSource = await read("../../public/app.js");
const chatSource = await read("../../public/room/chat.js");

// ---------------------------------------------------------------------------
// 偽の環境
// ---------------------------------------------------------------------------

/** 開かれた WebSocket の偽物。テストからイベントを起こせるようにする */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** S2C を1件流し込む */
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  parsedSent(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

/** 何もしないダミーモジュール（vc.js などの代わり） */
function stubModule(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy({ ...extra }, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return () => {};
    },
  });
}

/** fetch の応答。"reject" は通信断（fetch そのものが投げる） */
type Reply = { ok: boolean; status: number; body: unknown } | "reject";

const UNAVAILABLE: Reply = { ok: false, status: 503, body: {} };

/** app.js の内部から取り出したいもの */
type App = {
  // deno-lint-ignore no-explicit-any
  state: any;
  send: (msg: unknown) => boolean;
  gameModuleApi: () => { youId: string | null; isHost: boolean; serverNow: () => number };
};

type Options = {
  /** GET /api/me の応答 */
  me?: Reply;
  /** POST /api/auth/logout の応答 */
  logout?: Reply;
  guestTags?: string[];
  pendingJoin?: { roomCode: string } | null;
  /** 起動前から sessionStorage に入れておく値 */
  storage?: Record<string, string>;
  /** 本物の chat.js を Chat として渡す（送信経路まで通しで試す） */
  realChat?: boolean;
};

type Harness = {
  app: App;
  storage: Map<string, string>;
  location: { href: string };
  fetchPaths: string[];
  /** setGuestProfile に渡された値（ログアウトの後始末の確認用） */
  guestWrites: Array<{ nickname: string; tags: string[] }>;
  consumed: string[];
  element(id: string): FakeElement;
  socket(): FakeSocket;
  socketCount(): number;
  /** 溜まったマイクロタスクを流す */
  settle(): Promise<void>;
  /** #chat-form の submit を起こす */
  submitChat(): void;
};

function replyTo(reply: Reply): Promise<unknown> {
  if (reply === "reject") return Promise.reject(new TypeError("Failed to fetch"));
  return Promise.resolve({
    ok: reply.ok,
    status: reply.status,
    json: () => Promise.resolve(reply.body),
  });
}

async function load(options: Options = {}): Promise<Harness> {
  FakeSocket.instances = [];
  const { document } = createFakeDocument();
  const storage = new Map<string, string>(Object.entries(options.storage ?? {}));
  const location = { href: "/index.html" };
  const fetchPaths: string[] = [];
  const guestWrites: Array<{ nickname: string; tags: string[] }> = [];
  const consumed: string[] = [];
  document.getElementById("result").className = "card block hidden";

  const fetchStub = (path: string) => {
    fetchPaths.push(path);
    if (path === "/api/me") return replyTo(options.me ?? UNAVAILABLE);
    if (path === "/api/auth/logout") return replyTo(options.logout ?? UNAVAILABLE);
    return replyTo(UNAVAILABLE);
  };

  // 本物の chat.js。IIFE が window に Chat を置くので、偽の window を渡して受け取る
  const chatGlobal: Record<string, unknown> = {};
  if (options.realChat === true) {
    new Function("window", "document", chatSource)(chatGlobal, document);
  }

  const factory = new Function(
    "document",
    "fetch",
    "WebSocket",
    "sessionStorage",
    "GuestProfile",
    "RoomHandoff",
    "location",
    "setTimeout",
    "clearTimeout",
    "VC",
    "Voice",
    "Chat",
    "Bot",
    "Sound",
    `${appSource}\n; return { state, send, gameModuleApi };`,
  );

  const app = factory(
    document,
    fetchStub,
    FakeSocket,
    {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    {
      getGuestProfile: () => ({ nickname: "", tags: options.guestTags ?? [] }),
      setGuestProfile: (profile: { nickname: string; tags: string[] }) => {
        guestWrites.push(profile);
      },
    },
    {
      consumePendingCreateRoom: () => {
        consumed.push("create");
        return null;
      },
      consumePendingJoinRoom: () => {
        consumed.push("join");
        return options.pendingJoin ?? null;
      },
    },
    location,
    // 待ち時間は見ない。予約だけ受け取って走らせない
    (_fn: () => void) => 0,
    () => {},
    stubModule({
      getState: () => ({
        active: false,
        muted: false,
        camera: false,
        eligible: true,
        peers: [],
        quality: null,
      }),
      join: () => Promise.resolve(false),
    }),
    stubModule({ getState: () => ({ enabled: false }), isSupported: () => false }),
    options.realChat === true ? chatGlobal.Chat : stubModule(),
    stubModule({ getState: () => ({ bots: {}, isHost: false }) }),
    stubModule({ GAYA_CORRIDOR: 0.32, GAYA_ROOM: 0.06 }),
  ) as App;

  // start() は fetch を await してから connect() する。その解決を待つ。
  // /api/me が転ぶ経路も見るので、素通しでは足りない。数回まわす
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await settle();

  const element = (id: string) => document.getElementById(id);
  return {
    app,
    storage,
    location,
    fetchPaths,
    guestWrites,
    consumed,
    element,
    socket: () => FakeSocket.instances[FakeSocket.instances.length - 1],
    socketCount: () => FakeSocket.instances.length,
    settle,
    submitChat: () => {
      for (const handler of element("chat-form").handlers.get("submit") ?? []) {
        handler({ preventDefault: () => {} });
      }
    },
  };
}

/** 卓に入っている状態を作る。availableGames は品書きの札になる */
function roomState(
  h: Harness,
  games: Array<{ id: string; title: string }> = [],
  overrides: Record<string, unknown> = {},
): void {
  h.socket().receive({
    t: "roomState",
    snapshot: {
      code: "123456",
      session: "sess-abc",
      youId: "p1",
      youAreHost: true,
      hostId: "p1",
      players: [],
      capacity: 6,
      availableGames: games.map((g) => ({
        id: g.id,
        title: g.title,
        description: "",
        kind: "module",
        minPlayers: 2,
        maxPlayers: 6,
        scoring: "vote",
        rounds: 3,
      })),
      selectedGameId: null,
      description: "",
      tags: [],
      chat: [],
      phase: "lobby",
      deadline: null,
      view: { phase: "lobby", selectedGameId: null },
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// 1. 起動（M-04）: /api/me が失敗しても卓には繋がる
// ---------------------------------------------------------------------------

Deno.test("app.js: /api/me が返れば、ログイン状態を出して接続する（正常系）", async () => {
  const h = await load({ me: { ok: true, status: 200, body: { userId: "taro2026" } } });

  assertEquals(h.element("account-status").textContent, "ログイン中: taro2026");
  assertEquals(h.socketCount(), 1, "WebSocket を開いている");
});

Deno.test("app.js: /api/me が通信断でも WebSocket は開く（異常系・起動が止まらない）", async () => {
  const h = await load({ me: "reject" });

  // refreshAccount() が投げると start() の Promise.all ごと転び、その後ろの
  // connect() が呼ばれない。利用者には「アプリが起動しない」としか見えないが、
  // 原因は /api/me が一瞬こけただけ（VPS の再起動直後に必ず起きる）
  assertEquals(h.socketCount(), 1, "/api/me の失敗で卓への接続まで巻き添えにしない");
});

Deno.test("app.js: /api/me が通信断のとき「確認中…」で固まらない（異常系）", async () => {
  const h = await load({ me: "reject" });

  const status = h.element("account-status").textContent;
  assert(status.length > 0, "HTML の初期値『確認中…』のまま固まらない");
  assertFalse(
    status === "未ログイン",
    "確認できなかっただけなのに『未ログイン』と言い切ると、本人の落ち度に見える",
  );
  assertFalse(
    h.element("login-link").className.split(" ").includes("hidden"),
    "確認できないときは未ログイン相当の導線を出しておく",
  );
});

Deno.test("app.js: /api/me が 503 なら未ログイン扱いで接続する（境界値）", async () => {
  const h = await load({ me: { ok: false, status: 503, body: {} } });

  // 返事は返っている（通信はできている）ので、こちらは従来どおり「未ログイン」
  assertEquals(h.element("account-status").textContent, "未ログイン");
  assertEquals(h.socketCount(), 1);
});

// ---------------------------------------------------------------------------
// 2. お会計（M-06）: ログアウトの後始末
// ---------------------------------------------------------------------------

async function logout(h: Harness): Promise<void> {
  h.element("logout").click();
  await h.settle();
}

Deno.test("app.js: お会計で卓の再接続トークンを捨てる（異常系・別アカウントへの持ち越し）", async () => {
  const h = await load({
    me: { ok: true, status: 200, body: { userId: "taro2026" } },
    logout: { ok: true, status: 200, body: {} },
    // キック経路は §3.1 のブロック判定のためトークンを意図的に残す。
    // その状態でお会計を押せてしまうのが問題の入り口
    storage: { "en-session": JSON.stringify({ code: "654321", session: "sess-xyz" }) },
  });

  await logout(h);

  assertEquals(h.storage.get("en-session"), undefined, "次のログイン後に前の卓へ join させない");
  assertEquals(h.location.href, "/login.html");
});

Deno.test("app.js: お会計でゲストの一時プロフィールも消す（共用端末）", async () => {
  const h = await load({
    me: { ok: true, status: 200, body: { userId: "taro2026" } },
    logout: { ok: true, status: 200, body: {} },
  });

  await logout(h);

  assertEquals(h.guestWrites.length, 1, "ゲストのあだ名・タグを空に戻す");
  assertEquals(h.guestWrites[0], { nickname: "", tags: [] });
});

Deno.test("app.js: お会計は受け渡し待ちの卓も捨てる（合言葉を残さない）", async () => {
  const h = await load({
    me: { ok: true, status: 200, body: { userId: "taro2026" } },
    logout: { ok: true, status: 200, body: {} },
  });
  const before = h.consumed.length;

  await logout(h);

  // consume は「読んで捨てる」。起動時の1組に加えて、ログアウトでもう1組
  assertEquals(h.consumed.slice(before), ["create", "join"]);
});

Deno.test("app.js: お会計は通信できなくてもログイン画面へ進む（異常系）", async () => {
  const h = await load({
    me: { ok: true, status: 200, body: { userId: "taro2026" } },
    logout: "reject",
    storage: { "en-session": JSON.stringify({ code: "654321", session: "sess-xyz" }) },
  });

  await logout(h);

  assertEquals(h.location.href, "/login.html", "押しても何も起きない、にしない");
  assertEquals(h.storage.get("en-session"), undefined, "後始末はやり切る");
});

// ---------------------------------------------------------------------------
// 3. チャット（M-13）: 送れなかったら本文を残す
// ---------------------------------------------------------------------------

Deno.test("app.js: send は繋がっていなければ false を返す（境界値）", async () => {
  const h = await load();

  // まだ onopen していない（ソケットは作られているが state.ws は open 前）
  h.socket().readyState = 3;
  assertEquals(h.app.send({ t: "chat", text: "test" }), false);
  assertEquals(h.element("error").textContent, "サーバーに接続していません");
});

Deno.test("app.js: send は送れたら true を返す（正常系）", async () => {
  const h = await load();
  h.socket().open();

  assertEquals(h.app.send({ t: "skipPhase" }), true);
});

Deno.test("chat.js: 送信に失敗したら入力欄の本文を消さない（異常系）", async () => {
  const h = await load({ realChat: true });
  h.socket().open();
  roomState(h);
  // サーバーの再起動中。app.js の send は showError して false を返す
  h.socket().readyState = 3;

  const long = "今日の飲み会、ほんとうに楽しかったです。またやりましょう";
  h.element("chat-text").value = long;
  h.submitChat();

  assertEquals(h.element("chat-text").value, long, "打った長文が消えると書き直しになる");
  assertEquals(h.element("error").textContent, "サーバーに接続していません");
});

Deno.test("chat.js: 送信できたら入力欄を空にする（正常系）", async () => {
  const h = await load({ realChat: true });
  h.socket().open();
  roomState(h);

  h.element("chat-text").value = "かんぱーい";
  h.submitChat();

  assertEquals(h.element("chat-text").value, "");
  const chats = h.socket().parsedSent().filter((m) => m.t === "chat");
  assertEquals(chats.length, 1);
  assertEquals(chats[0].text, "かんぱーい");
});

// ---------------------------------------------------------------------------
// 4. 品書き（M-08）: 中身が同じなら札を作り直さない
// ---------------------------------------------------------------------------

const GAMES = [{ id: "prompt", title: "大喜利" }, { id: "wordwolf", title: "ワードウルフ" }];

Deno.test("app.js: 卓の状態が変わっても、品書きの中身が同じなら札を作り直さない", async () => {
  const h = await load();
  h.socket().open();
  roomState(h, GAMES);

  const list = h.element("game-list");
  assertEquals(list.children.length, 2);
  const chosen = list.children[1];

  // 誰かが入室した（players が変わっただけ）。roomState は品書きも組み直させる
  roomState(h, GAMES, { players: [{ id: "p2", nickname: "たろう", score: 0 }] });

  assertEquals(
    h.element("game-list").children[1],
    chosen,
    "同じ札が残っていないと、選んでいる最中にフォーカスが <body> に落ちる",
  );
});

Deno.test("app.js: 品書きの中身が変われば作り直す（正常系）", async () => {
  const h = await load();
  h.socket().open();
  roomState(h, GAMES);
  const chosen = h.element("game-list").children[0];

  roomState(h, [{ id: "draw", title: "お絵かき" }]);

  const list = h.element("game-list");
  assertEquals(list.children.length, 1);
  assertFalse(list.children[0] === chosen, "並ぶものが変わったら作り直す");
  assertEquals(list.children[0].dataset.choice, "official:draw");
});

Deno.test("app.js: 札を作り直さないときも、押せるかどうかは追随する（境界値）", async () => {
  const h = await load();
  h.socket().open();
  roomState(h, GAMES);
  assertFalse(h.element("game-list").children[0].disabled, "ホストなので押せる");

  // ホストを譲った。札はそのままでよいが、押せなくなる
  roomState(h, GAMES, { youAreHost: false, hostId: "p2" });

  assert(h.element("game-list").children[0].disabled, "非ホストには押させない");
});

// ---------------------------------------------------------------------------
// 5. 受け渡し（M-05 の一部）: 黙って別の卓へ戻さない
// ---------------------------------------------------------------------------

Deno.test("app.js: 復帰が勝って廊下の選択が使われなかったときは、その旨を出す", async () => {
  const h = await load({
    pendingJoin: { roomCode: "482913" },
    storage: { "en-session": JSON.stringify({ code: "654321", session: "sess-xyz" }) },
  });

  h.socket().open();

  const sent = h.socket().parsedSent();
  assertEquals(sent[0].roomCode, "654321", "復帰の優先順位は変えていない");
  const notice = h.element("error").textContent;
  assert(notice.includes("前にいた卓"), "扉を選んだのに別の卓に入るなら、何が起きたかを伝える");
  // 「無視されました」で終わると行き止まりになる。選んだ卓へ行く道筋まで出す
  assert(notice.includes("お先に失礼"), "出る手順");
  assert(notice.includes("店内を歩く"), "選び直す手順");
});

Deno.test("app.js: 復帰だけのときは余計な案内を出さない（正常系）", async () => {
  const h = await load({
    storage: { "en-session": JSON.stringify({ code: "654321", session: "sess-xyz" }) },
  });

  h.socket().open();

  assertEquals(h.element("error").textContent, "");
});

// ---------------------------------------------------------------------------
// 5. ビューモジュールへ渡す api（audit/parts/07-client-games.md の Medium）
// ---------------------------------------------------------------------------

Deno.test("app.js: mount 後に roomState が届いても api.youId が読める（途中参加）", async () => {
  const h = await load();
  h.socket().open();

  // 進行中の卓へ入ると、roomState より先に gameView が来ることがある。
  // その時点で mount したゲームが受け取る api
  const api = h.app.gameModuleApi();
  assertEquals(api.youId, null, "まだ自分が誰か分からない");

  roomState(h);

  // 素のオブジェクトだと mount 時点の null で固まり、自分の手番も自分の回答も
  // 見分けられなくなる。ゲーム側は view に自分を指す印を持たないので直せない
  assertEquals(api.youId, "p1", "届いたあとは同じ api から読めなければならない");
});

Deno.test("app.js: api.isHost も後から届いた卓の状態に追随する", async () => {
  const h = await load();
  h.socket().open();
  const api = h.app.gameModuleApi();
  assertFalse(api.isHost);

  roomState(h);
  assert(api.isHost, "ホストになったことが伝わらないと、進行の操作を出せない");

  // ホストを譲った場合も同じ api から見えること
  roomState(h, [], { youAreHost: false, hostId: "p2" });
  assertFalse(api.isHost);
});
