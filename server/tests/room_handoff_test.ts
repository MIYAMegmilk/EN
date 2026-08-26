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
  /** 承認制（§3.1.1）。一覧に出す卓にだけ付く */
  entryMode?: "open" | "knock";
  /** 合言葉（§3.1）。招待制の卓にだけ付く */
  passphrase?: string;
};
type PendingJoinRoom = { roomCode: string };
type FakeSessionStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** room-handoff.js を偽の sessionStorage で読み込み、window.RoomHandoff を取り出す */
function load(sessionStorage: FakeSessionStorage): {
  setPendingCreateRoom(payload: PendingCreateRoom): void;
  consumePendingCreateRoom(): PendingCreateRoom | null;
  setPendingJoinRoom(payload: PendingJoinRoom): void;
  consumePendingJoinRoom(): PendingJoinRoom | null;
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
    // 渡されなければ既定の open。合言葉は付けていないので undefined のまま
    entryMode: "open",
    passphrase: undefined,
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

Deno.test("room-handoff.js: 承認制と合言葉をそのまま渡す（§3.1 / §3.1.1）", () => {
  const storage = fakeSessionStorage();
  const RoomHandoff = load(storage);
  RoomHandoff.setPendingCreateRoom({
    nickname: "ホスト太郎",
    visibility: "public",
    roomName: "金曜の反省会",
    tags: [],
    entryMode: "knock",
  });
  assertEquals(RoomHandoff.consumePendingCreateRoom()?.entryMode, "knock");

  RoomHandoff.setPendingCreateRoom({
    nickname: "ホスト太郎",
    visibility: "private",
    tags: [],
    passphrase: "さくら三番",
  });
  assertEquals(RoomHandoff.consumePendingCreateRoom()?.passphrase, "さくら三番");
});

Deno.test("room-handoff.js: 知らない entryMode は open に倒す（sessionStorage は書き換えられる）", () => {
  const RoomHandoff = load(
    fakeSessionStorage({
      "en:pendingCreateRoom": JSON.stringify({
        nickname: "x",
        visibility: "public",
        tags: [],
        entryMode: "invite-only",
      }),
    }),
  );
  assertEquals(RoomHandoff.consumePendingCreateRoom()?.entryMode, "open");
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

Deno.test("room-handoff.js: pendingJoinRoom も未保存なら null を返す", () => {
  const RoomHandoff = load(fakeSessionStorage());
  assertEquals(RoomHandoff.consumePendingJoinRoom(), null);
});

Deno.test("room-handoff.js: pendingJoinRoom を1回だけ読み戻せる", () => {
  const storage = fakeSessionStorage();
  const RoomHandoff = load(storage);
  RoomHandoff.setPendingJoinRoom({ roomCode: "482913" });
  assertEquals(RoomHandoff.consumePendingJoinRoom(), { roomCode: "482913" });
  // 2回目は消費済みなので null
  assertEquals(RoomHandoff.consumePendingJoinRoom(), null);
});

Deno.test("room-handoff.js: pendingCreateRoom と pendingJoinRoom は別キーで独立している", () => {
  const storage = fakeSessionStorage();
  const RoomHandoff = load(storage);
  RoomHandoff.setPendingCreateRoom({ nickname: "x", visibility: "private", tags: [] });
  RoomHandoff.setPendingJoinRoom({ roomCode: "482913" });
  // 片方を消費してももう片方は残る
  assertEquals(RoomHandoff.consumePendingJoinRoom(), { roomCode: "482913" });
  assertEquals(RoomHandoff.consumePendingCreateRoom()?.nickname, "x");
});

Deno.test("room-handoff.js: pendingJoinRoom の roomCode が文字列でなければ null を返す", () => {
  const RoomHandoff = load(
    fakeSessionStorage({ "en:pendingJoinRoom": JSON.stringify({ roomCode: 482913 }) }),
  );
  assertEquals(RoomHandoff.consumePendingJoinRoom(), null);
});

Deno.test("room-handoff.js: pendingJoinRoom の roomCode が空文字なら null を返す", () => {
  const RoomHandoff = load(
    fakeSessionStorage({ "en:pendingJoinRoom": JSON.stringify({ roomCode: "" }) }),
  );
  assertEquals(RoomHandoff.consumePendingJoinRoom(), null);
});

Deno.test("room-handoff.js: pendingJoinRoom も壊れたJSONなら null を返す", () => {
  const RoomHandoff = load(fakeSessionStorage({ "en:pendingJoinRoom": "not json" }));
  assertEquals(RoomHandoff.consumePendingJoinRoom(), null);
});

Deno.test("room-handoff.js: sessionStorage が例外を投げても setPendingJoinRoom は落ちない", () => {
  const throwing: FakeSessionStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {},
  };
  const RoomHandoff = load(throwing);
  RoomHandoff.setPendingJoinRoom({ roomCode: "482913" });
});
