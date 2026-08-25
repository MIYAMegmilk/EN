# three.js（vendoring）

廊下の 3D 表示（`/assets/3d/corridor-view.js`）で使う。

- バージョン: **0.185.1**
- 取得元: `https://unpkg.com/three@0.185.1/...`
  - `build/three.module.min.js`
  - `examples/jsm/loaders/GLTFLoader.js`
  - `examples/jsm/utils/BufferGeometryUtils.js`
  - `examples/jsm/utils/SkeletonUtils.js`

## なぜ CDN ではなく自前で持つのか

アプリの CSP は `default-src 'self'`（`server/main.ts` の `SECURITY_HEADERS`）で、
`script-src` はそこにフォールバックする。つまり **外部 CDN からは読めず、インライン
`<script>` も通らない**。en.css の冒頭にも同じことが書いてある。

## 加えた変更

CSP でインラインの `<script type="importmap">` が張れないため、bare specifier を
相対パスに書き換えてある。これだけで素の `<script type="module">` から読める。

```
} from 'three';                              → } from './three.module.min.js';
from '../utils/BufferGeometryUtils.js'       → from './BufferGeometryUtils.js'
from '../utils/SkeletonUtils.js'             → from './SkeletonUtils.js'
```

## 更新する

```sh
V=0.186.0   # 上げたいバージョン
cd public/vendor/three
curl -sS -o three.module.min.js   "https://unpkg.com/three@$V/build/three.module.min.js"
curl -sS -o GLTFLoader.js         "https://unpkg.com/three@$V/examples/jsm/loaders/GLTFLoader.js"
curl -sS -o BufferGeometryUtils.js "https://unpkg.com/three@$V/examples/jsm/utils/BufferGeometryUtils.js"
curl -sS -o SkeletonUtils.js      "https://unpkg.com/three@$V/examples/jsm/utils/SkeletonUtils.js"
sed -i "s|} from 'three';|} from './three.module.min.js';|" GLTFLoader.js BufferGeometryUtils.js SkeletonUtils.js
sed -i "s|from '../utils/BufferGeometryUtils.js'|from './BufferGeometryUtils.js'|" GLTFLoader.js
sed -i "s|from '../utils/SkeletonUtils.js'|from './SkeletonUtils.js'|" GLTFLoader.js
grep -c "from 'three'" *.js   # すべて 0 なら書き換え漏れなし
```
