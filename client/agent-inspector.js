/**
 * me-tric agent inspector.
 *
 * Why this exists: the shared frontend core renders the *curated* view — the
 * server-side UI projection deliberately hides internal tools (see
 * `CHAT_HIDDEN_TOOL_NAMES` / `CHAT_HIDDEN_TOOL_PREFIXES` in ui_backend.rs), so
 * WorkMap, Compact and other bookkeeping calls never appear in the transcript.
 * For debugging and for operators who want the truth, this panel reads the *raw*
 * event stream instead:
 *
 *     GET /api/events/:agent?after=<n>&mutation=<rev>
 *
 * That endpoint returns every event unfiltered, plus a `reset` flag when the
 * cursor is stale. This module therefore owns its own tiny incremental cursor —
 * it does not share state with `app.js`, so it can never corrupt the transcript.
 *
 * It also surfaces the per-agent metadata that the snapshot already exposes
 * (`kind`, `parent_agent_id`, `edb_size_bytes`, revisions) and the projection-level
 * states (api state, token usage, context breakdown, turn state) as a single
 * tabular "agent card", which is the "more detailed agent status" ask.
 */
(() => {
  "use strict";

  const RUNTIME = globalThis.MeFrontendRuntime;
  if (!RUNTIME) return;

  const PANEL_ID = "me-tric-agent-panel";
  const LAUNCHER_ID = "me-tric-agent-launcher";
  const POLL_MS = 2000;
  const MAX_ROWS = 400;
  const MAX_BODY_CHARS = 4000;

  /** Raw event cursors, keyed by agent id: { count, mutation, events: [] } */
  const cursors = new Map();
  /** Latest snapshot metadata, keyed by agent id. */
  let snapshotAgents = new Map();
  let selectedAgent = null;
  let pollTimer = null;
  let filter = "";
  let showingHiddenOnly = false;

  function coreState() {
    // `app.js` keeps its state in a module-scope const; we cannot import it, so we
    // read the DOM instead. This is intentionally read-only and defensive: if the
    // sidebar structure changes, the inspector degrades to "no agents" rather than
    // throwing.
    const rows = [...document.querySelectorAll("#agent-list [data-agent-row]")];
    return rows.map((row) => ({
      id: row.dataset.agentRow,
      title: row.querySelector(".agent-title, strong, .agent-name")?.textContent?.trim() || row.dataset.agentRow,
      active: row.classList.contains("active") || row.getAttribute("aria-current") === "true",
    }));
  }

  function currentAgentId() {
    const selected = coreState().find((agent) => agent.active);
    return selected?.id || coreState()[0]?.id || null;
  }

  async function callApi(path) {
    const response = await RUNTIME.fetch(RUNTIME.apiPath(path), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  // ---- metadata -----------------------------------------------------------

  async function loadSnapshot() {
    const snapshot = await callApi("/api/snapshot");
    snapshotAgents = new Map((snapshot.agents || []).map((agent) => [agent.id, agent]));
    return snapshot;
  }

  // ---- raw events ---------------------------------------------------------

  async function loadEvents(agentId, { reset = false } = {}) {
    const cursor = reset ? { count: 0, mutation: null, events: [] } : cursors.get(agentId) || { count: 0, mutation: null, events: [] };
    const query = new URLSearchParams({ after: String(cursor.count) });
    if (cursor.mutation != null) query.set("mutation", String(cursor.mutation));
    const payload = await callApi(`/api/events/${encodeURIComponent(agentId)}?${query}`);
    const events = payload.reset ? payload.events || [] : [...cursor.events, ...(payload.events || [])];
    const next = {
      count: payload.event_count ?? events.length,
      mutation: payload.mutation_revision ?? cursor.mutation,
      events: events.slice(-MAX_ROWS),
    };
    cursors.set(agentId, next);
    return next;
  }

  // ---- projection-level states -------------------------------------------

  async function loadProjectionState(agentId) {
    try {
      const payload = await callApi(`/api/ui-projections/${encodeURIComponent(agentId)}/state`);
      return payload.state || null;
    } catch {
      return null;
    }
  }

  // ---- rendering ----------------------------------------------------------

  function eventKind(event) {
    // Event is an externally-tagged enum: exactly one key besides nothing else.
    const keys = Object.keys(event || {});
    return keys[0] || "Unknown";
  }

  function eventSummary(event) {
    const kind = eventKind(event);
    const body = event[kind];
    if (!body || typeof body !== "object") return "";
    switch (kind) {
      case "ToolCall":
        return `${body.name || "?"} ${truncate(JSON.stringify(body.arguments ?? {}), 160)}`;
      case "ToolCallResult": {
        const state = body.result?.state ?? body.state ?? "";
        const exit = body.result?.exit_code ?? body.exit_code;
        return `${state}${exit == null ? "" : ` · exit ${exit}`}`;
      }
      case "ApiStateUpdate":
        return String(body.state ?? "");
      case "ModelChanged":
        return String(body.model ?? "");
      case "ReasoningEffortChanged":
        return String(body.effort ?? "");
      case "ToolInfoUpdate":
        return truncate(typeof body.content === "string" ? body.content : JSON.stringify(body.content ?? {}), 160);
      case "CompactStateUpdate":
        return `${body.kind ?? ""} ${body.stage ?? "?"}/${body.total_stages ?? "?"} ${body.state ?? ""}`.trim();
      case "UserPrompt":
      case "ManagerPrompt":
      case "ParentAgentPrompt":
      case "FollowUpPrompt":
      case "AssistResponse":
        return truncate(String(body.content ?? ""), 160);
      default:
        return "";
    }
  }

  function truncate(value, limit) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  function isHiddenToolEvent(event, visibility) {
    if (eventKind(event) !== "ToolCall") return false;
    const name = String(event.ToolCall?.name || "");
    if (!name) return false;
    if ((visibility.hidden_names || []).includes(name)) return true;
    return (visibility.hidden_prefixes || []).some((prefix) => name.startsWith(prefix));
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "me-tric-agent-panel hidden";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Agent 状态");
    panel.innerHTML = `
      <header class="me-tric-agent-header">
        <div>
          <h2>Agent 状态</h2>
          <span class="me-tric-agent-subtitle">原始事件流 · 未过滤内部工具</span>
        </div>
        <button type="button" class="me-tric-agent-close" aria-label="关闭">×</button>
      </header>
      <div class="me-tric-agent-toolbar">
        <select class="me-tric-agent-select" aria-label="选择会话"></select>
        <input class="me-tric-agent-filter" type="search" placeholder="过滤事件…" aria-label="过滤事件">
        <label class="me-tric-agent-toggle">
          <input type="checkbox" class="me-tric-agent-hidden-only"> 仅内部工具
        </label>
        <button type="button" class="me-tric-agent-refresh">刷新</button>
      </div>
      <section class="me-tric-agent-card" aria-label="概览"></section>
      <section class="me-tric-agent-events" aria-label="事件流"></section>
      <div class="me-tric-agent-error" role="alert"></div>
    `;
    return panel;
  }

  function renderAgentOptions() {
    const panel = document.getElementById(PANEL_ID);
    const select = panel?.querySelector(".me-tric-agent-select");
    if (!select) return;
    const agents = coreState();
    select.textContent = "";
    if (!agents.length) {
      const option = document.createElement("option");
      option.textContent = "（无会话）";
      option.value = "";
      select.append(option);
      return;
    }
    for (const agent of agents) {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.title || agent.id;
      if (agent.id === selectedAgent) option.selected = true;
      select.append(option);
    }
  }

  function renderCard(agent, projection) {
    const panel = document.getElementById(PANEL_ID);
    const card = panel?.querySelector(".me-tric-agent-card");
    if (!card) return;
    card.textContent = "";
    if (!agent) {
      card.textContent = "选择一个会话以查看状态。";
      return;
    }
    const context = projection?.context || {};
    const values = context.values || {};
    const rows = [
      ["标识", agent.id],
      ["标题", agent.title || "—"],
      ["类型", agent.kind || "—"],
      ["父会话", agent.parent_agent_id || "—"],
      ["编排模式", agent.orchestrator || "—"],
      ["EDB", `${agent.edb_id || "—"} · ${formatBytes(agent.edb_size_bytes)}`],
      ["事件数", String(agent.event_count ?? "—")],
      ["mutation", String(agent.mutation_revision ?? "—")],
      ["prompt rev", String(agent.prompt_submission_revision ?? "—")],
      ["输入草稿 rev", String(agent.input_draft_revision ?? "—")],
      ["API 状态", projection?.api_state || "—"],
      ["当前轮", projection?.turn_state?.state || "—"],
      ["模型", projection?.model || "—"],
      ["推理强度", projection?.effort || "—"],
      ["Token 用量", projection?.api_usage ? `${projection.api_usage.total_tokens ?? "?"} total` : "—"],
      ["上下文", context.total == null ? "—" : `${formatTokens(context.total)}`],
      ["上下文分项", contextBreakdown(values)],
      ["压缩中", projection?.compact_activity
        ? `${projection.compact_activity.kind} ${projection.compact_activity.stage}/${projection.compact_activity.total_stages}`
        : "—"],
      ["WorkMap", projection?.workmap ? `${projection.workmap.recordCount ?? 0} 条记录` : "—"],
    ];
    const table = document.createElement("table");
    for (const [label, value] of rows) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = label;
      const td = document.createElement("td");
      td.textContent = String(value);
      td.title = String(value);
      tr.append(th, td);
      table.append(tr);
    }
    card.append(table);
  }

  function contextBreakdown(values) {
    const parts = [];
    for (const [key, value] of Object.entries(values || {})) {
      if (value == null || value === 0) continue;
      parts.push(`${key}=${formatTokens(value)}`);
    }
    return parts.length ? parts.join(" ") : "—";
  }

  function formatBytes(value) {
    if (value == null) return "—";
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  }

  function formatTokens(value) {
    if (value == null) return "—";
    return value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}k`;
  }

  function renderEvents(record, visibility) {
    const panel = document.getElementById(PANEL_ID);
    const container = panel?.querySelector(".me-tric-agent-events");
    if (!container) return;
    container.textContent = "";
    const events = (record?.events || []).filter((event) => {
      if (showingHiddenOnly && !isHiddenToolEvent(event, visibility)) return false;
      if (!filter) return true;
      const needle = filter.toLowerCase();
      return `${eventKind(event)} ${eventSummary(event)}`.toLowerCase().includes(needle);
    });
    if (!events.length) {
      container.textContent = "没有匹配的事件。";
      return;
    }
    const list = document.createElement("ol");
    list.className = "me-tric-agent-event-list";
    for (const event of events) {
      const kind = eventKind(event);
      const item = document.createElement("li");
      item.className = "me-tric-agent-event";
      item.dataset.kind = kind;
      const head = document.createElement("button");
      head.type = "button";
      head.className = "me-tric-agent-event-head";
      const timestamp = event[kind]?.timestamp_ms;
      head.innerHTML = `<span class="me-tric-agent-event-kind">${escapeHtml(kind)}</span>`
        + `<span class="me-tric-agent-event-time">${timestamp ? new Date(timestamp).toLocaleTimeString() : ""}</span>`
        + `<span class="me-tric-agent-event-summary">${escapeHtml(eventSummary(event))}</span>`;
      const body = document.createElement("pre");
      body.className = "me-tric-agent-event-body hidden";
      body.textContent = truncate(JSON.stringify(event[kind], null, 2), MAX_BODY_CHARS);
      head.addEventListener("click", () => body.classList.toggle("hidden"));
      item.append(head, body);
      list.append(item);
    }
    container.append(list);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]
    ));
  }

  function setError(message) {
    const panel = document.getElementById(PANEL_ID);
    const region = panel?.querySelector(".me-tric-agent-error");
    if (region) region.textContent = message || "";
  }

  // ---- refresh loop -------------------------------------------------------

  let visibility = { hidden_names: [], hidden_prefixes: [], activity_names: [] };

  async function refresh() {
    try {
      const snapshot = await loadSnapshot();
      visibility = snapshot.tool_visibility || visibility;
      selectedAgent = selectedAgent && snapshotAgents.has(selectedAgent)
        ? selectedAgent
        : currentAgentId();
      renderAgentOptions();
      if (!selectedAgent) {
        renderCard(null, null);
        renderEvents(null, visibility);
        return;
      }
      const [record, projection] = await Promise.all([
        loadEvents(selectedAgent),
        loadProjectionState(selectedAgent),
      ]);
      renderCard(snapshotAgents.get(selectedAgent), projection);
      renderEvents(record, visibility);
      setError("");
    } catch (error) {
      setError(String(error));
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (document.getElementById(PANEL_ID)?.classList.contains("hidden")) return;
      void refresh();
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer != null) clearInterval(pollTimer);
    pollTimer = null;
  }

  function open() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.classList.remove("hidden");
    selectedAgent = currentAgentId();
    // Force a clean cursor: the panel may have been closed for a long time and the
    // EDB may have been rewritten (clear/compaction) in the meantime.
    if (selectedAgent) cursors.delete(selectedAgent);
    void refresh();
    startPolling();
  }

  function close() {
    document.getElementById(PANEL_ID)?.classList.add("hidden");
    stopPolling();
  }

  function installLauncher() {
    const footer = document.querySelector(".sidebar-footer");
    if (!footer || document.getElementById(LAUNCHER_ID)) return;
    const button = document.createElement("button");
    button.id = LAUNCHER_ID;
    button.type = "button";
    button.className = "me-tric-agent-launcher";
    button.title = "Agent 状态";
    button.setAttribute("aria-label", "Agent 状态");
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19h16"/><path d="M8 15V9M12 15V7M16 15v-4"/></svg>';
    button.addEventListener("click", open);
    footer.append(button);
  }

  function install() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = buildPanel();
    document.body.append(panel);
    installLauncher();

    panel.querySelector(".me-tric-agent-close").addEventListener("click", close);
    panel.querySelector(".me-tric-agent-refresh").addEventListener("click", () => {
      if (selectedAgent) cursors.delete(selectedAgent);
      void refresh();
    });
    panel.querySelector(".me-tric-agent-select").addEventListener("change", (event) => {
      selectedAgent = event.target.value || null;
      if (selectedAgent) cursors.delete(selectedAgent);
      void refresh();
    });
    panel.querySelector(".me-tric-agent-filter").addEventListener("input", (event) => {
      filter = event.target.value.trim();
      if (selectedAgent) renderEvents(cursors.get(selectedAgent), visibility);
    });
    panel.querySelector(".me-tric-agent-hidden-only").addEventListener("change", (event) => {
      showingHiddenOnly = event.target.checked;
      if (selectedAgent) renderEvents(cursors.get(selectedAgent), visibility);
    });

    globalThis.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
  }

  install();

  globalThis.MeTricAgentInspector = Object.freeze({
    open,
    close,
    refresh,
    get selectedAgent() { return selectedAgent; },
  });
})();
