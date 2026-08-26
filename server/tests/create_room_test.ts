/**
 * public/create-room.js の単体テスト。
 *
 * ブラウザ向けのファイルだが、触る API は document / location / fetch と
 * RoomHandoff だけなので、偽物を渡せば素の JavaScript として Deno から
 * 直接実行できる（guest_profile_test.ts / app_reconnect_test.ts と同じ手口）。
 *
 * ここで見張るのは、卓を立てる画面が index.html から create-room.html へ
 * 移ったときに落ちやすいところ:
 *
 *   ・承認制（§3.1.1）は一覧に出す卓、合言葉（§3.1）は招待制の卓にだけ付く。
 *     サーバーが同じ条件で弾くので、出し分けを間違えると「付けられるように
 *     見えて必ずエラーになる」欄ができる
 *   ・その2つが RoomHandoff に載らないと、実装が生きたまま到達不能になる
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createFakeDocument } from "./fake_dom.ts";

const CREATE_ROOM_JS = fromFileUrl(new URL("../../public/create-room.js", import.meta.url));
const source = await Deno.readTextFile(CREATE_ROOM_JS);

type Pending = Record<string, unknown>;

/** create-room.js を偽の DOM で読み込む */
function load() {
  const { elements, document } = createFakeDocument();
  const location = { href: "/create-room.html" };
  let pending: Pending | null = null;

  const fetchStub = (path: string) => {
    const body = path === "/api/me" ? { userId: "taro2026", nickname: "ホスト太郎" } : { tags: [] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };

  const RoomHandoff = {
    setPendingCreateRoom: (payload: Pending) => {
      pending = payload;
    },
  };

  const factory = new Function("document", "location", "fetch", "RoomHandoff", source);
  factory(document, location, fetchStub, RoomHandoff);

  const el = (id: string) => document.getElementById(id);
  return {
    elements,
    el,
    location,
    getPending: () => pending,
    /** 誰に見せるかを変える。change の handler を直接呼ぶ */
    setVisibility: (value: string) => {
      const select = el("create-room-visibility");
      select.value = value;
      for (const handler of select.handlers.get("change") ?? []) handler({});
    },
    submit: () => el("create-room-submit").click(),
    shown: (id: string) => !el(id).classList.contains("hidden"),
  };
}

Deno.test("create-room.js: 一覧に出す卓では承認制を出し、合言葉は隠す（§3.1.1）", () => {
  const page = load();
  // 既定は public
  assertEquals(page.el("create-room-visibility").value, "");
  page.setVisibility("public");
  assert(page.shown("create-room-entry-mode-field"), "承認制の欄が出ている");
  assert(!page.shown("create-room-passphrase-field"), "合言葉の欄は隠れている");
});

Deno.test("create-room.js: 招待制の卓では合言葉を出し、承認制は隠す（§3.1）", () => {
  const page = load();
  page.setVisibility("private");
  assert(!page.shown("create-room-entry-mode-field"), "承認制の欄は隠れている");
  assert(page.shown("create-room-passphrase-field"), "合言葉の欄が出ている");
});

Deno.test("create-room.js: 承認制を選ぶと entryMode が受け渡しに載る", () => {
  const page = load();
  page.el("create-room-nickname").value = "ホスト太郎";
  page.el("create-room-name").value = "金曜の反省会";
  page.setVisibility("public");
  page.el("create-room-entry-mode").value = "knock";

  page.submit();

  const pending = page.getPending();
  assertEquals(pending?.visibility, "public");
  assertEquals(pending?.entryMode, "knock");
  assertEquals(page.location.href, "/index.html");
});

Deno.test("create-room.js: 合言葉を書くと passphrase が受け渡しに載る", () => {
  const page = load();
  page.el("create-room-nickname").value = "ホスト太郎";
  page.setVisibility("private");
  page.el("create-room-passphrase").value = "さくら三番";

  page.submit();

  assertEquals(page.getPending()?.visibility, "private");
  assertEquals(page.getPending()?.passphrase, "さくら三番");
});

Deno.test("create-room.js: あだ名が空欄なら送らずにその場で知らせる", () => {
  const page = load();
  page.setVisibility("private");

  page.submit();

  assertEquals(page.getPending(), null, "受け渡しに書かない");
  assertEquals(page.location.href, "/create-room.html", "遷移しない");
  assertEquals(page.el("error").textContent, "あだ名を入力してください");
});

Deno.test("create-room.js: 一覧に出す卓で名前が空欄なら送らない", () => {
  const page = load();
  page.el("create-room-nickname").value = "ホスト太郎";
  page.setVisibility("public");

  page.submit();

  assertEquals(page.getPending(), null, "受け渡しに書かない");
  assertEquals(page.location.href, "/create-room.html", "遷移しない");
  assert(page.el("error").textContent.length > 0, "理由を出す");
});
