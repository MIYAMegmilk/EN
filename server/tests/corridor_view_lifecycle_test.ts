/**
 * 廊下ビュー（public/assets/3d/corridor-view.js）の後始末まわりのテスト。
 *
 * ここで守りたいのは次の2つ。どちらも「画面は動いていないのに走り続ける」種類の
 * 不具合で、目では気づきにくい。
 *
 *   H-17 キーを押したまま canvas からフォーカスが外れると、keyup が届かないので
 *        押しっぱなしの記録が残り、歩き続けて止まらない（Alt+Tab で起きる）
 *   H-18 WebGL の描画文脈が落ちても手当てが無く、真っ黒な canvas の上で
 *        requestAnimationFrame が回り続ける（電池と CPU を食う）
 *
 * ■ 動かし方
 * corridor-view.js は three.js と GLB を要るので、server/tests/corridor_client_test.ts の
 * 偽 CorridorView では中身を見られない。代わりに**既にある検証台**
 * （tools/corridor-harness/）に乗る。あそこは three.js を**本物のまま**読み、
 * 画面が要る WebGLRenderer だけを偽物にしてあるので、corridor-view.js を
 * 1文字も書き換えずに Deno で動かせる。
 *
 * ■ なぜ子プロセスか
 * 検証台の setup.js は globalThis の requestAnimationFrame / ResizeObserver を
 * 丸ごと差し替える。`deno test` は全テストを1プロセスで走らせるので、そのまま
 * 読み込むと他のテストの時計まで止まる。tools/corridor-harness/corridor_harness_test.js
 * と同じ理由で、実測は子プロセスに追い出してある。
 * このファイルは `deno test` から読まれると入口として振る舞い、`deno run` で
 * 直に起動されると実測そのものを行う（import.meta.main で切り替える）。
 *
 * ■ 見ていないこと
 * 偽レンダラを使う以上、**three.js の WebGLRenderer が自前で持っている
 * webglcontextlost / webglcontextrestored の処理は動いていない。**
 * 本物のブラウザでは three.js 側のハンドラが先に走って内部の状態を作り直すが、
 * ここで確かめているのは「corridor-view.js が rAF を止めるか・戻すか」だけ。
 * 実際に GPU の文脈が落ちて絵が戻るかは実機での目視が要る。
 */

import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

// ── 実測（子プロセス側） ──────────────────────────────

/** 判定の記録。失敗した数を返して終了コードにする */
function makeLog() {
  let fails = 0;
  const ok = (cond: boolean, label: string, extra = "") => {
    if (!cond) fails++;
    console.log(`${cond ? "  OK " : "NG   "} ${label}${extra ? "  " + extra : ""}`);
  };
  return {
    ok,
    get fails() {
      return fails;
    },
  };
}

/**
 * 実時間を ms ぶん進める。
 *
 * corridor-view.js の毎フレームの移動量は THREE.Clock（＝実時計）から出るので、
 * rAF を続けざまに叩くと dt が 0 になって「歩いた」が測れない。
 * 検証台の flushFrames は時計を持たないので、ここで実際に少しだけ待つ。
 */
function spin(ms: number): void {
  const until = performance.now() + ms;
  let n = 0;
  while (performance.now() < until) n++;
  if (n < 0) throw new Error("到達しない");
}

/** テスト用の卓 */
function rooms(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    code: `R${String(i).padStart(3, "0")}`,
    roomName: `卓${i}`,
    playerCount: i % 5,
    capacity: 4,
    playing: i % 3 === 0,
    tags: [],
    createdAt: Date.now(),
  }));
}

async function runChecks(): Promise<number> {
  // 検証台は globalThis を差し替えるので、読み込むのは子プロセスの中だけにする
  const { flushFrames, kitUrl, loadCorridorView, makeContainer, pendingFrames } = await import(
    "../../tools/corridor-harness/setup.js"
  );
  const log = makeLog();

  /*
   * 窓（globalThis）に足されたリスナを数える。
   * 要素側は検証台の偽 canvas が listeners を見せてくれるが、窓側は Deno から
   * 覗けないので、addEventListener / removeEventListener を挟んで対を数える。
   * ビューを作る前に仕掛けること。
   */
  const windowListeners: Array<[string, unknown]> = [];
  const origAdd = globalThis.addEventListener.bind(globalThis);
  const origRemove = globalThis.removeEventListener.bind(globalThis);
  // deno-lint-ignore no-explicit-any
  (globalThis as any).addEventListener = (type: string, fn: any, opts?: any) => {
    windowListeners.push([type, fn]);
    origAdd(type, fn, opts);
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).removeEventListener = (type: string, fn: any, opts?: any) => {
    const at = windowListeners.findIndex((p) => p[0] === type && p[1] === fn);
    if (at >= 0) windowListeners.splice(at, 1);
    origRemove(type, fn, opts);
  };
  const windowBlurCount = () => windowListeners.filter((p) => p[0] === "blur").length;

  const container = makeContainer();
  const states: string[] = [];
  // deno-lint-ignore no-explicit-any
  const view: any = (await loadCorridorView()).createCorridorView(container, {
    modelUrl: kitUrl(),
    onContextChange: (state: string) => states.push(state),
  });
  await view.ready;
  view.setRooms(rooms(7));

  /** 検証台の偽 canvas。fire() でイベントを流し込め、listeners で登録を覗ける */
  // deno-lint-ignore no-explicit-any
  const el: any = container.children[0];

  /** 実時間を進めながら n コマ描く */
  const step = (n = 6) => {
    for (let i = 0; i < n; i++) {
      spin(2);
      flushFrames(1);
    }
  };

  /**
   * 「いま押されている記録のせいで歩くか」を測る。
   *
   * position の setter は速度を 0 に戻すので、ここから歩き出したぶんは
   * すべて「押しっぱなしの記録」から出たことになる。押下が空なら
   * 速度も入力も 0 のままで、座標はぴったり動かない（誤差ではなく厳密に 0）。
   */
  const walked = () => {
    view.position = { x: 0, z: 0, yaw: 0 };
    step();
    const p = view.position;
    return Math.hypot(p.x, p.z);
  };

  console.log("=== H-17 押下状態とフォーカス ===");
  el.fire("keydown", { key: "w" });
  const held = walked();
  log.ok(held > 0, "キーを押している間は歩く（この土台が崩れると以下が無意味）", `${held}`);

  el.fire("blur");
  const afterElBlur = walked();
  log.ok(afterElBlur === 0, "canvas から焦点が外れると押下が解ける", `${afterElBlur}`);

  el.fire("keydown", { key: "w" });
  const again = walked();
  log.ok(again > 0, "解けた後にもう一度押せば、これまでどおり歩ける", `${again}`);

  // Alt+Tab で窓ごと後ろへ回る経路。要素の blur が飛ばないブラウザがある
  globalThis.dispatchEvent(new Event("blur"));
  const afterWindowBlur = walked();
  log.ok(
    afterWindowBlur === 0,
    "窓ごと後ろへ回っても押下が解ける（Alt+Tab）",
    `${afterWindowBlur}`,
  );

  el.fire("keydown", { key: "ArrowUp" });
  view.pause();
  view.resume();
  const afterPause = walked();
  log.ok(afterPause === 0, "pause / resume を挟んでも押下が残らない", `${afterPause}`);

  // 異常系: 押していないのに焦点が何度も外れる（別の窓を行き来する）
  el.fire("blur");
  el.fire("blur");
  globalThis.dispatchEvent(new Event("blur"));
  const idle = walked();
  log.ok(idle === 0, "押していない状態で焦点が何度外れても動き出さない", `${idle}`);
  el.fire("keydown", { key: "s" });
  const backward = walked();
  log.ok(backward > 0, "その後もキーは効く（過剰に無効化していない）", `${backward}`);
  el.fire("keyup", { key: "s" });

  console.log("=== H-18 描画文脈のロスト ===");
  view.position = { x: 0, z: 0, yaw: 0 };
  step(1);
  log.ok(pendingFrames() === 1, "回っているときは rAF が1件予約されている", `${pendingFrames()}`);

  let prevented = 0;
  const lost = () => el.fire("webglcontextlost", { preventDefault: () => prevented++ });

  lost();
  log.ok(pendingFrames() === 0, "ロストで rAF の予約が消える（黒いまま回し続けない）");
  log.ok(prevented === 1, "既定動作を止めている（止めないと復帰の合図が来ない）");
  step(3);
  log.ok(pendingFrames() === 0, "ロスト中はフレームが積み上がらない");
  log.ok(states.join(",") === "lost", "呼び出し側へ1回だけ知らせる", states.join(","));

  // 異常系: 同じロストが二重に来る
  lost();
  log.ok(pendingFrames() === 0, "ロストが二重に来ても壊れない");
  log.ok(prevented === 2, "二重に来ても毎回きちんと既定動作は止める");
  log.ok(states.join(",") === "lost", "二重のロストで通知まで二重にしない", states.join(","));

  el.fire("webglcontextrestored", {});
  log.ok(pendingFrames() === 1, "復帰すると描画が再開する", `${pendingFrames()}`);
  log.ok(states.join(",") === "lost,restored", "復帰も知らせる", states.join(","));
  const walkedAfterRestore = (() => {
    el.fire("keydown", { key: "w" });
    const d = walked();
    el.fire("blur");
    return d;
  })();
  log.ok(walkedAfterRestore > 0, "復帰後は操作もこれまでどおり効く", `${walkedAfterRestore}`);

  // 異常系: 落ちていないのに復帰の合図が来る
  el.fire("webglcontextrestored", {});
  log.ok(pendingFrames() === 1, "落ちていないのに復帰が来ても rAF が二重に回らない");
  log.ok(states.join(",") === "lost,restored", "余計な通知を出さない", states.join(","));

  // 境界値: 止めている（pause）あいだにロストして戻ってくる
  view.pause();
  lost();
  el.fire("webglcontextrestored", {});
  log.ok(pendingFrames() === 0, "pause 中に復帰しても、勝手には回り出さない");
  view.resume();
  log.ok(pendingFrames() === 1, "resume すればそこから回り出す", `${pendingFrames()}`);

  console.log("=== 後始末（登録したリスナを外しているか） ===");
  const blurOnWindow = windowBlurCount();
  log.ok(blurOnWindow === 1, "窓に足した blur はちょうど1本", `${blurOnWindow}`);
  view.dispose();
  log.ok(pendingFrames() === 0, "dispose で rAF が止まる");
  log.ok(el.listeners.has("blur") === false, "canvas の blur を外している");
  log.ok(el.listeners.has("webglcontextlost") === false, "webglcontextlost を外している");
  log.ok(el.listeners.has("webglcontextrestored") === false, "webglcontextrestored を外している");
  log.ok(windowBlurCount() === 0, "窓に足した blur を外している", `${windowBlurCount()}`);
  globalThis.dispatchEvent(new Event("blur"));
  log.ok(pendingFrames() === 0, "片付けた後に焦点が外れても何も起きない");
  view.dispose();
  log.ok(true, "dispose の二重呼びで落ちない");

  console.log(log.fails === 0 ? "\nすべて通過" : `\n${log.fails} 件失敗`);
  return log.fails;
}

/**
 * 暖簾の演出（public/noren-scene.js）で描画文脈が落ちたとき。
 *
 * こちらは 2.6 秒の一本道なので**戻す道は選んでいない**。落ちた時点で演出を畳んで
 * 呼び出し側（login.js）へ返し、暗転と遷移を続けさせる。残りの尺ぶん、何も
 * 描かれない板を出したまま rAF を回さないことを見る。
 *
 * 動かし方は tools/noren-harness/。あちらの setup.js は performance.now まで
 * 差し替えるので、廊下側とは**別の子プロセス**で走らせる。
 */
async function runNorenChecks(): Promise<number> {
  const { advance, loadNorenScene, makeStage, now, pendingFrames, settle } = await import(
    "../../tools/noren-harness/setup.js"
  );
  const { playNorenIntro } = await loadNorenScene();
  const log = makeLog();
  /** 1コマの長さ。実時間では待たない */
  const STEP = 1000 / 60;

  console.log("=== H-18 暖簾の演出: 描画文脈のロスト ===");
  {
    const stage = makeStage();
    const beats: Array<{ name: string; t: number }> = [];
    let result: string | null = null;
    let prevented = 0;
    let lostAt = -1;
    const play = playNorenIntro(stage, {
      onBeat: (name: string) => beats.push({ name, t: now() }),
      // deno-lint-ignore no-explicit-any
    }).then((r: any) => {
      result = r;
    });

    for (let i = 0; i < 800 && result === null; i++) {
      await settle();
      if (result !== null) break;
      advance(STEP);
      if (i === 70) {
        // 演出の途中（1.2 秒あたり）で GPU の文脈が落ちる。二重に来る場合も見る
        // deno-lint-ignore no-explicit-any
        const canvas = (globalThis as any).__renderer.domElement;
        canvas.fire("webglcontextlost", { preventDefault: () => prevented++ });
        canvas.fire("webglcontextlost", { preventDefault: () => prevented++ });
        lostAt = now();
      }
    }
    await play;
    await settle();

    log.ok(lostAt > 0, "演出の途中で文脈を落とせた（土台）", `${lostAt.toFixed(0)}ms`);
    log.ok(result !== null, "ロストしても呼び出し側へ必ず戻る（止まったままにしない）");
    log.ok(prevented === 2, "二重に来ても毎回きちんと既定動作を止める", `${prevented} 回`);
    log.ok(pendingFrames() === 0, "ロストの後に rAF の予約が残らない", `${pendingFrames()} 件`);

    const readyAt = beats.find((b) => b.name === "ready")?.t ?? 0;
    const total = now() - readyAt;
    log.ok(
      total < 2000,
      "残りの尺を黒いまま回さず、落ちた時点で畳む（通しは 2.6 秒）",
      `${total.toFixed(0)}ms`,
    );
  }

  console.log("=== 後始末（登録したリスナを外しているか） ===");
  {
    const controller = new AbortController();
    const stage = makeStage();
    let result: string | null = null;
    const play = playNorenIntro(stage, { signal: controller.signal })
      // deno-lint-ignore no-explicit-any
      .then((r: any) => {
        result = r;
      });
    for (let i = 0; i < 800 && result === null; i++) {
      await settle();
      if (result !== null) break;
      advance(STEP);
      if (i === 70) controller.abort(); // 演出の途中で画面を離れる
    }
    await play;
    await settle();
    // deno-lint-ignore no-explicit-any
    const canvas = (globalThis as any).__renderer.domElement;
    log.ok(
      canvas.listeners.has("webglcontextlost") === false,
      "片付けで webglcontextlost を外している",
    );
    canvas.fire("webglcontextlost", { preventDefault: () => {} });
    log.ok(pendingFrames() === 0, "片付けた後にロストが来ても何も起きない");
  }

  console.log("=== 揺れを嫌う設定（一コマだけ描く経路） ===");
  {
    // deno-lint-ignore no-explicit-any
    const before = (globalThis as any).__renderer;
    const stage = makeStage();
    let result: string | null = null;
    let lost = false;
    const play = playNorenIntro(stage, { reducedMotion: true })
      // deno-lint-ignore no-explicit-any
      .then((r: any) => {
        result = r;
      });
    for (let i = 0; i < 800 && result === null; i++) {
      await settle();
      if (result !== null) break;
      // deno-lint-ignore no-explicit-any
      const renderer = (globalThis as any).__renderer;
      if (!lost && renderer !== undefined && renderer !== before) {
        renderer.domElement.fire("webglcontextlost", { preventDefault: () => {} });
        lost = true;
      }
      advance(STEP);
    }
    await play;
    await settle();
    log.ok(lost, "この経路でも文脈を落とせた（土台）");
    log.ok(result === "still", "落ちても静止画の経路は止まらず呼び出し側へ返る", `${result}`);
    log.ok(pendingFrames() === 0, "rAF の予約が残らない", `${pendingFrames()} 件`);
  }

  console.log(log.fails === 0 ? "\nすべて通過" : `\n${log.fails} 件失敗`);
  return log.fails;
}

// ── 入口 ──────────────────────────────────────────────

/**
 * 子プロセスで自分自身を走らせる。
 * 検証台が globalThis（時計・rAF・document）を差し替えるので、
 * `deno test` の本体とも、廊下と暖簾どうしとも、混ぜてはいけない。
 */
function spawnSelf(mode: string): Deno.ChildProcess {
  const self = fromFileUrl(import.meta.url);
  const config = fromFileUrl(new URL("../../deno.json", import.meta.url));
  return new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--config", config, self, mode],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

async function expectPass(mode: string): Promise<void> {
  const { code, stdout, stderr } = await spawnSelf(mode).output();
  if (code !== 0) {
    console.log(new TextDecoder().decode(stdout));
    console.log(new TextDecoder().decode(stderr));
  }
  assertEquals(code, 0, "検証台の項目に失敗がある（上の出力を見ること）");
}

if (import.meta.main) {
  const fails = Deno.args[0] === "noren" ? await runNorenChecks() : await runChecks();
  Deno.exit(fails === 0 ? 0 : 1);
} else {
  Deno.test("廊下ビュー: 焦点喪失と WebGL コンテキストロスト（本物の three.js と GLB）", async () => {
    await expectPass("corridor");
  });

  Deno.test("暖簾の演出: WebGL コンテキストロストで演出を畳む（本物の three.js と GLB）", async () => {
    await expectPass("noren");
  });
}
