# ゲーム基盤の統一（設計書）

- 版: v0.2（v0.1 の方針を一部差し戻す改訂。§0）
- 日付: 2026-08-26
- 前提: 詳細仕様書 [overall.md](../spec/overall.md) v0.5 §3.2〜§3.5 / §4 / §5 / §7 / §8、
  全体設計書 [overall.md](overall.md) v1.0、
  サンドボックス設計書 [game-sandbox.md](game-sandbox.md) v0.1（**廃止済み。アーカイブとして保存**。§6.4）
- 状態: v0.1 の方針（§0.1）は**モジュール介面・prompt アダプタ・専用モジュール4本
  （chicken / hayaoshi / wordwolf / draw）として実装済み**（**実測**: `server/games/` のファイル構成と
  git log で確認）。v0.2 で追加する「クライアント専用ゲーム」の経路は
  同じブランチ（`feature/client-games`）で**実装が並行して進んでいる**（`server/games/client.ts`・
  `public/room/games/_client.js`・reflex / mogura / emoawase）。本書はその方式を確定させる文書であり、
  記述は実装と突き合わせてある。

**表記規約**: 「**実測**」= 実際に動かして確認した事実（本書ではコードを読んで確認した事実を含む）、
「**想定**」= 仕様・コードからの推論で未検証、「**【暫定値】**」= 出典の無い数値。
game-sandbox.md と同じ書き分けに従う。

---

## 0. 方針の経緯（オーナー判断）

### 0.1 v0.1 で決めたこと（維持する）

game-sandbox.md §0 は「宣言的エンジンとサンドボックスの**2基盤を並列に持つ**」ことを
オーナー確定方針としていた。v0.1 はこれを次のとおり変更し、その部分は**v0.2 でも維持する**。

1. **サーバー側のゲーム実装をモジュール介面1本に統一する**（§2.1）。
   宣言的フロー（大喜利・以心伝心・クイズ・スタジオ投稿ゲーム）は prompt モジュール1実装として吸収する。
2. **iframe サンドボックス基盤（`public/sandbox/` runner / `public/games/` /
   `sandboxStart`・`sandboxEnd`・`sandboxSignal`）は廃止する**（§6）。
3. **スタジオ（§3.5 投稿ゲーム）は従来どおり宣言的データのみ**を受け付ける。
   ユーザー投稿にコード実行の経路は今後も作らない。

### 0.2 v0.2 で差し戻すこと

v0.1 は上に加えて「**ゲームの作り方を1通りに固定し、判断分岐そのものを無くす**」と書いていた。
すなわち「ゲーム1本 = `server/games/<id>.ts`（サーバー権威の状態機械）+ ビュー」を必須とした。
これを次のとおり**改める**。

- **サーバー側モジュールは任意にする。** クライアント側だけでゲームを書いて置けば動く経路を用意する。
- クライアント側ゲームは（サンドボックスに戻すのではなく）**アプリのオリジンで動く通常の ES モジュール**とする。

理由は2つある。どちらも「v0.1 の時点では見えていなかった前提」である。

**(a) オーナーの用途を落としかけていた。**
オーナーが求めていたのは「**普通のブラウザゲーム開発と同じように、画像ファイルを使ったゲームを書いて
置いたら動く**」ことだった。これは元々サンドボックス基盤が担っていた用途である。
v0.1 は基盤を1本に畳む際に、この用途ごと畳んでしまっていた。
サーバー権威モジュールは「秘密配布・公式スコア・完全復元」には必要だが、
画像を並べて動かすだけのゲームにとっては、`server/games/<id>.ts` と
`server/tests/games/<id>_test.ts` を必ず書かせる**純粋な追加コスト**でしかない。

**(b) 脅威モデルの前提が変わった。**
オーナー判断により「**ゲームを追加できるのはチームだけ**」が確認された。
game-sandbox.md の多層防御（不透明オリジン + 多重 CSP + `new Function` 隔離）は
「悪意あるゲームコードが常に入ってくる」前提で組んだものだが、その前提が成り立たない。
リポジトリ入り + 人間の PR レビューを通るコードに対しては**過剰**であり、
`chat.js` / `vc.js` と同じ信頼水準に置けば足りる（§9.2）。

### 0.3 「作り方の分散を嫌う」動機は捨てない

v0.1 の動機（「毎回どちらの基盤か選ばされる」構造を無くす）は正しかった。
v0.2 はそれを**基盤を1本に潰すことではなく、判断基準を迷わない形で固定すること**で満たす（§1.3）。
分岐は残すが、分岐で悩む時間は残さない。

具体的には次の3点で分散のコストを消している。

- **一覧・開始経路・進行の正本は1つのまま**。クライアント専用ゲームも
  `server/games/index.ts` のカタログに載り、`selectGame` → `startGame` → `gameView` → `endGame`
  という同じ経路で動く（§2.8）。基盤が2つに割れるわけではない。
- **登録の手数が同じ**。どちらも「`GAME_MODULES` に1行足す」で終わる。
- **判断が3問のイエス/ノーで済む**（§1.3）。

---

## 1. 背景

### 1.1 何が分散していたか（v0.1 時点）

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
| 現状の収録 | 大喜利 / 以心伝心 / 雑学クイズ / 格付けクイズ（`official_games.ts`） | reflex / mogura |

エンジン側の制約は仕様上のもの（§3.4 / §3.5）:
入力は `text` / `choice` の2種、採点は `vote` / `match` / `correct` の3種、
入力と採点の組は `gamedef.ts` の `ALLOWED_INPUT_BY_SCORING`（vote→text / match→text /
correct→choice）に固定。この枠の外のゲームが1本も作れなかった。

### 1.2 v0.1 の統一で解けたこと・落としかけたこと

**解けたこと**（**実測**: `server/games/` に実装済み）:
モジュール介面（§2.1）により、秘密配布（wordwolf）・到着順（hayaoshi）・
隠し同時提出（chicken）・描画中継（draw）がすべてサーバー権威で書けるようになった。
これらは構造上サンドボックスでは作れなかったものである。

**落としかけたこと**: 上記4本はいずれも「サーバーが state を持つ必要が本当にあった」ゲームである。
一方で reflex / mogura のような「その必要が無いゲーム」まで、
サーバーモジュール + サーバーテストを必須にしていた。画像を使ったカジュアルゲームは
ここに該当し、追加コストだけを払わされる。v0.2 はこの層に**受け皿を作る**改訂である。

### 1.3 どちらで作るか — 3問で決める

> **サーバーモジュールが要るのは、次の3つのどれかに当てはまるときだけ。**
>
> 1. **参加者ごとに違う秘密を配るか？**（役職・お題・単語など、他人に見えてはいけない情報がある）
> 2. **公式スコア（`Player.score`）に算入するか？**（卓の順位に効く得点を付ける）
> 3. **途中参加・再接続で状態を完全に復元する必要があるか？**（直近の数手だけでは足りない）
>
> **どれにも当てはまらなければ、クライアント専用で書く。**

3問すべてが「いいえ」なら `public/room/games/<id>.js` を1本書き、
`server/games/index.ts` に `clientGame({...})` を1行足すだけで終わる（§7.1）。
1つでも「はい」があるなら `server/games/<id>.ts` を書く（§7.2）。

**迷ったときの原則**: 先にクライアント専用で作ってよい。
あとから3問のどれかが「はい」に変わったら、サーバーモジュールを足して差し替える。
逆（サーバーモジュールを書いてから要らないと気づく）より安い。

具体例:

| ゲームの例 | 3問の答え | どちらで作るか |
|---|---|---|
| 画像を並べて動かすカジュアルゲーム（間違い探し・神経衰弱など） | いいえ×3 | **C** クライアント専用 |
| 反射神経バトル（reflex）・もぐらたたき（mogura） | いいえ×3（順位は場の盛り上げとして表示するだけ） | **C** クライアント専用 |
| ネタゲー・お遊び演出（勝敗が無い、または自己申告でよいもの） | いいえ×3 | **C** クライアント専用 |
| クイズ（お題データを足すだけで成立するもの） | ① 正解を伏せる必要がある | **P** prompt（データ追加のみ。コードを書かない） |
| ワードウルフ・インサイダー風・エセ回答者 | ① はい（秘密配布） | **M** 専用サーバーモジュール |
| 早押しクイズ・チキンレース | ①② はい | **M** 専用サーバーモジュール |
| お絵かき当て | ①③ はい（描画履歴の完全復元） | **M** 専用サーバーモジュール |

**C で作ったゲームの得点は公式スコアに算入しない**（§2.8.3）。これは制約であると同時に、
「順位が卓に効くゲームはサーバーが握る」という §3.2 原則1 を曲げないための線引きである。

---

## 2. アーキテクチャ

### 2.1 設計の核 — エンジンの3関数を「ゲームモジュール」介面に一般化する

既存エンジン（`server/engine.ts`）は実質的に次の3関数でできている（**実測**: コード確認）。

- `startGame(definition, players, now, durations)` … 初期状態を作る
- `reduce(state, event)` … 純粋関数でイベントを1件処理し、新しい状態と副作用を返す
- `buildPhaseView(state, viewerId)` … **受信者ごとの**表示データを作る（§3.2 原則3）

この形を `server/games/module.ts` の `GameModule` として切り出してある（**実測**: 実装済み）。
主要な型は次のとおり（実装から抜粋。全文は `server/games/module.ts`）。

```ts
export type GameModuleKind = "prompt" | "module";

export type GameModule<S = unknown, V = unknown> = {
  id: string;
  kind: GameModuleKind;
  meta: GameModuleMeta; // title / description / minPlayers / maxPlayers
  init(input: ModuleInitInput): ModuleResult<S>; // players / now / seed / config
  reduce(state: S, event: ModuleEvent): ModuleResult<S>;
  view(state: S, viewerId: string): V;
};
```

`ModuleEvent` は `clientEvent` / `chatMessage` / `timeout` / `playerJoined` / `playerLeft` /
`playerRejoined` / `playerKicked` / `skipPhase` / `endGame`、
`ModuleEffect` は `viewChanged` / `schedule` / `score` / `ended` / `suppressChat` /
`roundResult` / `finalResult`（**実測**: `server/games/module.ts`）。
乱数は `nextSeed` / `randomFloat` / `randomInt` / `shuffle` の seed PRNG ヘルパーを使い、
`Math.random()` は禁止（§2.5）。

### 2.2 WS プロトコル（実装済み）

```ts
// C2S
| { t: "gameEvent"; payload: unknown }
// S2C
| { t: "gameView"; gameId: string; view: unknown; deadline: number | null }
```

既存の `selectGame` / `startGame` / `skipPhase` はモジュールにもそのまま使う（開始経路の統一。§4）。
`submitInput` / `submitVote` / `phase` / `roundResult` / `finalResult` は prompt モジュール用に維持する。

**レート制限**（**実測**: `server/types.ts`）: `WS_GAME_EVENT_RATE_MAX = 30`（ソフト、件/秒）/
`WS_GAME_EVENT_HARD_MAX = 150`（ハード、件/秒。超過で切断）/
`GAME_EVENT_PAYLOAD_MAX_BYTES = 4 * 1024`。いずれも sandboxSignal の値を引き継いだ**【暫定値】**。
ソフト超過は破棄・通知は判定窓1回、ハード超過は切断。

### 2.3 何が sandboxSignal と決定的に違うか

| | sandboxSignal（廃止） | gameEvent |
|---|---|---|
| サーバーの扱い | payload を**解釈せず**同室へ中継 | サーバーが受け取り、**state を進める**（C の場合は解釈せず**保持**する。§2.8.2） |
| 状態の在り処 | ホスト役のブラウザ | **サーバー** |
| 配信 | 送信者以外へ生 payload を全員配信 | サーバーが受信者ごとに `view()` を作って配信 |
| 途中参加 | ゲーム側任せ（状態がサーバーに無い） | サーバーが view を配るだけ |
| ホスト交代 | ホスト役の引き継ぎ処理が必要 | 不要（サーバーが握っている） |

**クライアント専用ゲーム（C）でもこの表の右列に入る**ことが重要である。
C はサーバーが payload を**解釈しない**が、**保持と配信の主体はサーバー**なので、
「ホスト役ブラウザが状態を持つ」というサンドボックスの構造には戻らない。

### 2.4 タイマー — 既存 deadline 機構の一般化で足りる

- モジュールは `schedule` 効果（次に `timeout` を起こしてほしい時刻1点）で進行する。
  ルーム層の `syncPhaseTimer` 相当がこれを消化する。
- **毎秒 N 回の定期 tick は基盤として常設しない。** サーバー側の進行は
  「入力イベント + 予約時刻」で表現できる（**想定**）。
- クライアント専用ゲームのアニメーションは**クライアントの rAF で回す**（サーバーは関知しない）。
  これが C の一番の利点で、毎フレームの通信そのものが発生しない。

### 2.5 乱数 — seed を渡して決定的にする

`engine.ts` は匿名表示順に FNV-1a（`hash32`）を使い、純粋関数性を守っている（**実測**: コード確認）。
モジュールも同じ規約で、`init` の `seed` から `server/games/module.ts` の xorshift32 ヘルパーを進める。
`Math.random()` の呼び出しは禁止（テストの再現性と §3.2 規約2 のため）。

クライアント専用ゲームには **`view.seed` として同じ seed が配られる**（§2.8.2）。
全員が同じ seed を見るので、「全員の画面で同じ配置になる」ゲームが通信なしで作れる。

### 2.6 秘密配布（M でのみ可能）

`view(state, viewerId)` が受信者ごとに絞る。ワードウルフなら view に「自分の単語」だけを載せ、
狼判定はサーバー state にのみ存在する。**改造クライアントでも他人の秘密は見えない**
（そもそも受信していない）。C ではこれができない（C の view は全員同じ内容 + `you` のみ）。

### 2.7 リアルタイム描画（お絵かき系。M）

描き手は `gameEvent` でストロークのチャンク（点列）を送り、モジュールが検証して
state の描画履歴に積み、`viewChanged` で配る。途中参加・再接続は履歴から全再描画できる。
描画履歴の上限【暫定値】: 1ラウンド 4,000 点。超過は古い順に間引くか受理拒否する。

### 2.8 クライアント専用ゲーム（C）の成り立ち

**方式は「新しい経路を足す」のではなく「既存のモジュールを自動生成する」。**
これにより `rooms.ts` / `types.ts` / `main.ts` に一切変更を入れずに済む。

#### 2.8.1 登録 — `clientGame()` ファクトリ

`server/games/client.ts`（新規）に次のファクトリを置く（**実測**: 実装済み）。

```ts
clientGame({ id, title, description, minPlayers, maxPlayers, relayLogMax });
```

これが通常の `GameModule`（`kind: "module"`）を**自動生成して返す**。
ゲーム作者はサーバーコードを書かず、`server/games/index.ts` の `GAME_MODULES` に
`clientGame({...})` を**1行足すだけ**でよい。

`relayLogMax` は参加者間の中継ログの件数（§2.8.2）。
省略時は `CLIENT_RELAY_LOG_DEFAULT = 32`【暫定値】、指定できる上限は
`CLIENT_RELAY_LOG_MAX = 128`【暫定値】、**`0` を渡すと中継そのものを断る**
（`gameEvent` は `INVALID_INPUT` で棄却。1人で完結するゲーム向け）。
大きくすると view 1通が太り、配信量がその分だけ増えるので、
「同時に飛び交いうるイベント件数」に合わせて小さく取る。

生成されたモジュールは普通のモジュールなので、
`selectGame` → `startGame` → `gameView` → `endGame`、途中参加・切断・再接続・
ホスト交代・キック・`minPlayers` 判定が**すべて既存実装のまま効く**。
クライアント側も `public/room/games/<id>.js` を動的 import する既存経路
（**実測**: `public/app.js:219` の動的 `import()`）に乗る。

#### 2.8.2 参加者間通信（relay）— 上限つきイベントログ

**新しい S2C メッセージ（`sandboxSignal` のような無解釈ブロードキャスト経路）は作らない。**
代わりに、生成されたモジュールが state に**上限つき連番イベントログ**を持つ。

- `clientEvent` を受けたら、payload を**解釈せず**（サイズ・件数・レート上限だけ課して）
  連番 `n`（1 始まり）を振ってログに積み、`viewChanged` を返す。
- ログは既定 32 件【暫定値】、上限 128 件。超えたら**古い順に間引く**。
- `view(state, viewerId)` は次を返す（**実測**: `ClientGameView`）。

```ts
type ClientGameView = {
  seed: number; // 卓の全員で同じ乱数の種（§2.5）
  startedAt: number; // 開始時刻（epoch ms）。経過時間の基準
  players: RelayPlayer[]; // 名簿 { id, name, connected }
  events: RelayEvent[]; // 中継ログ（古い順）{ n, from, payload }
  ended: boolean; // 終了したか
};
```

- クライアントは連番 `n` を見て、前回までに処理した番号より大きいものだけを適用する（差分適用）。
- 自分の playerId は view に載せない。ビュー側は `api.youId`（§3.2）を使う。
- 名簿の `name` はユーザー由来なので、**表示は必ず `textContent`**（§9.3）。
- 名簿に載っていない相手からの `clientEvent` は `PHASE_MISMATCH` で棄却する
  （キック直後の取りこぼし対策）。`relayLogMax: 0` のゲームは `INVALID_INPUT` で全部棄却する。

**この形にした理由**:
既存の `gameView` 1本で「配信」と「途中参加・再接続時の復元」の両方をまかなえ、
無解釈ブロードキャスト経路を新設せずに済む。サーバーは payload を解釈しないが、
**保持と配信の主体はサーバー**なので、sandboxSignal のような
「ホスト役ブラウザが状態を持つ」構造にはならない（§2.3）。

**限界（正直に書く）**:
ログは直近 N 件しか保たないため、**履歴の完全復元は保証しない**。
長時間の対戦の全経過や、1手でも欠けたら破綻する種類のゲームはこの経路では作れない。
そのときは §1.3 の3問目が「はい」になるので、サーバーモジュールを書く。

**上限**（いずれも【暫定値】。§2.2 と同じ枠を使う）:
payload 4KB / ソフト 30 件毎秒（破棄）/ ハード 150 件毎秒（切断）/ ログ既定 32 件・最大 128 件。

#### 2.8.3 得点 — 公式スコアには算入しない

生成されたモジュールは **`score` 効果を一切出さない**。
クライアント専用ゲームの得点は自己申告であり、改造クライアントで任意の値を作れるため、
**公式スコア（`Player.score`）には算入しない**。

ゲーム内での勝敗表示・順位表示は自由だが、
**画面に「この得点は卓の点数に入りません」と断りを出すこと**（§7.1 のチェックリスト）。
卓の順位に効く得点を付けたいなら、それは §1.3 の2問目が「はい」なのでサーバーモジュールを書く。

#### 2.8.4 画像などのアセット

```
public/assets/games/<ゲームID>/<名前>.svg|png|jpg
```

- `@std/http` の `serveDir` が `public/` 配下をそのまま配る（**実測**: `server/main.ts:527`、
  `fsRoot: PUBLIC_DIR`）ため、**`main.ts` の変更は不要**。ファイルを置けば配信される。
- 本体の CSP は `img-src 'self' data:`（**実測**: `server/main.ts:110`）なので、
  同一オリジンの画像は追加作業なしで `<img>` / canvas から読める。
- **ライセンス表は `public/assets/games/CREDITS.md` に置く。**
  書式・方針は `public/assets/sound/CREDITS.md` に合わせる（「使用中のもの」の表 +
  配布元ごとの条件 + 差し替えるときの注意）。
- **再配布ライセンスが不明な素材は置かない。** クレジット表記が必須の配布元を使う場合は、
  表記を出す場所まで確保してから使う（`public/assets/sound/CREDITS.md` の
  ポケットサウンドの件——「表記を出す場所がまだ無い」という未対応の宿題——が前例）。

---

## 3. クライアント規約

### 3.1 ファイル構成

```
server/games/
├── module.ts          … GameModule 介面と共通ヘルパー（§2.1）
├── client.ts          … clientGame() ファクトリ（§2.8.1）
├── index.ts           … カタログの正本。GAME_MODULES（§4）
├── prompt.ts          … 宣言的フロー（engine.ts）のアダプタ
├── _template.ts       … サーバーモジュールの雛形
└── <id>.ts            … 【M のみ】1ゲーム = 1ファイル
server/tests/games/
└── <id>_test.ts       … 【M のみ】Deno.test（reduce/view の純関数テスト）
public/room/games/
├── _template.js       … ビューモジュールの雛形
├── _client.js         … 【C のみ】共通ヘルパー（DOM・差分適用など。ルールは知らない）
└── <id>.js            … ビューモジュール（ES module、1ゲーム = 1ファイル）
public/assets/games/
├── CREDITS.md         … 素材の出典と利用条件（§2.8.4）
└── <id>/              … そのゲームの画像など
```

**C は3つだけで済む**: `public/room/games/<id>.js` /
`public/assets/games/<id>/`（要るなら）/ `server/games/index.ts` への1行。

### 3.2 ビューモジュールの介面と読み込み

```js
// public/room/games/<id>.js
/** container: 専用の空要素。api: { send(payload), youId, isHost, serverNow() } */
export function mount(container, api) {
  return {
    update(view, deadline) {/* gameView を受けて描き直す */},
    unmount() {/* タイマー・リスナを片付ける */},
  };
}
```

- **読み込みはビルドレスの動的 `import()`**（**実測**: `public/app.js:219`）。
  id はサーバーのカタログ由来（`gameView.gameId`）のみを使い、
  URL 組み立てにユーザー入力を混ぜない（パス注入の防止。§9.3）。
- **iframe / runner / postMessage は使わない。** ビューモジュールはアプリのオリジンで直接動く。
  信頼水準は §9.2 のとおり PR レビューで担保する。
- 表示規約: ユーザー由来テキストは必ず `textContent`（§3.8 / CLAUDE.md）。`innerHTML` 禁止。
  canvas 描画は制約なし。
- **音は出さない**（VC の会話にかぶせない。game-sandbox.md §5.4 の方針を引き継ぐ）。
- `update` は同じ view で何度でも呼ばれる。骨組みは `mount` で1度だけ作り、
  `update` では中身だけ変える（**実測**: `public/room/games/_template.js` の規約5）。

### 3.3 M と C でビューモジュールの書き方が変わる点

| | M（サーバーモジュールあり） | C（クライアント専用） |
|---|---|---|
| view の中身 | モジュールが設計した任意の形 | `{ seed, startedAt, players, events, ended }` 固定（§2.8.2） |
| 勝敗・進行の判断 | **クライアントでしない**（view に書いてあることだけ描く） | **クライアントでする**（ゲームロジックはここにある） |
| ローカル状態 | 表示上の一時値だけ | 持ってよい（ゲームの状態そのもの） |
| アニメーション | サーバーの `schedule` 起点 | rAF で自由に回す |
| 得点 | `score` 効果で公式スコアへ | 公式スコアに乗らない（画面に断る） |

C では `_template.js` の規約4（サーバーが唯一の状態機械）だけが当てはまらない。
それ以外の規約（`textContent` / 音を出さない / `unmount` で後始末 / update は何度でも呼ばれる）は同じ。

---

## 4. カタログ統一

- **正本はサーバーの `server/games/index.ts` 1か所**（`GAME_MODULES`）+ ルームの
  `availableGames`（宣言的データ: 公式 + インポート分）。クライアントへは
  `RoomSnapshot.availableGames` に一本化して配る。`GET /api/sandboxGames` は廃止する。
- `GameSummary`（`server/types.ts`）は `kind: "prompt" | "module"` を持つ（**実測**: 実装済み。
  省略時は prompt とみなす）。**クライアント専用ゲームも `kind: "module"` として並ぶ**——
  `clientGame()` が生成するのは普通のモジュールだからである（§2.8.1）。
- 開始経路も一本化: モジュールも `selectGame` → `startGame`（host only）。
  `sandboxStart` / `sandboxEnd` は廃止する。
- **スタジオ投稿ゲームとの関係**: 投稿は従来どおり宣言的データ（`GameDefinition`）のみで、
  prompt モジュールの上で動く。**投稿ゲームがモジュール（コード）になる経路は作らない。**
  §3.5 の「実行可能スクリプトは受け付けない」は不変（§9.2）。

---

## 5. 既存フローとの整合（異常系は §8 マトリクスを踏襲）

C の挙動は `server/games/client.ts` の実装（**実測**）。

| イベント | M の挙動 | C の挙動（`clientGame` 生成モジュール） |
|---|---|---|
| 途中入室 | `playerJoined` をモジュールへ。扱いはモジュールが決める | 名簿に加わる（`maxPlayers` を超えるぶんは載せない）。`events` は直近ログしか受け取れず、それ以前は復元されない（§2.8.2 の限界） |
| 切断/再接続(60秒) | `playerLeft` / `playerRejoined`。state から全量復元 | 在籍は残したまま `connected` を倒す／戻すだけ。復帰後に見えるのは直近ログの範囲 |
| ホスト切断・委譲 | 既存の `hostChanged` のまま。引き継ぎ処理は不要 | 同じ（サンドボックスの「ホスト役引き継ぎ」問題は起きない） |
| キック | `playerKicked`。痕跡の除去はモジュールの責務 | 名簿から外し、**当人が残した `events` も消す**（卓から痕跡を消す） |
| 人数不足 | `meta.minPlayers` を下回ったらルーム層が終了させる | キックで名簿が `minPlayers` を割ったら `ended` にする（`clientGame` の引数で宣言する） |
| ホストの skipPhase | モジュールが解釈する | 進行を持たないので無視する。終わらせたいときは `endGame` |
| ホストの endGame | `ended` 効果 | `ended: true` にして `ended`（`hostEnded`）を返す |
| サーバー再起動 | ルームごと消滅（§8 共通規定のまま） | 同じ |

---

## 6. 移行計画（サンドボックス撤去）

**原則: 新しい受け皿を先に用意してから消す。** 削除 PR は必ず単独で出し、レビューで差分を見る。

1. **新規追加の停止（v0.1 マージ時点で実施済み）**: `public/games/` への新ゲーム追加を止める。
2. **受け皿の用意**: `server/games/client.ts`（`clientGame` ファクトリ）と
   `public/assets/games/`（CREDITS.md を含む）を先に入れる。**ここが v0.2 の追加分**。
3. **reflex / mogura の移植**: **クライアント専用ゲーム（C）として移植する**（§6.1 / §6.2）。
   v0.1 では「サーバー権威モジュールへ移植」としていたが、§1.3 の3問がすべて「いいえ」なので改める。
   同時に画像を使うゲーム（絵合わせ）を1本入れ、`public/assets/games/` の経路を実際に通す。
4. **UI 導線の除去**: 一覧から `sandbox:` カードを外し、`public/room/sandbox.js` の読み込みを外す。
5. **コードの撤去（削除 PR・チーム合意とバックアップ必須）**:
   - `server/types.ts`: `SandboxGameState` / `SandboxGameInfo` / `sandboxStart`・`sandboxEnd`・
     `sandboxSignal`（C2S/S2C）/ `Room.sandbox` / `RoomSnapshot.sandbox` / `WS_SANDBOX_*` /
     `SANDBOX_PAYLOAD_MAX_BYTES`（`GAME_EVENT_*` へ改名転用済みのため元定義は消せる）
   - `server/rooms.ts`: `handleSandboxStart` / `handleSandboxEnd` / `relaySandboxSignal` /
     `sandboxGameIds` / 排他分岐
   - `server/main.ts`: `SANDBOX_SECURITY_HEADERS` と `/sandbox/` ヘッダー分岐 /
     `GET /api/sandboxGames` / sandboxSignal レート枠 /
     manifest の検証・読み込み・`sandboxGamesBody` 生成部（独立ファイルは無く main.ts 内にある）
   - `server/tests/main_test.ts` / `server/tests/rooms_test.ts` 内の sandbox 関連テスト
     （独立したテストファイルは無い）
   - `public/sandbox/`（runner.html / runner.js）/ `public/games/`（manifest.json 含む。**削除する**）/
     `public/room/sandbox.js`
   - `public/app.js` の sandbox 連携部
6. **文書の更新**: `docs/spec/overall.md` §3.5.1 を本方式の記述に差し替える。
   `docs/design/game-sandbox.md` は §6.4 のとおりアーカイブとして残す。

### 6.1 reflex（反射神経バトル）の移植方針 — C

- 現実装（**実測**: `public/games/reflex.js` と `public/games/manifest.json`）は
  ホスト役ブラウザが `round`→`go`→`tap`→`result` を配る自己申告制。
- 移植後も**ゲームロジックはクライアントに置く**。合図のタイミングは `view.seed` から
  全員が同じ値を決定的に算出し、`view.startedAt` を基準に合わせる
  （通信で合図を配らないので、中継の遅延がそのまま合図のズレにならない）。
  各自のタップは relay で流し、`events` を集めて順位表示にする。
- 反応時間は**自己申告のまま**であり、改造クライアントは任意の値を送れる。
  したがって**公式スコアには算入しない**（§2.8.3）。画面にその旨を出す。
- 厳密な順位を競わせたくなったら、そのときに §1.3 の2問目が「はい」になるので
  サーバーモジュール（到着順判定）へ差し替える。**先回りして作らない。**

### 6.2 mogura（もぐらたたき）の移植方針 — C

- 現実装（**実測**: `public/games/mogura.js`）は完全クライアント制で、スコアは表示専用。
  そもそも C にそのまま当てはまる形をしている。
- 移植後: 出現位置・時刻は `view.seed` から全員同じ列を決定的に生成する。
  スコアは各自のクライアントが数え、relay で申告して一覧表示する（公式スコアには乗らない）。
- 一人でも遊べる（`clientGame({ minPlayers: 1, ... })`。§10.2-5 で解決済み）。

### 6.3 移植で捨てるもの

`public/games/manifest.json` の `author` / `dev` フィールドは移行先に対応物が無い（**実測**:
`GameModuleMeta` は title / description / minPlayers / maxPlayers のみ）。
作者表記が要るならビュー側の画面に出すか、`description` に含める。

### 6.4 game-sandbox.md の扱い — アーカイブとして残す

**削除しない。** CSP の実測（`worker-src` を書き忘れると `script-src` にフォールバックして
Worker 経由で外部通信できてしまう等）・opaque origin の16項目実測は、
撤去対象に紐づく知見だが**今後 iframe や CSP を触るときに再利用できる**。
冒頭に「本書は games-unified.md v0.2 により廃止された設計のアーカイブである」旨を明記し、
現行方針の参照先を本書に向ける。

---

## 7. 作り方ガイド

**まず §1.3 の3問に答える。** 答えによってどちらか一方の節だけを読めばよい。

### 7.1 クライアント専用ゲーム（C）の作り方

1. 作業ブランチを切る: `git switch -c feature/game-<id>`
2. **`public/room/games/<id>.js` を書く。** `_template.js` をコピーして始め、
   雑用は `./_client.js` の共通ヘルパー（`el` / `clear` など）を import して済ませる。
   ゲームのロジックはここに書く（普通のブラウザゲームと同じ）。
   サーバーから届く view は `{ seed, startedAt, players, events, ended }`（§2.8.2）。
   自分の playerId は `api.youId` から取る。
   参加者間で何か伝えたいときは `api.send(payload)`、受け取りは `view.events` を
   連番 `n` で差分適用する。
3. **画像などを使うなら `public/assets/games/<id>/` に置く。**
   参照は `/assets/games/<id>/<名前>.png` のような同一オリジンのパス。
   置いたら `public/assets/games/CREDITS.md` の表に**必ず**追記する（§2.8.4）。
4. **`server/games/index.ts` の `GAME_MODULES` に1行足す。**

   ```ts
   clientGame({
     id: "<id>",
     title: "…",
     description: "…",
     minPlayers: 1,
     maxPlayers: 10,
     relayLogMax: 12, // 参加者間の中継が要らないなら 0
   }),
   ```

   サーバーコードは**これだけ**。`server/games/<id>.ts` も
   `server/tests/games/<id>_test.ts` も要らない。
5. `deno task check` / `lint` / `fmt` を通す。
6. 実 Chrome **別ウィンドウ2窓**で2人プレイを確認する
   （同一ウィンドウ2タブは背面タブの rAF 間引きで検証にならない。
   game-sandbox.md §6.3 の実測知見を引き継ぐ）。
   一人用でも、途中参加・再接続・ホスト交代で画面が壊れないことは2窓で見る。
7. PR を作り、下のチェックリストを本文に貼って人間レビューを受ける。

**PR チェックリスト（C）**:

- [ ] ユーザー由来テキストは `textContent` のみ。`innerHTML` を使っていない
- [ ] 音を出していない（VC の会話にかぶせない）
- [ ] `unmount()` で setInterval / setTimeout / addEventListener / requestAnimationFrame を
      すべて解除している（ゲームは何度でも開始・終了される）
- [ ] 画像などの素材は `public/assets/games/<id>/` 配下に置いた
- [ ] `public/assets/games/CREDITS.md` を更新した。再配布ライセンスが不明な素材は入れていない
- [ ] **得点が公式スコア（卓の点数）に入らないことを画面に断っている**
- [ ] `api.send()` の payload が 4KB 以内で、連打しても毎秒 30 件を超えない
- [ ] `view.events` を連番 `n` で差分適用しており、同じイベントを二重に処理しない
- [ ] 途中参加・再接続で `events` が欠けても画面が壊れない
      （`relayLogMax` 件しか届かない。完全復元は保証されない）
- [ ] 乱数は `view.seed` 由来。全員の画面で一致すべきものに `Math.random()` を使っていない
- [ ] 他人の payload を「信頼できない外部データ」として扱っている（§9.3）
- [ ] 実 Chrome **別ウィンドウ2窓**で確認した

### 7.2 サーバーモジュール付きゲーム（M）の作り方

1. 作業ブランチを切る: `git switch -c feature/game-<id>`
2. `server/games/<id>.ts` を書く。雛形は `server/games/_template.ts` をコピーする。
   規約: 純粋関数・await 禁止・`Math.random()` / `Date.now()` 禁止（seed PRNG を使う）・
   `clientEvent.payload` は必ず先頭で型検証し、不正は `INVALID_INPUT` で棄却する。
3. `server/games/index.ts` の `GAME_MODULES` に1行追加する（カタログ登録はこれだけ）。
4. `server/tests/games/<id>_test.ts` を書く。最低限: 正常進行1本 / 不正 payload 棄却 /
   途中参加 / 切断・キック / `minPlayers` 未満での終了。
5. `public/room/games/<id>.js` を `_template.js` からコピーして書く。
   規約: `textContent` のみ・音を出さない・`unmount` で必ず片付ける・
   **勝敗や進行をクライアントで判断しない**（view に書いてあることだけを描く）。
6. `deno task check` / `lint` / `fmt` / `test` を通し、実 Chrome **別ウィンドウ2窓**で
   2人プレイを確認する。
7. PR を作り、下のチェックリストを本文に貼って人間レビューを受ける。

**PR チェックリスト（M）**:

- [ ] `clientEvent.payload` を型検証してから使っている（サイズ・範囲・列挙の妥当性）
- [ ] `init` / `reduce` / `view` に I/O・await・`Math.random()`・`Date.now()` が無い
- [ ] 秘密情報（正解・役職・他人の入力中の値）が `view` の受信者絞りで守られている
- [ ] `schedule` の予約が終了時に残らない（`ended` 後に発火しても無害）
- [ ] 途中参加・切断・再接続・キック・`minPlayers` 未満で落ちない（テストあり）
- [ ] ビューモジュールは `textContent` のみ・音なし・`unmount` で後始末
- [ ] 公式スコアへの反映（`score` 効果）が1ゲーム1回
- [ ] 別ウィンドウ2窓で対戦が成立することを確認した

---

## 8. 量産予定ゲームへの適用表

「基盤」列: **C** = クライアント専用（`clientGame`。サーバーコードを書かない）/
**P** = prompt（宣言的データの追加、または小拡張）/ **M** = 専用サーバーモジュール。
分類の根拠は §1.3 の3問。

| # | ゲーム | 基盤 | 3問のどれに当たるか / 必要な機能 | 状況 |
|---|---|---|---|---|
| 1 | 格付けクイズ | P | 既存 correct のお題追加のみ | **実装済み** |
| 2 | 多数派ゲーム | P拡張 | ② scoring `majority` を追加 | Phase 2 |
| 3 | 価値観アンケート | P拡張 | scoring `none`（採点なし・雑談燃料） | Phase 2 |
| 4 | ○×サドンデス | M | ② 脱落（elimination）と生存者表示 | Phase 2 |
| 5 | チキンレース | M | ①② 隠し同時提出 → 一斉公開 | **実装済み**（`chicken.ts`） |
| 6 | せーの!同時押し | M | ② サーバー基準時刻との差の計測 | Phase 2 |
| 7 | 早押しクイズ | M | ①② 到着順の回答権 + 誤答ロック | **実装済み**（`hayaoshi.ts`） |
| 8 | reflex 移植 | **C** | いいえ×3（順位は場の盛り上げ表示。§6.1） | Phase 2 |
| 9 | mogura 移植 | **C** | いいえ×3（seed で出現列を共有。§6.2） | Phase 2 |
| 10 | ワードウルフ | M | ① 秘密配布 + 議論タイマー + 投票 | **実装済み**（`wordwolf.ts`） |
| 11 | NGワードゲーム | M | ① 秘密配布（自分のは見えない）+ 申告 | Phase 3 |
| 12 | インサイダー風 | M | ① 秘密配布（内通者だけ正解を知る）+ 投票 | Phase 3 |
| 13 | エセ回答者 | M | ① 秘密配布（1人だけお題を知らない）+ 投票 | Phase 3 |
| 14 | ジェスチャー当て | M | ① 出題者だけに秘密お題（カメラは既存 VC 映像） | Phase 3 |
| 15 | ハミング当て | M | ① 同上（音は既存 VC 音声） | Phase 3 |
| 16 | 質問王 | M | ① 出題者だけに秘密お題 + Yes/No 応答 UI | Phase 3 |
| 17 | お絵かき当て | M | ①③ 描画中継 + 出題者秘密 + 回答判定 | **実装済み**（`draw.ts`） |
| 18 | 伝言お絵かき | M | ①③ 描画中継 + リレー順の個別配布 + 一斉公開 | Phase 4 |
| — | 絵合わせ（emoawase） | **C** | いいえ×3。画像アセット経路（§2.8.4）の実証を兼ねる | v0.2 で追加 |
| — | 画像を使ったカジュアルゲーム（枠） | **C** | いいえ×3。`public/assets/games/<id>/` に素材を置く | v0.2 で開通 |

- Phase 3 の秘密配布系は「秘密配布 + プレイヤー投票」の共通ヘルパーを
  `server/games/module.ts` に置いて量産する。
- 2 / 3 の scoring 追加は `ScoringMode` の変更（`types.ts` / `gamedef.ts`）を伴う。
  **スタジオ（投稿ゲーム）にも新 scoring を開放するか**は別判断（§10.2-3）。
- **C の枠は本数の上限を設けない。** 追加コストが「1ファイル + 1行」なので、
  量産計画の外で自由に足してよい（PR レビューは通す）。

---

## 9. セキュリティ・チート耐性

### 9.1 サーバー権威で守れるもの（M）

- **採点・進行・秘密**はサーバー state にのみ存在し、クライアントは view しか受け取らない。
  改造クライアントができるのは「不正な payload を送る」ことだけで、
  それはモジュールの型検証で `INVALID_INPUT` に落ちる。
- 公式スコア（`ScoreEntry` / `Player.score`）に算入できるのは **M だけ**である。

### 9.2 クライアント専用ゲーム（C）の信頼モデル

- **C はアプリのオリジンで動く。** iframe にも入れず、CSP も本体と同じものが適用される。
  隔離はしない。
- 代わりに、**ゲームを追加できるのはチームだけ**とする（オーナー判断）。
  コードはリポジトリに入り、**人間の PR レビュー（DoD）を通る**。
  これは `chat.js` / `vc.js` / `corridor.js` といった既存フロントコードと**同じ信頼水準**であり、
  ゲームだけを特別扱いしない。
- **ユーザー投稿にコード実行の経路は今後も作らない。** スタジオ（§3.5）が受け付けるのは
  宣言的データ（`GameDefinition`）のみで、投稿がモジュールやビューモジュールになる経路は無い。
  この一点が守られている限り、「悪意あるコードが常に入ってくる」前提は不要である。
  **将来ユーザー投稿のコード実行を検討するなら、game-sandbox.md（§6.4 のアーカイブ）に
  立ち返って隔離設計をやり直すこと。** C の経路をユーザー投稿に開放してはならない。
- **C はチート耐性を持たない。** 得点は自己申告であり、公式スコアに算入しない（§2.8.3）。
  「盛られた得点が卓の順位に効かない」ことが、この経路の唯一の防御線である。
- **フロントの無限ループ**は起きればそのタブのバグとして直す（既存フロント全般と同じ）。
  サーバー側は純粋関数 + レート制限で保護されており、1クライアントの暴走が
  ルーム全体を巻き込む経路は `gameEvent` のハード上限（切断）で塞ぐ。
- **タイミング系の公平性**（早押し・reflex）はサーバー到着順のため RTT の影響を受ける。
  §7 非機能要件（反映500ms以内・同一リージョン）の範囲では許容し、
  画面に「回線が速いと有利」の注記を出す（§10.2-6）。

### 9.3 入力検証・上限

- `gameEvent`（M / C 共通）: ソフト 30 件/秒（破棄。通知は判定窓1回）/
  ハード 150 件/秒（切断）/ payload 4KB【いずれも暫定値。§10.2-2】。
- **relay（C）の追加上限**: イベントログは `relayLogMax` 件（既定 32・最大 128）【暫定値】。
  超過は古い順に間引く。`0` を指定したゲームは `gameEvent` 自体を受け付けない。
  サーバーは payload を解釈しないが、**サイズ・件数・レートだけは必ず課す**。
  これがあるため、無解釈の保持・配信でもメモリと fan-out が発散しない。
- ビューモジュールの動的 import は `gameView.gameId`（サーバーのカタログ照合済み）
  のみから URL を組む。ユーザー入力からはパスを作らない。
- 表示は `textContent` のみ（§3.8）。ニックネーム・回答・お題などのユーザー由来文字列を
  `innerHTML` に入れない。**C では他人の payload も同様に扱う**——
  relay の payload はサーバーが検証していないので、
  ビュー側で「信頼できない外部データ」として型・範囲を確かめてから使うこと。
- 画像アセットは同一オリジン配信のみ（`img-src 'self' data:`）。
  外部 URL の画像・CDN は使わない（CSP で弾かれるうえ、CLAUDE.md の方針にも反する）。

---

## 10. 段階的実装計画（PR 分割）と未決事項

### 10.1 PR 分割

| PR | 内容 | 主な変更ファイル | 状況 |
|---|---|---|---|
| 1 | v0.1 設計書（方針変更 + types.ts 変更の合意） | docs のみ | **完了** |
| 2 | モジュール介面 + prompt アダプタ（挙動不変） | `server/games/module.ts`・`prompt.ts`・`index.ts`、`rooms.ts`、`types.ts` | **完了** |
| 3 | 専用モジュール4本（chicken / hayaoshi / wordwolf / draw）+ ビューローダー + 雛形2種 | `server/games/`、`public/room/games/`、`public/app.js` | **完了** |
| 4 | **本書（v0.2）**+ `clientGame` ファクトリ + 共通ヘルパー + `public/assets/games/` | 本書、`server/games/client.ts`、`server/games/index.ts`、`public/room/games/_client.js`、`public/assets/games/CREDITS.md` | 進行中（`feature/client-games`） |
| 5 | reflex / mogura を C として移植（§6.1 / §6.2）+ 画像ゲーム1本（絵合わせ）で経路を実証 | `public/room/games/`、`public/assets/games/`、`server/games/index.ts` | 進行中（PR 4 と同ブランチ） |
| 6 | sandbox UI 導線の除去 | `public/app.js`、`public/room/sandbox.js` | 次 |
| 7 | sandbox 撤去（削除のみの単独 PR。§6-5 の一覧） | types / rooms / main / public/sandbox / public/games ほか | 次 |
| 8〜 | §8 の Phase 2〜4 を順に量産（1 PR = 1〜4本） | `server/games/`・`public/room/games/` | 以降 |

PR 5 と PR 7 の順序は入れ替えない。**受け皿（C）で reflex / mogura が動くことを確認してから
サンドボックスを消す**（§6 の原則）。

### 10.2 未決事項

| # | 内容 | 判断者 | 状況 |
|---|---|---|---|
| 1 | v0.1 の方針変更（サンドボックス廃止・モジュール統一） | オーナー + チーム | **解決: 承認済み。実装も PR 2 / 3 で完了** |
| 2 | `gameEvent` のレート・payload 上限【暫定値】と負荷試験の要否 | チーム | 未決（relay の `CLIENT_RELAY_LOG_DEFAULT` = 32 / `CLIENT_RELAY_LOG_MAX` = 128 も同じ枠で判断する） |
| 3 | scoring `majority` / `none` をスタジオ（投稿ゲーム）にも開放するか（§8） | チーム | 未決 |
| 4 | `submitInput` / `submitVote` / `phase` 系を最終的に `gameEvent` / `gameView` に統合するか | チーム | 未決（当面は prompt 専用として維持） |
| 5 | `minPlayers: 1` を認めるか（エンジン共通 `MIN_PLAYERS = 2` のモジュール宣言による上書き） | オーナー | **解決: `GameModuleMeta.minPlayers`（1..10）として実装済み。mogura は `minPlayers: 1` で移植する** |
| 6 | タイミング系ゲームの公平性の扱い（サーバー到着順 + 注記で足りるか） | チーム | 未決 |
| 7 | sandbox 撤去（PR 7）の実施時期とバックアップ方法（削除前ブランチ or タグ） | オーナー | 未決 |
| 8 | `public/room/games/` と `public/assets/games/` の担当。全体設計書 §3 の担当表に行が無い | オーナー | 未決（C の追加が誰でもできる分、担当表への明記が要る） |
| 9 | iOS Safari での動的 `import()` とビューモジュールの動作確認 | チーム | 未決（corridor の実績はあるがゲーム UI としては未検証） |
| 10 | **クライアント専用ゲームの方式**（`clientGame` + 上限つきイベントログ。§2.8） | オーナー + チーム | 本書の PR のマージをもって合意とする |
| 11 | relay のログ上限（既定 32・最大 128）で足りるか。足りないゲームが出たときに上限を上げるか、M へ移すか | チーム | 未決（**方針としては M へ移す**。§2.8.2 の限界） |
| 12 | 画像素材の調達方針（配布元・ライセンス・クレジット表記を出す場所） | オーナー | 未決（`public/assets/sound/CREDITS.md` のポケットサウンドと同じ宿題を抱えないこと） |
