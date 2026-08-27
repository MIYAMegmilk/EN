/**
 * 画面の「送信ボタン」まわりの守りのテスト（login.js / profile.js / create-room.js）。
 *
 * 見張るのは3つとも「押した結果、利用者が損をしないこと」。
 *
 *   1. login.js  — 連打で登録レート制限（3件/時・server/auth.ts の REGISTER_LIMIT）を
 *                  使い切らないこと。押した瞬間に塞ぐ
 *   2. profile.js — GET /api/tags に失敗した状態で保存しても、既存の趣味タグを
 *                  消さないこと（チェックボックスが1つも無い＝「1つも選んでいない」ではない）
 *   3. create-room.js — 卓のタグ上限（server/types.ts の ROOM_TAGS_MAX = 5）を
 *                  超えたまま遷移しないこと。超えると卓は建つのに
 *                  PATCH /api/rooms/:code だけが 400 で弾かれ、説明文ごと失われる
 *
 * どれもブラウザ向けのファイルだが、触る API は document / location / fetch と
 * ごく一部のグローバルだけなので、偽物を渡せば Deno から素の JavaScript として
 * 実行できる（create_room_test.ts / app_reconnect_test.ts と同じ手口）。
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createFakeDocument, FakeElement } from "./fake_dom.ts";

const read = (rel: string) => Deno.readTextFile(fromFileUrl(new URL(rel, import.meta.url)));

const loginSource = await read("../../public/login.js");
const profileSource = await read("../../public/profile.js");
const createRoomSource = await read("../../public/create-room.js");

// ---------------------------------------------------------------------------
// 共通の偽物
// ---------------------------------------------------------------------------

type Called = { path: string; init?: { method?: string; body?: string } };

/** マイクロタスクとタイマーを、止まるまで交互に流す */
async function settle(runTimers: () => void, rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    runTimers();
  }
}

/** 予約を溜めておいて、テストの合図でまとめて発火するタイマー */
function fakeTimers() {
  let seq = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimeout: (fn: () => void) => {
      const id = seq++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    run: () => {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, fn] of pending) fn();
    },
  };
}

/**
 * `#xxx input[type="checkbox"]:checked` だけを解する簡易 querySelectorAll。
 * fake_dom.ts の既定は常に空配列を返すので、チェックの付いた箱を見たいテストでは
 * これを重ねる（本物のセレクタは解さない）
 */
function checkedSelector(getContainer: (id: string) => FakeElement) {
  return (selector: string): FakeElement[] => {
    const match = /^#([\w-]+) input\[type="checkbox"\]:checked$/.exec(selector);
    if (match === null) return [];
    const out: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const child of node.children) {
        if (child.tagName === "input" && child.checked) out.push(child);
        walk(child);
      }
    };
    walk(getContainer(match[1]));
    return out;
  };
}

// ---------------------------------------------------------------------------
// login.js（H-12: 二重送信）
// ---------------------------------------------------------------------------

/**
 * login.js は ES モジュール（noren-scene.js を import する）。
 * import 文だけ外して関数の本体として読み込み、演出の2つは引数で受け取らせる。
 * 本物のグローバルには触らないので、テスト同士が互いの偽物を踏まない。
 */
const LOGIN_IMPORT = 'import { playNorenIntro, preloadNorenIntro } from "./noren-scene.js";';
if (!loginSource.includes(LOGIN_IMPORT)) {
  throw new Error("login.js の import が変わっています。テストの読み込み方を直してください");
}
const loginBody = loginSource.replace(LOGIN_IMPORT, "");

type LoginPage = {
  el(id: string): FakeElement;
  calls: Called[];
  location: { href: string };
  /** 直前の fetch に応答を返す */
  respond(res: { ok: boolean; status: number; body: unknown }): void;
  /** 直前の fetch を通信断にする */
  reject(): void;
  /** 入力欄で Enter を押す（IME 変換確定中なら composing: true） */
  pressEnter(id: string, composing?: boolean): void;
  /** form の submit を起こす（パスワードマネージャの自動送信の経路） */
  submitForm(id: string): void;
  settle(): Promise<void>;
};

function loadLogin(meFails = false): LoginPage {
  // login.js は #guest-link の aria-disabled を付け外しする。fake_dom.ts の要素は
  // setAttribute しか持たないので、この1要素だけ removeAttribute を足して差し込む
  const elements = new Map<string, FakeElement>();
  const guestLink = new FakeElement("a", "guest-link") as FakeElement & {
    removeAttribute(name: string): void;
  };
  guestLink.removeAttribute = (name: string) => {
    guestLink.attributes.delete(name);
  };
  elements.set("guest-link", guestLink);
  const { document } = createFakeDocument(elements);
  const location = { href: "/login.html" };
  const calls: Called[] = [];
  const timers = fakeTimers();
  const pending: Array<{
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];

  const fetchStub = (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, init });
    // /api/me は「未ログイン」で即答する（ページを開いた時点の確認）。
    // meFails のときは通信断（fetch そのものが投げる）にする
    if (path === "/api/me") {
      if (meFails) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    }
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };

  const factory = new Function(
    "document",
    "location",
    "fetch",
    "Sound",
    "setTimeout",
    "playNorenIntro",
    "preloadNorenIntro",
    loginBody,
  );

  factory(
    document,
    location,
    fetchStub,
    {
      bindButtons: () => {},
      mountControls: () => {},
      preload: () => {},
      unlock: () => {},
      play: () => Promise.resolve(),
      loop: () => Promise.resolve(),
      stop: () => {},
      GAYA_CORRIDOR: 0.32,
    },
    timers.setTimeout,
    () => Promise.resolve("played"),
    // 3D を落とせなかった体にする。login.js は CSS 版の演出へ倒す
    () => Promise.resolve(false),
  );

  return {
    el: (id: string) => document.getElementById(id),
    calls,
    location,
    respond: (res) => {
      const next = pending.shift();
      if (next === undefined) throw new Error("応答を待っている fetch がありません");
      next.resolve({ ok: res.ok, status: res.status, json: () => Promise.resolve(res.body) });
    },
    reject: () => {
      const next = pending.shift();
      if (next === undefined) throw new Error("応答を待っている fetch がありません");
      next.reject(new TypeError("Failed to fetch"));
    },
    pressEnter: (id: string, composing = false) => {
      const el = document.getElementById(id);
      for (const handler of el.handlers.get("keydown") ?? []) {
        handler({ key: "Enter", isComposing: composing, preventDefault: () => {} });
      }
    },
    submitForm: (id: string) => {
      const el = document.getElementById(id);
      for (const handler of el.handlers.get("submit") ?? []) {
        handler({ preventDefault: () => {} });
      }
    },
    settle: () => settle(timers.run),
  };
}

/** 認証系の呼び出しだけを数える（/api/me は数えない） */
function authCalls(page: LoginPage): Called[] {
  return page.calls.filter((c) => c.path.startsWith("/api/auth/"));
}

Deno.test("login.js: 登録は1回押せば1回だけ送る（正常系）", async () => {
  const page = loadLogin();
  page.el("register-userid").value = "taro2026";
  page.el("register-password").value = "hunter2hunter2";

  page.el("register").click();
  await page.settle();

  assertEquals(authCalls(page).length, 1);
  assertEquals(authCalls(page)[0].path, "/api/auth/register");
  assertEquals(page.el("status").textContent, "送信しています…");
});

Deno.test("login.js: 登録ボタンを連打しても送信は1回に抑える", async () => {
  const page = loadLogin();
  page.el("register-userid").value = "taro2026";
  page.el("register-password").value = "hunter2hunter2";

  // 応答が遅いときに押し直すのはごく普通の操作。3回で1時間登録できなくなる
  page.el("register").click();
  page.el("register").click();
  page.el("register").click();
  await page.settle();

  assertEquals(authCalls(page).length, 1, "REGISTER_LIMIT（3件/時）を1秒で使い切らせない");
  assert(page.el("register").disabled, "押せないことが見た目にも分かる");
});

Deno.test("login.js: ログインボタンを連打しても送信は1回に抑える", async () => {
  const page = loadLogin();
  page.el("login-userid").value = "taro2026";
  page.el("login-password").value = "hunter2hunter2";

  page.el("login").click();
  page.el("login").click();
  page.el("login").click();
  page.el("login").click();
  page.el("login").click();
  await page.settle();

  assertEquals(authCalls(page).length, 1, "LOGIN_LIMIT（5回/分）を1秒で使い切らせない");
});

Deno.test("login.js: 失敗したら塞ぎを解いて、押し直せるようにする（異常系）", async () => {
  const page = loadLogin();
  page.el("login-userid").value = "taro2026";
  page.el("login-password").value = "wrong";

  page.el("login").click();
  page.respond({ ok: false, status: 401, body: { error: "ユーザーIDかパスワードが違います" } });
  await page.settle();

  assertFalse(page.el("login").disabled, "打ち直せないと直しようがない");
  assert(page.el("login-error").textContent.includes("ユーザーIDかパスワードが違います"));

  // 打ち直して、もう一度送れること
  page.el("login-password").value = "hunter2hunter2";
  page.el("login").click();
  await page.settle();
  assertEquals(authCalls(page).length, 2);
});

Deno.test("login.js: 通信できなかったときも塞ぎを解き、黙って終わらない（異常系）", async () => {
  const page = loadLogin();
  page.el("login-userid").value = "taro2026";
  page.el("login-password").value = "hunter2hunter2";

  page.el("login").click();
  page.reject();
  await page.settle();

  assertFalse(page.el("login").disabled);
  // 無反応だと「効いていない」と思ってまた押す。それが連打の入り口になる
  assert(page.el("login-error").textContent.length > 0, "理由を出す");
});

Deno.test("login.js: 成功したら塞いだまま入店へ進む", async () => {
  const page = loadLogin();
  page.el("login-userid").value = "taro2026";
  page.el("login-password").value = "hunter2hunter2";

  page.el("login").click();
  page.respond({ ok: true, status: 200, body: { userId: "taro2026" } });
  await page.settle();

  assertEquals(page.location.href, "/entrance.html");
  // 遷移が始まるまでの間にもう一度押せてしまうと、また1回ぶん食う
  assert(page.el("login").disabled);
});

Deno.test("login.js: /api/me が通信断でも画面は動く（M-01: callApi の try/catch）", async () => {
  // callApi が fetch を包んでいないと、ページを開いた時点で refreshMe() が
  // 未処理の Promise 拒否になり、#me-result は空のまま、以降の操作も
  // 「押しても何も出ない」になる
  const page = loadLogin(true);
  await page.settle();

  assert(page.el("me-result").textContent.length > 0, "何も出さずに終わらない");
  assertFalse(
    page.el("me-result").textContent === "未ログイン",
    "確認できなかっただけなのに『未ログイン』と言い切らない",
  );

  // 画面はそのまま使える（ログインを送れる）
  page.el("login-userid").value = "taro2026";
  page.el("login-password").value = "hunter2hunter2";
  page.el("login").click();
  await page.settle();
  assertEquals(authCalls(page).length, 1);
});

Deno.test("login.js: 通信できなかったことを『(0)』ではなく言葉で出す（異常系）", async () => {
  const page = loadLogin();
  page.el("login-userid").value = "taro2026";
  page.el("login-password").value = "hunter2hunter2";

  page.el("login").click();
  page.reject();
  await page.settle();

  const message = page.el("login-error").textContent;
  assert(message.includes("繋がりません"), `理由が読める文言にする: ${message}`);
  assertFalse(message.includes("(0)"), "callApi の内部表現（status 0）を画面に出さない");
});

// ---------------------------------------------------------------------------
// login.js（M-02: Enter キーで送れる）
// ---------------------------------------------------------------------------

Deno.test("login.js: パスワード欄で Enter を押すと送信する（正常系）", async () => {
  const page = loadLogin();
  page.el("login-userid").value = "taro2026";
  page.el("login-password").value = "hunter2hunter2";

  page.pressEnter("login-password");
  await page.settle();

  assertEquals(authCalls(page).length, 1, "ログイン画面でいちばん多い操作を通す");
  assertEquals(authCalls(page)[0].path, "/api/auth/login");
});

Deno.test("login.js: ユーザーID欄の Enter でも送信する（正常系）", async () => {
  const page = loadLogin();
  page.el("login-userid").value = "taro2026";
  page.el("login-password").value = "hunter2hunter2";

  page.pressEnter("login-userid");
  await page.settle();

  assertEquals(authCalls(page).length, 1);
});

Deno.test("login.js: 新規登録側の Enter は登録に送る（正常系）", async () => {
  const page = loadLogin();
  page.el("register-userid").value = "taro2026";
  page.el("register-password").value = "hunter2hunter2";

  page.pressEnter("register-password");
  await page.settle();

  assertEquals(authCalls(page).length, 1);
  assertEquals(authCalls(page)[0].path, "/api/auth/register");
});

Deno.test("login.js: IME の変換確定の Enter では送らない（境界値）", async () => {
  const page = loadLogin();
  page.el("login-userid").value = "taro2026";
  page.el("login-password").value = "hunter2hunter2";

  page.pressEnter("login-password", true);
  await page.settle();

  assertEquals(authCalls(page).length, 0, "変換を確定しただけで送ってしまう");
});

Deno.test("login.js: form の submit（自動送信）でも1回だけ送る（境界値）", async () => {
  const page = loadLogin();
  page.el("login-userid").value = "taro2026";
  page.el("login-password").value = "hunter2hunter2";

  // パスワードマネージャの自動入力＋自動送信はこの経路で来る
  page.submitForm("login-form");
  // 続けて Enter とクリックが来ても、送信は1回に抑える
  page.pressEnter("login-password");
  page.el("login").click();
  await page.settle();

  assertEquals(authCalls(page).length, 1, "入口が増えても送信は1回");
});

// ---------------------------------------------------------------------------
// profile.js（H-13: 取得失敗でタグを消さない）
// ---------------------------------------------------------------------------

type ProfilePage = {
  el(id: string): FakeElement;
  calls: Called[];
  /** #profile-tags に描かれた箱に印を付ける（tagId で指定） */
  check(tagId: string): void;
  /** PUT /api/profile に載った本文 */
  saved(): { nickname?: string; tags?: string[] } | null;
  save(): Promise<void>;
};

/**
 * profile.js を偽の環境で読み込む。
 * tagsOk を false にすると GET /api/tags が失敗した状態になる
 */
async function loadProfile(
  tagsOk: boolean,
  myTags: string[] = ["game", "music"],
  offline: { tags?: boolean; save?: boolean } = {},
): Promise<ProfilePage> {
  const base = createFakeDocument();
  const document = {
    ...base.document,
    querySelectorAll: checkedSelector((id) => base.document.getElementById(id)),
  };
  const location = { href: "/profile.html" };
  const calls: Called[] = [];

  const fetchStub = (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, init });
    if (path === "/api/me") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ userId: "taro2026", nickname: "たろう", tags: myTags }),
      });
    }
    if (path === "/api/tags") {
      // 通信断（fetch そのものが投げる）。5xx とは別の経路
      if (offline.tags === true) return Promise.reject(new TypeError("Failed to fetch"));
      if (!tagsOk) {
        return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve(null) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            tags: [
              { id: "game", label: "ゲーム" },
              { id: "music", label: "音楽" },
              { id: "movie", label: "映画" },
            ],
          }),
      });
    }
    // PUT /api/profile。サーバーは正本を返す
    if (offline.save === true) return Promise.reject(new TypeError("Failed to fetch"));
    const sent = JSON.parse(init?.body ?? "{}") as { nickname?: string; tags?: string[] };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ nickname: sent.nickname, tags: sent.tags }),
    });
  };

  const factory = new Function("document", "location", "fetch", profileSource);
  factory(document, location, fetchStub);
  // init() の fetch 2本ぶんを待つ
  await settle(() => {});

  const el = (id: string) => base.document.getElementById(id);
  return {
    el,
    calls,
    check: (tagId: string) => {
      for (const label of el("profile-tags").children) {
        const box = label.children[0];
        if (box !== undefined && box.value === tagId) box.checked = true;
      }
    },
    saved: () => {
      const put = calls.filter((c) => c.path === "/api/profile");
      const last = put[put.length - 1];
      return last === undefined ? null : JSON.parse(last.init?.body ?? "{}");
    },
    save: async () => {
      el("profile-save").click();
      await settle(() => {});
    },
  };
}

Deno.test("profile.js: 取得できていれば、印を付けたタグがそのまま保存される（正常系）", async () => {
  const page = await loadProfile(true, ["game"]);
  page.check("game");
  page.check("movie");

  await page.save();

  assertEquals(page.saved()?.tags, ["game", "movie"]);
});

Deno.test("profile.js: /api/tags に失敗したら、既存の趣味タグを消さない（異常系）", async () => {
  const page = await loadProfile(false, ["game", "music"]);
  // チェックボックスは1つも描けていない
  assertEquals(page.el("profile-tags").children.length, 0);
  assertEquals(page.el("error").textContent, "趣味タグ一覧の取得に失敗しました");

  page.el("profile-nickname").value = "たろう改";
  await page.save();

  // 空配列で上書きすると、本人の知らないうちに全部消える
  assertEquals(page.saved()?.tags, ["game", "music"], "取得失敗と「1つも選んでいない」は別物");
  assertEquals(page.saved()?.nickname, "たろう改", "あだ名の変更はちゃんと通る");
});

Deno.test("profile.js: /api/tags に失敗したときは、ただ「保存しました」とは言わない（異常系）", async () => {
  const page = await loadProfile(false, ["game", "music"]);

  await page.save();

  // タグ一覧を取れていないときは、タグを触れていない。そこで「プロフィールを
  // 保存しました」と言い切ると、タグまで意図どおりに保存できたように読める。
  //
  // 現在の実装は保存が通ると画面遷移するので、そもそもこの文言を出さない。
  // 「出さない」ことを守るのがこのテストの役目で、代わりに何と出すかは決めない
  // （タグを触れていない旨を明示するのは、あれば嬉しい程度の改善）
  assertFalse(
    page.el("status").textContent === "プロフィールを保存しました",
    "タグを触れていないのに、まるごと保存できたように見せない",
  );
});

Deno.test("profile.js: タグが0個の人は、取得に失敗しても0個のまま（境界値）", async () => {
  const page = await loadProfile(false, []);

  await page.save();

  assertEquals(page.saved()?.tags, [], "無い人に勝手に増やさない");
});

Deno.test("profile.js: /api/tags が通信断でも画面は最後まで組み上がる（M-09）", async () => {
  // callApi が fetch を包んでいないと、init() が未処理の Promise 拒否で止まり、
  // タグもあだ名も描かれない真っ白なフォームだけが残る（エラー表示も出ない）
  const page = await loadProfile(true, ["game", "music"], { tags: true });

  assertEquals(page.el("error").textContent, "趣味タグ一覧の取得に失敗しました", "理由を出す");
  assertEquals(page.el("profile-nickname").value, "たろう", "init() の残りまで走り切る");
});

Deno.test("profile.js: /api/tags が通信断のときも、保存で既存タグを消さない（異常系）", async () => {
  const page = await loadProfile(true, ["game", "music"], { tags: true });

  await page.save();

  assertEquals(page.saved()?.tags, ["game", "music"]);
});

Deno.test("profile.js: 保存が通信断なら、押しても無反応にせず理由を出す（異常系）", async () => {
  const page = await loadProfile(true, ["game"], { save: true });

  await page.save();

  const message = page.el("error").textContent;
  assert(message.includes("繋がりません"), `理由が読める文言にする: ${message}`);
  assertFalse(message.includes("(0)"), "callApi の内部表現（status 0）を画面に出さない");
});

// ---------------------------------------------------------------------------
// create-room.js（H-14: 卓のタグの上限）
// ---------------------------------------------------------------------------

/** server/types.ts の ROOM_TAGS_MAX と同じ値であることを、テスト側でも念のため見る */
const ROOM_TAGS_MAX = 5;

type CreateRoomPage = {
  el(id: string): FakeElement;
  location: { href: string };
  getPending(): Record<string, unknown> | null;
  /** 先頭から count 個のタグに印を付ける */
  checkTags(count: number): void;
  submit(): void;
};

async function loadCreateRoom(tagCount = 8): Promise<CreateRoomPage> {
  const base = createFakeDocument();
  const document = {
    ...base.document,
    querySelectorAll: checkedSelector((id) => base.document.getElementById(id)),
  };
  const location = { href: "/create-room.html" };
  let pending: Record<string, unknown> | null = null;

  const tags = Array.from({ length: tagCount }, (_, i) => ({
    id: `tag${i + 1}`,
    label: `タグ${i + 1}`,
  }));
  const fetchStub = (path: string) => {
    const body = path === "/api/me" ? { userId: "taro2026", nickname: "ホスト太郎" } : { tags };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };

  const factory = new Function("document", "location", "fetch", "RoomHandoff", createRoomSource);
  factory(document, location, fetchStub, {
    setPendingCreateRoom: (payload: Record<string, unknown>) => {
      pending = payload;
    },
  });
  await settle(() => {});

  const el = (id: string) => base.document.getElementById(id);
  return {
    el,
    location,
    getPending: () => pending,
    checkTags: (count: number) => {
      const labels = el("create-room-tags").children;
      for (let i = 0; i < count; i++) labels[i].children[0].checked = true;
    },
    submit: () => el("create-room-submit").click(),
  };
}

/** 一覧に出す卓として、必須項目だけ埋める */
function fillPublicRoom(page: CreateRoomPage): void {
  page.el("create-room-nickname").value = "ホスト太郎";
  page.el("create-room-name").value = "金曜の反省会";
  page.el("create-room-description").value = "しめの一杯までゆっくり";
  const select = page.el("create-room-visibility");
  select.value = "public";
  for (const handler of select.handlers.get("change") ?? []) handler({});
}

Deno.test("create-room.js: タグがちょうど5個なら建てられる（境界値）", async () => {
  const page = await loadCreateRoom();
  fillPublicRoom(page);
  page.checkTags(ROOM_TAGS_MAX);

  page.submit();

  const pending = page.getPending();
  assertEquals((pending?.tags as string[]).length, ROOM_TAGS_MAX);
  assertEquals(pending?.description, "しめの一杯までゆっくり");
  assertEquals(page.location.href, "/index.html");
});

Deno.test("create-room.js: タグが6個なら、遷移せずにその場で知らせる（境界値）", async () => {
  const page = await loadCreateRoom();
  fillPublicRoom(page);
  page.checkTags(ROOM_TAGS_MAX + 1);

  page.submit();

  // 送ってしまうと卓だけ建ち、説明文とタグを載せる PATCH が 400 で丸ごと落ちる
  assertEquals(page.getPending(), null, "受け渡しに書かない");
  assertEquals(page.location.href, "/create-room.html", "遷移しない");
  assertEquals(page.el("error").textContent, `タグは${ROOM_TAGS_MAX}個以内で選んでください`);
  assertEquals(
    page.el("create-room-description").value,
    "しめの一杯までゆっくり",
    "書いた説明文は残る",
  );
});

Deno.test("create-room.js: タグを1つも選ばなくても建てられる（境界値）", async () => {
  const page = await loadCreateRoom();
  fillPublicRoom(page);

  page.submit();

  assertEquals(page.getPending()?.tags, []);
  assertEquals(page.location.href, "/index.html");
});

// ---------------------------------------------------------------------------
// create-room.js（M-12: 合言葉の下限 / M-07: 一覧に出さない卓の説明文・タグ）
// ---------------------------------------------------------------------------

/** server/types.ts の PASSPHRASE_MIN と同じ値であることを、テスト側でも念のため見る */
const PASSPHRASE_MIN = 4;

/** 一覧に出さない卓として、必須項目だけ埋める */
function fillPrivateRoom(page: CreateRoomPage): void {
  page.el("create-room-nickname").value = "ホスト太郎";
  const select = page.el("create-room-visibility");
  select.value = "private";
  for (const handler of select.handlers.get("change") ?? []) handler({});
}

Deno.test("create-room.js: 合言葉が3文字なら、遷移せずにその場で知らせる（境界値）", async () => {
  const page = await loadCreateRoom();
  fillPrivateRoom(page);
  page.el("create-room-passphrase").value = "abc";

  page.submit();

  // 送ってしまうと index.html へ遷移したあとで validatePassphrase に弾かれ、
  // 卓そのものが建たない。原因は別の画面の小さなエラー表示にしか出ない
  assertEquals(page.getPending(), null, "受け渡しに書かない");
  assertEquals(page.location.href, "/create-room.html", "遷移しない");
  assertEquals(
    page.el("error").textContent,
    `合言葉は${PASSPHRASE_MIN}文字以上で入力してください`,
  );
});

Deno.test("create-room.js: 合言葉がちょうど4文字なら建てられる（境界値）", async () => {
  const page = await loadCreateRoom();
  fillPrivateRoom(page);
  page.el("create-room-passphrase").value = "abcd";

  page.submit();

  assertEquals(page.getPending()?.passphrase, "abcd");
  assertEquals(page.location.href, "/index.html");
});

Deno.test("create-room.js: 合言葉が空欄なら、付けない卓として建てられる（境界値）", async () => {
  const page = await loadCreateRoom();
  fillPrivateRoom(page);

  page.submit();

  assertEquals(page.location.href, "/index.html");
  assertEquals(page.getPending()?.passphrase, "");
});

Deno.test("create-room.js: 一覧に出す卓では合言葉欄を見ない（境界値）", async () => {
  const page = await loadCreateRoom();
  fillPublicRoom(page);
  // 招待制のときに書いて、公開に切り替えた残り。合言葉は公開卓には付かない
  page.el("create-room-passphrase").value = "ab";

  page.submit();

  assertEquals(page.location.href, "/index.html", "使わない欄で足止めしない");
});

Deno.test("create-room.js: 一覧に出さない卓では説明文・タグの欄を隠す（M-07）", async () => {
  const page = await loadCreateRoom();
  fillPrivateRoom(page);

  // 出したままだと、書いても送られないものを書かせることになる
  assert(page.el("create-room-description-field").className.split(" ").includes("hidden"));
  assert(page.el("create-room-tags-field").className.split(" ").includes("hidden"));
});

Deno.test("create-room.js: 一覧に出す卓では説明文・タグの欄を出す（正常系）", async () => {
  const page = await loadCreateRoom();
  fillPublicRoom(page);

  assertFalse(page.el("create-room-description-field").className.split(" ").includes("hidden"));
  assertFalse(page.el("create-room-tags-field").className.split(" ").includes("hidden"));
});

Deno.test("create-room.js: 公開で書いてから private に切り替えたら、説明文・タグは積まない", async () => {
  const page = await loadCreateRoom();
  fillPublicRoom(page);
  page.checkTags(2);
  // ここで「一覧に出さない」へ切り替える。欄は隠れるが、打った値は DOM に残る
  fillPrivateRoom(page);

  page.submit();

  // app.js の doCreateRoom は private のとき pendingRoomMeta を null にするので、
  // 積んでも捨てられる。積まないと決め切っておけば、後から経路が変わっても
  // 「送ったのに反映されない」にならない
  assertEquals(page.getPending()?.description, "");
  assertEquals(page.getPending()?.tags, []);
  assertEquals(page.location.href, "/index.html");
});
