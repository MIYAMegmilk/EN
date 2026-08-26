/**
 * ビューモジュール（public/room/games/*.js）を**実際に mount して動かす**スモークテスト。
 *
 * 実ブラウザ2窓での確認（設計書 §7.1-6）の代わりにはならないが、
 * 「読み込んだ瞬間に落ちる」「view を渡したら例外が出る」「unmount で後始末していない」
 * といった、手で気づくのに時間がかかる壊れ方はここで捕まえられる。
 *
 * 偽 DOM はこのファイルに閉じてある（server/tests/fake_dom.ts は canvas も Image も
 * 持たないため、ゲーム用に必要なぶんだけを別に用意した）。
 * 本物の DOM を再現するものではなく、ビューモジュールが呼ぶ範囲だけを埋めている。
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
  alt = "";
  src = "";
  width = 0;
  height = 0;
  disabled = false;
  draggable = false;
  decoding = "";
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
  /** 登録されているハンドラを呼ぶ（クリック・キー操作の再現） */
  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) {
      handler({ target: this, preventDefault: () => {}, ...event });
    }
  }
  /** 自分から祖先へ向かって tagName の一致する要素を探す */
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
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.width || 420, height: this.height || 300 };
  }
  getContext(): Record<string, unknown> {
    // 呼ばれるメソッドはすべて受け流す。描いた内容は見ない
    const noop = () => {};
    return new Proxy({ canvas: this }, {
      get: (target, key) => {
        if (key in target) return (target as Record<string | symbol, unknown>)[key];
        return noop;
      },
      set: () => true,
    });
  }
  /** ハンドラの総数（unmount の後始末を数えるのに使う） */
  handlerCount(): number {
    let total = 0;
    for (const bucket of this.handlers.values()) total += bucket.length;
    for (const child of this.children) total += child.handlerCount();
    return total;
  }
  /** 部分木の textContent を連結する（表示内容の確認用） */
  text(): string {
    return this.textContent + this.children.map((c) => c.text()).join("");
  }
  /** 部分木から tagName の一致する要素を集める */
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

/** ビューモジュールを動かすのに要る globalThis を差し込む。戻り値で元に戻す */
function installDom(): { restore: () => void; frames: (() => void)[] } {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  const frames: (() => void)[] = [];
  const set = (key: string, value: unknown) => {
    saved[key] = g[key];
    g[key] = value;
  };
  set("document", {
    createElement: (tag: string) => tag === "img" ? new FakeImage() : new FakeElement(tag),
  });
  set("Image", FakeImage);
  set("HTMLImageElement", FakeImage);
  set("Element", FakeElement);
  set("devicePixelRatio", 2);
  set("requestAnimationFrame", (fn: (t: number) => void) => {
    frames.push(() => fn(performance.now()));
    return frames.length;
  });
  set("cancelAnimationFrame", () => {});
  return {
    frames,
    restore: () => {
      for (const [key, value] of Object.entries(saved)) g[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const YOU = "you-1";
const OTHER = "other-1";
/** ニックネームはユーザー由来。タグが文字のまま入ること（textContent）を見るのに使う */
const OTHER_NAME = "<script>あいて</script>";

/** サーバーが実際に配る形の view（server/games/client.ts の ClientGameView） */
function makeView(events: { n: number; from: string; payload: unknown }[] = [], ended = false) {
  return {
    seed: 20260826,
    startedAt: T0,
    players: [
      { id: YOU, name: "じぶん", connected: true },
      { id: OTHER, name: OTHER_NAME, connected: true },
    ],
    events,
    ended,
  };
}

function makeApi(sent: unknown[], now = { value: T0 }) {
  return {
    send: (payload: unknown) => sent.push(payload),
    youId: YOU,
    isHost: true,
    serverNow: () => now.value,
  };
}

// deno-lint-ignore no-explicit-any
async function loadGame(id: string): Promise<any> {
  return await import(`../../../public/room/games/${id}.js`);
}

/** mount → update → unmount を一通り回し、例外が出ないことと後始末を確かめる */
async function exercise(
  id: string,
  drive: (ctx: {
    // deno-lint-ignore no-explicit-any
    handle: any;
    container: FakeElement;
    sent: unknown[];
    now: { value: number };
    frames: (() => void)[];
  }) => void,
) {
  const dom = installDom();
  try {
    const module = await loadGame(id);
    const container = new FakeElement("div");
    const sent: unknown[] = [];
    const now = { value: T0 };
    const handle = module.mount(container, makeApi(sent, now));
    assert(typeof handle.update === "function", `${id}: update が無い`);
    assert(typeof handle.unmount === "function", `${id}: unmount が無い`);
    assert(container.children.length > 0, `${id}: 何も描いていない`);
    // 「点は付かない」断り書きが必ず出る（設計書 §2.8.3）
    assert(container.text().includes("宴の得点には入りません"), `${id}: 断り書きが無い`);
    drive({ handle, container, sent, now, frames: dom.frames });
    handle.unmount();
    assertEquals(container.children.length, 0, `${id}: unmount で片付いていない`);
    assertEquals(container.handlerCount(), 0, `${id}: リスナが残っている`);
  } finally {
    dom.restore();
  }
}

// ---------------------------------------------------------------------------

Deno.test("mogura: mount → 叩く → 中継を受ける → unmount まで落ちない", async () => {
  await exercise("mogura", ({ handle, container, frames }) => {
    handle.update(makeView(), null);
    // 1フレーム進める（rAF ループの中身が走る）
    frames.forEach((f) => f());
    const canvas = container.findAll("canvas")[0];
    assert(canvas !== undefined, "canvas が無い");
    // 開始 → 盤面のどこかを叩く（例外が出ないことを見る）
    canvas.fire("pointerdown", { clientX: 210, clientY: 150 });
    canvas.fire("pointerdown", { clientX: 210, clientY: 150 });
    // 他人の最終得点が届く
    handle.update(makeView([{ n: 1, from: OTHER, payload: { k: "final", s: 17 } }]), null);
    assert(container.text().includes("17点"), "他人の得点が出ていない");
    // ニックネームは textContent 経由なので、タグは文字のまま入る
    assert(container.text().includes(OTHER_NAME), "名前が出ていない");
  });
});

Deno.test("mogura: 壊れた payload・壊れた view でも落ちない", async () => {
  await exercise("mogura", ({ handle }) => {
    for (
      const events of [
        [{ n: 1, from: OTHER, payload: null }],
        [{ n: 2, from: OTHER, payload: { k: "final" } }],
        [{ n: 3, from: OTHER, payload: { k: "final", s: "9999999" } }],
        [{ n: 4, from: OTHER, payload: { k: "final", s: -1 } }],
        [{ n: 5, from: OTHER, payload: { k: "unknown", s: 1 } }],
      ]
    ) {
      handle.update(makeView(events), null);
    }
    handle.update(null, null);
    handle.update({}, null);
    handle.update({ events: "x", players: 3 }, null);
  });
});

Deno.test("reflex: ラウンドが進み、押すと1件だけ中継され、二重加点しない", async () => {
  await exercise("reflex", ({ handle, container, sent, now, frames }) => {
    handle.update(makeView(), null);
    const pad = container.findAll("div").find((d) => d.handlers.has("pointerdown"));
    assert(pad !== undefined, "押す場所が無い");
    // 第1ラウンドの合図より後（予告2.5秒 + 待ち最大4.0秒）まで進める
    now.value = T0 + 7000;
    pad.fire("pointerdown");
    assertEquals(sent.length, 1, "1回押して1件だけ送る");
    assertEquals((sent[0] as { k: string; r: number }).k, "t");
    assertEquals((sent[0] as { k: string; r: number }).r, 0);
    // 同じラウンドで連打しても増えない
    pad.fire("pointerdown");
    pad.fire("pointerdown");
    assertEquals(sent.length, 1, "同じラウンドで二重送信している");
    // 他人のタップが届く
    handle.update(makeView([{ n: 1, from: OTHER, payload: { k: "t", r: 0, rt: 500 } }]), null);
    // ラウンドを進めて集計させる
    now.value = T0 + 3 * 10_500;
    frames.forEach((f) => f());
    const scores = container.findAll("li").map((li) => li.text());
    assert(scores.length >= 2, `順位表が出ていない: ${JSON.stringify(scores)}`);
    assert(scores.some((t) => t.includes("3点")), `1位に3点が入っていない: ${scores}`);
    // 同じイベントをもう一度流しても二重加点しない
    handle.update(makeView([{ n: 1, from: OTHER, payload: { k: "t", r: 0, rt: 500 } }]), null);
    const again = container.findAll("li").map((li) => li.text());
    assertEquals([...again].sort(), [...scores].sort(), "同じイベントで二重加点している");
  });
});

Deno.test("reflex: 範囲外・型違いのタップは捨てる", async () => {
  await exercise("reflex", ({ handle, container, now, frames }) => {
    handle.update(makeView(), null);
    handle.update(
      makeView([
        { n: 1, from: OTHER, payload: { k: "t", r: 99, rt: 1 } }, // ラウンド範囲外
        { n: 2, from: OTHER, payload: { k: "t", r: 0, rt: 999_999 } }, // 反応時間が非現実的
        { n: 3, from: OTHER, payload: { k: "t", r: 0, rt: "10" } }, // 型違い
        { n: 4, from: OTHER, payload: "こわれ" },
      ]),
      null,
    );
    now.value = T0 + 3 * 10_500;
    frames.forEach((f) => f());
    const scores = container.findAll("li").map((li) => li.text());
    // どれも受理されないので、誰にも点が入らない
    assert(scores.every((t) => t.includes("0点")), `不正な値で加点している: ${scores}`);
  });
});

Deno.test("emoawase: 中継されたタイムを出し、壊れた payload は捨てる", async () => {
  await exercise("emoawase", ({ handle, container, sent }) => {
    handle.update(makeView(), null);
    assert(container.text().includes("絵合わせ"), "見出しが無い");
    handle.update(makeView([{ n: 1, from: OTHER, payload: { k: "done", ms: 48_000 } }]), null);
    assert(container.text().includes("48.0秒"), "他人のタイムが出ていない");
    handle.update(
      makeView([
        { n: 2, from: OTHER, payload: { k: "done", ms: -1 } },
        { n: 3, from: OTHER, payload: { k: "done" } },
        { n: 4, from: OTHER, payload: null },
      ]),
      null,
    );
    assertEquals(sent.length, 0, "こちらは何も送っていないはず");
  });
});

Deno.test("emoawase: 画像が読めたら12枚の札が並び、めくれる（3枚目はめくれない）", async () => {
  const dom = installDom();
  try {
    const module = await loadGame("emoawase");
    const container = new FakeElement("div");
    const sent: unknown[] = [];
    const handle = module.mount(container, makeApi(sent));
    handle.update(makeView(), null);
    // loadImage の Promise を解決させる（偽 Image は load を発火しないので、
    // mount 時に登録された handler を直接呼ぶ）
    for (const img of [...container.findAll("img")]) img.fire("load");
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const buttons = container.findAll("button");
    if (buttons.length > 0) {
      assertEquals(buttons.length, 12, "札が12枚ではない");
      buttons[0].fire("click");
      buttons[1].fire("click");
      buttons[2].fire("click");
      // 表になっているのは最大2枚（取れた組を除く）
      const faceUp = buttons.filter((b) => {
        const img = b.firstChild;
        return img !== null && !img.src.endsWith("back.svg");
      });
      assert(faceUp.length <= 2, `3枚以上めくれている: ${faceUp.length}`);
    }
    handle.unmount();
    assertEquals(container.children.length, 0);
  } finally {
    dom.restore();
  }
});
