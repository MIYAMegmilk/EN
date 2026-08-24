# 通話の文字起こし → せりの川柳検出（設計書）

- 版: v1.0
- 日付: 2026-08-24
- 担当: ひろし（bot）
- 前提: 詳細仕様書 [overall.md](../spec/overall.md) v0.5 §3.6 / §3.9 / §3.10、全体設計書 [overall.md](overall.md) v1.0
- 状態: **bot 側・クライアント側は実装済み。サーバー側（types.ts / main.ts / rooms.ts）は
  `VoiceLine` 型のチーム合意待ち**（§5 / §9）。判断を求めていた2点はちいかわが回答済み（§5.3 / §5.4）

---

## 1. 何を解くか

呑み会の会話は VC（§3.6）で進む。チャット欄は静かなままなので、いまの bot には2つの穴がある。

1. **せりが仕事をしない。** 川柳は「喋っているうちに偶然 5-7-5 になる」のがいちばん面白い瞬間なのに、
   せりが見ているのはチャットだけなので、その場にいながら一句も拾えない。
2. **ぐっちーが場を壊す。** 沈黙検知（§3.10）はチャットとゲーム操作しか見ていない。
   全員が声で盛り上がっている部屋を「3分沈黙」と誤判定し、話題カードを投げ、
   ゲームを提案し、最後にはお開きを打診する。

どちらも原因は同じで、**bot に「声」が届いていない**ことである。
各参加者のブラウザが自分のマイクを文字起こしし、その文をルームの発言として bot に流す。

**bot に喋らせる話ではない。** せりの発話面はこれまでどおりチャットのみで、
音声合成（読み上げ）は実装しない（§3.10 / 全体設計書 §3）。
通話から入力を取るだけで、出力は変わらない。

---

## 2. 全体像

```
[自分のマイク]
     │  ブラウザの SpeechRecognition（自分の声のみ・既定 OFF）
     ▼
public/room/voice.js  ── 未確定文 → 手元の字幕表示だけ（送らない）
     │                └ 確定文 → 整形・重複よけ・自主レート制限
     │  C2S { t: "voice", text }
     ▼
server/rooms.ts  ── S2C { t: "voice", line } を同室へ配信（チャット履歴には積まない）
     │  botReduce({ t: "message", source: "voice" })
     ▼
server/bot.ts
     ├ せり  … 声から 5-7-5 を検出 → **チャットへ**発話（テロップ付き）
     └ ぐっちー … 沈黙タイマーを進めない（声も人間の活動として数える）
```

要点は「文字起こしは bot への入力経路であって、bot の出力経路ではない」こと。

---

## 3. せりの拾い方（server/bot.ts・実装済み）

`BotEvent` の `message` は `source: "chat" | "voice"` を持つ。声のときだけ規則を変える。

| | チャット | 声（文字起こし） |
|---|---|---|
| 字余り・字足らず | 拾う（`SENRYU_LOOSE_TEXTS`） | **拾わない** |
| ちょうど 5-7-5 | 拾う（`SENRYU_EXACT_TEXTS`） | 拾う（`SENRYU_VOICE_TEXTS`） |
| 連続で拾う間隔 | 制限なし | **`SERI_VOICE_COOLDOWN_MS` = 90 秒** |
| 同じ句の拾い直し | 直近 `SENRYU_MEMORY` 件は黙る | 同左（共通） |
| ぐっちーの発話枠 | 消費しない | 同左（共通） |

**なぜ声だけ厳しくするか**

- **字余り・字足らずを外した理由**: 文字起こしは読点も改行もない喋り言葉が一本の長い文字列で届く。
  ±1 モーラまで許すと「たまたま 4-8-6 に割れただけの雑談」を拾い続けることになり、
  しかも聞き違いなのか字余りなのかを誰も判別できない。ぴったり 5-7-5 のときだけにする。
- **クールダウンを置いた理由**: 人が 5-7-5 を打ち込むのは意図的な行為で数もたかが知れているが、
  会話は止まらない。1件ずつは正しくても、拾うたびに割り込まれると場が壊れる。
  判定（形態素解析）より先にクールダウンを見るので、解析コストも節約できる。
- **文面を分けた理由**: 「書いた句」ではなく「言った句」なので言い回しが噛み合わない。
  聞き違いの余地を残した文面にして、チャット欄を見ていない人にも
  「いま声を拾った」と分かるようにする。

クールダウンの起点（`state.seri.lastVoiceAt`）は**声で拾えたときだけ**進める。
チャットの句や、見送った声では進めない（黙っているのに次の句まで待たせないため）。

## 4. ぐっちーへの影響（実装済み）

`source` に関わらず `message` は `lastActivityAt` / `lastHumanAt` を進め、`silenceStreak` を 0 に戻す。
文字起こしが流れているあいだ、ぐっちーは沈黙話題・ゲーム提案・お開きの打診を出さない。
声も止まって 3 分経てば、これまでどおり話題カードを投げる。

仕様書 §3.10 の「チャット・ゲーム操作が 3 分間ない場合」に**「VC の文字起こし」を加える改訂**を要請する。

## 5. サーバー側の依頼（→ ちいかわ）

型と API の変更はチーム合意が必要（全体設計書 §3）なので、ここに差分だけ置く。
`server/bot.ts` 側は受け入れ済みなので、下記3ファイルが入れば通しで動く。

### 5.1 `server/types.ts`

```ts
/**
 * 通話の文字起こし1行（§3.6 + docs/design/bot-voice.md）。
 * チャット（§3.9）とは別枠。履歴（chatHistory）には積まず、永続化もしない。
 */
export type VoiceLine = {
  /** 発言の一意ID */
  id: string;
  /** 喋った人の playerId */
  playerId: string;
  /** 発言時点の表示名 */
  nickname: string;
  /** 認識結果。200文字以内・制御文字なし */
  text: string;
  /** 受信時刻（epoch ms） */
  at: number;
};
```

```ts
// C2S に1行
  | { t: "voice"; text: string }

// S2C に1行
  | { t: "voice"; line: VoiceLine }
```

### 5.2 `server/main.ts`

`C2S_TYPES` に `"voice"` を足す。

```diff
   "chat",
+  "voice",
   "rtcSignal",
```

**あわせて報告（別件のバグ）→ #10 で修正済み**: `C2S_TYPES` に `"setBot"` と `"endPollVote"` が
入っておらず、実際の WebSocket 経由では `asC2S` で落ちて bot の ON/OFF と終了アンケートの投票が
動かなかった。ちいかわが実サーバーで再現を確認し、#10 で修正。
`types.ts` の `C2S` 型から `t` を抽出して `C2S_TYPES` と双方向で照合するテストも入っている。

**`"voice"` は #10 に含まれない。** `VoiceLine` 型の追加が §4.3「型変更はチーム合意必須」に当たり、
合意済みの追加リストに入っていないため。**合意が取れ次第、本節の差分どおりに実装する。**

### 5.3 `server/rooms.ts`

`handleChat` の隣に `handleVoice` を置く。**チャットとの違いは4点**。

```ts
/** 文字起こし1行の上限（チャットと同じ、§3.9） */
const VOICE_TEXT_MAX = CHAT_TEXT_MAX;
/** 文字起こしのレート制限。喋り続けても止まらない程度に緩くとる */
const VOICE_RATE_WINDOW_MS = 10_000;
const VOICE_RATE_MAX = 12;

/**
 * 通話の文字起こしを処理する（docs/design/bot-voice.md）。
 * chatHistory には積まない。喋り言葉は量が多く、積むと §3.9 の直近100件が
 * 文字起こしで埋まってチャットの履歴が押し出されるため。
 */
private handleVoice(
  entry: RoomEntry,
  state: LinkState,
  player: Player,
  text: unknown,
  now: number,
): void {
  const validated = validateChatText(text); // 200文字・制御文字の基準は共通
  if (!validated.ok) {
    sendError(state.link, validated.code, validated.message);
    return;
  }
  const times = (entry.voiceTimes.get(player.id) ?? [])
    .filter((at) => now - at < VOICE_RATE_WINDOW_MS);
  if (times.length >= VOICE_RATE_MAX) {
    entry.voiceTimes.set(player.id, times);
    // 超過は黙って捨てる。喋っている最中にエラーを出しても本人には止めようがなく、
    // rtcSignal（§3.8）と同じ「破棄するだけ」の扱いにする
    return;
  }
  times.push(now);
  entry.voiceTimes.set(player.id, times);
  const line: VoiceLine = {
    id: crypto.randomUUID(),
    playerId: player.id,
    nickname: player.nickname,
    text: validated.value,
    at: now,
  };
  this.broadcast(entry, { t: "voice", line });
  // 配信してから bot に渡す（せりの返しが元の発言より先に出ないように）
  this.applyBotEvent(entry, {
    t: "message",
    playerId: player.id,
    nickname: player.nickname,
    text: line.text,
    source: "voice",
  });
}
```

- ディスパッチに `case "voice": this.handleVoice(entry, state, player, msg.text, now); return;`
- `RoomEntry` に `voiceTimes: Map<string, number[]>`（`chatTimes` と同じ初期化・掃除）

**決定（2026-08-24・ちいかわ）: `isVcEligible` で絞る。**

当初は「VC 枠外の人が偽の `voice` を投げても実害はチャット欄が汚れる程度」と見ていたが、
これは過小評価だった。`handleVoice` は配信後に `applyBotEvent` へ `source: "voice"` で渡すので、
**偽の `voice` は bot を駆動できる**:

- 川柳検出を任意のタイミングで誤爆させられる
- 沈黙タイマーをリセットして bot の話題振りを封じられる（逆に、喋っていないのに喋ったことにできる）
- 喋っていない人の発言として、全員の字幕行に文字を出せる

チャットは「自分が打った」という事実に嘘がないが、`voice` は「**喋った**」という属性そのものを
偽装できる。性質が違う。§3.8 が `rtcSignal` に定める中継条件（実装済みの `relayRtcSignal` は
双方が VC 枠に入っていることまで見る）と同じ原則を `voice` にも適用する。

**限界を承知のうえで入れる**: `isVcEligible` は「VC 枠を持っているか（先着6人か）」であって
「実際に VC に参加しているか」ではない。サーバーは VC の参加状態を持っていないため
（§3.6 で payload はサーバーが解釈しない設計）。したがって **7人目以降は弾けるが、
枠内にいて VC 未参加の人による偽装は防げない**。厳密化にはサーバーが VC 参加状態を追跡する
必要があり、それは §3.6 の設計変更になるので別課題とする。

```ts
// handleVoice の冒頭。rtcSignal と同じく、条件を満たさないものは黙って捨てる
if (!this.isVcEligible(entry, player.id)) return;
```

### 5.4 `public/index.html` / `public/app.js`（動作確認ページ）

`voice.js` の読み込みと、卓上パネルへのトグル＋字幕行の追加。

```diff
   <script src="./room/vc.js"></script>
+  <script src="./room/voice.js"></script>
   <script src="./room/chat.js"></script>
```

```diff
     <button id="vc-camera" class="btn" type="button">カメラON</button>
+    <button id="vc-transcribe" class="btn" type="button">文字起こしON</button>
     <button id="vc-leave" class="btn" type="button">VC退出</button>
```

```diff
+    <p id="voice-caption" class="dim" aria-live="polite"></p>
```

```js
Voice.init({
  send,
  captionEl: $("voice-caption"),
  onStatus: (event) => { $("vc-status").textContent = event.message; },
});
$("vc-transcribe").addEventListener("click", () => {
  const on = Voice.toggle();
  $("vc-transcribe").textContent = on ? "文字起こしOFF" : "文字起こしON";
});
// 受信ループに1行、退室処理に1行
Voice.handleServerMessage(msg);   // kicked で自動 OFF
Voice.reset();                    // 退室時
```

**決定（2026-08-24・ちいかわ）: 字幕行に出す。チャット欄には混ぜない。**

`#voice-caption`（`aria-live="polite"`）に**最新1〜2行を上書き表示**する。理由は4点。

1. **サーバー設計との整合**: `chatHistory` に積まない設計なので、UI でチャット欄に混ぜると
   「リロードしたら消えた発言がチャット欄にあった」という不整合が出る
2. **量**: 喋り言葉は量が多く、§3.9 の直近100件をすぐ埋める。混在させると履歴としての価値が壊れる
3. **意味**: チャットは「打った・残る」、文字起こしは「喋った・流れる」。
   同じ枠に置くと、どちらなのか区別できない
4. **専用スクロールログは割に合わない**: 画面を食うのに、飲み会の最中に読み返す動機が薄い

将来「開くと専用ログ」を足す余地は残す。

---

## 6. クライアント（public/room/voice.js・実装済み）

各参加者のブラウザが**自分のマイクだけ**を認識する。他人の声には触らない。

| 決めごと | 値・扱い | 理由 |
|---|---|---|
| 既定 | **OFF**。本人の明示操作でのみ ON | カメラ（§3.6）と同じ扱い。§3.7 |
| 認識 | `continuous` + `interimResults` | 一発言ごとに止まると呑み会では使えない |
| 送るもの | **確定文（`isFinal`）のみ** | 未確定文は手元の字幕だけに出す |
| 最小長 | 2文字未満は送らない | 「あ」「ん」は環境音の誤認識が大半 |
| 上限 | 200文字ごとに**分割**（切り捨てない） | 末尾を捨てるとそこにあった 5-7-5 が消える |
| 重複 | 直前と同じ確定文は送らない | エンジンが結果を出し直すことがある |
| レート | 10秒に10件で頭打ち | サーバーの RATE_LIMITED を浴びる前に手元で間引く |
| 中断時 | `onend` で指数バックオフ再開、5回連続失敗で OFF | 無音や内部エラーで勝手に止まるため |
| 権限拒否 | 即 OFF + 本人へ通知 | 再開しても無駄 |
| 非対応 | ON にできない旨を通知。VC は続行 | iOS Safari・Firefox では使えないことがある |

## 7. プライバシー・安全（§3.7 / §3.8）

- **参加者ごとの opt-in**。自分のマイクを自分の意思で ON にするので、同意の単位が素直に閉じる。
- **ブラウザの音声認識は、エンジンによっては音声をブラウザベンダのサーバーへ送る**（Chrome など）。
  ON にする前に必ずその旨を本人に示すこと。ここは UI 側（トグルの説明文）の責務とする。
  §3.10 の「外部 AI API を使わない」は bot の**発話**をテンプレートに限る規定であり、
  文字起こしは抵触しない。ただし「音声が外に出る」こと自体は別途の説明責任がある。
- 文字起こしは**保存しない**。chatHistory にも積まず、ルームが消えれば残らない（§5 の方針どおり）。
- 表示は `textContent`（§3.8）。せりがテロップに引用する句は `QUOTE_LINE_MAX` で切り詰め済み。
- 誰が文字起こし ON かをルーム内に表示するかは未決（§9）。

## 8. テスト

- `server/tests/bot_test.ts`（せり・ぐっちーの声対応、7件追加）
  - 声の句もチャットに流す／声用の文面を使う
  - 声の字余り・字足らずは拾わない
  - クールダウン中は見送る・見送りで延長しない・チャットの句とは別枠
  - せり OFF なら声からも拾わない
  - 声で会話が続く部屋を沈黙と判定しない／声も止まれば従来どおり話題を投げる
- `server/tests/voice_client_test.ts`（voice.js を偽 window に載せて 13 件）
  - 既定 OFF・確定文のみ送信・短文よけ・重複よけ・分割・レート制限
  - 権限拒否で OFF・自動再開・OFF 後は送らない・非対応ブラウザ・キック時 OFF
  - **音声合成 API に触れていないこと**（§3.10 の回帰よけ）
- 手動確認は `docs/testing/vc-manual.md` に追記する（実機で2人以上・要 HTTPS）。

## 9. 未決・宿題

- **`VoiceLine` 型の追加についてチーム合意**（§4.3）。これが取れるまで §5 は実装に入れない
- 誰が文字起こし ON かをルーム内に見せるか（見せるなら `PlayerPublic` に1フィールド必要 → 要合意）
- **VC 参加状態の厳密な追跡**（§5.3）。`isVcEligible` は「枠を持っているか」までしか見られないので、
  枠内にいて VC 未参加の人による `voice` 偽装は防げない。厳密化は §3.6 の設計変更になるため別課題
- `SERI_VOICE_COOLDOWN_MS = 90_000` は**暫定値**。実際の呑み会で誤検出の頻度を見て詰める
- kuromoji プロバイダ導入後、喋り言葉での誤検出率を測り直す（かなプロバイダは tolerance 0 固定）
- 仕様書 §3.10 の改訂要請: 沈黙検知の対象に「VC の文字起こし」を加える
