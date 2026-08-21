/**
 * 結合スモークテスト
 * 実サーバーを空きポートで起動し、WebSocket クライアント3人で
 * 雑学クイズを最終結果まで完走させる（§9 のボット結合テストの最小版）。
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { startServer } from "../main.ts";
import { QUIZ } from "../official_games.ts";
import { CORRECT_BASE_POINT, CORRECT_SPEED_BONUS } from "../engine.ts";
import type { C2S, Phase, S2C } from "../types.ts";

/** 1メッセージを待つ上限（ミリ秒） */
const WAIT_TIMEOUT_MS = 5_000;

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
  readonly closed: Promise<void>;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.onmessage = (event) => {
      this.messages.push(JSON.parse(event.data) as S2C);
      for (const listener of [...this.listeners]) listener();
    };
    this.closed = new Promise<void>((resolve) => {
      this.socket.addEventListener("close", () => resolve(), { once: true });
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
    this.socket.send(JSON.stringify(msg));
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
  host.send({ t: "selectGame", gameId: QUIZ.id });
  host.send({ t: "startGame" });
  for (const client of clients) await client.waitPhase("intro");

  /** ホストがスキップして目的のフェーズまで進める */
  const skipTo = async (phase: Phase) => {
    host.send({ t: "skipPhase" });
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
    host.send({ t: "submitInput", value: correct });
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
  host.send({ t: "skipPhase" });
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
