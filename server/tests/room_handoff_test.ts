/**
 * public/room-handoff.js の単体テスト。
 *
 * ブラウザ向けのファイルだが、触るブラウザ API は sessionStorage だけなので、
 * 偽物を渡せば素の JavaScript として Deno から直接実行できる
 * （server/tests/guest_profile_test.ts と同じ手口）。
 */

import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const ROOM_HANDOFF_JS = fromFileUrl(new URL("../../public/room-handoff.js", import.meta.url));
const source = await Deno.readTextFile(ROOM_HANDOFF_JS);

type PendingCreateRoom = {
  nickname: string;
  visibility: "public" | "private";
  roomName?: string;
  description?: string;
  tags: string[];
};
type FakeSessionStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** room-handoff.js を偽の sessionStorage で読み込み、window.RoomHandoff を取り出す */
function load(sessionStorage: FakeSessionStorage): {
  setPendingCreateRoom(payload: PendingCreateRoom): void;
  consumePendingCreateRoom(): PendingCreateRoom | null;
} {
  const fakeWindow: Record<string, unknown> = {};
  const factory = new Function(
    "window",
    "sessionStorage",
    `${source}\n; return window.RoomHandoff;`,
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
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

Deno.test("room-handoff.js: 未保存なら null を返す", () => {
  const RoomHandoff = load(fakeSessionStorage());
  assertEquals(RoomHandoff.consumePendingCreateRoom(), null);
});

Deno.test("room-handoff.js: 保存した値を1回だけ読み戻せる", () => {
  const storage = fakeSessionStorage();
  const RoomHandoff = load(storage);
  RoomHandoff.setPendingCreateRoom({
    nickname: "ホスト太郎",
    visibility: "public",
    roomName: "金曜の反省会",
    description: "今夜は焼酎の会です",
    tags: ["drink"],
  });
  assertEquals(RoomHandoff.consumePendingCreateRoom(), {
    nickname: "ホスト太郎",
    visibility: "public",
    roomName: "金曜の反省会",
    description: "今夜は焼酎の会です",
    tags: ["drink"],
  });
  // 2回目は消費済みなので null
  assertEquals(RoomHandoff.consumePendingCreateRoom(), null);
});

Deno.test("room-handoff.js: private のとき roomName/description は省略できる", () => {
  const storage = fakeSessionStorage();
  const RoomHandoff = load(storage);
  RoomHandoff.setPendingCreateRoom({
    nickname: "ホスト太郎",
    visibility: "private",
    tags: [],
  });
  const result = RoomHandoff.consumePendingCreateRoom();
  assertEquals(result?.nickname, "ホスト太郎");
  assertEquals(result?.visibility, "private");
  assertEquals(result?.roomName, undefined);
  assertEquals(result?.tags, []);
});

Deno.test("room-handoff.js: 壊れたJSONが入っていても null を返す", () => {
  const RoomHandoff = load(fakeSessionStorage({ "en:pendingCreateRoom": "not json" }));
  assertEquals(RoomHandoff.consumePendingCreateRoom(), null);
});

Deno.test("room-handoff.js: nickname が文字列でなければ null を返す", () => {
  const RoomHandoff = load(
    fakeSessionStorage({
      "en:pendingCreateRoom": JSON.stringify({ visibility: "public", tags: [] }),
    }),
  );
  assertEquals(RoomHandoff.consumePendingCreateRoom(), null);
});

Deno.test("room-handoff.js: visibility が public/private 以外なら null を返す", () => {
  const RoomHandoff = load(
    fakeSessionStorage({
      "en:pendingCreateRoom": JSON.stringify({ nickname: "x", visibility: "secret", tags: [] }),
    }),
  );
  assertEquals(RoomHandoff.consumePendingCreateRoom(), null);
});

Deno.test("room-handoff.js: sessionStorage が例外を投げても consumePendingCreateRoom は null を返す", () => {
  const throwing: FakeSessionStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  const RoomHandoff = load(throwing);
  assertEquals(RoomHandoff.consumePendingCreateRoom(), null);
});

Deno.test("room-handoff.js: sessionStorage が例外を投げても setPendingCreateRoom は落ちない", () => {
  const throwing: FakeSessionStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {},
  };
  const RoomHandoff = load(throwing);
  RoomHandoff.setPendingCreateRoom({ nickname: "x", visibility: "private", tags: [] });
});
