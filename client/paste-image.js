/**
 * me-tric clipboard images.
 *
 * Why this exists: a user prompt is a plain string. `submit_user_prompt` carries
 * text only (`UserPromptEvent { content }`), the model sees it XML-escaped inside
 * `<user_prompt>`, and `EventDataBase::append_image_content` refuses image content
 * from any tool except `Image.View` / `Image.Send` / `WebBrowser.Snapshot`. So the
 * client cannot attach an image to a prompt — it can only put a path in front of
 * the agent and let the agent decide to read it.
 *
 * The chosen route: upload the pasted blob through the server's own file API into
 * `workspace/.me/attachments/`, then append one `[图片] <path>` line per image to
 * the prompt text. `Image.View` resolves a relative path against the server-side
 * workspace, so that line is directly usable. No server change, no new command,
 * and no instruction sentence — the marker only labels what the path is.
 *
 * Why upload instead of writing a local file: the workspace lives on the server.
 * For a remote Gateway deployment the client's disk is not the server's disk, and
 * the native bridge exposes no file-writing command at all.
 *
 * Why the fetch interception: `app.js` reads `globalThis.MeFrontendRuntime` once at
 * load time and calls `frontendRuntime.fetch` for every request, including the
 * prompt submission. Replacing that global with a prototype child before `app.js`
 * runs is therefore the only way to rewrite a prompt body without touching the
 * shared core. `build-frontend.js` asserts this module loads before `app.js`.
 *
 * Every DOM and web-platform reference goes through `globalThis` so the module can
 * be loaded in a bare test sandbox, exactly like `tool-diff.js`.
 */
(() => {
  "use strict";

  const RUNTIME = globalThis.MeFrontendRuntime;
  if (!RUNTIME) return;

  const CONTAINER_ID = "me-tric-attachments";
  const SHELL_CLASS = "me-tric-has-attachments";
  const INPUT_ID = "prompt-input";
  const SEND_ID = "send-prompt";
  /** Matches the core's `UPLOAD_CHUNK_BYTES`; the server rejects chunks over 512 KiB. */
  const CHUNK_BYTES = 384 * 1024;
  const IMAGE_LINE_PREFIX = "[图片] ";
  const SEND_SHORTCUT_ENTER = "enter";
  const SEND_SHORTCUT_MODIFIED_ENTER = "modified-enter";
  const SEND_SHORTCUT_PREFERENCE = "me-send-shortcut";

  // ---- pure helpers -------------------------------------------------------

  const IMAGE_EXTENSIONS = Object.freeze({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/tiff": "tiff",
  });

  function imageExtension(mime) {
    return IMAGE_EXTENSIONS[String(mime || "").trim().toLowerCase()] || "png";
  }

  /**
   * A single path component. The server's `validate_component` rejects anything
   * containing `/`, `\` or `:`, and the internal temp pattern `.me-upload-*.tmp`.
   */
  function attachmentName(sequence, extension, { now = Date.now(), salt = Math.random() } = {}) {
    const stamp = new Date(now);
    const pad = (value) => String(value).padStart(2, "0");
    const date = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`;
    const time = `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
    const random = Math.floor(Math.abs(Number(salt) || 0) * 0xffffff)
      .toString(16)
      .padStart(6, "0")
      .slice(-6);
    const index = String(Math.max(0, Math.trunc(Number(sequence) || 0)) + 1);
    const suffix = String(extension || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
    return `paste-${date}-${time}-${random}-${index}.${suffix}`;
  }

  /** `Image.View` resolves relative paths against the workspace, so uploads must be expressed that way. */
  function relativeTo(root, absolute) {
    const normalize = (value) => String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const base = normalize(root);
    const full = normalize(absolute);
    if (!full) return "";
    if (!base) return full;
    if (full.toLowerCase() === base.toLowerCase()) return "";
    const prefix = `${base}/`;
    if (!full.toLowerCase().startsWith(prefix.toLowerCase())) return full;
    return full.slice(prefix.length);
  }

  function isImageItem(item) {
    return Boolean(item) && item.kind === "file" && String(item.type || "").toLowerCase().startsWith("image/");
  }

  function contentWithImages(text, paths) {
    const lines = (Array.isArray(paths) ? paths : [])
      .map((path) => String(path || "").trim())
      .filter(Boolean)
      .map((path) => `${IMAGE_LINE_PREFIX}${path}`);
    const base = String(text ?? "").replace(/\s+$/, "");
    if (!lines.length) return base;
    return base ? `${base}\n${lines.join("\n")}` : lines.join("\n");
  }

  function hasImageLine(text, path) {
    const line = `${IMAGE_LINE_PREFIX}${String(path || "").trim()}`;
    return String(text ?? "")
      .split(/\r?\n/)
      .some((candidate) => candidate.trim() === line);
  }

  /**
   * Idempotent, because one submission can be reached twice: the box is prefilled
   * when it was empty, and the request body is rewritten when it was not.
   */
  function submissionContent(text, paths) {
    const base = String(text ?? "");
    const missing = (Array.isArray(paths) ? paths : []).filter((path) => !hasImageLine(base, path));
    return missing.length ? contentWithImages(base, missing) : base;
  }

  /** Mirrors `app.js::sendShortcutPressed()`; a wrong answer only costs a visible prefill. */
  function enterSubmits(event) {
    if (!event || event.key !== "Enter" || event.ctrlKey || event.metaKey) return false;
    return readSendShortcut() === SEND_SHORTCUT_ENTER
      ? !event.shiftKey && !event.altKey
      : Boolean(event.shiftKey || event.altKey);
  }

  function readSendShortcut() {
    const normalize = (value) => (value === SEND_SHORTCUT_ENTER ? SEND_SHORTCUT_ENTER : SEND_SHORTCUT_MODIFIED_ENTER);
    try {
      const stored = RUNTIME.devicePreferences?.getItem(SEND_SHORTCUT_PREFERENCE);
      if (stored) return normalize(stored);
    } catch (_) { /* fall through to localStorage */ }
    try {
      const stored = globalThis.localStorage?.getItem(SEND_SHORTCUT_PREFERENCE);
      if (stored) return normalize(stored);
    } catch (_) { /* no storage available */ }
    return SEND_SHORTCUT_MODIFIED_ENTER;
  }

  // ---- server file API ----------------------------------------------------

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return globalThis.btoa(binary);
  }

  async function post(path, body, workspaceId) {
    const response = await RUNTIME.fetch(RUNTIME.apiPath(path, workspaceId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    return payload;
  }

  /** `files/mkdir` uses a non-recursive `create_dir`, so "already exists" is the normal case. */
  async function ensureDirectory(parent, name, workspaceId) {
    try {
      const created = await post("/api/files/mkdir", { parent, name }, workspaceId);
      const path = String(created?.entry?.path || "");
      if (path) return path;
    } catch (_) { /* resolve the existing directory below */ }
    const listing = await post("/api/files/list", { path: parent, roots: false }, workspaceId);
    const entry = (listing?.entries || []).find((item) => item.name === name && item.kind === "directory");
    if (entry?.path) return String(entry.path);
    throw new Error(`无法创建目录 ${name}`);
  }

  /** Keyed by workspace, because the selected workspace can change without a reload. */
  const directories = new Map();

  function workspaceDirectory(workspaceId) {
    const cached = directories.get(workspaceId);
    if (cached) return cached;
    const pending = (async () => {
      // An empty path resolves to the server's workspace root; the answer is the
      // only reliable source of that absolute path.
      const listing = await post("/api/files/list", { path: null, roots: false }, workspaceId);
      const workspace = String(listing?.path || "");
      if (!workspace) throw new Error("无法确定工作区目录");
      const dotMe = await ensureDirectory(workspace, ".me", workspaceId);
      const attachmentsDirectory = await ensureDirectory(dotMe, "attachments", workspaceId);
      return { workspace, directory: attachmentsDirectory };
    })();
    directories.set(workspaceId, pending);
    pending.catch(() => directories.delete(workspaceId));
    return pending;
  }

  async function uploadImage(file, name, directory, workspaceId, onProgress) {
    // `keep_both` is the only policy that never dead-ends: without one the server
    // answers `requires_confirmation` with no upload at all, and `skip` discards it.
    const created = await post("/api/files/uploads/create", {
      destination: directory,
      name,
      size_bytes: file.size,
      conflict_policy: "keep_both",
    }, workspaceId);
    const upload = created?.upload;
    if (!upload?.upload_id) throw new Error("上传未能开始");
    try {
      let offset = 0;
      while (offset < file.size) {
        const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
        await post("/api/files/uploads/chunk", {
          upload_id: upload.upload_id,
          offset,
          data: bytesToBase64(bytes),
        }, workspaceId);
        offset += bytes.byteLength;
        onProgress?.(offset, file.size);
      }
      const finished = await post("/api/files/uploads/finish", { upload_id: upload.upload_id }, workspaceId);
      if (finished?.state !== "completed") throw new Error(finished?.error || "上传未完整完成");
      return String(finished.target_path || upload.target_path || "");
    } catch (error) {
      await post("/api/files/uploads/cancel", { upload_id: upload.upload_id }, workspaceId).catch(() => {});
      throw error;
    }
  }

  // ---- thumbnails ---------------------------------------------------------

  let sequence = 0;
  /** Live chips in paste order: `{ state, path, url, node }`. */
  const attachments = [];

  /**
   * `state.workspaceId` is module-scoped inside `app.js`; the selected agent row is
   * its only readable projection, because `updateAgentRow()` mirrors it there.
   */
  function currentWorkspaceId() {
    const row = globalThis.document?.querySelector?.(".agent-row.active");
    return row?.dataset?.workspaceId || "chat";
  }

  function shell() {
    return globalThis.document?.querySelector?.("#composer-shell") || null;
  }

  function container() {
    const host = shell();
    if (!host) return null;
    const existing = host.querySelector?.(`#${CONTAINER_ID}`);
    if (existing) return existing;
    const stack = host.querySelector?.(".prompt-input-stack");
    if (!stack?.before || !globalThis.document?.createElement) return null;
    const element = globalThis.document.createElement("div");
    element.id = CONTAINER_ID;
    element.className = "me-tric-attachments";
    element.setAttribute("role", "list");
    element.setAttribute("aria-label", "待发送的图片");
    // Placed before the textarea so the strip sits on the left of the composer.
    stack.before(element);
    return element;
  }

  function syncShell() {
    shell()?.classList?.toggle(SHELL_CLASS, attachments.length > 0);
  }

  function setState(record, state, label) {
    record.state = state;
    const node = record.node;
    if (!node) return;
    node.dataset.state = state;
    node.title = label || "";
    node.setAttribute?.("aria-label", label || "图片");
    const badge = node.querySelector?.(".me-tric-attachment-badge");
    if (badge) badge.textContent = state === "ready" ? "✓" : state === "failed" ? "!" : "";
  }

  function addChip(file) {
    const host = container();
    const documentValue = globalThis.document;
    if (!host || !documentValue?.createElement) return null;
    const node = documentValue.createElement("div");
    node.className = "me-tric-attachment";
    node.setAttribute("role", "listitem");
    const thumb = documentValue.createElement("img");
    thumb.className = "me-tric-attachment-thumb";
    thumb.alt = "";
    thumb.draggable = false;
    const badge = documentValue.createElement("span");
    badge.className = "me-tric-attachment-badge";
    badge.setAttribute("aria-hidden", "true");
    const remove = documentValue.createElement("button");
    remove.className = "me-tric-attachment-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "移除图片");
    remove.title = "移除图片";
    node.append(thumb, badge, remove);

    const record = { id: `attachment-${++sequence}`, state: "uploading", path: "", url: "", node };
    node.dataset.attachmentId = record.id;
    record.url = String(globalThis.URL?.createObjectURL?.(file) || "");
    if (record.url) thumb.src = record.url;
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeChip(record);
    });

    host.append(node);
    attachments.push(record);
    setState(record, "uploading", "正在上传…");
    syncShell();
    return record;
  }

  function removeChip(record) {
    const index = attachments.indexOf(record);
    if (index >= 0) attachments.splice(index, 1);
    if (record.url) globalThis.URL?.revokeObjectURL?.(record.url);
    record.node?.remove?.();
    syncShell();
  }

  function removeByPath(path) {
    for (const record of attachments.filter((item) => item.path === path)) removeChip(record);
  }

  function readyPaths() {
    return attachments
      .filter((record) => record.state === "ready" && record.path)
      .map((record) => record.path);
  }

  async function addImage(file) {
    const record = addChip(file);
    if (!record) return;
    const workspaceId = currentWorkspaceId();
    try {
      const { workspace, directory } = await workspaceDirectory(workspaceId);
      const name = attachmentName(sequence, imageExtension(file.type));
      const target = await uploadImage(file, name, directory, workspaceId);
      const relative = relativeTo(workspace, target);
      if (!relative) throw new Error("无法确定图片路径");
      record.path = relative;
      setState(record, "ready", `已上传 · ${relative}`);
    } catch (error) {
      record.path = "";
      setState(record, "failed", `上传失败：${error?.message || error}`);
    }
  }

  // ---- events -------------------------------------------------------------

  function onPaste(event) {
    const input = globalThis.document?.getElementById?.(INPUT_ID);
    if (!input || event.target !== input) return;
    const files = Array.from(event.clipboardData?.items || [])
      .filter(isImageItem)
      .map((item) => item.getAsFile?.())
      .filter(Boolean);
    if (!files.length) return;
    // The clipboard holds an image rather than text worth pasting: take it over.
    event.preventDefault();
    for (const file of files) void addImage(file);
  }

  /**
   * `app.js` opens the send-settings drawer instead of submitting when the box is
   * empty, so an image-only message needs its path lines in the box to go out.
   */
  function prefillEmptyInput() {
    const input = globalThis.document?.getElementById?.(INPUT_ID);
    if (!input) return;
    const paths = readyPaths();
    if (!paths.length) return;
    const value = String(input.value ?? "");
    if (value.trim()) return;
    const content = submissionContent(value, paths);
    if (content === value) return;
    input.value = content;
    const EventValue = globalThis.Event;
    if (typeof EventValue === "function") {
      input.dispatchEvent?.(new EventValue("input", { bubbles: true }));
    }
  }

  function onKeydown(event) {
    if (event.target?.id !== INPUT_ID || !enterSubmits(event)) return;
    prefillEmptyInput();
  }

  function onClick(event) {
    if (!event.target?.closest?.(`#${SEND_ID}`)) return;
    prefillEmptyInput();
  }

  // ---- request interception ----------------------------------------------

  function commandRequest(input, options) {
    const url = String(typeof input === "string" ? input : input?.url || "");
    if (!/\/command(?:[?#]|$)/.test(url)) return null;
    if (typeof options?.body !== "string") return null;
    let payload;
    try {
      payload = JSON.parse(options.body);
    } catch (_) {
      return null;
    }
    if (payload?.command !== "submit_user_prompt" || typeof payload.content !== "string") return null;
    return payload;
  }

  async function fetchWithImages(base, input, options) {
    const payload = commandRequest(input, options);
    const paths = payload ? readyPaths() : [];
    if (!paths.length) return base.fetch(input, options);
    const content = submissionContent(payload.content, paths);
    const rewritten = content === payload.content
      ? options
      : { ...options, body: JSON.stringify({ ...payload, content }) };
    const response = await base.fetch(input, rewritten);
    // Only an accepted submission consumes the chips; a rejected one keeps them so
    // the user can simply send again.
    let accepted = Boolean(response?.ok);
    if (accepted && typeof response.clone === "function") {
      try {
        accepted = (await response.clone().json())?.ok !== false;
      } catch (_) { /* keep the status-based verdict */ }
    }
    if (accepted) for (const path of paths) removeByPath(path);
    return response;
  }

  // ---- bootstrap ----------------------------------------------------------

  function install() {
    const base = globalThis.MeFrontendRuntime;
    if (base && !base.meTricPasteImages) {
      // A prototype child keeps every live getter and method of the frozen runtime
      // intact while overriding exactly one property.
      const patched = Object.create(base);
      Object.defineProperty(patched, "fetch", {
        value: (input, options) => fetchWithImages(base, input, options),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(patched, "meTricPasteImages", { value: true });
      globalThis.MeFrontendRuntime = patched;
    }
    const documentValue = globalThis.document;
    if (typeof documentValue?.addEventListener !== "function") return;
    documentValue.addEventListener("paste", onPaste, true);
    documentValue.addEventListener("keydown", onKeydown, true);
    documentValue.addEventListener("click", onClick, true);
  }

  install();

  globalThis.MeTricPasteImage = Object.freeze({
    IMAGE_LINE_PREFIX,
    attachments,
    imageExtension,
    attachmentName,
    relativeTo,
    isImageItem,
    contentWithImages,
    hasImageLine,
    submissionContent,
    enterSubmits,
    readyPaths,
    addImage,
    install,
  });
})();
