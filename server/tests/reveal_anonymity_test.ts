/**
 * 匿名 reveal の身元秘匿（監査バグ H-3）の回帰テスト。
 *
 * 修正前は reveal:"anonymous" のゲームでも RevealEntry.playerId に本物の playerId が入り、
 * 並び順も公開値のハッシュ（hash32(`playerId:round:startedAt`)）で決まっていたため、
 * 改造クライアントは「どの回答を誰が書いたか」を完全に特定できた（詳細仕様書 §3.2 原則3 違反）。
 *
 * 修正後は次を満たす。
 *   - 匿名時の entry.playerId は、ラウンドごとに作り直す不透明トークン
 *   - 並び順もそのトークン順（クライアント既知の値からは再現できない）
 *   - 投票はトークンで受け、サーバー内部で本物の playerId に解決してから採点する
 *   - judge view の myVoteTargetId もトークン
 */

import { assert, assertEquals, assertFalse, assertNotEquals } from "@std/assert";
import {
  buildPhaseView,
  DEFAULT_PHASE_DURATIONS,
  type EnginePlayerInput,
  type EngineResult,
  reduce,
  type RevealTokenSource,
  startGame,
} from "../engine.ts";
import { ROOM_CAPACITY } from "../types.ts";
import type { GameDefinition, GameState, RevealEntry } from "../types.ts";

const T0 = 1_700_000_000_000;

/** テスト用のゲーム定義（既定は匿名・投票制。engine_test.ts と同じ形） */
function makeDef(over: Partial<GameDefinition> = {}): GameDefinition {
  return {
    id: "def-1",
    ownerId: "owner",
    title: "テスト",
    rounds: 1,
    inputType: "text",
    inputTimeSec: 30,
    reveal: "anonymous",
    scoring: "vote",
    prompts: [{ kind: "open", text: "お題1" }, { kind: "open", text: "お題2" }],
    ...over,
  };
}

/** テスト用の参加者を作る */
function players(...ids: string[]): EnginePlayerInput[] {
  return ids.map((id) => ({ id, nickname: `nick-${id}`, connected: true }));
}

/** ゲームを開始する（トークンは既定どおり暗号乱数） */
function start(def: GameDefinition, ids: string[], source?: RevealTokenSource): GameState {
  const res = source === undefined
    ? startGame(def, players(...ids), T0, DEFAULT_PHASE_DURATIONS)
    : startGame(def, players(...ids), T0, DEFAULT_PHASE_DURATIONS, source);
  assertEquals(res.error, undefined);
  return res.state;
}

/** フェーズを1段進める */
function skip(state: GameState, now = T0): GameState {
  const res = reduce(state, { t: "skipPhase", now });
  assertEquals(res.error, undefined);
  return res.state;
}

/** 全員が回答して judge まで進んだ状態を作る */
function toJudge(state: GameState, ids: string[], values?: string[]): GameState {
  let s = state.phase === "intro" ? skip(skip(state)) : skip(state); // -> input
  assertEquals(s.phase, "input");
  ids.forEach((id, i) => {
    const res = reduce(s, {
      t: "submitInput",
      playerId: id,
      value: values?.[i] ?? `ans-${id}`,
      now: T0 + i + 1,
    });
    assertEquals(res.error, undefined);
    s = res.state;
  });
  if (s.phase === "reveal") s = skip(s);
  assertEquals(s.phase, "judge");
  return s;
}

/** judge フェーズの entries を取り出す */
function entriesOf(state: GameState, viewerId: string): RevealEntry[] {
  const view = buildPhaseView(state, viewerId);
  assert(view.phase === "judge" || view.phase === "reveal", `想定外のフェーズ: ${view.phase}`);
  return view.phase === "judge" || view.phase === "reveal" ? view.entries : [];
}

/** judge view の myVoteTargetId を取り出す */
function myVoteTargetOf(state: GameState, viewerId: string): string | undefined {
  const view = buildPhaseView(state, viewerId);
  assertEquals(view.phase, "judge");
  return view.phase === "judge" ? view.myVoteTargetId : undefined;
}

/** 投票を1件流す */
function vote(state: GameState, voterId: string, target: string, now = T0): EngineResult {
  return reduce(state, { t: "submitVote", voterId, targetPlayerId: target, now });
}

/** 修正前の並び順（公開値だけで再現できてしまうハッシュ順）。テスト10 の比較対象 */
function legacyHash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 修正前のロジックで並べた playerId 列を作る */
function legacyOrder(ids: string[], round: number, startedAt: number): string[] {
  return [...ids].sort((a, b) => {
    const ha = legacyHash32(`${a}:${round}:${startedAt}`);
    const hb = legacyHash32(`${b}:${round}:${startedAt}`);
    if (ha !== hb) return ha - hb;
    return a < b ? -1 : 1;
  });
}

/** トークンから本物の playerId を引く（テスト側の照合用） */
function ownerOf(state: GameState, token: string): string | undefined {
  return Object.keys(state.revealTokens).find((id) => state.revealTokens[id] === token);
}

// ---------------------------------------------------------------------------
// 1. entry.playerId が実在の playerId と一致しない
// ---------------------------------------------------------------------------

Deno.test("H-3 (1) 匿名の reveal / judge の entry.playerId は実在の playerId と一致しない", () => {
  const ids = ["p-alice", "p-bob", "p-carol"];
  let s = start(makeDef(), ids);
  s = skip(skip(s)); // -> input
  ids.forEach((id, i) => {
    s = reduce(s, { t: "submitInput", playerId: id, value: `ans-${id}`, now: T0 + i }).state;
  });
  assertEquals(s.phase, "reveal");
  for (const e of entriesOf(s, "p-alice")) {
    assertFalse(ids.includes(e.playerId), `reveal に本物の playerId が出ている: ${e.playerId}`);
    assertEquals(e.nickname, undefined);
  }
  s = skip(s); // -> judge
  const judgeEntries = entriesOf(s, "p-alice");
  assertEquals(judgeEntries.length, 3);
  for (const e of judgeEntries) {
    assertFalse(ids.includes(e.playerId), `judge に本物の playerId が出ている: ${e.playerId}`);
    // 値は表示されるが、書いた人は分からない
    assert(ownerOf(s, e.playerId) !== undefined, "トークンが内部表に存在しない");
  }
});

// ---------------------------------------------------------------------------
// 2. ラウンドごとにトークンが変わる
// ---------------------------------------------------------------------------

Deno.test("H-3 (2) 同じプレイヤーのトークンはラウンド1と2で異なる", () => {
  const ids = ["a", "b"];
  let s = start(makeDef({ rounds: 2 }), ids);
  s = toJudge(s, ids);
  assertEquals(s.round, 1);
  const round1 = { ...s.revealTokens };
  s = vote(s, "a", round1["b"]).state;
  s = vote(s, "b", round1["a"]).state;
  assertEquals(s.phase, "roundResult");
  s = skip(s); // -> round 2 prompt
  assertEquals(s.round, 2);
  const round2 = { ...s.revealTokens };
  for (const id of ids) {
    assert(round2[id] !== undefined, `ラウンド2のトークンが無い: ${id}`);
    assertNotEquals(round2[id], round1[id], `${id} のトークンがラウンド間で使い回されている`);
  }
});

// ---------------------------------------------------------------------------
// 3. トークンはゲーム全体で重複しない
// ---------------------------------------------------------------------------

Deno.test("H-3 (3) ゲーム全体でトークンが重複しない", () => {
  const s = start(makeDef({ rounds: 10 }), ["a", "b", "c"]);
  const all = s.revealTokenPool.flat();
  assertEquals(all.length, 10 * ROOM_CAPACITY);
  assertEquals(new Set(all).size, all.length, "トークンが重複している");
  for (const token of all) assertEquals(token.length, 16); // 16進16文字 = 64bit
  // 生成器を省略した場合に固定値にならないこと（別ゲームでは必ず違う束になる）
  const other = start(makeDef({ rounds: 10 }), ["a", "b", "c"]);
  assertEquals(new Set([...all, ...other.revealTokenPool.flat()]).size, all.length * 2);
});

Deno.test("H-3 (3b) 生成器が重複を返しても、割り当てられるトークンは一意になる", () => {
  // わざと同じ値ばかり返す生成器を注入する（本番では暗号乱数なので起こらない）
  const source: RevealTokenSource = () => "same";
  const s = start(makeDef({ rounds: 3 }), ["a", "b"], source);
  const all = s.revealTokenPool.flat();
  assertEquals(new Set(all).size, all.length);
});

// ---------------------------------------------------------------------------
// 4. トークンで投票すると正しいプレイヤーに票が入る
// ---------------------------------------------------------------------------

Deno.test("H-3 (4) トークンで投票すると本人に得点が入る", () => {
  const ids = ["a", "b", "c"];
  let s = toJudge(start(makeDef(), ids), ids);
  const tokenC = s.revealTokens["c"];
  s = vote(s, "a", tokenC).state;
  assertEquals(s.votes["a"], "c", "state.votes には本物の playerId を入れる");
  const res = vote(s, "b", tokenC);
  assertEquals(res.error, undefined);
  const done = vote(res.state, "c", res.state.revealTokens["a"]);
  assertEquals(done.state.phase, "roundResult");
  const scores = done.state.lastScores;
  assertEquals(scores.find((x) => x.playerId === "c")?.roundScore, 2);
  assertEquals(scores.find((x) => x.playerId === "a")?.roundScore, 1);
  assertEquals(scores.find((x) => x.playerId === "b")?.roundScore, 0);
});

// ---------------------------------------------------------------------------
// 5-7. 不正な投票先はすべて弾く
// ---------------------------------------------------------------------------

Deno.test("H-3 (5) 本物の playerId で投票すると INVALID_INPUT で弾かれる", () => {
  const ids = ["a", "b", "c"];
  const s = toJudge(start(makeDef(), ids), ids);
  const res = vote(s, "a", "b");
  assertEquals(res.error, "INVALID_INPUT");
  assertEquals(res.changed, false);
  assertEquals(res.state.votes["a"], undefined);
});

Deno.test("H-3 (6) 前のラウンドのトークンでは投票できない", () => {
  const ids = ["a", "b"];
  let s = toJudge(start(makeDef({ rounds: 2 }), ids), ids);
  const staleTokenB = s.revealTokens["b"];
  s = vote(s, "a", staleTokenB).state;
  s = vote(s, "b", s.revealTokens["a"]).state;
  assertEquals(s.phase, "roundResult");
  s = skip(s); // -> round 2
  s = toJudge(s, ids);
  assertEquals(s.round, 2);
  const res = vote(s, "a", staleTokenB);
  assertEquals(res.error, "INVALID_INPUT");
  assertEquals(res.state.votes["a"], undefined);
  // 現ラウンドのトークンなら通る
  assertEquals(vote(s, "a", s.revealTokens["b"]).error, undefined);
});

Deno.test("H-3 (7) 自分のトークンには投票できない", () => {
  const ids = ["a", "b", "c"];
  const s = toJudge(start(makeDef(), ids), ids);
  const res = vote(s, "a", s.revealTokens["a"]);
  assertEquals(res.error, "INVALID_INPUT");
  assertEquals(res.message, "自分には投票できません");
});

// ---------------------------------------------------------------------------
// 8. myVoteTargetId
// ---------------------------------------------------------------------------

Deno.test("H-3 (8) myVoteTargetId は本物の playerId ではなくトークン", () => {
  const ids = ["a", "b", "c"];
  let s = toJudge(start(makeDef(), ids), ids);
  const tokenB = s.revealTokens["b"];
  s = vote(s, "a", tokenB).state;
  const mine = myVoteTargetOf(s, "a");
  assertEquals(mine, tokenB);
  assertFalse(ids.includes(mine ?? ""), "myVoteTargetId に本物の playerId が入っている");
  // 投票していない人には出ない
  assertEquals(myVoteTargetOf(s, "b"), undefined);
});

// ---------------------------------------------------------------------------
// 9. named は従来どおり
// ---------------------------------------------------------------------------

Deno.test('H-3 (9) reveal:"named" では本物の playerId と nickname を載せ、実IDで投票できる', () => {
  const ids = ["a", "b", "c"];
  let s = toJudge(start(makeDef({ reveal: "named" }), ids), ids);
  const entries = entriesOf(s, "a");
  assertEquals(entries.map((e) => e.playerId).sort(), ["a", "b", "c"]);
  assertEquals(entries.map((e) => e.nickname).sort(), ["nick-a", "nick-b", "nick-c"]);
  const res = vote(s, "a", "b");
  assertEquals(res.error, undefined);
  s = res.state;
  assertEquals(s.votes["a"], "b");
  assertEquals(myVoteTargetOf(s, "a"), "b");
});

// ---------------------------------------------------------------------------
// 10. 並び順から身元を再現できない
// ---------------------------------------------------------------------------

Deno.test("H-3 (10) 匿名時の並び順は修正前の公開ハッシュ順では再現できない", () => {
  const ids = ["p-alice", "p-bob", "p-carol", "p-dave", "p-erin", "p-frank"];
  const legacy = legacyOrder(ids, 1, T0).join(",");
  const seen = new Set<string>();
  let legacyMatches = 0;
  const trials = 30;
  for (let i = 0; i < trials; i++) {
    const s = toJudge(start(makeDef(), ids), ids);
    const order = entriesOf(s, "p-alice").map((e) => {
      const owner = ownerOf(s, e.playerId);
      assert(owner !== undefined, "トークンが解決できない");
      return owner;
    }).join(",");
    seen.add(order);
    if (order === legacy) legacyMatches++;
  }
  // 修正前は playerId・round・startedAt が同じなら毎回まったく同じ並びだった
  assert(seen.size > 1, "並び順が毎回同じ（公開値から再現できてしまう）");
  assert(
    legacyMatches < trials,
    "並び順が修正前の公開ハッシュ順と常に一致している",
  );
});

// ---------------------------------------------------------------------------
// 11-12. 参加者の増減
// ---------------------------------------------------------------------------

Deno.test("H-3 (11) 切断・キックが起きてもトークンの解決は壊れない", () => {
  const ids = ["a", "b", "c", "d"];
  let s = toJudge(start(makeDef(), ids), ids);
  const tokenB = s.revealTokens["b"];
  const tokenD = s.revealTokens["d"];
  // b が切断（在籍は続くので投票先として有効なまま）
  s = reduce(s, { t: "playerLeft", playerId: "b", now: T0 }).state;
  assertEquals(vote(s, "a", tokenB).state.votes["a"], "b");
  // d をキック（在籍から外れるので投票先にできない）
  s = reduce(s, { t: "playerKicked", playerId: "d", now: T0 }).state;
  assertEquals(vote(s, "a", tokenD).error, "INVALID_INPUT");
  // 残った相手へのトークン投票は通り続ける
  const res = vote(s, "a", s.revealTokens["c"]);
  assertEquals(res.error, undefined);
  assertEquals(res.state.votes["a"], "c");
});

Deno.test("H-3 (12) 途中参加者が昇格した次ラウンドにもトークンが割り当てられる", () => {
  let s = start(makeDef({ rounds: 2 }), ["a", "b"]);
  s = skip(skip(s)); // -> input（ラウンド1）
  s = reduce(s, { t: "playerJoined", playerId: "c", nickname: "nick-c", now: T0 }).state;
  assertEquals(s.participants["c"].role, "spectator");
  assertEquals(s.revealTokens["c"], undefined, "観戦中はトークンを配らない");
  s = reduce(s, { t: "submitInput", playerId: "a", value: "A", now: T0 + 1 }).state;
  s = reduce(s, { t: "submitInput", playerId: "b", value: "B", now: T0 + 2 }).state;
  s = skip(s); // reveal -> judge
  s = vote(s, "a", s.revealTokens["b"]).state;
  s = vote(s, "b", s.revealTokens["a"]).state;
  assertEquals(s.phase, "roundResult");
  s = skip(s); // -> ラウンド2（c が採点対象へ昇格）
  assertEquals(s.participants["c"].role, "player");
  const tokenC = s.revealTokens["c"];
  assert(typeof tokenC === "string" && tokenC.length > 0, "昇格した参加者にトークンが無い");
  s = toJudge(s, ["a", "b", "c"]);
  const entries = entriesOf(s, "a");
  assertEquals(entries.length, 3);
  assert(entries.some((e) => e.playerId === tokenC), "昇格した参加者の回答が entry に無い");
  // 昇格した c のトークンへ投票でき、票は c に入る
  const res = vote(s, "a", tokenC);
  assertEquals(res.error, undefined);
  assertEquals(res.state.votes["a"], "c");
  // c 自身もトークンで投票できる
  assertEquals(vote(res.state, "c", s.revealTokens["a"]).error, undefined);
});

// ---------------------------------------------------------------------------
// 13. 定員いっぱいでも枯渇しない
// ---------------------------------------------------------------------------

Deno.test("H-3 (13) 定員10人・全10ラウンドでもトークンが枯渇しない", () => {
  const ids = Array.from({ length: ROOM_CAPACITY }, (_, i) => `p${i}`);
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    let s = start(makeDef({ rounds: 10 }), ids);
    const usedTokens = new Set<string>();
    for (let round = 1; round <= 10; round++) {
      s = toJudge(s, ids);
      assertEquals(s.round, round);
      const entries = entriesOf(s, ids[0]);
      assertEquals(entries.length, ids.length);
      const owners = new Set<string>();
      for (const e of entries) {
        assertFalse(ids.includes(e.playerId), "本物の playerId が出ている");
        assertFalse(usedTokens.has(e.playerId), "トークンが使い回されている");
        usedTokens.add(e.playerId);
        const owner = ownerOf(s, e.playerId);
        assert(owner !== undefined, "トークンが解決できない");
        owners.add(owner);
      }
      assertEquals(owners.size, ids.length, "1ラウンドで同じ人が二重に出ている");
      // 全員が投票して roundResult へ
      for (const id of ids) {
        const target = id === ids[0] ? ids[1] : ids[0];
        const res = vote(s, id, s.revealTokens[target]);
        assertEquals(res.error, undefined);
        s = res.state;
      }
      assertEquals(s.phase, "roundResult");
      if (round < 10) s = skip(s);
    }
    assertEquals(usedTokens.size, ids.length * 10);
  } finally {
    console.warn = original;
  }
  assertEquals(warnings, [], "トークン不足の警告が出ている（設計上ここには来ない）");
});

// ---------------------------------------------------------------------------
// 14. トークンそのものが view に漏れない
// ---------------------------------------------------------------------------

Deno.test("H-3 (14) view には現ラウンド以外のトークンも内部フィールドも載らない", () => {
  const ids = ["a", "b", "c"];
  let s = toJudge(start(makeDef({ rounds: 3 }), ids), ids);
  s = vote(s, "a", s.revealTokens["b"]).state;
  const currentRound = new Set(Object.values(s.revealTokens));
  const otherRoundTokens = s.revealTokenPool.flat().filter((t) => !currentRound.has(t));
  for (const phase of ["reveal", "judge", "roundResult"] as const) {
    const state: GameState = { ...s, phase };
    for (const viewer of ids) {
      const json = JSON.stringify(buildPhaseView(state, viewer));
      assertFalse(json.includes("revealToken"), `${phase} に内部フィールド名が出ている`);
      for (const token of otherRoundTokens) {
        assertFalse(json.includes(token), `${phase} に他ラウンドのトークンが漏れている`);
      }
    }
  }
});
