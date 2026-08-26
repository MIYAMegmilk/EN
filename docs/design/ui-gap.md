# UI と実装ロジックの差分

> **2026-08-26 更新**: 合言葉・承認制（ノック）・ランダムマッチ（いますぐ飲む）・部屋タグを
> 実装したため、以下は解消済み。以下の表のうち該当する行は古い記述のまま残っているものがあるので、
> このメモを優先すること。
>
> - `GET /api/rooms`（`server/main.ts`）… 稼働中の公開ルームを返す。認証不要・10秒ポーリング
> - 公開ルームの作成（`rooms.ts` `handleCreateRoom`）… `visibility: "public"` + ルーム名必須
> - 公開ルームへのオープン入室（`doJoin`）… コードだけで入室できる
> - **承認制（ノック）** … `handleKnock` / `handleApproveKnock` / `handleRejectKnock`（`server/rooms.ts`）。
>   フロントは `public/app.js` の `knockRoom` / `renderKnocks` と `public/rooms.js` の
>   「ノックする」ボタン（`room.entryMode === "knock"` で出し分け）。テストは
>   `server/tests/rooms_test.ts` の「ノック: …」多数
> - **合言葉** … `validatePassphrase` / `passphrases` マップ（`server/rooms.ts`）。フロントは
>   `public/index.html` の `#passphrase` 欄と `public/create-room.js` の入力欄（招待制のみ表示）。
>   テストは `rooms_test.ts` の「合言葉: …」多数
> - **ランダムマッチ（いますぐ飲む）** … `joinQueue` / `leaveQueue` と待機列の成立処理
>   （`server/rooms.ts`）。フロントは `public/index.html` の `#queue-join` ボタンと
>   `public/app.js` の `joinQueue` / `renderQueue`。テストは `rooms_test.ts` の「相席: …」多数
> - **部屋タグ** … `ROOM_TAGS` / `GET /api/room-tags`（`server/room_tags.ts` / `main.ts`）。
>   フロントは `public/create-room.js`（作成時の選択）と `public/rooms.js`（一覧のタグ表示）
> - `PublicRoomSummary`（`server/types.ts`）… 一覧1行の型。`entryMode` / `tags` / `createdAt` を含む
> - ホーム（`public/index.html` + `public/rooms.js`）… お座敷一覧の描画と10秒ポーリング。
>   「◯時から」（`createdAt`）も一覧に表示済み
>
> 未実装のまま残っているのは、趣味タグ以外のプロフィール周り（統計・卓歴・自由記述）・
> サムネイル画像・ゲームUI本体など、下の表の該当行のとおり。

`public/mock/` の4画面を、**いまサーバーに実装されているロジック**（`server/types.ts` /
`rooms.ts` / `auth.ts` / `bot.ts` / `main.ts`、`public/room/vc.js`）と突き合わせた結果。

凡例:

- **✅ ある** … そのまま繋げばモックどおり動く
- **⚠️ 型はあるが未配線** … サーバーにデータはあるがモックが使っていない／表示が足りない
- **🔴 ロジックが無い** … 実装すること自体がこれから。API・型の追加が必要（＝チーム合意が要る）

---

## 0. 全画面に効く前提

| 事項 | 実装の状態 |
|---|---|
| **ルーム状態はメモリのみ** | `Room` は KV に置かない（`types.ts` §5 コメント / 設計書 §5）。サーバー再起動で全ルーム消滅。24時間で自動削除 |
| **永続化されるのは4つだけ** | アカウント・認証セッション・ゲーム定義・共有コードマップ。**履歴・統計は一切残らない** |
| **`/` の振り分け** | `main.ts` … ログイン済み → `index.html`、未ログイン → `login.html` |
| **HTTP API** | 認証系・`/api/ice`・`/api/rooms`・`/api/room-tags`・`/api/rooms/:code`（PATCH）・`/api/tags`・`/api/profile` は実装済み。`main.ts` には `// TODO(チーム分担): §4.0 HTTP API（/api/rooms 以外の未実装分）` が残っており、`/api/games/*` などはまだ無い |

---

## 1. ログイン画面（`login.html`）

| モックの要素 | 実装の状態 | 詳細 |
|---|---|---|
| ユーザーID + パスワード | ✅ ある | `POST /api/auth/register` / `login`。ID は半角英数4〜20、パスワード8〜64 |
| のれんをくぐる | ✅ ある | 成功で Cookie 発行（HttpOnly / SameSite=Lax） |
| ふらっと（ゲスト） | ✅ ある | `join` はゲスト可。ただしルーム作成は要ログイン |
| **次回も暖簾をくぐったままにする** | 🔴 ロジックが無い | セッションは**常に30日固定**。「保持しない」選択肢がサーバーに無い。チェックボックスは飾りになる |
| **合言葉で入る** | ✅ ある | `join` は合言葉（`msg.passphrase`）でも入室できる（`server/rooms.ts` `validatePassphrase` / `passphraseKey`）。招待制の卓にのみ付けられ、4〜20文字・全ルーム横断で一意。ホーム（`index.html` `#passphrase`）に入力欄がある |
| 再発行はできません | ✅ 仕様どおり | §3.0 でリセットは作らない |
| 登録画面への導線 | ⚠️ モックに無い | `register` は実装済みだが、モックにタブ／リンクが無い |

---

## 2. お座敷一覧（`rooms.html`）

**このモックは初期のダミー一覧を元にした比較表。** 実画面は `public/index.html` +
`public/rooms.js` に統合されており、すでに `GET /api/rooms` に繋がって実データを
10秒ポーリングで描画している（`public/mock/` 自体は現存しない）。以下はモックの要素との突き合わせ。

| モックの要素 | 実装の状態 | 詳細 |
|---|---|---|
| **公開ルーム一覧そのもの** | ✅ ある | `GET /api/rooms`（`main.ts`）が `manager.listPublicRooms()` を返す。認証不要・`index.html` + `rooms.js` が10秒ポーリングで描画する |
| TAKU-01 などの卓コード | ⚠️ 表記が違う | 実際は `ROOM_CODE_LENGTH = 6` の**数字6桁**。`TAKU-04` 形式ではない |
| **3 / 8 名** の定員 | ⚠️ 値が違う | 定員は `ROOM_CAPACITY = 10` 固定。ルームごとに 6/8/10 と変える仕組みは無い |
| 顔（あだ名の頭文字アイコン） | ⚠️ 型はあるが未配線 | `PlayerPublic.nickname` から頭1文字を取れば作れる。アイコン画像の型は無い |
| **タグ（初めての方歓迎／静かめ …）** | ✅ ある | `Room` にプリセットタグ（`server/room_tags.ts` の `ROOM_TAGS`）が付けられる。`GET /api/room-tags` で一覧を取得し、`create-room.js` の選択欄・`rooms.js` の一覧表示（`.room-tags`）まで配線済み |
| **絞り込みピル** | 🔴 ロジックが無い | タグ自体はあるが、一覧をタグで絞り込むUI・ロジックはまだ無い |
| **19:40 から** | ✅ ある | `PublicRoomSummary.createdAt` が一覧APIに含まれ、`rooms.js` の `formatTime()` が「◯時から」として表示している |
| **空きあり／満席ちかし** | ✅ ある | `PublicRoomSummary.playerCount` / `capacity` から `rooms.js` が導出して表示している |
| **承認制／ノックする** | ✅ ある | `handleKnock` / `handleApproveKnock` / `handleRejectKnock`（`server/rooms.ts`）。`RoomEntryMode = "open" \| "knock"` が型にあり、一覧は `entryMode` に応じて「入店」／「ノックする」を出し分ける（`rooms.js`）。承認待ちの一覧はホストにのみ `app.js` の `renderKnocks` が表示する |
| サムネイル画像 | 🔴 ロジックが無い | 設計書 §5 のプリセット画像。型もアセットも未着手（モックにも入れていない） |
| 卓を立てる | ✅ ある | `createRoom`（要ログイン）。ただし公開ルーム名は `ROOM_NAME_MAX = 20` |
| **「いますぐ飲む」（ランダムマッチ）** | ✅ ある | `C2S: joinQueue` / `leaveQueue`、成立処理は `server/rooms.ts`。`index.html` の `#queue-join` ボタンと `app.js` の `joinQueue` / `renderQueue` が導線になっている |

---

## 3. 手帳（`profile.html`）

**軽量プロフィール（あだ名・趣味タグ）は実装済み。** それ以外の統計・卓歴・自由記述は
実データが無いまま。`GET /api/me` は `{ userId, nickname?, tags? }` を返す（`server/auth.ts` `me()`）。

| モックの要素 | 実装の状態 | 詳細 |
|---|---|---|
| ユーザーID（@takashi） | ✅ ある | `/api/me` の `userId` |
| あだ名（たかし） | ✅ ある | `PUT /api/profile`（`server/auth.ts` `saveProfile`）でアカウントに保存でき、`/api/me` が `nickname` を返す。`public/profile.js` / `public/entrance.js` から編集できる |
| **48 / 312 / 27 / 9 の統計** | 🔴 ロジックが無い | 集計対象が残らない（ルームはメモリのみ・24時間で消滅）。出すなら KV への履歴設計から |
| **通っている卓** | 🔴 同上 | 過去に入った卓を記録する仕組みが無い |
| **呑んだ記録** | 🔴 同上 | 滞在時間・杯数・乾杯回数を数えるロジックがどこにも無い |
| **ひとこと／住まい／今夜の一杯** | 🔴 仕様と衝突 | §3.7「他者に見えるのはあだ名とプリセット趣味タグのみ。自由記述プロフィールは作らない」。実装するなら仕様変更の合意が要る |
| 呑み方タグ | ✅ ある | プリセット趣味タグ（§3.11）は `GET /api/tags` で一覧を取得でき、`PUT /api/profile` の `tags` で保存する。`public/profile.js` / `public/entrance.js` がチェックボックスとして配線済み |
| **卓に入るときの決めごと（トグル4つ）** | 🔴 ロジックが無い | 保存先が無い。うち「自動でカメラを入れる」は **§3.6 の「カメラは全ルーム初期OFF」と正面から衝突**する。安全設計の根幹なので、実装するなら要議論 |
| いま呑んでいます | 🔴 ロジックが無い | アカウントの在室状態を横断で持っていない |
| 卓歴 1年4ヶ月 | ⚠️ 導出は可能 | `User.createdAt` はある。ただし `/api/me` が返していない |

---

## 4. 卓の中（`room.html`）

一番よく繋がる画面ですが、**ゲーム機能が丸ごと抜けています。**

### 繋がるもの

| モックの要素 | 実装の状態 | 詳細 |
|---|---|---|
| 参加者タイル | ✅ ある | `RoomSnapshot.players`（`PlayerPublic`） |
| カメラ映像 | ✅ ある | `vc.js` の `toggleCamera()`。初期 OFF も実装済み（`getUserMedia` は最初 `video: false`） |
| ミュート | ✅ ある | `vc.js` の `toggleMute()` |
| やりとり（チャット） | ✅ ある | `C2S: chat` / `S2C: chat`。200文字・5件/10秒 |
| 卓を立てた人 | ✅ ある | `PlayerPublic.isHost` |
| お先に失礼 | ✅ ある | `C2S: leave` |
| 呑み手 6 | ⚠️ 意味が違う | `VC_CAPACITY = 6` は**VC枠**。定員は10人なので、**7人目以降は映像タイルに出せない参加者**になる。モックの6枠固定ではこの人たちが表示から漏れる |

### 繋がらないもの

| モックの要素 | 実装の状態 | 詳細 |
|---|---|---|
| **ゲーム UI が丸ごと無い** | 🔴 モック側の欠落 | `engine.ts` は8フェーズ（lobby / intro / prompt / input / reveal / judge / roundResult / finalResult）を実装済み。**ゲーム選択・開始・お題表示・回答入力・投票・順位表・スキップ**の置き場がモックに一つも無い。`PhaseView` はフェーズごとに形が違うので、画面設計としては一番重い部分 |
| **せりの川柳テロップ** | 🔴 モック側の欠落 | `BotCard.c = "senryu"`（上句・中句・下句＋モーラ数＋`exact`）を出す前提の型がすでにある。ひろし担当分の見せ場がモックに無い |
| **ぐっちーの終了アンケート** | 🔴 モック側の欠落 | `BotCard.c = "endPoll"` と `C2S: endPollVote` / `S2C: botPollClosed` が実装済み。**賛成／反対を押すUIが要る** |
| **bot の ON/OFF** | 🔴 モック側の欠落 | `C2S: setBot`（ホストのみ、`botId` 省略で3体まとめて）が実装済み。切り替えUIが無い |
| **bot の名前と役割が違う** | 🔴 モックの誤り | モックは「しゅんぴ＋場回しバッジ」だが、`bot_templates.ts` では **しゅんぴ＝あだ名をつける / せり＝川柳を見つける / ぐっちー＝場を回す**。話題振りは**ぐっちー**。※このファイルの指摘どおり `room.html` を修正済み |
| 話し中 | 🔴 ロジックが無い | 発話検知（audio level）はサーバーにもクライアントにも無い |
| **他人の 声入／声切** | 🔴 ロジックが無い | 自分のミュート状態しか分からない。他者のマイク状態を配信する `S2C` が無い |
| 席をはずしています | ⚠️ 近いものはある | `PlayerPublic.connected` が false（＝切断中、60秒で退室扱い）。「離席」という中間状態は無い |
| **お通し配布中 / お通し待ち** | 🔴 ロジックが無い | 対応する概念がサーバーに無い。フェーズ名を言い換えるなら対応表が要る |
| **乾杯 3 回** | 🔴 ロジックが無い | 乾杯を数える仕組みが無い |
| 乾杯／もう一杯／お愛想 チップ | ⚠️ 代用は可能 | 定型文専用のメッセージは無いが、`chat` の本文として送れば成立する |
| 席替え | 🔴 ロジックが無い | 対応する `C2S` が無い |
| お品書き タブ | ⚠️ 意味が未定 | ゲーム一覧（`RoomSnapshot.availableGames`）を指すなら繋がる。メニュー的な別物なら未実装 |
| 通信 良好 | ⚠️ 導出は可能 | `vc.js` が各ピアの `connectionState` を持っている。集約して1つの表示にする関数が要る |
| キック（ホスト） | ✅ ある | `handleKick`（`server/rooms.ts`、ホストのみ）。`public/app.js` に確認つきの `confirmKick` とキックボタンが実装済み |
| 通報リンク | 🔴 モック側の欠落 | §3.7 で「ルーム内フッターに常設」と決めている外部フォームへのリンクが無い |
| TAKU-04 ／ 01:12:40 | ⚠️ 一部だけある | コードは6桁数字。経過時間は `Room.createdAt` があるが `RoomSnapshot` に含まれない |

### モックに入れ忘れている、実装済みの機能

| 機能 | 実装 |
|---|---|
| **あだ名の自動命名** | `C2S: join` の `nickname` は**省略可**で、省略するとしゅんぴが二つ名を付ける（`bot.ts` の `pickNickname`）。「名前を決めずに入る」導線がモックに無い |
| 再接続 | `RoomSnapshot.session` を保存して `join` に添えると60秒以内なら復帰する。「接続が切れました」の表示が無い |
| ホスト委譲 | `S2C: hostChanged`。60秒でホストが移る。移った旨の表示が無い |
| ゲームのインポート | `importGame` は未実装（`INVALID_INPUT`）だが、`availableGames` に公式3種は入っている |

---

## まとめ: 実装順の目安

1. **モックの直しで済むもの** … ゲームUI（8フェーズ）・川柳テロップ・終了アンケート・bot ON/OFF・通報リンクの置き場を足す。サーバーは既にある（キックはUIも実装済み）
2. **配線すれば動くもの** … 参加者タイル・チャット・VC・カメラ・ホスト表示・通信状態
3. **サーバーの実装が要るもの（型変更なし）** … `importGame`
4. **型の追加＝チーム合意が要るもの** … 他者のマイク状態、サムネイル画像、絞り込みピル（趣味タグ・ルームタグ・合言葉・ランダムマッチ・ノック・あだ名のアカウント保存は実装済み）
5. **仕様変更の議論が要るもの** … 手帳の自由記述（§3.7 と衝突）、カメラ自動ON（§3.6 と衝突）、統計・履歴の永続化（メモリのみの前提と衝突）
