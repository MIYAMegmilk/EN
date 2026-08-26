# CLAUDE.md

このリポジトリで Claude Code が守ること。

## 作業ボード — 着手前に「何を作るか」を表明する

チームで開発しているため、**同じ機能を2人が別々に作ってしまう事故**が実際に起きている。
それを防ぐために、VPS 上に小さな共有ボードを置いてある。

設計は [`docs/design/board.md`](docs/design/board.md)、設定手順は
[`tools/board/README.md`](tools/board/README.md)。

### 実装に着手する前に表明する

`PROJECT` 内のコードを書き始める前に、**必ず**次を実行すること。

```
deno run --allow-net --allow-read --allow-env tools/board/board.ts claim "<何を作るか>" --paths <触る予定のファイル>
```

例:

```
deno run --allow-net --allow-read --allow-env tools/board/board.ts claim "VC の画面共有" --paths public/room/vc.js,public/index.html --branch feature/vc-share
```

**`--paths` は必ず書くこと。** これがあると、他のメンバーが同じファイルを触ろうとしたときに
警告が出る。無いと重なりを検出できない。

### 着手前に他の人の作業を確認する

```
deno run --allow-net --allow-read --allow-env tools/board/board.ts list
```

**すでに誰かが同じものを作っていたら、実装を始める前にユーザーへ知らせること。**
勝手に重複して実装しない。

触る予定のファイルが決まっているなら、こちらのほうが確実:

```
deno run --allow-net --allow-read --allow-env tools/board/board.ts check <パス...>
```

他のメンバーの表明に加えて、**同じファイルを触っているオープン中の PR** も出る。
マージされたときに他人の PR を壊す事故は、これで気づける。

### 作業が終わったら

```
deno run --allow-net --allow-read --allow-env tools/board/board.ts done
```

**放置すると「古い表明」として残り続け、他のメンバーが「まだやっているのか」と誤解する。** PR
を出した時点、または作業を切り上げる時点で必ず片付けること。

### タスクのメモ

Issue にするほどでもない粒度のメモを置ける。

```
deno run --allow-net --allow-read --allow-env tools/board/board.ts task add "<やること>"
deno run --allow-net --allow-read --allow-env tools/board/board.ts task list
deno run --allow-net --allow-read --allow-env tools/board/board.ts task done <id>
```

正式な課題は GitHub Issues を使うこと。ボードのタスクはあくまで補助。

### 設定していない場合

`tools/board/.env` が無い、またはボードに繋がらないときは、**CLI が理由を表示して 終了コード 0
で終わる。** エラーとして扱わず、そのまま作業を続けてよい。

**ボードのために作業を止めないこと。** 運用のための道具が本業を止めるのは本末転倒。

ただし、その場合は **「ボードに表明できていないので、重複の確認は各自でお願いします」と
ユーザーに一言伝えること。**

### 秘密情報を書き込まない

表明のタイトル・メモ・タスクの本文は**全員が読める**。
トークン・パスワード・個人情報を書かないこと（サーバー側でも弾いているが、頼らないこと）。

### 人が見る画面

ボードはブラウザからも読める。URL は各自の `tools/board/.env` の `BOARD_URL`。
チーム全体の状況を見たいときはそちらが早い。
