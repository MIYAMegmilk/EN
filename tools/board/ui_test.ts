/**
 * 作業ボードの画面（tools/board/public/index.html）のテスト。
 *
 * 画面は CSS も JavaScript も1ファイルに収めてあるので、
 * まずは **ソースを文字列として検査する**（server/tests/corridor_client_test.ts が
 * public/index.html を検査しているのと同じ手口）。ここで守りたいのは次の4つ。
 *   - 利用者由来の文字列を HTML として解釈させる経路が無いこと（XSS）
 *   - インラインの on* 属性が無いこと（CSP に引っかかる）
 *   - 外部から何も読み込まないこと（CDN のフォント・アイコン・スクリプト）
 *   - トークンが URL にも記録にも残らないこと（§7-4 / §7-6）
 *
 * そのうえで、インラインの JavaScript を **偽 DOM 相手に実際に動かして**、
 * 描画・古い表明の判定・自動更新の止め方・通信断のときの振る舞いを見る。
 * 偽 DOM は server/tests/fake_dom.ts を借りている。**テストの器としてだけの借用**で、
 * 画面そのものは EN 本体から何も読み込まない（§3 の独立性は保っている）。
 *
 * 見ていないこと: 実際の見え方・配色・スマホでの折り返し（実機でしか分からない）。
 */

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { fromFileUrl } from "@std/path";
import { createFakeDocument, FakeElement } from "../../server/tests/fake_dom.ts";
import { CLAIM_TTL_MS } from "./types.ts";

const htmlSource = await Deno.readTextFile(
  fromFileUrl(new URL("./public/index.html", import.meta.url)),
);

// ── ソースの切り分け ───────────────────────────────────

const SCRIPT_OPEN = "<script>";
const SCRIPT_CLOSE = "</script>";

/** インラインの <script> の中身。ブラウザがハッシュを取るのと同じ範囲で切り出す */
function extractScript(source: string): string {
  const start = source.indexOf(SCRIPT_OPEN);
  const end = source.indexOf(SCRIPT_CLOSE);
  assert(start >= 0 && end > start, "<script> が見つからない");
  assertEquals(
    source.indexOf(SCRIPT_OPEN, start + 1),
    -1,
    "<script> が2つ以上ある（1ファイル1本の約束が崩れている）",
  );
  return source.slice(start + SCRIPT_OPEN.length, end);
}

const scriptSource = extractScript(htmlSource);

/** <script> と <style> とコメントを外した、素の HTML だけ */
const markupSource = htmlSource
  .replace(/<script>[\s\S]*?<\/script>/g, "<script></script>")
  .replace(/<style>[\s\S]*?<\/style>/g, "<style></style>")
  .replace(/<!--[\s\S]*?-->/g, "");

// ── ① 利用者由来の文字列を HTML として解釈させないこと ──────────

Deno.test("index.html: HTML 文字列を DOM に流し込む経路を持たない", () => {
  // 表明の title / note / あだ名 / PR のタイトルは、すべて利用者が書いた文字列。
  // 代入した瞬間に HTML として解釈される口を、1つも持たせない。
  for (
    const forbidden of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "createContextualFragment",
      "eval(",
      "new Function",
    ]
  ) {
    assertFalse(
      htmlSource.includes(forbidden),
      `${forbidden} を使っている（textContent で組み立てること）`,
    );
  }
});

Deno.test("index.html: 文字は textContent で置いている", () => {
  assertStringIncludes(scriptSource, "node.textContent = String(text)");
  // 生成はすべて createElement 経由（文字列から要素を作らない）
  assert(
    scriptSource.includes("document.createElement("),
    "createElement で組み立てていない",
  );
});

// ── ② インラインの on* 属性が無いこと ─────────────────────

Deno.test("index.html: インラインの on* 属性が無い", () => {
  const inlineHandler = /<[a-zA-Z][^>]*\son[a-z]+\s*=/;
  assertFalse(
    inlineHandler.test(markupSource),
    "on* 属性でハンドラを付けている（addEventListener を使うこと）",
  );
  assertStringIncludes(scriptSource, "addEventListener(");
});

// ── ③ 外部から何も読み込まないこと ───────────────────────

Deno.test("index.html: 外部ドメインを参照していない", () => {
  // src / href に限らず、そもそも http(s) の URL が1つも無いことを見る
  // （CDN のフォント・アイコン・スクリプト、CSS の @import と url() を一括で禁じる）。
  assertFalse(htmlSource.includes("http://"), "http:// の参照がある");
  assertFalse(htmlSource.includes("https://"), "https:// の参照がある");
  assertFalse(/(src|href)\s*=\s*["']\/\//.test(htmlSource), "//host 形式の参照がある");
  assertFalse(/@import/.test(htmlSource), "CSS の @import がある");
  assertFalse(/url\(\s*["']?[a-z]+:/i.test(htmlSource), "CSS の url() が外部を指している");
});

Deno.test("index.html: 外部ファイルに分かれていない（1ファイルに収まっている）", () => {
  assertFalse(/<link\b/i.test(markupSource), "<link> で外部 CSS を読んでいる");
  assertFalse(/<script[^>]+src=/i.test(markupSource), "<script src> で外部 JS を読んでいる");
  assertFalse(/<img\b/i.test(markupSource), "<img> がある（アイコンはインライン SVG か文字で）");
});

// ── ④ トークンの扱い（§7-4 / §7-6） ───────────────────

Deno.test("index.html: 記憶する先は「この端末に記憶する」で選べる", () => {
  /*
   * 方針変更（もとは sessionStorage だけ）。
   * 毎回トークンを貼り直す手間が、このボードの中身（誰が何を作っているか）に
   * 見合わないため、既定は localStorage にした。共用 PC 向けの逃げ道として
   * sessionStorage も残してあることを、両方の名前で確かめる。
   */
  assertStringIncludes(scriptSource, "localStorage");
  assertStringIncludes(scriptSource, "sessionStorage");
  // チェックは入力欄の下にあり、既定で入っている
  const gateRemember = /<input\s+id="gate-remember"\s+type="checkbox"\s+checked\s*\/>/;
  assert(
    gateRemember.test(markupSource.replace(/\s+/g, " ").replace(/ \/>/g, " />")),
    "「この端末に記憶する」のチェックが無いか、既定で入っていない",
  );
  assertStringIncludes(markupSource, "この端末に記憶する");
  assert(
    markupSource.indexOf('id="gate-token"') < markupSource.indexOf('id="gate-remember"'),
    "チェックが入力欄より上にある",
  );
  // 置き場を読むのも消すのも、必ず両方を回る
  assertStringIncludes(scriptSource, "for (const remember of [true, false])");
});

Deno.test("index.html: トークンを画面にも URL にも記録にも出さない", () => {
  // 入力欄は伏せ字
  assert(
    /<input[^>]*id="gate-token"[^>]*type="password"/.test(markupSource.replace(/\s+/g, " ")),
    "トークンの入力欄が伏せ字になっていない",
  );
  // ヘッダにだけ載せる。クエリに載せない
  assertStringIncludes(scriptSource, "authorization: `Bearer ${token}`");
  assertFalse(/token=\$\{/.test(scriptSource), "URL にトークンを埋めている");
  assertFalse(/[?&]token=/.test(scriptSource), "クエリにトークンを載せている");
  // 記録に出さない（console 系を一切呼ばない）
  assertFalse(/\bconsole\.[a-z]+\(/.test(scriptSource), "console に何か出している");
});

// ── ⑤ HTML として読めること ────────────────────────────

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** 引用符の中の `>` を終わりと間違えないよう、タグの終端を探す */
function findTagEnd(source: string, from: number): number {
  let quote = "";
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

/**
 * 開きと閉じの対応だけを見る簡易パーサ。
 * DOMParser は Deno に無く、外部の HTML パーサを入れるのは
 * この repo の方針（サードパーティを使わない）に反するので、必要なぶんだけ自前で持つ。
 */
function findMarkupErrors(source: string): string[] {
  const errors: string[] = [];
  const stack: string[] = [];
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt);
      if (end < 0) {
        errors.push("閉じられていないコメントがある");
        break;
      }
      i = end + 3;
      continue;
    }
    if (source.startsWith("<!", lt)) {
      const end = findTagEnd(source, lt);
      if (end < 0) {
        errors.push("閉じられていない宣言がある");
        break;
      }
      i = end + 1;
      continue;
    }
    const gt = findTagEnd(source, lt);
    if (gt < 0) {
      errors.push("閉じられていないタグがある");
      break;
    }
    const raw = source.slice(lt + 1, gt).trim();
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toLowerCase();
      const open = stack.pop();
      if (open !== name) {
        errors.push(`</${name}> の対応がずれている（開いているのは <${open ?? "なし"}>）`);
      }
      i = gt + 1;
      continue;
    }
    const matched = raw.match(/^[a-zA-Z][^\s/>]*/);
    if (matched === null) {
      errors.push(`タグ名が読めない: <${raw.slice(0, 20)}`);
      i = gt + 1;
      continue;
    }
    const name = matched[0].toLowerCase();
    if (name === "script" || name === "style") {
      const close = source.indexOf(`</${name}>`, gt);
      if (close < 0) {
        errors.push(`</${name}> が無い`);
        break;
      }
      i = close + name.length + 3;
      continue;
    }
    if (!VOID_TAGS.has(name) && !raw.endsWith("/")) stack.push(name);
    i = gt + 1;
  }
  if (stack.length > 0) errors.push(`閉じていない要素がある: ${stack.join(" > ")}`);
  return errors;
}

Deno.test("index.html: HTML として読める（開きと閉じが揃っている）", () => {
  assertEquals(findMarkupErrors(htmlSource), []);
});

Deno.test("index.html: 骨組みが揃っている", () => {
  assertStringIncludes(htmlSource, "<!DOCTYPE html>");
  assertStringIncludes(htmlSource, '<html lang="ja">');
  assertStringIncludes(htmlSource, '<meta charset="utf-8" />');
  assertStringIncludes(htmlSource, 'name="viewport"');
  assertStringIncludes(htmlSource, "<title>作業ボード</title>");
});

Deno.test("index.html: JavaScript が引く id は、すべて HTML にある", () => {
  const ids = [...scriptSource.matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1]);
  assert(ids.length > 10, "id をほとんど引いていない（切り出しに失敗している）");
  const missing = ids.filter((id) => !markupSource.includes(`id="${id}"`));
  assertEquals(missing, [], "HTML に無い id を引いている");
});

// ── ⑥ CSP（インラインの script はハッシュで1本だけ許す） ──────────

Deno.test("index.html: CSP のハッシュが実際の <script> と一致している", async () => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(scriptSource),
  );
  const expected = `sha256-${encodeBase64(new Uint8Array(digest))}`;
  const csp = /content="(default-src[^"]*)"/.exec(htmlSource);
  assert(csp !== null, "CSP の meta が無い");
  assertStringIncludes(csp[1], "default-src 'none'");
  assertStringIncludes(csp[1], "connect-src 'self'");
  assert(
    csp[1].includes(`script-src '${expected}'`),
    `CSP のハッシュが古い。<script> を書き換えたら meta も直すこと。正しい値: '${expected}'`,
  );
});

// ── ⑦ 設計書の約束（TTL・自動更新・fetchedAt） ─────────────

Deno.test("index.html: 古い表明の判定は types.ts の CLAIM_TTL_MS と同じ値", () => {
  // 画面は board サーバーと独立に動かせるよう定数を写しているので、
  // 正本（types.ts）とずれていないことを機械的に確かめる。
  const matched = /const CLAIM_TTL_MS = ([^;]+);/.exec(scriptSource);
  assert(matched !== null, "CLAIM_TTL_MS を持っていない");
  // 「8 * 60 * 60 * 1000」の形だけを解く（式を評価する口を持ち込まないため）
  const factors = matched[1].split("*").map((part) => Number(part.trim()));
  assertFalse(factors.some(Number.isNaN), `掛け算の形で書いてほしい: ${matched[1]}`);
  const value = factors.reduce((a, b) => a * b, 1);
  assertEquals(value, CLAIM_TTL_MS, "types.ts の CLAIM_TTL_MS とずれている");
});

Deno.test("index.html: PR 索引は「いつ時点か」を必ず出す（§9）", () => {
  assertStringIncludes(markupSource, 'id="prs-fetched-at"');
  assertStringIncludes(scriptSource, "state.prsFetchedAt");
  assertStringIncludes(scriptSource, "まだ一度も取得できていません");
});

Deno.test("index.html: タブが見えていないときは自動更新を止める", () => {
  assertStringIncludes(scriptSource, 'document.addEventListener("visibilitychange"');
  assertStringIncludes(scriptSource, "document.hidden === true");
  assertStringIncludes(scriptSource, "clearInterval(");
});

// ── 偽 DOM で実際に動かす ───────────────────────────────

/** 画面のロジックから取り出す口。boot() の呼び出しを差し替えて受け取る */
type Ui = {
  els: Record<string, FakeElement>;
  state: {
    token: string | null;
    timerId: number | null;
    showDoneClaims: boolean;
    claims: unknown[];
    serverTime: number;
    tasks: unknown[];
    prs: unknown[];
    prsFetchedAt: number | null;
  };
  renderClaims: () => void;
  renderTasks: () => void;
  renderPrs: () => void;
  renderFetchedAt: () => void;
  isStale: (claim: unknown, now: number) => boolean;
  pathsOverlap: (a: unknown, b: unknown) => boolean;
  connect: (token: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  dropToken: (message: string) => void;
  boot: () => Promise<void> | void;
  POLL_MS: number;
};

const BOOT_CALL = "\n        boot();\n";
const INTERNALS = `
        return {
          els,
          state,
          renderClaims,
          renderTasks,
          renderPrs,
          renderFetchedAt,
          isStale,
          pathsOverlap,
          connect,
          refreshAll,
          dropToken,
          boot,
          POLL_MS,
        };
`;
const IIFE_OPEN = "      (function () {";

type FetchCall = { path: string; init: { method: string; headers: Record<string, string> } };

type Harness = {
  ui: Ui;
  doc: { hidden: boolean; dispatch: (type: string, event: unknown) => void };
  timers: Set<number>;
  calls: FetchCall[];
  /** この端末に残る記憶（localStorage） */
  local: Map<string, string>;
  /** このタブだけの記憶（sessionStorage） */
  session: Map<string, string>;
  /** 要素に付いたハンドラを呼ぶ（fake_dom の addEventListener は受け流すので差し替えてある） */
  fire: (el: FakeElement, type: string, event?: unknown) => void;
};

/** 応答の作り方。パスごとに { status, body } を返す */
type Responder = (path: string) => { status: number; body: unknown } | "throw";

/**
 * インラインの JavaScript を、偽の DOM・記憶・通信の上で動かす。
 * 起動（boot）は走らせず、内部を受け取ってからテストが好きに呼ぶ。
 */
function loadUi(respond: Responder, brokenStorage = false): Harness {
  assert(scriptSource.includes(BOOT_CALL), "boot() の呼び出しが見つからない（差し替えられない）");
  assert(scriptSource.includes(IIFE_OPEN), "即時関数の書き出しが変わっている");
  const body = scriptSource
    .replace(IIFE_OPEN, `      const __ui = ${IIFE_OPEN.trim()}`)
    .replace(BOOT_CALL, INTERNALS) + "\nreturn __ui;\n";

  const base = createFakeDocument();

  /*
   * fake_dom.ts の FakeElement.addEventListener は受け流すだけなので、
   * 「トークンを変更」を押す・チェックを切り替えるといった操作を試せない。
   * fake_dom.ts は他の担当のファイルなので触らず、ここで受け口だけ差し替える。
   */
  const handlers = new Map<FakeElement, Map<string, ((event: unknown) => void)[]>>();
  function withListeners(el: FakeElement): FakeElement {
    if (!handlers.has(el)) {
      const bucket = new Map<string, ((event: unknown) => void)[]>();
      handlers.set(el, bucket);
      (el as unknown as {
        addEventListener: (type: string, handler: (event: unknown) => void) => void;
      }).addEventListener = (type, handler) => {
        const list = bucket.get(type) ?? [];
        list.push(handler);
        bucket.set(type, list);
      };
    }
    return el;
  }
  const fire = (el: FakeElement, type: string, event: unknown = { preventDefault: () => {} }) => {
    for (const handler of handlers.get(el)?.get(type) ?? []) handler(event);
  };

  const doc = {
    ...base.document,
    hidden: false,
    getElementById: (id: string) => withListeners(base.document.getElementById(id)),
  };

  /**
   * localStorage / sessionStorage の最小限の偽物。中身はテストから覗ける。
   * brokenStorage なら、本物が記憶を禁じられているとき（プライベート窓・
   * サイトデータの遮断）と同じく、呼ぶたびに例外を投げる。
   */
  function makeStorage(box: Map<string, string>) {
    if (brokenStorage) {
      const deny = () => {
        throw new Error("storage is not available");
      };
      return { getItem: deny, setItem: deny, removeItem: deny };
    }
    return {
      getItem: (key: string) => box.get(key) ?? null,
      setItem: (key: string, value: string) => {
        box.set(key, value);
      },
      removeItem: (key: string) => {
        box.delete(key);
      },
    };
  }
  const local = new Map<string, string>();
  const session = new Map<string, string>();

  const calls: FetchCall[] = [];
  const fakeFetch = (path: string, init: FetchCall["init"]) => {
    calls.push({ path, init });
    const result = respond(path);
    if (result === "throw") return Promise.reject(new Error("network down"));
    return Promise.resolve({
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: () => Promise.resolve(result.body),
    });
  };

  const timers = new Set<number>();
  let nextTimer = 1;
  const fakeSetInterval = () => {
    const id = nextTimer++;
    timers.add(id);
    return id;
  };
  const fakeClearInterval = (id: number) => {
    timers.delete(id);
  };

  const factory = new Function(
    "document",
    "localStorage",
    "sessionStorage",
    "fetch",
    "setInterval",
    "clearInterval",
    body,
  );
  const ui = factory(
    doc,
    makeStorage(local),
    makeStorage(session),
    fakeFetch,
    fakeSetInterval,
    fakeClearInterval,
  ) as Ui;
  // 起動と同じく、チェックは既定で入っている（HTML の checked に合わせる）
  ui.els.gateRemember.checked = true;
  return { ui, doc, timers, calls, local, session, fire };
}

/** 木をたどって、出てきた要素の tagName をすべて集める */
function tagNames(node: FakeElement): string[] {
  const out: string[] = [];
  for (const child of node.children) {
    out.push(child.tagName.toLowerCase());
    out.push(...tagNames(child));
  }
  return out;
}

/** 木をたどって、文字を持つ要素の textContent をすべて集める */
function texts(node: FakeElement): string[] {
  const out: string[] = [];
  for (const child of node.children) {
    if (child.textContent.length > 0) out.push(child.textContent);
    out.push(...texts(child));
  }
  return out;
}

const okResponder: Responder = (path) => {
  if (path.startsWith("/api/claims")) {
    return { status: 200, body: { claims: [], serverTime: Date.now() } };
  }
  if (path.startsWith("/api/tasks")) return { status: 200, body: { tasks: [] } };
  if (path.startsWith("/api/prs")) return { status: 200, body: { prs: [], fetchedAt: null } };
  return { status: 404, body: null };
};

const NASTY = '<img src=x onerror="alert(1)">';

Deno.test("画面: 表明の文字はタグとして解釈されず、文字のまま入る", () => {
  const h = loadUi(okResponder);
  h.ui.state.serverTime = 2_000_000_000_000;
  h.ui.state.claims = [
    {
      id: "01",
      member: "m1",
      sessionId: "s1",
      memberName: NASTY,
      title: NASTY,
      note: NASTY,
      paths: [NASTY],
      branch: NASTY,
      status: "working",
      startedAt: 2_000_000_000_000 - 1000,
      heartbeatAt: 2_000_000_000_000 - 1000,
      stale: false,
    },
  ];
  h.ui.renderClaims();

  const list = h.ui.els.claimsList;
  assertEquals(list.children.length, 1);
  // 危ない文字列は「文字」として置かれている
  const shown = texts(list);
  assert(shown.includes(NASTY), "利用者由来の文字列が文字として入っていない");
  // 文字列から要素が生えていない（img は1つも作られない）
  assertFalse(tagNames(list).includes("img"), "文字列がタグとして解釈されている");
});

Deno.test("画面: タスクと PR の文字も、タグとして解釈されない", () => {
  const h = loadUi(okResponder);
  h.ui.state.tasks = [
    { id: "t1", title: NASTY, body: NASTY, status: "open", createdAt: 1_700_000_000_000 },
  ];
  h.ui.state.prs = [
    { prNumber: 7, title: NASTY, author: NASTY, headRef: NASTY, files: [NASTY], fetchedAt: 1 },
  ];
  h.ui.renderTasks();
  h.ui.renderPrs();

  for (const list of [h.ui.els.tasksList, h.ui.els.prsList]) {
    assertEquals(list.children.length, 1);
    assert(texts(list).includes(NASTY), "文字として入っていない");
    assertFalse(tagNames(list).includes("img"), "文字列がタグとして解釈されている");
  }
});

Deno.test("画面: TTL を過ぎた working は「古い表明」として区別される（§5）", () => {
  const h = loadUi(okResponder);
  const now = 2_000_000_000_000;
  h.ui.state.serverTime = now;
  const base = {
    id: "x",
    member: "m",
    sessionId: "s",
    memberName: "ちいかわ",
    title: "何か",
    status: "working",
    startedAt: now - CLAIM_TTL_MS * 2,
    stale: false,
  };
  h.ui.state.claims = [
    { ...base, id: "fresh", heartbeatAt: now - 60_000 },
    { ...base, id: "old", heartbeatAt: now - CLAIM_TTL_MS - 1 },
    // 中断は時間が経っていても「古い表明」にはしない（§5 は working が対象）
    { ...base, id: "paused", status: "paused", heartbeatAt: now - CLAIM_TTL_MS * 3 },
  ];
  h.ui.renderClaims();

  const classes = h.ui.els.claimsList.children.map((li) => li.className);
  assertEquals(classes.filter((c) => c.includes("claim-stale")).length, 1);
  // 境界: ちょうど TTL は古くない、1ms 超えたら古い
  assertEquals(h.ui.isStale({ status: "working", heartbeatAt: now - CLAIM_TTL_MS }, now), false);
  assertEquals(h.ui.isStale({ status: "working", heartbeatAt: now - CLAIM_TTL_MS - 1 }, now), true);
  // サーバーが stale を付けてきたら、それを優先する
  assertEquals(h.ui.isStale({ status: "working", heartbeatAt: now, stale: true }, now), true);
});

Deno.test("画面: 完了した表明は既定で隠れ、切り替えると出る", () => {
  const h = loadUi(okResponder);
  const now = 2_000_000_000_000;
  h.ui.state.serverTime = now;
  h.ui.state.claims = [
    { id: "a", memberName: "ひろし", title: "作業中のやつ", status: "working", heartbeatAt: now },
    { id: "b", memberName: "みつお", title: "終わったやつ", status: "done", heartbeatAt: now },
  ];
  h.ui.renderClaims();
  assertEquals(h.ui.els.claimsList.children.length, 1);
  h.ui.state.showDoneClaims = true;
  h.ui.renderClaims();
  assertEquals(h.ui.els.claimsList.children.length, 2);
});

Deno.test("画面: PR 索引の取得時刻を出す。まだ無ければそう言う（§9）", () => {
  const h = loadUi(okResponder);
  h.ui.state.prsFetchedAt = null;
  h.ui.renderFetchedAt();
  assertEquals(h.ui.els.prsFetchedAt.textContent, "まだ一度も取得できていません");

  h.ui.state.prsFetchedAt = Date.now() - 60_000;
  h.ui.renderFetchedAt();
  assertStringIncludes(h.ui.els.prsFetchedAt.textContent, "時点");
  assertStringIncludes(h.ui.els.prsFetchedAt.textContent, "1分前");
});

Deno.test("画面: 表明と重なる PR に印が付く", () => {
  const h = loadUi(okResponder);
  assert(h.ui.pathsOverlap("server/main.ts", "server/main.ts"));
  assert(h.ui.pathsOverlap("public", "public/app.js"), "ディレクトリ配下を重なりとみなせていない");
  assertFalse(h.ui.pathsOverlap("public/app.js", "server/main.ts"));
  assertFalse(h.ui.pathsOverlap("public", ""));

  h.ui.state.claims = [
    { id: "c", memberName: "ちいかわ", title: "廊下", status: "working", paths: ["public"] },
  ];
  h.ui.state.prs = [
    { prNumber: 1, title: "廊下の描き直し", author: "a", headRef: "b", files: ["public/app.js"] },
    { prNumber: 2, title: "サーバー", author: "a", headRef: "b", files: ["server/main.ts"] },
  ];
  h.ui.renderPrs();
  const shown = h.ui.els.prsList.children.map((li) => texts(li).join(" / "));
  assertStringIncludes(shown[0], "表明と重なる: ちいかわ");
  assertFalse(shown[1].includes("表明と重なる"));
});

// ── 認証と通信 ─────────────────────────────────────

Deno.test("index.html: 読み込んだ直後はボードが隠れている（未認証なら入力欄だけ）", () => {
  assertStringIncludes(markupSource, '<section id="board" class="hidden">');
  assertStringIncludes(markupSource, '<section id="gate" class="card block">');
});

Deno.test("画面: トークンはヘッダにだけ載り、URL には出ない", async () => {
  const h = loadUi(okResponder);
  await h.ui.connect("secret-token-value");
  assert(h.calls.length > 0, "1度も通信していない");
  for (const call of h.calls) {
    assertFalse(call.path.includes("secret-token-value"), "URL にトークンが載っている");
    assertEquals(call.init.headers.authorization, "Bearer secret-token-value");
  }
  assertEquals(h.local.get("board-token"), "secret-token-value");
  assert(h.ui.els.board.className.includes("hidden") === false, "ボードが出ていない");
  assert(h.ui.els.gate.className.includes("hidden"), "入力欄が残っている");
});

Deno.test("画面: トークンが通らなければ捨てて、入力欄に戻す", async () => {
  const h = loadUi(() => ({ status: 401, body: { error: "unauthorized" } }));
  await h.ui.connect("wrong-token");
  assertEquals(h.ui.state.token, null);
  assertEquals(h.local.has("board-token"), false, "通らなかったトークンを覚えている");
  assertEquals(h.session.has("board-token"), false, "通らなかったトークンを覚えている");
  assert(h.ui.els.gate.className.includes("hidden") === false, "入力欄に戻っていない");
  assertEquals(h.ui.els.gateError.textContent, "トークンが違います。");
});

Deno.test("画面: 通信に失敗しても画面が壊れない", async () => {
  const h = loadUi(() => "throw");
  await h.ui.connect("token");
  // 例外が飛ばずにここまで来ること自体がテスト。トークンは覚えない
  assertEquals(h.ui.state.token, null);
  assertEquals(h.local.has("board-token"), false);
  assertEquals(h.session.has("board-token"), false);
  assertStringIncludes(h.ui.els.gateError.textContent, "サーバーに繋がりません");
});

Deno.test("画面: 一部の取得だけ失敗しても、取れたぶんは出す", async () => {
  const h = loadUi((path) => {
    if (path.startsWith("/api/prs")) return "throw";
    if (path.startsWith("/api/claims")) {
      return {
        status: 200,
        body: {
          claims: [{ id: "a", memberName: "ひろし", title: "生きてる", status: "working" }],
          serverTime: Date.now(),
        },
      };
    }
    return { status: 200, body: { tasks: [{ id: "t", title: "やること", status: "open" }] } };
  });
  await h.ui.connect("token");
  assertEquals(h.ui.els.claimsList.children.length, 1, "表明が出ていない");
  assertEquals(h.ui.els.tasksList.children.length, 1, "タスクが出ていない");
  assertStringIncludes(h.ui.els.prsError.textContent, "サーバーに繋がりません");
});

// ── トークンの覚え方（「この端末に記憶する」） ─────────────────

/** 保存済みのトークンから読み直す。前のタブを閉じて開き直したのと同じこと */
function reopen(h: Harness, respond: Responder): Harness {
  const next = loadUi(respond);
  for (const [key, value] of h.local) next.local.set(key, value);
  for (const [key, value] of h.session) next.session.set(key, value);
  return next;
}

Deno.test("画面: 既定では、この端末に残る記憶に覚える", async () => {
  const h = loadUi(okResponder);
  assertEquals(h.ui.els.gateRemember.checked, true, "既定でチェックが入っていない");
  await h.ui.connect("remembered-token");
  assertEquals(h.local.get("board-token"), "remembered-token");
  assertEquals(h.session.has("board-token"), false, "タブだけの記憶にも二重に入れている");
});

Deno.test("画面: チェックを外すと、そのタブだけの記憶に覚える", async () => {
  const h = loadUi(okResponder);
  h.ui.els.gateRemember.checked = false;
  await h.ui.connect("tab-only-token");
  assertEquals(h.session.get("board-token"), "tab-only-token");
  assertEquals(h.local.has("board-token"), false, "この端末に残してしまっている");
});

Deno.test("画面: 一度覚えたら、次に開いたときは入力が要らない", async () => {
  const first = loadUi(okResponder);
  await first.ui.connect("kept-token");
  assertEquals(first.local.get("board-token"), "kept-token");

  // 開き直す: 入力欄には触れず、覚えていたトークンで繋がること
  const second = reopen(first, okResponder);
  await second.ui.boot();
  assertEquals(second.ui.state.token, "kept-token");
  assertEquals(second.ui.els.gateRemember.checked, true, "前に選んだ置き場を映していない");
  assert(second.ui.els.board.className.includes("hidden") === false, "ボードが出ていない");
  for (const call of second.calls) {
    assertEquals(call.init.headers.authorization, "Bearer kept-token");
  }
});

Deno.test("画面: タブだけの記憶に入れたぶんも、読み出しでは拾う", async () => {
  const first = loadUi(okResponder);
  first.ui.els.gateRemember.checked = false;
  await first.ui.connect("tab-only-token");
  assertEquals(first.session.get("board-token"), "tab-only-token");

  const second = reopen(first, okResponder);
  await second.ui.boot();
  assertEquals(second.ui.state.token, "tab-only-token");
  // 前に外していたチェックは、外れたまま出る
  assertEquals(second.ui.els.gateRemember.checked, false, "前に選んだ置き場を映していない");
});

Deno.test("画面: 覚え方を変えても、古いほうに残らない", async () => {
  const h = loadUi(okResponder);
  await h.ui.connect("token-a");
  assertEquals(h.local.get("board-token"), "token-a");

  // 同じタブで「トークンを変更」してから、今度はチェックを外して入れ直す
  h.fire(h.ui.els.tokenChange, "click");
  h.ui.els.gateRemember.checked = false;
  await h.ui.connect("token-b");
  assertEquals(h.session.get("board-token"), "token-b");
  assertEquals(h.local.has("board-token"), false, "この端末に古いトークンが残っている");
});

Deno.test("画面: 「トークンを変更」で、両方の記憶から消える", async () => {
  const h = loadUi(okResponder);
  await h.ui.connect("token-a");
  // 片方にしか入らない作りだが、取りこぼしが無いことを見るため両方に置いておく
  h.local.set("board-token", "token-a");
  h.session.set("board-token", "token-a");

  h.fire(h.ui.els.tokenChange, "click");
  assertEquals(h.ui.state.token, null);
  assertEquals(h.local.has("board-token"), false, "この端末の記憶に残っている");
  assertEquals(h.session.has("board-token"), false, "タブの記憶に残っている");
  assertEquals(h.ui.els.gateToken.value, "", "入力欄に残っている");
  assert(h.ui.els.gate.className.includes("hidden") === false, "入力欄に戻っていない");

  // 開き直しても戻ってこない
  const second = reopen(h, okResponder);
  await second.ui.boot();
  assertEquals(second.ui.state.token, null);
});

Deno.test("画面: 401 を受けたら、両方の記憶から消える", async () => {
  // 繋いだあとに通らなくなる（トークンが作り直された等）
  let unauthorized = false;
  const h = loadUi((path) => (unauthorized ? { status: 401, body: null } : okResponder(path)));
  await h.ui.connect("token-a");
  assertEquals(h.local.get("board-token"), "token-a");
  h.session.set("board-token", "token-a");

  unauthorized = true;
  await h.ui.refreshAll();
  assertEquals(h.ui.state.token, null);
  assertEquals(h.local.has("board-token"), false, "この端末の記憶に残っている");
  assertEquals(h.session.has("board-token"), false, "タブの記憶に残っている");
  assertStringIncludes(h.ui.els.gateError.textContent, "もう一度入力してください");
});

Deno.test("画面: 403 でも、両方の記憶から消える", () => {
  const h = loadUi(okResponder);
  h.local.set("board-token", "token-a");
  h.session.set("board-token", "token-a");
  // dropToken は 401 / 403 の両方から呼ばれる（isUnauthorized が同じ扱い）
  assertStringIncludes(scriptSource, "res.status === 401 || res.status === 403");
  h.ui.dropToken("");
  assertEquals(h.local.has("board-token"), false);
  assertEquals(h.session.has("board-token"), false);
});

Deno.test("画面: 記憶に触れない環境でも、画面は動く", async () => {
  const h = loadUi(okResponder, true);
  await h.ui.connect("token-a");
  assertEquals(h.ui.state.token, "token-a", "覚えられないだけで、このタブでは使えるはず");
  assert(h.ui.els.board.className.includes("hidden") === false, "ボードが出ていない");
});

// ── 自動更新 ───────────────────────────────────────

Deno.test("画面: 自動更新はタブを見ている間だけ動く", async () => {
  const h = loadUi(okResponder);
  await h.ui.connect("token");
  assertEquals(h.timers.size, 1, "自動更新が始まっていない");

  h.doc.hidden = true;
  h.doc.dispatch("visibilitychange", {});
  assertEquals(h.timers.size, 0, "タブを離れても回り続けている");

  const before = h.calls.length;
  h.doc.hidden = false;
  h.doc.dispatch("visibilitychange", {});
  assertEquals(h.timers.size, 1, "戻ってきたのに再開しない");
  assert(h.calls.length > before, "戻ってきたときに取り直していない");
});

Deno.test("画面: 自動更新の間隔は 30 秒", () => {
  const h = loadUi(okResponder);
  assertEquals(h.ui.POLL_MS, 30_000);
});
