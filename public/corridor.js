/**
 * 廊下ビューの入口。corridor.html と index.html の両方がこの1本を読む。
 *
 * 中身は corridor-ui.js にある。ここがやるのは「3D 本体をいつ読むか」だけ。
 *
 * corridor-view.js は three.js（vendor だけで約 750KB）と GLB を引き連れてくるので、
 * 静的 import にするとホームを開いた全員がそれを待たされる。ホームの既定は一覧なので、
 * 「店内を歩く」を選ばれて初めて動的 import する。
 *
 * 動的 import の先は同一オリジンの絶対パスなので、本番の CSP
 * （default-src 'self'／script-src は未指定なので default-src に従う）を通る。
 * インラインの importmap は 'unsafe-inline' が無いため使えない。
 */

import { mountCorridor } from "/assets/3d/corridor-ui.js";

mountCorridor({
  createView: async () => (await import("/assets/3d/corridor-view.js")).createCorridorView,
});
