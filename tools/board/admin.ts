/**
 * 作業ボード（board）の管理用 CLI（docs/design/board.md §7-1 / §7-2 / §10）
 *
 *   admin.ts add <id> <表示名>   … メンバーを登録し、トークンを1回だけ表示する
 *   admin.ts list                … 登録済みメンバーの一覧（ハッシュは出さない）
 *   admin.ts reissue <id>        … トークンを再発行する（旧トークンは失効）
 *
 * **これはサーバー管理者が VPS 上で手で叩くための道具**であり、ネットワークには一切出ない。
 * `BOARD_KV_PATH` の KV を直接開いて `BoardAuth` を呼ぶ（HTTP 越しの管理 API は作らない。
 * 公開インターネット上に「メンバーを増やせる口」を晒さないため、§7）。
 *
 * 設計上の約束:
 *
 *   - **認証まわりのロジックはここに書かない。** トークンの生成・ハッシュ化・保存はすべて
 *     `auth.ts` の `BoardAuth`（`registerMember` / `reissueToken` / `listMembers`）に任せる。
 *     このファイルは引数の解析と出力の整形しかしない。
 *   - **トークンを `console` に出すのは `add` / `reissue` の発行結果ただ1箇所だけ**（§7-4）。
 *     エラー・ヘルプ・`list` には一切出さない。`.env` の記入例にも実物は埋め込まない
 *     （同じ値を2回出すと、片方だけを消して安心する事故が起きるため）。
 *   - **既存のトークンを黙って上書きしない。** `add` で既存 id を指定したら何も書かずに拒否し、
 *     `reissue` を案内する（`BoardAuth.registerMember` が atomic に弾く。§7-2）。
 *   - **サーバーを止めずに実行できる。** Deno KV（SQLite）は同じファイルを複数のプロセスから
 *     開けるので `board.service` は動かしたままでよい。開けなかったときは理由を示して終了コード 1。
 *
 * §3 のとおり board は EN 本体と完全に独立させるため、`server/` からは何も import しない。
 *
 * 実行例（VPS 上、リポジトリのルートで）:
 *   BOARD_KV_PATH=/var/lib/board/board.kv \
 *   deno run --unstable-kv --allow-env --allow-read --allow-write=/var/lib/board \
 *     tools/board/admin.ts add chiikawa ちいかわ
 */

import { BoardAuth } from "./auth.ts";
import type { MemberPublic } from "./types.ts";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** KV ファイルの場所を指す環境変数。**サーバー（server.ts の main）と同じ流儀** */
export const ENV_KV_PATH = "BOARD_KV_PATH";

/**
 * メンバー識別子に使ってよい文字。
 *
 * 英数字で始まり、以降は英数字・`-`・`_` のみ。日本語や空白・記号を弾くのは、この値が
 *   - KV のキー（`["boardMember", id]`）
 *   - CLI / 画面の一覧表示
 *   - 表明の `member`
 * にそのまま出るためで、見た目が紛らわしい id（前後の空白や全角空白を含むもの）を作らせない。
 * 表示名は自由文でよいので、日本語のあだ名はそちらに書く。
 */
export const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** メンバー識別子の最大長。KV のキーとして扱う値なので常識的な長さに抑える */
export const MEMBER_ID_MAX_LENGTH = 32;

/** 表示名の最大長。一覧の1行に収まる範囲に抑える */
export const DISPLAY_NAME_MAX_LENGTH = 40;

/** ヘルプや案内に出す実行形式（長いので1箇所にまとめる） */
export const INVOKE_HINT =
  "deno run --unstable-kv --allow-env --allow-read --allow-write tools/board/admin.ts";

// ---------------------------------------------------------------------------
// 引数の解析
// ---------------------------------------------------------------------------

/** 解析済みのサブコマンド */
export type AdminCommand =
  | { kind: "help" }
  | { kind: "add"; id: string; displayName: string }
  | { kind: "list" }
  | { kind: "reissue"; id: string };

/** 引数の解析結果。使い方の誤りは例外ではなく値で返す（テストしやすさのため） */
export type ParsedAdminArgs =
  | { ok: true; command: AdminCommand }
  | { ok: false; message: string };

/** 検証の結果 */
type Validation = { ok: true } | { ok: false; message: string };

/**
 * メンバー識別子を検証する。
 * **不正な値をそのままエラーメッセージに出さない**（長大な入力で画面を埋められないよう）。
 */
export function validateMemberId(id: string): Validation {
  if (id === "") return { ok: false, message: "id が空です。" };
  if (id.length > MEMBER_ID_MAX_LENGTH) {
    return { ok: false, message: `id が長すぎます（${MEMBER_ID_MAX_LENGTH}文字まで）。` };
  }
  if (!MEMBER_ID_PATTERN.test(id)) {
    return {
      ok: false,
      message: "id は英数字で始まり、英数字・ハイフン・アンダースコアだけで書いてください" +
        "（日本語のあだ名は表示名のほうに書く）。",
    };
  }
  return { ok: true };
}

/** 表示名を検証する。制御文字・改行は一覧の整形を壊すので弾く */
export function validateDisplayName(name: string): Validation {
  if (name === "") return { ok: false, message: "表示名が空です。" };
  if (name.length > DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, message: `表示名が長すぎます（${DISPLAY_NAME_MAX_LENGTH}文字まで）。` };
  }
  const codes = [...name].map((ch) => ch.codePointAt(0) ?? 0);
  if (codes.some((code) => code < 0x20 || code === 0x7f)) {
    return { ok: false, message: "表示名に改行や制御文字は使えません。" };
  }
  return { ok: true };
}

/**
 * コマンドライン引数を解析する（副作用なし。純関数）。
 *
 * 値を取るオプションは無いので、`-` で始まる引数は `--help` / `-h` 以外すべて誤りとする。
 * 黙って無視すると「指定したのに効かない」事故になる（board.ts と同じ方針）。
 */
export function parseArgs(argv: readonly string[]): ParsedAdminArgs {
  const positionals: string[] = [];
  let help = false;

  for (const arg of argv) {
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    return { ok: false, message: `不明なオプション: ${arg}` };
  }

  if (help || positionals.length === 0) return { ok: true, command: { kind: "help" } };

  const sub = positionals[0];
  const rest = positionals.slice(1);

  switch (sub) {
    case "help":
      return { ok: true, command: { kind: "help" } };

    case "add": {
      const id = (rest[0] ?? "").trim();
      // 表示名は空白を含んでよい（引用符を付け忘れても拾えるように残りを連結する）
      const displayName = rest.slice(1).join(" ").trim();
      if (id === "" || displayName === "") {
        return {
          ok: false,
          message: `add には id と表示名が必要です（例: ${INVOKE_HINT} add chiikawa ちいかわ）。`,
        };
      }
      const idCheck = validateMemberId(id);
      if (!idCheck.ok) return { ok: false, message: idCheck.message };
      const nameCheck = validateDisplayName(displayName);
      if (!nameCheck.ok) return { ok: false, message: nameCheck.message };
      return { ok: true, command: { kind: "add", id, displayName } };
    }

    case "list":
      if (rest.length > 0) return { ok: false, message: "list は引数を取りません。" };
      return { ok: true, command: { kind: "list" } };

    case "reissue": {
      const id = (rest[0] ?? "").trim();
      if (id === "") {
        return {
          ok: false,
          message: `reissue には対象の id が必要です（例: ${INVOKE_HINT} reissue chiikawa）。`,
        };
      }
      if (rest.length > 1) return { ok: false, message: "reissue の引数は id 1つだけです。" };
      const idCheck = validateMemberId(id);
      if (!idCheck.ok) return { ok: false, message: idCheck.message };
      return { ok: true, command: { kind: "reissue", id } };
    }

    default:
      return { ok: false, message: `不明なサブコマンド: ${sub}` };
  }
}

// ---------------------------------------------------------------------------
// 出力の整形
// ---------------------------------------------------------------------------

/** ヘルプ本文。**トークンの実物はもちろん、例にも本物らしい値を書かない** */
export const HELP = `作業ボード 管理 CLI （docs/design/board.md §7）

メンバーのトークンを発行するための、サーバー管理者用のコマンド。
${ENV_KV_PATH} が指す KV を直接読み書きする（ネットワークには出ない）。

使い方: ${INVOKE_HINT} <コマンド>

  add <id> <表示名>    メンバーを登録し、トークンを1回だけ表示する
  list                 登録済みメンバーの一覧（トークン・ハッシュは表示しない）
  reissue <id>         トークンを再発行する（そのメンバーの旧トークンは即座に失効）
  -h, --help           このヘルプ

  id      … 英数字で始まり、英数字・ハイフン・アンダースコア（${MEMBER_ID_MAX_LENGTH}文字まで）
  表示名  … 画面や CLI に出るあだ名。日本語可（${DISPLAY_NAME_MAX_LENGTH}文字まで）

例:
  ${INVOKE_HINT} add chiikawa ちいかわ
  ${INVOKE_HINT} list
  ${INVOKE_HINT} reissue chiikawa

トークンについて（重要）:
  - 発行時の1回しか表示されない。KV にはハッシュしか保存しないため、後から取り出せない
  - 紛失したら回復ではなく reissue で再発行する（旧トークンは失効する）
  - 既存の id に add はできない（既存のトークンを黙って無効にしないため）。付け替えは reissue

環境変数:
  ${ENV_KV_PATH}   KV ファイルのパス。board.service と同じ値を指定すること
                     （違う値だと、サーバーが見ていない別の KV に登録してしまう）

board.service は止めなくてよい（Deno KV は同じファイルを複数のプロセスから開ける）。

終了コード: 0 = 成功 / 1 = 使い方の誤り・重複・該当なし・KV を開けなかったとき`;

/**
 * 発行したトークンの表示（**この関数だけがトークンの値を含む文字列を作る**、§7-2 / §7-4）。
 *
 * 約束:
 *   - トークンは**単独の1行**に置く。前後に何も付けない（そのまま選択してコピーできるように）
 *   - `.env` の記入例には実物を埋め込まず `<上の1行>` と書く。**値は出力全体で1回だけ**
 *   - 「二度と表示されない」「他人に渡さない」「貼らない」を必ず添える
 */
export function formatIssuedToken(
  kind: "add" | "reissue",
  member: MemberPublic,
  token: string,
): string {
  const lines = kind === "add"
    ? ["== メンバーを登録しました =="]
    : ["== トークンを再発行しました =="];
  lines.push(`  id     : ${member.id}`, `  表示名 : ${member.displayName}`, "");
  if (kind === "reissue") {
    lines.push("このメンバーの古いトークンは、いまこの瞬間に失効しました。", "");
  }
  lines.push(
    "発行したトークン（次の1行がトークンそのもの）:",
    "",
    token,
    "",
    "！ この値が表示されるのは、いまのこの1回だけです。",
    "   KV にはハッシュしか保存していないため、あとから取り出すことはできません。",
    "   閉じる前に本人へ渡してください（紛失したら reissue で再発行するしかありません）。",
    "！ 他人に渡さないこと。チャット・Issue・PR・コミット・ログ・スクリーンショットに",
    "   貼らないこと。渡すのは本人にだけ、本人しか読めない経路で（§7-3 / §7-4）。",
    "",
    "受け取った本人は tools/board/.env に次のように書きます（値は上の1行をそのまま貼る）:",
    "",
    "  BOARD_URL=https://board.example.com",
    "  BOARD_TOKEN=<上の1行>",
    "",
    "   ※ .env は PROJECT/.gitignore で除外済み。git には決して入れないこと。",
  );
  return lines.join("\n");
}

/**
 * メンバー一覧の表示。
 * **トークンもハッシュも出さない。** `BoardAuth.listMembers()` が返すのは `MemberPublic`
 * （id と表示名だけ）なので、そもそもこの関数はハッシュを受け取れない（型で保証している）。
 */
export function formatMemberList(members: readonly MemberPublic[]): string {
  if (members.length === 0) {
    return "== 登録済みメンバー ==\n" +
      `まだ誰も登録されていません（${INVOKE_HINT} add <id> <表示名> で登録する）。`;
  }
  const sorted = [...members].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const width = Math.max(...sorted.map((m) => m.id.length));
  const lines = [`== 登録済みメンバー (${sorted.length}件) ==`];
  for (const m of sorted) lines.push(`- ${m.id.padEnd(width)}  ${m.displayName}`);
  lines.push("※ トークンとそのハッシュは表示しません（保存しているのはハッシュだけで、");
  lines.push("   平文は復元できません。渡し忘れたときは reissue で発行し直してください）。");
  return lines.join("\n");
}

/** KV を開けなかったときの案内。**推測させず、確認すべき点を並べる** */
export function formatKvOpenError(kvPath: string | undefined, detail: string): string {
  const target = kvPath === undefined || kvPath.trim() === ""
    ? `${ENV_KV_PATH} が未設定のため、Deno の既定の場所を開こうとしました`
    : `${ENV_KV_PATH}=${kvPath}`;
  return [
    "KV を開けませんでした。メンバーの登録・一覧・再発行はできません。",
    `  対象: ${target}`,
    `  詳細: ${detail}`,
    "",
    "確認すること:",
    `  - ${ENV_KV_PATH} が board.service と同じ値になっているか`,
    "  - board.service と同じユーザーで実行しているか（KV ファイルの読み書き権限）",
    "  - --allow-read / --allow-write を KV の置き場所に対して渡しているか",
    "  - --unstable-kv を付けているか（リポジトリのルートで実行すれば deno.json が面倒を見る）",
    "",
    "※ board.service を止める必要はありません。",
    "   Deno KV（SQLite）は同じファイルを複数のプロセスから開けます。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

/** 入出力の差し替え口（テストは文字列を集める） */
export type AdminIo = { out: (text: string) => void; err: (text: string) => void };

/** KV を開く関数。テストは一時ファイルを開く物に差し替える */
export type OpenKv = (path: string | undefined) => Promise<Deno.Kv>;

/** `runAdmin` に渡す依存 */
export type AdminDeps = {
  argv: readonly string[];
  io: AdminIo;
  /** `BOARD_KV_PATH` の値（未設定なら undefined） */
  kvPath: string | undefined;
  openKv: OpenKv;
};

/**
 * 管理 CLI 本体。**終了コードを返す**（プロセスは呼び出し側で終える）。
 *
 *   0 … 成功、ヘルプ
 *   1 … 使い方の誤り、id の重複、該当なし、書き込みの競合、KV を開けなかったとき
 *
 * board.ts（メンバー用 CLI）が「繋がらなくても 0 で終わる」のと逆に、こちらは**失敗を必ず
 * 非 0 で伝える**。フックから呼ばれることは無く、管理者が結果を見て次の手を決めるため、
 * 「登録できていないのに成功に見える」ほうが危ない。
 */
export async function runAdmin(deps: AdminDeps): Promise<number> {
  const parsed = parseArgs(deps.argv);
  if (!parsed.ok) {
    deps.io.err(`${parsed.message}\n\n${HELP}`);
    return 1;
  }
  const command = parsed.command;
  if (command.kind === "help") {
    deps.io.out(HELP);
    return 0;
  }

  let kv: Deno.Kv;
  try {
    kv = await deps.openKv(deps.kvPath);
  } catch (e) {
    deps.io.err(formatKvOpenError(deps.kvPath, e instanceof Error ? e.message : String(e)));
    return 1;
  }

  const auth = new BoardAuth(kv);
  try {
    switch (command.kind) {
      case "add": {
        const result = await auth.registerMember(command.id, command.displayName);
        if (!result.ok) {
          deps.io.err(
            [
              `id「${command.id}」は既に登録されています。何も変更していません。`,
              "既存メンバーのトークンはそのまま有効です。",
              "",
              "付け替えたい（本人が紛失した・漏らしたかもしれない）ときは reissue を使います:",
              `  ${INVOKE_HINT} reissue ${command.id}`,
              "登録済みの id は list で確認できます:",
              `  ${INVOKE_HINT} list`,
            ].join("\n"),
          );
          return 1;
        }
        deps.io.out(formatIssuedToken("add", result.member, result.token));
        return 0;
      }

      case "list": {
        deps.io.out(formatMemberList(await auth.listMembers()));
        return 0;
      }

      case "reissue": {
        const result = await auth.reissueToken(command.id);
        if (!result.ok) {
          if (result.reason === "notFound") {
            deps.io.err(
              [
                `id「${command.id}」のメンバーは登録されていません。何も変更していません。`,
                "登録済みの id は list で確認できます:",
                `  ${INVOKE_HINT} list`,
                "新しく登録するなら add を使います:",
                `  ${INVOKE_HINT} add ${command.id} <表示名>`,
              ].join("\n"),
            );
          } else {
            deps.io.err(
              [
                "ほかの書き込みと競合したため、再発行しませんでした。" +
                "トークンは変わっていません（旧トークンは有効なままです）。",
                "同時に別の再発行が走っていないか確認して、もう一度実行してください。",
              ].join("\n"),
            );
          }
          return 1;
        }
        deps.io.out(formatIssuedToken("reissue", result.member, result.token));
        return 0;
      }
    }
  } finally {
    auth.dispose();
    kv.close();
  }
}

if (import.meta.main) {
  // `Deno.env.get` は --allow-env が無ければ例外になる。ここで握りつぶすと
  // **既定の（サーバーとは別の）KV に登録してしまう**ので、あえて素通しにする。
  const code = await runAdmin({
    argv: Deno.args,
    io: { out: (text) => console.log(text), err: (text) => console.error(text) },
    kvPath: Deno.env.get(ENV_KV_PATH),
    openKv: (path) => Deno.openKv(path),
  });
  Deno.exit(code);
}
