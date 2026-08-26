/**
 * 検証台を `deno task test` からも走らせるための入口。
 *
 * 中身は run.js をそのまま子プロセスで動かして、終了コードだけ見る。
 * run.js は最後に失敗数で `Deno.exit(1)` するので、これで全項目が守られる。
 *
 * なぜ子プロセスかというと、run.js は「1つのビューを作って、位置と向きを変えながら
 * 順に測っていく」形で、状態が前後の項目にまたがっているため。Deno.test へ細かく
 * 割ると、その順序を保つために結局1つにまとめることになる。
 * 実行は 2 秒ほどなので、まとめて1件でも困らない。
 *
 * このファイル名（*_test.js）だけで `deno test` が拾うので、deno.json は触っていない。
 */
import { assertEquals } from "@std/assert";

Deno.test("廊下ビュー: 本物の three.js と GLB で実測する（ドローコール・壁の穴・API）", async () => {
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
