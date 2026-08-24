/**
 * 結合スモークテスト
 * 実サーバーを空きポートで起動し、WebSocket クライアント3人で
 * 雑学クイズを最終結果まで完走させる（§9 のボット結合テストの最小版）。
 * テキストチャット（§3.9）の配信・スナップショット・レート制限、
 * および WS メッセージのレート制限（§3.8）も検証する。
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { MessageRateLimiter, startServer } from "../main.ts";
import { QUIZ } from "../official_games.ts";
import { CORRECT_BASE_POINT, CORRECT_SPEED_BONUS } from "../engine.ts";
import {
  type C2S,
  CHAT_RATE_MAX,
  type Phase,
  type S2C,
  WS_RATE_MAX,
  WS_RATE_WINDOW_MS,
} from "../types.ts";

/** 1メッセージを待つ上限（ミリ秒） */
const WAIT_TIMEOUT_MS = 5_000;

/**
 * sendPaced が空ける送信間隔（ミリ秒）。
 * §3.8 の 20件/秒 に対し余裕を持たせ、ボットが制限に触れないようにする。
 */
const PACE_INTERVAL_MS = 60;

/** 指定ミリ秒待つ */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** テスト用の WebSocket クライアント */
class TestClient {
  private readonly socket: WebSocket;
  private readonly messages: S2C[] = [];
  private readonly listeners = new Set<() => void>();
  private cursor = 0;
  private lastSentAt = 0;
  /** 切断時の close code。未切断は null */
  closeCode: number | null = null;
  readonly closed: Promise<void>;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.onmessage = (event) => {
      this.messages.push(JSON.parse(event.data) as S2C);
      for (const listener of [...this.listeners]) listener();
    };
    this.closed = new Promise<void>((resolve) => {
      this.socket.addEventListener("close", (event) => {
        this.closeCode = event.code;
        resolve();
      }, { once: true });
    });
  }

  /** 接続が確立するまで待つ */
  static connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const client = new TestClient(socket);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(client), { once: true });
      socket.addEventListener("error", () => reject(new Error("接続に失敗しました")), {
        once: true,
      });
    });
  }

  /** C2S を送る */
  send(msg: C2S): void {
    this.lastSentAt = Date.now();
    this.socket.send(JSON.stringify(msg));
  }

  /** 文字列をそのまま送る（不正な JSON を送るテスト用） */
  sendRaw(text: string): void {
    this.lastSentAt = Date.now();
    this.socket.send(text);
  }

  /**
   * 直前の送信から PACE_INTERVAL_MS 空けてから送る。
   * ボットの連投が §3.8 の WS レート制限（20件/秒）に触れないようにするため、
   * 多数のメッセージを送る側（ホスト）はこちらを使う。
   */
  async sendPaced(msg: C2S): Promise<void> {
    const wait = this.lastSentAt + PACE_INTERVAL_MS - Date.now();
    if (wait > 0) await delay(wait);
    this.send(msg);
  }

  /** これまでに受信したメッセージ（検査用のコピー） */
  received(): S2C[] {
    return [...this.messages];
  }

  /** 条件に合うメッセージが届くまで待つ。既に届いている分から順に走査する */
  waitFor(predicate: (msg: S2C) => boolean, label: string): Promise<S2C> {
    return new Promise((resolve, reject) => {
      const scan = (): S2C | null => {
        while (this.cursor < this.messages.length) {
          const msg = this.messages[this.cursor++];
          if (msg.t === "error") {
            reject(new Error(`${label} の待機中にエラー: ${msg.code} ${msg.message}`));
            return null;
          }
          if (predicate(msg)) return msg;
        }
        return null;
      };
      const finish = (msg: S2C) => {
        this.listeners.delete(listener);
        clearTimeout(timer);
        resolve(msg);
      };
      const listener = () => {
        const found = scan();
        if (found !== null) finish(found);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`${label} を待機中にタイムアウトしました`));
      }, WAIT_TIMEOUT_MS);
      const immediate = scan();
      if (immediate !== null) {
        finish(immediate);
        return;
      }
      this.listeners.add(listener);
    });
  }

  /** 指定フェーズの phase メッセージを待つ */
  async waitPhase(phase: Phase): Promise<Extract<S2C, { t: "phase" }>> {
    const msg = await this.waitFor(
      (m) => m.t === "phase" && m.phase === phase,
      `phase=${phase}`,
    );
    return msg as Extract<S2C, { t: "phase" }>;
  }

  /** 退室してから接続を閉じる */
  async leaveAndClose(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.send({ t: "leave" });
      await Promise.race([this.closed, delay(1_000)]);
    }
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.close();
    await this.closed;
  }
}

Deno.test("結合: 3人で雑学クイズを最終結果まで完走する", async () => {
  const server = startServer(0);
  const base = `http://127.0.0.1:${server.port}`;

  // 静的配信とセキュリティヘッダ
  const page = await fetch(`${base}/`);
  assertEquals(page.status, 200);
  assertExists(page.headers.get("content-security-policy"));
  const html = await page.text();
  assert(html.includes("宴 -EN-"));

  // 公開ディレクトリの外は取得できない
  const traversal = await fetch(`${base}/%2e%2e/deno.json`);
  assert(traversal.status !== 200);
  await traversal.body?.cancel();

  const host = await TestClient.connect(server.port);
  const p2 = await TestClient.connect(server.port);
  const p3 = await TestClient.connect(server.port);
  const clients = [host, p2, p3];

  // ルーム作成と参加
  host.send({ t: "createRoom", nickname: "ホスト", visibility: "private" });
  const created = await host.waitFor((m) => m.t === "roomState", "roomState(host)");
  assert(created.t === "roomState");
  const code = created.snapshot.code;
  assertEquals(created.snapshot.players.length, 1);

  p2.send({ t: "join", roomCode: code, nickname: "ふたり目" });
  const joined2 = await p2.waitFor((m) => m.t === "roomState", "roomState(p2)");
  assert(joined2.t === "roomState");
  assertEquals(joined2.snapshot.players.length, 2);

  p3.send({ t: "join", roomCode: code, nickname: "みたり目" });
  const joined3 = await p3.waitFor((m) => m.t === "roomState", "roomState(p3)");
  assert(joined3.t === "roomState");
  assertEquals(joined3.snapshot.players.length, 3);

  // ゲーム選択と開始
  await host.sendPaced({ t: "selectGame", gameId: QUIZ.id });
  await host.sendPaced({ t: "startGame" });
  for (const client of clients) await client.waitPhase("intro");

  /** ホストがスキップして目的のフェーズまで進める（§3.8 のレート制限に触れない間隔で送る） */
  const skipTo = async (phase: Phase) => {
    await host.sendPaced({ t: "skipPhase" });
    for (const client of clients) await client.waitPhase(phase);
  };

  for (let round = 1; round <= QUIZ.rounds; round++) {
    await skipTo("prompt");
    await skipTo("input");

    const prompt = QUIZ.prompts[(round - 1) % QUIZ.prompts.length];
    assert(prompt.kind === "choice" && prompt.answer !== undefined);
    const correct = prompt.answer;
    const wrong = (correct + 1) % prompt.options.length;

    // 提出順で早さボーナスが決まるため、間隔をあけて順に送る
    await host.sendPaced({ t: "submitInput", value: correct });
    await delay(20);
    p2.send({ t: "submitInput", value: correct });
    await delay(20);
    p3.send({ t: "submitInput", value: wrong });

    // 全員の提出で自動的に reveal へ進む
    for (const client of clients) await client.waitPhase("reveal");
    await skipTo("judge");
    await skipTo("roundResult");
  }

  // 最終ラウンドの roundResult から finalResult へ
  await host.sendPaced({ t: "skipPhase" });
  const finalViews = [];
  for (const client of clients) finalViews.push((await client.waitPhase("finalResult")).view);

  const first = CORRECT_BASE_POINT + CORRECT_SPEED_BONUS[0];
  const second = CORRECT_BASE_POINT + CORRECT_SPEED_BONUS[1];
  for (const view of finalViews) {
    assert(view.phase === "finalResult");
    const scores = view.scores;
    assertEquals(scores.length, 3);
    assertEquals(scores[0].nickname, "ホスト");
    assertEquals(scores[0].totalScore, first * QUIZ.rounds);
    assertEquals(scores[0].rank, 1);
    assertEquals(scores[1].nickname, "ふたり目");
    assertEquals(scores[1].totalScore, second * QUIZ.rounds);
    assertEquals(scores[1].rank, 2);
    assertEquals(scores[2].nickname, "みたり目");
    assertEquals(scores[2].totalScore, 0);
    assertEquals(scores[2].rank, 3);
  }

  // Player.score にはゲーム1本分の累計が反映される
  const room = server.manager.getRoom(code);
  assertExists(room);
  assertEquals([...room.players.values()][0].score, first * QUIZ.rounds);

  for (const client of clients) await client.leaveAndClose();
  assertEquals(server.manager.roomCount, 0);
  await server.shutdown();
});

Deno.test("結合: チャットが全員に届き、途中入室者は履歴を受け取る（§3.9）", async () => {
  const server = startServer(0);
  const host = await TestClient.connect(server.port);
  const p2 = await TestClient.connect(server.port);

  // ルーム作成と参加
  host.send({ t: "createRoom", nickname: "ホスト", visibility: "private" });
  const created = await host.waitFor((m) => m.t === "roomState", "roomState(host)");
  assert(created.t === "roomState");
  const code = created.snapshot.code;
  p2.send({ t: "join", roomCode: code, nickname: "ふたり目" });
  await p2.waitFor((m) => m.t === "roomState", "roomState(p2)");

  // 発言者本人を含む全員に届く
  host.send({ t: "chat", text: "こんばんは" });
  for (const client of [host, p2]) {
    const msg = await client.waitFor((m) => m.t === "chat", "chat(1件目)");
    assert(msg.t === "chat");
    assertEquals(msg.message.text, "こんばんは");
    assertEquals(msg.message.nickname, "ホスト");
    assertEquals(msg.message.bot, false);
    assertExists(msg.message.playerId);
  }
  p2.send({ t: "chat", text: "よろしくです" });
  for (const client of [host, p2]) {
    const msg = await client.waitFor((m) => m.t === "chat", "chat(2件目)");
    assert(msg.t === "chat");
    assertEquals(msg.message.nickname, "ふたり目");
  }

  // 途中入室者のスナップショットに履歴が古い順で入る
  const p3 = await TestClient.connect(server.port);
  p3.send({ t: "join", roomCode: code, nickname: "みたり目" });
  const joined3 = await p3.waitFor((m) => m.t === "roomState", "roomState(p3)");
  assert(joined3.t === "roomState");
  assertEquals(joined3.snapshot.chat.map((m) => m.text), ["こんばんは", "よろしくです"]);

  // レート制限: 10秒窓で6件目は RATE_LIMITED（waitFor はエラー受信で reject する）
  for (let i = 1; i <= CHAT_RATE_MAX; i++) {
    p3.send({ t: "chat", text: `連投${i}` });
  }
  p3.send({ t: "chat", text: "超過分" });
  const limited = await p3
    .waitFor(() => false, "RATE_LIMITED")
    .then(() => null)
    .catch((e: unknown) => e);
  assert(limited instanceof Error && limited.message.includes("RATE_LIMITED"));

  for (const client of [host, p2, p3]) await client.leaveAndClose();
  assertEquals(server.manager.roomCount, 0);
  await server.shutdown();
});

Deno.test("ユニット: WS レート制限は窓内 WS_RATE_MAX 件まで受理する（§3.8）", () => {
  const now = 1_000_000;
  const limiter = new MessageRateLimiter(() => now);
  for (let i = 1; i <= WS_RATE_MAX; i++) {
    assertEquals(limiter.accept(), true, `${i}件目は受理される`);
  }
  // 「超えたら切断」なので 20 件ちょうどはセーフ、21 件目が違反
  assertEquals(limiter.accept(), false);
});

Deno.test("ユニット: WS レート制限の窓の境界は経過 WS_RATE_WINDOW_MS 未満を窓内とする（§3.8）", () => {
  // 0..19ms に1件ずつ、計 WS_RATE_MAX 件受理させる
  const fill = (limiter: MessageRateLimiter, setNow: (at: number) => void) => {
    for (let i = 0; i < WS_RATE_MAX; i++) {
      setNow(i);
      assertEquals(limiter.accept(), true, `${i + 1}件目は受理される`);
    }
  };

  // 最古（t=0）から WS_RATE_WINDOW_MS - 1 の時点ではまだ全件が窓内 → 21件目は違反
  let nowA = 0;
  const inside = new MessageRateLimiter(() => nowA);
  fill(inside, (at) => nowA = at);
  nowA = WS_RATE_WINDOW_MS - 1;
  assertEquals(inside.accept(), false);

  // 最古から WS_RATE_WINDOW_MS 経過するとその1件が窓から外れる → 受理される
  let nowB = 0;
  const outside = new MessageRateLimiter(() => nowB);
  fill(outside, (at) => nowB = at);
  nowB = WS_RATE_WINDOW_MS;
  assertEquals(outside.accept(), true);
});

Deno.test("ユニット: WS レート制限は窓が過ぎるとリセットされる（§3.8）", () => {
  let now = 0;
  const limiter = new MessageRateLimiter(() => now);
  for (let i = 0; i < WS_RATE_MAX; i++) assertEquals(limiter.accept(), true);
  assertEquals(limiter.accept(), false);

  // 窓を十分に空ければ、また WS_RATE_MAX 件受理できる
  now += WS_RATE_WINDOW_MS * 2;
  for (let i = 1; i <= WS_RATE_MAX; i++) {
    assertEquals(limiter.accept(), true, `リセット後 ${i}件目は受理される`);
  }
  assertEquals(limiter.accept(), false);
});

Deno.test("結合: 1接続で 20件/秒 を超えると RATE_LIMITED を受け取ってから切断される（§3.8）", async () => {
  const server = startServer(0);
  const client = await TestClient.connect(server.port);

  // ルーム未参加でも、JSON として壊れたメッセージでも WS 層で数える
  for (let i = 0; i < WS_RATE_MAX; i++) client.sendRaw("{");
  client.sendRaw("{");

  await Promise.race([client.closed, delay(WAIT_TIMEOUT_MS)]);
  assertEquals(client.closeCode, 1008, "policy violation の 1008 で切断される");

  const received = client.received();
  const last = received[received.length - 1];
  assertExists(last);
  assert(last.t === "error" && last.code === "RATE_LIMITED", "切断前に RATE_LIMITED が届く");
  // 窓内の 20 件は通常どおり処理されている（壊れた JSON なので INVALID_INPUT）
  const invalid = received.filter((m) => m.t === "error" && m.code === "INVALID_INPUT");
  assertEquals(invalid.length, WS_RATE_MAX);

  await server.shutdown();
});

Deno.test("結合: 通常の利用ではレート制限で切断されない（§3.8）", async () => {
  const server = startServer(0);
  const host = await TestClient.connect(server.port);

  host.send({ t: "createRoom", nickname: "ホスト", visibility: "private" });
  const created = await host.waitFor((m) => m.t === "roomState", "roomState(host)");
  assert(created.t === "roomState");
  for (let i = 1; i <= 3; i++) {
    host.send({ t: "chat", text: `発言${i}` });
    await host.waitFor((m) => m.t === "chat", `chat(${i}件目)`);
  }
  assertEquals(host.closeCode, null, "切断されていない");

  await host.leaveAndClose();
  assertEquals(server.manager.roomCount, 0);
  await server.shutdown();
});
