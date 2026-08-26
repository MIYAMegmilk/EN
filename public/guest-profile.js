/**
 * ゲストの一時プロフィール（あだ名・趣味タグ）を sessionStorage に読み書きする。
 *
 * ログイン中ユーザーの軽量プロフィールはアカウントに保存される（PUT /api/profile）が、
 * ゲストはアカウントを持たないためサーバーには保存されない。ここではブラウザの
 * セッション（タブを閉じるまで）に限り一時的に保持し、entrance.html の編集UIと
 * index.html の入室欄への自動入力に使う（docs/spec/overall.md §3.0）。
 *
 * app.js は type="module" を付けない従来の <script> として読み込まれており
 * import 文が使えないため、rooms.js と同じ「IIFEで window にグローバル公開する」
 * パターンに従う。
 */

"use strict";

(function (global) {
  const STORAGE_KEY = "en:guestProfile";

  /** @typedef {{ nickname: string, tags: string[] }} GuestProfile */

  /** @returns {GuestProfile} 保存されていない・壊れている場合は空のプロフィールを返す（例外を投げない） */
  function getGuestProfile() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw === null) return { nickname: "", tags: [] };
      const parsed = JSON.parse(raw);
      const nickname = typeof parsed?.nickname === "string" ? parsed.nickname : "";
      const tags = Array.isArray(parsed?.tags) ? parsed.tags.filter((t) => typeof t === "string") : [];
      return { nickname, tags };
    } catch {
      return { nickname: "", tags: [] };
    }
  }

  /** @param {GuestProfile} profile 呼び出し側で trim・上限チェック済みの値を渡すこと */
  function setGuestProfile(profile) {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ nickname: profile.nickname, tags: profile.tags }),
      );
    } catch {
      // sessionStorage が使えない（プライベートブラウジング等）場合は諦める。
      // 次回同一セッションでの復元ができないだけで、実害はない
    }
  }

  global.GuestProfile = { getGuestProfile, setGuestProfile };
})(window);
