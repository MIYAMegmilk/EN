/**
 * 作業ボード（board）共通型定義
 * docs/design/board.md の §4（データモデル）/ §5（期限切れ）/ §6（API）/ §7（認証と秘密情報の保護）
 * / §9（GitHub API 連携）に対応する。
 *
 * このファイルは board サービスの担当（サーバー / CLI / フック / 画面）が共有する契約。
 * §3 のとおり board は EN 本体と完全に独立させるため、`server/` からは何も import しない
 * （型の重複より、EN が落ちてもボードが動く独立性を優先する）。
 */

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/**
 * 表明が「古い」と見なされるまでの時間（ミリ秒、§5 の「TTL = 8時間」）。
 * `heartbeatAt` からこれを過ぎた `working` は一覧で区別して表示する。
 * §5 のとおり**サーバー側で自動削除はしない**。あくまで表示上の区別。
 */
export const CLAIM_TTL_MS = 8 * 60 * 60 * 1000;

/** PR 索引を GitHub から取り直す間隔（ミリ秒、§9 の「5分」） */
export const PR_INDEX_REFRESH_MS = 5 * 60_000;

/**
 * リクエストボディの受理上限（バイト、§7-8「リクエストボディのサイズ上限を設ける」）。
 * 【暫定値】。設計書に具体値の指定が無いため、表明・タスクの本文（自由文）に対して
 * 十分すぎる 64KB を置いた。EN 本体の GAME_DEFINITION_BYTES_MAX と同じ桁で揃えてある。
 */
export const BOARD_REQUEST_BODY_MAX_BYTES = 64 * 1024;

/**
 * Deno KV のキー先頭要素（§3 のとおり KV ファイルは EN とは別に分ける）。
 * 撤去時（§10）に消す対象がここを見れば分かるよう、1箇所に集めておく。
 */
export const KV_PREFIX = {
  /** `["boardMember", memberId]` → Member */
  member: "boardMember",
  /** `["boardClaim", claimId]` → Claim */
  claim: "boardClaim",
  /** `["boardTask", taskId]` → Task */
  task: "boardTask",
  /** `["boardPrIndex", prNumber]` → PrIndex */
  prIndex: "boardPrIndex",
} as const;

// ---------------------------------------------------------------------------
// §4 データモデル
// ---------------------------------------------------------------------------

/**
 * メンバー。KV `["boardMember", id]` に保存する（§7-1 / §7-2）。
 *
 * **平文のトークンは保存しない。** 保存するのは SHA-256 ハッシュと表示名だけで、
 * 万一 KV の中身が漏れてもトークンそのものは復元できない（§7-2）。
 * 紛失時は回復ではなく再発行する。
 */
export type Member = {
  /** メンバー識別子。表明の `member` はこの値を指す。一意 */
  id: string;
  /** 画面や CLI に出す表示名（ちいかわ / ひろし / みつお）。サーバー側で持つ（§7-1） */
  displayName: string;
  /**
   * トークンの SHA-256 ハッシュ（base64url）。**平文は決して保存しない**（§7-2）。
   * この値も API 応答・画面・ログには出さない（外に出すのは MemberPublic だけ）。
   */
  tokenHash: string;
  /** 発行時刻（epoch ms） */
  createdAt: number;
};

/**
 * メンバーのうち、API 応答・画面・ログに出してよい部分。
 * `tokenHash` を含めないことを型で保証するために分けてある（§7-2 / §7-4）。
 */
export type MemberPublic = {
  /** メンバー識別子 */
  id: string;
  /** 表示名 */
  displayName: string;
};

/** 表明の状態（§4 claim の `status`） */
export type ClaimStatus = "working" | "paused" | "done";

/**
 * 表明（claim）。KV `["boardClaim", id]` に保存する（§4）。
 * 「これから何を作るか」を着手前に書き込み、着手の重複を防ぐためのもの（§1）。
 */
export type Claim = {
  /** ULID */
  id: string;
  /**
   * 表明した人のメンバー識別子（`Member.id`）。
   * **サーバーがトークンから解決する。クライアントは名乗らない**（§4 / §7-1）。
   */
  member: string;
  /** Claude Code のセッション識別子。1セッション1表明（§4） */
  sessionId: string;
  /** 何を作るか（例:「VC ルームの画面共有」）。自由文（§7-7 の秘密検出の対象） */
  title: string;
  /**
   * 触る予定のファイル・ディレクトリ（任意）。リポジトリルートからの相対パス。
   * 重なりの自動検出に効かせるために持たせている（§4）。無くても表明としては成立する。
   */
  paths?: string[];
  /** 作業ブランチ名（任意） */
  branch?: string;
  /** 対応する PR 番号（任意） */
  prNumber?: number;
  /** 状態 */
  status: ClaimStatus;
  /** 表明した時刻（epoch ms） */
  startedAt: number;
  /** 最後に生存を知らせた時刻（epoch ms）。CLI 呼び出しのたびに更新する（§5） */
  heartbeatAt: number;
  /** 補足（任意）。自由文（§7-7 の秘密検出の対象） */
  note?: string;
};

/**
 * 一覧・検査で返す表明。保存されている `Claim` に、サーバーが解決した情報を足したもの。
 * KV には保存しない（`memberName` は Member から、`stale` は時刻から都度求める）。
 */
export type ClaimView = Claim & {
  /** `member` を Member から解決した表示名。画面が id を出さずに済むように添える */
  memberName: string;
  /** `heartbeatAt` から CLAIM_TTL_MS を過ぎた `working` か（§5 の「古い表明」） */
  stale: boolean;
};

/** タスクの状態（§4 task の `status`） */
export type TaskStatus = "open" | "doing" | "done";

/**
 * タスク（task）。KV `["boardTask", id]` に保存する（§4）。
 * Issue にするほどでもない粒度のメモ。正式な課題は GitHub Issues を使う（§2）。
 */
export type Task = {
  /** ULID */
  id: string;
  /** 何をするか。自由文（§7-7 の秘密検出の対象） */
  title: string;
  /** 詳細。自由文（§7-7 の秘密検出の対象） */
  body: string;
  /** 担当のメンバー識別子（任意、`Member.id`） */
  assignee?: string;
  /** 状態 */
  status: TaskStatus;
  /** 作成時刻（epoch ms） */
  createdAt: number;
};

/**
 * PR 索引のキャッシュ（§4 prIndex）。KV `["boardPrIndex", prNumber]` に保存する。
 *
 * GitHub API から定期取得したものを保持する。**API のレート制限を避けるため、
 * リクエストのたびに GitHub を叩かない**（§4 / §9: 更新間隔は5分）。
 */
export type PrIndex = {
  /** PR 番号 */
  prNumber: number;
  /** PR のタイトル */
  title: string;
  /** PR の作成者（GitHub のログイン名） */
  author: string;
  /** PR のヘッドブランチ名 */
  headRef: string;
  /** その PR が変更しているファイルのパス一覧 */
  files: string[];
  /** この索引を GitHub から取得した時刻（epoch ms）。「いつ時点か」の表示に使う（§9） */
  fetchedAt: number;
};

// ---------------------------------------------------------------------------
// §6 API のリクエスト / レスポンス
// ---------------------------------------------------------------------------

/**
 * エラー応答（全 API 共通）。EN 本体の `{ error: message }` と同じ形に揃える。
 * **§7-4 のとおり、ここにトークンの値を含めてはならない。**
 */
export type BoardErrorResponse = {
  /** 人間向けのメッセージ。秘密情報を含めない */
  error: string;
};

/**
 * `POST /api/claims` のリクエスト。
 * **`member` は含めない。** サーバーが `Authorization: Bearer <token>` から解決する（§7-1）。
 */
export type ClaimCreateRequest = {
  /** Claude Code のセッション識別子。1セッション1表明 */
  sessionId: string;
  /** 何を作るか */
  title: string;
  /** 触る予定のファイル・ディレクトリ（任意） */
  paths?: string[];
  /** 作業ブランチ名（任意） */
  branch?: string;
  /** 対応する PR 番号（任意） */
  prNumber?: number;
  /** 補足（任意） */
  note?: string;
};

/**
 * `PATCH /api/claims/:id` のリクエスト。
 * 省略したフィールドは変更しない。`heartbeatAt` はサーバーが自動で更新するので送らない（§5）。
 */
export type ClaimUpdateRequest = {
  /** 状態を変える（`SessionEnd` フックは `paused` を送る、§8） */
  status?: ClaimStatus;
  /** 表明の内容を書き直す */
  title?: string;
  /** 触る予定のパスを差し替える */
  paths?: string[];
  /** 作業ブランチ名 */
  branch?: string;
  /** 対応する PR 番号 */
  prNumber?: number;
  /** 補足 */
  note?: string;
};

/** `POST /api/claims` / `PATCH /api/claims/:id` の応答 */
export type ClaimResponse = {
  /** 作成・更新後の表明 */
  claim: ClaimView;
};

/** `GET /api/claims` の応答 */
export type ClaimListResponse = {
  /** 表明の一覧 */
  claims: ClaimView[];
  /** サーバー時刻（epoch ms）。クライアントが `stale` を再計算せずに済むよう添える */
  serverTime: number;
};

/**
 * `GET /api/claims/check?paths=a,b` の応答（§6 の「フックの中核」）。
 *
 * 「このファイルを触ろうとしている」に対して、重なる表明とオープン PR を返す。
 * どちらも `PreToolUse` フックでは**警告のみで通す**（§8）。
 */
export type ClaimCheckResponse = {
  /** 問い合わせたパス（サーバーが正規化した結果） */
  paths: string[];
  /** 指定パスに重なる、呼び出し元以外のメンバーの表明 */
  claims: ClaimView[];
  /** 指定パスを触っているオープン PR（キャッシュ） */
  prs: PrIndex[];
  /**
   * PR 索引を最後に取得できた時刻（epoch ms）。まだ一度も取得できていなければ null。
   * 取得失敗時は古いキャッシュを返すため、「いつ時点か」を必ず添える（§9）。
   */
  prsFetchedAt: number | null;
  /** サーバー時刻（epoch ms） */
  serverTime: number;
};

/** `POST /api/tasks` のリクエスト */
export type TaskCreateRequest = {
  /** 何をするか */
  title: string;
  /** 詳細 */
  body: string;
  /** 担当のメンバー識別子（任意） */
  assignee?: string;
};

/** `PATCH /api/tasks/:id` のリクエスト。省略したフィールドは変更しない */
export type TaskUpdateRequest = {
  /** 状態 */
  status?: TaskStatus;
  /** 何をするか */
  title?: string;
  /** 詳細 */
  body?: string;
  /** 担当のメンバー識別子 */
  assignee?: string;
};

/** `POST /api/tasks` / `PATCH /api/tasks/:id` の応答 */
export type TaskResponse = {
  /** 作成・更新後のタスク */
  task: Task;
};

/** `GET /api/tasks` の応答 */
export type TaskListResponse = {
  /** タスクの一覧 */
  tasks: Task[];
};

/** `GET /api/prs` の応答（キャッシュ、§6 / §9） */
export type PrListResponse = {
  /** オープン PR の索引 */
  prs: PrIndex[];
  /** 最後に取得できた時刻（epoch ms）。まだ一度も取得できていなければ null */
  fetchedAt: number | null;
};

/**
 * `POST /api/messages` のリクエスト（§6 / §9）。
 * **ボードには保存せず、GitHub の PR コメントとして投稿する**（GitHub の通知で相手に届くため）。
 */
export type MessagePostRequest = {
  /** 宛先の PR 番号 */
  prNumber: number;
  /** 本文。自由文（§7-7 の秘密検出の対象） */
  body: string;
};

/** `POST /api/messages` の応答 */
export type MessagePostResponse = {
  /** 投稿された PR コメントの URL。投稿できたことを人間が確認するために返す */
  commentUrl: string;
};
