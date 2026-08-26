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
