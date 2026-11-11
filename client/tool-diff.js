/**
 * me-tric file-edit diffs.
 *
 * Why this exists: the shared frontend core renders a file-edit tool call as a
 * summary table plus the *new* content only ("修改 N 的新内容"). The old side of
 * the change is never part of the tool result either — `File.Edit` returns only
 * line counts (`selected_lines` / `new_line_count` / `replacement_bytes`) and the
 * pre-edit hash, because the toolbox deliberately keeps results small.
 *
 * So a diff has to be assembled on the client from two things:
 *
 *   1. The edit itself — line coordinates and `new_lines` from the tool input,
 *      which is authoritative and always present.
 *   2. The old text — recovered from *earlier tool calls in the same session*:
 *      a `File.Read` result (its `lines` map plus its content hash), or the
 *      `content` argument of a `File.Create` / `File.Replace` (a whole-file write).
 *
 * Point 2 is reliable in practice rather than by luck: the server refuses a
 * `File.Edit` whose target ranges were not established by a preceding
 * `File.Read` (`read_required` / `stale_read` / `unread_range`), and it verifies
 * the current content hash against that read. The read therefore sits a handful
 * of events before the edit, and its hash equals the edit's `previous_hash`.
 * Matching on that hash is what makes a recovered line trustworthy — no hash
 * match means no removed text, and the diff degrades to real line numbers plus an
 * explicit "original content not recorded" marker instead of inventing content.
 *
 * Integration: this module never edits the shared core. It (a) replaces the
 * frozen `globalThis.MeToolPresenters` with a thin wrapper that feeds the content
 * cache from every rendered tool card, and (b) wraps the core's card builders to
 * place the diff under the card header. `app.js` resolves `MeToolPresenters` at
 * call time, and the card builders are top-level globals, so both take effect
 * without touching a single upstream character.
 */
(() => {
  "use strict";

  const presenters = globalThis.MeToolPresenters;
  if (!presenters || typeof presenters !== "object") return;

  /** Tools whose call is worth rendering as a diff. */
  const DIFF_TOOLS = new Set([
    "File.Edit", "File.EditBytes", "File.Create", "File.Replace", "File.Append",
  ]);
  /**
   * Tools whose `content` argument is the *whole* resulting file, and which can
   * therefore be cached as a candidate old version. `File.Append` is excluded on
   * purpose: its `content` is only the appended tail, not the file.
   */
  const WHOLE_FILE_WRITE_TOOLS = new Set(["File.Create", "File.Replace"]);

  const MAX_ROWS = 400;
  const MAX_CONTEXT = 2;
  const MAX_CANDIDATES = 16;

  /** path -> candidate[], oldest first. */
  const candidates = new Map();

  // ---- value helpers ------------------------------------------------------

  function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function integerOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : null;
  }

  function hashOrNull(value) {
    return typeof value === "string" && /^[0-9a-f]{8}$/i.test(value) ? value.toLowerCase() : null;
  }

  function normalizePath(value) {
    const text = String(value ?? "").trim().replaceAll("\\", "/");
    if (!text) return "";
    return text.startsWith("./") ? text.slice(2) : text;
  }

  function resultValue(output) {
    return objectValue(output?.result?.value);
  }

  function resultSucceeded(output) {
    return String(output?.result?.state ?? "").toLowerCase() === "succeeded";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  /** Split text into logical lines without their terminators. */
  function splitFileLines(text) {
    const source = String(text ?? "");
    const lines = [];
    let start = 0;
    let index = 0;
    while (index < source.length) {
      const character = source[index];
      if (character === "\r") {
        index += source[index + 1] === "\n" ? 2 : 1;
        lines.push(source.slice(start, index));
        start = index;
      } else if (character === "\n") {
        index += 1;
        lines.push(source.slice(start, index));
        start = index;
      } else {
        index += 1;
      }
    }
    if (start < source.length) lines.push(source.slice(start));
    return lines.map((line) => line.replace(/\r\n$|\r$|\n$/, ""));
  }

  // ---- content cache ------------------------------------------------------
  //
  // A candidate is one known version of one file:
  //   { hash, lines: Map<lineNumber, text>, total, verified }
  //
  // `verified: true` means the content hash came from the server (`File.Read`),
  // so it may be matched exactly against an edit's `previous_hash`. Content
  // recovered from a write argument cannot be hashed on the client without an
  // async digest, so it is only used as a same-path fallback when the line count
  // matches, and the diff says the comparison is inferred rather than verified.

  function sameLines(candidate, lines) {
    if (candidate.total !== lines.length || candidate.lines.size !== lines.length) return false;
    return lines.every((text, offset) => candidate.lines.get(offset + 1) === text);
  }

  function pushCandidate(path, candidate, lines) {
    const list = candidates.get(path) || [];
    // Content-derived candidates carry no hash, so identity is their lines. The
    // same card is re-observed on every re-render; without this dedupe those
    // repeats would evict the verified reads that the diff depends on.
    const duplicate = candidate.hash
      ? list.find((item) => item.hash === candidate.hash)
      : list.find((item) => !item.hash && lines && sameLines(item, lines));
    if (duplicate) {
      list.splice(list.indexOf(duplicate), 1);
      for (const [line, text] of candidate.lines) duplicate.lines.set(line, text);
      if (candidate.total != null) duplicate.total = candidate.total;
      duplicate.verified = duplicate.verified || candidate.verified;
      // Re-push so `latestCandidate` keeps seeing it as the newest version.
      list.push(duplicate);
    } else {
      list.push(candidate);
      if (list.length > MAX_CANDIDATES) list.splice(0, list.length - MAX_CANDIDATES);
    }
    candidates.set(path, list);
  }

  function rememberRead(value) {
    const path = normalizePath(value?.path);
    const hash = hashOrNull(value?.hash);
    if (!path || !hash) return;
    const entries = Object.entries(objectValue(value.lines))
      .map(([line, text]) => [Number(line), typeof text === "string" ? text : String(text ?? "")])
      .filter(([line]) => Number.isInteger(line) && line > 0);
    if (!entries.length) return;
    pushCandidate(path, {
      hash,
      lines: new Map(entries),
      total: integerOrNull(value.total_lines),
      verified: true,
    });
  }

  function rememberContent(path, content) {
    const normalized = normalizePath(path);
    if (!normalized || typeof content !== "string") return null;
    const lines = splitFileLines(content);
    const candidate = {
      hash: null,
      lines: new Map(lines.map((text, index) => [index + 1, text])),
      total: lines.length,
      verified: false,
    };
    pushCandidate(normalized, candidate, lines);
    return candidate;
  }

  function resolveCandidate(path, hash, total) {
    const list = candidates.get(normalizePath(path));
    if (!list?.length) return null;
    if (hash) {
      const exact = list.find((item) => item.verified && item.hash === hash);
      if (exact) return exact;
    }
    if (total != null) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const item = list[index];
        if (!item.verified && item.total === total) return item;
      }
    }
    return null;
  }

  /**
   * The newest known version of a file, skipping the version the caller is
   * about to write. A whole-file write cannot be matched by hash on the client
   * (no synchronous sha256), and `observe` deliberately caches the incoming
   * content first, so "newest" alone would return the new text as its own old
   * side. Comparing against the candidate's own lines is exact, not heuristic.
   */
  function latestCandidate(path, excludeLines) {
    const list = candidates.get(normalizePath(path));
    if (!list?.length) return null;
    const target = excludeLines ? splitFileLines(excludeLines) : null;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const item = list[index];
      if (!target) return item;
      if (item.total === target.length && target.every(
        (text, offset) => item.lines.get(offset + 1) === text,
      )) continue;
      return item;
    }
    return null;
  }

  /** Feed the cache from anything the core already hands us while rendering. */
  function observe(name, inputJson, outputJson) {
    const input = objectValue(inputJson);
    if (outputJson && name === "File.Read" && resultSucceeded(outputJson)) {
      rememberRead(resultValue(outputJson));
    }
    if (WHOLE_FILE_WRITE_TOOLS.has(name) && typeof input.content === "string") {
      rememberContent(input.path, input.content);
    }
  }

  // ---- diff model ---------------------------------------------------------

  function contextRows(rows, candidate, from, to, shift) {
    if (!candidate) return;
    for (let line = from; line <= to; line += 1) {
      const text = candidate.lines.get(line);
      if (text === undefined) continue;
      rows.push({ kind: "context", oldLine: line, newLine: line + shift, text });
    }
  }

  function modelForEdit(input, output) {
    const value = resultValue(output);
    const path = normalizePath(input.path ?? value.path);
    const edits = Array.isArray(input.edits) ? input.edits : [];
    if (!edits.length) return null;

    const candidate = resolveCandidate(
      path, hashOrNull(value.previous_hash), integerOrNull(value.previous_total_lines),
    );
    // A same-path line-count match is a weaker claim than a hash match; the note
    // below says so instead of presenting the comparison as authoritative.
    const inferred = Boolean(candidate) && !candidate.verified;

    const ordered = edits
      .map((edit, index) => ({ edit: objectValue(edit), index }))
      .sort((left, right) => {
        const anchor = (item) => integerOrNull(item.edit.start_line ?? item.edit.before_line) ?? 0;
        return anchor(left) - anchor(right) || left.index - right.index;
      });

    const hunks = [];
    let delta = 0;
    let added = 0;
    let removed = 0;
    let missing = 0;

    for (const { edit, index } of ordered) {
      const operation = String(edit.operation ?? "");
      const newLines = Array.isArray(edit.new_lines) ? edit.new_lines.map((line) => String(line ?? "")) : [];
      const rows = [];

      if (operation === "insert") {
        const before = integerOrNull(edit.before_line) ?? 1;
        const newStart = before + delta;
        contextRows(rows, candidate, before - MAX_CONTEXT, before - 1, delta);
        newLines.forEach((text, offset) => {
          rows.push({ kind: "add", newLine: newStart + offset, text });
        });
        hunks.push({
          index, operation, rows,
          oldStart: before, oldCount: 0, newStart, newCount: newLines.length,
        });
        added += newLines.length;
        delta += newLines.length;
        continue;
      }

      const start = integerOrNull(edit.start_line) ?? 1;
      const end = Math.max(start, integerOrNull(edit.end_line) ?? start);
      const oldCount = end - start + 1;
      const newStart = start + delta;
      contextRows(rows, candidate, start - MAX_CONTEXT, start - 1, delta);
      for (let line = start; line <= end; line += 1) {
        const text = candidate?.lines.get(line);
        if (text === undefined) missing += 1;
        rows.push({ kind: "del", oldLine: line, text: text === undefined ? null : text });
      }
      newLines.forEach((text, offset) => {
        rows.push({ kind: "add", newLine: newStart + offset, text });
      });
      delta += newLines.length - oldCount;
      contextRows(rows, candidate, end + 1, end + MAX_CONTEXT, delta);
      hunks.push({
        index, operation, rows,
        oldStart: start, oldCount, newStart, newCount: newLines.length,
      });
      added += newLines.length;
      removed += oldCount;
    }

    if (!hunks.length) return null;
    return {
      kind: "edit",
      path,
      added,
      removed,
      missing,
      hunks,
      notes: [
        inferred ? "原始内容来自本会话中该文件的写入内容，按行数推断，未经哈希校验。" : "",
        candidate ? "" : "本会话中没有该文件的原始内容，删除侧只显示行号。",
        missing ? `${missing} 行原始内容未记录，以占位符显示。` : "",
      ].filter(Boolean),
    };
  }

  function modelForBytes(input, output) {
    const value = resultValue(output);
    const path = normalizePath(input.path ?? value.path);
    const edits = Array.isArray(input.edits) ? input.edits : [];
    if (!edits.length) return null;
    const rows = [];
    let added = 0;
    let removed = 0;
    for (const [index, raw] of edits.entries()) {
      const edit = objectValue(raw);
      const offset = integerOrNull(edit.target_offset) ?? 0;
      const length = integerOrNull(edit.target_length) ?? 0;
      const bytes = String(edit.data ?? "").trim().split(/\s+/).filter(Boolean);
      const operation = length === 0 ? "插入" : bytes.length ? "替换" : "删除";
      rows.push({
        kind: "hunk",
        text: `#${index + 1} 偏移 ${offset} · ${operation} ${length} 字节 → ${bytes.length} 字节`,
      });
      if (length > 0) {
        rows.push({ kind: "del", text: `${length} 字节（原内容未在会话记录中）` });
        removed += length;
      }
      if (bytes.length) {
        const text = bytes.join(" ");
        rows.push({ kind: "add", text: text.length > 512 ? `${text.slice(0, 512)}…` : text });
        added += bytes.length;
      }
    }
    return {
      kind: "bytes", path, added, removed, missing: 0,
      hunks: [{ rows, oldStart: null, oldCount: removed, newStart: null, newCount: added }],
      notes: ["字节级修改，单位是字节而不是行。"],
    };
  }

  function modelForWholeFileWrite(name, input, output) {
    const value = resultValue(output);
    const path = normalizePath(input.path ?? value.path);
    if (typeof input.content !== "string") return null;
    const newLines = splitFileLines(input.content);
    const newRows = (startLine) => newLines.map((text, offset) => ({
      kind: "add", newLine: startLine == null ? offset + 1 : startLine + offset, text,
    }));

    if (name === "File.Create") {
      if (!newLines.length) return null;
      return {
        kind: "create", path, added: newLines.length, removed: 0, missing: 0,
        hunks: [{ rows: newRows(1), oldStart: 0, oldCount: 0, newStart: 1, newCount: newLines.length }],
        notes: [],
      };
    }

    // File.Append's `content` is only the appended tail, so it must not be
    // cached as a whole version — hence the narrower tool set in `observe`.
    const candidate = resolveCandidate(path, hashOrNull(value.previous_hash), null)
      || latestCandidate(path, input.content);

    if (name === "File.Append") {
      const start = candidate ? candidate.total + 1 : null;
      return {
        kind: "append", path, added: newLines.length, removed: 0, missing: 0,
        hunks: [{
          rows: newRows(start), oldStart: start ?? 0, oldCount: 0,
          newStart: start ?? 1, newCount: newLines.length,
        }],
        notes: start == null ? ["本会话中没有该文件的行数，追加位置以行内序号显示。"] : [],
      };
    }

    // File.Replace: keep the whole old version only when we actually know it.
    const oldRows = [];
    if (candidate) {
      for (let line = 1; line <= candidate.total; line += 1) {
        const text = candidate.lines.get(line);
        oldRows.push({ kind: "del", oldLine: line, text: text === undefined ? null : text });
      }
    }
    const rows = [...oldRows, ...newRows(1)];
    return {
      kind: "replace", path, added: newLines.length,
      removed: oldRows.length,
      missing: oldRows.filter((row) => row.text === null).length,
      hunks: [{
        rows, oldStart: candidate ? 1 : 0, oldCount: oldRows.length,
        newStart: 1, newCount: newLines.length,
      }],
      notes: candidate ? ["整文件替换。"] : ["本会话中没有该文件的原始内容，只显示替换后的完整内容。"],
    };
  }

  function model(name, inputJson, outputJson) {
    // A diff needs the result: `previous_hash` / `previous_total_lines` live in
    // the output, and without them the old side cannot be identified at all. A
    // still-running edit keeps the shared core's "new content" block instead.
    if (!DIFF_TOOLS.has(name) || !outputJson || !resultSucceeded(outputJson)) return null;
    const input = objectValue(inputJson);
    try {
      if (name === "File.EditBytes") return modelForBytes(input, outputJson);
      if (name === "File.Edit") return modelForEdit(input, outputJson);
      return modelForWholeFileWrite(name, input, outputJson);
    } catch {
      // A malformed payload must never break the transcript: no diff, no noise.
      return null;
    }
  }

  // ---- rendering ----------------------------------------------------------

  function lineCell(value) {
    return `<span class="tool-diff-line-no">${value == null ? "" : escapeHtml(value)}</span>`;
  }

  function rowHtml(row) {
    if (row.kind === "hunk") {
      return '<div class="tool-diff-row tool-diff-hunk"><span class="tool-diff-mark">@@</span>'
        + `<span class="tool-diff-text">${escapeHtml(row.text)}</span></div>`;
    }
    if (row.kind === "context") {
      return `<div class="tool-diff-row tool-diff-context">${lineCell(row.oldLine)}${lineCell(row.newLine)}`
        + '<span class="tool-diff-mark"> </span>'
        + `<span class="tool-diff-text">${escapeHtml(row.text)}</span></div>`;
    }
    if (row.kind === "del") {
      const body = row.text === null
        ? '<span class="tool-diff-muted">（原内容未记录）</span>'
        : escapeHtml(row.text);
      return `<div class="tool-diff-row tool-diff-del">${lineCell(row.oldLine)}${lineCell(null)}`
        + `<span class="tool-diff-mark">-</span><span class="tool-diff-text">${body}</span></div>`;
    }
    return `<div class="tool-diff-row tool-diff-add">${lineCell(null)}${lineCell(row.newLine)}`
      + '<span class="tool-diff-mark">+</span>'
      + `<span class="tool-diff-text">${escapeHtml(row.text)}</span></div>`;
  }

  function statsHtml(diff) {
    const parts = [];
    if (diff.added) parts.push(`<span class="tool-diff-added">+${diff.added}</span>`);
    if (diff.removed) parts.push(`<span class="tool-diff-removed">−${diff.removed}</span>`);
    if (!parts.length) parts.push('<span class="tool-diff-muted">无变化</span>');
    return parts.join(" ");
  }

  function render(diff, { title = true } = {}) {
    if (!diff) return "";
    const rows = [];
    let count = 0;
    let truncated = false;
    for (const hunk of diff.hunks) {
      if (hunk.oldStart != null) {
        const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
        rows.push('<div class="tool-diff-row tool-diff-hunk">'
          + `<span class="tool-diff-mark">@@</span><span class="tool-diff-text">${escapeHtml(header)}</span></div>`);
      }
      for (const row of hunk.rows) {
        if (count >= MAX_ROWS) { truncated = true; break; }
        rows.push(rowHtml(row));
        count += 1;
      }
      if (truncated) break;
    }
    if (truncated) rows.push('<div class="tool-diff-truncated">差异过长，已截断显示。</div>');
    const heading = title
      ? `<div class="tool-block-title">修改差异 <span class="tool-diff-stats">${statsHtml(diff)}</span></div>`
      : "";
    return `<section class="tool-block tool-diff-block" data-diff-kind="${escapeHtml(diff.kind)}">`
      + heading
      + (diff.notes?.length ? `<div class="tool-diff-note">${diff.notes.map(escapeHtml).join(" ")}</div>` : "")
      + `<div class="tool-diff-scroll">${rows.join("")}</div>`
      + "</section>";
  }

  // ---- inline placement ---------------------------------------------------
  //
  // The core renders a tool's details only for cards whose id is in
  // `state.expandedTools`, a module-scoped Set inside `app.js` with no way in
  // from outside. A diff behind that click is invisible in practice: the reader
  // sees a collapsed "编辑文件 src/x.js · 2 处修改" row and never learns what
  // changed.
  //
  // So the diff is rendered *outside* `.tool-details`, directly under the card
  // header, and stays visible whether or not the details are open. The expand
  // state is left alone, so opening the details still reveals the input/output
  // JSON exactly as before, and the same hunk is never printed twice.
  //
  // Both card paths need it: `createMessageNode` builds a card from HTML, and
  // `updateToolCardNode` rewrites an existing card when the result lands. They
  // are top-level declarations of a classic script, so they are reachable as
  // globals — but only after `app.js` has run, and this module loads before it.

  const INLINE_CLASS = "tool-diff-inline";

  /** Mirror `app.js::toolPresentationOutput()` for a raw tool record. */
  function toolOutput(tool) {
    if (!tool || (!tool.result && !tool.output && !tool.updates?.length)) return undefined;
    const detail = tool.result?.detail;
    // The projection keeps the result payload as JSON text.
    let value = detail;
    if (typeof detail === "string") {
      try { value = JSON.parse(detail); } catch { value = undefined; }
    }
    return {
      text: tool.output || "",
      updates: tool.updates || [],
      result: tool.result
        ? { state: tool.result.state, exitCode: tool.result.exitCode, value, rawDetail: detail }
        : null,
    };
  }

  /** The diff for one call, or "" when there is nothing to show. */
  function diffBlockFor(name, inputJson, outputJson) {
    const diff = model(name, inputJson, outputJson);
    // No heading: the card header already names the file and the edit count.
    return diff ? render(diff, { title: false }) : "";
  }

  /** Last markup written per card, so a periodic refresh does not rebuild it. */
  const renderedBlocks = new WeakMap();

  function syncInlineDiff(node, tool) {
    if (!node || typeof node.querySelector !== "function" || !tool) return;
    const name = String(tool.name ?? "");
    const args = tool.args ?? {};
    const output = toolOutput(tool);
    // Cache here as well, so the block does not depend on which core path ran.
    observe(name, args, output);
    const existing = node.querySelector(`:scope > .${INLINE_CLASS}`);
    const block = diffBlockFor(name, args, output);
    if (!block) {
      existing?.remove();
      return;
    }
    const documentValue = node.ownerDocument || globalThis.document;
    const header = node.querySelector(":scope > .tool-header");
    if (!header?.after || !documentValue?.createElement) return;
    const host = existing || documentValue.createElement("div");
    if (!existing) {
      host.className = INLINE_CLASS;
      // Clicking the diff must not toggle the card, exactly like `.tool-details`.
      host.addEventListener("click", (event) => event.stopPropagation());
      header.after(host);
    }
    if (renderedBlocks.get(host) === block) return;
    renderedBlocks.set(host, block);
    host.innerHTML = block;
  }

  /** Wrap one core global once. Returns false while it does not exist yet. */
  function wrapGlobal(name, decorate) {
    const original = globalThis[name];
    if (typeof original !== "function" || original.meTricToolDiff === true) return false;
    const wrapper = function (...args) {
      const result = original.apply(this, args);
      try {
        decorate(result, args);
      } catch {
        // A broken diff must never break the transcript.
      }
      return result;
    };
    wrapper.meTricToolDiff = true;
    globalThis[name] = wrapper;
    return true;
  }

  function installCardWrappers() {
    wrapGlobal("createMessageNode", (node, [message]) => {
      if (message?.kind === "tool") syncInlineDiff(node, message.tool);
    });
    wrapGlobal("updateToolCardNode", (_result, [node, tool]) => syncInlineDiff(node, tool));
  }

  // The globals appear at different times depending on script order and on
  // whether the document is already interactive, so retry at each milestone.
  installCardWrappers();
  if (typeof globalThis.document?.addEventListener === "function") {
    globalThis.document.addEventListener("DOMContentLoaded", installCardWrappers, { once: true });
  }
  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("load", installCardWrappers, { once: true });
  }

  function install() {
    const wrapped = {
      KNOWN_TOOLS: presenters.KNOWN_TOOLS,
      has: (name) => presenters.has(name),
      names: () => presenters.names(),
      safeJson: (value) => presenters.safeJson(value),
      present(name, inputJson, outputJson) {
        observe(name, inputJson, outputJson);
        return presenters.present(name, inputJson, outputJson);
      },
      summarize(name, inputJson) {
        // A collapsed card only calls summarize, so whole-file writes must be
        // cached from here too; outputs arrive through imageAttachments.
        observe(name, inputJson, undefined);
        return presenters.summarize(name, inputJson);
      },
      describe(name, inputJson, outputJson) {
        observe(name, inputJson, outputJson);
        const details = presenters.describe(name, inputJson, outputJson);
        const diff = model(name, inputJson, outputJson);
        if (diff) details.diff = diff;
        return details;
      },
      // The diff is placed under the card header instead of in here, so the
      // details block never repeats it.
      renderDetails: presenters.renderDetails,
      imageAttachments(name, output) {
        // Every rendered tool card funnels through here, which is the only
        // guaranteed chance to see another tool's *output* while it is on
        // screen. That is what lets a later File.Edit find its File.Read.
        observe(name, undefined, output);
        return presenters.imageAttachments(name, output);
      },
    };
    globalThis.MeToolPresenters = Object.freeze(wrapped);
    return globalThis.MeToolPresenters;
  }

  install();

  globalThis.MeTricToolDiff = Object.freeze({
    DIFF_TOOLS: Object.freeze([...DIFF_TOOLS]),
    model,
    render,
    diffBlockFor,
    syncInlineDiff,
    installCardWrappers,
    observe,
    rememberRead,
    rememberContent,
    /** Test seam only: drop the recovered-content cache. */
    reset() { candidates.clear(); },
    /** Test seam only: how many versions of `path` are cached. */
    cachedVersions(path) { return (candidates.get(normalizePath(path)) || []).length; },
  });
})();
