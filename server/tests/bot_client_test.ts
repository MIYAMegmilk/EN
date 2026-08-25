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

Deno.test("bot.js: 4体分のトグルを出す", () => {
  const { container } = load();
  const text = container.text();
  for (const name of ["しゅんぴ", "せり", "ぐっちー", "なべ"]) {
    assert(text.includes(name), `${name} のトグルがない`);
  }
});

Deno.test("bot.js: トグルを押せるのはホストだけ（§3.10）", () => {
  const { Bot, container, sent } = load();
  Bot.handleServerMessage(roomState({ youAreHost: false }));
  assertEquals(container.button("せり").disabled, true, "ホスト以外が操作できてしまう");

  Bot.handleServerMessage(roomState({ youAreHost: true }));
  const seri = container.button("せり");
  assertEquals(seri.disabled, false);
  seri.click();
  assertEquals(sent, [{ t: "setBot", botId: "seri", enabled: false }]);
});

Deno.test("bot.js: ON/OFF はサーバーの botState で反映する（楽観更新しない）", () => {
  const { Bot, container } = load();
  Bot.handleServerMessage(roomState({ youAreHost: true }));
  container.button("せり").click();
  // 送っただけでは変わらない
  assertEquals(Bot.getState().bots.seri, true);

  Bot.handleServerMessage({
    t: "botState",
    bots: { shunpi: true, seri: false, gucchi: true, nabe: true },
  });
  assertEquals(Bot.getState().bots.seri, false);
  assert(container.text().includes("せり（OFF）"), "OFF が表示に出ていない");
});

Deno.test("bot.js: 川柳テロップに三句・モーラ数・詠み手を出す", () => {
  const { Bot, container } = load();
  Bot.handleServerMessage(senryuMessage());
  const text = container.text();
  for (const line of ["ふるいけや", "かわずとびこむ", "みずのおと"]) {
    assert(text.includes(line), `句が出ていない: ${line}`);
  }
  assert(text.includes("五七五"));
  assert(text.includes("たろう さんの一句"));
});

Deno.test("bot.js: 字余り・字足らずはラベルを出し分ける", () => {
  const { Bot, container } = load();
  const message = senryuMessage("たろう", false);
  message.message.card.morae = [5, 8, 5];
  Bot.handleServerMessage(message);
  assert(container.text().includes("字余り"));
  assertEquals(Bot.shapeLabel([4, 7, 5]), "字足らず");
  assertEquals(Bot.shapeLabel([4, 8, 5]), "字余り字足らず");
  assertEquals(Bot.shapeLabel([5, 7, 5]), "五七五");
});

Deno.test("bot.js: あだ名は textContent で入れる（innerHTML を使わない・§3.8）", () => {
  const { Bot, container } = load();
  const evil = '<img src=x onerror="alert(1)">';
  Bot.handleServerMessage(senryuMessage(evil));
  // 生の文字列がそのままテキストとして入っていること（＝HTML として解釈していない）
  assert(container.text().includes(evil));
  // コメントでは「使わない」と書いてあるので、コードだけを見る
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert(!code.includes("innerHTML"), "bot.js が innerHTML を使っている");
});

Deno.test("bot.js: ゲーム提案カードからゲームを選べる（ホストのみ）", () => {
  const { Bot, container, sent } = load();
  const suggest = {
    t: "chat",
    message: {
      bot: true,
      botId: "gucchi",
      botKind: "gameSuggest",
      card: { c: "gameSuggest", gameId: "official-ogiri", gameTitle: "大喜利" },
    },
  };
  Bot.handleServerMessage(roomState({ youAreHost: false }));
  Bot.handleServerMessage(suggest);
  assert(container.text().includes("大喜利"));
  assertEquals(container.button("これで遊ぶ").disabled, true, "ホスト以外が選べてしまう");

  Bot.handleServerMessage(roomState({ youAreHost: true }));
  Bot.handleServerMessage(suggest);
  container.button("これで遊ぶ").click();
  assertEquals(sent.at(-1), { t: "selectGame", gameId: "official-ogiri" });
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

Deno.test("bot.js: 再接続すると集計中のアンケートと直近のカードが戻る（§3.2）", () => {
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
  assertEquals(Bot.getState().card?.c, "senryu");
  assert(container.text().includes("そろそろお開きにしますか？"));
});

Deno.test("bot.js: bot 以外の発言や card なしの発話には反応しない", () => {
  const { Bot } = load();
  Bot.handleServerMessage({ t: "chat", message: { bot: false, text: "こんばんは" } });
  Bot.handleServerMessage({ t: "chat", message: { bot: true, text: "いらっしゃい" } });
  assertEquals(Bot.getState().card, null);
  assertEquals(Bot.getState().poll, null);
});

Deno.test("bot.js: ホストが変わったら操作権も移る", () => {
  const { Bot, container } = load();
  Bot.setSelfId("p1");
  Bot.handleServerMessage(roomState({ youAreHost: false }));
  assertEquals(container.button("せり").disabled, true);

  Bot.handleServerMessage({ t: "hostChanged", playerId: "p1" });
  assertEquals(Bot.getState().isHost, true);
  assertEquals(container.button("せり").disabled, false);
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
