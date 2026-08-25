/**
 * 正常終了（graceful shutdown）のテスト。
 *
 * 本番の systemd では restart のたびに status=143（SIGTERM で強制終了）が記録され、
 * 繋いでいる人には理由不明の異常切断として届いていた。ここで見るのは
 *
 *   - dispose() が接続中のソケットを 1001（going away）で閉じること
 *   - 1本の close() が失敗しても残りの切断が止まらないこと
 *   - クローズ理由が RFC 6455 の 123 バイト制限に収まること
 *   - 後始末を2回呼んでも壊れないこと
 *
 * シグナル送信そのものは環境依存が大きいのでテストしない。代わりに
 * ハンドラの中身を createShutdownHandler / listenShutdownSignals に切り出し、
 * それを直接呼んで確かめる。
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  type ClientLink,
  CLOSE_REASON_MAX_BYTES,
  RoomManager,
  SHUTDOWN_CLOSE_CODE,
  SHUTDOWN_CLOSE_REASON,
} from "../rooms.ts";
import {
  createShutdownHandler,
  listenShutdownSignals,
  SHUTDOWN_TIMEOUT_MS,
  startServer,
} from "../main.ts";
import type { S2C } from "../types.ts";

// ---------------------------------------------------------------------------
// テスト用の接続とルーム
// ---------------------------------------------------------------------------

/** close() に渡された引数を記録する接続。throwOnClose で「既に閉じた」ソケットを模す */
class RecordingLink implements ClientLink {
  readonly id = crypto.randomUUID();
  readonly received: S2C[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  constructor(
    readonly userId: string | null = "testUser",
    private readonly throwOnClose = false,
  ) {}

  send(msg: S2C): void {
    this.received.push(msg);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    // 実際の WebSocket も、閉じ済み・閉じかけの接続に close() すると例外になり得る
    if (this.throwOnClose) throw new Error("already closed");
  }
}

/** その接続が受け取った roomState からルームコードを取り出す */
function roomCodeOf(link: RecordingLink): string {
  const state = link.received.find((msg) => msg.t === "roomState");
  assertExists(state, "roomState を受け取っていない");
  return state.snapshot.code;
}

/** タイマーを実際には走らせない RoomManager（テスト後にタイマーが残らないようにする） */
function newManager(): RoomManager {
  let seq = 1;
  return new RoomManager({
    setTimer: () => seq++,
    clearTimer: () => {},
  });
}

/** ホストと指定人数のゲストを入れたルームを作り、全接続を返す */
function roomWith(manager: RoomManager, guests: number): RecordingLink[] {
  const host = new RecordingLink();
  manager.handle(host, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  const code = roomCodeOf(host);
  const links = [host];
  for (let i = 0; i < guests; i++) {
    const guest = new RecordingLink();
    manager.handle(guest, { t: "join", roomCode: code, nickname: `客${i}` });
    links.push(guest);
  }
  return links;
}

// ---------------------------------------------------------------------------
// dispose(): ソケットの閉じ方
// ---------------------------------------------------------------------------

Deno.test("dispose: 接続中の全ソケットを 1001（going away）で閉じる", () => {
  const manager = newManager();
  const links = roomWith(manager, 2);

  manager.dispose();

  assertEquals(links.length, 3);
  for (const link of links) {
    assertEquals(link.closes.length, 1, "接続ごとにちょうど1回だけ閉じる");
    assertEquals(link.closes[0].code, SHUTDOWN_CLOSE_CODE);
    assertEquals(link.closes[0].reason, SHUTDOWN_CLOSE_REASON);
  }
  // 1000（正常終了）で閉じてしまうと、クライアントは退室と区別できず自動再接続できない
  assertEquals(SHUTDOWN_CLOSE_CODE, 1001);
});

Deno.test("dispose: 1本の close() が失敗しても残りの接続は閉じる", () => {
  const manager = newManager();
  const host = new RecordingLink("testUser", true); // このホストの close() は例外を投げる
  manager.handle(host, { t: "createRoom", nickname: "ホスト", visibility: "private" });
  const code = roomCodeOf(host);
  const guests = [new RecordingLink(), new RecordingLink()];
  for (const [i, guest] of guests.entries()) {
    manager.handle(guest, { t: "join", roomCode: code, nickname: `客${i}` });
  }

  manager.dispose(); // 例外が外へ漏れないこと自体もここで見ている

  assertEquals(host.closes.length, 1, "失敗する接続にも close() は試みる");
  for (const guest of guests) {
    assertEquals(guest.closes.length, 1, "先の失敗に巻き込まれず閉じられる");
    assertEquals(guest.closes[0].code, SHUTDOWN_CLOSE_CODE);
  }
});

Deno.test("dispose: 複数ルームにまたがる接続をすべて閉じる", () => {
  const manager = newManager();
  const roomA = roomWith(manager, 1);
  const roomB = roomWith(manager, 3);

  manager.dispose();

  for (const link of [...roomA, ...roomB]) {
    assertEquals(link.closes.length, 1);
    assertEquals(link.closes[0].code, SHUTDOWN_CLOSE_CODE);
  }
  assertEquals(manager.roomCount, 0);
});

Deno.test("dispose: 2回呼んでも壊れず、2回目は何も閉じない", () => {
  const manager = newManager();
  const links = roomWith(manager, 2);

  manager.dispose();
  manager.dispose();

  for (const link of links) {
    assertEquals(link.closes.length, 1, "2回目の dispose で二重に閉じない");
  }
  assertEquals(manager.roomCount, 0);
});

Deno.test("クローズ理由は RFC 6455 の 123 バイト以内に収まる", () => {
  // 文言を変えた人がここで気づけるようにしておく。超えると close() が例外を投げ、
  // サーバー停止時に接続が閉じられなくなる（日本語は1文字3バイトですぐ膨らむ）
  const bytes = new TextEncoder().encode(SHUTDOWN_CLOSE_REASON).length;
  assertEquals(CLOSE_REASON_MAX_BYTES, 123);
  assert(
    bytes <= CLOSE_REASON_MAX_BYTES,
    `クローズ理由が ${bytes} バイトで上限 ${CLOSE_REASON_MAX_BYTES} を超えている`,
  );
});

// ---------------------------------------------------------------------------
// createShutdownHandler(): シグナルを受けたときの処理
// ---------------------------------------------------------------------------

Deno.test("shutdown handler: 後始末をしてから終了コード 0 で終わる", async () => {
  const exits: number[] = [];
  const logs: string[] = [];
  let disposed = 0;
  const handler = createShutdownHandler({
    shutdown: () => {
      disposed++;
      return Promise.resolve();
    },
    exit: (code) => exits.push(code),
    log: (message) => logs.push(message),
  });

  await handler("SIGTERM");

  assertEquals(disposed, 1);
  // 0 で終わることが systemd の status=143（失敗）表示を消す本体
  assertEquals(exits, [0]);
  assertEquals(logs.length, 1, "終了することが分かるログを1行だけ出す");
  assert(logs[0].includes("SIGTERM"));
});

Deno.test("shutdown handler: シグナルが連続で来ても後始末は1回だけ", async () => {
  const exits: number[] = [];
  let disposed = 0;
  const handler = createShutdownHandler({
    shutdown: () => {
      disposed++;
      return Promise.resolve();
    },
    exit: (code) => exits.push(code),
    log: () => {},
  });

  await Promise.all([handler("SIGTERM"), handler("SIGINT"), handler("SIGTERM")]);

  assertEquals(disposed, 1, "2回目以降のシグナルは無視する");
  assertEquals(exits, [0]);
});

Deno.test("shutdown handler: 後始末が例外を投げても終了する", async () => {
  const exits: number[] = [];
  const logs: string[] = [];
  const handler = createShutdownHandler({
    shutdown: () => Promise.reject(new Error("dispose に失敗")),
    exit: (code) => exits.push(code),
    log: (message) => logs.push(message),
  });

  await handler("SIGTERM");

  assertEquals(exits, [0], "後始末で転んでも再起動は完了させる");
  assert(logs.some((m) => m.includes("dispose に失敗")));
});

Deno.test("shutdown handler: 後始末がハングしても保険のタイムアウトで終了する", async () => {
  const exits: number[] = [];
  const logs: string[] = [];
  // 永久に解決しない後始末。終了しないサービスは強制再起動される分だけ悪い
  const handler = createShutdownHandler({
    shutdown: () => new Promise<void>(() => {}),
    exit: (code) => exits.push(code),
    log: (message) => logs.push(message),
    timeoutMs: 20,
  });

  handler("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 60));

  assertEquals(exits, [0]);
  assert(logs.some((m) => m.includes("強制終了")));
});

// ---------------------------------------------------------------------------
// listenShutdownSignals(): OS ごとの購読対象
// ---------------------------------------------------------------------------

Deno.test("signal 購読: Windows では SIGTERM を購読しない（SIGINT / SIGBREAK のみ）", () => {
  // Deno.addSignalListener("SIGTERM") は Windows で例外を投げる。
  // ここを間違えると開発機で deno task dev が起動しなくなる
  const seen: Deno.Signal[] = [];
  const registered = listenShutdownSignals(() => {}, (signal) => {
    seen.push(signal);
  }, "windows");

  assertEquals(seen, ["SIGINT", "SIGBREAK"]);
  assertEquals(registered, ["SIGINT", "SIGBREAK"]);
});

Deno.test("signal 購読: Linux では SIGTERM と SIGINT を購読する", () => {
  const seen: Deno.Signal[] = [];
  const registered = listenShutdownSignals(() => {}, (signal) => {
    seen.push(signal);
  }, "linux");

  assertEquals(seen, ["SIGTERM", "SIGINT"]);
  assertEquals(registered, ["SIGTERM", "SIGINT"]);
});

Deno.test("signal 購読: 購読できないシグナルがあっても起動は続く", () => {
  const registered = listenShutdownSignals(() => {}, (signal) => {
    if (signal === "SIGTERM") throw new TypeError("Windows only supports SIGINT");
  }, "linux");

  // SIGTERM は落ちたが SIGINT は購読できている（例外が外へ漏れないことも見ている）
  assertEquals(registered, ["SIGINT"]);
});

Deno.test("signal 購読: 受け取ったシグナル名がハンドラへ渡る", () => {
  const handlers = new Map<Deno.Signal, () => void>();
  const received: string[] = [];
  listenShutdownSignals((signal) => received.push(signal), (signal, fn) => {
    handlers.set(signal, fn);
  }, "linux");

  handlers.get("SIGTERM")?.();

  assertEquals(received, ["SIGTERM"]);
});

// ---------------------------------------------------------------------------
// クライアントとの取り決め
// ---------------------------------------------------------------------------

Deno.test("public/app.js はサーバーと同じクローズコードで再接続を判定する", async () => {
  // ビルド無しの構成なのでサーバーとクライアントで定数を共有できない。
  // 片方だけ変えられたときにここで気づけるようにしておく
  const appJs = await Deno.readTextFile(
    fromFileUrl(new URL("../../public/app.js", import.meta.url)),
  );
  const match = /SERVER_SHUTDOWN_CLOSE_CODE\s*=\s*(\d+)/.exec(appJs);
  assert(match !== null, "app.js に SERVER_SHUTDOWN_CLOSE_CODE の定義が見つからない");
  assertEquals(Number(match[1]), SHUTDOWN_CLOSE_CODE);
});

// ---------------------------------------------------------------------------
// 実サーバーでの結合確認（本番と同じ経路で 1001 が届くか）
// ---------------------------------------------------------------------------

Deno.test("停止時: ルームに入っていない接続にも 1001 が届き、shutdown はすぐ返る", async () => {
  // app.js はページを開いた直後に繋ぎに来るので、ロビーで待っているだけの接続が常にいる。
  // これは RoomManager が把握していないため、startServer 側で閉じる必要がある
  const handle = startServer(0, "127.0.0.1");
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("WebSocket を開けなかった"));
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.onclose = (event) => resolve(event);
  });

  const startedAt = Date.now();
  await handle.shutdown();
  const event = await closed;
  const elapsed = Date.now() - startedAt;

  // 利用者側が見るのはコード。1001 なら app.js が「再起動なので待って繋ぎ直す」と判断する。
  // 理由文字列は、こちらの close() より Deno.serve の shutdown() 自身の close
  // （"Server shutting down"）が先に届くことがあるため、どちらでも通るようにしておく
  assertEquals(event.code, SHUTDOWN_CLOSE_CODE);
  assert(event.reason.length > 0);
  // 閉じ残しがあると Deno.serve の shutdown() がその接続を待って返ってこなくなる。
  // 保険のタイムアウト（SHUTDOWN_TIMEOUT_MS）に頼らず自力で終われることを見ている
  assert(elapsed < SHUTDOWN_TIMEOUT_MS, `shutdown に ${elapsed}ms かかった`);
});

Deno.test("停止時: ルームに入っている接続にも 1001 が届く", async () => {
  const kv = await Deno.openKv(":memory:");
  const handle = startServer(0, "127.0.0.1", kv);
  const base = `http://127.0.0.1:${handle.port}`;
  // ルーム作成にはログインが要る（§3.0）
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: "u" + crypto.randomUUID().replace(/-/g, "").slice(0, 10),
      password: "correcthorse",
    }),
  });
  assertEquals(res.status, 200);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  assertExists(cookie);

  // ブラウザは WS ハンドシェイクに Cookie を自動で付けるが、生スクリプトからは自分で付ける。
  // 標準の WebSocket に headers 引数は無いので Deno 独自拡張の第2引数を使う
  // （integration_test.ts の TestClient.connect と同じ手口）
  // deno-lint-ignore no-explicit-any
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`, { headers: { cookie } } as any);
  const joined = new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      socket.send(JSON.stringify({ t: "createRoom", nickname: "ホスト", visibility: "private" }));
    };
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data) as S2C;
      if (msg.t === "roomState") resolve();
      if (msg.t === "error") reject(new Error(`createRoom が失敗: ${msg.message}`));
    };
    socket.onerror = () => reject(new Error("WebSocket を開けなかった"));
  });
  await joined;
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.onclose = (event) => resolve(event);
  });

  await handle.shutdown();
  const event = await closed;

  assertEquals(event.code, SHUTDOWN_CLOSE_CODE);
  kv.close();
});
