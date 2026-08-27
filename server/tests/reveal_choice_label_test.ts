/**
 * 選択式（inputType:"choice"）の回答一覧が、添字ではなく選択肢のテキストで出ることのテスト。
 *
 * RevealEntry.value は choice のとき「選択肢の添字」（server/types.ts）なので、
 * そのまま出すと画面に「2」とだけ並び、誰が何を選んだのか読めない。
 * reveal だけでなく judge でも同じ一覧が出る（engine.ts: reveal の次は必ず judge）ため、
 * サーバーが judge の view にも options を載せていることまで含めて確かめる。
 * ただし正解（answerIndex）は reveal 限定で、judge に載ってはいけない。
 *
 * クライアントのファイルだが、app.js が触るブラウザ API は DOM・fetch・WebSocket・
 * sessionStorage・タイマーだけなので、偽物を渡せば Deno から素の JavaScript として
 * 動かせる（app_reconnect_test.ts / voice_client_test.ts と同じ手口）。
 */

import { assert, assertEquals, assertExists, assertFalse } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { buildPhaseView, DEFAULT_PHASE_DURATIONS, reduce, startGame } from "../engine.ts";
import type { GameDefinition, GameState, PhaseView, Prompt } from "../types.ts";
import { createFakeDocument, type FakeElement } from "./fake_dom.ts";

const APP_JS = fromFileUrl(new URL("../../public/app.js", import.meta.url));
const source = await Deno.readTextFile(APP_JS);

const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// サーバー側の状態を作る道具（engine_test.ts と同じ組み立て方）
// ---------------------------------------------------------------------------

/** 選択式クイズの定義。選択肢に HTML に見える文字列を混ぜ、素通しで出ないことも見る */
function choiceDef(over: Partial<GameDefinition> = {}): GameDefinition {
  const prompt: Prompt = {
    kind: "choice",
    text: "好きな動物は？",
    options: ["ねこ", "いぬ", "とり", "<b>きつね</b>"],
    answer: 2,
  };
  return {
    id: "def-choice",
    ownerId: "owner",
    title: "選択式テスト",
    rounds: 1,
    inputType: "choice",
    inputTimeSec: 30,
    reveal: "anonymous",
    scoring: "correct",
    prompts: [prompt],
    ...over,
  };
}

/** 自由入力のゲーム定義（options が無い側の比較用） */
function openDef(over: Partial<GameDefinition> = {}): GameDefinition {
  return {
    id: "def-open",
    ownerId: "owner",
    title: "自由入力テスト",
    rounds: 1,
    inputType: "text",
    inputTimeSec: 30,
    reveal: "anonymous",
    scoring: "vote",
    prompts: [{ kind: "open", text: "お題1" }],
    ...over,
  };
}

/** ホストスキップでフェーズを1段進める */
function skip(state: GameState): GameState {
  const res = reduce(state, { t: "skipPhase", now: T0 });
  assertEquals(res.error, undefined);
  return res.state;
}

/** 全員が提出した直後（reveal）の状態を作る */
function toReveal(def: GameDefinition, ids: string[], values: (string | number)[]): GameState {
  const started = startGame(
    def,
    ids.map((id) => ({ id, nickname: `nick-${id}`, connected: true })),
    T0,
    DEFAULT_PHASE_DURATIONS,
    undefined,
    // startGame は選択肢をシャッフルして answer を振り直す。ここで見たいのは
    // 「添字が選択肢テキストに引き直されるか」なので、並びは定義どおりに固定する。
    // シャッフルそのものの検証は quiz_answer_position_test.ts が行う
    (items) => [...items],
  );
  assertEquals(started.error, undefined);
  let s = skip(skip(started.state)); // intro -> prompt -> input
  ids.forEach((id, i) => {
    s = reduce(s, { t: "submitInput", playerId: id, value: values[i], now: T0 + i + 1 }).state;
  });
  // 全員提出でサーバーが自動的に reveal へ進める
  assertEquals(s.phase, "reveal");
  return s;
}

/** judge の状態を作る */
function toJudge(def: GameDefinition, ids: string[], values: (string | number)[]): GameState {
  const s = skip(toReveal(def, ids, values));
  assertEquals(s.phase, "judge");
  return s;
}

// ---------------------------------------------------------------------------
// クライアント側（public/app.js）を偽の環境で動かす道具
// ---------------------------------------------------------------------------

/** app.js が開く WebSocket の偽物。ここでは開くだけで中身は使わない */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(_data: string): void {}
  close(): void {
    this.readyState = 3;
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

type App = {
  // deno-lint-ignore no-explicit-any
  state: any;
  renderPhase: () => void;
};

type Harness = {
  app: App;
  element: (id: string) => FakeElement;
};

/** app.js を偽の環境で読み込む */
async function load(): Promise<Harness> {
  FakeSocket.instances = [];
  const { document } = createFakeDocument();
  const storage = new Map<string, string>();

  // 起動時に叩く API はすべて「使えない」応答にする（app.js は握りつぶして続行する）
  const fetchStub = () =>
    Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });

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
    `${source}\n; return { state, renderPhase };`,
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
    { getGuestProfile: () => ({ nickname: "", tags: [] }) },
    { consumePendingCreateRoom: () => null, consumePendingJoinRoom: () => null },
    { protocol: "http:", host: "127.0.0.1:8000", href: "" },
    // タイマーは動かさない（描画の検証に秒読みは要らない）
    () => 1,
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
  ) as App;

  // start() は fetch を await してから connect() する。その解決を待つ
  await new Promise((resolve) => setTimeout(resolve, 0));

  return { app, element: (id: string) => document.getElementById(id) };
}

/** view を流し込んで描画させ、回答一覧の表示文字列を取り出す */
function renderLabels(h: Harness, view: PhaseView | Record<string, unknown>): string[] {
  h.app.state.phase = (view as { phase: string }).phase;
  h.app.state.view = view;
  h.app.renderPhase();
  const body = h.element("phase-body");
  const list = body.children.find((child) => child.tagName === "ul");
  assertExists(list, "回答一覧の <ul> が描かれている");
  return list.children.map((item) => {
    const span = item.children.find((child) => child.tagName === "span");
    assertExists(span, "回答1件は <span> で描かれている");
    return span.textContent;
  });
}

// ---------------------------------------------------------------------------
// 表示（public/app.js の renderEntries）
// ---------------------------------------------------------------------------

Deno.test("reveal: choice の回答は添字ではなく選択肢のテキストで出る", async () => {
  const s = toReveal(choiceDef(), ["a", "b"], [2, 0]);
  const view = buildPhaseView(s, "a");
  assertEquals(view.phase, "reveal");

  const h = await load();
  const labels = renderLabels(h, view);

  assertEquals([...labels].sort(), ["とり", "ねこ"]);
  // 生の添字が漏れていないこと（"2" や "0" だけの行が無い）
  for (const label of labels) assertFalse(/^\d+$/.test(label), `添字がそのまま出ている: ${label}`);
});

Deno.test("judge: choice の回答も選択肢のテキストで出る（サーバーが options を載せている）", async () => {
  const s = toJudge(choiceDef(), ["a", "b"], [2, 0]);
  const view = buildPhaseView(s, "a");
  assertEquals(view.phase, "judge");

  const h = await load();
  const labels = renderLabels(h, view);

  assertEquals([...labels].sort(), ["とり", "ねこ"]);
  for (const label of labels) assertFalse(/^\d+$/.test(label), `添字がそのまま出ている: ${label}`);
});

Deno.test('reveal:"named" では「ニックネーム: 選択肢テキスト」で出る', async () => {
  const s = toReveal(choiceDef({ reveal: "named" }), ["a", "b"], [1, 3]);
  const view = buildPhaseView(s, "a");

  const h = await load();
  const labels = renderLabels(h, view);

  assertEquals([...labels].sort(), ["nick-a: いぬ", "nick-b: <b>きつね</b>"].sort());
  // HTML には解釈させない（textContent に生の文字列がそのまま入る）
  assert(
    labels.some((label) => label.includes("<b>きつね</b>")),
    "選択肢はテキストとして入る",
  );
});

Deno.test("open 形式（options 無し）では回答テキストがそのまま出る", async () => {
  const s = toReveal(openDef(), ["a", "b"], ["ねこと和解せよ", "いぬ"]);
  const view = buildPhaseView(s, "a");

  const h = await load();
  assertEquals([...renderLabels(h, view)].sort(), ["いぬ", "ねこと和解せよ"]);
});

Deno.test("添字が範囲外・数値でなくても落ちずに従来どおりの表示になる", async () => {
  // サーバーの view と同じ形。選択肢は3つしか無いのに 99 番や文字列が来た場合
  const view = {
    phase: "judge",
    round: 1,
    totalRounds: 1,
    scoring: "correct",
    inputType: "choice",
    options: ["ねこ", "いぬ", "とり"],
    reveal: "anonymous",
    entries: [
      { playerId: "a", value: 99 },
      { playerId: "b", value: -1 },
      { playerId: "c", value: 1.5 },
      { playerId: "d", value: "ねずみ" },
    ],
    canVote: false,
    votedCount: 0,
    participantCount: 4,
  };

  const h = await load();
  assertEquals(renderLabels(h, view), ["99", "-1", "1.5", "ねずみ"]);

  // options がまったく無い choice でも落ちない
  const noOptions = { ...view, options: undefined };
  assertEquals(renderLabels(h, noOptions), ["99", "-1", "1.5", "ねずみ"]);
});

// ---------------------------------------------------------------------------
// サーバー（engine.ts の buildPhaseView）
// ---------------------------------------------------------------------------

Deno.test("PhaseView: judge に options と inputType が載り、answerIndex は載らない", () => {
  const s = toJudge(choiceDef(), ["a", "b"], [2, 0]);
  const view = buildPhaseView(s, "a");
  assertEquals(view.phase, "judge");
  if (view.phase !== "judge") return;

  assertEquals(view.inputType, "choice");
  assertEquals(view.options, ["ねこ", "いぬ", "とり", "<b>きつね</b>"]);
  // 正解は reveal 限定。judge に混ぜると採点前に答えが割れる
  assertFalse("answerIndex" in view, "judge に answerIndex を載せない");
  assertFalse(JSON.stringify(view).includes("answerIndex"));

  // reveal のほうには従来どおり載っている（取り違えて消していないことの確認）
  const revealView = buildPhaseView(toReveal(choiceDef(), ["a", "b"], [2, 0]), "a");
  if (revealView.phase === "reveal") assertEquals(revealView.answerIndex, 2);
});

Deno.test("PhaseView: open 形式のゲームでは judge の options は undefined", () => {
  const s = toJudge(openDef(), ["a", "b"], ["A", "B"]);
  const view = buildPhaseView(s, "a");
  if (view.phase !== "judge") throw new Error("judge のはず");

  assertEquals(view.inputType, "text");
  assertEquals(view.options, undefined);
});
