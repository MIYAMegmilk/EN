/**
 * public/room/chat.js の行の組み方のテスト。
 *
 * 見るのは2点。
 *   1. bot の発言者名に data-bot-id が付くこと（個体色は CSS が引く）。
 *      色そのものは CSS 変数なので、ここで検査できるのは「印が付くか」まで
 *   2. 同じ人が1分以内に続けて喋った行で、時刻・bot の札・名前を出さないこと
 *
 * クライアントのファイルだが、chat.js が触るのは DOM だけなので、
 * 偽の document を渡せば Deno から素の JavaScript として動かせる
 * （bot_client_test.ts / client_resilience_test.ts と同じ手口）。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createFakeDocument, FakeElement } from "./fake_dom.ts";

const CHAT_JS = fromFileUrl(new URL("../../public/room/chat.js", import.meta.url));
const source = await Deno.readTextFile(CHAT_JS);

/** 1分。chat.js の GROUP_WINDOW_MS と同じ値 */
const WINDOW_MS = 60_000;

type ChatMessage = {
  at: number;
  nickname: string;
  text: string;
  playerId?: string;
  bot?: boolean;
  botId?: string;
};

/** chat.js を読み込み、描画先の <ul> を返す */
function load() {
  const list = new FakeElement("ul", "chat-log");
  const input = new FakeElement("input", "chat-input");
  const form = new FakeElement("form", "chat-form");
  const elements = new Map([
    ["chat-log", list],
    ["chat-input", input],
    ["chat-form", form],
  ]);
  const { document } = createFakeDocument(elements);
  const window: Record<string, unknown> = { document };
  // chat.js は (function (global) { ... })(window) の形。global に window を渡す
  new Function("window", "document", `${source}\nreturn window.Chat;`)(window, document);
  const chat = window.Chat as {
    init(options: Record<string, unknown>): void;
    handleServerMessage(msg: unknown): void;
    setSelfId(id: string | null): void;
  };
  chat.init({
    send: () => true,
    listEl: list,
    inputEl: input,
    formEl: form,
    onError: () => {},
  });
  return { chat, list };
}

/** 履歴をまとめて流し込む（roomState 経由。1件ずつ push しても結果は同じ） */
function feed(chat: { handleServerMessage(msg: unknown): void }, chatLog: ChatMessage[]) {
  chat.handleServerMessage({ t: "roomState", snapshot: { chat: chatLog } });
}

/** 行の中に、その class を持つ子があるか */
function has(row: FakeElement, className: string): boolean {
  return row.children.some((c) => c.className.split(" ").includes(className));
}

/** 行の中の、その class を持つ最初の子 */
function pick(row: FakeElement, className: string): FakeElement | undefined {
  return row.children.find((c) => c.className.split(" ").includes(className));
}

const base = 1_700_000_000_000;

Deno.test("チャット: bot の名前に個体色を引くための data-bot-id が付く", () => {
  const { chat, list } = load();
  feed(chat, [
    { at: base, nickname: "せり", text: "一句できました", bot: true, botId: "seri" },
    { at: base + 1000, nickname: "ぐっちー", text: "いいですね", bot: true, botId: "gucchi" },
  ]);

  assertEquals(list.children.length, 2);
  const first = pick(list.children[0], "chat-nickname");
  assert(first !== undefined);
  assertEquals(first.dataset.botId, "seri");
  const second = pick(list.children[1], "chat-nickname");
  assert(second !== undefined);
  assertEquals(second.dataset.botId, "gucchi");
});

Deno.test("チャット: 人の発言には data-bot-id を付けない", () => {
  const { chat, list } = load();
  feed(chat, [{ at: base, nickname: "ちいかわ", text: "こんばんは", playerId: "p1" }]);

  const nickname = pick(list.children[0], "chat-nickname");
  assert(nickname !== undefined);
  assertEquals(nickname.dataset.botId, undefined);
});

Deno.test("チャット: 同じ人が1分以内に続けたら、時刻・名前を出さない", () => {
  const { chat, list } = load();
  feed(chat, [
    { at: base, nickname: "ちいかわ", text: "ひとつめ", playerId: "p1" },
    { at: base + WINDOW_MS - 1, nickname: "ちいかわ", text: "ふたつめ", playerId: "p1" },
  ]);

  assertEquals(list.children.length, 2);
  assert(has(list.children[0], "chat-time"), "1件目は時刻を出す");
  assert(has(list.children[0], "chat-nickname"), "1件目は名前を出す");

  const cont = list.children[1];
  assert(cont.className.split(" ").includes("chat-cont"), "続きの行と分かる印が付く");
  assertFalse(has(cont, "chat-time"), "続きの行に時刻は出さない");
  assertFalse(has(cont, "chat-nickname"), "続きの行に名前は出さない");
  assert(has(cont, "chat-text"), "本文は出す");
  // 読み上げでは誰の発言か分かるようにしておく
  const sr = pick(cont, "sr-only");
  assert(sr !== undefined, "読み上げ用の発言者名を置く");
  assertEquals(sr.textContent, "ちいかわ");
});

Deno.test("チャット: 1分を超えたら、同じ人でも名前を出す", () => {
  const { chat, list } = load();
  feed(chat, [
    { at: base, nickname: "ちいかわ", text: "ひとつめ", playerId: "p1" },
    { at: base + WINDOW_MS + 1, nickname: "ちいかわ", text: "ふたつめ", playerId: "p1" },
  ]);

  assert(has(list.children[1], "chat-nickname"), "間が空いたら名前を出す");
  assert(has(list.children[1], "chat-time"));
});

Deno.test("チャット: 1分の起点は直前の発言（3件続けば通算では超えていてもまとめる）", () => {
  const { chat, list } = load();
  const gap = WINDOW_MS - 1000;
  feed(chat, [
    { at: base, nickname: "ちいかわ", text: "1", playerId: "p1" },
    { at: base + gap, nickname: "ちいかわ", text: "2", playerId: "p1" },
    { at: base + gap * 2, nickname: "ちいかわ", text: "3", playerId: "p1" },
  ]);

  // 3件目は1件目から見れば1分を超えているが、直前（2件目）からは1分以内
  assertFalse(has(list.children[1], "chat-nickname"));
  assertFalse(has(list.children[2], "chat-nickname"));
});

Deno.test("チャット: 別の人が挟まったらまとめない", () => {
  const { chat, list } = load();
  feed(chat, [
    { at: base, nickname: "ちいかわ", text: "1", playerId: "p1" },
    { at: base + 1000, nickname: "はちわれ", text: "2", playerId: "p2" },
    { at: base + 2000, nickname: "ちいかわ", text: "3", playerId: "p1" },
  ]);

  assert(has(list.children[1], "chat-nickname"), "別の人は名前を出す");
  assert(has(list.children[2], "chat-nickname"), "挟まれた後は名前を出し直す");
});

Deno.test("チャット: 別の bot 同士はまとめない", () => {
  const { chat, list } = load();
  feed(chat, [
    { at: base, nickname: "せり", text: "1", bot: true, botId: "seri" },
    { at: base + 1000, nickname: "ぐっちー", text: "2", bot: true, botId: "gucchi" },
  ]);

  assert(has(list.children[1], "chat-nickname"), "別の bot は名前を出す");
});

Deno.test("チャット: 同じ bot が続けたらまとめる", () => {
  const { chat, list } = load();
  feed(chat, [
    { at: base, nickname: "ぐっちー", text: "1", bot: true, botId: "gucchi" },
    { at: base + 1000, nickname: "ぐっちー", text: "2", bot: true, botId: "gucchi" },
  ]);

  assertFalse(has(list.children[1], "chat-nickname"));
  assertFalse(has(list.children[1], "chat-badge-bot"), "続きの行に bot の札は出さない");
});

Deno.test("チャット: あだ名が変わったらまとめない（新しい名前が出ないと分からない）", () => {
  const { chat, list } = load();
  feed(chat, [
    { at: base, nickname: "ちいかわ", text: "1", playerId: "p1" },
    { at: base + 1000, nickname: "よふかしフクロウ", text: "2", playerId: "p1" },
  ]);

  const nickname = pick(list.children[1], "chat-nickname");
  assert(nickname !== undefined, "改名後は名前を出す");
  assertEquals(nickname.textContent, "よふかしフクロウ");
});

Deno.test("チャット: 時刻が逆行していたらまとめない", () => {
  const { chat, list } = load();
  feed(chat, [
    { at: base + 5000, nickname: "ちいかわ", text: "1", playerId: "p1" },
    { at: base, nickname: "ちいかわ", text: "2", playerId: "p1" },
  ]);

  assert(has(list.children[1], "chat-nickname"), "間隔が読めないときは名前を出す");
});

Deno.test("チャット: 発言者が分からない行は前後どちらともまとめない", () => {
  const { chat, list } = load();
  feed(chat, [
    { at: base, nickname: "名無し", text: "1" },
    { at: base + 1000, nickname: "名無し", text: "2" },
  ]);

  assert(has(list.children[1], "chat-nickname"));
});
