/**
 * public/app.js の自動再接続まわりのテスト。
 *
 * サーバーを再起動すると、ルームはメモリ上にしかないため必ず消える。
 * したがって「切断（1001）→ 待って再接続 → 保存済みセッションで復帰 join →
 * ROOM_NOT_FOUND」は再起動のたびに必ず通る経路になる。ここが「ルームが見つかりません」
 * の赤いエラーで終わると、自動再接続を入れた意味が消えるので、その着地を検証する。
 *
 * クライアントのファイルだが、app.js が触るブラウザ API は DOM・fetch・WebSocket・
 * sessionStorage・タイマーだけなので、偽物を渡せば Deno から素の JavaScript として
 * 動かせる（voice_client_test.ts と同じ手口）。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { SHUTDOWN_CLOSE_CODE } from "../rooms.ts";
import { createFakeDocument, type FakeElement } from "./fake_dom.ts";

const APP_JS = fromFileUrl(new URL("../../public/app.js", import.meta.url));
const source = await Deno.readTextFile(APP_JS);

// ---------------------------------------------------------------------------
// 偽の DOM
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

  /** 接続確立。app.js の onopen（保存済みセッションでの復帰 join）が走る */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** サーバーからの切断。code に 1001 を渡すと「サーバー再起動」になる */
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

/** app.js の内部から取り出したいもの */
type App = {
  // deno-lint-ignore no-explicit-any
  state: any;
  // deno-lint-ignore no-explicit-any
  store: any;
};

type Harness = {
  app: App;
  elements: Map<string, FakeElement>;
  storage: Map<string, string>;
  /** VC / Chat などのモジュールで呼ばれた関数（"VC.teardown" 形式） */
  calls: string[];
  /** VC に参加している状態にする */
  setVcActive(active: boolean): void;
  /** VC に参加したままか（teardown で false になる） */
  vcActive(): boolean;
  /** 予約されたタイマーを、待たずに全部発火する */
  runTimers(): void;
  /** 予約されているタイマーの遅延（ミリ秒、予約順） */
  timerDelays(): number[];
  socket(): FakeSocket;
  errorBox(): FakeElement;
};

/** 何もしないダミーモジュール（vc.js / chat.js などの代わり） */
function stubModule(
  name: string,
  calls: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return new Proxy({ ...extra }, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      // 呼ばれたことだけ控える（どのモジュールのどの関数を呼んだかの検証用）
      return (...args: unknown[]) => {
        calls.push(`${name}.${prop}`);
        return args.length === 0 ? undefined : undefined;
      };
    },
  });
}

/** app.js を偽の環境で読み込む */
async function load(): Promise<Harness> {
  FakeSocket.instances = [];
  const { elements, document } = createFakeDocument();
  const storage = new Map<string, string>();
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  const calls: string[] = [];
  // VC に参加しているかどうか。テストから setVcActive(true) で通話中にできる
  let vcActive = false;
  let timerSeq = 1;

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
    "location",
    "setTimeout",
    "clearTimeout",
    "VC",
    "Voice",
    "Chat",
    "Bot",
    "Sandbox",
    `${source}\n; return { state, store };`,
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
    { protocol: "http:", host: "127.0.0.1:8000", href: "" },
    (fn: () => void, ms: number) => {
      const id = timerSeq++;
      timers.push({ id, fn, ms });
      return id;
    },
    (id: number) => {
      const at = timers.findIndex((t) => t.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
    stubModule("VC", calls, {
      getState: () => ({
        active: vcActive,
        muted: false,
        camera: false,
        eligible: true,
        peers: [],
        quality: null,
      }),
      // 実物は畳んだら active が false になる（vc_teardown_test.ts で検証済み）
      teardown: () => {
        calls.push("VC.teardown");
        vcActive = false;
      },
    }),
    stubModule("Voice", calls, { getState: () => ({ enabled: false }), isSupported: () => false }),
    stubModule("Chat", calls),
    stubModule("Bot", calls, { getState: () => ({ bots: {} }) }),
    stubModule("Sandbox", calls),
  ) as App;

  // start() は fetch を await してから connect() する。その解決を待つ
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    app,
    elements,
    storage,
    calls,
    setVcActive: (active: boolean) => {
      vcActive = active;
    },
    vcActive: () => vcActive,
    runTimers: () => {
      const pending = timers.splice(0, timers.length);
      for (const timer of pending) timer.fn();
    },
    timerDelays: () => timers.map((t) => t.ms),
    socket: () => FakeSocket.instances[FakeSocket.instances.length - 1],
    // 未生成でも作られるよう document 経由で取る
    errorBox: () => document.getElementById("error"),
  };
}

/** 卓に入っている状態を作る（roomState を1件流してセッションを保存させる） */
function enterRoom(h: Harness, code = "123456"): void {
  h.socket().open();
  h.socket().receive({
    t: "roomState",
    snapshot: {
      code,
      session: "sess-abc",
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

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

Deno.test("app.js: 1001 で切れたら、待ってから自動で繋ぎ直す", async () => {
  const h = await load();
  enterRoom(h);
  assertEquals(h.storage.get("en-session") !== undefined, true, "セッションが保存されている");
  const before = h.socket();

  before.closeFromServer(SHUTDOWN_CLOSE_CODE);

  // 即座に繋ぎ直すと、まだ起動していないサーバーへ高速なループを撃つことになる
  assertEquals(h.socket(), before, "待たずに繋ぎ直さない");
  assertEquals(h.timerDelays(), [1000], "初回は1秒待つ");
  assert(h.errorBox().textContent.includes("再起動"));
  assertEquals(h.errorBox().className, "notice", "赤い警告ではなく通知として出す");

  h.runTimers();
  assert(h.socket() !== before, "待ち時間のあとに繋ぎ直す");
});

Deno.test("app.js: 繋がらないあいだは待ち時間を倍にし、上限で頭打ちにする", async () => {
  const h = await load();
  enterRoom(h);
  h.socket().closeFromServer(SHUTDOWN_CLOSE_CODE);

  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    delays.push(...h.timerDelays());
    h.runTimers();
    // 再接続の試行が失敗したときのコードは 1001 ではなく 1006（異常終了）になる
    h.socket().closeFromServer(1006);
  }

  assertEquals(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  // 上限に達したら諦めて、元どおり再読み込みを促す
  assertEquals(h.timerDelays(), [], "諦めたあとは再試行を予約しない");
  assert(h.errorBox().textContent.includes("再読み込み"));
  assertEquals(h.errorBox().className, "alert");
});

Deno.test("app.js: 再接続を諦めたら VC を畳んでマイク・カメラを止める", async () => {
  const h = await load();
  enterRoom(h);
  h.setVcActive(true); // 通話に参加している状態
  h.socket().closeFromServer(SHUTDOWN_CLOSE_CODE);

  // 上限まで失敗させて諦めさせる
  for (let i = 0; i < 8; i++) {
    h.runTimers();
    h.socket().closeFromServer(1006);
  }

  // 畳まないとサーバーは戻ってこないのにマイク・カメラだけが動き続ける
  // （teardown が実際にトラックを止めることは vc_teardown_test.ts で検証している）
  assert(h.calls.includes("VC.teardown"), `VC.teardown が呼ばれていない: ${h.calls.join(", ")}`);
  assertFalse(h.vcActive(), "VC が畳まれていない");
  // 通話が切れたことは利用者から見える変化なので、理由まで伝える
  const text = h.errorBox().textContent;
  assert(text.includes("繋がりません"), `サーバーに繋がらないことが分からない: ${text}`);
  assert(text.includes("通話を終了"), `通話が切れたことが分からない: ${text}`);
  assert(text.includes("再読み込み"), `戻り方が分からない: ${text}`);
});

Deno.test("app.js: 通話していないのに諦めたときは、通話の話をしない", async () => {
  const h = await load();
  enterRoom(h);
  h.socket().closeFromServer(SHUTDOWN_CLOSE_CODE);

  for (let i = 0; i < 8; i++) {
    h.runTimers();
    h.socket().closeFromServer(1006);
  }

  const text = h.errorBox().textContent;
  assertFalse(text.includes("通話"), `通話していないのに通話の話が出ている: ${text}`);
  assert(text.includes("再読み込み"));
});

Deno.test("app.js: 再起動を受けただけでは VC を畳まない（P2P の通話は生きている）", async () => {
  const h = await load();
  enterRoom(h);
  h.setVcActive(true);

  h.socket().closeFromServer(SHUTDOWN_CLOSE_CODE);

  // メディアは P2P で流れており、サーバーが落ちても通話自体は生きている。
  // ここで畳むと、まだ機能している通話をこちらから壊すことになる
  assertFalse(h.calls.includes("VC.teardown"), "復帰できるかもしれない段階で畳んでいる");
  assert(h.vcActive(), "通話は続いていなければならない");
});

Deno.test("app.js: 繋がったら待ち時間はリセットされる", async () => {
  const h = await load();
  enterRoom(h);

  h.socket().closeFromServer(SHUTDOWN_CLOSE_CODE);
  h.runTimers();
  h.socket().closeFromServer(1006);
  assertEquals(h.timerDelays(), [2000], "1回失敗したので次は2秒");
  h.runTimers();
  h.socket().open(); // 今度は繋がった

  h.socket().closeFromServer(SHUTDOWN_CLOSE_CODE);
  assertEquals(h.timerDelays(), [1000], "繋がったので次の再起動はまた1秒から");
});

Deno.test("app.js: 再起動での復帰 join が ROOM_NOT_FOUND なら、解散として案内する", async () => {
  const h = await load();
  enterRoom(h);
  h.socket().closeFromServer(SHUTDOWN_CLOSE_CODE);
  h.runTimers();

  // 繋がったので、保存済みセッションで復帰 join を送る
  h.socket().open();
  const join = h.socket().parsedSent().find((msg) => msg.t === "join");
  assertEquals(join?.session, "sess-abc");

  // ルームはサーバーのメモリ上にしかないので、再起動後は必ずこうなる
  h.socket().receive({
    t: "error",
    code: "ROOM_NOT_FOUND",
    message: "ルームが見つかりません",
  });

  const box = h.errorBox();
  assert(box.textContent.includes("再起動"), `案内が出ていない: ${box.textContent}`);
  assert(box.textContent.includes("解散"), `案内が出ていない: ${box.textContent}`);
  assertFalse(box.textContent.includes("ROOM_NOT_FOUND"), "生のエラーコードは見せない");
  // 利用者は何も間違えていないので、赤い警告ではなく事実の通知として出す
  assertEquals(box.className, "notice");
  assertEquals(box.attributes.get("role"), "status");

  // 残すと、次に開いたときも消えた卓へ復帰しようとして同じことが起きる
  assertEquals(h.storage.get("en-session"), undefined, "保存済みセッションを捨てる");
  // 次に取れる行動（別の卓に入る・作り直す）へ繋がるよう、一覧の見える画面に戻す
  assertFalse(h.elements.get("entry")!.classList.contains("hidden"), "卓一覧が見える");
  assert(h.elements.get("room")!.classList.contains("hidden"), "卓の画面は畳む");
});

Deno.test("app.js: 再起動での解散では、bye を送らない後始末で VC を畳む", async () => {
  const h = await load();
  enterRoom(h);
  h.socket().closeFromServer(SHUTDOWN_CLOSE_CODE);
  h.runTimers();
  h.socket().open();
  h.calls.length = 0;

  h.socket().receive({ t: "error", code: "ROOM_NOT_FOUND", message: "ルームが見つかりません" });

  // teardown はピアへ bye を送らずにマイク・カメラを止める（vc_teardown_test.ts で検証）。
  // ここで leave() を呼ぶと、繋ぎ直した先の新しいサーバーへ宛先不明の rtcSignal が飛び、
  // その拒否応答で「サーバーが再起動したため…」の案内が消えてしまう
  assert(h.calls.includes("VC.teardown"), `VC.teardown が呼ばれていない: ${h.calls.join(", ")}`);
  assertFalse(h.calls.includes("VC.leave"), "再起動での解散で bye を送ってはいけない");
  // 案内が VC 側の通知で上書きされていないこと
  assert(h.errorBox().textContent.includes("解散"));
});

Deno.test("app.js: 打ち間違いの ROOM_NOT_FOUND は今までどおりのエラー表示", async () => {
  const h = await load();
  h.socket().open();

  // 再起動を経ていない、自分で打った参加コードが間違っていた場合
  h.socket().receive({
    t: "error",
    code: "ROOM_NOT_FOUND",
    message: "ルームが見つかりません",
  });

  const box = h.errorBox();
  assertEquals(box.textContent, "ROOM_NOT_FOUND: ルームが見つかりません");
  assertEquals(box.className, "alert");
});

Deno.test("app.js: 再起動で復帰できたときは案内を出さない", async () => {
  const h = await load();
  enterRoom(h);
  h.socket().closeFromServer(SHUTDOWN_CLOSE_CODE);
  h.runTimers();
  h.socket().open();

  // 復帰に成功した（サーバーが十分に速く戻り、猶予内だった）場合
  enterRoom(h, "123456");

  assertEquals(h.errorBox().textContent, "");
  assertFalse(h.app.state.rejoinAfterRestart, "復帰できたら再起動起因の記憶は捨てる");
  assertEquals(h.storage.get("en-session"), '{"code":"123456","session":"sess-abc"}');
});

Deno.test("app.js: 復帰後に別の卓で ROOM_NOT_FOUND が出ても解散扱いにしない", async () => {
  const h = await load();
  enterRoom(h);
  h.socket().closeFromServer(SHUTDOWN_CLOSE_CODE);
  h.runTimers();
  h.socket().open();
  h.socket().receive({ t: "error", code: "ROOM_NOT_FOUND", message: "ルームが見つかりません" });

  // 案内のあと、利用者が別の卓コードを打ち間違えた
  h.socket().receive({ t: "error", code: "ROOM_NOT_FOUND", message: "ルームが見つかりません" });

  assertEquals(h.errorBox().textContent, "ROOM_NOT_FOUND: ルームが見つかりません");
  assertEquals(h.errorBox().className, "alert");
});

Deno.test("app.js: 退室による切断は今までどおり張り直すだけ（再起動の案内は出ない）", async () => {
  const h = await load();
  enterRoom(h);
  const before = h.socket();
  h.app.state.leaving = true;

  before.closeFromServer(1000);

  assert(h.socket() !== before, "退室時は待たずに張り直す");
  assertEquals(h.timerDelays(), [], "退室ではバックオフを挟まない");
  assertEquals(h.errorBox().textContent, "");
});

Deno.test("app.js: 再起動以外の切断は、今までどおり再読み込みを促す", async () => {
  const h = await load();
  enterRoom(h);

  h.socket().closeFromServer(1006);

  assertEquals(h.errorBox().textContent, "接続が切れました。再読み込みしてください");
  assertEquals(h.errorBox().className, "alert");
  assertEquals(h.timerDelays(), [], "自動再接続はしない");
});
