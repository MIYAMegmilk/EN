# 場回し bot ― 表示と川柳判定（設計書）

- 版: v1.0
- 日付: 2026-08-24
- 担当: ひろし（bot）
- 前提: 詳細仕様書 [overall.md](../spec/overall.md) v0.5 §3.10、全体設計書 [overall.md](overall.md) v1.0
- 関連: 通話の文字起こしは [bot-voice.md](bot-voice.md)
- 状態: **`public/room/bot.js` と kuromoji 配線は実装済み。画面への差し込みはちいかわへ依頼中**（§4）

---

## 1. 何を解いたか

bot のロジック（`server/bot.ts`）とルーム配線（`server/rooms.ts`）は先に入っていたが、
**受け取る側がいなかった**ため、実際の画面では bot が半分しか働いていなかった。

| 症状 | 原因 |
|---|---|
| せりが川柳を拾ってもテロップが出ない | `ChatMessage.card` を描画する実装がどこにもない |
| ゲーム提案を押せない | 同上（カードがただの文字列として流れる） |
| **終了アンケートに投票できない** | `endPollVote` を送る UI が存在しない |
| bot の ON/OFF ができない | `setBot` を送る UI が存在しない |
| **漢字混じりの川柳を拾えない** | kuromoji プロバイダが未配線（かなのみ） |

前4つを `public/room/bot.js`（新規）で、最後の1つを kuromoji の配線で解いた。

---

## 2. `public/room/bot.js`（実装済み）

`chat.js` / `vc.js` / `voice.js` と同じ classic script。`Bot` だけをグローバルに公開する。
DOM は空のコンテナに自前で組み立てるので、呼び出し側が用意するのは `<div id="bot"></div>` 1つでよい。

```
#bot
 ├ .bot-toggles  … しゅんぴ / せり / ぐっちー の ON/OFF
 ├ .bot-stage    … 直近のテロップ（川柳 / ゲーム提案 / アンケート結果）
 └ .bot-poll     … 集計中の終了アンケート（投票ボタン + 残り時間）
```

### 責務の線引き

- **bot の発話そのものはチャット欄に出る**（`chat.js` の仕事）。bot.js が持つのは演出面だけ
- **読み上げ（音声合成）はしない**。bot の発話はチャットのみ（§3.10 / 全体設計書 §3）。
  回帰よけに「`speechSynthesis` に触れていないこと」のテストを置いてある

### API

```js
Bot.init({ send, container, onError });
Bot.setSelfId(playerId);      // hostChanged の判定に使う
Bot.handleServerMessage(msg); // roomState / chat / botState / botPollClosed / hostChanged / kicked
Bot.reset();                  // 退室時
Bot.getState();               // デバッグ・テスト用
```

### 決めごとと理由

| 決めごと | 理由 |
|---|---|
| トグルは**ホスト以外にも見せる**（操作だけ不可） | 「いま誰が動いているか」は全員が知りたい。隠すと bot が黙った理由が分からない |
| ON/OFF は**楽観更新しない**（`botState` を待つ） | サーバーが正。押した直後に見た目だけ変わると、拒否されたとき食い違う |
| アンケートは**投票し直せる** | サーバーは最後の票を採る。締切までは気が変わってよい |
| `botPollClosed` は **pollId を照合**してから閉じる | 遅れて届いた前回の結果で、次のアンケートを消さないため |
| 再接続時は `snapshot.botPoll` と履歴の直近カード1枚を**復元** | 途中入室・再接続でも投票に参加できる（§3.2） |
| カウントダウンは締切で**必ず止める** | タイマーを残さない。締めるのはサーバーで、こちらは表示を止めるだけ |
| 描画は `textContent` のみ | §3.8。句・あだ名・ゲーム名はすべてユーザー由来 |

## 3. kuromoji の配線（実装済み）

かなプロバイダだけでは**漢字が1文字でも混ざると拾えない**。実測:

```
○ ふるいけやかわずとびこむみずのおと   → 検出できる
✕ 古池や蛙飛び込む水の音               → 検出できない
```

音声認識の出力は漢字かな混じりで返ってくるので、[bot-voice.md](bot-voice.md) の文字起こしは
これがないと実質発火しない。

`server/senryu.ts` に `createSenryuDetector()` を足し、`server/main.ts` で `RoomManager` に渡した。

**「使うまで読まない、読めたら差し替える」**方式にしている。

- 最初の判定要求で辞書の読み込みを**開始する**（プロセスで1回だけ）
- 読み終わるまでは かな のみで判定する（`bot.reduce` は純粋関数で `await` できないため待たせない）
- 読み終わったら `[kuromoji, kana]` で判定する（kuromoji はかなだけの文で解析が破綻するので、
  うしろに kana を残して互いの穴を埋める。`detectSenryuAny` のコメント参照）
- 読み込めない環境（辞書なし・npm 不通）では かな のまま動き続ける

一度も発言のないルームや、川柳判定を使わないテストでは辞書を読まない。

### メモリの申し送り

実測（Deno 2.9 / Windows）: **初期化 560ms・RSS 404MB・辞書 17MB**。
デプロイ先は Xserver VPS 4GB（§6）なので収まるが、**プロセス常駐で +385MB は小さくない**。
§6 のメモリ見積りとあわせて、チームで一度目を通してほしい。
必要なら `createSenryuDetector()` を呼ばない（＝ `RoomManager` に渡さない）だけで
従来のかなのみに戻せる。

## 4. 画面への差し込み依頼（→ ちいかわ）

`public/index.html` と `public/app.js` は担当外なので触っていない。**この2箇所が入るまで bot.js は動かない。**

```diff
   <script src="./room/vc.js"></script>
   <script src="./room/chat.js"></script>
+  <script src="./room/bot.js"></script>
   <script src="./app.js"></script>
```

卓上（`#vc`）とチャット（`#chat`）のあいだあたりに空の器を1つ。

```diff
+  <section id="bot" class="card block hidden"></section>
```

`app.js` には3行。

```js
Bot.init({ send, container: $("bot"), onError: (m) => { $("error").textContent = m; } });

// 受信ループに
Bot.handleServerMessage(msg);
// roomState の分岐に（chat.js と同じ場所）
Bot.setSelfId(msg.snapshot.youId);
// 退室・キック処理に
Bot.reset();
// 表示切替（chat と同じ条件）
$("bot").classList.toggle("hidden", snapshot === null);
```

CSS クラスは `bot-toggles` / `bot-stage` / `bot-poll` / `bot-card` / `bot-senryu-*` /
`bot-poll-*` / `bot-badge` を使っている。`public/assets/en.css` への追加もお願いしたい
（未定義でも動作はするが、川柳テロップは縦に積んだほうが映える）。

**前提（解決済み）**: `main.ts` の `C2S_TYPES` に `setBot` / `endPollVote` が入っておらず、
bot.js が正しく送っても `asC2S` で落ちる状態だったが、**#10 で修正済み**。
`types.ts` の `C2S` 型と `C2S_TYPES` を双方向で照合するテストも入ったので、
今後この種の取りこぼしは検出される。

## 5. テスト

- `server/tests/bot_client_test.ts`（新規 15 件）… 偽 DOM に bot.js を載せて検証
  - トグル3体・ホストのみ操作可・楽観更新しない
  - 川柳テロップ（三句・モーラ数・詠み手）・字余り字足らずのラベル出し分け
  - **あだ名を textContent で入れる／`innerHTML` を使わない**（§3.8）
  - ゲーム提案から `selectGame`・アンケートへの投票と投票し直し
  - `botPollClosed` で結果表示とタイマー解放・別 pollId の無視
  - 再接続でアンケートとカードが戻る・キックで状態を捨てる
  - **音声合成 API に触れていないこと**（§3.10 の回帰よけ）
- `server/tests/senryu_test.ts` +3 … `createSenryuDetector` の遅延ロード・漢字混じり検出

`deno test -A` → **323 passed / 0 failed**。

## 6. 未決・宿題

- **全体設計書 §2 の担当表の記述が誤っている**: 「`bot.js` … しゅんぴボットの表示・**音声**」とあるが、
  §3 の「bot の発話はチャットのみ。音声合成・読み上げは実装しない」が正。
  担当表から「音声」を削ってほしい（担当外ファイルなので未修正）
- 全体設計書 §2 のファイル一覧に `public/room/voice.js` が載っていない（同上）
- 川柳テロップの演出（フェードイン・一定時間で消す）は未実装。いまは次のカードが来るまで出しっぱなし
- kuromoji の常駐メモリについてチームの合意（§3）
