/**
 * public/app.js の「卓から離れたあとの後始末」のテスト。
 *
 * 見張るのは次の2つ。どちらも卓を出た後に残る痕跡の話で、
 * 自動再接続（app_reconnect_test.ts）とは別の経路。
 *
 *   1. キック（§3.1）: サーバーは {t:"kicked"} を送った直後にソケットを 1000 で閉じる。
 *      閉じられたままだと、お座敷一覧の画面は出ているのに WS だけが死んでおり、
 *      以降どの卓にも入れなくなる（手動リロード以外に復帰手段が無い）
 *   2. 順位表 #result: #room / #phase の子ではなく renderAll() が畳む対象にも
 *      入っていないため、片付けないと他人のあだ名と得点が一覧の画面にも
 *      次の卓にも残り続ける
 *
 * クライアントのファイルだが、app.js が触るブラウザ API は DOM・fetch・WebSocket・
 * sessionStorage・タイマーだけなので、偽物を渡せば Deno から素の JavaScript として
 * 動かせる（app_reconnect_test.ts と同じ手口）。
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createFakeDocument, type FakeElement } from "./fake_dom.ts";

const APP_JS = fromFileUrl(new URL("../../public/app.js", import.meta.url));
const source = await Deno.readTextFile(APP_JS);

/** サーバーが退室・キックで閉じるときのコード（server/main.ts の ClientLink.close の既定） */
const NORMAL_CLOSE_CODE = 1000;

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

  /** 接続確立 */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** サーバーからの切断 */
  closeFromServer(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** S2C を1件流し込む */
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** 送ったメッセージを構造化して取り出す */
  parsedSent(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

/** 何もしないダミーモジュール（vc.js / chat.js などの代わり） */
function stubModule(
  name: string,
  calls: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return new Proxy({ ...extra }, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return () => {
        calls.push(`${name}.${prop}`);
      };
    },
  });
}

type Harness = {
  storage: Map<string, string>;
  socket(): FakeSocket;
  /** いま何本目のソケットか（張り直したかどうかの判定に使う） */
  socketCount(): number;
  element(id: string): FakeElement;
  errorBox(): FakeElement;
};

/** app.js を偽の環境で読み込む */
async function load(): Promise<Harness> {
  FakeSocket.instances = [];
  const { document } = createFakeDocument();
  const storage = new Map<string, string>();
  const calls: string[] = [];
  // index.html の #result は畳んだ状態で始まる（class="card block hidden"）。
  // 偽 DOM は class を持たない要素を作るので、初期値だけ本物に合わせておく
  document.getElementById("result").className = "card block hidden";

  // 起動時に叩く API はすべて「使えない」応答にする（app.js は握りつぶして続行する）
  const fetchStub = () =>
    Promise.resolve({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    });

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
    source,
  );

  factory(
    document,
    fetchStub,
    FakeSocket,
    {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    { getGuestProfile: () => ({ nickname: "", tags: [] }) },
    { consumePendingCreateRoom: () => null, consumePendingJoinRoom: () => null },
    { protocol: "http:", host: "127.0.0.1:8000", href: "" },
    (fn: () => void) => {
      // このテストは待ち時間を見ないので、予約だけ受け取って走らせない
      void fn;
      return 0;
    },
    () => {},
    stubModule("VC", calls, {
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
    stubModule("Voice", calls, { getState: () => ({ enabled: false }), isSupported: () => false }),
    stubModule("Chat", calls),
    stubModule("Bot", calls, { getState: () => ({ bots: {}, isHost: false }) }),
    stubModule("Sound", calls, { GAYA_CORRIDOR: 0.32, GAYA_ROOM: 0.06 }),
  );

  // start() は fetch を await してから connect() する。その解決を待つ
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    storage,
    socket: () => FakeSocket.instances[FakeSocket.instances.length - 1],
    socketCount: () => FakeSocket.instances.length,
    element: (id: string) => document.getElementById(id),
    errorBox: () => document.getElementById("error"),
  };
}

/** 卓に入っている状態を作る（roomState を1件流してセッションを保存させる） */
function enterRoom(h: Harness, code = "123456", session = "sess-abc"): void {
  h.socket().open();
  roomState(h, code, session);
}

/** roomState だけを1件流す（ソケットは既に開いている前提） */
function roomState(h: Harness, code: string, session: string): void {
  h.socket().receive({
    t: "roomState",
    snapshot: {
      code,
      session,
      youId: "p1",
      youAreHost: true,
      hostId: "p1",
      players: [],
      capacity: 6,
      availableGames: [],
      selectedGameId: null,
      description: "",
      tags: [],
      chat: [],
      phase: "lobby",
      deadline: null,
      view: { phase: "lobby", selectedGameId: null },
    },
  });
}

/**
 * キックされて、サーバーがソケットを閉じるところまで進める。
 *
 * app.js が張り直したときだけ、その新しいソケットを開く（ブラウザが繋ぐ役）。
 * 閉じられたソケットをテスト側から開き直さないのが肝で、そこを手で開くと
 * 「張り直していない」という不具合そのものを覆い隠してしまう
 */
function kickAndClose(h: Harness): void {
  const before = h.socket();
  before.receive({ t: "kicked" });
  // server/rooms.ts は {t:"kicked"} の直後に close() する。既定コードは 1000
  before.closeFromServer(NORMAL_CLOSE_CODE);
  if (h.socket() !== before) h.socket().open();
}

/** 順位表を1回出す */
function showScores(h: Harness): void {
  h.socket().receive({
    t: "finalResult",
    scores: [
      { rank: 1, nickname: "ましろ", roundScore: 3, totalScore: 12 },
      { rank: 2, nickname: "たろう", roundScore: 1, totalScore: 8 },
    ],
  });
}

// ---------------------------------------------------------------------------
// キック（H-10）
// ---------------------------------------------------------------------------

Deno.test("app.js: キックでソケットを閉じられたら張り直す", async () => {
  const h = await load();
  enterRoom(h);
  const before = h.socketCount();

  kickAndClose(h);

  assertEquals(h.socketCount(), before + 1, "張り直さないと以降どの卓にも入れない");
});

Deno.test("app.js: キック後の張り直しでは「再読み込みしてください」を出さない", async () => {
  const h = await load();
  enterRoom(h);

  kickAndClose(h);

  // 原因はサーバー障害ではないので、再読み込みを促すと誤った案内になる。
  // 繋ぎ直した拍子に理由が消えても「勝手に一覧へ戻された」ようにしか見えない
  assertEquals(h.errorBox().textContent, "ホストにお引き取りいただきました");
});

Deno.test("app.js: キック後の張り直しで、追い出された卓へ自動では入り直さない", async () => {
  const h = await load();
  enterRoom(h, "123456");

  kickAndClose(h);

  const joins = h.socket().parsedSent().filter((m) => m.t === "join");
  assertEquals(joins, [], "残したトークンは手で入り直すとき用で、自動復帰の合図ではない");
});

Deno.test("app.js: キックされても、そのあと別の卓に入れる", async () => {
  const h = await load();
  enterRoom(h, "123456");

  kickAndClose(h);

  h.element("code").value = "654321";
  h.element("nickname").value = "ましろ";
  h.element("join").click();

  const joins = h.socket().parsedSent().filter((m) => m.t === "join");
  const last = joins[joins.length - 1];
  assertExists(last, "張り直したソケットで join を送れる");
  assertEquals(last.roomCode, "654321");
  assertEquals(last.session, undefined, "別の卓に前のトークンは関係ない");
  // 閉じたままのソケットに送ろうとしたときの文言が出ていないこと
  assert(
    !h.errorBox().textContent.includes("サーバーに接続していません"),
    "WS が生きている",
  );
});

Deno.test("app.js: キック後に同じ卓へ入り直すときは、ブロック判定用のトークンを積む", async () => {
  const h = await load();
  enterRoom(h, "123456", "sess-abc");

  kickAndClose(h);

  h.element("code").value = "123456";
  h.element("join").click();

  const joins = h.socket().parsedSent().filter((m) => m.t === "join");
  const last = joins[joins.length - 1];
  assertExists(last);
  // 積まないとサーバーは blockedSessions を照合できず、追い出した人が戻れてしまう（§3.1）
  assertEquals(last.session, "sess-abc", "キックされた卓のトークンは残っている");
});

// ---------------------------------------------------------------------------
// 順位表（H-11）
// ---------------------------------------------------------------------------

Deno.test("app.js: 順位表は結果が届いたら出る", async () => {
  const h = await load();
  enterRoom(h);

  showScores(h);

  assert(!h.element("result").classList.contains("hidden"), "結果が出ている");
  assertEquals(h.element("result-list").children.length, 2);
});

Deno.test("app.js: 卓を出ると順位表が消える", async () => {
  const h = await load();
  enterRoom(h);
  showScores(h);

  h.element("leave").click();

  assert(h.element("result").classList.contains("hidden"), "一覧の画面に順位表を残さない");
  assertEquals(h.element("result-title").textContent, "");
  assertEquals(h.element("result-list").children.length, 0, "他人のあだ名と得点を残さない");
});

Deno.test("app.js: キックされたときも順位表が消える", async () => {
  const h = await load();
  enterRoom(h);
  showScores(h);

  kickAndClose(h);

  assert(h.element("result").classList.contains("hidden"));
  assertEquals(h.element("result-list").children.length, 0);
});

Deno.test("app.js: 別の卓に入っても、前の卓の順位表が残らない", async () => {
  const h = await load();
  enterRoom(h, "123456");
  showScores(h);

  // 退室 → 張り直し → 別の卓へ
  h.element("leave").click();
  h.socket().closeFromServer(NORMAL_CLOSE_CODE);
  h.socket().open();
  roomState(h, "654321", "sess-xyz");

  assert(
    h.element("result").classList.contains("hidden"),
    "採点していない卓で前の卓の順位が出ていてはいけない",
  );
  assertEquals(h.element("result-list").children.length, 0);
});
