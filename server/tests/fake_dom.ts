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

  /**
   * 登録された handler は捨てずに持つ。
   * ボタンを押したときに何が送られるかを試したいテストがあるため（click 参照）
   */
  readonly handlers = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type?: string, handler?: (event: unknown) => void): void {
    if (typeof type !== "string" || typeof handler !== "function") return;
    const bucket = this.handlers.get(type) ?? [];
    bucket.push(handler);
    this.handlers.set(type, bucket);
  }

  /** 押す。登録順に click の handler を呼ぶ */
  click(): void {
    for (const handler of this.handlers.get("click") ?? []) {
      handler({ target: this, preventDefault: () => {}, stopPropagation: () => {} });
    }
  }

  /** 表示に関わる呼び出しは受け流す。テストで見るのは textContent と class */
  focus(): void {}

  readonly style = {
    setProperty: (name: string, value: string) => {
      this.styles.set(name, value);
    },
    getPropertyValue: (name: string) => this.styles.get(name) ?? "",
  };

  readonly styles = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }

  /**
   * クラス名1つぶんだけを引く簡易版。app.js が絵と文字を分けたボタンの
   * 文字だけを差し替えるのに使う（.vc-ctl-label / .vc-bot-label など）。
   * 本物のセレクタは解さない。子孫を先行順にたどって最初の一致を返す。
   */
  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith(".")) return null;
    const name = selector.slice(1);
    for (const child of this.children) {
      if (child.className.split(" ").includes(name)) return child;
      const found = child.querySelector(selector);
      if (found !== null) return found;
    }
    return null;
  }

  /** 自動再生の試行。本物と同じく undefined を返してよい（呼び出し側が見ている） */
  play(): undefined {
    return undefined;
  }
}

/** getElementById が id ごとに同じ要素を返す偽 document */
export function createFakeDocument(elements = new Map<string, FakeElement>()) {
  /** document に直接付けられたハンドラ。型ごとに束ねる */
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const getElementById = (id: string): FakeElement => {
    const found = elements.get(id);
    if (found !== undefined) return found;
    const created = new FakeElement("div", id);
    // index.html の #error は .alert（赤い警告）で始まる
    if (id === "error") created.className = "alert";
    elements.set(id, created);
    return created;
  };
  // app.js は body の data 属性で「ロビー中か」を持つ
  const body = new FakeElement("body", "body");
  return {
    elements,
    document: {
      body,
      /*
       * 端末の全画面に出ている要素。本物の全画面 API は再現しないので、
       * テストが手で入れる（app.js は「いま全画面なのはどの要素か」しか
       * 見ていないため、これだけで分岐を試せる）。
       * requestFullscreen / exitFullscreen は**わざと置かない**。無い環境
       * （全画面に対応しない端末）でも壊れないことの確認を兼ねている。
       */
      fullscreenElement: null as FakeElement | null,
      getElementById,
      createElement: (tag: string) => new FakeElement(tag),
      // app.js は bot の絵と手元の操作の絵を inline SVG で組む。
      // 名前空間は再現しないので、要素だけ返せば足りる
      createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
      createTextNode: (text: string) => {
        const node = new FakeElement("#text");
        node.textContent = text;
        return node;
      },
      querySelectorAll: () => [] as FakeElement[],
      /*
       * app.js は document にも直接ハンドラを付ける（品書きを Esc で閉じる）。
       * 受け口が無いと読み込みの時点で落ちるので、記録だけしておく。
       * dispatch で呼び出せるようにしてあるのは、後からキー操作を試せるように。
       */
      listeners,
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        const bucket = listeners.get(type) ?? [];
        bucket.push(handler);
        listeners.set(type, bucket);
      },
      removeEventListener: (type: string, handler: (event: unknown) => void) => {
        const bucket = listeners.get(type);
        if (bucket === undefined) return;
        const index = bucket.indexOf(handler);
        if (index >= 0) bucket.splice(index, 1);
      },
      dispatch: (type: string, event: unknown) => {
        for (const handler of listeners.get(type) ?? []) handler(event);
      },
    },
  };
}
