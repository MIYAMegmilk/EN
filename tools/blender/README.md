# 居酒屋の 3D モデル

個室（座敷）と、卓を選ぶための廊下の2本立て。

## 1. 個室 — `izakaya_room.py`

部屋リストページを Google ストリートビュー風に歩かせるための、個室（6畳・座敷）のモデル。

### 中身

| ファイル | 用途 |
| --- | --- |
| `izakaya_room.py` | ビルドスクリプト。これ1本で全部組み上がる |
| `izakaya_room.blend` | 上を流したあとの Blender ファイル |
| `../../public/assets/3d/izakaya_room.glb` | 個室のみ（廊下ぬき）。three.js 用 |
| `../../public/assets/3d/izakaya_room_with_corridor.glb` | 廊下つき。入口の導線ごと使う場合 |
| `../../public/assets/3d/pano_*.jpg` | 360度パノラマ（4096×2048、equirectangular） |

### 作り直す

Blender 4.5 の Scripting タブで:

```python
exec(open(r"C:\myproject\jigintern\EN\tools\blender\izakaya_room.py", encoding="utf-8").read())
```

`main()` が走って `IzakayaRoom` コレクションを作り直す。何度流しても同じ結果になる。
コレクションの外に手で置いた物は消えない。

寸法や配置はスクリプト冒頭の定数（`ROOM_W` / `TBL_X` / `PANO_NODES` など）で変える。

### パノラマを焼き直す

360度は **Cycles でしか焼けない**。EEVEE はパノラマカメラを無視して通常投影に落ちる。

```python
render_panos(r"C:\path\to\out", width=4096, samples=96)
```

`PANO_NODES` に定義した3地点（廊下 → 敷居の内側 → 室内）をまとめて出す。
RTX 3060 で 4096×2048 / 64 サンプルが1枚あたり 75〜90 秒ほど。

### 部屋の作り

- 内寸 3.64m × 2.73m × 高さ 2.40m。ちょうど6畳で、畳は祝儀敷き（四隅が十字に集まらない並び）
- **-Y** = 入口。襖2枚のうち左を引き開けてあり、その先に廊下を一区画だけ張ってある
- **+Y** = 障子窓。外に発光面を置いて夜の灯りが透ける
- **-X** = 短冊メニュー・呼び出しボタン・コート掛け
- **+X** = 床の間（掛け軸・一升瓶・花入れ）
- 座卓 + 座布団6枚、卓上は土鍋・ジョッキ・徳利など
- 光源は提灯2つ（ポイントライト内蔵）＋ 天井際のフィル ＋ 廊下

### web に持っていくときの注意

- **手続き型テクスチャは glTF に出ない。** 壁の土壁感・畳目は Blender 内の Noise / Wave ノードで
  付けているので、GLB にすると単色になる。必要ならベイクするか、タイル画像に差し替える
- **エリアライトは glTF 非対応。** 提灯のポイントライトだけが出る。書き出し時に警告が出るのは想定どおり
- 6,136 三角形 / 25 マテリアルと軽いので、モバイルでもそのまま置ける
- パノラマ方式なら GLB は不要。JPEG を球の内側に貼るだけで済み、こちらのほうが圧倒的に軽い

---

## 2. 廊下の部品キット — `izakaya_kit.py`

卓が何百あっても歩けて、しかも**曲がり角・T字路・十字路・行き止まり**が出るようにするための部品。

廊下を1本道として作り置きすると、曲げたり分けたりするたびに形の種類が増える。
そこで正方形のマス目を考えて、

    床天井（どのマスにも置く） ＋ 各辺の壁（塞ぐ辺にだけ置く）

という足し算で組む。辺を開けるか塞ぐかを決めるだけで、直線も角もT字も十字も
行き止まりも同じ部品から出てくる。

| ファイル | 用途 |
| --- | --- |
| `izakaya_kit.py` | ビルドスクリプト |
| `izakaya_kit.blend` | 流したあとの Blender ファイル |
| `../../public/assets/3d/izakaya_corridor_kit.glb` | 部品一式（39KB / 668 三角形） |

### 作り直して書き出す

```python
exec(open(r"C:\myproject\jigintern\EN\tools\blender\izakaya_kit.py", encoding="utf-8").read())
export_kit(r"C:\myproject\jigintern\EN\public\assets\3d\izakaya_corridor_kit.glb")
```

`main()` は確認用に「直線・角・T字・十字・行き止まりが1枚に入る見本」（`SAMPLE`）も
組み立てる。`export_kit()` は部品だけを書き出すので混ざらない。

### フロントとの取り決め（変えると `corridor-view.js` が壊れる）

| 名前 | 値 |
| --- | --- |
| `CELL` | 3.00 m（マスの1辺） |
| `CORR_W` | 2.00 m（通り幅） |
| `CORR_H` | 2.35 m（天井高） |
| 目線 | 1.55 m |

部品は **+Y 側の辺を塞ぐ形**で作ってある。他の辺は Z 軸まわりに回して使う。
glTF に出すと Blender の +Y は three.js の -Z になるので、**+Y を「北」と読み替える**。

    +Y(北) = 0°  /  +X(東) = -90°  /  -Y(南) = 180°  /  -X(西) = +90°

隅柱は **+X+Y の1本だけ**入れてある。隅は4つのマスで共有するので、どのマスにも
四隅の柱を持たせると同じ場所に4本重なって面が喧嘩する。全マスを並べれば隣のマスの
柱が残り3隅を埋める。天井の梁も同じ理由で +X / +Y の辺にだけ置いている。

ノード名:

| ノード | フロントでの扱い |
| --- | --- |
| `Kit_Core` | 床・天井・隅柱・梁。どのマスにも1つ |
| `Kit_Wall` | 塞ぐ辺に置く、扉の無い壁 |
| `Kit_Door` | 塞ぐ辺に置く、扉つきの壁（下の子を持つ） |
| `Kit_Pendant` | 天井の灯り。マスによって間引く |
| └ `Door_Static` | 壁・鴨居・敷居・框・組子・木札の台。まとめて1つ |
| └ `Door_Paper` | 引き戸の紙。中の灯り |
| └ `Door_Sign` | 木札。**UV 0..1 の板**。canvas を貼って卓の情報を描く |
| └ `Door_Lantern` | 提灯。遠くからの空席サイン |
| └ `Door_Hit` | クリック判定の板。透明 |

**木札のテクスチャは `flipY = false` にすること。** glTF の UV は V が反転しており、
`CanvasTexture` の既定（`flipY = true`）のままだと二重に反転して札が上下逆さまになる。

---

## 3. 廊下ビュー（フロント）

- `public/assets/3d/corridor-view.js` … 本体。`createCorridorView(container, options)`
- `public/corridor.html` / `public/corridor.js` … 表示確認用の単体ページ
- `public/vendor/three/` … three.js（CSP が `script-src 'self'` なので自前で持つ）
- `tools/corridor-layout-check.js` … 間取り生成を机上で測る道具

```
deno task dev
→ http://localhost:8000/corridor.html?demo=1     （?demo=1 はサンプルの卓）
```

### 間取りの決め方

辺を1本ずつ独立に開け閉めすると、通路ではなく「柱の立った広間」になる。
廊下に見せるには**先に「通りになる行・列」を決めて**、その筋に沿った辺を開ける。
通りと通りが交差したところが十字路、片側が塞がればT字路、二方向だけ残れば角、
一方向だけなら行き止まり — と自然に出そろう。

開閉は座標から計算するハッシュで決めている。乱数表を持たないので、同じ場所へ戻れば
必ず同じ形になり、どれだけ歩いても地図を保持しなくてよい。判定を「マス」ではなく
**「辺」**に対して行うのが肝で、辺は隣り合う2マスで共有されるため、隣同士で
食い違うことが原理的に起きない。

3つの定数はこの組み合わせを測って選んだ:

```
P_STREET = 0.50   P_SEGMENT = 0.78   P_SHORTCUT = 0.14
→ 直線 29.1% / 角 10.3% / T字 22.1% / 十字 10.3% / 行き止まり 28.1%
→ 40万歩あるいて壁抜け0回・363マス到達（＝閉じ込められない）
```

**触るときは必ず `deno run tools/corridor-layout-check.js` で測ってから決めること。**
`P_SEGMENT` を 0.7 より下げると角は増えるが網が千切れ、歩ける範囲が半分以下に落ちる。

### 卓の割り当て

扉の位置（マス座標 ＋ どの辺か）から引いたハッシュで卓を選ぶ。扉のほうが卓より
ずっと多いので、歩き続ければ同じ卓に何度も出会う。**卓が少ないうちは近くに同じ卓が
並ぶことがある**が、これは「無限に広い場所に有限の卓を置く」以上避けられない。

### index.html に載せるとき

このビューは入店の経路を持たず、扉が押されたら `onEnter(code)` を呼ぶだけにしてある。
index.html に載せるなら、rooms.js が使っているのと同じ道（`#code` に入れて `#join` を
押す）に繋ぐ。WS の送信経路を1本に保つため、ここで別の送信を書かないこと。

```js
import { createCorridorView } from "/assets/3d/corridor-view.js";

const view = createCorridorView(document.getElementById("corridor"), {
  onEnter(code) {
    document.getElementById("code").value = code;   // rooms.js の enterRoom と同じ道
    document.getElementById("join").click();
  },
  onFocus(room) { /* aria-live に流す。canvas は読み上げられないため */ },
});
await view.ready;
view.setRooms(rooms, tagLabels);   // ポーリングのたびに呼んでよい
```

必要な変更は index.html 側に3つ:

1. 廊下を入れる箱（`<div id="corridor">`）と、一覧カードとの切り替え
2. `<script type="module" src="./assets/3d/corridor-view.js"></script>`
   （**インライン script は CSP で弾かれる**ので、配線も外部ファイルに置く）
3. rooms.js のポーリング結果を `view.setRooms()` にも渡す

一覧カードは残すこと。3D の canvas は読み上げられず、WebGL が無い環境もある。
`createCorridorView` は WebGL が使えないと例外を投げるので、そこでカード表示に倒せる。

---

## 4. 作りかけで捨てたもの

最初は「曲がり角の無い1本道の区画を、進行方向へ使い回す」形で作っていた。
曲がり角・T字路・十字路を入れる段で、区画を作り置きする方式では形の種類が増える一方だと
分かったため、いまのキットに作り替えた。

その頃の `izakaya_corridor.py` / `izakaya_corridor.blend` /
`izakaya_corridor_module.glb` は **commit していない**（作業機のディスクには残っている）。
必要になることは無いはずなので、追いかけなくてよい。
