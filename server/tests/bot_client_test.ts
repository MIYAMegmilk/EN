/**
 * public/room/bot.js（bot の表示）のテスト。ひろし担当。
 *
 * クライアントのファイルだが、触るのは DOM とタイマーだけなので、
 * 最小限の偽 document を用意すれば Deno から素の JavaScript として動かせる。
 * ここで見るのは「何をサーバーへ送るか」と「ユーザー由来のテキストを
 * textContent で入れているか（§3.8）」の2点。
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const BOT_JS = fromFileUrl(new URL("../../public/room/bot.js", import.meta.url));
const source = await Deno.readTextFile(BOT_JS);

/** 最小限の DOM。textContent と子要素だけを持つ */
class FakeElement {
  children: FakeElement[] = [];
  textContent = "";
  className = "";
  type = "";
  title = "";
  disabled = false;
  attributes: Record<string, string> = {};
  private listeners: Record<string, Array<() => void>> = {};
  private classes = new Set<string>();

  constructor(public tag: string) {}

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): void {
    this.children = this.children.filter((c) => c !== child);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  /** クリックを起こす */
  click(): void {
    for (const fn of this.listeners.click ?? []) fn();
  }

  readonly classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, on?: boolean) => {
      const next = on ?? !this.classes.has(name);
      if (next) this.classes.add(name);
      else this.classes.delete(name);
      return next;
    },
  };

  /** 部分木の全要素（自分を含む） */
  all(): FakeElement[] {
    return [this as FakeElement, ...this.children.flatMap((c) => c.all())];
  }

  /** 部分木のテキストを連結する */
  text(): string {
    return this.all().map((n) => n.textContent).join(" ");
  }

  /** 部分木のボタンのうち、表示文言が一致するもの */
  button(label: string): FakeElement {
    const found = this.all().find((n) => n.tag === "button" && n.textContent === label);
    assert(found !== undefined, `「${label}」ボタンが見つからない: ${this.text()}`);
    return found;
  }
}

type Sent = Record<string, unknown>;

/** bot.js を読み込んだ偽 window を1つ作る */
function load() {
  const sent: Sent[] = [];
  const errors: string[] = [];
  const intervals = new Map<number, () => void>();
  let seq = 0;
  const container = new FakeElement("div");
  // deno-lint-ignore no-explicit-any
  const win: any = {
    document: { createElement: (tag: string) => new FakeElement(tag) },
    setInterval: (fn: () => void) => {
      intervals.set(++seq, fn);
      return seq;
    },
    clearInterval: (id: number) => intervals.delete(id),
  };
  // bot.js は document をグローバル名で参照する（window 経由ではない）
  new Function("window", "document", source)(win, win.document);
  win.Bot.init({
    send: (msg: Sent) => sent.push(msg),
    container,
    onError: (message: string) => errors.push(message),
  });
  return { Bot: win.Bot, sent, errors, container, intervals };
}

/** roomState を1件作る */
function roomState(overrides: Record<string, unknown> = {}) {
  return {
    t: "roomState",
    snapshot: {
      youId: "p1",
      youAreHost: false,
      hostId: "p9",
      bots: { shunpi: true, seri: true, gucchi: true, nabe: true },
      chat: [],
      ...overrides,
    },
  };
}

/** せりの川柳発話を1件作る */
function senryuMessage(author = "たろう", exact = true) {
  return {
    t: "chat",
    message: {
      id: "m1",
      playerId: null,
      nickname: "せり",
      text: "一句できました",
      at: 0,
      bot: true,
      botId: "seri",
      botKind: "senryu",
      card: {
        c: "senryu",
        lines: ["ふるいけや", "かわずとびこむ", "みずのおと"],
        morae: [5, 7, 5],
        exact,
        author,
      },
    },
  };
}

Deno.test("bot.js: 4体分の ON/OFF を持つ", () => {
  const { Bot } = load();
  const bots = Bot.getState().bots;
  for (const id of ["shunpi", "seri", "gucchi", "nabe"]) {
    assertEquals(bots[id], true, `${id} の初期状態がない`);
  }
});

Deno.test("bot.js: 切り替えられるのはホストだけ（§3.10）", () => {
  const { Bot, sent } = load();
  Bot.handleServerMessage(roomState({ youAreHost: false }));
  assertEquals(Bot.toggle("seri"), false, "ホスト以外が操作できてしまう");
  assertEquals(sent, []);

  Bot.handleServerMessage(roomState({ youAreHost: true }));
  assertEquals(Bot.toggle("seri"), true);
  assertEquals(sent, [{ t: "setBot", botId: "seri", enabled: false }]);
});

Deno.test("bot.js: 知らない botId は切り替えない", () => {
  const { Bot, sent } = load();
  Bot.handleServerMessage(roomState({ youAreHost: true }));
  assertEquals(Bot.toggle("dareka"), false);
  assertEquals(sent, []);
});

Deno.test("bot.js: ON/OFF はサーバーの botState で反映する（楽観更新しない）", () => {
  const { Bot } = load();
  Bot.handleServerMessage(roomState({ youAreHost: true }));
  Bot.toggle("seri");
  // 送っただけでは変わらない
  assertEquals(Bot.getState().bots.seri, true);

  Bot.handleServerMessage({
    t: "botState",
    bots: { shunpi: true, seri: false, gucchi: true, nabe: true },
  });
  assertEquals(Bot.getState().bots.seri, false);
  // 2度目は「入れる」側を送る
  Bot.toggle("seri");
  assertEquals(Bot.getState().bots.seri, false);
});

Deno.test("bot.js: 字余り・字足らずはラベルを出し分ける", () => {
  const { Bot } = load();
  assertEquals(Bot.shapeLabel([5, 8, 5]), "字余り");
  assertEquals(Bot.shapeLabel([4, 7, 5]), "字足らず");
  assertEquals(Bot.shapeLabel([4, 8, 5]), "字余り字足らず");
  assertEquals(Bot.shapeLabel([5, 7, 5]), "五七五");
});

Deno.test("bot.js: 川柳とゲーム提案には手を出さない（表示はチャットの行）", () => {
  const { Bot, container } = load();
  Bot.handleServerMessage(senryuMessage());
  // 句も詠み手もこのモジュールは描かない（app.js の renderChatCard が描く）
  const text = container.text();
  assert(!text.includes("ふるいけや"), "bot.js が川柳を描いている");
  assert(!text.includes("たろう"), "bot.js が詠み手を描いている");
});

Deno.test("bot.js: innerHTML を使わない（§3.8）", () => {
  // コメントでは「使わない」と書いてあるので、コードだけを見る
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert(!code.includes("innerHTML"), "bot.js が innerHTML を使っている");
});

Deno.test("bot.js: ゲーム提案にも手を出さない（押す口はチャットの行）", () => {
  const { Bot, container, sent } = load();
  Bot.handleServerMessage(roomState({ youAreHost: true }));
  Bot.handleServerMessage({
    t: "chat",
    message: {
      bot: true,
      botId: "gucchi",
      botKind: "gameSuggest",
      card: { c: "gameSuggest", gameId: "official-ogiri", gameTitle: "大喜利" },
    },
  });
  assert(!container.text().includes("これで遊ぶ"), "bot.js が提案を描いている");
  assertEquals(sent, []);
});

Deno.test("bot.js: 終了アンケートに投票できる", () => {
  const { Bot, container, sent } = load();
  const deadline = Date.now() + 60_000;
  Bot.handleServerMessage({
    t: "chat",
    message: {
      bot: true,
      botId: "gucchi",
      botKind: "endPoll",
      card: { c: "endPoll", pollId: "poll-1", deadline },
    },
  });
  assert(container.text().includes("そろそろお開きにしますか？"));
  container.button("お開き").click();
  assertEquals(sent.at(-1), { t: "endPollVote", pollId: "poll-1", agree: true });
  assertEquals(Bot.getState().myVote, true);

  // 締切までは投票し直せる
  container.button("まだ続ける").click();
  assertEquals(sent.at(-1), { t: "endPollVote", pollId: "poll-1", agree: false });
  assertEquals(Bot.getState().myVote, false);
});

Deno.test("bot.js: アンケートが締まったら結果を出し、タイマーを残さない", () => {
  const { Bot, container, intervals } = load();
  Bot.handleServerMessage({
    t: "chat",
    message: {
      bot: true,
      card: { c: "endPoll", pollId: "poll-1", deadline: Date.now() + 60_000 },
    },
  });
  assertEquals(intervals.size, 1, "カウントダウンが動いていない");

  Bot.handleServerMessage({ t: "botPollClosed", pollId: "poll-1", agreed: true });
  assertEquals(Bot.getState().poll, null);
  assertEquals(intervals.size, 0, "タイマーが残っている");
  assert(container.text().includes("お開きに決まりました"));
});

Deno.test("bot.js: 別のアンケートの結果は無視する（遅延した通知よけ）", () => {
  const { Bot } = load();
  Bot.handleServerMessage({
    t: "chat",
    message: { bot: true, card: { c: "endPoll", pollId: "poll-2", deadline: Date.now() + 60_000 } },
  });
  Bot.handleServerMessage({ t: "botPollClosed", pollId: "poll-1", agreed: true });
  assert(Bot.getState().poll !== null, "集計中のアンケートが消えている");
});

Deno.test("bot.js: 再接続すると集計中のアンケートが戻る（§3.2）", () => {
  const { Bot, container } = load();
  const deadline = Date.now() + 30_000;
  Bot.handleServerMessage(roomState({
    botPoll: { pollId: "poll-9", deadline },
    chat: [
      {
        bot: true,
        card: { c: "senryu", lines: ["あ", "い", "う"], morae: [5, 7, 5], author: "は" },
      },
      { bot: false, text: "ふつうの発言" },
    ],
  }));
  assertEquals(Bot.getState().poll, { pollId: "poll-9", deadline });
  assert(container.text().includes("そろそろお開きにしますか？"));
  // カードの復元は要らない（チャット履歴ごと chat.js が描き直す）
  assert(!container.text().includes("あ"), "bot.js がカードを復元している");
});

Deno.test("bot.js: bot 以外の発言や card なしの発話には反応しない", () => {
  const { Bot } = load();
  Bot.handleServerMessage({ t: "chat", message: { bot: false, text: "こんばんは" } });
  Bot.handleServerMessage({ t: "chat", message: { bot: true, text: "いらっしゃい" } });
  assertEquals(Bot.getState().poll, null);
});

Deno.test("bot.js: ホストが変わったら操作権も移る", () => {
  const { Bot } = load();
  Bot.setSelfId("p1");
  Bot.handleServerMessage(roomState({ youAreHost: false }));
  assertEquals(Bot.toggle("seri"), false);

  Bot.handleServerMessage({ t: "hostChanged", playerId: "p1" });
  assertEquals(Bot.getState().isHost, true);
  assertEquals(Bot.toggle("seri"), true);
});

Deno.test("bot.js: キックされたら表示と状態を捨てる", () => {
  const { Bot, intervals } = load();
  Bot.handleServerMessage(roomState({ youAreHost: true }));
  Bot.handleServerMessage({
    t: "chat",
    message: { bot: true, card: { c: "endPoll", pollId: "p", deadline: Date.now() + 60_000 } },
  });
  Bot.handleServerMessage({ t: "kicked" });
  assertEquals(Bot.getState().poll, null);
  assertEquals(Bot.getState().isHost, false);
  assertEquals(intervals.size, 0, "タイマーが残っている");
});

Deno.test("bot.js: 音声合成には触れない（bot の発話はチャットのみ・§3.10）", () => {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert(
    !code.includes("speechSynthesis") && !code.includes("SpeechSynthesisUtterance"),
    "bot の表示モジュールが読み上げを持ち込んでいる",
  );
});
