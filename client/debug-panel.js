/**
 * me-tric debug sidebar.
 *
 * Why this exists: the shared core shows model, effort and a live SSE counter in
 * the status bar, and nothing else about what the agent is actually doing. There
 * is no way to see the raw streamed text as it arrives, how fast it is arriving,
 * or what the context window is made of. This module adds a right-hand debug
 * sidebar with exactly that.
 *
 * Why it observes `fetch` instead of reading the DOM: `app.js` keeps all of its
 * state in module scope with no exports, but every `/api/sync` response carries
 * the raw material — `projection_states[].range.projections[]` (streaming
 * assistant text, tool calls, turn toolbars) plus `api_activity`. Tapping the
 * response is therefore the only way to see it without editing the shared core.
 * `frontend/` stays byte-identical; `build-frontend.js` asserts this module loads
 * before `app.js` so the runtime replacement is picked up.
 *
 * What is measured and what is estimated — this distinction is load-bearing:
 *
 * - `api_activity.received_sse_events` is a real server-side counter, but it is
 *   reset at the start of every API call, so it is "events this call", not a total.
 * - `api_usage` (real token counts) is only written when an API call *completes*
 *   (`ui_projection.rs`: `ApiState::Completed` / `Interrupted`). During streaming
 *   it is null, so a real token/s cannot be measured while text is arriving.
 * - The live rate is therefore computed from assistant text growth in characters
 *   per second, and the token figure derived from it is labelled 估算. Once the
 *   call completes, the server's real usage is shown instead.
 */
(() => {
  "use strict";

  const RUNTIME = globalThis.MeFrontendRuntime;
  if (!RUNTIME) return;

  const PANEL_ID = "me-tric-debug-panel";
  const TOGGLE_ID = "me-tric-debug-toggle";
  const OPEN_CLASS = "me-tric-debug-open";
  const STORAGE_KEY = "me-tric-debug-open";
  const STATUS_ID = "me-tric-debug-status";
  /** Rough characters-per-token for mixed CJK/Latin text; used only for the estimate. */
  const CHARS_PER_TOKEN = 4;
  /** Sampling window for the live rate, in milliseconds. */
  const RATE_WINDOW_MS = 3000;
  /** How much of the streaming tail the text box keeps. */
  const STREAM_TAIL_CHARS = 6000;
  const MAX_TOOL_ROWS = 40;

  // ---- pure helpers -------------------------------------------------------

  function toNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function formatBytes(bytes) {
    const value = toNumber(bytes);
    if (value < 1024) return `${Math.round(value)} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatTokens(value) {
    if (value == null) return "—";
    const tokens = toNumber(value);
    if (tokens < 1000) return String(Math.round(tokens));
    if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
    return `${(tokens / 1000000).toFixed(2)}M`;
  }

  function formatDuration(ms) {
    const value = Math.max(0, toNumber(ms));
    if (value < 1000) return `${Math.round(value)} ms`;
    if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
    return `${Math.floor(value / 60000)}m ${Math.round((value % 60000) / 1000)}s`;
  }

  /**
   * The selected agent's projection state, or null. `selected_agent` is the only
   * field the server uses to decide which agent gets an inline `range`, so a
   * non-null `range` is itself the authoritative signal.
   */
  function selectedState(payload) {
    const states = Array.isArray(payload?.projection_states) ? payload.projection_states : [];
    if (!states.length) return null;
    const selected = payload?.selected_agent ?? null;
    return states.find((state) => state?.agent_id === selected) || states[0] || null;
  }

  function partsOf(state) {
    const parts = state?.range?.projections;
    return Array.isArray(parts) ? parts : [];
  }

  /** The assistant part that is still growing, i.e. the newest one. */
  function latestAssistant(state) {
    const parts = partsOf(state);
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      if (parts[index]?.kind === "assistant") return parts[index];
    }
    return null;
  }

  function toolParts(state) {
    return partsOf(state).filter((part) => part?.kind === "tool" || part?.kind === "worker-activity");
  }

  /** Tool rows for the list, newest last so the active one stays visible. */
  function toolRows(state) {
    return toolParts(state)
      .slice(-MAX_TOOL_ROWS)
      .map((part) => {
        const tool = part.tool || {};
        const result = tool.result || null;
        const started = toNumber(tool.started);
        const finished = result ? toNumber(result.finished) : 0;
        return {
          name: String(tool.name || "—"),
          state: result ? String(result.state || "succeeded") : tool.queued ? "queued" : "running",
          durationMs: result && finished >= started ? finished - started : null,
          started,
        };
      });
  }

  const CONTEXT_ROWS = [
    ["system", "系统提示词"],
    ["compact", "上下文压缩"],
    ["memory", "记忆"],
    ["user", "用户消息"],
    ["model", "模型输出"],
    ["tool", "工具调用"],
  ];

  function contextRows(state) {
    const context = state?.context || {};
    const values = context.values || {};
    const total = context.total == null ? null : toNumber(context.total);
    const rows = CONTEXT_ROWS.map(([key, label]) => ({
      key,
      label,
      tokens: toNumber(values[key]),
      share: total && total > 0 ? toNumber(values[key]) / total * 100 : null,
    }));
    return { total, rows };
  }

  /**
   * The turn currently on screen: every assistant part after the newest user
   * prompt, and how much text those parts hold.
   *
   * Why the turn and not the newest assistant part: one turn issues several API
   * calls (one per tool round), and each call appends a *new* assistant part with
   * its own `key` (`assistant:{prompt_id}:{response.id}`). Keying the rate on the
   * part identity therefore reset the sampling window at every tool boundary —
   * which is most of a coding turn — so the window rarely held two samples and the
   * rate stayed null. The turn's assistant text is monotone across those
   * boundaries, so the measurement survives them.
   */
  function currentTurn(state) {
    const parts = partsOf(state);
    let start = -1;
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      if (parts[index]?.kind === "user") { start = index; break; }
    }
    const turn = start >= 0 ? String(parts[start].key || `user:${start}`) : "";
    const slice = start >= 0 ? parts.slice(start + 1) : parts;
    let text = "";
    let hasText = false;
    for (const part of slice) {
      if (part?.kind !== "assistant" || typeof part.content !== "string") continue;
      text += part.content;
      hasText = true;
    }
    return { turn, chars: text.length, hasText, text };
  }

  /**
   * Characters per second over the sampling window.
   *
   * The window belongs to the *turn*, not to one assistant part, and a poll that
   * carries no assistant text at all (a tool-only suffix, or a turn that has not
   * produced text yet) keeps the previous window instead of wiping it. Wiping was
   * the other half of the bug: one text-free poll left a single sample behind, and
   * a single sample can never yield a rate.
   */
  function nextRate(sample, previous, now) {
    const base = previous || {};
    const turn = sample?.turn ?? base.turn ?? "";
    if (!sample?.hasText || sample?.chars == null) {
      return {
        rate: base.rate ?? null,
        samples: base.samples || [],
        turn,
        chars: toNumber(base.chars),
        grown: 0,
      };
    }
    const chars = Math.max(0, toNumber(sample.chars));
    const sameTurn = base.turn === turn;
    // A shrinking count means the window scrolled or a part was replaced; the old
    // samples describe a different suffix, so the difference would be meaningless.
    const continuous = sameTurn && chars >= toNumber(base.chars);
    const samples = [...(continuous ? base.samples || [] : []), { at: now, chars }];
    const recent = samples.filter((entry) => now - entry.at <= RATE_WINDOW_MS);
    // Keep one sample just outside the window so the span is never zero.
    const windowed = recent.length >= 2 ? recent : samples.slice(-2);
    const grown = Math.max(0, chars - toNumber(base.chars));
    if (windowed.length < 2) {
      return { rate: null, samples: samples.slice(-24), turn, chars, grown };
    }
    const span = windowed[windowed.length - 1].at - windowed[0].at;
    const delta = windowed[windowed.length - 1].chars - windowed[0].chars;
    return {
      // Two samples sharing one timestamp cannot be divided; the previous rate is
      // still a better answer than a null that erases the block.
      rate: span > 0 ? Math.max(0, delta) / (span / 1000) : base.rate ?? null,
      samples: samples.slice(-24),
      turn,
      chars,
      grown,
    };
  }

  /** `edb_size_bytes` lives on the agent snapshot, not the projection state. */
  function edbSize(payload) {
    const agent = (payload?.snapshot?.agents || []).find((entry) => entry?.id === payload?.selected_agent);
    return agent?.edb_size_bytes == null ? null : toNumber(agent.edb_size_bytes);
  }

  /**
   * The agent the user is actually looking at, read from the sidebar DOM.
   *
   * `app.js` keeps `state.selectedAgent` in module scope with no export, but it
   * mirrors it onto the selected `.agent-row` (`updateAgentRow` toggles `.active`
   * and sets `data-workspace-id`). This is the only authoritative answer to "which
   * conversation is on screen", and the panel needs it to ignore the background
   * polls that `app.js` also runs for other agents.
   */
  function selectedAgentId() {
    const row = documentValue()?.querySelector?.(".agent-row.active");
    // `createAgentRow` emits `data-agent-row`, so the DOM exposes `dataset.agentRow`;
    // reading `agentId` returned null for every row.
    return row?.dataset?.agentRow || row?.dataset?.agentId || null;
  }

  /**
   * True only for a response about the conversation currently on screen.
   *
   * `app.js` runs two kinds of sync: the foreground poll for the selected agent,
   * and a background poll for other workspaces/agents (`backgroundSyncRequestBody`).
   * Both hit `/api/sync`, so without this filter a background response would render
   * as if it were the conversation on screen — which is what made the panel appear
   * to change while nothing was happening.
   */
  function tracksSelected(payload, trackedAgentId, selected = selectedAgentId()) {
    const reported = payload?.selected_agent ?? null;
    if (!reported) return false;
    // The server only attaches an inline `range` for the selected agent, so a
    // response without one is a background poll even if the id matches.
    const state = selectedState(payload);
    if (!state || state.agent_id !== reported) return false;
    if (state.range == null) return false;
    // When the sidebar names a selection, it wins over whatever the poll reports.
    if (selected) return reported === selected;
    return trackedAgentId == null || trackedAgentId === reported;
  }

  /**
   * Whether the agent is actually producing something right now. Idle polling keeps
   * advancing cursors and response sizes; only these two signals mean real work.
   */
  function isActive(payload, grew) {
    if (payload?.api_activity?.active) return true;
    const turn = selectedState(payload)?.turn_state?.state;
    if (turn === "active" || turn === "aborting") return true;
    return toNumber(grew) > 0;
  }

  // ---- state --------------------------------------------------------------

  /** A clean sampling window. `text` and `active` are filled in as polls arrive. */
  function emptyRate() {
    return { rate: null, samples: [], turn: null, chars: 0, active: false };
  }

  const debugState = {
    open: false,
    paused: false,
    /** Latest parsed sync payload, kept only while the panel is open. */
    snapshot: null,
    /** Which agent the panel is currently tracking; a change resets the samples. */
    agentId: null,
    /** Rolling character-growth samples for the live rate. */
    rate: emptyRate(),
    /** Wall-clock of the last observed sync response. */
    lastAt: 0,
    /** Bytes of the last sync response body. */
    lastBytes: 0,
    /** Monotonic count of observed responses, for the "poll" row. */
    syncCount: 0,
    /** Frozen streaming tail while paused. */
    frozenText: "",
    /** Signature of the last rendered markup, so an unchanged frame writes nothing. */
    renderSignature: null,
    root: null,
  };

  function readOpenPreference() {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function writeOpenPreference(open) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, open ? "1" : "0");
    } catch (_) { /* storage unavailable */ }
  }

  // ---- DOM ----------------------------------------------------------------

  function documentValue() {
    return globalThis.document || null;
  }

  function row(label, value, { mono = false } = {}) {
    return `<div class="me-tric-debug-row"><span class="me-tric-debug-key">${escapeHtml(label)}</span>`
      + `<span class="me-tric-debug-value${mono ? " mono" : ""}">${escapeHtml(value)}</span></div>`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[character]));
  }

  function section(title, bodyHtml, extraClass = "") {
    return `<section class="me-tric-debug-section ${extraClass}">`
      + `<h3 class="me-tric-debug-heading">${escapeHtml(title)}</h3>`
      + bodyHtml
      + "</section>";
  }

  function buildShell(root) {
    root.innerHTML = `
      <header class="me-tric-debug-bar">
        <span class="me-tric-debug-title">调试</span>
        <span class="me-tric-debug-dot" data-role="activity" aria-hidden="true"></span>
        <span class="me-tric-debug-actions">
          <button type="button" data-action="pause" title="暂停采样">暂停</button>
          <button type="button" data-action="clear" title="清空采样">清空</button>
          <button type="button" data-action="close" title="收起调试面板" aria-label="收起调试面板">×</button>
        </span>
      </header>
      <div class="me-tric-debug-body">
        <div data-role="overview"></div>
        <div data-role="speed"></div>
        <div data-role="stream"></div>
        <div data-role="context"></div>
        <div data-role="tools"></div>
        <div data-role="cursors"></div>
      </div>`;
  }

  function ensureRoot() {
    const documentRef = documentValue();
    if (!documentRef?.createElement || !documentRef.body) return null;
    let root = documentRef.getElementById(PANEL_ID);
    if (!root) {
      root = documentRef.createElement("aside");
      root.id = PANEL_ID;
      root.className = "me-tric-debug-panel";
      root.setAttribute("aria-label", "调试面板");
      root.setAttribute("aria-hidden", "true");
      buildShell(root);
      root.addEventListener("click", onPanelClick);
      documentRef.body.append(root);
    }
    return root;
  }

  function ensureToggle() {
    const documentRef = documentValue();
    if (!documentRef?.createElement || !documentRef.body) return null;
    let toggle = documentRef.getElementById(TOGGLE_ID);
    if (!toggle) {
      toggle = documentRef.createElement("button");
      toggle.id = TOGGLE_ID;
      toggle.type = "button";
      toggle.className = "me-tric-debug-toggle theme-control";
      toggle.title = "展开调试面板";
      toggle.setAttribute("aria-label", "展开调试面板");
      toggle.setAttribute("aria-expanded", "false");
      toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
        + '<path d="M4 6h9M4 12h6M4 18h9"/><path d="M17 8v8M13.5 12.5 17 16l3.5-3.5"/></svg>';
      toggle.addEventListener("click", () => setOpen(!debugState.open));
      // Join the sidebar's existing settings/theme row instead of floating over the
      // transcript. `.sidebar-appearance` is the right-hand flex group there, and it
      // survives the narrow layout where `.sidebar-settings` is hidden.
      const row = documentRef.querySelector?.(".sidebar-appearance")
        || documentRef.querySelector?.(".sidebar-footer");
      if (row?.append) row.append(toggle);
      else documentRef.body.append(toggle);
    }
    return toggle;
  }

  function setOpen(open) {
    const root = ensureRoot();
    const toggle = ensureToggle();
    debugState.open = Boolean(open);
    if (root) {
      root.classList.toggle("open", debugState.open);
      root.setAttribute("aria-hidden", String(!debugState.open));
    }
    if (toggle) {
      // `app.js` re-renders the sidebar; re-attach if the button was detached.
      const row = documentValue()?.querySelector?.(".sidebar-appearance")
        || documentValue()?.querySelector?.(".sidebar-footer");
      if (row?.contains && !row.contains(toggle)) row.append(toggle);
      toggle.classList.toggle("open", debugState.open);
      toggle.setAttribute("aria-expanded", String(debugState.open));
      toggle.title = debugState.open ? "收起调试面板" : "展开调试面板";
      toggle.setAttribute("aria-label", toggle.title);
    }
    // The panel is fixed-positioned, so the workspace needs a gutter of its own.
    documentValue()?.documentElement?.classList?.toggle(OPEN_CLASS, debugState.open);
    writeOpenPreference(debugState.open);
    if (debugState.open) render();
  }

  function onPanelClick(event) {
    const action = event.target?.closest?.("[data-action]")?.dataset?.action;
    if (!action) return;
    if (action === "close") setOpen(false);
    else if (action === "pause") {
      debugState.paused = !debugState.paused;
      if (!debugState.paused) {
        // Resuming restarts the sampling window; the frozen text is dropped.
        debugState.frozenText = "";
        debugState.rate = emptyRate();
      }
      render();
    } else if (action === "clear") {
      debugState.snapshot = null;
      debugState.rate = emptyRate();
      debugState.frozenText = "";
      debugState.lastBytes = 0;
      debugState.syncCount = 0;
      updateStatusBar();
      render();
    }
  }

  // ---- rendering ----------------------------------------------------------

  function renderOverview(payload, state) {
    const activity = payload?.api_activity || {};
    const usage = state?.api_usage || null;
    const rows = [
      row("API 状态", state?.api_state || "—"),
      row("模型", state?.model || "—"),
      row("推理强度", state?.effort || "—"),
      row("轮次状态", state?.turn_state?.state || "—"),
      row("本轮 SSE", activity.active ? String(toNumber(activity.received_sse_events)) : "空闲"),
      row("响应体积", formatBytes(debugState.lastBytes)),
      row("采样次数", String(debugState.syncCount)),
      row("服务端用量", usage ? `${formatTokens(usage.input_tokens)} 入 / ${formatTokens(usage.output_tokens)} 出` : "未完成"),
    ];
    return section("概览", rows.join(""));
  }

  /** Rates below 10 keep one decimal; `Math.round` alone showed a real 0.4 as 0. */
  function formatRate(value) {
    if (value == null) return null;
    return value >= 10 ? Math.round(value).toLocaleString() : value.toFixed(1);
  }

  function renderSpeed(state) {
    const { rate, chars, samples, active } = debugState.rate;
    const speed = formatRate(rate);
    const rows = [
      row("当前文本", `${toNumber(chars).toLocaleString()} 字符`),
      // `采样中…` only while work is in flight; an idle turn must not claim to be
      // still measuring, and a measured rate must never be rounded down to 0.
      row("输出速度", speed == null ? (active ? "采样中…" : "—") : `${speed} 字符/秒`),
      row("折合速率", speed == null ? "—" : `${formatRate(rate / CHARS_PER_TOKEN)} tok/s（估算）`),
      row("每分钟", speed == null ? "—" : `${Math.round(rate * 60).toLocaleString()} 字符/分`),
      row("采样点", `${(samples || []).length} 个`),
    ];
    const usage = state?.api_usage;
    if (usage) {
      rows.push(row("本轮真实输出", `${formatTokens(usage.output_tokens)} tok`));
    }
    const note = '<p class="me-tric-debug-note">流式期间服务端不返回 token 用量，'
      + 'tok/s 由字符增长折算，仅供参考；API 完成后显示真实用量。</p>';
    return section("输出速度", rows.join("") + note);
  }

  function renderStream() {
    const text = debugState.paused ? debugState.frozenText : debugState.rate.text;
    const body = text
      ? `<pre class="me-tric-debug-stream" data-role="stream-text">${escapeHtml(text)}</pre>`
      : '<pre class="me-tric-debug-stream" data-role="stream-text"><span class="me-tric-debug-empty">等待流式数据…</span></pre>';
    const meta = debugState.paused
      ? '<span class="me-tric-debug-badge">已暂停</span>'
      : "";
    return section(`流式数据 ${meta}`, body);
  }

  function renderContext(state) {
    const { total, rows } = contextRows(state);
    const list = rows.map((entry) => {
      const share = entry.share == null ? "—" : `${entry.share.toFixed(1)}%`;
      const width = entry.share == null ? 0 : Math.min(100, entry.share);
      return `<div class="me-tric-debug-context-row">`
        + `<span class="me-tric-debug-key">${escapeHtml(entry.label)}</span>`
        + `<span class="me-tric-debug-context-bar"><i style="width:${width.toFixed(1)}%"></i></span>`
        + `<span class="me-tric-debug-value">${escapeHtml(formatTokens(entry.tokens))}</span>`
        + `<span class="me-tric-debug-share">${escapeHtml(share)}</span>`
        + "</div>";
    }).join("");
    const head = row("总计", formatTokens(total));
    return section("上下文占用", head + list);
  }

  function renderTools(state) {
    const rows = toolRows(state);
    if (!rows.length) return section("工具调用", '<p class="me-tric-debug-empty">暂无工具调用</p>');
    const list = rows.map((entry) => {
      const duration = entry.durationMs == null ? "进行中" : formatDuration(entry.durationMs);
      return `<div class="me-tric-debug-tool-row" data-state="${escapeHtml(entry.state)}">`
        + `<span class="me-tric-debug-tool-name">${escapeHtml(entry.name)}</span>`
        + `<span class="me-tric-debug-tool-state">${escapeHtml(entry.state)}</span>`
        + `<span class="me-tric-debug-tool-time">${escapeHtml(duration)}</span>`
        + "</div>";
    }).join("");
    return section(`工具调用 (${rows.length})`, list);
  }

  function renderCursors(payload, state) {
    const rows = [
      row("会话事件数", String(toNumber(state?.count))),
      row("源事件数", String(toNumber(state?.source_event_count))),
      row("last_event_id", state?.last_event_id == null ? "—" : String(state.last_event_id), { mono: true }),
      row("revision", String(state?.revision ?? "—"), { mono: true }),
      row("变更起点", state?.changed_from == null ? "—" : String(state.changed_from)),
      row("EDB 体积", edbSize(payload) == null ? "—" : formatBytes(edbSize(payload))),
      row("响应时间", debugState.lastAt ? new Date(debugState.lastAt).toLocaleTimeString() : "—"),
    ];
    return section("事件与游标", rows.join(""));
  }

  function render() {
    const root = debugState.root;
    if (!root || !debugState.open) return;
    const payload = debugState.snapshot;
    const state = payload ? selectedState(payload) : null;
    const body = root.querySelector?.(".me-tric-debug-body");
    if (!body) return;

    const dot = root.querySelector?.('[data-role="activity"]');
    if (dot) {
      const active = Boolean(payload?.api_activity?.active);
      dot.classList.toggle("active", active);
    }
    const pause = root.querySelector?.('[data-action="pause"]');
    if (pause) {
      pause.textContent = debugState.paused ? "继续" : "暂停";
      pause.classList.toggle("active", debugState.paused);
    }

    const scroll = body.querySelector?.('[data-role="stream-text"]');
    const pinned = !scroll || scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 24;

    const markup = {
      overview: renderOverview(payload, state),
      speed: renderSpeed(state),
      stream: renderStream(),
      context: renderContext(state),
      tools: renderTools(state),
      cursors: renderCursors(payload, state),
    };
    // Idle polls still arrive every second; writing identical markup each time would
    // thrash the DOM and reset text selection for no visible change.
    const signature = JSON.stringify([markup, debugState.paused, Boolean(payload?.api_activity?.active)]);
    if (signature === debugState.renderSignature) return;
    debugState.renderSignature = signature;

    for (const [role, html] of Object.entries(markup)) {
      const slot = body.querySelector(`[data-role="${role}"]`);
      if (slot) slot.innerHTML = html;
    }

    const next = body.querySelector?.('[data-role="stream-text"]');
    // Follow the tail only when the user was already at the bottom.
    if (next && pinned) next.scrollTop = next.scrollHeight;
  }

  // ---- observation --------------------------------------------------------

  function isSyncRequest(input) {
    const url = String(typeof input === "string" ? input : input?.url || "");
    // `app.js` calls `frontendRuntime.apiPath("/api/sync", workspaceId)` first, which
    // rewrites it to `/api/workspaces/<id>/sync`. Both forms must match.
    return /\/api\/(?:workspaces\/[^/?#]+\/)?sync(?:[?#]|$)/.test(url);
  }

  function observeSync(payload, bytes) {
    if (debugState.paused) return;
    // Background polls describe other agents; rendering them would make the panel
    // change while the visible conversation is idle.
    if (!tracksSelected(payload, debugState.agentId)) return;

    const agentId = payload.selected_agent;
    const switched = debugState.agentId !== agentId;
    if (switched) {
      // A different conversation starts with a clean sampling window.
      debugState.agentId = agentId;
      debugState.rate = emptyRate();
      debugState.syncCount = 0;
      debugState.lastBytes = 0;
      debugState.frozenText = "";
      debugState.renderSignature = null;
    }

    const state = selectedState(payload);
    const turn = currentTurn(state);
    const previous = debugState.rate;
    const next = nextRate(turn, previous, Date.now());
    const grew = toNumber(next.chars) - toNumber(previous.turn === next.turn ? previous.chars : 0);
    const active = isActive(payload, grew);

    debugState.snapshot = payload;
    debugState.rate = next;
    debugState.rate.active = active;
    debugState.rate.text = turn.text.slice(-STREAM_TAIL_CHARS);
    // Keep the frozen copy current so pausing freezes at the last live text.
    debugState.frozenText = debugState.rate.text;

    // Volatile bookkeeping only advances while the agent is actually working, so an
    // idle conversation shows a stable frame instead of a ticking counter.
    if (active) {
      debugState.lastAt = Date.now();
      debugState.lastBytes = bytes;
      debugState.syncCount += 1;
    }

    updateStatusBar();
    if (debugState.open) render();
  }

  function byteLength(text) {
    // Response bodies here are JSON; a UTF-8 byte count is what "data length" means.
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
    return text.length;
  }

  /**
   * The status bar shows model, effort and a live SSE counter, but no byte count.
   * `frontend/` is read-only, so this adds one span of its own to `#statusbar`
   * rather than editing the markup.
   */
  function updateStatusBar() {
    const documentRef = documentValue();
    const bar = documentRef?.getElementById?.("statusbar");
    if (!bar?.append || !documentRef.createElement) return;
    let slot = documentRef.getElementById(STATUS_ID);
    if (!slot) {
      slot = documentRef.createElement("span");
      slot.id = STATUS_ID;
      slot.className = "me-tric-debug-status";
      slot.title = "本次连接收到的同步数据";
      // After `.status-primary` so it sits beside the model/effort group.
      const primary = bar.querySelector?.(".status-primary");
      if (primary?.after) primary.after(slot);
      else bar.append(slot);
    }
    const activity = debugState.snapshot?.api_activity || {};
    const sse = activity.active ? toNumber(activity.received_sse_events) : null;
    const parts = [];
    if (debugState.lastBytes) parts.push(`⇣ ${formatBytes(debugState.lastBytes)}`);
    if (sse != null) parts.push(`${sse} SSE`);
    slot.textContent = parts.join(" · ");
  }

  async function fetchWithDebug(base, input, options) {
    const response = await base.fetch(input, options);
    if (!isSyncRequest(input) || !response?.clone) return response;
    try {
      const text = await response.clone().text();
      observeSync(JSON.parse(text), byteLength(text));
    } catch (_) {
      // A malformed or aborted poll must never break the core's own handling.
    }
    return response;
  }

  // ---- bootstrap ----------------------------------------------------------

  function installRuntime() {
    const base = globalThis.MeFrontendRuntime;
    if (!base || base.meTricDebugPanel) return;
    // A prototype child preserves every live getter of the frozen runtime while
    // overriding exactly one property. Chaining with paste-image.js is fine: each
    // layer delegates to its parent's `fetch`, ending at the native transport.
    const patched = Object.create(base);
    Object.defineProperty(patched, "fetch", {
      value: (input, options) => fetchWithDebug(base, input, options),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(patched, "meTricDebugPanel", { value: true });
    globalThis.MeFrontendRuntime = patched;
  }

  function install() {
    installRuntime();
    debugState.root = ensureRoot();
    ensureToggle();
    updateStatusBar();
    if (readOpenPreference()) setOpen(true);
  }

  // The fetch patch must land *now*: `app.js` captures MeFrontendRuntime at load
  // time, so waiting for DOMContentLoaded would install it too late. Only the DOM
  // mount has to wait for the body to exist.
  installRuntime();
  if (documentValue()?.body) {
    install();
  } else if (typeof documentValue()?.addEventListener === "function") {
    documentValue().addEventListener("DOMContentLoaded", install, { once: true });
  }

  globalThis.MeTricDebugPanel = Object.freeze({
    formatBytes,
    formatTokens,
    formatDuration,
    formatRate,
    selectedState,
    latestAssistant,
    currentTurn,
    renderSpeed,
    toolRows,
    contextRows,
    nextRate,
    edbSize,
    selectedAgentId,
    tracksSelected,
    isActive,
    isSyncRequest,
    observeSync,
    setOpen,
    isOpen: () => debugState.open,
    state: debugState,
    install,
    installRuntime,
    updateStatusBar,
  });
})();
