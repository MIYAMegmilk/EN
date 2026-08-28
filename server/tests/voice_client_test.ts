/**
 * public/room/voice.js（通話の文字起こし）のテスト。ひろし担当。
 * 設計は docs/design/bot-voice.md。
 *
 * クライアントのファイルだが、ブラウザ API のうち voice.js が触るのは
 * SpeechRecognition とタイマーだけなので、偽の window に載せれば
 * Deno から素の JavaScript として動かせる。
 * ここで見るのは「何をサーバーへ送るか」――誤送信は全員のチャットに出るため。
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const VOICE_JS = fromFileUrl(new URL("../../public/room/voice.js", import.meta.url));
const source = await Deno.readTextFile(VOICE_JS);

/** SpeechRecognition の偽物。テストからイベントを起こせるようにする */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  started = false;
  aborted = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void {
    this.started = true;
  }

  abort(): void {
    this.aborted = true;
  }

  /** 認識結果を1件流す。final=false なら未確定（字幕だけに出るはず） */
  emit(transcript: string, final: boolean): void {
    this.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript }, isFinal: final, length: 1 }],
    });
  }
}

type Sent = { t: string; text: string };

/** voice.js を読み込んだ偽 window を1つ作る */
function load(options: { supported?: boolean } = {}) {
  FakeRecognition.instances = [];
  const sent: Sent[] = [];
  const status: Array<{ kind: string; message: string }> = [];
  const timers: Array<() => void> = [];
  // deno-lint-ignore no-explicit-any
  const win: any = {
    SpeechRecognition: options.supported === false ? undefined : FakeRecognition,
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
  };
  new Function("window", source)(win);
  const caption = { textContent: "" };
  win.Voice.init({
    send: (msg: Sent) => sent.push(msg),
    onStatus: (event: { kind: string; message: string }) => status.push(event),
    captionEl: caption,
  });
  return { Voice: win.Voice, sent, status, caption, timers };
}

/** いま動いている偽 SpeechRecognition */
function current(): FakeRecognition {
  const last = FakeRecognition.instances.at(-1);
  assert(last !== undefined, "認識セッションが作られていない");
  return last;
}

Deno.test("voice.js: 既定は OFF（本人が ON にするまで何も送らない）", () => {
  const { Voice, sent } = load();
  assertEquals(Voice.getState().enabled, false);
  assertEquals(FakeRecognition.instances.length, 0);
  assertEquals(sent.length, 0);
});

Deno.test("voice.js: ON にすると日本語・継続認識でセッションを張る", () => {
  const { Voice } = load();
  assertEquals(Voice.setEnabled(true), true);
  const recognition = current();
  assertEquals(recognition.started, true);
  assertEquals(recognition.lang, "ja-JP");
  assertEquals(recognition.continuous, true, "一発言ごとに止まると呑み会では使えない");
  assertEquals(recognition.interimResults, true);
});

Deno.test("voice.js: 確定した認識結果だけを送る（未確定は字幕のみ）", () => {
  const { Voice, sent, caption } = load();
  Voice.setEnabled(true);
  current().emit("ふるいけやかわ", false);
  assertEquals(sent.length, 0, "未確定の文を送ってはいけない");
  assertEquals(caption.textContent, "ふるいけやかわ");

  current().emit("ふるいけやかわずとびこむみずのおと", true);
  assertEquals(sent, [{ t: "voice", text: "ふるいけやかわずとびこむみずのおと" }]);
});

Deno.test("voice.js: 短すぎる確定結果は送らない（環境音の誤認識よけ）", () => {
  const { Voice, sent } = load();
  Voice.setEnabled(true);
  current().emit("あ", true);
  assertEquals(sent.length, 0);
  current().emit("かんぱい", true);
  assertEquals(sent.length, 1);
});

Deno.test("voice.js: 同じ文が続けて確定しても1回しか送らない", () => {
  const { Voice, sent } = load();
  Voice.setEnabled(true);
  current().emit("おつかれさま", true);
  current().emit("おつかれさま", true);
  assertEquals(sent.length, 1);
  assertEquals(Voice.getState().dropped, 1);
});

Deno.test("voice.js: 制御文字を落とし、200文字超は切らずに分割する", () => {
  const { Voice } = load();
  // 制御文字（改行・タブ）は空白に潰れ、連続空白は1つにまとまる
  assertEquals(Voice.sanitize("あい\nうえ\tお"), ["あい うえ お"]);
  // 認識結果は句読点なしの長文になりやすい。末尾を捨てるとそこの 5-7-5 が消える
  const long = "あ".repeat(250);
  const chunks = Voice.sanitize(long);
  assertEquals(chunks.length, 2);
  assertEquals(chunks[0].length, 200);
  assertEquals(chunks[1].length, 50);
});

Deno.test("voice.js: 送信レートを自主規制する（サーバーの RATE_LIMITED を浴びない）", () => {
  const { Voice, sent } = load();
  Voice.setEnabled(true);
  for (let i = 0; i < 15; i++) current().emit(`はつげん${i}`, true);
  assertEquals(sent.length, 10, "10秒あたり10件で頭打ちになるはず");
  assertEquals(Voice.getState().dropped, 5);
});

Deno.test("voice.js: マイクを拒否されたら OFF に倒す（再開ループを回さない）", () => {
  const { Voice, status } = load();
  Voice.setEnabled(true);
  current().onerror?.({ error: "not-allowed" });
  assertEquals(Voice.getState().enabled, false);
  assert(status.some((s) => s.kind === "error"), "本人に理由を知らせていない");
});

Deno.test("voice.js: 勝手に終わったセッションは ON のあいだ張り直す", () => {
  const { Voice, timers } = load();
  Voice.setEnabled(true);
  const first = current();
  first.onend?.();
  assertEquals(Voice.getState().running, false);
  assertEquals(timers.length, 1, "再開が予約されていない");
  timers[0]();
  assert(current() !== first, "新しいセッションが張られていない");
  assertEquals(Voice.getState().running, true);
});

Deno.test("voice.js: OFF にすると認識を止め、以後は送らない", () => {
  const { Voice, sent, timers } = load();
  Voice.setEnabled(true);
  const recognition = current();
  Voice.setEnabled(false);
  assertEquals(recognition.aborted, true);
  // 止めたあとに遅れて届いた結果は送らない
  recognition.emit("おそれてきたけっか", true);
  assertEquals(sent.length, 0);
  // 自動再開も予約されない
  recognition.onend?.();
  assertEquals(timers.length, 0);
});

Deno.test("voice.js: 非対応ブラウザでは ON にできない（VC 自体は続けられる）", () => {
  const { Voice, status } = load({ supported: false });
  assertEquals(Voice.isSupported(), false);
  assertEquals(Voice.setEnabled(true), false);
  assertEquals(Voice.getState().enabled, false);
  assert(status.some((s) => s.kind === "error"));
});

Deno.test("voice.js: キックされたら文字起こしを止める", () => {
  const { Voice } = load();
  Voice.setEnabled(true);
  Voice.handleServerMessage({ t: "kicked" });
  assertEquals(Voice.getState().enabled, false);
});

Deno.test("voice.js: 音声合成には触れない（bot の発話はチャットのみ・§3.10）", () => {
  // コメントでは「使わない」と書いてあるので、コードだけを見る
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert(
    !code.includes("speechSynthesis") && !code.includes("SpeechSynthesisUtterance"),
    "文字起こしモジュールが読み上げを持ち込んでいる",
  );
});

// ===========================================================================
// マイクのミュート中は認識そのものを止める
//
// SpeechRecognition は VC の getUserMedia とは別に自前でマイクを開くので、
// vc.js が track.enabled を落としても認識は動き続ける。以前は voice.js に
// muted の参照が1つも無く、ミュートしたはずの声が字幕にも bot にも流れていた。
// ===========================================================================

Deno.test("voice.js: ミュート中は認識を止め、確定結果を送らない", () => {
  const { Voice, sent } = load();
  Voice.setEnabled(true);
  const recognition = current();
  assertEquals(Voice.getState().listening, true);

  Voice.setMuted(true);
  assertEquals(Voice.getState().muted, true);
  assertEquals(Voice.getState().running, false, "ミュート中も認識セッションが動いている");
  assertEquals(Voice.getState().enabled, true, "ミュートは文字起こしの ON を取り消さない");
  // 止め方は abort()。stop() だと溜まっていた音声が確定結果として吐き出される
  assertEquals(recognition.aborted, true, "abort() で止めていない");

  // 止める直前の結果が遅れて届いても送らない（onresult は外してあるので
  // 本来は届かないが、送信側にも同じ判定を置いてある）
  recognition.emit("ないしょのはなし", true);
  assertEquals(sent.length, 0, "ミュート中の発言が送られている");
});

Deno.test("voice.js: ミュート中に喋った内容が、解除後にまとめて出ない", () => {
  const { Voice, sent, caption } = load();
  Voice.setEnabled(true);
  const before = current();
  Voice.setMuted(true);

  // ミュート中の発話（未確定も確定も）はどこにも出ない
  before.emit("ないしょのつぶやき", false);
  before.emit("ないしょのつぶやき", true);
  assertEquals(sent.length, 0);
  assertEquals(caption.textContent, "", "ミュート中の声が字幕に残っている");

  Voice.setMuted(false);
  const after = current();
  assert(after !== before, "解除しても新しいセッションが張られていない");
  assertEquals(Voice.getState().running, true);
  // 溜め込みが無いこと。古いセッションが後から吐いても素通りする
  before.emit("ないしょのつぶやき", true);
  assertEquals(sent.length, 0, "ミュート中の発言が解除後に出てきた");

  after.emit("かんぱいしましょう", true);
  assertEquals(sent, [{ t: "voice", text: "かんぱいしましょう" }]);
});

Deno.test("voice.js: ミュート中に ON にしても認識は始まらない（解除で始まる）", () => {
  const { Voice, status } = load();
  Voice.setMuted(true);
  assertEquals(Voice.setEnabled(true), true, "ON の操作そのものは受け付ける");
  assertEquals(FakeRecognition.instances.length, 0, "ミュート中なのに認識が始まっている");
  assert(
    status.some((s) => s.message.includes("ミュート")),
    "何も拾わない理由が本人に伝わっていない",
  );

  Voice.setMuted(false);
  assertEquals(FakeRecognition.instances.length, 1, "解除しても認識が始まらない");
  assertEquals(Voice.getState().running, true);
});

Deno.test("voice.js: OFF のあいだのミュート操作は認識を触らない", () => {
  const { Voice } = load();
  Voice.setMuted(true);
  Voice.setMuted(false);
  assertEquals(FakeRecognition.instances.length, 0, "OFF なのにセッションが張られた");
  assertEquals(Voice.getState().enabled, false, "ミュート操作で ON になっている");
});

Deno.test("voice.js: ミュート中は自動再開の予約もしない", () => {
  const { Voice, timers } = load();
  Voice.setEnabled(true);
  const recognition = current();
  Voice.setMuted(true);
  // 止めたセッションが後から onend を出しても、張り直しを予約しない
  recognition.onend?.();
  assertEquals(timers.length, 0, "ミュート中に再開が予約されている");
});

Deno.test("voice.js: 卓を離れる（reset）とミュートも持ち越さない", () => {
  const { Voice } = load();
  Voice.setEnabled(true);
  Voice.setMuted(true);
  Voice.reset();
  assertEquals(Voice.getState().muted, false);
  assertEquals(Voice.getState().enabled, false);
  // 次の卓で ON にすれば、そのまま認識が始まる
  Voice.setEnabled(true);
  assertEquals(Voice.getState().running, true);
});
