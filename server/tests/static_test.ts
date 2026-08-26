/**
 * public/ の静的ページに必要なリンク・要素が入っているかを確認するテスト。
 * ブラウザ実行なしで検証できる範囲（配信されるHTMLの中身）だけを見る。
 */

import { assert, assertEquals } from "@std/assert";
import { startServer } from "../main.ts";

Deno.test("login.html: ゲストとして進むリンクが index.html を指している", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/login.html`);
    const html = await res.text();
    assert(
      html.includes('id="guest-link"') && html.includes('href="/index.html"'),
      "login.html に index.html へのゲスト用リンクが必要です",
    );
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("entrance.html: いちらん・廊下それぞれへのリンクが存在する", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/entrance.html`);
    assertEquals(res.status, 200);
    const html = await res.text();
    assert(
      html.includes('id="entrance-index"') && html.includes('href="/index.html"'),
      "entrance.html に index.html へのリンクが必要です",
    );
    assert(
      html.includes('id="entrance-corridor"') && html.includes('href="/corridor.html"'),
      "entrance.html に corridor.html へのリンクが必要です",
    );
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("entrance.html: 簡易プロフィール編集の帯・フォームが存在する", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/entrance.html`);
    const html = await res.text();
    assert(html.includes('id="entrance-profile-summary"'), "あだ名の要約表示が必要です");
    assert(html.includes('id="entrance-profile-toggle"'), "編集フォームの開閉ボタンが必要です");
    assert(html.includes('id="entrance-nickname"'), "あだ名入力欄が必要です");
    assert(html.includes('id="entrance-tags"'), "タグ一覧を描画するコンテナが必要です");
    assert(html.includes('id="entrance-profile-save"'), "保存ボタンが必要です");
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("index.html・entrance.html: guest-profile.js が本体スクリプトより前に読み込まれている", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const indexRes = await fetch(`http://127.0.0.1:${server.port}/index.html`);
    const indexHtml = await indexRes.text();
    const indexGuestProfileIndex = indexHtml.indexOf('<script src="./guest-profile.js">');
    const indexAppIndex = indexHtml.indexOf('<script src="./app.js">');
    assert(indexGuestProfileIndex >= 0, "index.html に guest-profile.js の script タグが必要です");
    assert(indexAppIndex >= 0, "index.html に app.js の script タグが必要です");
    assert(
      indexGuestProfileIndex < indexAppIndex,
      "index.html では guest-profile.js が app.js より前に読み込まれている必要があります",
    );

    const entranceRes = await fetch(`http://127.0.0.1:${server.port}/entrance.html`);
    const entranceHtml = await entranceRes.text();
    const entranceGuestProfileIndex = entranceHtml.indexOf('<script src="./guest-profile.js">');
    const entranceEntranceJsIndex = entranceHtml.indexOf('<script src="./entrance.js">');
    assert(
      entranceGuestProfileIndex >= 0,
      "entrance.html に guest-profile.js の script タグが必要です",
    );
    assert(entranceEntranceJsIndex >= 0, "entrance.html に entrance.js の script タグが必要です");
    assert(
      entranceGuestProfileIndex < entranceEntranceJsIndex,
      "entrance.html では guest-profile.js が entrance.js より前に読み込まれている必要があります",
    );
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("index.html: ログインリンクが login.html を指している（初期状態は隠れている）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/index.html`);
    const html = await res.text();
    assert(
      html.includes('id="login-link"') && html.includes('href="/login.html"'),
      "index.html に login.html へのログインリンクが必要です",
    );
    assert(
      /id="login-link"[^>]*class="hidden"|class="hidden"[^>]*id="login-link"/.test(html),
      "login-link は初期状態で hidden クラスが付いている必要があります",
    );
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("profile.html: あだ名入力欄・タグ一覧・保存ボタンが存在する", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/profile.html`);
    assertEquals(res.status, 200);
    const html = await res.text();
    assert(html.includes('id="profile-nickname"'), "あだ名入力欄が必要です");
    assert(html.includes('id="profile-tags"'), "タグ一覧を描画するコンテナが必要です");
    assert(html.includes('id="profile-save"'), "保存ボタンが必要です");
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("index.html: プロフィールリンクが profile.html を指している（初期状態は隠れている）", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/index.html`);
    const html = await res.text();
    assert(
      html.includes('id="profile-link"') && html.includes('href="/profile.html"'),
      "index.html に profile.html へのリンクが必要です",
    );
    assert(
      /id="profile-link"[^>]*class="hidden"|class="hidden"[^>]*id="profile-link"/.test(html),
      "profile-link は初期状態で hidden クラスが付いている必要があります",
    );
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("create-room.html: 卓作成フォームの各要素が存在する", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/create-room.html`);
    assertEquals(res.status, 200);
    const html = await res.text();
    assert(html.includes('id="create-room-nickname"'), "あだ名入力欄が必要です");
    assert(html.includes('id="create-room-name"'), "卓名入力欄が必要です");
    assert(html.includes('id="create-room-description"'), "説明文入力欄が必要です");
    assert(html.includes('id="create-room-tags"'), "タグ一覧を描画するコンテナが必要です");
    assert(html.includes('id="create-room-visibility"'), "公開設定の選択欄が必要です");
    // 承認制（§3.1.1）と合言葉（§3.1）はここでしか設定できない。欄が消えると
    // サーバー側の実装が生きたまま到達不能になるので、静的に見張る
    assert(html.includes('id="create-room-entry-mode"'), "入店のしかたの選択欄が必要です");
    assert(html.includes('id="create-room-passphrase"'), "合言葉の入力欄が必要です");
    assert(html.includes('id="create-room-submit"'), "建てるボタンが必要です");
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("create-room.html: room-handoff.js が create-room.js より前に読み込まれる", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/create-room.html`);
    const html = await res.text();
    const handoffIndex = html.indexOf("room-handoff.js");
    const scriptIndex = html.indexOf("create-room.js");
    assert(handoffIndex >= 0, "room-handoff.js の読み込みが必要です");
    assert(scriptIndex >= 0, "create-room.js の読み込みが必要です");
    assert(
      handoffIndex < scriptIndex,
      "room-handoff.js は create-room.js より前に読み込む必要があります",
    );
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("index.html: room-handoff.js が app.js より前に読み込まれる", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/index.html`);
    const html = await res.text();
    const handoffIndex = html.indexOf('<script src="./room-handoff.js">');
    const scriptIndex = html.indexOf('<script src="./app.js">');
    assert(handoffIndex >= 0, "room-handoff.js の読み込みが必要です");
    assert(scriptIndex >= 0, "app.js の読み込みが必要です");
    assert(handoffIndex < scriptIndex, "room-handoff.js は app.js より前に読み込む必要があります");
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("corridor.html: room-handoff.js が corridor.js より前に読み込まれる", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/corridor.html`);
    const html = await res.text();
    const handoffIndex = html.indexOf('<script src="./room-handoff.js">');
    const scriptIndex = html.indexOf('<script type="module" src="./corridor.js">');
    assert(handoffIndex >= 0, "room-handoff.js の読み込みが必要です");
    assert(scriptIndex >= 0, "corridor.js の読み込みが必要です");
    assert(
      handoffIndex < scriptIndex,
      "room-handoff.js は corridor.js より前に読み込む必要があります",
    );
  } finally {
    await server.shutdown();
    kv.close();
  }
});

Deno.test("entrance.html: 卓を建てるカードが index.html/廊下カードと並んで存在する", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/entrance.html`);
    const html = await res.text();
    assert(
      html.includes('id="entrance-create"') && html.includes('href="/create-room.html"'),
      "entrance.html に create-room.html へのリンクが必要です",
    );
    assert(html.includes('id="entrance-create-desc"'), "卓を建てるカードの説明文の要素が必要です");
  } finally {
    await server.shutdown();
    kv.close();
  }
});

/**
 * 「暖簾をくぐった先の景色」は assets/interior.svg 1枚が正本で、
 * 3D の背景板・login.html の遷移画面・entrance.html の到着が同じ絵を使う。
 * どれかが別の絵を持ち出すと、くぐった先と遷移画面と着いた先が別の店に見える。
 */
Deno.test("interior.svg: 3D・遷移画面・到着が同じ1枚を使っている", async () => {
  const kv = await Deno.openKv(":memory:");
  const server = startServer(0, "127.0.0.1", kv);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const svg = await fetch(`${base}/assets/interior.svg`);
    assertEquals(svg.status, 200, "景色が配信されている必要があります");
    assert(
      (svg.headers.get("content-type") ?? "").includes("image/svg+xml"),
      "SVG として配信される必要があります（three も CSS も画像として読む）",
    );
    await svg.body?.cancel();

    for (const path of ["/login.html", "/entrance.html", "/noren-scene.js"]) {
      const res = await fetch(`${base}${path}`);
      const text = await res.text();
      assert(
        text.includes("interior.svg"),
        `${path} が assets/interior.svg を参照している必要があります`,
      );
    }
  } finally {
    await server.shutdown();
    kv.close();
  }
});
