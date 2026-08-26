/**
 * entrance.html（正確には create-room.html / corridor.html）から index.html への
 * 「卓を建てる」「卓に入る」橋渡し。index.html は別ページなので、内容を
 * sessionStorage に一度だけ書き込み・一度だけ読み取って即クリアする
 * （consume 方式で、リロード時の多重発火を防ぐ）。
 *
 * app.js は type="module" を付けない従来の <script> として読み込まれており
 * import 文が使えないため、rooms.js / guest-profile.js と同じ「IIFEで
 * window にグローバル公開する」パターンに従う（corridor.js は type="module" だが、
 * モジュールからも window のグローバルはそのまま参照できる）。
 */

"use strict";

(function (global) {
  const STORAGE_KEY = "en:pendingCreateRoom";
  const JOIN_STORAGE_KEY = "en:pendingJoinRoom";

  /**
   * @typedef {{
   *   nickname: string,
   *   visibility: "public" | "private",
   *   roomName?: string,
   *   description?: string,
   *   tags: string[],
   * }} PendingCreateRoom
   */

  /** @param {PendingCreateRoom} payload */
  function setPendingCreateRoom(payload) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // 書き込めなくても index.html 側は「自動作成なし」の通常フローに
      // 落ちるだけでよい（consumePendingCreateRoom が null を返す）
    }
  }

  /**
   * 読み取ってすぐ消す（多重発火防止）。無い・壊れている場合は null。
   * @returns {PendingCreateRoom | null}
   */
  function consumePendingCreateRoom() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw === null) return null;
      sessionStorage.removeItem(STORAGE_KEY);
      const parsed = JSON.parse(raw);
      if (typeof parsed?.nickname !== "string") return null;
      if (parsed.visibility !== "public" && parsed.visibility !== "private") return null;
      return {
        nickname: parsed.nickname,
        visibility: parsed.visibility,
        roomName: typeof parsed.roomName === "string" ? parsed.roomName : undefined,
        description: typeof parsed.description === "string" ? parsed.description : undefined,
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === "string") : [],
      };
    } catch {
      return null;
    }
  }

  /**
   * @typedef {{ roomCode: string }} PendingJoinRoom
   */

  /**
   * @param {PendingJoinRoom} payload あだ名は集めない。join はあだ名が空欄でも
   *   サーバーが自動で二つ名を付ける既存の仕様（§3.10）に乗る
   */
  function setPendingJoinRoom(payload) {
    try {
      sessionStorage.setItem(JOIN_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // 書き込めなくても index.html 側は「自動入室なし」の通常フローに
      // 落ちるだけでよい（consumePendingJoinRoom が null を返す）
    }
  }

  /**
   * 読み取ってすぐ消す（多重発火防止）。無い・壊れている場合は null。
   * @returns {PendingJoinRoom | null}
   */
  function consumePendingJoinRoom() {
    try {
      const raw = sessionStorage.getItem(JOIN_STORAGE_KEY);
      if (raw === null) return null;
      sessionStorage.removeItem(JOIN_STORAGE_KEY);
      const parsed = JSON.parse(raw);
      if (typeof parsed?.roomCode !== "string" || parsed.roomCode === "") return null;
      return { roomCode: parsed.roomCode };
    } catch {
      return null;
    }
  }

  global.RoomHandoff = {
    setPendingCreateRoom,
    consumePendingCreateRoom,
    setPendingJoinRoom,
    consumePendingJoinRoom,
  };
})(window);
