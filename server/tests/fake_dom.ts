/**
 * クライアントの素の JavaScript を Deno から動かすための、最小限の偽 DOM。
 *
 * public/ 配下のファイルはブラウザ向けだが、触る DOM API はごく一部なので、
 * 偽物を渡せば素の JavaScript としてそのまま実行できる
 * （voice_client_test.ts が public/room/voice.js で使っているのと同じ手口）。
 * 本物の DOM を再現するためのものではなく、テスト対象が呼ぶ範囲だけを埋める。
 */

/** app.js / vc.js が使う範囲だけの要素 */
export class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  parent: FakeElement | null = null;
  textContent = "";
  className = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  autoplay = false;
  playsInline = false;
  muted = false;
  srcObject: unknown = null;
  scrollTop = 0;
  scrollHeight = 0;

  constructor(readonly tagName: string, readonly id = "") {}

  readonly classList = {
    add: (name: string) => this.setClasses([...this.classes(), name]),
    remove: (name: string) => this.setClasses(this.classes().filter((c) => c !== name)),
    contains: (name: string) => this.classes().includes(name),
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes().includes(name);
      if (on) this.classList.add(name);
      else this.classList.remove(name);
      return on;
    },
  };

  private classes(): string[] {
    return this.className.split(" ").filter((c) => c.length > 0);
  }

  private setClasses(list: string[]): void {
    this.className = [...new Set(list)].join(" ");
  }

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

  /** 自分を親から外す。vc.js が閉じたピアの表示枠を片付けるのに使う */
  remove(): void {
    this.parent?.removeChild(this);
  }

  addEventListener(): void {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }

  /** 自動再生の試行。本物と同じく undefined を返してよい（呼び出し側が見ている） */
  play(): undefined {
    return undefined;
  }
}

/** getElementById が id ごとに同じ要素を返す偽 document */
export function createFakeDocument(elements = new Map<string, FakeElement>()) {
  const getElementById = (id: string): FakeElement => {
    const found = elements.get(id);
    if (found !== undefined) return found;
    const created = new FakeElement("div", id);
    // index.html の #error は .alert（赤い警告）で始まる
    if (id === "error") created.className = "alert";
    elements.set(id, created);
    return created;
  };
  return {
    elements,
    document: {
      getElementById,
      createElement: (tag: string) => new FakeElement(tag),
      createTextNode: (text: string) => {
        const node = new FakeElement("#text");
        node.textContent = text;
        return node;
      },
      querySelectorAll: () => [] as FakeElement[],
    },
  };
}
