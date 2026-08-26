# 作業ボード（board） — CLI とフックの使い方

「誰がこれから何を作るか」を着手前に書き込み、**同じ機能を2人が作ってしまう事故**と、 **オープン中の
PR を壊すマージ**を防ぐための小さな運用ツール。 設計は
[`docs/design/board.md`](../../docs/design/board.md)。

このページは**各メンバーが自分の PC で設定するための手順書**。

- [1. 準備](#1-準備)
- [2. CLI の使い方](#2-cli-の使い方)
- [3. Claude Code のフックに登録する](#3-claude-code-のフックに登録する)
- [4. フックの動き](#4-フックの動き)
- [5. トークンの扱い（重要）](#5-トークンの扱い重要)
- [6. うまく動かないとき](#6-うまく動かないとき)
- [7. テスト](#7-テスト)
- [8. 管理者向け: トークンの発行](#8-管理者向け-トークンの発行)

---

## 1. 準備

### 1-1. 必要なもの

- **Deno**（`deno --version` が通ること）。PATH に無いとフックは黙って何もしない。
- **ボードのトークン**。管理者に発行してもらう（メンバーごとに別のトークン、§7-1）。

### 1-2. `.env` を作る

`tools/board/.env.example` を `tools/board/.env` にコピーして、2つの値を入れる。

```powershell
Copy-Item tools\board\.env.example tools\board\.env
notepad tools\board\.env
```

```dotenv
# ボードの URL（公開環境では https:// 必須。http:// は localhost のみ）
BOARD_URL=https://board.example.com
# 自分専用のトークン（他人に渡さない）
BOARD_TOKEN=enboard_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- `.env` は **`PROJECT/.gitignore` の `.env` で除外済み**。コミットされない。
- 一時的に上書きしたいときは環境変数 `BOARD_URL` / `BOARD_TOKEN` が `.env` より優先される。
- CLI は `.env` を**このファイル（`tools/board/board.ts`）の隣**から読む。
  どのディレクトリから実行しても同じ `.env` を見る。

### 1-3. 動作確認

```powershell
deno run --allow-net --allow-read --allow-env tools\board\board.ts list
```

表明一覧が出れば設定完了。設定が足りないときや、ボードに繋がらないときは、
**理由を表示して終了コード 0 で終わる**（作業を止めないため。詳細は §6）。

---

## 2. CLI の使い方

実行形式（長いので、PowerShell なら
`function board { deno run --allow-net --allow-read --allow-env tools\board\board.ts @args }`
のような関数を用意しておくと楽）:

```powershell
deno run --allow-net --allow-read --allow-env tools\board\board.ts <サブコマンド>
```

| コマンド           | 用途                                         |
| ------------------ | -------------------------------------------- |
| `claim <title>`    | これから作るものを表明する                   |
| `list`             | 現在の表明一覧を表示する                     |
| `check <paths...>` | 指定パスに重なる表明・オープン PR を確認する |
| `done`             | 自分の表明を完了にする（`--paused` で中断）  |
| `task add <title>` | タスクを追加する                             |
| `task list`        | タスク一覧                                   |
| `task done <id>`   | タスクを完了にする                           |

### claim — 表明する

```powershell
board.ts claim "VC ルームの画面共有" --paths server/rooms.ts,public/vc.js --branch feature/vc-share --pr 41 --note "音声から着手"
```

| オプション        | 内容                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `--paths a,b`     | 触る予定のファイル・ディレクトリ（カンマ区切り。繰り返し指定も可） |
| `--branch <name>` | 作業ブランチ名                                                     |
| `--pr <number>`   | 対応する PR 番号（`#41` でも可）                                   |
| `--note <text>`   | 補足                                                               |

- **`--paths` は書いたほうがよい。** 重なりの自動検出（フックの警告）が効くようになる。
- `--paths` を付けると、表明の直後にその場で重なりも確認して表示する。
- **`title` / `note` に秘密情報（トークン・パスワード等）を書かないこと**（§7-7）。
  サーバー側でもトークンらしき文字列は拒否される。

### list — 一覧

```
== 作業ボード: 現在の表明 (2件) ==
- [作業中] ちいかわ: VC ルームの画面共有 (10分前)
    ブランチ feature/vc-share / PR #41
    パス: server/rooms.ts, public/vc.js
- [作業中・古い] ひろし: コリドーの当たり判定 (10時間前)
※ 「古い」表明が 1件 あります（8時間以上更新なし）。放置かもしれません。
```

`[作業中・古い]` は、8時間（§5 の TTL）更新が無い表明。**自動では消さない**ので、 心当たりがあれば
`done` で片付ける。

### check — 重なりの確認

```powershell
board.ts check server/auth.ts public/profile.js
```

他のメンバーの表明と、**同じファイルを触っているオープン PR** を表示する。 PR
は5分ごとに取得したキャッシュなので、「いつ時点か」が併記される。

### done — 表明を終える

```powershell
board.ts done              # 完了にする
board.ts done --paused     # 中断にする（SessionEnd フックが使う）
```

このセッションの表明を探して状態を変える。表明が無ければ何もしない。

### task — タスク

```powershell
board.ts task add "VC の再接続を直す" --body "切断後に再入室できない" --assignee m2
board.ts task list
board.ts task done 01JTASK...
```

Issue にするほどでもない粒度のメモ用。**正式な課題は GitHub Issues を使う**（§2）。

### 共通オプション

| オプション       | 内容                                                       |
| ---------------- | ---------------------------------------------------------- |
| `--session <id>` | セッション識別子。フックが hook 入力の `session_id` を渡す |
| `--json`         | 結果を JSON1行で出す（フック用）                           |
| `--timeout <ms>` | 応答待ちの上限（既定 4000ms）                              |
| `-h`, `--help`   | ヘルプ                                                     |

`--session` を省いたときは `CLAUDE_SESSION_ID` → `BOARD_SESSION_ID` → `manual-<ユーザー名>`
の順で決まる。**手で表明したものは手で `done` する**のが基本。

### 終了コード

| コード | いつ                                                                |
| ------ | ------------------------------------------------------------------- |
| `0`    | 成功したとき／**ボードに繋がらないとき**／**`.env` が未設定のとき** |
| `1`    | 使い方が間違っているとき／ボードがエラー（401・500 等）を返したとき |

**繋がらないときに 0 で終わるのは意図的**。この CLI はフックから呼ばれるので、
ボードの不調で本業（編集・コミット）が止まってはいけない（§8）。

---

## 3. Claude Code のフックに登録する

`tools/board/hooks/` の PowerShell スクリプト3つを `settings.json` に登録する。

| フック                         | スクリプト                | 動き                                              |
| ------------------------------ | ------------------------- | ------------------------------------------------- |
| `SessionStart`                 | `board-session-start.ps1` | 表明一覧を取得してセッション冒頭に差し込む        |
| `PreToolUse`（`Edit`/`Write`） | `board-pre-tool-use.ps1`  | 未表明なら**最初の1回だけ**ブロック、重なりは警告 |
| `SessionEnd`                   | `board-session-end.ps1`   | 自分の表明を `paused` に落とす                    |

### 登録例（`c:\intern\.claude\settings.json`）

Claude Code を `c:\intern` で開いている場合。**既存の push ガードのエントリは消さずに、 `PreToolUse`
の配列に追記する**（下の例は追記後の全体）。

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "shell": "powershell",
            "command": "$d = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (Get-Location).Path }; & \"$d\\PROJECT\\tools\\board\\hooks\\board-session-start.ps1\"",
            "statusMessage": "作業ボードの表明一覧を取得中..."
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "shell": "powershell",
            "command": "$d = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (Get-Location).Path }; & \"$d\\tools\\hooks\\guard-git-push.ps1\"",
            "statusMessage": "push ガードを確認中..."
          }
        ]
      },
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "shell": "powershell",
            "command": "$d = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (Get-Location).Path }; & \"$d\\PROJECT\\tools\\board\\hooks\\board-pre-tool-use.ps1\"",
            "statusMessage": "作業ボードの表明を確認中..."
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "shell": "powershell",
            "command": "$d = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (Get-Location).Path }; & \"$d\\PROJECT\\tools\\board\\hooks\\board-session-end.ps1\""
          }
        ]
      }
    ]
  }
}
```

### Claude Code を `PROJECT` 直下で開いている場合

パスから `\\PROJECT` を取り除き、`PROJECT/.claude/settings.json` に同じ内容を書く。

```json
"command": "$d = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (Get-Location).Path }; & \"$d\\tools\\board\\hooks\\board-pre-tool-use.ps1\""
```

登録したら Claude Code を開き直し、`/hooks` で3つとも見えることを確認する。

---

## 4. フックの動き

### `SessionStart`

表明一覧を取得して `additionalContext` として差し込む。**作業を始める前に必ず目に入る。**
取得できなかったときは何も出さない。

### `PreToolUse`（`Edit` / `Write` / `MultiEdit` / `NotebookEdit`）

1. 編集対象のパスを取り出し、リポジトリルートからの相対パスに直す。
2. **セッション内で最初の編集**かどうかを、一時ディレクトリの印ファイル
   （`%TEMP%\claude-board\<session_id>.first-edit`）で判定する。
3. `board.ts check` を呼ぶ。
   - **最初の編集 かつ このセッションの表明が無い → ブロック**して表明を促す。
   - 表明済み、または2回目以降 → 通す。他人の表明・オープン PR と重なるときだけ警告を出す。

**ブロックは1セッションに1回だけ。** 編集のたびに止められると鬱陶しく、
フックごと無効化される。それでは何も残らない（§8）。印は `check`
を呼ぶ前に付けるので、その後で何が起きても2回目以降は決してブロックしない。
印はセッション終了時（`SessionEnd`）に片付けられる。

**重なりはブロックしない。** 2人で分担している正当なケースを機械が判別できないため、
警告して人間に委ねる。

### `SessionEnd`

このセッションの表明を `paused`（中断）に落とす。完了は本人が `done` で宣言する。

### 落ちても作業を止めない

**3つとも、どんな失敗をしても必ず終了コード 0 で終わる。**

- ボードに繋がらない／タイムアウト／`.env` 未設定／`deno` が PATH に無い → 素通り
- 応答が壊れている／想定外の例外 → 素通り
- 制限時間（CLI 側 3秒 + 外側 8秒）を超えたら子プロセスを止めて素通り

繋がらなかったことを知らせるのは「セッション最初の編集」のときだけ。 毎回言われると邪魔になるため。

---

## 5. トークンの扱い（重要）

- **トークンは各自が管理する。** 他人のトークンを借りない（誰の表明か分からなくなる）。
- **git に入れない。** 値を書くのは `tools/board/.env` だけ。`.env.example` は空のまま。
- **貼らない。** チャット・Issue・PR・ログ・スクリーンショットに出さない。
- CLI はトークンを `Authorization: Bearer` ヘッダー以外に載せず、**画面にも出さない。**
  万一サーバーの応答に混ざっていても `***` に伏せて表示する（§7-4）。
- **平文 HTTP には送らない。** `BOARD_URL` が `http://`（localhost 以外）なら、 CLI
  は通信せずに警告して終わる（§7-8）。
- 漏らしたかもしれないときは、**黙って様子を見ずに管理者へ連絡して再発行**する。
  サーバーにはハッシュしか無いので、再発行以外に回復手段は無い（§7-2）。

---

## 6. うまく動かないとき

| 症状                                    | 見るところ                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `BOARD_URL と BOARD_TOKEN が未設定です` | `tools/board/.env` があるか。値が空でないか                                 |
| `平文 HTTP です`                        | `BOARD_URL` を `https://` にする（localhost は例外）                        |
| `ボードが 401 を返しました`             | トークンが古い可能性。管理者に再発行を依頼する（値は貼らない）              |
| `作業ボードに繋がりませんでした`        | ボードが停止中かもしれない。**作業はそのまま続けてよい**                    |
| フックが何も言わない                    | `deno --version` が通るか。`/hooks` に登録されているか。`.env` があるか     |
| フックが遅い                            | `deno` の起動に1秒前後かかる。CLI 側は3秒で見切る                           |
| 何度もブロックされる                    | 印ファイル（`%TEMP%\claude-board\`）を作れていない可能性。TEMP の権限を確認 |

手で確かめるとき（フックと同じ問い合わせ）:

```powershell
deno run --allow-net --allow-read --allow-env tools\board\board.ts check server\auth.ts --json
```

---

## 7. テスト

```powershell
deno check server/ tools/board/
deno lint tools/board/
deno fmt --check tools/board/
deno test -A
```

`tools/board/board_test.ts` は**ネットワークに出ない**（`fetch` を注入し、偽の応答を返す）。
とくに「**繋がらないときに終了コード 0 で終わること**」と「**トークンが出力に現れないこと**」を
検証している。

PowerShell スクリプトの構文確認（実行はしない）:

```powershell
Get-ChildItem tools\board\hooks -Filter *.ps1 | ForEach-Object {
  $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$errs)
  if ($errs) { "NG $($_.Name)" } else { "OK $($_.Name)" }
}
```

`tools/board/admin_test.ts`（管理用 CLI）は、**発行したトークンで実際に認証が通ること**と、 **KV
ファイルに平文のトークンが1バイトも残っていないこと**、**`list` にトークンもハッシュも
出ないこと**を検証している。

---

## 8. 管理者向け: トークンの発行

**この節はサーバー管理者だけが読めばよい。** メンバーのトークンを発行するのは
`tools/board/admin.ts`（管理用 CLI）で、**VPS 上で管理者が手で叩く**。

管理用の HTTP API は用意していない。公開インターネット上に「メンバーを増やせる口」を
晒さないため、KV を直接触るこの CLI だけを入口にしている（§7）。

### 8-1. 前提

- **`BOARD_KV_PATH` を `board.service` と同じ値にする。** 違う値を指すと、サーバーが見ていない別の
  KV に登録してしまい、発行したトークンで認証が通らない。
- **`board.service` は止めなくてよい。** Deno KV（SQLite）は同じファイルを複数のプロセスから
  開ける。開けなかったときは理由と確認事項を表示して終了コード 1 で終わる。
- **`board.service` と同じユーザーで実行する**（KV ファイルの読み書き権限のため）。

### 8-2. コマンド

```bash
cd /path/to/PROJECT   # deno.json のあるディレクトリ
export BOARD_KV_PATH=/var/lib/board/board.kv

deno run --unstable-kv --allow-env --allow-read --allow-write=/var/lib/board \
  tools/board/admin.ts <コマンド>
```

| コマンド            | 用途                                                   |
| ------------------- | ------------------------------------------------------ |
| `add <id> <表示名>` | メンバーを登録し、**トークンを1回だけ表示する**        |
| `list`              | 登録済みメンバーの一覧（トークン・ハッシュは出さない） |
| `reissue <id>`      | トークンを再発行する（旧トークンは即座に失効）         |
| `-h`, `--help`      | ヘルプ                                                 |

- `id` … 英数字で始まり、英数字・ハイフン・アンダースコア（32文字まで）。 表明の `member`
  や一覧にそのまま出る値なので、日本語のあだ名は**表示名のほう**に書く。
- `表示名` … 画面や CLI に出るあだ名。日本語可（40文字まで）。

### 8-3. add — メンバーを登録してトークンを発行する

```bash
deno run --unstable-kv --allow-env --allow-read --allow-write=/var/lib/board \
  tools/board/admin.ts add chiikawa ちいかわ
```

```
== メンバーを登録しました ==
  id     : chiikawa
  表示名 : ちいかわ

発行したトークン（次の1行がトークンそのもの）:

enboard_（ここに43文字のトークンが1行で出る）

！ この値が表示されるのは、いまのこの1回だけです。
   KV にはハッシュしか保存していないため、あとから取り出すことはできません。
   閉じる前に本人へ渡してください（紛失したら reissue で再発行するしかありません）。
！ 他人に渡さないこと。チャット・Issue・PR・コミット・ログ・スクリーンショットに
   貼らないこと。渡すのは本人にだけ、本人しか読めない経路で（§7-3 / §7-4）。

受け取った本人は tools/board/.env に次のように書きます（値は上の1行をそのまま貼る）:

  BOARD_URL=https://board.example.com
  BOARD_TOKEN=<上の1行>

   ※ .env は PROJECT/.gitignore で除外済み。git には決して入れないこと。
```

- **トークンは単独の1行**に出る。その行をそのまま選択してコピーする。
- **この1回しか表示されない。** KV にはハッシュしか保存しないため、後から取り出せない（§7-2）。
- **既に居る id には登録できない。** 黙って上書きすると既存メンバーのトークンが無言で失効する
  ため、拒否して `reissue` を案内する（終了コード 1・**何も変更しない**）。
- 渡したあとは、**端末の履歴やスクロールバックにトークンが残っていないか**を確認する。

### 8-4. list — 誰が登録されているか

```bash
deno run --unstable-kv --allow-env --allow-read --allow-write=/var/lib/board \
  tools/board/admin.ts list
```

```
== 登録済みメンバー (2件) ==
- chiikawa  ちいかわ
- hiroshi   ひろし
※ トークンとそのハッシュは表示しません（保存しているのはハッシュだけで、
   平文は復元できません。渡し忘れたときは reissue で発行し直してください）。
```

**トークンもハッシュも決して表示しない。** 「渡し忘れた」「本人が失くした」ときにできるのは
再発行だけで、既存の値を確認する手段は無い（それが §7-2 の狙い）。

### 8-5. reissue — 再発行する

紛失・漏洩の疑い・端末の紛失など、**そのメンバーのトークンを無効にしたいとき**に使う。

```bash
deno run --unstable-kv --allow-env --allow-read --allow-write=/var/lib/board \
  tools/board/admin.ts reissue chiikawa
```

出力は `add` とほぼ同じで、冒頭に「古いトークンは、いまこの瞬間に失効しました」が付く。
**新しいトークンだけを表示する**（旧トークンは出さない）。

- 実行した瞬間に旧トークンは使えなくなる。本人が `.env` を更新するまで、その人の CLI と
  フックはボードに繋がらない（フックは素通りするので**本業は止まらない**）。
- `id` と表示名は引き継がれる。表明やタスクもそのまま残る。

### 8-6. 終了コード

| コード | いつ                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------- |
| `0`    | 登録・一覧・再発行に成功したとき／`--help`                                                               |
| `1`    | 使い方の誤り／不正な `id`／既に居る `id` への `add`／未登録の `id` への `reissue`／**KV を開けないとき** |

KV を開けないときは、`BOARD_KV_PATH` の値・実行ユーザーの権限・`--allow-read` / `--allow-write` /
`--unstable-kv` の指定を確認する（メッセージにも列挙される）。

### 8-7. 管理者が守ること

- **トークンをこの CLI の外へ出さない。** `add` / `reissue` の出力をファイルへリダイレクトしたり、
  ログに残したりしない。
- **チャット・Issue・PR に貼らない。** 渡すのは本人にだけ、本人しか読めない経路で。
- 「漏らしたかもしれない」と相談されたら、**様子を見ずにすぐ `reissue`** する。 サーバーには
  ハッシュしか無いので、再発行以外に手当ての方法は無い（§7-2）。
