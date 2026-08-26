/**
 * 検証台を `deno task test` からも走らせるための入口。
 *
 * 中身は run.js をそのまま子プロセスで動かして、終了コードだけ見る。
 * run.js は最後に失敗数で `Deno.exit(1)` するので、これで全項目が守られる。
 *
 * 子プロセスにしているのは、run.js が globalThis の requestAnimationFrame や
 * performance.now、document を丸ごと差し替えるため。同じプロセスで走らせると
 * 他のテストの時計まで止まる。
 *
 * このファイル名（*_test.js）だけで `deno test` が拾うので、deno.json は触っていない。
 */
import { assertEquals } from "@std/assert";

Deno.test("暖簾の演出: 本物の three.js と GLB で時間軸を実測する", async () => {
  const run = new URL("./run.js", import.meta.url);
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", run.pathname.replace(/^\/([A-Za-z]:)/, "$1")],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const out = new TextDecoder().decode(stdout);
  if (code !== 0) {
    console.log(out);
    console.log(new TextDecoder().decode(stderr));
  }
  assertEquals(code, 0, "検証台の項目に失敗がある（上の出力を見ること）");
});
