# 宴 -EN- 全体設計書

- 版: v1.1
- 日付: 2026-08-28
- 前提: 詳細仕様書 [overall.md](../spec/overall.md) / 企画書 [concept.md](../spec/concept.md)
- 型の正本は `server/types.ts`（仕様書 §4.3）。本書は「どう作るか・誰が作るか」を定める

### v1.0 → v1.1 の変更点

- §1: 実在する7ページ構成に更新。`room.html` は作られず、部屋（ロビー→ゲーム→結果）は `index.html` 内のセクション切替として実装された。`studio.html` は未実装
- §2: ディレクトリ構成を実ファイルに合わせて全面更新（`create-room.html` / `rooms.js` / `room-handoff.js` / `server/games/` / `public/room/games/` / `public/vendor/three/` など）
- §4: ロードマップ1〜6はすべて消化済み。残作業の一覧に置き換え
- §6: テスト件数を実測値（1365件）に更新
- §3（担当表）は変更していない

## 1. ページ構成

ルームに入ってからページ遷移すると WebSocket / VC が切断されるため、**ルーム関連（ロビー→ゲーム→結果）は1ページ内のフェーズ切替**で実装する。v1.0 ではこれを `room.html` として計画していたが、実装では **`index.html` がホームと部屋の両方を内包する単一ページ**になった（`room.html` は存在しない）。

実在するページは次の7枚。

| ページ | 内容 |
|---|---|
| `index.html` | **ホームと部屋を1枚で持つ単一ページ。** ホーム: 「いますぐ飲む」+ マッチング待機（`#queue-waiting`）/ 公開ルーム一覧（`rooms.js`・10秒ポーリング）/ 参加コード・合言葉入力 / ログイン状態表示。部屋: 参加者一覧・ノック承認・キック / チャット / VC・カメラ・画面共有 / ゲームリスト・進行・結果。セクション `#entry`（ホーム）→ `#room`（ロビー）→ `#phase`（ゲーム進行）→ `#result`（結果）を切り替える。招待URL `/r/{code}` の着地先もここ |
| `login.html` | アカウント登録 / ログイン / ゲスト入店 |
| `entrance.html`（入り口選択） | ログイン成功・ゲスト入店直後に出る中間画面。卓の探し方（`index.html` の一覧 / `corridor.html` の3D廊下）と `create-room.html` への導線。あだ名・趣味タグの編集は帯状UIではなく `profile.html`（名札）に一本化された（`entrance.js` 冒頭コメント参照） |
| `corridor.html`（廊下ビュー） | 3Dで通路を歩いて卓を探す代替導線。**入店機能は実装済み**: 扉を選ぶと `room-handoff.js`（sessionStorage）経由で `index.html` に遷移し自動入店する |
| `create-room.html` | 卓を建てる（要ログイン）。入室モード（オープン / 承認制 / 合言葉）・タグ・サムネを選び、`room-handoff.js` 経由で `index.html` が WS の createRoom を送る |
| `profile.html`（名札） | あだ名・趣味タグの登録・編集。ログイン中はアカウント（`PUT /api/profile`）、ゲストは sessionStorage（`guest-profile.js`）に保存 |
| `debug.html` | 開発チーム向けの内部診断ページ（サーバーの出来事・状況の閲覧。`server/debug.ts` が対になる） |
| `studio.html` | 【未実装】自作ゲームの作成・編集・共有コード（担当は後決め。ゲーム=全員の一部）。サーバー側も `gamedef.ts` の KV 永続化関数はあるが API 未配線 |

## 2. ディレクトリ構成と担当

```
PROJECT/
├── docs/
│   ├── spec/              … 仕様書（overall.md / concept.md）
│   ├── design/            … 設計書（本書 / games-unified.md / vc-screenshare.md /
│   │                        bot.md / bot-voice.md / game-sandbox.md / ui-gap.md / board.md）
│   └── testing/           … 手動テスト手順書（vc-manual.md / chat-manual.md / vc-quality-test.html）
├── server/                … サーバー（Deno + TypeScript）      【ちいかわ】
│   ├── types.ts           … 型の正本（変更はチーム合意必須）
│   ├── main.ts            … HTTP/WS 入口・静的配信・認証まわりの配線・
│   │                        /api/ice（TURN 資格情報の組み立てと配布）
│   ├── rooms.ts           … ルーム・入室モード・ランダムマッチ・キック・rtcSignal 中継
│   ├── engine.ts          … ゲームエンジン（フェーズ状態機械）
│   ├── auth.ts            … 認証 API（§3.0 / §4.0）
│   ├── validation.ts      … 文字列検証ヘルパー
│   ├── gamedef.ts         … ゲーム定義の検証・KV 永続化（スタジオ用。API 未配線）
│   ├── official_games.ts  … 公式の宣言的ゲーム4種（大喜利・以心伝心・雑学クイズ・格付けクイズ）
│   ├── games/             … ゲームカタログの正本（index.ts）と専用サーバーモジュール
│   │                        （chicken / draw / hayaoshi / wordwolf・prompt.ts=宣言的ゲームの進行・
│   │                         client.ts / module.ts / _template.ts）
│   ├── bot.ts             … しゅんぴボット（サーバー側ロジック）  【ひろし】
│   ├── bot_templates.ts   … bot の定型文データ                    【ひろし】
│   ├── senryu.ts          … 川柳（5-7-5）検出                     【ひろし】
│   ├── room_tags.ts / hobby_tags.ts … プリセットタグのデータ
│   ├── debug.ts           … 開発チーム向け内部診断
│   └── tests/             … Deno.test（games/ 配下含め *_test.ts 58本）
└── public/                … フロント（素の HTML/CSS/JS）
    ├── index.html         … ホーム+部屋の単一ページ（§1）
    ├── app.js             … index.html の配線（WS 接続・フェーズ切替・状態管理・VC 結線）
    ├── login.html / login.js       … ログイン                     【みつお】
    ├── entrance.html / entrance.js … 入り口選択                   【みつお】
    ├── corridor.html / corridor.js … 廊下ビュー（3D）の入口       【みつお】
    ├── create-room.html / create-room.js … 卓を建てる
    ├── profile.html / profile.js   … 名札（プロフィール）         【みつお】
    ├── debug.html / debug.js       … デバッグ画面
    ├── rooms.js           … 公開ルーム一覧の描画（10秒ポーリング）
    ├── room-handoff.js    … 別ページ → index.html への入店・卓建ての橋渡し（sessionStorage）
    ├── guest-profile.js   … ゲストの一時プロフィール（sessionStorage）
    ├── noren-scene.js     … ログイン成功演出「暖簾をくぐる」（three.js）
    ├── room/
    │   ├── chat.js        … チャットUI                            【ちいかわ】
    │   ├── vc.js          … VC・カメラ・画面共有（WebRTC）        【ちいかわ】
    │   ├── voice.js       … 通話の文字起こし（VC → テキスト）     【ひろし】
    │   ├── bot.js         … しゅんぴボットの表示                  【ひろし】
    │   └── games/         … クライアント側ゲーム実装9本
    │                        （chicken / draw / emoawase / hayaoshi / mogura / reflex /
    │                         wordwolf・共通ヘルパー _client.js・雛形 _template.js）
    ├── vendor/three/      … three.js 一式の同梱（CDN を使わない方針のため自前配信）
    └── assets/            … プリセット画像・効果音・共通CSS
        └── 3d/            … GLB・パノラマ画像と廊下ビュー実装（corridor-view.js / corridor-ui.js）
```

- `room.html` / `studio.html` は存在しない（§1）。`public/room/` は JS のみのディレクトリで HTML は無い
- ゲームは「宣言的（GameDefinition・`official_games.ts`）4種 + 専用サーバーモジュール4種 + クライアント専用3種」の計11本。一覧の正本は `server/games/index.ts`（設計は [games-unified.md](games-unified.md)）

## 3. 担当表（やることリスト対応）

| 担当 | 領域 | 主な仕様 |
|---|---|---|
| **みつお** | ログインページ / 部屋リストページ（タイトル・サムネ・タグ）/ プロフィールページ（フロントのみ。API はちいかわが提供） | §2, §3.0(UI), §3.11(UI) |
| **ちいかわ** | **サーバーサイド全体**（認証・ルーム・マッチング・チャット・VCシグナリング・API）+ 部屋ページ（VC・ビデオ / ゲームリスト・選択 / チャット） | §3.0〜3.9, §4, §5 |
| **ひろし** | しゅんぴボット（サーバー側ロジック + 表示。川柳・終了切り出し・ゲーム提案・ON/OFF） | §3.10（詳細はひろしが拡張） |
| **全員** | ゲーム（お題・GameDefinition の中身づくり、テストプレイ） | §3.4, §3.5 |

- 他メンバーの担当ファイルには触らない。またがる変更は PR で相談する
- フロント⇔サーバーの契約は `server/types.ts` と仕様書 §4。**API・型を変えたいときはチーム合意**（ちいかわ経由で types.ts を更新）
- **bot の発話はチャットのみ**（§3.10）。音声合成・読み上げは実装しない（VC 中に bot の声が被るのを避けるため）

## 4. 実装順序（ちいかわ視点のロードマップ)

v1.0 で立てた 1〜6（チャット → VC 疎通 → 入室モード+ランダムマッチ → 認証+プロフィール API → VC 本実装+カメラ → タグ・サムネ配信+公開ルーム一覧 API）は**すべて消化済み**。さらに画面共有・品質劣化時の映像自動停止・TURN 資格情報の配布（`/api/ice`）・キック・ゲーム11本・bot（川柳・文字起こし）・廊下ビューからの入店まで実装が進んだ。

残っている主な作業:

1. **ゲームスタジオ（§3.5）** — 【未実装】UI（`studio.html`）・API とも手つかず。`server/gamedef.ts` の検証・KV 永続化だけが先行してある
2. **タグ優先マッチ** — 【未実装】ランダムマッチの待機列（`server/rooms.ts`）は並んだ順のみで、趣味タグを考慮しない
3. **ルームの24時間自動削除（§3.1）** — 【未実装】`server/rooms.ts` に TODO として残っている
4. **CI** — 【未整備】`.github/` が無く、`deno task test` 等の自動実行は手元のみ
5. **importGame（共有コードの取り込み）** — 【未実装】スタジオと対になる機能

## 5. 部屋サムネイル（v0.5 追補）

- 部屋リストに表示するサムネは**運営が用意したプリセット画像から部屋作成時に選ぶ**（ユーザーのアップロードは受け付けない。不適切画像の混入を構造的に防ぐ）
- 画像は `public/assets/` に置き、サーバーは画像IDのみ扱う（タグと同じ方式）

## 6. テスト・品質

- サーバー・フロントロジック: `deno task test`（2026-08-28 実測: **1365 件 passed / 0 failed**。`server/tests/` 配下の `*_test.ts` 58本 + `tools/` の 3D 実測ハーネス2本）。機能追加のたびにユニット+結合を足す
- フロント: 簡易 JS アサーション + 主要ブラウザ目視（iOS Safari 必須）。WebRTC 本体・実機確認は手動（[vc-manual.md](../testing/vc-manual.md) / [chat-manual.md](../testing/chat-manual.md)）
- PR 前に `deno task check` / `deno task lint` / `deno task fmt` を通す
