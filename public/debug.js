/**
 * デバッグ画面（public/debug.html）のロジック。
 * サーバーが記録した出来事（/api/debug/events）とサーバー状況（/api/debug/summary）を
 * 読みやすく表示するだけの、開発チーム向けの単独ページ。
 *
 * 表示規約（§3.8 / CLAUDE.md セキュリティ基準）:
 * サーバーから来る文字列（message・detail・kind・room情報 等）は一切信用せず、
 * 必ず textContent で描画する。innerHTML は使わない。
 *
 * サーバーとの契約（別担当実装中）:
 *   GET /api/debug/events?limit=&kind=   ヘッダ x-debug-token
 *     → { events: [{ seq, at, kind, message, detail }] }
 *   GET /api/debug/summary               ヘッダ x-debug-token
 *     → { uptimeMs, serverTime, roomCount, rooms: [{ code, playerCount, phase, sandbox }] }
 *   POST /api/debug/reset-limits         ヘッダ x-debug-token
 *     本文（省略可）: { ip?: string }（省略・空欄なら全IP対象）
 *     → { cleared: { login, register }, scope: "ip" | "all" }
 *   トークン未設定・不一致は 404（デバッグ機能の存在を隠すための仕様。401ではない）。
 *   reset-limits は開発中にログイン・登録のレート制限で詰まったとき、待たずに解除する
 *   ための操作。誤爆防止のため実行前に confirm() を挟む（このJS側のガード）。
 */

"use strict";

(function () {
  const STORAGE_KEY = "en-debug-token";
  const EVENTS_LIMIT = 200;
  const AUTO_REFRESH_MS = 5000;

  function $(id) {
    return document.getElementById(id);
  }

  const els = {
    connStatus: $("conn-status"),
    tokenChange: $("token-change"),

    gate: $("gate"),
    gateForm: $("gate-form"),
    gateToken: $("gate-token"),
    gateError: $("gate-error"),

    dashboard: $("dashboard"),
    summaryBody: $("summary-body"),
    roomsTable: $("rooms-table"),

    resetLimitsForm: $("reset-limits-form"),
    resetLimitsIp: $("reset-limits-ip"),
    resetLimitsSubmit: $("reset-limits-submit"),
    resetLimitsResult: $("reset-limits-result"),
    resetLimitsError: $("reset-limits-error"),

    filterLogin: $("filter-login"),
    refreshNow: $("refresh-now"),
    autoRefreshBtn: $("auto-refresh"),
    autoRefreshLabel: $("auto-refresh-label"),

    filterForm: $("filter-form"),
    kindFilter: $("kind-filter"),
    filterClear: $("filter-clear"),

    eventsError: $("events-error"),
    eventsEmpty: $("events-empty"),
    eventsList: $("events-list"),
  };

  /** アプリの状態 */
  const state = {
    token: null,
    kindFilter: "",
    autoRefresh: true,
    timerId: null,
    events: [],
  };

  // ── DOM 組み立てヘルパー（textContent のみ使用） ─────────────────

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ── 書式 ─────────────────────────────────────────────

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /** epoch ms を HH:MM:SS に整形する */
  function formatClock(at) {
    if (typeof at !== "number" || !Number.isFinite(at)) return "--:--:--";
    const d = new Date(at);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  /** 現在時刻からの経過を「◯秒前」のように整形する */
  function formatElapsed(at) {
    if (typeof at !== "number" || !Number.isFinite(at)) return "";
    const diffSec = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (diffSec < 60) return `${diffSec}秒前`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}分前`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}時間前`;
    const diffDay = Math.floor(diffHour / 24);
    return `${diffDay}日前`;
  }

  /** ms を「◯時間◯分◯秒」に整形する（稼働時間表示用） */
  function formatDuration(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    let out = "";
    if (h > 0) out += `${h}時間`;
    if (h > 0 || m > 0) out += `${m}分`;
    out += `${s}秒`;
    return out;
  }

  /** 出来事の種別から色分けの区分を決める */
  function classifyKind(kind) {
    if (typeof kind !== "string" || kind.length === 0) return "unknown";
    if (kind.endsWith(".ok")) return "ok";
    if (kind.toLowerCase().includes("ratelimited")) return "warn";
    return "fail";
  }

  /**
   * login.userNotFound と login.passwordMismatch は HTTP 応答上は同じ 401・同じ文言のため
   * サーバーの応答だけでは見分けられない。この画面でだけ明確に区別できるようにする。
   */
  function loginBadge(kind) {
    if (kind === "login.userNotFound") {
      return { cls: "notfound", label: "未登録ユーザー" };
    }
    if (kind === "login.passwordMismatch") {
      return { cls: "mismatch", label: "パスワード不一致" };
    }
    return null;
  }

  // ── API 呼び出し ─────────────────────────────────────

  /** デバッグ API を呼ぶ。ネットワークエラーも例外を投げずに返す */
  async function callDebugApi(path, token) {
    let res;
    try {
      res = await fetch(path, {
        credentials: "same-origin",
        headers: { "x-debug-token": token },
      });
    } catch {
      return { ok: false, status: 0, body: null, networkError: true };
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, networkError: false };
  }

  function fetchSummary(token) {
    return callDebugApi("/api/debug/summary", token);
  }

  function fetchEvents(token, kindFilter) {
    const params = new URLSearchParams();
    params.set("limit", String(EVENTS_LIMIT));
    if (kindFilter) params.set("kind", kindFilter);
    return callDebugApi(`/api/debug/events?${params.toString()}`, token);
  }

  /** POST 系のデバッグ API を呼ぶ。ネットワークエラーも例外を投げずに返す */
  async function postDebugApi(path, token, body) {
    let res;
    try {
      res = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "x-debug-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
      });
    } catch {
      return { ok: false, status: 0, body: null, networkError: true };
    }
    let resBody = null;
    try {
      resBody = await res.json();
    } catch {
      resBody = null;
    }
    return { ok: res.ok, status: res.status, body: resBody, networkError: false };
  }

  /** ip を省略（undefined）すると全IP対象、指定するとそのIPだけを対象にする */
  function resetLimits(token, ip) {
    const body = ip ? { ip } : {};
    return postDebugApi("/api/debug/reset-limits", token, body);
  }

  // ── 描画: サーバーの状況 ─────────────────────────────────

  function renderSummary(summary) {
    clear(els.summaryBody);
    if (typeof summary !== "object" || summary === null) {
      els.summaryBody.appendChild(el("span", "取得できませんでした"));
      clear(els.roomsTable);
      return;
    }

    const uptimeItem = el("span", undefined, "summary-item");
    uptimeItem.appendChild(document.createTextNode("稼働時間:"));
    uptimeItem.appendChild(el("strong", formatDuration(summary.uptimeMs)));
    els.summaryBody.appendChild(uptimeItem);

    const timeItem = el("span", undefined, "summary-item");
    timeItem.appendChild(document.createTextNode("サーバー時刻:"));
    timeItem.appendChild(el("strong", formatClock(summary.serverTime)));
    els.summaryBody.appendChild(timeItem);

    const roomCountItem = el("span", undefined, "summary-item");
    roomCountItem.appendChild(document.createTextNode("ルーム数:"));
    roomCountItem.appendChild(
      el("strong", typeof summary.roomCount === "number" ? summary.roomCount : "-"),
    );
    els.summaryBody.appendChild(roomCountItem);

    renderRoomsTable(Array.isArray(summary.rooms) ? summary.rooms : []);
  }

  function renderRoomsTable(rooms) {
    clear(els.roomsTable);
    if (rooms.length === 0) {
      els.roomsTable.appendChild(el("p", "現在ルームはありません", "dim"));
      return;
    }
    const table = document.createElement("table");
    table.className = "rooms-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["卓コード", "人数", "フェーズ", "サンドボックス"]) {
      headRow.appendChild(el("th", label));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const room of rooms) {
      if (typeof room !== "object" || room === null) continue;
      const row = document.createElement("tr");
      row.appendChild(el("td", room.code ?? "-"));
      row.appendChild(el("td", typeof room.playerCount === "number" ? room.playerCount : "-"));
      row.appendChild(el("td", room.phase ?? "-"));
      row.appendChild(el("td", room.sandbox ? "有" : "無"));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    els.roomsTable.appendChild(table);
  }

  // ── 描画: 出来事の一覧 ─────────────────────────────────

  function renderEvent(ev) {
    const kindClass = classifyKind(ev.kind);
    const badge = loginBadge(ev.kind);

    const li = el("li", undefined, `event-item kind-${kindClass}`);
    if (badge) li.classList.add(`login-${badge.cls}`);

    const head = el("div", undefined, "event-head");
    head.appendChild(el("span", formatClock(ev.at), "event-time"));
    head.appendChild(el("span", `(${formatElapsed(ev.at)})`, "event-elapsed"));
    head.appendChild(
      el("span", typeof ev.kind === "string" ? ev.kind : "(不明)", `event-kind kind-${kindClass}`),
    );
    if (badge) {
      head.appendChild(el("span", badge.label, `login-badge ${badge.cls}`));
    }
    head.appendChild(el("span", typeof ev.message === "string" ? ev.message : "", "event-message"));
    li.appendChild(head);

    if (ev.detail !== undefined && ev.detail !== null) {
      const details = document.createElement("details");
      details.className = "event-detail";
      details.appendChild(el("summary", "詳細"));
      const pre = document.createElement("pre");
      let text;
      try {
        text = JSON.stringify(ev.detail, null, 2);
      } catch {
        text = String(ev.detail);
      }
      pre.textContent = text;
      details.appendChild(pre);
      li.appendChild(details);
    }

    return li;
  }

  function renderEvents(events) {
    clear(els.eventsList);
    if (events.length === 0) {
      els.eventsEmpty.classList.remove("hidden");
      return;
    }
    els.eventsEmpty.classList.add("hidden");
    // 新しい順（seq 降順）に並べる
    const sorted = events.slice().sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
    for (const ev of sorted) {
      if (typeof ev !== "object" || ev === null) continue;
      els.eventsList.appendChild(renderEvent(ev));
    }
  }

  // ── 状態遷移: ゲート / ダッシュボード ─────────────────────

  function showGate(errorMessage) {
    stopAutoRefreshTimer();
    els.gate.classList.remove("hidden");
    els.dashboard.classList.add("hidden");
    els.tokenChange.classList.add("hidden");
    els.connStatus.textContent = "未接続";
    els.gateError.textContent = errorMessage || "";
  }

  function showDashboard() {
    els.gate.classList.add("hidden");
    els.dashboard.classList.remove("hidden");
    els.tokenChange.classList.remove("hidden");
    els.connStatus.textContent = "接続中";
    els.gateError.textContent = "";
  }

  // ── 更新処理 ─────────────────────────────────────────

  async function refreshSummary() {
    const res = await fetchSummary(state.token);
    if (res.status === 404) return { invalidToken: true };
    if (!res.ok) return { error: true };
    renderSummary(res.body);
    return { ok: true };
  }

  async function refreshEvents() {
    const res = await fetchEvents(state.token, state.kindFilter);
    if (res.status === 404) return { invalidToken: true };
    if (!res.ok) return { error: true };
    const events = Array.isArray(res.body?.events) ? res.body.events : [];
    state.events = events;
    renderEvents(events);
    return { ok: true };
  }

  async function refreshAll() {
    const [summaryResult, eventsResult] = await Promise.all([
      refreshSummary(),
      refreshEvents(),
    ]);

    if (summaryResult.invalidToken || eventsResult.invalidToken) {
      sessionStorage.removeItem(STORAGE_KEY);
      state.token = null;
      showGate("無効か、トークンが違います");
      return;
    }

    if (summaryResult.error || eventsResult.error) {
      els.eventsError.textContent = "更新に失敗しました。しばらくして再度お試しください。";
      return;
    }

    els.eventsError.textContent = "";
  }

  function stopAutoRefreshTimer() {
    if (state.timerId !== null) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function startAutoRefreshTimer() {
    stopAutoRefreshTimer();
    if (state.autoRefresh) {
      state.timerId = setInterval(refreshAll, AUTO_REFRESH_MS);
    }
  }

  function updateAutoRefreshUi() {
    els.autoRefreshBtn.setAttribute("aria-pressed", String(state.autoRefresh));
    els.autoRefreshLabel.textContent = state.autoRefresh
      ? `自動更新: オン（${Math.round(AUTO_REFRESH_MS / 1000)}秒ごと）`
      : "自動更新: オフ";
  }

  // ── 接続 ─────────────────────────────────────────────

  /** トークンで接続を試みる。成功したらダッシュボードを表示して自動更新を開始する */
  async function connect(token) {
    const summaryRes = await fetchSummary(token);
    if (summaryRes.status === 404) {
      showGate("無効か、トークンが違います");
      return;
    }
    if (!summaryRes.ok) {
      showGate("サーバーに接続できませんでした。時間をおいて再度お試しください。");
      return;
    }

    state.token = token;
    sessionStorage.setItem(STORAGE_KEY, token);
    showDashboard();
    renderSummary(summaryRes.body);
    await refreshEvents();
    updateAutoRefreshUi();
    startAutoRefreshTimer();
  }

  // ── イベント配線 ─────────────────────────────────────

  els.gateForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const token = els.gateToken.value.trim();
    if (token.length === 0) {
      els.gateError.textContent = "トークンを入力してください";
      return;
    }
    connect(token);
  });

  els.tokenChange.addEventListener("click", () => {
    sessionStorage.removeItem(STORAGE_KEY);
    state.token = null;
    state.events = [];
    els.gateToken.value = "";
    clear(els.eventsList);
    clear(els.summaryBody);
    clear(els.roomsTable);
    showGate("");
    els.gateToken.focus();
  });

  els.refreshNow.addEventListener("click", () => {
    if (state.token) refreshAll();
  });

  els.autoRefreshBtn.addEventListener("click", () => {
    state.autoRefresh = !state.autoRefresh;
    updateAutoRefreshUi();
    startAutoRefreshTimer();
  });

  function applyKindFilter(value) {
    state.kindFilter = value;
    els.kindFilter.value = value;
    els.filterLogin.classList.toggle("is-active", value === "login.");
    if (state.token) refreshEvents();
  }

  els.filterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    applyKindFilter(els.kindFilter.value.trim());
  });

  els.filterClear.addEventListener("click", () => {
    applyKindFilter("");
  });

  els.filterLogin.addEventListener("click", () => {
    applyKindFilter("login.");
  });

  els.resetLimitsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.token) return;

    const ip = els.resetLimitsIp.value.trim();
    const confirmMessage = ip
      ? `IP ${ip} のログイン・登録のレート制限を解除します。よろしいですか？`
      : "すべてのIPのログイン・登録のレート制限を解除します。よろしいですか？";
    if (!confirm(confirmMessage)) return;

    els.resetLimitsError.textContent = "";
    els.resetLimitsResult.textContent = "";
    els.resetLimitsSubmit.disabled = true;
    try {
      const res = await resetLimits(state.token, ip || undefined);
      if (res.status === 404) {
        sessionStorage.removeItem(STORAGE_KEY);
        state.token = null;
        showGate("無効か、トークンが違います");
        return;
      }
      if (!res.ok || res.body === null) {
        els.resetLimitsError.textContent =
          "解除に失敗しました。しばらくして再度お試しください。";
        return;
      }
      const cleared = res.body.cleared || {};
      const scopeLabel = res.body.scope === "ip" ? `IP ${ip}` : "全IP";
      els.resetLimitsResult.textContent =
        `${scopeLabel} を解除しました（ログイン: ${cleared.login ?? 0}件, 登録: ${
          cleared.register ?? 0
        }件）`;
      // 出来事の一覧を再読み込みする（この操作自体も debug.resetLimits として記録される）
      await refreshAll();
    } finally {
      els.resetLimitsSubmit.disabled = false;
    }
  });

  // ── 初期化 ─────────────────────────────────────────

  updateAutoRefreshUi();

  const storedToken = sessionStorage.getItem(STORAGE_KEY);
  if (storedToken) {
    connect(storedToken);
  } else {
    showGate("");
  }
})();
