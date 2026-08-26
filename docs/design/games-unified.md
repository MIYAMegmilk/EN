# ゲーム基盤のエンジン統一（設計書）

- 版: v0.1（設計のみ。実装は未着手）
- 日付: 2026-08-26
- 前提: 詳細仕様書 [overall.md](../spec/overall.md) v0.5 §3.2〜§3.5 / §4 / §5 / §7 / §8、
  全体設計書 [overall.md](overall.md) v1.0、
  サンドボックス設計書 [game-sandbox.md](game-sandbox.md) v0.1（**本書により方針を変更する対象**）
- 状態: **オーナー方針の変更を含む**（§0）。本書の PR がその変更と、
  §2 の `server/types.ts` 変更に対するチーム合意の場を兼ねる

**表記規約**: 「**実測**」= 実際に動かして確認した事実、「**想定**」= 仕様・コードからの推論で未検証、
「**【暫定値】**」= 出典の無い数値。game-sandbox.md と同じ書き分けに従う。

---

## 0. 方針変更（オーナー判断）

game-sandbox.md §0 は「宣言的エンジンとサンドボックスの**2基盤を並列に持つ**」ことを
オーナー確定方針としていた。本書はこれを次のとおり**変更**する。

1. **ゲームの実行基盤をサーバー権威のエンジン1本に統一する。**
   §3.2 原則1（サーバーが唯一の状態機械）を、リアルタイム系を含む**全ゲーム**に適用する。
2. **サンドボックス基盤（iframe runner / `public/games/` / `sandboxStart`・`sandboxEnd`・
   `sandboxSignal`）は廃止する**（§6 の移行計画に従い段階的に撤去）。
   既存のサンドボックスゲーム2本（reflex / mogura）はエンジンへ移植する。
3. **ゲームの作り方を1本の規約に固定化する**（§7）。「どちらの基盤で作るか」という
   判断分岐（game-sandbox.md §1.3）そのものを無くす。
4. **スタジオ（§3.5 投稿ゲーム）は従来どおり宣言的データのみ**を受け付ける。
   ユーザー投稿にコード実行の経路は今後も作らない（変更なし）。

### 変更の理由

- **作り方の分散**: ゲームを1本足すのに「エンジン（宣言的データ）か、サンドボックス（JS）か」を
  毎回選ぶ構造になっており、一覧の正本も2つ（`RoomSnapshot.availableGames` と
  `GET /api/sandboxGames`）、追加手順も2つに割れていた。量産（§8 の15本）を前に統一する。
- **品質の天井**: サンドボックスは構造上「秘密を隠せない・チートを防げない・公式スコアに
  算入できない・暴走でタブが固まる」（game-sandbox.md §1.2 / §7）。ワードウルフ等の
  秘密配布型も、順位を競うリアルタイム型も、この上には作れない。
- **サーバー権威に寄せても失うものが小さい**: パーティーゲームに毎フレーム同期は不要で、
  「入力とイベントを送り、サーバーが状態を進め、受信者ごとのビューを配る」既存エンジンの
  構造（`reduce` / `buildPhaseView` / deadline タイマー）で表現できる（§2）。

### 失うもの（正直に書く）

- **隔離の1枚**: サンドボックスは「チーム製コードでも悪意を前提に隔離する」多層防御を
  持っていた（game-sandbox.md §2）。統一後、ゲームのクライアント表示コードは
  アプリのオリジンで直接動く。これは `chat.js` / `vc.js` 等の既存フロントコードと
  同じ信頼水準（リポジトリ入り + PR の人間レビュー）に置くという判断である（§9.2）。
- **プロトタイプで積んだ実測資産**: CSP・opaque origin の16項目実測などは撤去対象に
  紐づく。知見は game-sandbox.md を削除せず**アーカイブとして残す**ことで保存する（§6.4）。

---

## 1. 背景 — 何が分散していたか

| | 宣言的エンジン | サンドボックス |
|---|---|---|
| ゲームの記述 | `GameDefinition`（データ） | JavaScript（`public/games/*.js`） |
| 状態機械 | サーバー（`server/engine.ts`） | クライアント（ホスト役のブラウザ） |
| 一覧の正本 | `Room.availableGames` → `RoomSnapshot.availableGames` | `public/games/manifest.json` → `GET /api/sandboxGames` |
| 開始の経路 | `selectGame` + `startGame` | `sandboxStart` |
| 進行中の排他 | `room.game` | `room.sandbox`（相互排他。`rooms.ts` `handleSelectGame` / `handleSandboxStart`） |
| 公式スコア | 算入する | 算入しない |
| 秘密の保持 | できる（`buildPhaseView` が受信者ごとに絞る） | できない（payload は全員配信） |
| 表現できる型 | 「回答→投票/一致/正解」のみ | リアルタイム・描画 |
| 現状の収録 | 大喜利 / 以心伝心 / 雑学クイズ（`official_games.ts`） | reflex / mogura |

開発ページ（`public/app.js` `listGames()`）はカード一覧こそ `official:<id>` / `sandbox:<id>` に
統合済みだが、開始経路・進行 UI・追加手順は最後まで別物のままである（**実測**: コード確認）。

エンジン側の制約は仕様上のもの（§3.4 / §3.5）:
入力は `text` / `choice` の2種、採点は `vote` / `match` / `correct` の3種、
入力と採点の組は `gamedef.ts` の `ALLOWED_INPUT_BY_SCORING`（vote→text / match→text /
correct→choice）に固定。この枠の外のゲームが1本も作れない。

---

## 2. 統一アーキテクチャ

### 2.1 設計の核 — 既存エンジンの3関数を「ゲームモジュール」介面に一般化する

既存エンジン（`server/engine.ts`）は実質的に次の3関数でできている（**実測**: コード確認）。

- `startGame(definition, players, now, durations)` … 初期状態を作る
- `reduce(state, event)` … 純粋関数でイベントを1件処理し、新しい状態と副作用（`EngineEffect`）を返す
- `buildPhaseView(state, viewerId)` … **受信者ごとの**表示データを作る（§3.2 原則3）

この形をそのまま**モジュール介面**として切り出し、ゲーム1本＝モジュール1実装にする。
既存の宣言的フロー（大喜利・以心伝心・クイズ・スタジオ投稿ゲーム）は
**「prompt モジュール」という1実装**として吸収する（エンジンの中身は変えず、包むだけ）。

```ts
// server/games/module.ts（新規）
/** ゲーム1本のサーバー側実装。engine.ts と同じ純粋関数規約（§3.2 規約2）に従う:
 *  I/O・await 禁止。外部要因はすべて ModuleEvent で受け取り、入力 state は変更しない */
export type GameModule<S = unknown> = {
  /** ゲームID（例 "wordwolf"）。カタログ（§4）の正本 */
  id: string;
  /** 一覧表示用のメタ情報 */
  meta: GameModuleMeta;
  /** 開始。seed は乱数が要るモジュール用（§2.5） */
  init(input: { players: EnginePlayerInput[]; now: number; seed: number }): ModuleResult<S>;
  /** イベントを1件処理する */
  reduce(state: S, event: ModuleEvent): ModuleResult<S>;
  /** 受信者ごとの表示データ。秘密はここで絞る（§2.6） */
  view(state: S, viewerId: string): unknown;
};

export type GameModuleMeta = {
  title: string;        // 20文字以内（gamedef.ts TITLE_MAX に合わせる）
  description: string;  // 100文字以内
  minPlayers: number;   // 1..10。エンジン共通の MIN_PLAYERS=2 に代わりモジュールが宣言する（§10-5）
  maxPlayers: number;   // minPlayers..10
};

export type ModuleEvent =
  /** クライアントからのゲーム内イベント。payload の検証はモジュールの責務（§9.1） */
  | { t: "clientEvent"; playerId: string; payload: unknown; now: number }
  /** schedule 効果（下記）で予約した時刻に達した */
  | { t: "timeout"; now: number }
  /** 参加者の増減・再接続・キック・ホスト操作。EngineEvent と同じ語彙 */
  | { t: "playerJoined"; playerId: string; nickname: string; now: number }
  | { t: "playerLeft"; playerId: string; now: number }
  | { t: "playerRejoined"; playerId: string; now: number }
  | { t: "playerKicked"; playerId: string; now: number }
  | { t: "skipPhase"; now: number }   // host only（ルーム層が検証してから流す）
  | { t: "endGame"; now: number };    // host only

export type ModuleEffect =
  /** 全接続へ view を配り直す（受信者ごとに view() を呼ぶ） */
  | { t: "viewChanged" }
  /** 次に timeout を起こしてほしい時刻。null で解除。既存 deadline 機構の一般化（§2.4） */
  | { t: "schedule"; at: number | null }
  /** 公式スコアへの加算（ゲーム終了時に1回）。Player.score への反映はルーム層が行う */
  | { t: "score"; totals: ScoreEntry[] }
  | { t: "ended"; reason: "completed" | "tooFewPlayers" | "hostEnded" };

export type ModuleResult<S> = {
  state: S;
  changed: boolean;
  error?: ErrorCode;
  message?: string;
  effects: ModuleEffect[];
};
```

- **prompt モジュール**（`server/games/prompt.ts`）は `GameDefinition` を state に抱え、
  `clientEvent` の payload を既存の `submitInput` / `submitVote` に写像して
  `engine.reduce` を呼ぶ薄いアダプタにする。`engine.ts` 本体・既存テストは変えない。
- ルーム層（`rooms.ts`）の `applyEngineEvent` / `applyEffects` / `syncPhaseTimer` は
  モジュール介面向けに一般化する（`room.game: GameState` → `room.game: { moduleId, state }`）。
  タイマーの張り直しは既存の `syncPhaseTimer`（rooms.ts:2044、`setTimer` 抽象を利用）と
  同じ構造で `schedule` 効果を消化する。

### 2.2 WS プロトコル拡張（`server/types.ts`。チーム合意必須）

```ts
// C2S に追加
  /** ゲーム内イベント。サーバー（モジュール）が検証・解釈する。
   *  sandboxSignal（無解釈中継）とは正反対の設計であることに注意 */
  | { t: "gameEvent"; payload: unknown }

// S2C に追加
  /** 受信者ごとのゲーム表示データ。deadline はカウントダウン表示用 */
  | { t: "gameView"; gameId: string; view: unknown; deadline: number | null }
```

- 既存の `selectGame` / `startGame` / `skipPhase` は**そのまま**モジュールにも使う
  （開始経路の統一。§4）。
- 既存の `submitInput` / `submitVote` / `phase` / `roundResult` / `finalResult` は
  prompt モジュール用に**当面維持**する（クライアントを壊さない）。
  最終的に `gameEvent` / `gameView` へ寄せるかは未決（§10-4）。
- `RoomSnapshot` には `game?: { gameId: string; view: unknown; deadline: number | null }` を
  追加し、途中参加・再接続でフル状態を配る（既存の `phase`/`view` と並存。§10-4）。

**レート制限**: `gameEvent` は `sandboxSignal` の2段構え（`WS_SANDBOX_RATE_MAX` 30 /
`WS_SANDBOX_HARD_MAX` 150 / payload 4KB。いずれも【暫定値】のまま）を**そのまま引き継ぎ**、
定数名を `WS_GAME_EVENT_RATE_MAX` / `WS_GAME_EVENT_HARD_MAX` / `GAME_EVENT_PAYLOAD_MAX_BYTES`
に改名して転用する。実装は `main.ts` の既存の別枠カウント（rtcSignal / sandboxSignal と
同構造）を流用する。ソフト超過は破棄・通知は判定窓1回、ハード超過は切断。

### 2.3 何が sandboxSignal と決定的に違うか

| | sandboxSignal（廃止） | gameEvent（新設） |
|---|---|---|
| サーバーの扱い | payload を**解釈せず**同室へ中継 | モジュールが**検証して解釈**。状態を進める |
| 配信 | 送信者以外へ生 payload を全員配信 | サーバーが受信者ごとに `view()` を作って配信 |
| 秘密 | 隠せない | 隠せる |
| チート | 任意 payload がそのまま通る | 不正 payload は `INVALID_INPUT` で棄却 |
| 途中参加 | ゲーム側任せ（状態はサーバーに無い） | サーバーが state を持つので view を配るだけ |

### 2.4 タイマー — 既存 deadline 機構の一般化で足りる（tick ループは常設しない）

- 既存エンジンは「フェーズの期限1点」だけをタイマーにしている
  （`GameState.deadline` + `syncPhaseTimer`）。モジュール介面ではこれを
  `schedule` 効果（次に起こしてほしい時刻1点）に一般化する。
- **毎秒 N 回の定期 tick は基盤として常設しない。** パーティーゲームの進行は
  「入力イベント + 予約時刻」で表現できる（**想定**。§8 の15本を §2.7 で確認済み）。
  例: reflex の「1.2〜4.0秒後に合図」は schedule 1本、mogura の「次のもぐら出現」も
  schedule 1本で、出現のたびに次を予約すれば足りる。
- 負荷の目安（**想定**。負荷試験は §10-2）: 最も忙しい mogura でも schedule 発火は
  1ルームあたり毎秒 1〜3 回、view 配信は 10 接続 fan-out で毎秒 10〜30 通。
  同時20ルーム全部が稼働しても毎秒 600 通程度で、sandboxSignal 設計時の
  最悪試算（54,000通/秒。game-sandbox.md §4.3）より2桁小さい。
  サーバーが配信周期を握る（クライアントの連打が fan-out に直結しない）ことが効く。

### 2.5 乱数 — seed を渡して決定的にする

`engine.ts` は匿名表示順に FNV-1a（`hash32`）を使い、純粋関数性を守っている（**実測**:
コード確認）。モジュールも同じ規約とし、`init` で受け取った `seed` から
決定的 PRNG（xorshift 等）を state 内で進める。`Math.random()` をモジュール内で
呼ぶことは禁止する（テストの再現性と §3.2 規約2 のため。§7 のチェックリストに入れる）。

### 2.6 秘密配布（ワードウルフ等）

`view(state, viewerId)` が受信者ごとに絞る——既存の `buildPhaseView` が
「input 中は他人の回答を送らない・クイズの正解は reveal まで隠す」を実現しているのと
同じ原理（§3.2 原則3）。ワードウルフなら view に「自分の単語」だけを載せ、
狼判定はサーバー state にのみ存在する。**改造クライアントでも他人の秘密は見えない**
（そもそも受信していない）。これはサンドボックスでは構造的に不可能だった点である。

### 2.7 リアルタイム描画（お絵かき系）の設計

- 描き手は `gameEvent` でストロークの**チャンク**（点列）を送る。モジュールが検証
  （数値範囲・点数上限）して state の描画履歴に積み、`viewChanged` で配る。
- 途中参加・再接続は state の履歴から全再描画できる（サンドボックスでは不可能だった）。
- 概算（**想定**・【暫定値】）: 論理座標 0..479 の整数ペア、1チャンク最大 64 点
  （JSON で 500B 前後）、描き手のみ送信・最大 10 チャンク/秒 → 受信 5KB/秒、
  fan-out 9 で 45KB/秒/ルーム。`GAME_EVENT_PAYLOAD_MAX_BYTES`（4KB）と
  ソフト 30件/秒の枠に余裕で収まる。
- 描画履歴の上限【暫定値】: 1ラウンド 4,000 点。超過はモジュールが古い順に間引くか
  受理拒否する（メモリと再入室時の view サイズを抑える）。

---

## 3. クライアント規約

### 3.1 固定構造 — 1ゲーム = サーバー1ファイル + ビュー1ファイル + テスト1ファイル

```
server/games/
├── module.ts          … GameModule 介面と共通ヘルパー（§2.1）
├── index.ts           … カタログの正本。GAME_MODULES: GameModule[]（§4）
├── prompt.ts          … 宣言的フロー（engine.ts）のアダプタ
├── reflex.ts          … 以降、1ゲーム = 1ファイル
└── <id>.ts
server/tests/games/
└── <id>_test.ts       … Deno.test（reduce/view の純関数テスト）
public/room/games/
└── <id>.js            … ビューモジュール（ES module、1ゲーム = 1ファイル）
```

### 3.2 ビューモジュールの介面と読み込み

```js
// public/room/games/<id>.js
/** container: 専用の空要素。api: { send(payload), youId, isHost, serverNow() } */
export function mount(container, api) {
  // DOM を組み立てて返す
  return {
    update(view, deadline) { /* gameView を受けて描き直す */ },
    unmount() { /* タイマー・リスナを片付ける */ },
  };
}
```

- **読み込みはビルドレスの動的 `import()`**。前例: `public/corridor.js` が
  `import("/assets/3d/corridor-ui.js")` を本番 CSP（`default-src 'self'` 基調、
  script-src 未指定）で通している（**実測**: corridor.js のコメントと実運用）。
  ルーム UI はゲーム開始時に `import(`/room/games/${id}.js`)` する。id は
  サーバーのカタログ由来（`gameView.gameId`）のみを使い、URL 組み立てに
  ユーザー入力を混ぜない（パス注入の防止。§9.3）。
- prompt モジュールの表示は既存のフェーズ UI（`app.js` → 将来 `room/game.js`）を使い続ける。
  ビューモジュールが要るのは新設のモジュール型ゲームだけ。
- **iframe / runner / postMessage は使わない。** ビューモジュールはアプリのオリジンで
  直接動く。信頼水準は §0「失うもの」のとおり PR レビューで担保する。
- 表示規約は既存どおり: ユーザー由来テキストは必ず `textContent`（§3.8 / CLAUDE.md）。
  `innerHTML` 禁止。canvas 描画は制約なし。
- **音は出さない**（VC の会話にかぶせない。game-sandbox.md §5.4 の方針を引き継ぐ）。

---

## 4. カタログ統一

- **正本はサーバーの `server/games/index.ts` 1か所**（モジュール）+ ルームの
  `availableGames`（宣言的データ: 公式 + インポート分）。クライアントへは
  `RoomSnapshot.availableGames` に**一本化**して配る。`GET /api/sandboxGames` は廃止。
- `GameSummary`（types.ts）に `kind: "prompt" | "module"` を追加する。
  `official` フラグは維持（モジュールは常に official）。
- 開始経路も一本化: モジュールも `selectGame` → `startGame`（host only）。
  `sandboxStart` / `sandboxEnd` は廃止。進行の排他は `room.game` 1本になるため、
  `handleSelectGame` / `handleStartGame` にある sandbox 分岐（rooms.ts:1126 / 1147）は消える。
- **スタジオ投稿ゲームとの関係**: 投稿は従来どおり宣言的データ（`GameDefinition`）のみで、
  prompt モジュールの上で動く。**投稿ゲームがモジュール（コード）になる経路は作らない。**
  §3.5 の「実行可能スクリプトは受け付けない」は不変。

---

## 5. 既存フローとの整合（異常系は §8 マトリクスを踏襲）

| イベント | モジュール型ゲームの挙動 |
|---|---|
| 途中入室 | `playerJoined` をモジュールへ。既定は観戦（prompt と同じ）。扱いはモジュールが決められる |
| 切断/再接続(60秒) | `playerLeft` / `playerRejoined`。再接続時は `RoomSnapshot.game` で全量復元 |
| ホスト切断・委譲 | 既存の `hostChanged` のまま。進行はサーバーが握っているので引き継ぎ処理は不要（sandbox で必要だった「ホスト役の引き継ぎ」問題が消える） |
| キック | `playerKicked`。当人の痕跡の除去はモジュールの責務（prompt は既存実装） |
| 2人未満 | モジュールの `meta.minPlayers` を下回ったらルーム層が `endGame` 相当を流す（§10-5） |
| サーバー再起動 | ルームごと消滅（§8 共通規定のまま。変更なし） |

---

## 6. 移行計画（サンドボックス廃止の手順）

**原則: 動くものを先に用意してから消す。** 削除 PR は必ず単独で出し、レビューで差分を見る。

1. **新規追加の停止（本書マージ時点）**: `public/games/` への新ゲーム追加を止める。
2. **エンジン移植**: reflex → mogura の順にモジュールとして再実装する（§6.1 / §6.2）。
3. **UI 導線の除去**: 一覧から `sandbox:` カードを外し、`room/sandbox.js` の読み込みを外す。
4. **コードの撤去（削除 PR・チーム合意とバックアップ必須）**:
   - `server/types.ts`: `SandboxGameState` / `SandboxGameInfo` / `sandboxStart`・`sandboxEnd`・
     `sandboxSignal`（C2S/S2C）/ `Room.sandbox` / `RoomSnapshot.sandbox` / `WS_SANDBOX_*` /
     `SANDBOX_PAYLOAD_MAX_BYTES`（`gameEvent` 用に改名転用。§2.2）
   - `server/rooms.ts`: `handleSandboxStart` / `handleSandboxEnd` / `relaySandboxSignal` /
     `sandboxGameIds` / 排他分岐
   - `server/main.ts`: `SANDBOX_SECURITY_HEADERS` と `/sandbox/` ヘッダー分岐 /
     `GET /api/sandboxGames` / sandboxSignal レート枠
   - `server/main.ts` の manifest 検証・読み込み・`sandboxGamesBody` 生成部（独立ファイルは無く main.ts 内にある）
   - `server/tests/main_test.ts` / `server/tests/rooms_test.ts` 内の sandbox 関連テスト（独立したテストファイルは無い）
   - `public/sandbox/`（runner）/ `public/games/`（マニフェスト含む）/ `public/room/sandbox.js`
   - `public/app.js` の sandbox 連携部
5. **文書の更新**: `docs/spec/overall.md` §3.5.1 を本方式の記述に差し替え、
   `docs/design/game-sandbox.md` の冒頭に「本書は games-unified.md により廃止された
   設計のアーカイブである」旨を追記する（実測知見の保存のため削除しない）。

### 6.1 reflex（反射神経バトル）の移植方針

- 現実装（**実測**: `public/games/reflex.js`）はホスト役ブラウザが
  `round`→`go`→`tap`→`result` を配る自己申告制。反応時間 `rt` は各自の自己申告で、
  改造クライアントは任意の値を送れる。
- 移植後: サーバーが `schedule` で合図時刻を決めて view で配り、タップは
  `clientEvent {k:"tap"}` の**サーバー到着時刻**で順位付けする。フライングは
  「合図時刻より前の到着」で判定。自己申告値は使わない。
  RTT の個人差が順位に影響する限界は正直に表示する（§10-6）。
- 公式スコアに算入**できる**ようになる（`score` 効果）。

### 6.2 mogura（もぐらたたき）の移植方針

- 現実装（**実測**: `public/games/mogura.js`）は完全クライアント制で、スコアは表示専用。
- 移植後: サーバーが seed 由来の PRNG で出現位置と時刻を決めて schedule で進行し、
  タップ `clientEvent {k:"hit", cell}` を「そのセルにもぐらが出ている時刻内か」で判定する。
  遅延で「見えていたのに外れ」が起きうるため、判定に猶予【暫定値 150ms】を持たせる。
- `minPlayers: 1` の扱いは §10-5 の決定に従う。

---

## 7. 作り方ガイド（固定化 — 選択肢を残さない）

新ゲームの追加手順は以下の**1通りのみ**とする。判断分岐は「§8 の一覧のどれに似ているか」だけ。

1. 作業ブランチを切る: `git switch -c feature/game-<id>`
2. `server/games/<id>.ts` を書く。雛形は `server/games/_template.ts`（実装 Phase 1 で用意）を
   コピーする。規約: 純粋関数・await 禁止・`Math.random()` 禁止（seed PRNG を使う）・
   `clientEvent.payload` は必ず先頭で型検証し、不正は `INVALID_INPUT` で棄却する。
3. `server/games/index.ts` の `GAME_MODULES` に1行追加する（カタログ登録はこれだけ）。
4. `server/tests/games/<id>_test.ts` を書く。最低限: 正常進行1本 / 不正 payload 棄却 /
   途中参加 / 切断・キック / 2人未満（または minPlayers 未満）での終了。
5. 表示が既存フェーズ UI で足りないゲームは `public/room/games/<id>.js` を
   `_template.js` からコピーして書く。規約: `textContent` のみ・音を出さない・
   `unmount` で必ず片付ける。
6. `deno task check` / `lint` / `fmt` / `test` を通し、実 Chrome **別ウィンドウ2窓**で
   2人プレイを確認する（同一ウィンドウ2タブは背面タブの rAF 間引きで検証にならない。
   game-sandbox.md §6.3 の実測知見を引き継ぐ）。
7. PR を作り、下のチェックリストを本文に貼って人間レビューを受ける。

**PR チェックリスト**（レビュー観点）:

- [ ] `clientEvent.payload` を型検証してから使っている（サイズ・範囲・列挙の妥当性）
- [ ] `reduce` / `view` に I/O・await・`Math.random()`・`Date.now()` が無い
- [ ] 秘密情報（正解・役職・他人の入力中の値）が `view` の受信者絞りで守られている
- [ ] `schedule` の予約が終了時に残らない（`ended` 後に発火しても無害）
- [ ] 途中参加・切断・再接続・キック・minPlayers 未満で落ちない（テストあり）
- [ ] ビューモジュールは `textContent` のみ・音なし・`unmount` で後始末
- [ ] 公式スコアへの反映（`score` 効果）が1ゲーム1回
- [ ] 別ウィンドウ2窓で対戦が成立することを確認した

---

## 8. 量産予定15ゲームへの適用表

必要なエンジン機能は §2 の介面でどれも表現できる（**想定**。実装 Phase で順に検証する）。
「基盤」列: P = prompt モジュール（お題データの追加 or 小拡張）/ M = 専用モジュール。

| # | ゲーム | 基盤 | 必要な機能 | 実装フェーズ |
|---|---|---|---|---|
| 1 | 格付けクイズ | P | 既存 correct のお題追加のみ | **1** |
| 2 | 多数派ゲーム | P拡張 | scoring `majority`（choice で多数派に得点）を追加 | **2** |
| 3 | 価値観アンケート | P拡張 | scoring `none`（採点なし・実名公開の雑談燃料） | **2** |
| 4 | ○×サドンデス | M | 脱落（elimination）と生存者表示 | **2** |
| 5 | チキンレース | M | 隠し同時提出 → 一斉公開（0..100、被らず最大が勝ち） | **2** |
| 6 | せーの!同時押し | M | サーバー基準時刻との差の計測 | **2** |
| 7 | 早押しクイズ | M | 到着順の回答権 + 誤答ロック | **2** |
| 8 | reflex 移植 | M | schedule + 到着順（§6.1） | **2** |
| 9 | mogura 移植 | M | seed PRNG + schedule 進行（§6.2） | **2** |
| 10 | ワードウルフ | M | **秘密配布**（§2.6）+ 議論タイマー + プレイヤー投票 | **3** |
| 11 | NGワードゲーム | M | 秘密配布（自分のは見えない/見える切替）+ 申告ボタン | **3** |
| 12 | インサイダー風 | M | 秘密配布（内通者だけ正解を知る）+ 正解判定 + 投票 | **3** |
| 13 | エセ回答者 | M | 秘密配布（1人だけお題を知らない）+ 投票 | **3** |
| 14 | ジェスチャー当て | M | 出題者だけに秘密お題 + 回答判定（カメラは既存 VC 映像を使う） | **3** |
| 15 | ハミング当て | M | 同上（音は既存 VC 音声。ゲーム側は出題と判定のみ） | **3** |
| 16 | 質問王 | M | 出題者だけに秘密お題 + Yes/No 応答 UI | **3** |
| 17 | お絵かき当て | M | **描画中継**（§2.7）+ 出題者秘密 + 回答判定 | **4** |
| 18 | 伝言お絵かき | M | 描画中継 + リレー順の個別配布 + 最終一斉公開 | **4** |

- Phase 3 の4本（10〜13）は「秘密配布 + プレイヤー投票」の共通ヘルパーを
  `server/games/module.ts` に置いて量産する。
- 2 / 3 の scoring 追加は `ScoringMode` の変更（types.ts / gamedef.ts）を伴う。
  **スタジオ（投稿ゲーム）にも新 scoring を開放するか**は別判断（§10-3）。

---

## 9. セキュリティ・チート耐性

### 9.1 サーバー権威で守れるもの

- **採点・進行・秘密**はすべてサーバー state にのみ存在し、クライアントは view しか
  受け取らない。改造クライアントができるのは「不正な payload を送る」ことだけで、
  それはモジュールの型検証（§7 規約2）で `INVALID_INPUT` に落ちる。
- 全ゲームが公式スコア（`ScoreEntry` / `Player.score`）に算入できる。
  sandbox 方針3（算入禁止）はその前提ごと消える。

### 9.2 残るリスクと引き受け方

- **ビューモジュールはアプリのオリジンで動く。** 隔離しない代わりに、
  リポジトリ入り + 人間の PR レビュー必須（DoD）という、`chat.js` / `vc.js` と同じ
  信頼水準に置く。ユーザー投稿コードの経路は存在しない（§4）ため、
  「悪意あるコードが常に入ってくる」前提は不要になった。
- **フロントの無限ループ**は起きればそのタブのバグとして直す（既存フロント全般と同じ）。
  サーバー側は純粋関数 + レート制限で保護されており、1クライアントの暴走が
  ルーム全体を巻き込む経路は `gameEvent` のハード上限（切断）で塞ぐ。
- **タイミング系の公平性**（早押し・reflex）はサーバー到着順のため RTT の影響を受ける。
  §7 非機能要件（反映500ms以内・同一リージョン）の範囲では許容し、画面に
  「回線が速いと有利」の注記を出す（§10-6）。

### 9.3 入力検証・上限

- `gameEvent`: ソフト 30件/秒（破棄・通知は窓1回）/ ハード 150件/秒（切断）/
  payload 4KB【いずれも暫定値。§10-2】。`main.ts` の既存別枠カウント実装を転用。
- ビューモジュールの動的 import は `gameView.gameId`（サーバーのカタログ照合済み）
  のみから URL を組む。ユーザー入力からはパスを作らない。
- 表示は `textContent` のみ（§3.8）。ニックネーム・回答・お題などの
  ユーザー由来文字列を innerHTML に入れない。

---

## 10. 段階的実装計画（PR 分割）と未決事項

### 10.1 PR 分割案

| PR | 内容 | 主な変更ファイル | 規模感 |
|---|---|---|---|
| 1 | 本設計書（方針変更 + types.ts 変更の合意） | docs のみ | 小 |
| 2 | モジュール介面 + prompt アダプタ（挙動不変。既存テスト green 維持） | `server/games/module.ts`・`prompt.ts`・`index.ts`、`rooms.ts` の一般化、`types.ts`（`gameEvent`/`gameView`/`GameSummary.kind`） | 大 |
| 3 | reflex 移植（リアルタイム経路の実証）+ ビューローダー + 雛形2種 | `server/games/reflex.ts`、`public/room/games/`、テスト | 中 |
| 4 | mogura 移植 + sandbox UI 導線除去 | `server/games/mogura.ts`、`app.js` | 中 |
| 5 | sandbox 撤去（削除のみの単独 PR。§6-4 の一覧） | types / rooms / main / public/sandbox ほか | 中（削除） |
| 6〜 | §8 のフェーズ 1〜4 を順に量産（1 PR = 1〜4本） | `server/games/`・`public/room/games/` | 各 小〜中 |

PR 2 が全体の要で、ここまでは**ゲームの見た目・挙動が一切変わらない**リファクタとして
レビューできるように切る。

### 10.2 未決事項（チーム・オーナー判断待ち）

| # | 内容 | 判断者 |
|---|---|---|
| 1 | **方針変更そのもの**（§0。game-sandbox.md §0 の上書き）。本 PR のマージをもって合意とする | オーナー + チーム |
| 2 | `gameEvent` のレート・payload 上限【暫定値】と負荷試験の要否（§2.2 / §2.4 の試算は想定） | チーム |
| 3 | scoring `majority` / `none` をスタジオ（投稿ゲーム）にも開放するか（§8） | チーム |
| 4 | `submitInput` / `submitVote` / `phase` 系メッセージを最終的に `gameEvent` / `gameView` に統合するか、prompt 専用として残すか | チーム |
| 5 | `minPlayers: 1`（mogura）を認めるか。エンジン共通 `MIN_PLAYERS = 2`（§8 共通規定「2人未満で中断」）をモジュール宣言でオーバーライドする設計の可否 | オーナー |
| 6 | タイミング系ゲームの公平性の扱い（サーバー到着順 + 注記で足りるか、補正を入れるか） | チーム |
| 7 | sandbox 撤去（PR 5）の実施時期とバックアップ方法（削除前ブランチ or タグ） | オーナー |
| 8 | `public/room/games/` の担当。全体設計書 §3 の担当表に行が無い（サーバーモジュールは
    サーバー担当、ビューはゲームと同じ「全員」枠に置く案） | オーナー |
| 9 | iOS Safari での動的 `import()` とビューモジュールの動作確認（corridor の実績はあるが
    ゲーム UI としては未検証） | チーム |
