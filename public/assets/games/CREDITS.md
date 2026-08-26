# ゲーム用アセットの出典と利用条件

`public/assets/games/` は、クライアント専用ゲーム（設計書 `docs/design/games-unified.md`）が
使う画像・データの置き場である。書式と方針は `public/assets/sound/CREDITS.md` に合わせている。

## 置き方の規約

```
public/assets/games/<ゲームID>/<名前>.svg|png|jpg|webp
```

- **ディレクトリ名はゲームID**（`public/room/games/<ゲームID>.js` と一致させる）。
  どのゲームがどの素材を使っているかが、置き場だけで分かるようにする。
- ゲームからは `/assets/games/<ゲームID>/<名前>.svg` で読む。
  本体の CSP は `img-src 'self' data:` なので、**同一オリジンの画像は追加設定なしで**
  `<img>` からも canvas の `drawImage` からも読める（`server/main.ts` の `SECURITY_HEADERS`）。
  配信は `@std/http` の `serveDir` が `public/` 配下をそのまま返すので、
  サーバー側に足す設定は何も無い。
- **複数のゲームで共有する素材は作らない。** 使い回したくなったらコピーする。
  共有すると「片方のゲームを消したら、もう片方の絵が消えた」が起きる。
- 1ファイルは【暫定値】200KB 以内を目安にする。ベクタで済むものは SVG にする。

## ライセンスの扱い（**必ず読むこと**）

- **再配布の可否が確認できない素材は置かない。** 「たぶん大丈夫」で入れない。
  リポジトリは GitHub 上で公開しており、置いた時点で再配布に当たる。
- 外部の素材を足したら、**下の表に必ず1行足す**。表に無い素材は「出典不明」であり、
  レビューで差し戻す。
- 生成 AI の出力・検索で拾った画像・フリー素材サイトの素材は、**配布元の規約を読み、
  再配布（リポジトリ同梱・GitHub 公開）が許されていることを確認してから**入れる。
- クレジット表記が必須の素材は、表記を出す場所が無いうちは入れない
  （効果音で同じ宿題が残っている。`public/assets/sound/CREDITS.md` 参照）。

## 使用中のもの

| ディレクトリ | ファイル | 使う場所 | 出典・ライセンス |
|---|---|---|---|
| `emoawase/` | `tokkuri.svg` `ochoko.svg` `edamame.svg` `yakitori.svg` `chochin.svg` `yunomi.svg` `back.svg` | 絵合わせ（`public/room/games/emoawase.js`） | **このリポジトリの自作**（手書きの SVG パス。外部素材を含まない）。リポジトリの MIT ライセンスに従う |
