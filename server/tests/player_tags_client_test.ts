/**
 * public/app.js の趣味タグまわりのテスト（§3.11 用途1）。
 *
 * 見るのは2つだけ。
 *   1. 自分のタグ（ログイン中はアカウント、ゲストは entrance.html の一時保存）を
 *      入室・卓作成・相席のメッセージに積んでいること
 *   2. 卓の参加者一覧に、他人のタグが**表示名**で出ること。サーバーは ID しか
 *      配らない（表示テキストをサーバー由来だけに保つため §3.11）ので、
 *      GET /api/tags の対応表を引けていないと英語の ID が出てしまう
 *
 * 手口は app_reconnect_test.ts と同じで、偽の DOM・fetch・WebSocket の上に
 * app.js を new Function で読み込み、Deno から素の JavaScript として動かす。
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createFakeDocument, type FakeElement } from "./fake_dom.ts";

const APP_JS = fromFileUrl(new URL("../../public/app.js", import.meta.url));
const source = await Deno.readTextFile(APP_JS);

// ---------------------------------------------------------------------------
// 偽のブラウザ環境
// ---------------------------------------------------------------------------

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

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  parsedSent(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

/** 何もしないダミーモジュール（vc.js / chat.js などの代わり） */
function stubModule(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy({ ...extra }, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return () => undefined;
    },
  });
}

type Profile = { userId?: string; nickname?: string; tags?: string[] };

type Options = {
  /** GET /api/me の応答。null なら未ログイン扱い（503 を返す） */
  me?: Profile | null;
  /** GET /api/tags の応答。null なら取得失敗（対応表が空のまま） */
  presetTags?: Array<{ id: string; label: string }> | null;
  /** ゲストの一時プロフィール（entrance.html が sessionStorage に置くもの） */
  guest?: { nickname: string; tags: string[] };
};

type Harness = {
  socket(): FakeSocket;
  element(id: string): FakeElement;
  /** 卓に入った状態を作る（roomState を1件流す） */
  enterRoom(players: Array<Record<string, unknown>>): void;
};

async function load(options: Options = {}): Promise<Harness> {
  FakeSocket.instances = [];
  const { document } = createFakeDocument();
  const storage = new Map<string, string>();
  const me = options.me === undefined ? null : options.me;
  const presetTags = options.presetTags === undefined
    ? [{ id: "game", label: "ゲーム" }, { id: "alcohol", label: "お酒" }]
    : options.presetTags;
  const guest = options.guest ?? { nickname: "", tags: [] };

  const fetchStub = (url: string) => {
    if (url === "/api/me" && me !== null) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(me) });
    }
    if (url === "/api/tags" && presetTags !== null) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ tags: presetTags }),
      });
    }
    // それ以外（ICE サーバーなど）は「使えない」応答。app.js は握りつぶして続行する
    return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
  };

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
    `${source}\n; return {};`,
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
    { getGuestProfile: () => guest },
    { consumePendingCreateRoom: () => null, consumePendingJoinRoom: () => null },
    { protocol: "http:", host: "127.0.0.1:8000", href: "" },
    (fn: () => void) => {
      // タイマーは張られるだけでよい（このテストは時間を進めない）
      void fn;
      return 1;
    },
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
    stubModule(),
    stubModule({ getState: () => ({ bots: {}, isHost: false }) }),
    stubModule({ GAYA_CORRIDOR: 0.32, GAYA_ROOM: 0.06 }),
  );

  // start() は /api/me・/api/tags を待ってから connect() する。その解決を待つ
  await new Promise((resolve) => setTimeout(resolve, 0));

  const socket = () => FakeSocket.instances[FakeSocket.instances.length - 1];
  return {
    socket,
    element: (id: string) => document.getElementById(id),
    enterRoom: (players) => {
      socket().open();
      socket().receive({
        t: "roomState",
        snapshot: {
          code: "123456",
          session: "sess-abc",
          youId: "p1",
          youAreHost: false,
          hostId: "p1",
          players,
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
    },
  };
}

/** 参加者一覧の行から、札の文字列を取り出す */
function tagLabelsOf(row: FakeElement): string[] {
  const main = row.children.find((c) => c.className.includes("player-main"));
  if (main === undefined) return [];
  const tags = main.children.find((c) => c.className.includes("player-tags"));
  if (tags === undefined) return [];
  return tags.children.map((c) => c.textContent);
}

const PLAYER = {
  id: "p2",
  nickname: "たろう",
  connected: true,
  isHost: true,
  score: 0,
  vcEligible: true,
};

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

Deno.test("app.js: 同席者の趣味タグを、表示名の札で名前の下に出す（§3.11 用途1）", async () => {
  const h = await load();
  h.enterRoom([{ ...PLAYER, tags: ["game", "alcohol"] }]);

  const row = h.element("players").children[0];
  assertExists(row);
  assertEquals(tagLabelsOf(row), ["ゲーム", "お酒"]);
  // 名前と点数の行は今までどおり残っていること
  const main = row.children.find((c) => c.className.includes("player-main"));
  assertExists(main);
  assert(main.children[0].textContent.startsWith("たろう"));
});

Deno.test("app.js: タグを選んでいない人の行には札の枠を作らない", async () => {
  const h = await load();
  h.enterRoom([PLAYER]);

  const row = h.element("players").children[0];
  assertExists(row);
  assertEquals(tagLabelsOf(row), []);
});

Deno.test("app.js: 対応表を取れなかったときは ID のまま出す（名前ごと消さない）", async () => {
  const h = await load({ presetTags: null });
  h.enterRoom([{ ...PLAYER, tags: ["game"] }]);

  const row = h.element("players").children[0];
  assertExists(row);
  assertEquals(tagLabelsOf(row), ["game"]);
});

// ---------------------------------------------------------------------------
// 持ち込み
// ---------------------------------------------------------------------------

Deno.test("app.js: ログイン中は、アカウントの趣味タグを入室メッセージに積む（§3.11）", async () => {
  const h = await load({ me: { userId: "taro", nickname: "たろう", tags: ["game"] } });
  h.socket().open();
  h.element("code").value = "123456";
  h.element("join").click();

  const join = h.socket().parsedSent().find((m) => m.t === "join");
  assertExists(join);
  assertEquals(join.tags, ["game"]);
});

Deno.test("app.js: ゲストは entrance.html で選んだ一時的なタグを積む（§3.0 / §3.11）", async () => {
  const h = await load({ me: null, guest: { nickname: "のんべえ", tags: ["alcohol"] } });
  h.socket().open();
  h.element("code").value = "123456";
  h.element("join").click();

  const join = h.socket().parsedSent().find((m) => m.t === "join");
  assertExists(join);
  assertEquals(join.tags, ["alcohol"]);
  // あだ名の自動入力（既存の挙動）も壊していないこと
  assertEquals(join.nickname, "のんべえ");
});

Deno.test("app.js: 相席の待機列にもタグを持って並ぶ（§3.1.2 / §3.11）", async () => {
  const h = await load({ me: { userId: "taro", tags: ["game", "alcohol"] } });
  h.socket().open();
  h.element("queue-join").click();

  const queued = h.socket().parsedSent().find((m) => m.t === "joinQueue");
  assertExists(queued);
  assertEquals(queued.tags, ["game", "alcohol"]);
});

Deno.test("app.js: タグを1つも選んでいなければ tags を積まない", async () => {
  const h = await load({ me: { userId: "taro", tags: [] } });
  h.socket().open();
  h.element("code").value = "123456";
  h.element("join").click();

  const join = h.socket().parsedSent().find((m) => m.t === "join");
  assertExists(join);
  assertEquals(join.tags, undefined);
});
