/**
 * ビューモジュール（public/room/games/*.js）の **二重送信ガードと残量の見積もり** のテスト。
 *
 * ここで見るのは次の3つ（監査 H-5 / H-6 / H-7）。
 *   - chicken.js  … 提出ボタンの連打で submit を二度送らないこと（DUPLICATE の赤帯が出る）
 *   - wordwolf.js … 投票・言い当ての連打で二度送らないこと（同上）
 *   - draw.js     … サーバーの view 間引きで pointCount が遅れて届いても、
 *                   点数の上限ちょうどまで描け、超えては送らないこと
 *
 * あわせて draw.js の「描き続けられなくなる」2件（監査 M-5 / M-7）も見る。
 *   - ポインタ捕捉に失敗した環境で、canvas の外で離しても線が終わること
 *   - 「全部消す」を繰り返してもストロークIDがサーバーの受理範囲を超えないこと
 *
 * ガードは「押せなくして終わり」では困る。次の2つも必ず確かめる。
 *   - **持ち越さない**: ラウンド・フェーズ・ターンが変われば送り直せる
 *   - **詰まない**: サーバーに弾かれて（＝view が「まだ提出していない」と言って）きたら送り直せる
 *
 * 偽 DOM はこのファイルに閉じてある（client_view_smoke_test.ts / client_view_resize_test.ts
 * と同じ作り。本物の DOM を再現するものではなく、ビューモジュールが呼ぶ範囲だけを埋める）。
 */

import { assert, assertEquals } from "@std/assert";

// ---------------------------------------------------------------------------
// 偽 DOM
// ---------------------------------------------------------------------------

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent = "";
  className = "";
  type = "";
  value = "";
  placeholder = "";
  maxLength = 0;
  alt = "";
  src = "";
  width = 0;
  height = 0;
  disabled = false;
  draggable = false;
  decoding = "";
  /** getBoundingClientRect が返す寸法。テストから setRect で差し替える */
  rect = { left: 0, top: 0, width: 0, height: 0 };
  // deno-lint-ignore no-explicit-any
  readonly style: Record<string, any> = { setProperty: () => {} };
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly handlers = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly tagName: string) {}

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement): void {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parent = null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    const bucket = this.handlers.get(type) ?? [];
    bucket.push(handler);
    this.handlers.set(type, bucket);
  }
  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const bucket = this.handlers.get(type);
    if (bucket === undefined) return;
    const at = bucket.indexOf(handler);
    if (at >= 0) bucket.splice(at, 1);
  }
  /** 登録されているハンドラを呼ぶ（クリック・キー操作・ポインタ操作の再現） */
  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) {
      handler({ target: this, preventDefault: () => {}, ...event });
    }
  }
  closest(selector: string): FakeElement | null {
    if (this.tagName === selector) return this;
    return this.parent === null ? null : this.parent.closest(selector);
  }
  contains(other: FakeElement | null): boolean {
    let node = other;
    while (node !== null) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }
  /** 表示されている大きさを差し替える */
  setRect(width: number, height: number, left = 0, top = 0): void {
    this.rect = { left, top, width, height };
  }
  getBoundingClientRect() {
    if (this.rect.width > 0 || this.rect.height > 0) return this.rect;
    return { left: 0, top: 0, width: this.width || 480, height: this.height || 480 };
  }
  getContext(): Record<string, unknown> {
    const noop = () => {};
    return new Proxy({ canvas: this }, {
      get: (target, key) => {
        if (key in target) return (target as Record<string | symbol, unknown>)[key];
        return noop;
      },
      set: () => true,
    });
  }
  handlerCount(): number {
    let total = 0;
    for (const bucket of this.handlers.values()) total += bucket.length;
    for (const child of this.children) total += child.handlerCount();
    return total;
  }
  text(): string {
    return this.textContent + this.children.map((c) => c.text()).join("");
  }
  findAll(tagName: string, out: FakeElement[] = []): FakeElement[] {
    for (const child of this.children) {
      if (child.tagName === tagName) out.push(child);
      child.findAll(tagName, out);
    }
    return out;
  }
}

class FakeImage extends FakeElement {
  constructor() {
    super("img");
  }
}

/** ResizeObserver 1件ぶんの控え（解除漏れを見るのに使う） */
interface ObserverRec {
  target: FakeElement | null;
  cb: () => void;
  disconnected: boolean;
}

/** ビューモジュールを動かすのに要る globalThis を差し込む。戻り値で元に戻す */
function installDom(): {
  restore: () => void;
  frames: (() => void)[];
  observers: ObserverRec[];
  fireResize: (target: FakeElement) => void;
} {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  const frames: (() => void)[] = [];
  const observers: ObserverRec[] = [];
  const set = (key: string, value: unknown) => {
    saved[key] = g[key];
    g[key] = value;
  };

  class FakeResizeObserver {
    private readonly rec: ObserverRec;
    constructor(cb: () => void) {
      this.rec = { target: null, cb, disconnected: false };
      observers.push(this.rec);
    }
    observe(target: FakeElement): void {
      this.rec.target = target;
    }
    disconnect(): void {
      this.rec.disconnected = true;
    }
  }

  set("document", {
    createElement: (tag: string) => tag === "img" ? new FakeImage() : new FakeElement(tag),
  });
  set("Image", FakeImage);
  set("HTMLImageElement", FakeImage);
  set("Element", FakeElement);
  set("devicePixelRatio", 2);
  set("ResizeObserver", FakeResizeObserver);
  set("requestAnimationFrame", (fn: (t: number) => void) => {
    frames.push(() => fn(performance.now()));
    return frames.length;
  });
  set("cancelAnimationFrame", () => {});

  return {
    frames,
    observers,
    fireResize: (target: FakeElement) => {
      for (const rec of [...observers]) {
        if (!rec.disconnected && rec.target === target) rec.cb();
      }
    },
    restore: () => {
      for (const [key, value] of Object.entries(saved)) g[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------
// 共通の小道具
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const YOU = "you-1";
const OTHER = "other-1";
const OTHER_NAME = "あいて";
/** draw.js の CANVAS_SIZE（サーバーの DRAW_COORD_MAX + 1）と同じ */
const DRAW_SIZE = 480;
/** draw.js / server の 1チャンク上限と同じ */
const MAX_CHUNK_POINTS = 64;

// deno-lint-ignore no-explicit-any
async function loadGame(id: string): Promise<any> {
  return await import(`../../../public/room/games/${id}.js`);
}

function makeApi(sent: unknown[], now = { value: T0 }) {
  return {
    send: (payload: unknown) => sent.push(payload),
    youId: YOU,
    isHost: true,
    serverNow: () => now.value,
  };
}

/** ビューモジュールが返す取っ手（update と unmount だけ使う） */
interface GameHandle {
  update: (view: unknown, deadline: number | null) => void;
  unmount: () => void;
}

/** mount してから片付けまでを面倒みる（後始末の確認つき） */
async function withGame(
  id: string,
  drive: (ctx: {
    handle: GameHandle;
    container: FakeElement;
    sent: unknown[];
    dom: ReturnType<typeof installDom>;
  }) => void,
) {
  const dom = installDom();
  try {
    const module = await loadGame(id);
    const container = new FakeElement("div");
    const sent: unknown[] = [];
    const handle = module.mount(container, makeApi(sent)) as GameHandle;
    drive({ handle, container, sent, dom });
    handle.unmount();
    assertEquals(container.children.length, 0, `${id}: unmount で片付いていない`);
    assertEquals(container.handlerCount(), 0, `${id}: リスナが残っている`);
  } finally {
    dom.restore();
  }
}

/** 表示文字の一致するボタンを1つ探す */
function buttonByText(container: FakeElement, text: string): FakeElement {
  const found = container.findAll("button").find((b) => b.textContent === text);
  assert(found !== undefined, `「${text}」ボタンが見つからない`);
  return found;
}

/** 送られた payload のうち k が一致するものを数える */
function countKind(sent: unknown[], kind: string): number {
  return sent.filter((p) => (p as { k?: string }).k === kind).length;
}

/**
 * canvas の外でポインタを離したときの再現。
 *
 * ポインタ捕捉（setPointerCapture）が効かない環境では、canvas の外で離した
 * pointerup / pointercancel は canvas に届かず window にだけ届く。
 * 偽 DOM は canvas しか持たないので、window ぶんは本物の EventTarget で起こす
 */
function firePointerOnWindow(type: "pointerup" | "pointercancel", pointerId: number): void {
  const event = new Event(type);
  Object.assign(event, { pointerId, preventDefault: () => {} });
  globalThis.dispatchEvent(event);
}

// ---------------------------------------------------------------------------
// chicken（H-5）: 提出の二重送信ガード
// ---------------------------------------------------------------------------

function chickenView(
  opts: { round?: number; phase?: string; mySubmission?: number | null } = {},
) {
  const round = opts.round ?? 1;
  const phase = opts.phase ?? "submit";
  const mySubmission = opts.mySubmission ?? null;
  return {
    kind: "chicken",
    phase,
    round,
    totalRounds: 3,
    playerCount: 2,
    submittedCount: mySubmission === null ? 0 : 1,
    mySubmission,
    players: [
      { playerId: YOU, nickname: "じぶん", submitted: mySubmission !== null, connected: true },
      { playerId: OTHER, nickname: OTHER_NAME, submitted: false, connected: true },
    ],
    standings: [
      { playerId: YOU, nickname: "じぶん", wins: 0, rank: 1 },
      { playerId: OTHER, nickname: OTHER_NAME, wins: 0, rank: 1 },
    ],
  };
}

Deno.test("chicken: 提出ボタンを連打しても submit は1回しか送らない", async () => {
  await withGame("chicken", ({ handle, container, sent }) => {
    handle.update(chickenView(), null);
    const input = container.findAll("input")[0];
    const submit = buttonByText(container, "提出する");
    input.value = "42";
    submit.fire("click");
    submit.fire("click");
    submit.fire("click");
    assertEquals(countKind(sent, "submit"), 1, "連打で二重に送っている");
    assertEquals(submit.disabled, true, "送った後もボタンが押せるままになっている");
  });
});

Deno.test("chicken: Enter 連打でも submit は1回しか送らない", async () => {
  await withGame("chicken", ({ handle, container, sent }) => {
    handle.update(chickenView(), null);
    const input = container.findAll("input")[0];
    input.value = "7";
    input.fire("keydown", { key: "Enter" });
    input.fire("keydown", { key: "Enter" });
    assertEquals(countKind(sent, "submit"), 1, "Enter 連打で二重に送っている");
  });
});

Deno.test("chicken: ラウンドが変われば また提出できる（ガードを持ち越さない）", async () => {
  await withGame("chicken", ({ handle, container, sent }) => {
    handle.update(chickenView({ round: 1 }), null);
    const input = container.findAll("input")[0];
    const submit = buttonByText(container, "提出する");
    input.value = "42";
    submit.fire("click");
    submit.fire("click"); // 連打ぶんは捨てられる
    assertEquals(countKind(sent, "submit"), 1);

    // 提出が通り、公開されて、次のラウンドが始まる
    handle.update(chickenView({ round: 1, phase: "reveal", mySubmission: 42 }), null);
    handle.update(chickenView({ round: 2 }), null);
    assertEquals(submit.disabled, false, "次のラウンドでボタンが戻っていない");

    input.value = "13";
    submit.fire("click");
    submit.fire("click");
    assertEquals(countKind(sent, "submit"), 2, "ラウンドが変わっても送れないままになっている");
  });
});

Deno.test("chicken: サーバーに弾かれたら、同じラウンドで出し直せる（詰まない）", async () => {
  await withGame("chicken", ({ handle, container, sent }) => {
    handle.update(chickenView(), null);
    const input = container.findAll("input")[0];
    const submit = buttonByText(container, "提出する");
    input.value = "42";
    submit.fire("click");
    assertEquals(countKind(sent, "submit"), 1);

    // 弾かれた（＝提出は残っていない）ことは、次の view の mySubmission が null であることで分かる
    handle.update(chickenView({ mySubmission: null }), null);
    assertEquals(submit.disabled, false, "弾かれた後もボタンが無効のままになっている");
    submit.fire("click");
    assertEquals(countKind(sent, "submit"), 2, "弾かれた後に出し直せない");
  });
});

Deno.test("chicken: 提出が通ったら、同じラウンドではもう送れない", async () => {
  await withGame("chicken", ({ handle, container, sent }) => {
    handle.update(chickenView(), null);
    const input = container.findAll("input")[0];
    const submit = buttonByText(container, "提出する");
    input.value = "42";
    submit.fire("click");
    handle.update(chickenView({ mySubmission: 42 }), null);
    submit.fire("click");
    input.fire("keydown", { key: "Enter" });
    assertEquals(countKind(sent, "submit"), 1, "提出済みなのに送っている");
  });
});

Deno.test("chicken: 入力が不正で送らなかったときはガードが立たない（直せば送れる）", async () => {
  await withGame("chicken", ({ handle, container, sent }) => {
    handle.update(chickenView(), null);
    const input = container.findAll("input")[0];
    const submit = buttonByText(container, "提出する");
    // 空・小数・範囲外・全角はどれも送らない（規約6）
    for (const bad of ["", "3.5", "101", "１２"]) {
      input.value = bad;
      submit.fire("click");
    }
    assertEquals(countKind(sent, "submit"), 0, "不正な入力を送っている");
    assertEquals(submit.disabled, false, "送っていないのにボタンを止めている");
    // 境界値（0 と 100）はどちらも送れる
    input.value = "100";
    submit.fire("click");
    assertEquals(countKind(sent, "submit"), 1, "直した後に送れない");
  });
});

// ---------------------------------------------------------------------------
// wordwolf（H-6）: 投票・言い当ての二重送信ガード
// ---------------------------------------------------------------------------

function wolfView(
  opts: {
    phase?: string;
    myVote?: string | null;
    youAreWolf?: boolean;
    guess?: string | null;
  } = {},
) {
  const phase = opts.phase ?? "vote";
  const myVote = opts.myVote ?? null;
  const guess = opts.guess ?? null;
  return {
    kind: "wordwolf",
    phase,
    mode: "reversal",
    discussionSec: 300,
    discussionChoices: [180, 300],
    configuredBy: null,
    configLocked: false,
    playerCount: 2,
    youArePlayer: true,
    players: [
      { playerId: YOU, nickname: "じぶん", connected: true, voted: myVote !== null },
      { playerId: OTHER, nickname: OTHER_NAME, connected: true, voted: false },
    ],
    myWord: "りんご",
    myVote,
    votedCount: myVote === null ? 0 : 1,
    tally: [],
    exiledId: null,
    exiledNickname: null,
    voteTie: false,
    youAreWolf: opts.youAreWolf ?? false,
    guess,
  };
}

/** 投票ボタン（相手の名前が書かれたボタン）を取り出す */
function voteButton(container: FakeElement): FakeElement {
  return buttonByText(container, OTHER_NAME);
}

Deno.test("wordwolf: 投票ボタンを連打しても vote は1回しか送らない", async () => {
  await withGame("wordwolf", ({ handle, container, sent }) => {
    handle.update(wolfView(), null);
    const btn = voteButton(container);
    btn.fire("click");
    btn.fire("click");
    btn.fire("click");
    assertEquals(countKind(sent, "vote"), 1, "連打で二重に送っている");
    assertEquals(btn.disabled, true, "送った後も投票ボタンが押せるままになっている");
  });
});

Deno.test("wordwolf: サーバーに弾かれたら投票し直せる（詰まない・ボタンも戻る）", async () => {
  await withGame("wordwolf", ({ handle, container, sent }) => {
    handle.update(wolfView(), null);
    const btn = voteButton(container);
    btn.fire("click");
    assertEquals(countKind(sent, "vote"), 1);

    // 弾かれた（myVote が null のまま）。名簿も投票状況も同じなので、
    // 投票ボタンの「作り直し」は起きない。それでも無効化は戻らないといけない
    handle.update(wolfView({ myVote: null }), null);
    assertEquals(voteButton(container), btn, "作り直しが起きた（このテストの前提が崩れている）");
    assertEquals(btn.disabled, false, "弾かれた後も投票ボタンが無効のままになっている");
    btn.fire("click");
    assertEquals(countKind(sent, "vote"), 2, "弾かれた後に投票し直せない");
  });
});

Deno.test("wordwolf: 投票フェーズに入り直せば また投票できる（ガードを持ち越さない）", async () => {
  await withGame("wordwolf", ({ handle, container, sent }) => {
    handle.update(wolfView(), null);
    voteButton(container).fire("click");
    voteButton(container).fire("click");
    assertEquals(countKind(sent, "vote"), 1);

    // 投票が通り、開票され、（次の卓で）また投票フェーズが来る
    handle.update(wolfView({ myVote: OTHER }), null);
    handle.update(wolfView({ phase: "result", myVote: OTHER }), null);
    handle.update(wolfView({ phase: "vote", myVote: null }), null);

    const btn = voteButton(container);
    assertEquals(btn.disabled, false, "投票フェーズに戻ってもボタンが無効のまま");
    btn.fire("click");
    btn.fire("click");
    assertEquals(countKind(sent, "vote"), 2, "投票フェーズに戻っても送れないままになっている");
  });
});

Deno.test("wordwolf: 投票が通ったら もう送れない", async () => {
  await withGame("wordwolf", ({ handle, container, sent }) => {
    handle.update(wolfView(), null);
    voteButton(container).fire("click");
    handle.update(wolfView({ myVote: OTHER }), null);
    voteButton(container).fire("click");
    assertEquals(countKind(sent, "vote"), 1, "投票済みなのに送っている");
  });
});

Deno.test("wordwolf: 言い当てを連打しても guess は1回しか送らない", async () => {
  await withGame("wordwolf", ({ handle, container, sent }) => {
    handle.update(wolfView({ phase: "guess", youAreWolf: true }), null);
    const input = container.findAll("input")[0];
    const btn = buttonByText(container, "答える");
    input.value = "みかん";
    btn.fire("click");
    btn.fire("click");
    input.fire("keydown", { key: "Enter" });
    assertEquals(countKind(sent, "guess"), 1, "連打で二重に送っている");
    assertEquals(btn.disabled, true, "送った後もボタンが押せるままになっている");
  });
});

Deno.test("wordwolf: 言い当てが弾かれたら答え直せる（詰まない）", async () => {
  await withGame("wordwolf", ({ handle, container, sent }) => {
    handle.update(wolfView({ phase: "guess", youAreWolf: true }), null);
    const input = container.findAll("input")[0];
    const btn = buttonByText(container, "答える");
    input.value = "みかん";
    btn.fire("click");
    assertEquals(countKind(sent, "guess"), 1);

    handle.update(wolfView({ phase: "guess", youAreWolf: true, guess: null }), null);
    assertEquals(btn.disabled, false, "弾かれた後もボタンが無効のままになっている");
    btn.fire("click");
    assertEquals(countKind(sent, "guess"), 2, "弾かれた後に答え直せない");

    // 通ったらもう送れない
    handle.update(wolfView({ phase: "guess", youAreWolf: true, guess: "みかん" }), null);
    btn.fire("click");
    assertEquals(countKind(sent, "guess"), 2, "回答済みなのに送っている");
  });
});

Deno.test("wordwolf: 入力が不正で送らなかったときはガードが立たない（直せば送れる）", async () => {
  await withGame("wordwolf", ({ handle, container, sent }) => {
    handle.update(wolfView({ phase: "guess", youAreWolf: true }), null);
    const input = container.findAll("input")[0];
    const btn = buttonByText(container, "答える");
    // 空・空白だけ・41文字（上限 40 の1つ超え）はどれも送らない
    for (const bad of ["", "   ", "あ".repeat(41)]) {
      input.value = bad;
      btn.fire("click");
    }
    assertEquals(countKind(sent, "guess"), 0, "不正な入力を送っている");
    assertEquals(btn.disabled, false, "送っていないのにボタンを止めている");
    // 境界値（ちょうど40文字）は送れる
    input.value = "あ".repeat(40);
    btn.fire("click");
    assertEquals(countKind(sent, "guess"), 1, "直した後に送れない");
  });
});

// ---------------------------------------------------------------------------
// draw（H-7）: view が間引かれても残量の見積もりが合っていること
// ---------------------------------------------------------------------------

function drawView(
  opts: { turn?: number; rev?: number; pointCount?: number; pointMax?: number } = {},
) {
  return {
    kind: "draw",
    phase: "draw",
    turn: opts.turn ?? 1,
    totalTurns: 2,
    drawerId: YOU,
    drawerName: "じぶん",
    youAreDrawer: true,
    topic: "ねこ",
    topicLength: 2,
    strokes: [],
    rev: opts.rev ?? 1,
    // 【重要】サーバーは描画チャンクの配信を間引くので、実際にはこの値は遅れて増える。
    // 既定では 0 のまま（＝1点も返ってきていない）にして、いちばん厳しい遅れを再現する
    pointCount: opts.pointCount ?? 0,
    pointMax: opts.pointMax ?? 10,
    correct: [],
    guesserCount: 1,
    myCorrectOrder: null,
    myTurnPoints: 0,
    players: [{ playerId: YOU, nickname: "じぶん", connected: true, correct: false, drawer: true }],
    standings: [{ playerId: YOU, nickname: "じぶん", score: 0, rank: 1 }],
  };
}

/** 送られた draw チャンクの点数の合計 */
function sentPointCount(sent: unknown[]): number {
  let total = 0;
  for (const payload of sent) {
    const p = payload as { k?: string; p?: number[] };
    if (p.k !== "draw" || !Array.isArray(p.p)) continue;
    total += p.p.length / 2;
  }
  return total;
}

/**
 * 1本の線を引く。moves 回だけ動かして離す（実際に何点送られるかは残量しだい）。
 * MIN_STEP（2）以上動かさないと点が捨てられるので、2px ずつ動かす
 */
function drawStroke(canvas: FakeElement, moves: number, startX = 0, y = 10): void {
  canvas.fire("pointerdown", { clientX: startX, clientY: y, pointerId: 1 });
  for (let i = 1; i <= moves; i++) {
    canvas.fire("pointermove", { clientX: startX + i * 2, clientY: y, pointerId: 1 });
  }
  canvas.fire("pointerup", { clientX: startX + moves * 2, clientY: y, pointerId: 1 });
}

Deno.test("draw: view の pointCount が遅れて届いても、上限ちょうどまで送り、超えては送らない", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    // pointCount は 0 のまま更新されない（＝間引きで view がまったく返ってこない最悪ケース）
    handle.update(drawView({ pointMax: 100 }), null);

    // 上限をはるかに超える回数だけ動かす
    drawStroke(canvas, 500);
    assertEquals(
      sentPointCount(sent),
      100,
      "上限ちょうどで止まっていない（少なければ手前でやめている・多ければサーバーに弾かれる）",
    );

    // 上限に達した後は、新しい線を引き始めても何も送らない
    const before = sent.length;
    drawStroke(canvas, 50, 200, 100);
    assertEquals(sentPointCount(sent), 100, "上限を超えて送っている");
    assertEquals(
      sent.length,
      before,
      "上限に達しているのに送っている（end すら送らない）",
    );
  });
});

Deno.test("draw: 上限の1点手前ではまだ描ける（境界値）", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 10 }), null);

    // 1本目でちょうど9点（上限 10 の1点手前）
    drawStroke(canvas, 8);
    assertEquals(sentPointCount(sent), 9, "9点ぶん送られていない");

    // 残り1点。新しい線の1点目だけは通る
    drawStroke(canvas, 5, 100, 50);
    assertEquals(sentPointCount(sent), 10, "1点手前なのに描けない／描きすぎている");

    // ここから先は1点も送らない
    drawStroke(canvas, 5, 200, 50);
    assertEquals(sentPointCount(sent), 10, "上限を超えて送っている");
  });
});

Deno.test("draw: 1回のチャンクは 64点を超えない（サーバーの上限に合わせる）", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 200 }), null);
    drawStroke(canvas, 199);
    for (const payload of sent) {
      const p = payload as { k?: string; p?: number[] };
      if (p.k !== "draw" || !Array.isArray(p.p)) continue;
      assert(p.p.length / 2 <= MAX_CHUNK_POINTS, `チャンクが ${p.p.length / 2} 点ある`);
      assert(p.p.length % 2 === 0, "点列の長さが奇数");
    }
    assertEquals(sentPointCount(sent), 200, "上限ちょうどまで送れていない");
  });
});

Deno.test("draw: 全部消すと残量が戻る（clear）", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 10 }), null);
    drawStroke(canvas, 50);
    assertEquals(sentPointCount(sent), 10, "上限まで描けていない");

    buttonByText(container, "全部消す").fire("click");
    assertEquals(countKind(sent, "clear"), 1, "clear が送られていない");

    // clear の返事（view）が届く前でも、また描けること
    drawStroke(canvas, 50, 100, 100);
    assertEquals(sentPointCount(sent), 20, "全部消した後に描き直せない");
  });
});

Deno.test("draw: ひとつ戻すと、その線のぶんだけ残量が戻る（undo）", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 10 }), null);

    drawStroke(canvas, 4); // 5点（線1）
    drawStroke(canvas, 2, 100, 50); // 3点（線2）。合計8点
    assertEquals(sentPointCount(sent), 8);

    buttonByText(container, "ひとつ戻す").fire("click");
    assertEquals(countKind(sent, "undo"), 1, "undo が送られていない");

    // 線2（3点）が消えたので、残りは 10 - 5 = 5 点
    drawStroke(canvas, 50, 200, 50);
    assertEquals(sentPointCount(sent), 13, "undo で戻る残量が合っていない（5点ぶん描けるはず）");
  });
});

Deno.test("draw: 履歴が空のときの undo では残量が増えない（異常系）", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 10 }), null);

    // 何も描かないまま何度も戻す（サーバー側は何もしない）
    const undo = buttonByText(container, "ひとつ戻す");
    undo.fire("click");
    undo.fire("click");
    undo.fire("click");

    drawStroke(canvas, 50);
    assertEquals(sentPointCount(sent), 10, "空の undo で残量がずれた");
  });
});

Deno.test("draw: ターンが変われば残量は満タンに戻る（持ち越さない）", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ turn: 1, pointMax: 10 }), null);
    drawStroke(canvas, 50);
    assertEquals(sentPointCount(sent), 10);

    handle.update(drawView({ turn: 2, rev: 2, pointMax: 10 }), null);
    drawStroke(canvas, 50, 100, 100);
    assertEquals(sentPointCount(sent), 20, "ターンが変わっても残量が戻っていない");
  });
});

Deno.test("draw: 残量表示は、まだ view に返ってきていない送信済みのぶんも引いた値になる", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 100 }), null);
    assert(container.text().includes("あと 100 点ぶん描けます"), "最初の残量表示が違う");

    drawStroke(canvas, 39); // 40点ぶん送る
    assertEquals(sentPointCount(sent), 40);
    // pointCount が 0 のまま（間引き）の view が来ても、残量は 60 と出さないといけない
    handle.update(drawView({ rev: 2, pointCount: 0, pointMax: 100 }), null);
    assert(
      container.text().includes("あと 60 点ぶん描けます"),
      `送信済みぶんが残量から引かれていない: ${container.text()}`,
    );

    // 上限まで描いたら「上限に達しました」と出る
    drawStroke(canvas, 200, 100, 100);
    handle.update(drawView({ rev: 3, pointCount: 0, pointMax: 100 }), null);
    assert(
      container.text().includes("描ける量の上限に達しました"),
      `上限に達したことが出ていない: ${container.text()}`,
    );
  });
});

// ---------------------------------------------------------------------------
// draw（M-5）: ポインタ捕捉に失敗しても、そのターン描けなくならないこと
// ---------------------------------------------------------------------------

/** 送られた draw チャンクのストロークIDを、送られた順に並べる（同じIDの連続はまとめる） */
function sentStrokeIds(sent: unknown[]): number[] {
  const ids: number[] = [];
  for (const payload of sent) {
    const p = payload as { k?: string; s?: number };
    if (p.k !== "draw" || typeof p.s !== "number") continue;
    if (ids[ids.length - 1] !== p.s) ids.push(p.s);
  }
  return ids;
}

Deno.test("draw: 捕捉が効かない環境で canvas の外で離しても線が終わり、次の線を引ける", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    // 偽 canvas は setPointerCapture を持たない＝捕捉できない環境そのもの
    assertEquals(
      typeof (canvas as unknown as { setPointerCapture?: unknown }).setPointerCapture,
      "undefined",
      "この偽 canvas は捕捉できてしまう（再現条件が崩れている）",
    );
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 100 }), null);

    canvas.fire("pointerdown", { clientX: 0, clientY: 10, pointerId: 1 });
    canvas.fire("pointermove", { clientX: 10, clientY: 10, pointerId: 1 });
    // canvas の外で離す（canvas には届かず window にだけ届く）
    firePointerOnWindow("pointerup", 1);
    assertEquals(countKind(sent, "end"), 1, "線が終わっていない");

    // 2本目が引ける（以前はここで掴んだままのポインタに弾かれ、ターン中ずっと描けなかった）
    canvas.fire("pointerdown", { clientX: 100, clientY: 10, pointerId: 2 });
    canvas.fire("pointermove", { clientX: 110, clientY: 10, pointerId: 2 });
    firePointerOnWindow("pointerup", 2);
    assertEquals(countKind(sent, "end"), 2, "2本目が引けていない");
    assertEquals(sentStrokeIds(sent), [0, 1], "2本目が別のストロークになっていない");
  });
});

Deno.test("draw: window の pointercancel でも線が終わる（OS に取り上げられた場合）", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 100 }), null);
    canvas.fire("pointerdown", { clientX: 0, clientY: 10, pointerId: 3 });
    canvas.fire("pointermove", { clientX: 10, clientY: 10, pointerId: 3 });
    firePointerOnWindow("pointercancel", 3);
    assertEquals(countKind(sent, "end"), 1, "取り上げられた線が終わっていない");
    canvas.fire("pointerdown", { clientX: 100, clientY: 10, pointerId: 4 });
    canvas.fire("pointermove", { clientX: 110, clientY: 10, pointerId: 4 });
    canvas.fire("pointerup", { clientX: 110, clientY: 10, pointerId: 4 });
    assertEquals(countKind(sent, "end"), 2, "次の線が引けていない");
  });
});

Deno.test("draw: 別のポインタの pointerup では線を終わらせない（異常系）", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 100 }), null);
    canvas.fire("pointerdown", { clientX: 0, clientY: 10, pointerId: 1 });
    canvas.fire("pointermove", { clientX: 10, clientY: 10, pointerId: 1 });
    // 別の指（別ポインタ）が離れただけでは終わらない
    firePointerOnWindow("pointerup", 99);
    assertEquals(countKind(sent, "end"), 0, "他のポインタで線が終わってしまった");
    firePointerOnWindow("pointerup", 1);
    assertEquals(countKind(sent, "end"), 1);
  });
});

Deno.test("draw: unmount すると window のポインタ監視も外れる（後始末）", async () => {
  const dom = installDom();
  try {
    const module = await loadGame("draw");
    const container = new FakeElement("div");
    const sent: unknown[] = [];
    const handle = module.mount(container, makeApi(sent)) as GameHandle;
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 100 }), null);
    canvas.fire("pointerdown", { clientX: 0, clientY: 10, pointerId: 1 });
    canvas.fire("pointermove", { clientX: 10, clientY: 10, pointerId: 1 });
    handle.unmount();
    const before = sent.length;
    firePointerOnWindow("pointerup", 1);
    assertEquals(sent.length, before, "unmount 後も window のハンドラが生きている");
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// draw（M-7）: 「全部消す」を繰り返してもストロークIDが受理範囲を超えないこと
// ---------------------------------------------------------------------------

/** サーバーが受理するストロークIDの上限（server/games/draw.ts: DRAW_MAX_STROKES * 4） */
const MAX_STROKE_ID = 400 * 4;

Deno.test("draw: 全部消すとストロークIDが 0 から振り直される", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 1000 }), null);
    drawStroke(canvas, 3);
    drawStroke(canvas, 3, 100);
    assertEquals(sentStrokeIds(sent), [0, 1]);

    buttonByText(container, "全部消す").fire("click");
    sent.length = 0;
    // clear の返事（履歴が空の view）が届く前でも、IDは振り直されている
    drawStroke(canvas, 3, 200);
    assertEquals(sentStrokeIds(sent), [0], "全部消したのにIDが増え続けている");
  });
});

Deno.test("draw: 全部消すを繰り返してもIDが受理範囲（0..1600）を超えない", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    let rev = 1;
    for (let round = 0; round < 30; round++) {
      handle.update(drawView({ rev: rev++, pointCount: 0, pointMax: 1000 }), null);
      // 1回の「消すまで」に10本引く
      for (let i = 0; i < 10; i++) drawStroke(canvas, 2, i * 10);
      buttonByText(container, "全部消す").fire("click");
    }
    const ids = sentStrokeIds(sent);
    assertEquals(Math.max(...ids), 9, "消すたびにIDが持ち越されている");
    assert(
      ids.every((id) => id >= 0 && id <= MAX_STROKE_ID),
      `サーバーが受理しないIDを送っている: ${Math.max(...ids)}`,
    );
  });
});

Deno.test("draw: 引きかけの線がある状態で全部消しても、古いIDのチャンクを後から送らない", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 1000 }), null);
    drawStroke(canvas, 3); // 1本目（s=0）を引き終える
    // 2本目を引いている途中で「全部消す」
    canvas.fire("pointerdown", { clientX: 200, clientY: 10, pointerId: 5 });
    canvas.fire("pointermove", { clientX: 210, clientY: 10, pointerId: 5 });
    buttonByText(container, "全部消す").fire("click");
    sent.length = 0;
    // 離すイベントが遅れて届いても、消えた線のぶんは送らない
    canvas.fire("pointerup", { clientX: 210, clientY: 10, pointerId: 5 });
    assertEquals(countKind(sent, "draw"), 0, "消したはずの線のチャンクを送っている");
    assertEquals(countKind(sent, "end"), 0);
    // そのあとは 0 番から引き直せる（掴んだままのポインタで詰まない）
    drawStroke(canvas, 3, 300);
    assertEquals(sentStrokeIds(sent), [0], "全部消した後に描き始められない");
  });
});

Deno.test("draw: ひとつ戻したあとはIDを振り直さない（履歴が残るので増やし続ける）", async () => {
  await withGame("draw", ({ handle, container, sent }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 1000 }), null);
    drawStroke(canvas, 3);
    drawStroke(canvas, 3, 100);
    buttonByText(container, "ひとつ戻す").fire("click");
    sent.length = 0;
    drawStroke(canvas, 3, 200);
    // undo は履歴を1本残すので、サーバーは「直近より大きいID」しか受理しない
    assertEquals(sentStrokeIds(sent), [2], "undo でIDを巻き戻してしまっている");
  });
});

// ---------------------------------------------------------------------------
// 番人: 主役表示まわり（リサイズ追従・座標変換・後始末）を壊していないこと
// ---------------------------------------------------------------------------

Deno.test("draw: 描いている最中にリサイズしても、座標も残量も狂わない", async () => {
  await withGame("draw", ({ handle, container, sent, dom }) => {
    const canvas = container.findAll("canvas")[0];
    canvas.setRect(DRAW_SIZE, DRAW_SIZE);
    handle.update(drawView({ pointMax: 100 }), null);
    assert(dom.observers.length > 0, "表示サイズの見張りが登録されていない");

    // 等倍で1点打つ
    canvas.fire("pointerdown", { clientX: 120, clientY: 120, pointerId: 1 });
    canvas.fire("pointerup", { clientX: 120, clientY: 120, pointerId: 1 });

    // 倍の大きさに広げる。内部解像度が追従し、変換行列も掛け直される
    canvas.setRect(DRAW_SIZE * 2, DRAW_SIZE * 2);
    dom.fireResize(canvas);
    assertEquals(canvas.width, DRAW_SIZE * 4, "リサイズで内部解像度が追従していない（dpr 2）");

    // 同じ論理座標を指す位置を押すと、同じ座標が送られる
    canvas.fire("pointerdown", { clientX: 240, clientY: 240, pointerId: 2 });
    canvas.fire("pointerup", { clientX: 240, clientY: 240, pointerId: 2 });

    const chunks = sent.filter((p) => (p as { k?: string }).k === "draw") as { p: number[] }[];
    assertEquals(chunks.length, 2, "2点ぶん送られていない");
    assertEquals(chunks[0].p, [120, 120], "等倍のときの論理座標");
    assertEquals(chunks[1].p, chunks[0].p, "リサイズ後に座標がずれた");
    assertEquals(sentPointCount(sent), 2, "残量の数え方がリサイズでずれた");

    // 後始末（unmount 後に見張りが残っていないこと）は下で確かめる
    handle.unmount();
    assert(
      dom.observers.every((o) => o.disconnected),
      "unmount で ResizeObserver を外していない",
    );
    // withGame の後始末が二重に走らないよう、もう一度呼んでも落ちないことも兼ねる
  });
});
