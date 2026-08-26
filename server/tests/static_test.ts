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
