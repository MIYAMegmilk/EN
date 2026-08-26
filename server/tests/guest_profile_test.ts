/**
 * public/guest-profile.js の単体テスト。
 *
 * ブラウザ向けのファイルだが、触るブラウザ API は sessionStorage だけなので、
 * 偽物を渡せば素の JavaScript として Deno から直接実行できる
 * （server/tests/app_reconnect_test.ts と同じ手口）。
 */

import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const GUEST_PROFILE_JS = fromFileUrl(new URL("../../public/guest-profile.js", import.meta.url));
const source = await Deno.readTextFile(GUEST_PROFILE_JS);

type GuestProfile = { nickname: string; tags: string[] };
type FakeSessionStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** guest-profile.js を偽の sessionStorage で読み込み、window.GuestProfile を取り出す */
function load(sessionStorage: FakeSessionStorage): {
  getGuestProfile(): GuestProfile;
  setGuestProfile(profile: GuestProfile): void;
} {
  const fakeWindow: Record<string, unknown> = {};
  const factory = new Function(
    "window",
    "sessionStorage",
    `${source}\n; return window.GuestProfile;`,
  );
  return factory(fakeWindow, sessionStorage);
}

/** key→value の Map を裏に持つ、本物に近い挙動の偽 sessionStorage */
function fakeSessionStorage(initial: Record<string, string> = {}): FakeSessionStorage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

Deno.test("guest-profile.js: 未保存なら空のプロフィールを返す", () => {
  const GuestProfile = load(fakeSessionStorage());
  assertEquals(GuestProfile.getGuestProfile(), { nickname: "", tags: [] });
});

Deno.test("guest-profile.js: 壊れたJSONが入っていても空のプロフィールを返す", () => {
  const GuestProfile = load(fakeSessionStorage({ "en:guestProfile": "not json" }));
  assertEquals(GuestProfile.getGuestProfile(), { nickname: "", tags: [] });
});

Deno.test("guest-profile.js: 保存した値をそのまま読み戻せる", () => {
  const storage = fakeSessionStorage();
  const GuestProfile = load(storage);
  GuestProfile.setGuestProfile({ nickname: "ましろ", tags: ["game", "music"] });
  assertEquals(GuestProfile.getGuestProfile(), { nickname: "ましろ", tags: ["game", "music"] });
});

Deno.test("guest-profile.js: sessionStorage が例外を投げても getGuestProfile は空を返す", () => {
  const throwing: FakeSessionStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  const GuestProfile = load(throwing);
  assertEquals(GuestProfile.getGuestProfile(), { nickname: "", tags: [] });
});

Deno.test("guest-profile.js: sessionStorage が例外を投げても setGuestProfile は落ちない", () => {
  const throwing: FakeSessionStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("blocked");
    },
  };
  const GuestProfile = load(throwing);
  GuestProfile.setGuestProfile({ nickname: "たろう", tags: [] });
  // 例外を投げずにここまで到達すれば OK（アサーション自体は「落ちなかったこと」の確認）
});
