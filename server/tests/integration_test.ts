/**
 * 結合スモークテスト
 * 実サーバーを空きポートで起動し、WebSocket クライアント3人で
 * 雑学クイズを最終結果まで完走させる（§9 のボット結合テストの最小版）。
 * テキストチャット（§3.9）の配信・スナップショット・レート制限、
 * および WS メッセージのレート制限（§3.8。rtcSignal の別枠・破棄・ハードキャップを含む）も
 * 検証する。
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { MessageRateLimiter, startServer } from "../main.ts";
import { QUIZ } from "../official_games.ts";
import { CORRECT_BASE_POINT, CORRECT_SPEED_BONUS } from "../engine.ts";
import {
  type C2S,
  CHAT_RATE_MAX,
  type ErrorCode,
  type Phase,
  type S2C,
  WS_RATE_MAX,
  WS_RATE_WINDOW_MS,
  WS_SIGNAL_HARD_MAX,
  WS_SIGNAL_RATE_MAX,
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

/**
 * 条件が満たされるまでポーリングで待つ。
 * TestClient.waitFor はエラー受信で reject するため、エラー応答が正常系であるテスト
 * （レート制限に触れるまで連投する等）ではこちらを使う。
 */
async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`${label} を待機中にタイムアウトしました`);
    await delay(10);
  }
}

/** 使い捨てユーザーを登録し、セッション Cookie を返す（ルーム作成にはログインが必須: §3.0） */
async function registerCookie(base: string): Promise<string> {
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
  return cookie;
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

  /**
   * 接続が確立するまで待つ。cookie を渡すとログイン済みとしてアップグレードされる。
   * ブラウザは同一オリジンへの WS ハンドシェイクに Cookie を自動で付けるが、
   * このテストのような生スクリプトからは自分で付ける必要がある。標準の WebSocket
   * コンストラクタには headers 引数が無いため、Deno 独自拡張の第2引数 { headers }
   * を使う（Deno 2.9.5 で動作確認済み。将来の Deno 更新で動かなくなった場合は
   * ここが原因）。
   */
  static connect(port: number, cookie?: string): Promise<TestClient> {
    const socket = cookie !== undefined
      // deno-lint-ignore no-explicit-any
      ? new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } } as any)
      : new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

  /** これまでに受信した指定コードの error の件数 */
  countError(code: ErrorCode): number {
    return this.messages.filter((m) => m.t === "error" && m.code === code).length;
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
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
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

  // ルーム作成にはログインが必須（§3.0）。ホストだけ登録してセッション Cookie を得る
  const registerRes = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: "host" + crypto.randomUUID().replace(/-/g, "").slice(0, 8),
      password: "correcthorse",
    }),
  });
  assertEquals(registerRes.status, 200);
  const hostCookie = registerRes.headers.get("set-cookie")?.split(";")[0];
  assertExists(hostCookie);

  const host = await TestClient.connect(server.port, hostCookie);
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
  kv.close();
});

Deno.test("結合: チャットが全員に届き、途中入室者は履歴を受け取る（§3.9）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  const base = `http://127.0.0.1:${server.port}`;
  const hostCookie = await registerCookie(base);
  const host = await TestClient.connect(server.port, hostCookie);
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
    const msg = await client.waitFor(
      (m) => m.t === "chat" && !m.message.bot,
      "chat(1件目)",
    );
    assert(msg.t === "chat");
    assertEquals(msg.message.text, "こんばんは");
    assertEquals(msg.message.nickname, "ホスト");
    assertEquals(msg.message.bot, false);
    assertExists(msg.message.playerId);
  }
  p2.send({ t: "chat", text: "よろしくです" });
  for (const client of [host, p2]) {
    const msg = await client.waitFor(
      (m) => m.t === "chat" && !m.message.bot,
      "chat(2件目)",
    );
    assert(msg.t === "chat");
    assertEquals(msg.message.nickname, "ふたり目");
  }

  // 途中入室者のスナップショットに履歴が古い順で入る
  const p3 = await TestClient.connect(server.port);
  p3.send({ t: "join", roomCode: code, nickname: "みたり目" });
  const joined3 = await p3.waitFor((m) => m.t === "roomState", "roomState(p3)");
  assert(joined3.t === "roomState");
  // bot の挨拶（§3.10）が混ざるので、人の発言だけを比べる
  assertEquals(
    joined3.snapshot.chat.filter((m) => !m.bot).map((m) => m.text),
    ["こんばんは", "よろしくです"],
  );

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
  kv.close();
});

Deno.test("ユニット: WS レート制限は窓内 WS_RATE_MAX 件まで受理する（§3.8）", () => {
  const now = 1_000_000;
  const limiter = new MessageRateLimiter(WS_RATE_MAX, () => now);
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
  const inside = new MessageRateLimiter(WS_RATE_MAX, () => nowA);
  fill(inside, (at) => nowA = at);
  nowA = WS_RATE_WINDOW_MS - 1;
  assertEquals(inside.accept(), false);

  // 最古から WS_RATE_WINDOW_MS 経過するとその1件が窓から外れる → 受理される
  let nowB = 0;
  const outside = new MessageRateLimiter(WS_RATE_MAX, () => nowB);
  fill(outside, (at) => nowB = at);
  nowB = WS_RATE_WINDOW_MS;
  assertEquals(outside.accept(), true);
});

Deno.test("ユニット: WS レート制限は窓が過ぎるとリセットされる（§3.8）", () => {
  let now = 0;
  const limiter = new MessageRateLimiter(WS_RATE_MAX, () => now);
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
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  const base = `http://127.0.0.1:${server.port}`;
  const hostCookie = await registerCookie(base);
  const host = await TestClient.connect(server.port, hostCookie);

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
  kv.close();
});

Deno.test("ユニット: WS レート制限の上限はコンストラクタで受け取った値になる（§3.8）", () => {
  const now = 1_000_000;

  // rtcSignal 枠は WS_SIGNAL_RATE_MAX 件ちょうどまでセーフ、その次が違反
  const signal = new MessageRateLimiter(WS_SIGNAL_RATE_MAX, () => now);
  for (let i = 1; i <= WS_SIGNAL_RATE_MAX; i++) {
    assertEquals(signal.accept(), true, `signal 枠の${i}件目は受理される`);
  }
  assertEquals(signal.accept(), false, `signal 枠の${WS_SIGNAL_RATE_MAX + 1}件目は違反`);

  // 上限は枠ごとに独立している（同じ窓・同じ時刻でも一般枠は WS_RATE_MAX で切れる）
  const general = new MessageRateLimiter(WS_RATE_MAX, () => now);
  for (let i = 1; i <= WS_RATE_MAX; i++) {
    assertEquals(general.accept(), true, `一般枠の${i}件目は受理される`);
  }
  assertEquals(general.accept(), false, `一般枠の${WS_RATE_MAX + 1}件目は違反`);
});

Deno.test("ユニット: rtcSignal のハードキャップはソフト上限より大きい（§3.8）", () => {
  assert(
    WS_SIGNAL_RATE_MAX < WS_SIGNAL_HARD_MAX,
    "破棄で済ませる上限より切断の上限が大きくなければ破棄の余地がない",
  );

  // ハードキャップ枠も WS_SIGNAL_HARD_MAX 件ちょうどまでセーフ、その次が違反（＝切断）
  const now = 1_000_000;
  const hard = new MessageRateLimiter(WS_SIGNAL_HARD_MAX, () => now);
  for (let i = 1; i <= WS_SIGNAL_HARD_MAX; i++) {
    assertEquals(hard.accept(), true, `ハードキャップ枠の${i}件目は受理される`);
  }
  assertEquals(hard.accept(), false, `ハードキャップ枠の${WS_SIGNAL_HARD_MAX + 1}件目は違反`);
});

/** ルームを1つ作り、ホストとして参加済みのクライアントを返す（ルーム作成にはログインが必須: §3.0） */
async function connectInRoom(port: number, base: string): Promise<TestClient> {
  const hostCookie = await registerCookie(base);
  const client = await TestClient.connect(port, hostCookie);
  client.send({ t: "createRoom", nickname: "ホスト", visibility: "private" });
  await client.waitFor((m) => m.t === "roomState", "roomState(host)");
  return client;
}

/**
 * ルームを1つ作り、ホストと中継先の相手が参加済みのクライアントを返す。
 * rtcSignal は宛先が同室の接続中メンバーでなければ黙って破棄されるため（§3.6）、
 * 「レート制限を通過した件数」を数えるには実在する相手が要る。
 */
async function connectSignalPair(
  port: number,
  base: string,
): Promise<{ host: TestClient; peer: TestClient; peerId: string }> {
  const host = await connectInRoom(port, base);
  const created = host.received().find(
    (m): m is Extract<S2C, { t: "roomState" }> => m.t === "roomState",
  );
  assertExists(created);

  const peer = await TestClient.connect(port);
  peer.send({ t: "join", roomCode: created.snapshot.code, nickname: "相手" });
  const joined = await peer.waitFor((m) => m.t === "roomState", "roomState(peer)");
  assert(joined.t === "roomState");
  return { host, peer, peerId: joined.snapshot.youId };
}

/**
 * rtcSignal のバースト件数。フルメッシュ5本 × trickle ICE を模し、
 * 一般枠 WS_RATE_MAX の2倍を送る（別枠でなければ確実に切断される件数）。
 */
const SIGNAL_BURST = WS_RATE_MAX * 2;

/** rtcSignal を n 件、間を空けずに宛先 to へ送る */
function sendSignals(client: TestClient, count: number, to: string): void {
  for (let i = 0; i < count; i++) {
    client.send({ t: "rtcSignal", to, payload: { kind: "ice" } });
  }
}

/** 中継されて届いた rtcSignal の件数 */
function countRelayed(peer: TestClient): number {
  return peer.received().filter((m) => m.t === "rtcSignal").length;
}

/**
 * rtcSignal を n 件連投し、相手に中継され切るまで待つ。
 * レート制限に弾かれた分は中継されないため、届いた件数が受理件数になる。
 */
async function burstSignals(
  host: TestClient,
  peer: TestClient,
  peerId: string,
  count: number,
): Promise<void> {
  const before = countRelayed(peer);
  sendSignals(host, count, peerId);
  await waitUntil(
    () => countRelayed(peer) >= before + count,
    `rtcSignal ${count}件の中継`,
  );
}

Deno.test("結合: rtcSignal は別枠なので 20件/秒 を超えても切断されない（§3.6 / §3.8）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  const base = `http://127.0.0.1:${server.port}`;
  const { host, peer, peerId } = await connectSignalPair(server.port, base);

  await burstSignals(host, peer, peerId, SIGNAL_BURST);

  assertEquals(host.closeCode, null, "切断されていない");
  assertEquals(host.countError("RATE_LIMITED"), 0, "RATE_LIMITED は届かない");

  await peer.leaveAndClose();
  await host.leaveAndClose();
  assertEquals(server.manager.roomCount, 0);
  await server.shutdown();
  kv.close();
});

/**
 * ソフト上限（WS_SIGNAL_RATE_MAX）を確実に超える rtcSignal のバースト件数。
 * 1つの判定窓に収まる速さで送り切れる前提で件数を決めている。
 */
const SIGNAL_SOFT_BURST = WS_SIGNAL_RATE_MAX + 50;

/**
 * ハードキャップ（WS_SIGNAL_HARD_MAX）を超える rtcSignal のバースト件数。
 * ちょうど最後の1件で超過させる。これより多く送るとサーバーの close フレーム送出後も
 * 送信が続き、close code が 1008 ではなく異常終了扱いになってしまう。
 */
const SIGNAL_HARD_BURST = WS_SIGNAL_HARD_MAX + 1;

Deno.test("結合: rtcSignal はソフト上限を超えても切断されず、超過分だけ破棄される（§3.6 / §3.8）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  const base = `http://127.0.0.1:${server.port}`;
  const { host, peer, peerId } = await connectSignalPair(server.port, base);

  sendSignals(host, SIGNAL_SOFT_BURST, peerId);
  // 受理された分だけが相手に中継される
  await waitUntil(
    () => countRelayed(peer) >= WS_SIGNAL_RATE_MAX,
    `rtcSignal ${WS_SIGNAL_RATE_MAX}件の中継`,
  );
  // WS は順序が保たれるため、バースト後に送ったチャットが届いた時点で全件が処理済み。
  // 通常メッセージが処理されること自体が「切断されず接続が生きている」ことの確認でもある。
  host.send({ t: "chat", text: "バースト後の発言" });
  await waitUntil(
    () => host.received().some((m) => m.t === "chat" && m.message.text === "バースト後の発言"),
    "バースト後のチャット",
  );

  assertEquals(host.closeCode, null, "ソフト上限の超過では切断されない");
  assertEquals(
    countRelayed(peer),
    WS_SIGNAL_RATE_MAX,
    `受理はソフト上限までで、超過 ${SIGNAL_SOFT_BURST - WS_SIGNAL_RATE_MAX} 件は破棄される`,
  );
  // 超過1件ごとに返すとエラーの増幅になるため、判定窓につき1回に絞られている
  assertEquals(host.countError("RATE_LIMITED"), 1, "RATE_LIMITED の通知は判定窓につき1回");

  await peer.leaveAndClose();
  await host.leaveAndClose();
  assertEquals(server.manager.roomCount, 0);
  await server.shutdown();
  kv.close();
});

Deno.test("結合: rtcSignal がハードキャップを超えると乱用とみなして切断される（§3.8）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  const base = `http://127.0.0.1:${server.port}`;
  const client = await connectInRoom(server.port, base);

  // 宛先は実在しなくてよい。レート判定は WS 層で中継より先に走るため（§3.8）
  // 送信はすべて同期ループで済むため、送り終える前に切断されて送信が失敗することはない
  sendSignals(client, SIGNAL_HARD_BURST, "no-such-peer");

  await Promise.race([client.closed, delay(WAIT_TIMEOUT_MS)]);
  assertEquals(client.closeCode, 1008, "policy violation の 1008 で切断される");

  const received = client.received();
  const last = received[received.length - 1];
  assertExists(last);
  assert(last.t === "error" && last.code === "RATE_LIMITED", "切断前に RATE_LIMITED が届く");
  // 切断までに返した RATE_LIMITED は、ソフト上限の通知（窓につき1回）＋ 切断時の1回まで
  assert(
    client.countError("RATE_LIMITED") <= 2,
    `RATE_LIMITED の返信が増幅していない: ${client.countError("RATE_LIMITED")}件`,
  );

  await server.shutdown();
  kv.close();
});

Deno.test("結合: rtcSignal の連投は一般枠を消費しない（§3.8）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  const base = `http://127.0.0.1:${server.port}`;
  const { host, peer, peerId } = await connectSignalPair(server.port, base);

  await burstSignals(host, peer, peerId, SIGNAL_BURST);

  // 一般枠が消費されていなければ、バースト直後の通常メッセージも普通に処理される
  host.send({ t: "chat", text: "バースト後の発言" });
  await waitUntil(
    () => host.received().some((m) => m.t === "chat" && m.message.text === "バースト後の発言"),
    "バースト後のチャット",
  );
  assertEquals(host.closeCode, null, "切断されていない");
  assertEquals(host.countError("RATE_LIMITED"), 0, "RATE_LIMITED は届かない");

  await peer.leaveAndClose();
  await host.leaveAndClose();
  assertEquals(server.manager.roomCount, 0);
  await server.shutdown();
  kv.close();
});
