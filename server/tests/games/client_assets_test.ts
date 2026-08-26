/**
 * クライアント専用ゲームのアセット配信とビューモジュールの検証
 * （設計書 docs/design/games-unified.md）。
 *
 * ここで確かめるのは「画像を置いたら、追加設定なしでゲームから読める」という
 * 一番の眼目そのもの。サーバーに手を入れずに済んでいることを、**実際に配信して**確認する。
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { startServer } from "../../main.ts";
import { MODULE_GAMES } from "../../games/index.ts";

const PUBLIC_DIR = fromFileUrl(new URL("../../../public/", import.meta.url));

Deno.test("画像アセットは同一オリジンで配信され、本体の CSP のまま読める（§2.8.4）", async () => {
  const handle = startServer(0);
  try {
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/assets/games/emoawase/tokkuri.svg`,
    );
    const body = await res.text();
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/svg+xml");
    assert(body.length > 0);
    // 本体の CSP がそのまま付き、img-src に 'self' が入っている＝追加設定が要らない
    const csp = res.headers.get("content-security-policy") ?? "";
    assertStringIncludes(csp, "img-src 'self' data:");
    assertStringIncludes(csp, "default-src 'self'");
  } finally {
    await handle.shutdown();
  }
});

Deno.test("ビューモジュールは ES module として配信される（動的 import できる）", async () => {
  const handle = startServer(0);
  try {
    for (const path of ["/room/games/emoawase.js", "/room/games/_client.js"]) {
      const res = await fetch(`http://127.0.0.1:${handle.port}${path}`);
      const body = await res.text();
      assertEquals(res.status, 200, `${path} が配信されていない`);
      assertStringIncludes(res.headers.get("content-type") ?? "", "text/javascript");
      assertStringIncludes(body, "export ");
    }
  } finally {
    await handle.shutdown();
  }
});

Deno.test("カタログのモジュール型ゲームには、必ず対応するビューモジュールが存在する", async () => {
  for (const module of MODULE_GAMES) {
    const path = `${PUBLIC_DIR}room/games/${module.id}.js`;
    const stat = await Deno.stat(path).catch(() => null);
    assert(stat !== null && stat.isFile, `${module.id} のビューモジュールが無い: ${path}`);
  }
});

Deno.test("ビューモジュールは innerHTML を使わない（§3.2 / CLAUDE.md セキュリティ基準）", async () => {
  for await (const entry of Deno.readDir(`${PUBLIC_DIR}room/games`)) {
    if (!entry.isFile || !entry.name.endsWith(".js")) continue;
    const source = await Deno.readTextFile(`${PUBLIC_DIR}room/games/${entry.name}`);
    // コメント中の「innerHTML は使わない」に当たらないよう、代入の形だけを探す
    assert(
      !/\.innerHTML\s*=/.test(source),
      `${entry.name} が innerHTML へ代入している`,
    );
  }
});

Deno.test("画像アセットの置き場は CREDITS.md の表に載っている（出典不明の素材を置かない）", async () => {
  const credits = await Deno.readTextFile(`${PUBLIC_DIR}assets/games/CREDITS.md`);
  for await (const dir of Deno.readDir(`${PUBLIC_DIR}assets/games`)) {
    if (!dir.isDirectory) continue;
    assertStringIncludes(credits, `${dir.name}/`);
    for await (const file of Deno.readDir(`${PUBLIC_DIR}assets/games/${dir.name}`)) {
      if (!file.isFile) continue;
      assertStringIncludes(credits, file.name);
    }
  }
});
