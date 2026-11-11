"use strict";

const { describe, expect, test } = require("bun:test");
const { existsSync, readFileSync: readFileUtf8 } = require("node:fs");
const { join } = require("node:path");

// Every fixture in this repository is checked out with CRLF line endings on Windows.
// Normalise once here so multi-line assertions can use plain \n and stay platform-neutral.
function readFileSync(path) {
  return readFileUtf8(path, "utf8").replace(/\r\n/g, "\n");
}

function loadClientRuntime({ platform = "", userAgent = "", download = null } = {}) {
  const source = readFileSync(join(import.meta.dir, "../client/client-runtime.js"), "utf8");
  const calls = [];
  const browserBeacons = [];
  const nativeWindowListeners = new Map();
  const nativeDocumentListeners = new Map();
  const sandbox = {
    addEventListener(type, listener) { nativeWindowListeners.set(type, listener); },
    __TAURI__: {
      core: {
        Channel: class { onmessage() {} },
        async invoke(command, payload) {
          calls.push({ command, payload });
          if (command === "client_bootstrap") return {
            clientVersion: "0.1.89",
            endpoint: "http://127.0.0.1:38201",
            activeDeviceId: "office",
            devices: [
              { id: "office", endpoint: "http://127.0.0.1:38201", active: true },
              { id: "lab", endpoint: "https://lab.example", active: false },
            ],
            devicePreferences: {
              "me-theme": "ocean",
              "me-color-mode": "light",
              "me-send-shortcut": "enter",
              "me-window-border-style": "theme",
              "me-raw-edb-decoding": "false",
            },
            rememberedDevices: [
              { endpoint: "http://127.0.0.1:38200", password: "local secret", updatedAt: 2, online: true },
              { endpoint: "https://offline.example", password: "old secret", updatedAt: 1, online: false },
            ],
            localDevice: { endpoint: "http://127.0.0.1:38200", online: true, requiresPassword: true },
          };
          if (command === "client_window_action") return { maximized: false, fullscreen: false };
          if (command === "configure_target") {
            return { endpoint: "https://gateway.example", deviceId: payload.deviceId ?? "default" };
          }
          if (command === "set_active_device") return [
            { id: "office", endpoint: "http://127.0.0.1:38201", active: false },
            { id: payload.deviceId, endpoint: "https://lab.example", active: true },
          ];
          if (command === "list_devices") return [
            { id: "office", endpoint: "http://127.0.0.1:38201", active: true },
            { id: "lab", endpoint: "https://lab.example", active: false },
          ];
          if (command === "probe_device") return {
            deviceId: payload.deviceId, status: 200, productVersion: "0.1.116",
            requiresPassword: true, authenticated: false,
          };
          if (command === "remember_device") return {
            endpoint: payload.endpoint, password: payload.password, updatedAt: 3, online: true,
          };
          if (command === "forget_device") return null;
          if (command === "login_device") return {
            ok: true, authenticated: true, deviceId: payload.deviceId, httpStatus: 200,
          };
          if (command === "gateway_request") return {
            status: 200,
            headers: { "content-type": "application/json" },
            bodyText: JSON.stringify({ required: true, authenticated: false }),
            bodyBase64: null,
          };
          if (command === "set_device_preference") return null;
          if (command === "cancel_download") return null;
          if (command === "download_file") {
            if (download) return download(payload);
            payload.progress.onmessage({ requestId: "test-download", bytes: 12 });
            return { path: "/Downloads/archive.zip", bytes: 12 };
          }
          throw new Error(`unexpected command ${command}`);
        },
      },
    },
    navigator: {
      platform,
      userAgent,
      sendBeacon(input, body) {
        browserBeacons.push({ input, body });
        return true;
      },
    },
    fetch: async () => new Response("browser"),
  };
  const initialViewportContent = "width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content";
  const viewportMeta = {
    content: initialViewportContent,
    getAttribute(name) { return name === "content" ? this.content : null; },
    setAttribute(name, value) { if (name === "content") this.content = String(value); },
  };
  const documentValue = {
    querySelector(selector) { return selector === 'meta[name="viewport"]' ? viewportMeta : null; },
    addEventListener(type, listener) { nativeDocumentListeners.set(type, listener); },
    baseURI: "http://tauri.localhost/",
    documentElement: {
      attributes: {},
      style: { visibility: "" },
      classList: { add() {} },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      removeAttribute(name) { delete this.attributes[name]; },
    },
  };
  const factory = new Function(
    "globalThis", "document", "URL", "Headers", "Request", "Response", "Blob",
    "DOMException", "TextEncoder", "atob", "btoa",
    `${source}\nreturn globalThis.MeFrontendRuntime;`,
  );
  const runtime = factory(
    sandbox, documentValue, URL, Headers, Request, Response, Blob,
    DOMException, TextEncoder, atob, btoa,
  );
  return {
    runtime, sandbox, calls, browserBeacons, documentValue, viewportMeta,
    nativeWindowListeners, nativeDocumentListeners,
  };
}

describe("ME Tric native adapter", () => {
  test("uses native UTF-8 JSON responses while leaving frontend assets local", async () => {
    const { runtime, sandbox, calls, viewportMeta } = loadClientRuntime();
    expect(viewportMeta.content).toBe("width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content");
    expect(await runtime.initialize()).toEqual({
      endpoint: "http://127.0.0.1:38201",
      activeDeviceId: "office",
      devices: [
        { id: "office", endpoint: "http://127.0.0.1:38201", active: true },
        { id: "lab", endpoint: "https://lab.example", active: false },
      ],
      localDevice: { endpoint: "http://127.0.0.1:38200", online: true, requiresPassword: true },
    });
    expect(runtime.clientVersion).toBe("0.1.89");
    expect(runtime.activeDeviceId).toBe("office");
    expect(runtime.devices.map((device) => device.id)).toEqual(["office", "lab"]);
    expect(Object.getOwnPropertyDescriptor(runtime, "clientVersion").set).toBeUndefined();
    // The shared core calls configureTarget with one argument; the native default
    // device absorbs it and no deviceId is sent over IPC.
    expect(await runtime.configureTarget("https://gateway.example")).toEqual({
      endpoint: "https://gateway.example",
      deviceId: "default",
    });
    expect(calls.find((call) => call.command === "configure_target").payload).toEqual({
      endpoint: "https://gateway.example",
      activate: true,
    });
    expect(runtime.apiPath("/api/ui-projections/main/state", "workspace-one"))
      .toBe("/api/workspaces/workspace-one/ui-projections/main/state");
    for (const operation of ["preview", "original"]) {
      const path = `/api/images/main/${"a".repeat(64)}/${operation}`;
      expect(runtime.apiPath(path, "workspace-one")).toBe(`/api/workspaces/workspace-one${path.slice(4)}`);
    }
    const response = await sandbox.fetch("/api/auth/status", { cache: "no-store" });
    expect(await response.json()).toEqual({ required: true, authenticated: false });
    const request = calls.find((call) => call.command === "gateway_request").payload.request;
    expect(request.path).toBe("/api/auth/status");
    expect(request.bodyBase64).toBeUndefined();
    expect(await (await sandbox.fetch("/theme.js")).text()).toBe("browser");
  });


  test("keeps both document and native window hidden until the one-shot readiness boundary", async () => {
    const { runtime, calls, documentValue } = loadClientRuntime();
    expect(documentValue.documentElement.style.visibility).toBe("hidden");
    expect(documentValue.documentElement.attributes["data-me-tric-startup"]).toBe("pending");
    await runtime.initialize();
    expect(documentValue.documentElement.style.visibility).toBe("hidden");
    expect(calls.some((call) => call.command === "client_window_action")).toBe(false);
    const first = runtime.windowReady();
    const second = runtime.windowReady();
    expect(first).toBe(second);
    expect(documentValue.documentElement.style.visibility).toBe("");
    expect(documentValue.documentElement.attributes["data-me-tric-startup"]).toBeUndefined();
    await Promise.all([first, second]);
    const actions = calls.filter((call) => call.command === "client_window_action");
    expect(actions.map((call) => call.payload.action)).toEqual(["state", "show"]);
    expect(actions.filter((call) => call.payload.action === "show")).toHaveLength(1);

    const source = readFileSync(join(import.meta.dir, "../client/client-runtime.js"), "utf8");
    const readyStart = source.indexOf("function windowReady()");
    const readyEnd = source.indexOf("const runtime =", readyStart);
    const readiness = source.slice(readyStart, readyEnd);
    expect(readiness).not.toContain("requestAnimationFrame");
    expect(readiness).not.toContain("waitForFirstPaint");
  });

  test("uses the document readiness gate without desktop window actions on iOS", async () => {
    const { runtime, calls, documentValue, viewportMeta } = loadClientRuntime({
      platform: "iPhone",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X)",
    });
    expect(viewportMeta.content).toBe("width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content,maximum-scale=1,user-scalable=no");
    await runtime.initialize();
    await runtime.setWindowTitle("会话一 - ME Tric");
    await runtime.windowReady();
    expect(calls.filter((call) => call.command === "client_window_action")).toHaveLength(0);
    expect(documentValue.documentElement.style.visibility).toBe("");
  });

  test("caches dynamic native window titles", async () => {
    const { runtime, calls } = loadClientRuntime();
    await runtime.initialize();
    await runtime.setWindowTitle("会话一 - ME Tric");
    await runtime.setWindowTitle("会话一 - ME Tric");
    expect(calls.filter((call) => call.command === "client_window_action")).toEqual([
      {
        command: "client_window_action",
        payload: { action: "set_title", value: "会话一 - ME Tric" },
      },
    ]);
  });
  test("suppresses browser chrome gestures without breaking native text editing or terminal keys", () => {
    const { nativeWindowListeners, nativeDocumentListeners } = loadClientRuntime();
    const keydown = nativeWindowListeners.get("keydown");
    const contextmenu = nativeDocumentListeners.get("contextmenu");
    const target = (kind) => ({
      closest(selector) {
        if (kind === "editor" && selector.includes("textarea")) return this;
        if (kind === "raw" && selector.includes(".xterm")) return this;
        return null;
      },
    });
    const dispatch = (listener, properties) => {
      const event = {
        prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
        ...properties,
      };
      listener(event);
      return event;
    };

    expect(dispatch(keydown, { key: "F5", target: target("body") }).prevented).toBe(true);
    expect(dispatch(keydown, { key: "a", ctrlKey: true, target: target("body") }).prevented).toBe(true);
    expect(dispatch(keydown, { key: "a", metaKey: true, target: target("editor") }).prevented).toBe(false);
    expect(dispatch(keydown, { key: "r", metaKey: true, target: target("editor") }).prevented).toBe(true);
    expect(dispatch(keydown, { key: "r", ctrlKey: true, target: target("raw") }).prevented).toBe(false);
    expect(dispatch(keydown, { key: "ArrowLeft", altKey: true, target: target("body") }).prevented).toBe(true);
    expect(dispatch(contextmenu, { target: target("body") }).prevented).toBe(true);
    expect(dispatch(contextmenu, { target: target("editor") }).prevented).toBe(false);

    const config = readFileSync(join(import.meta.dir, "../client/src-tauri/tauri.conf.json"), "utf8");
    const windowsConfig = readFileSync(join(import.meta.dir, "../client/src-tauri/tauri.windows.conf.json"), "utf8");
    expect(config).toContain('"devtools": false');
    expect(config).toContain('"visible": false');
    expect(config).toContain('"decorations": false');
    expect(config).toContain('"transparent": true');
    expect(config).toContain('"shadow": true');
    expect(windowsConfig).toContain('"transparent": true');
    expect(windowsConfig).toContain('"shadow": false');
  });


  test("defines integrated client chrome and real compositor-owned platform window shaping", () => {
    const runtime = readFileSync(join(import.meta.dir, "../client/client-runtime.js"), "utf8");
    const css = readFileSync(join(import.meta.dir, "../client/client.css"), "utf8");
    const native = readFileSync(join(import.meta.dir, "../client/src-tauri/src/lib.rs"), "utf8");
    const nativeManifest = readFileSync(join(import.meta.dir, "../client/src-tauri/Cargo.toml"), "utf8");
    const runtimeWry = readFileSync(join(import.meta.dir, "../vendor/tauri-runtime-wry/src/lib.rs"), "utf8");
    const shadow = readFileSync(join(import.meta.dir, "../client/window-shadow.html"), "utf8");
    const frontendBuild = readFileSync(join(import.meta.dir, "../client/build-frontend.js"), "utf8");
    const windowsConfig = readFileSync(join(import.meta.dir, "../client/src-tauri/tauri.windows.conf.json"), "utf8");
    const capability = readFileSync(join(import.meta.dir, "../client/src-tauri/capabilities/default.json"), "utf8");
    const iosConfig = readFileSync(join(import.meta.dir, "../client/src-tauri/tauri.ios.conf.json"), "utf8");
    const iosInfo = readFileSync(join(import.meta.dir, "../client/src-tauri/Info.ios.plist"), "utf8");
    const shared = readFileSync(join(import.meta.dir, "../frontend/app.js"), "utf8");
    const sharedCss = readFileSync(join(import.meta.dir, "../frontend/style.css"), "utf8");
    expect(runtime).toContain('setAttribute?.("data-tauri-drag-region", "")');
    expect(runtime).toContain('document.querySelector?.(".sidebar")');
    expect(runtime).toContain('document.querySelector?.(".workspace-heading")');
    expect(runtime).toContain("markDragRegion(workspaceHeading)");
    expect(runtime).toContain('!element.classList?.contains?.("heading-actions")');
    expect(runtime).not.toContain('markDragRegion(document.querySelector?.(".heading-actions"))');
    expect(runtime).not.toContain('markDragRegion(document.querySelector?.("#create-workspace"))');
    expect(runtime).not.toContain('markDragRegion(document.querySelector?.("#open-workspace"))');
    expect(runtime).toContain('markDragRegion(document.querySelector?.("#login-screen"))');
    expect(runtime).toContain('chrome.className = "client-tabs-chrome"');
    expect(runtime).toContain('tabs.before(chrome)');
    expect(runtime).toContain('chrome.append(tabs)');
    expect(runtime).not.toContain('"#login-screen, .view-tabs"');
    expect(runtime).not.toContain('markDragRegion(tabs)');
    expect(runtime).toContain('sidebarDragRegion.className = "client-sidebar-drag-region"');
    expect(runtime).toContain('if (/iPhone|iPad|iPod/i.test(identity)) return "ios"');
    expect(runtime).toContain('if (/Mac/i.test(identity)) return "macos"');
    expect(runtime).toContain('if (/Win/i.test(identity)) return "windows"');
    expect(runtime).toContain('return "linux"');
    expect(runtime).toContain('createWindowControl("toggle_maximize"');
    expect(runtime).toContain('dynamicWindowTitle: true');
    expect(runtime).toContain('if (platform === "ios") return;');
    expect(runtime).toContain('clientPlatform() === "ios"');
    expect(css).toContain("html.me-tric-platform-ios {");
    expect(runtime).toContain("maximum-scale=1,user-scalable=no");
    expect(css).toContain("touch-action: pan-x pan-y;");
    expect(css).toContain("html.me-tric-platform-ios :is(");
    expect(css).toContain("height: calc(100% + env(safe-area-inset-top) + env(safe-area-inset-bottom));");
    expect(css).toContain("--client-ios-bottom-inset: max(0px, calc(env(safe-area-inset-bottom) - 6px))");
    expect(css).toContain("html.me-tric-platform-ios .statusbar {");
    expect(native).toContain("fn initialize_ios_webview");
    expect(native).toContain("root_view.setFrame(ui_window.bounds())");
    expect(native).toContain("webview.setFrame(root_view.bounds())");
    expect(native).toContain("UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight");
    expect(nativeManifest).toContain("objc2-ui-kit");
    expect(iosConfig).toContain('"visible": true');
    expect(iosConfig).toContain('"infoPlist": "Info.ios.plist"');
    expect(iosInfo).toContain("NSLocalNetworkUsageDescription");
    expect(iosInfo).toContain("UIFileSharingEnabled");
    expect(nativeManifest).toContain("target_os = \"ios\"");
    expect(shared).toContain('elements.createWorkspace.addEventListener("click"');
    expect(shared).toContain('elements.openWorkspace.addEventListener("click"');
    expect(capability).toContain('"core:window:allow-start-dragging"');
    expect(css.match(/--client-window-radius: 18px/g)).toHaveLength(1);
    expect(css).not.toContain("--client-window-radius: 8px");
    expect(css).not.toContain("html.me-tric-platform-windows {");
    expect(css).toContain("html.me-tric,\nhtml.me-tric body {\n  background: transparent;\n}");
    expect(css).toContain(".me-tric #app {\n  background: var(--bg);\n}");
    expect(css).not.toMatch(/\.me-tric\s+#login-screen(?:\s*,[^{}]*)?\s*\{[^}]*background\s*:/s);
    expect(sharedCss).toContain(".login-screen {");
    expect(sharedCss).toContain("radial-gradient(");
    expect(css).toContain("--client-window-outline: color-mix(in srgb, var(--text) 10%, var(--bg))");
    expect(css).toContain('html.me-tric[data-window-border-style="theme"] {');
    expect(css).toContain("--client-window-outline: var(--accent);");
    expect(runtime).toContain('windowBorderStyle: clientPlatform() !== "ios"');
    expect(css).toContain("html.me-tric body::after");
    expect(css).toContain("border: 1px solid var(--client-window-outline)");
    expect(css).toContain("html.me-tric-platform-macos body {");
    expect(css).toContain("html.me-tric-window-maximized body::after");
    expect(css).not.toContain(".client-window-drag-handle");
    expect(css).toContain(".me-tric-platform-macos .client-sidebar-drag-region {");
    expect(css).toContain("flex: 0 0 var(--client-chrome-height)");
    expect(css).toContain("margin-left: 88px");
    expect(css).toContain(".me-tric-platform-windows .view-tabs");
    expect(css).toContain("--view-tabs-end-space: 150px");
    expect(css).not.toContain("padding-right: 150px");
    expect(css).toMatch(/\.me-tric-platform-linux \.client-window-controls\s*\{[^}]*background: var\(--bg\)/);
    expect(css).toContain(".client-tabs-chrome {");
    expect(css).toMatch(/@media \(orientation: portrait\)\s*\{[^}]*\.client-window-controls\s*\{ height: 52px/);
    expect(css).toContain("pointer-events: none;");
    expect(css).toContain("inset: 0;");
    expect(css).not.toContain("backdrop-filter");
    expect(css).toContain(
      "html.me-tric-platform-windows .modal-backdrop,\n"
      + "html.me-tric-platform-windows .drawer-backdrop,\n"
      + "html.me-tric-platform-windows .mobile-sidebar-backdrop {\n"
      + "  overflow: hidden;\n"
      + "  border-radius: var(--client-window-radius);\n"
      + "}",
    );
    expect(css).not.toContain(".connection-overlay");
    expect(css).not.toContain(".session-sync-overlay");
    expect(css).not.toContain(".me-tric-platform-windows .user-message-menu");
    expect(css).not.toContain(".me-tric-platform-windows .agent-menu");
    expect(css).not.toContain(".me-tric-platform-windows .toast-region");
    expect(sharedCss).not.toContain("--client-window-radius");
    expect(sharedCss).not.toContain("me-tric-platform-windows");
    expect(native).toContain('setCornerRadius: corner_radius');
    expect(native).toContain("let corner_radius = if floating { 18.0 } else { 0.0 }");
    expect(native).toContain("setHasShadow: floating");
    expect(native).toContain("invalidateShadow");
    expect(native).toContain("WINDOWS_CORNER_RADIUS_CSS_PX: i32 = 18");
    expect(native).toContain("scaled_windows_px(WINDOWS_CORNER_RADIUS_CSS_PX, dpi)");
    expect(native).toContain("GetDpiForWindow");
    expect(native).toContain("SetWindowSubclass");
    expect(native).toContain("DefSubclassProc");
    expect(native).toContain("WM_NCHITTEST");
    expect(native).toContain("HTNOWHERE");
    expect(native).toContain("HTTOPLEFT");
    expect(native).toContain("HTBOTTOMRIGHT");
    expect(native).toContain("WINDOWS_WINDOW_SQUARE.store(!floating, Ordering::Release)");
    expect(native).toContain("WS_EX_NOREDIRECTIONBITMAP");
    expect(native).toContain("verify_windows_no_redirection(hwnd, \"main window\")");
    expect(native).toContain("WINDOWS_SHADOW_LABEL");
    expect(native).toContain("WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT");
    expect(native).toContain("HTTRANSPARENT");
    expect(native).toContain("SWP_NOACTIVATE | SWP_SHOWWINDOW");
    expect(native).toContain("ShowWindow(shadow_hwnd, SW_HIDE)");
    expect(native).toContain("!state.maximized");
    expect(native).toContain("!state.fullscreen");
    expect(native).not.toContain("SetLayeredWindowAttributes");
    expect(native).not.toContain("UpdateLayeredWindow");
    expect(native).not.toContain("LWA_COLORKEY");
    expect(native).not.toContain("DwmExtendFrameIntoClientArea");
    expect(native).not.toContain("DwmSetWindowAttribute");
    expect(native).not.toContain("CreateRoundRectRgn");
    expect(native).not.toContain("SetWindowRgn");
    expect(nativeManifest).toContain("[patch.crates-io]");
    expect(nativeManifest).toContain('tauri-runtime-wry = { path = "../../vendor/tauri-runtime-wry" }');
    expect(runtimeWry).toContain("let uses_no_redirection_bitmap =");
    expect(runtimeWry).toContain("is_window_transparent && !window_builder.inner.window.decorations");
    expect(runtimeWry).toContain("with_no_redirection_bitmap(true)");
    expect(runtimeWry).toContain("is_window_transparent && !uses_no_redirection_bitmap");
    expect(shadow).toContain("inset: 48px");
    expect(shadow).toContain("border-radius: 18px");
    expect(shadow).toContain("box-shadow:");
    expect(frontendBuild).toContain('"window-shadow.html"');
    expect(windowsConfig).toContain('"transparent": true');
    expect(windowsConfig).toContain('"shadow": false');
    expect(sharedCss).toContain("align-items: flex-end");
    expect(sharedCss).toContain("min-height: 46px");
    expect(sharedCss).toContain("height: 38px");
    expect(sharedCss).toContain("align-items: center");
    expect(sharedCss).toContain("justify-content: center");
    expect(sharedCss).toContain("calc(51px + env(safe-area-inset-top))");
    expect(sharedCss).toContain("height: 44px");
    expect(sharedCss).toContain("flex: 0 0 44px");
    expect(shared).toContain("dynamicWindowTitle: false");
    expect(shared).toContain('`${sessionTitle} - ${runtimeCapabilities.pageTitle}`');
  });
  test("uses native app selection boundaries while keeping content copyable", () => {
    const css = readFileSync(join(import.meta.dir, "../client/client.css"), "utf8");
    expect(css).toContain("html.me-tric body {");
    expect(css).toContain("-webkit-user-select: none;");
    expect(css).toContain("user-select: none;");
    for (const selector of [
      "input,",
      "textarea,",
      "[contenteditable=\"true\"]",
      ".user-message-content,",
      ".message-block.assistant .markdown,",
      ".notice-content,",
      ".session-content,",
      ".tool-details,",
      ".document-view,",
      ".compact-summary-content,",
      ".context-detail-raw,",
      ".message-modal-backdrop .modal > p",
    ]) expect(css).toContain(selector);
    expect(css).toContain("-webkit-user-select: text;");
    expect(css).toContain("user-select: text;");
    expect(css).not.toContain("selectstart");
  });

  test("persists all target-independent UI preferences through the native settings adapter", async () => {
    const { runtime, calls } = loadClientRuntime();
    expect(runtime.devicePreferences.getItem("me-theme")).toBeNull();
    await runtime.initialize();
    expect(runtime.devicePreferences.getItem("me-theme")).toBe("ocean");
    expect(runtime.devicePreferences.getItem("me-color-mode")).toBe("light");
    expect(runtime.devicePreferences.getItem("me-send-shortcut")).toBe("enter");
    expect(runtime.devicePreferences.getItem("me-window-border-style")).toBe("theme");
    expect(runtime.devicePreferences.getItem("me-raw-edb-decoding")).toBeNull();
    expect(runtime.capabilities.windowBorderStyle).toBe(true);

    await runtime.devicePreferences.setItem("me-theme", "obsidian");
    await runtime.devicePreferences.setItem("me-color-mode", "dark");
    await runtime.devicePreferences.setItem("me-send-shortcut", "modified-enter");
    await runtime.devicePreferences.setItem("me-window-border-style", "default");
    await runtime.devicePreferences.setItem("me-raw-edb-decoding", "true");
    await runtime.devicePreferences.setItem("gateway.endpoint", "must-not-persist");
    await runtime.configureTarget("https://other-gateway.example");
    expect(runtime.devicePreferences.getItem("me-theme")).toBe("obsidian");
    expect(runtime.devicePreferences.getItem("me-color-mode")).toBe("dark");
    expect(runtime.devicePreferences.getItem("me-send-shortcut")).toBe("modified-enter");
    expect(runtime.devicePreferences.getItem("me-window-border-style")).toBe("default");
    expect(runtime.devicePreferences.getItem("me-raw-edb-decoding")).toBeNull();
    expect(calls.filter((call) => call.command === "set_device_preference").map((call) => call.payload))
      .toEqual([
        { key: "me-theme", value: "obsidian" },
        { key: "me-color-mode", value: "dark" },
        { key: "me-send-shortcut", value: "modified-enter" },
        { key: "me-window-border-style", value: "default" },
      ]);

    const ios = loadClientRuntime({ platform: "iPhone", userAgent: "Mozilla/5.0 (iPhone)" });
    expect(ios.runtime.capabilities.windowBorderStyle).toBe(false);

    const clientRuntime = readFileSync(join(import.meta.dir, "../client/client-runtime.js"), "utf8");
    const nativeRuntime = readFileSync(join(import.meta.dir, "../client/src-tauri/src/lib.rs"), "utf8");
    expect(clientRuntime).not.toMatch(/document\.cookie|localStorage|globalThis\.indexedDB/);
    expect(clientRuntime).toContain('"me-theme", "me-color-mode", "me-send-shortcut", "me-window-border-style"');
    expect(clientRuntime).not.toContain('"me-raw-edb-decoding"');
    expect(nativeRuntime).toContain('const DEVICE_PREFERENCE_KEYS: [&str; 4]');
    expect(nativeRuntime).toContain('run_blocking(move || database.set_setting(&key, &value)).await');
    expect(nativeRuntime).toContain('device_preferences: BTreeMap<String, String>');
  });

  test("restores, updates, and forgets native remembered devices with online state", async () => {
    const { runtime, calls } = loadClientRuntime();
    expect(runtime.rememberedDevices.list()).toEqual([]);
    await runtime.initialize();
    expect(runtime.rememberedDevices.list()).toEqual([
      { endpoint: "http://127.0.0.1:38200", password: "local secret", updatedAt: 2, online: true },
      { endpoint: "https://offline.example", password: "old secret", updatedAt: 1, online: false },
    ]);

    await runtime.rememberedDevices.remember("https://new.example", "new secret");
    expect(runtime.rememberedDevices.list()[0]).toEqual({
      endpoint: "https://new.example", password: "new secret", updatedAt: 3, online: true,
    });
    await runtime.rememberedDevices.forget("https://offline.example");
    expect(runtime.rememberedDevices.list().map((device) => device.endpoint)).toEqual([
      "https://new.example", "http://127.0.0.1:38200",
    ]);
    expect(calls.find((call) => call.command === "remember_device").payload).toEqual({
      endpoint: "https://new.example", password: "new secret",
    });
    expect(calls.find((call) => call.command === "forget_device").payload).toEqual({
      endpoint: "https://offline.example",
    });

    const nativeRuntime = readFileSync(join(import.meta.dir, "../client/src-tauri/src/lib.rs"), "utf8");
    const nativeStorage = readFileSync(join(import.meta.dir, "../client/src-tauri/src/storage.rs"), "utf8");
    const nativeGateway = readFileSync(join(import.meta.dir, "../client/src-tauri/src/gateway.rs"), "utf8");
    expect(nativeRuntime).toContain("remembered_devices: Vec<RememberedDeviceStatus>");
    expect(nativeStorage).toContain("CREATE TABLE IF NOT EXISTS remembered_devices");
    expect(nativeGateway).toContain("const LOCAL_GATEWAY_FIRST_PORT: u16 = 38200");
    expect(nativeGateway).toContain("const LOCAL_GATEWAY_LAST_PORT: u16 = 38231");
    expect(nativeGateway).toContain("pub async fn online_remembered_devices");
  });

  test("restores the existing macOS window unless New Window is explicitly selected", () => {
    const nativeRuntime = readFileSync(join(import.meta.dir, "../client/src-tauri/src/lib.rs"), "utf8");
    const nativeStorage = readFileSync(join(import.meta.dir, "../client/src-tauri/src/storage.rs"), "utf8");
    const reopenStart = nativeRuntime.indexOf("if let tauri::RunEvent::Reopen");
    const reopenHandler = nativeRuntime.slice(reopenStart, nativeRuntime.indexOf("\n    });", reopenStart));
    const newWindowStart = nativeRuntime.indexOf("extern \"C-unwind\" fn new_me_tric_window");
    const newWindowEnd = nativeRuntime.indexOf("fn install_macos_dock_menu", newWindowStart);
    const newWindowAction = nativeRuntime.slice(newWindowStart, newWindowEnd);
    expect(reopenStart).toBeGreaterThan(-1);
    expect(newWindowStart).toBeGreaterThan(-1);
    expect(newWindowEnd).toBeGreaterThan(newWindowStart);
    expect(reopenHandler).toContain("restore_client_window(_app_handle)");
    expect(reopenHandler).not.toContain("spawn_client_instance()");
    expect(nativeRuntime).toContain("const NEW_CLIENT_WINDOW_LABEL: &str = \"新建窗口\"");
    expect(nativeRuntime).toContain("item.setAction(Some(sel!(newMeTricWindow:)))");
    expect(nativeRuntime).toContain("sel!(applicationDockMenu:)");
    expect(nativeRuntime).toContain("install_macos_dock_menu()?");
    expect(newWindowAction).toContain("spawn_client_instance()");
    const restoreStart = nativeRuntime.indexOf("fn restore_client_window");
    const restoreEnd = nativeRuntime.indexOf("fn spawn_client_instance", restoreStart);
    const restoreAction = nativeRuntime.slice(restoreStart, restoreEnd);
    expect(restoreAction.indexOf("window_revealed")).toBeGreaterThan(-1);
    expect(restoreAction.indexOf("window_revealed")).toBeLessThan(restoreAction.indexOf("app.show()?"));
    const closeStart = nativeRuntime.indexOf('#[cfg(target_os = "macos")]\nfn close_client_window');
    const closeEnd = nativeRuntime.indexOf('#[cfg(target_os = "windows")]', closeStart);
    const closeAction = nativeRuntime.slice(closeStart, closeEnd);
    expect(closeStart).toBeGreaterThan(-1);
    expect(closeAction).toContain("window.hide()");
    expect(closeAction).not.toContain("window.close()");
    expect(nativeRuntime).toContain("state.window_revealed.store(true, Ordering::Release)");
    expect(nativeRuntime).toContain("window.hide()?");
    expect(nativeRuntime).toContain("app.show()?");
    expect(nativeRuntime).toContain("window.unminimize()?");
    expect(nativeRuntime).toContain("window.show()?");
    expect(nativeRuntime).toContain("window.set_focus()?");
    expect(nativeRuntime).toContain("env::current_exe()?");
    expect(nativeRuntime).toContain("Command::new(executable)");
    expect(nativeStorage).toContain("const DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);");
    expect(nativeStorage).toContain(".busy_timeout(DATABASE_BUSY_TIMEOUT)");
  });

  test("routes page-close JSON beacons as text through the native transport", async () => {
    const { sandbox, calls, browserBeacons } = loadClientRuntime();
    const content = JSON.stringify({ command: "update_input_draft" });
    const body = new Blob([content], { type: "application/json" });
    expect(sandbox.navigator.sendBeacon("/api/command?workspace_id=chat", body)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = calls.find((call) => call.command === "gateway_request")?.payload.request;
    expect(request.path).toBe("/api/command?workspace_id=chat");
    expect(request.method).toBe("POST");
    expect(request.bodyText).toBe(content);
    expect(request.bodyBase64).toBeUndefined();
    expect(browserBeacons).toHaveLength(0);
    expect(sandbox.navigator.sendBeacon("/local-event", body)).toBe(true);
    expect(browserBeacons).toHaveLength(1);
  });

  test("sync requests go directly to the native transport without cache IPC", async () => {
    const { runtime, calls } = loadClientRuntime();
    await runtime.fetch("/api/workspaces/chat/sync", { method: "POST", body: JSON.stringify({ ui_projection: true }) });
    expect(calls.map((call) => call.command)).toEqual(["gateway_request"]);
    expect(JSON.parse(calls[0].payload.request.bodyText)).toEqual({ ui_projection: true });
    const native = readFileSync(join(import.meta.dir, "../client/src-tauri/src/lib.rs"), "utf8");
    for (const command of ["cache_load_metadata", "cache_load_chunk", "cache_list", "cache_save_batch", "cache_remove"]) {
      expect(native).not.toContain(command);
    }
  });

  test("assembles the one authoritative frontend core with a client adapter", () => {
    const repositoryRoot = join(import.meta.dir, "..");
    const build = readFileSync(join(repositoryRoot, "client/build-frontend.js"), "utf8");
    const config = readFileSync(join(repositoryRoot, "client/src-tauri/tauri.conf.json"), "utf8");
    const shared = readFileSync(join(repositoryRoot, "frontend/app.js"), "utf8");
    const entry = readFileSync(join(repositoryRoot, "frontend/index.html"), "utf8");
    // The shared core is copied verbatim from me-s; the build must take it from the
    // local `frontend/` copy and must never reach for the upstream server sources.
    expect(build).toContain('resolve(repositoryRoot, "frontend")');
    expect(build).not.toContain('"src/webui"');
    expect(build).not.toContain('"src/gateway_webui"');
    expect(existsSync(join(repositoryRoot, "src"))).toBe(false);
    // me-tric only modules must be registered so they ship with the desktop bundle.
    for (const asset of [
      "[\"client-runtime.js\", \"runtime.js\"]",
      "[\"device-manager.js\", \"device-manager.js\"]",
      "[\"device-manager.css\", \"device-manager.css\"]",
      "[\"agent-inspector.js\", \"agent-inspector.js\"]",
      "[\"agent-inspector.css\", \"agent-inspector.css\"]",
      "[\"window-shadow.html\", \"window-shadow.html\"]",
    ]) {
      expect(build).toContain(asset);
    }
    // Both feature modules must be linked into the assembled entry, not just copied.
    expect(build).toContain('<script src="/agent-inspector.js"></script>');
    expect(build).toContain('<script src="/device-manager.js"></script>');
    expect(build).toContain('<link rel="stylesheet" href="/device-manager.css">');
    expect(build).toContain('<link rel="stylesheet" href="/agent-inspector.css">');
    expect(config).toContain('"withGlobalTauri": true');
    expect(config).toContain('"frontendDist": "../frontend-dist"');
    // The browser transport must not ride along: desktop encryption lives in Rust.
    expect(entry).toContain('<script src="/transport.js"></script>');
    // The removal must not rely on a bare "\n" anchor: on a CRLF checkout that
    // silently no-ops and the wasm transport rides along unnoticed.
    const transportRemoval = build
      .split("\n")
      .find((line) => line.includes("transport\\.js"));
    expect(transportRemoval).toBeDefined();
    expect(transportRemoval).toContain("replace(/");
    expect(transportRemoval).toContain("\\r?\\n");
    expect(shared).toContain("const frontendRuntime = globalThis.MeFrontendRuntime");
    expect(shared).toContain("ui_projection: true");
    expect(shared).not.toContain("store.events");
    expect(shared).toContain("frontendRuntime.windowReady?.()");
    expect(shared).not.toContain("materializeClientAgentStore");
    expect(shared).not.toContain("releaseClientAgentStore");
  });

  test("locks the me-tric product version across manifest, package, and lock", () => {
    const root = join(import.meta.dir, "..");
    const productVersion = "0.1.0";
    const packageJson = JSON.parse(readFileSync(join(root, "client/package.json"), "utf8"));
    const tauriConfig = JSON.parse(readFileSync(join(root, "client/src-tauri/tauri.conf.json"), "utf8"));
    const clientCargo = readFileSync(join(root, "client/src-tauri/Cargo.toml"), "utf8");
    const clientLock = readFileSync(join(root, "client/src-tauri/Cargo.lock"), "utf8");
    const clientMain = readFileSync(join(root, "client/src-tauri/src/main.rs"), "utf8");
    expect(packageJson.version).toBe(productVersion);
    expect(tauriConfig.version).toBe(productVersion);
    expect(tauriConfig.productName).toBe("ME Tric");
    expect(tauriConfig.identifier).toBe("studio.me-tric.desktop");
    expect(clientCargo).toMatch(new RegExp(`^version = "${productVersion.replaceAll(".", "\\.")}"$`, "m"));
    expect(clientCargo).toContain('name = "me-tric"');
    expect(clientCargo).toContain('[lib]');
    expect(clientCargo).toContain('name = "me_tric_lib"');
    expect(clientCargo).toContain('me-transport = { path = "../../transport"');
    expect(clientLock).toContain(`name = "me-tric"\nversion = "${productVersion}"`);
    expect(clientLock).not.toContain('name = "me-client"');
    expect(clientMain).toContain('argument == "version" || argument == "--version"');
    expect(clientMain).toContain('println!("me-tric {}", env!("CARGO_PKG_VERSION"))');
    expect(clientMain).toContain("me_tric_lib::run()");
  });
});

test("native download cancellation waits for registration and forwards progress", async () => {
  let pending;
  const { runtime, calls } = loadClientRuntime({ download: (payload) => new Promise((resolve, reject) => { pending = { payload, resolve, reject }; }) });
  const controller = new AbortController();
  const progress = [];
  const running = runtime.downloadFile("/api/files/downloads/test/content", "test.bin", { signal: controller.signal, onProgress: (bytes) => progress.push(bytes) });
  controller.abort();
  expect(calls.filter((call) => call.command === "cancel_download")).toHaveLength(0);
  pending.payload.progress.onmessage({ requestId: "registered-download", bytes: 0 });
  expect(calls.at(-1)).toEqual({ command: "cancel_download", payload: { requestId: "registered-download" } });
  pending.reject(new Error("下载已取消"));
  await expect(running).rejects.toHaveProperty("name", "AbortError");
  expect(progress).toEqual([0]);
});

test("a pre-aborted native download never starts a native operation", async () => {
  const { runtime, calls } = loadClientRuntime();
  const controller = new AbortController();
  controller.abort();
  await expect(runtime.downloadFile("/api/files/downloads/test/content", "test.bin", { signal: controller.signal })).rejects.toHaveProperty("name", "AbortError");
  expect(calls).toHaveLength(0);
});

test("saving a device can opt out of stealing the active target", async () => {
  const { runtime, calls } = loadClientRuntime();
  await runtime.initialize();
  await runtime.configureTarget("https://lab.example", "lab", { activate: false });
  expect(calls.find((call) => call.command === "configure_target").payload).toEqual({
    endpoint: "https://lab.example",
    deviceId: "lab",
    activate: false,
  });
  // A non-activating add must not change which device the core talks to.
  expect(runtime.activeDeviceId).toBe("office");
});

test("logs one device in on its own transport without touching the others", async () => {
  const { runtime, calls } = loadClientRuntime();
  await runtime.initialize();
  await runtime.loginDevice("lab", "lab secret", 443);
  expect(calls.find((call) => call.command === "login_device").payload).toEqual({
    deviceId: "lab",
    password: "lab secret",
    browserPort: 443,
  });

  const nativeGateway = readFileSync(join(import.meta.dir, "../client/src-tauri/src/gateway.rs"), "utf8");
  // The per-device login must ride that device's own request path so its cookie
  // lands in the transport's own jar instead of a shared one.
  expect(nativeGateway).toContain("pub async fn login(");
  expect(nativeGateway).toContain('path: "/api/auth/login".into()');
  const nativeDevices = readFileSync(join(import.meta.dir, "../client/src-tauri/src/devices.rs"), "utf8");
  expect(nativeDevices).toContain("pub async fn configure(");
  expect(nativeDevices).toContain("activate: bool,");
});

test("the device rail is a left-hand column with an add button", () => {
  const rail = readFileSync(join(import.meta.dir, "../client/device-manager.js"), "utf8");
  // Tabs must render from the native roster, not from the core's login screen.
  expect(rail).toContain('const RAIL_ID = "me-tric-device-rail"');
  expect(rail).toContain('data-device-action="add"');
  expect(rail).toContain('data-device-action="activate"');
  expect(rail).toContain("document.body.append(buildRail())");
  // Every switch must go through the native target, never through a reload.
  expect(rail).not.toContain("location.reload");
  expect(rail).toContain('invoke("set_active_device"');
  // A device with a remembered password must be switchable without a dialog.
  expect(rail).toContain("loginQuietly(");

  const css = readFileSync(join(import.meta.dir, "../client/device-manager.css"), "utf8");
  expect(css).toContain("--me-tric-rail-width: 52px;");
  expect(css).toContain("position: fixed;");
  expect(css).toContain("left: var(--me-tric-rail-width);");
  expect(css).toContain(".me-tric-device-rail {");
  expect(css).toContain(".me-tric-device-backdrop {");
});

// ---- file-edit diffs ------------------------------------------------------
//
// `client/tool-diff.js` decorates the shared core's `MeToolPresenters`. The
// interesting behaviour is the *round trip*: a `File.Read` renders, and only
// then can a later `File.Edit` produce real removed text. These tests drive that
// sequence through the same public entry points `app.js` uses.

function loadToolDiff() {
  const read = (name) => readFileSync(join(import.meta.dir, `../frontend/${name}`), "utf8");
  const sandbox = {};
  new Function("globalThis", `${read("tool-presenters.js")}\n`)(sandbox);
  const diffSource = readFileSync(join(import.meta.dir, "../client/tool-diff.js"), "utf8");
  new Function("globalThis", diffSource)(sandbox);
  return {
    presenters: sandbox.MeToolPresenters,
    diff: sandbox.MeTricToolDiff,
    sandbox,
  };
}

/** The shape `app.js::toolPresentationOutput()` hands to the presenters. */
function toolOutput(state, value) {
  return {
    text: "",
    updates: [],
    result: { state, exitCode: null, value, rawDetail: JSON.stringify(value) },
  };
}

const READ_SOURCE = [
  "const alpha = 1;",
  "const beta = 2;",
  "",
  "export function total() {",
  "  return alpha + beta;",
  "}",
  "",
  "export const label = \"sum\";",
];

/** The successful `File.Read` payload, before it is wrapped as tool output. */
function readValue(lines, { hash = "aaaaaaaa", total } = {}) {
  const map = {};
  lines.forEach((text, index) => { map[String(index + 1).padStart(2, "0")] = text; });
  return {
    path: "src/sum.js",
    lines: map,
    editable_ranges: [{ start_line: 1, end_line: lines.length }],
    start_line: 1,
    end_line: lines.length,
    total_lines: total ?? lines.length,
    eof: true,
    truncated: false,
    hash,
    size: 120,
    encoding: "utf-8",
    encoding_confidence: 1,
    bom: false,
  };
}

function readOutput(lines, options) {
  return toolOutput("succeeded", readValue(lines, options));
}

/** The `File.Edit` output for deleting line 1 of the read source. */
function editValue(overrides = {}) {
  return {
    path: "src/sum.js",
    operation: "edited",
    previous_hash: "aaaaaaaa",
    previous_total_lines: READ_SOURCE.length,
    total_lines: READ_SOURCE.length - 1,
    previous_size: 120,
    size: 105,
    encoding: "utf-8",
    edit_results: [{ index: 0, state: "succeeded", operation: "delete", selected_lines: 1, new_line_count: 0, replacement_bytes: 0, start_line: 1, end_line: 1 }],
    tip: "",
    ...overrides,
  };
}

/** Just enough element/ownerDocument behaviour to exercise `syncInlineDiff`. */
function makeElement(tagName) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    innerHTML: "",
    children: [],
    listeners: [],
    parent: null,
    append(child) {
      child.parent = element;
      element.children.push(child);
      return child;
    },
    after(child) {
      const parent = element.parent;
      if (!parent) return;
      parent.children.splice(parent.children.indexOf(element) + 1, 0, child);
      child.parent = parent;
    },
    remove() {
      const parent = element.parent;
      if (!parent) return;
      parent.children.splice(parent.children.indexOf(element), 1);
      element.parent = null;
    },
    addEventListener(type, listener) { element.listeners.push({ type, listener }); },
    querySelector(selector) {
      const match = /^:scope > \.([\w-]+)$/.exec(selector);
      if (!match) return null;
      const wanted = match[1];
      return element.children.find((child) => child.className.split(/\s+/).includes(wanted)) || null;
    },
  };
  return element;
}

/** A collapsed tool card: header, then the details the core owns. */
function makeCard() {
  const card = makeElement("div");
  card.className = "tool-card succeeded";
  card.ownerDocument = { createElement: (tagName) => makeElement(tagName) };
  card.append(makeElement("div")).className = "tool-header";
  card.append(makeElement("div")).className = "tool-details";
  return card;
}

/** The tool record `app.js` holds, whose result detail is JSON text. */
function editTool(id = "call-1") {
  return {
    id,
    name: "File.Edit",
    args: { path: "src/sum.js", edits: [{ operation: "delete", start_line: 1, end_line: 1 }] },
    result: { state: "succeeded", exitCode: null, detail: JSON.stringify(editValue()) },
  };
}

const CARD_CHILDREN = ["tool-header", "tool-diff-inline", "tool-details"];

test("a file edit shows real removed text once the read is known", () => {
  const { presenters, diff } = loadToolDiff();
  // The core renders every tool card through imageAttachments, which is where a
  // File.Read output becomes available to a later edit.
  presenters.imageAttachments("File.Read", readOutput(READ_SOURCE));

  const args = {
    path: "src/sum.js",
    edits: [
      { operation: "replace", start_line: 5, end_line: 5, new_lines: ["  return alpha - beta;"] },
      { operation: "delete", start_line: 7, end_line: 7 },
    ],
  };
  const output = toolOutput("succeeded", {
    path: "src/sum.js",
    operation: "edited",
    previous_hash: "aaaaaaaa",
    previous_total_lines: READ_SOURCE.length,
    total_lines: READ_SOURCE.length - 2,
    previous_size: 120,
    size: 121,
    encoding: "utf-8",
    edit_results: [
      { index: 0, state: "succeeded", operation: "replace", selected_lines: 1, new_line_count: 1, replacement_bytes: 22, start_line: 5, end_line: 5 },
      { index: 1, state: "succeeded", operation: "delete", selected_lines: 1, new_line_count: 0, replacement_bytes: 0, start_line: 7, end_line: 7 },
    ],
    tip: "",
  });

  const details = presenters.describe("File.Edit", args, output);
  expect(details.diff).toBeDefined();
  expect(details.diff.added).toBe(1);
  expect(details.diff.removed).toBe(2);
  expect(details.diff.missing).toBe(0);

  const html = diff.diffBlockFor("File.Edit", args, output);
  expect(html).toContain("tool-diff-block");
  // The removed lines are the real ones, recovered from the File.Read result.
  expect(html).toContain("  return alpha + beta;");
  expect(html).toContain("  return alpha - beta;");
  expect(html).toContain('<span class="tool-diff-mark">-</span>');
  expect(html).toContain('<span class="tool-diff-mark">+</span>');
  // Unchanged neighbours appear as context, not as changes.
  expect(html).toContain("tool-diff-context");
  // The details block is not where the diff lives: the card puts this same
  // block under its header so the diff never needs a click.
  expect(presenters.renderDetails(details)).not.toContain("tool-diff-block");
});

test("a file edit without any known original still shows correct line numbers", () => {
  const { presenters, diff } = loadToolDiff();
  const args = {
    path: "src/unknown.js",
    edits: [{ operation: "replace", start_line: 12, end_line: 12, new_lines: ["replacement"] }],
  };
  const output = toolOutput("succeeded", {
    path: "src/unknown.js",
    previous_hash: "ffffffff",
    previous_total_lines: 40,
    total_lines: 40,
    previous_size: 900,
    size: 903,
    encoding: "utf-8",
    edit_results: [{ index: 0, state: "succeeded", operation: "replace", selected_lines: 1, new_line_count: 1, replacement_bytes: 11, start_line: 12, end_line: 12 }],
    tip: "",
  });

  // No invented content: the removed line is a placeholder with its real number.
  const details = presenters.describe("File.Edit", args, output);
  expect(details.diff.missing).toBe(1);
  expect(details.diff.removed).toBe(1);
  expect(details.diff.added).toBe(1);
  const html = diff.diffBlockFor("File.Edit", args, output);
  expect(html).toContain("原内容未记录");
  expect(html).toContain("本会话中没有该文件的原始内容");
  expect(html).toContain('<span class="tool-diff-line-no">12</span>');
});

test("a stale read hash is never reused as the edit's old side", () => {
  const { presenters, diff } = loadToolDiff();
  presenters.imageAttachments("File.Read", readOutput(READ_SOURCE, { hash: "aaaaaaaa" }));
  const args = { path: "src/sum.js", edits: [{ operation: "delete", start_line: 1, end_line: 1 }] };
  const output = toolOutput("succeeded", editValue({
    previous_hash: "bbbbbbbb", // a different revision than the one we read
  }));
  // Same line count, but the hash proves it is a different revision: refuse.
  const details = presenters.describe("File.Edit", args, output);
  expect(details.diff.missing).toBe(1);
  expect(diff.diffBlockFor("File.Edit", args, output)).toContain("原内容未记录");
});

test("a failed or still-running edit gets no diff at all", () => {
  const { presenters, diff } = loadToolDiff();
  presenters.imageAttachments("File.Read", readOutput(READ_SOURCE));
  const args = { path: "src/sum.js", edits: [{ operation: "delete", start_line: 1, end_line: 1 }] };

  const failedOutput = toolOutput("failed", { message: "conflict", code: "conflict" });
  expect(presenters.describe("File.Edit", args, failedOutput).diff).toBeUndefined();
  expect(diff.diffBlockFor("File.Edit", args, failedOutput)).toBe("");

  // No result yet: the card keeps exactly what the shared core produced.
  const runningArgs = {
    path: "src/sum.js",
    edits: [{ operation: "replace", start_line: 2, end_line: 2, new_lines: ["const beta = 3;"] }],
  };
  const running = presenters.describe("File.Edit", runningArgs, undefined);
  expect(running.diff).toBeUndefined();
  expect(diff.diffBlockFor("File.Edit", runningArgs, undefined)).toBe("");
  const html = presenters.renderDetails(running);
  expect(html).not.toContain("tool-diff-block");
  expect(html).toContain("修改 1 的新内容");
});

test("whole-file writes diff against the content that produced them", () => {
  const { presenters, diff } = loadToolDiff();
  const createArgs = { path: "notes/todo.md", content: "# Todo\n- one\n- two\n", encoding: "utf-8" };
  const createOutput = toolOutput("succeeded", {
    path: "notes/todo.md", operation: "created", hash: "cccccccc", size: 22,
    encoding: "utf-8", encoding_confidence: 1, bom: false,
  });
  const created = presenters.describe("File.Create", createArgs, createOutput);
  expect(created.diff.kind).toBe("create");
  // "# Todo\n- one\n- two\n" is three terminated lines, not four.
  expect(created.diff.added).toBe(3);

  // A later replace of that same file can show the created lines as removed,
  // because the create cached its content by path.
  const replaceArgs = { path: "notes/todo.md", content: "# Todo\n- one\n", encoding: "utf-8" };
  const replaceOutput = toolOutput("succeeded", {
    path: "notes/todo.md", operation: "replaced", previous_hash: "cccccccc",
    hash: "dddddddd", size: 13, encoding: "utf-8", encoding_confidence: 1, bom: false,
  });
  const replaced = presenters.describe("File.Replace", replaceArgs, replaceOutput);
  expect(replaced.diff.kind).toBe("replace");
  expect(replaced.diff.removed).toBe(3);
  expect(replaced.diff.added).toBe(2);
  expect(diff.diffBlockFor("File.Replace", replaceArgs, replaceOutput)).toContain("- two");
});

test("byte edits are reported in bytes and never pretend to be line diffs", () => {
  const { presenters, diff } = loadToolDiff();
  const args = {
    path: "assets/logo.bin",
    edits: [{ target_offset: 4, target_length: 2, data: "de ad be ef" }],
  };
  const output = toolOutput("succeeded", {
    path: "assets/logo.bin", previous_hash: "eeeeeeee", hash: "ffffffff",
    previous_size: 20, size: 22, encoding: "binary", encoding_confidence: 1, bom: false,
    edit_results: [{ index: 0, kind: "replace", target_offset: 4, selected_bytes: 2, replacement_bytes: 4 }],
  });
  const details = presenters.describe("File.EditBytes", args, output);
  expect(details.diff.kind).toBe("bytes");
  expect(details.diff.added).toBe(4);
  expect(details.diff.removed).toBe(2);
  const html = diff.diffBlockFor("File.EditBytes", args, output);
  expect(html).toContain("偏移 4");
  expect(html).toContain("de ad be ef");
  expect(html).toContain("字节级修改");
});

test("the details block is the core's own markup, for file edits and plain tools alike", () => {
  const { presenters, diff } = loadToolDiff();
  const core = {};
  new Function("globalThis", `${readFileSync(join(import.meta.dir, "../frontend/tool-presenters.js"), "utf8")}\n`)(core);
  presenters.imageAttachments("File.Read", readOutput(READ_SOURCE));
  const editDetails = presenters.describe("File.Edit",
    { path: "src/sum.js", edits: [{ operation: "delete", start_line: 1, end_line: 1 }] },
    toolOutput("succeeded", editValue()));
  expect(editDetails.diff).toBeDefined();
  // The diff is rendered outside `.tool-details`, so this markup stays identical to
  // the upstream core's: the same hunk is never printed in two places.
  expect(presenters.renderDetails(editDetails)).toBe(core.MeToolPresenters.renderDetails(editDetails));
  // Keep `diff` used so the destructure above documents intent.
  expect(typeof diff.diffBlockFor).toBe("function");
});

test("re-observing the same write never evicts the verified read", () => {
  const { presenters, diff } = loadToolDiff();
  presenters.imageAttachments("File.Read", readOutput(READ_SOURCE));
  const args = { path: "src/sum.js", content: "const alpha = 1;\nconst beta = 2;\n", encoding: "utf-8" };
  const output = toolOutput("succeeded", { path: "src/sum.js", operation: "replaced", hash: "dddddddd", size: 30 });

  // `syncInlineDiff` observes on every render, and a running card is rendered
  // repeatedly. Without dedupe each pass would add another candidate for the same
  // content and eventually push the verified File.Read out of the small cache.
  for (let pass = 0; pass < 40; pass += 1) diff.observe("File.Replace", args, output);

  // The read is still the edit's old side, by exact hash.
  const editOutput = toolOutput("succeeded", editValue());
  const diffModel = diff.model("File.Edit", { path: "src/sum.js", edits: [{ operation: "delete", start_line: 1, end_line: 1 }] }, editOutput);
  expect(diffModel.missing).toBe(0);
  expect(diffModel.hunks[0].rows.some((row) => row.kind === "del" && row.text === "const alpha = 1;")).toBe(true);
});

test("a read named relatively still matches an edit named absolutely", () => {
  const { presenters, diff } = loadToolDiff();
  // The toolbox answers File.Read with a path relative to its own root, while the
  // agent may address the same file with an absolute path. Both name one file.
  presenters.imageAttachments("File.Read", readOutput(READ_SOURCE));

  const absolute = "D:/WS/trime-c/me-tric/src/sum.js";
  const absoluteArgs = { path: absolute, edits: [{ operation: "delete", start_line: 1, end_line: 1 }] };
  const absoluteDiff = presenters.describe("File.Edit", absoluteArgs, toolOutput("succeeded", editValue()));
  expect(absoluteDiff.diff.missing).toBe(0);
  expect(diff.diffBlockFor("File.Edit", absoluteArgs, toolOutput("succeeded", editValue())))
    .toContain("const alpha = 1;");

  // The path only narrows the search; the hash is the real gate. A different
  // revision behind the same suffix must still be refused.
  const staleArgs = { path: "D:/WS/trime-c/me-tric/src/sum.js", edits: [{ operation: "delete", start_line: 1, end_line: 1 }] };
  expect(diff.diffBlockFor("File.Edit", staleArgs, toolOutput("succeeded", editValue({ previous_hash: "bbbbbbbb" }))))
    .toContain("原内容未记录");
});

test("the diff is placed under the card header, so no click is needed", () => {
  const { presenters, diff } = loadToolDiff();
  presenters.imageAttachments("File.Read", readOutput(READ_SOURCE));
  const card = makeCard();
  const tool = editTool();

  diff.syncInlineDiff(card, tool);

  // The diff sits between the header and the details, so it is already on screen
  // while the card is still collapsed.
  expect(card.children.map((child) => child.className)).toEqual(CARD_CHILDREN);
  expect(card.children[1].innerHTML).toContain("tool-diff-block");
  expect(card.children[1].innerHTML).toContain("const alpha = 1;");

  // The transcript re-renders running cards; that must not stack up blocks.
  diff.syncInlineDiff(card, tool);
  expect(card.children).toHaveLength(CARD_CHILDREN.length);

  // Clicking the diff must not toggle the card, exactly like `.tool-details`.
  const event = { stopped: false, stopPropagation() { this.stopped = true; } };
  card.children[1].listeners[0].listener(event);
  expect(event.stopped).toBe(true);

  // A card with nothing to diff is left exactly as the core built it.
  const plain = makeCard();
  diff.syncInlineDiff(plain, { id: "call-9", name: "Terminal.Status", args: { session_id: "a" }, result: { state: "succeeded", detail: "{}" } });
  expect(plain.children.map((child) => child.className)).toEqual(["tool-header", "tool-details"]);
});

test("the card builders are wrapped so a landing result gets its diff", () => {
  const { presenters, diff, sandbox } = loadToolDiff();
  presenters.imageAttachments("File.Read", readOutput(READ_SOURCE));

  // Stand in for app.js's own top-level builders, which do not exist yet when
  // this module loads.
  sandbox.createMessageNode = () => makeCard();
  diff.installCardWrappers();

  const node = sandbox.createMessageNode({ kind: "tool", tool: editTool("call-2") });
  expect(node.children.map((child) => child.className)).toEqual(CARD_CHILDREN);

  // Non-tool messages pass through untouched.
  const plain = sandbox.createMessageNode({ kind: "assistant", content: "hi" });
  expect(plain.children.map((child) => child.className)).not.toContain("tool-diff-inline");

  // Installing again must not double-wrap the builders.
  diff.installCardWrappers();
  const again = sandbox.createMessageNode({ kind: "tool", tool: editTool("call-3") });
  expect(again.children.filter((child) => child.className === "tool-diff-inline")).toHaveLength(1);
});

test("the diff module is assembled after the registry it decorates", () => {
  const build = readFileSync(join(import.meta.dir, "../client/build-frontend.js"), "utf8");
  expect(build).toContain('["tool-diff.js", "tool-diff.js"]');
  expect(build).toContain('["tool-diff.css", "tool-diff.css"]');
  expect(build).toContain('<script src="/tool-diff.js"></script>');
  expect(build).toContain('<link rel="stylesheet" href="/tool-diff.css">');
  // Order matters: the module needs the registry to already exist, and app.js
  // resolves MeToolPresenters at call time, so it must sit between them.
  expect(build).toContain('html.indexOf("/tool-diff.js") > html.indexOf("/tool-presenters.js")');
});

// `client/paste-image.js` cannot attach an image to a prompt (the server's prompt
// payload is a string), so it uploads the blob through the file API and appends a
// `[图片] <path>` line. These tests cover the pure path/name rules and the request
// rewrite, which is the whole contract the shared core depends on.

function loadPasteImage({ ok = true, body = { ok: true } } = {}) {
  const calls = [];
  const base = {
    devicePreferences: { getItem: () => null },
    apiPath: (path, workspaceId) => `/api/workspaces/${workspaceId || "chat"}${String(path).slice(4)}`,
    async fetch(input, options) {
      calls.push({ input, options });
      return {
        ok,
        status: ok ? 200 : 500,
        clone() { return { async json() { return body; } }; },
      };
    },
  };
  const sandbox = { MeFrontendRuntime: base };
  new Function("globalThis", readFileSync(join(import.meta.dir, "../client/paste-image.js"), "utf8"))(sandbox);
  return { api: sandbox.MeTricPasteImage, runtime: sandbox.MeFrontendRuntime, base, calls };
}

/** A ready chip, i.e. one whose upload already returned a workspace-relative path. */
function readyChip(path) {
  return { state: "ready", path, url: "", node: null };
}

function submitBody(content) {
  return { method: "POST", body: JSON.stringify({ command: "submit_user_prompt", agent_id: "main", content }) };
}

test("a pasted image is named as one safe path component", () => {
  const { api } = loadPasteImage();
  expect(api.imageExtension("image/png")).toBe("png");
  expect(api.imageExtension("IMAGE/JPEG")).toBe("jpg");
  expect(api.imageExtension("image/svg+xml")).toBe("svg");
  // An unknown or missing type still has to produce a usable extension.
  expect(api.imageExtension("application/octet-stream")).toBe("png");
  expect(api.imageExtension("")).toBe("png");

  const name = api.attachmentName(0, "png", { now: Date.UTC(2026, 5, 12, 14, 30, 15), salt: 0.5 });
  expect(name).toMatch(/^paste-\d{8}-\d{6}-[0-9a-f]{6}-1\.png$/);
  // The server's `validate_component` rejects separators, drive colons and the
  // internal `.me-upload-*.tmp` pattern.
  expect(name).not.toContain("/");
  expect(name).not.toContain("\\");
  expect(name).not.toContain(":");
  expect(name.startsWith(".me-upload-")).toBe(false);

  // Distinct pastes at the same second must not collide, or the second upload
  // would target the first one's file.
  const first = api.attachmentName(1, "png", { now: 0, salt: 0.1 });
  const second = api.attachmentName(2, "png", { now: 0, salt: 0.2 });
  expect(first).not.toBe(second);
});

test("an upload is addressed relative to the workspace, as Image.View expects", () => {
  const { api } = loadPasteImage();
  expect(api.relativeTo("D:/WS/proj", "D:/WS/proj/.me/attachments/a.png")).toBe(".me/attachments/a.png");
  // Windows paths arrive with either separator, and the drive letter may differ in case.
  expect(api.relativeTo("D:\\WS\\proj", "D:/WS/proj/.me/attachments/a.png")).toBe(".me/attachments/a.png");
  expect(api.relativeTo("d:/ws/proj/", "D:/WS/proj/.me/attachments/a.png")).toBe(".me/attachments/a.png");
  // A path outside the workspace stays absolute: it is still readable, and silently
  // shortening it would point Image.View at the wrong file.
  expect(api.relativeTo("D:/WS/proj", "D:/other/a.png")).toBe("D:/other/a.png");
  expect(api.relativeTo("D:/WS/proj", "D:/WS/proj")).toBe("");
});

test("the prompt gains one path line per image, and only once", () => {
  const { api } = loadPasteImage();
  expect(api.contentWithImages("", ["a.png"])).toBe("[图片] a.png");
  expect(api.contentWithImages("看看这个\n\n", ["a.png", "b.png"]))
    .toBe("看看这个\n[图片] a.png\n[图片] b.png");
  // No images means no trailing whitespace surgery beyond the trim.
  expect(api.contentWithImages("看看这个  ", [])).toBe("看看这个");
  expect(api.contentWithImages("", [])).toBe("");

  expect(api.hasImageLine("[图片] a.png", "a.png")).toBe(true);
  expect(api.hasImageLine("[图片] b.png", "a.png")).toBe(false);

  // One submission can be reached twice: the box is prefilled when it was empty and
  // the request body is rewritten when it was not. The path must not appear twice.
  const once = api.submissionContent("", ["a.png"]);
  expect(api.submissionContent(once, ["a.png"])).toBe(once);
  expect(api.submissionContent("看看", ["a.png", "b.png"])).toBe("看看\n[图片] a.png\n[图片] b.png");
});

test("only clipboard file items with an image type are taken over", () => {
  const { api } = loadPasteImage();
  expect(api.isImageItem({ kind: "file", type: "image/png" })).toBe(true);
  expect(api.isImageItem({ kind: "file", type: "IMAGE/PNG" })).toBe(true);
  expect(api.isImageItem({ kind: "string", type: "image/png" })).toBe(false);
  expect(api.isImageItem({ kind: "file", type: "text/plain" })).toBe(false);
  expect(api.isImageItem(null)).toBe(false);
});

test("the module patches the runtime without losing any of its other members", () => {
  const { api, runtime, base } = loadPasteImage();
  expect(typeof api.imageExtension).toBe("function");
  // `app.js` captures MeFrontendRuntime once at load time, so the replacement has
  // to be in place before it runs — and must keep every member it does not touch.
  expect(runtime).not.toBe(base);
  expect(runtime.apiPath("/api/files/list", "chat")).toBe("/api/workspaces/chat/files/list");
  expect(typeof runtime.devicePreferences.getItem).toBe("function");
  expect(runtime.fetch).not.toBe(base.fetch);

  // Re-installing must not stack a second wrapper.
  const once = runtime.fetch;
  api.install();
  expect(loadPasteImage().runtime.fetch).toBeTypeOf("function");
  expect(runtime.fetch).toBe(once);
});

test("an image-only message still submits, because the box is prefilled", () => {
  const { api, runtime, calls } = loadPasteImage();
  api.attachments.push(readyChip(".me/attachments/a.png"));
  return runtime.fetch("/api/workspaces/chat/command", submitBody(""))
    .then((response) => {
      expect(response.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0].options.body).content).toBe("[图片] .me/attachments/a.png");
      // The upload is consumed only once the submission is accepted.
      expect(api.attachments).toHaveLength(0);
    });
});

test("the paths ride along with whatever the user typed", () => {
  const { api, runtime, calls } = loadPasteImage();
  api.attachments.push(readyChip(".me/attachments/a.png"));
  return runtime.fetch("/api/workspaces/chat/command", submitBody("这是什么")).then(() => {
    expect(JSON.parse(calls[0].options.body).content).toBe("这是什么\n[图片] .me/attachments/a.png");
    expect(api.attachments).toHaveLength(0);
  });
});

test("a still-uploading or failed chip never reaches the model", () => {
  const { api, runtime, calls } = loadPasteImage();
  api.attachments.push({ state: "uploading", path: "", url: "", node: null });
  api.attachments.push({ state: "failed", path: "", url: "", node: null });
  return runtime.fetch("/api/workspaces/chat/command", submitBody("看看")).then(() => {
    // Nothing was rewritten, so the request is the core's own body untouched.
    expect(calls[0].options).toBeDefined();
    expect(JSON.parse(calls[0].options.body).content).toBe("看看");
    expect(api.attachments).toHaveLength(2);
  });
});

test("a rejected submission keeps its chips so it can be retried", () => {
  const { api, runtime } = loadPasteImage({ ok: false, body: { ok: false, error: "boom" } });
  api.attachments.push(readyChip(".me/attachments/a.png"));
  return runtime.fetch("/api/workspaces/chat/command", submitBody("看看")).then((response) => {
    expect(response.ok).toBe(false);
    expect(api.attachments).toHaveLength(1);
  });
});

test("every other request passes straight through the patched runtime", () => {
  const { api, runtime, calls } = loadPasteImage();
  api.attachments.push(readyChip(".me/attachments/a.png"));
  return runtime.fetch("/api/workspaces/chat/snapshot", { cache: "no-store" }).then(() => {
    expect(calls[0].input).toBe("/api/workspaces/chat/snapshot");
    expect(calls[0].options.body).toBeUndefined();
    // Only a submit_user_prompt consumes the chips.
    expect(api.attachments).toHaveLength(1);
  });
});

test("the paste module is assembled before the core that captures the runtime", () => {
  const build = readFileSync(join(import.meta.dir, "../client/build-frontend.js"), "utf8");
  expect(build).toContain('["paste-image.js", "paste-image.js"]');
  expect(build).toContain('["paste-image.css", "paste-image.css"]');
  expect(build).toContain('<script src="/paste-image.js"></script>');
  expect(build).toContain('<link rel="stylesheet" href="/paste-image.css">');
  // app.js reads MeFrontendRuntime at load time, so the patch must already be applied.
  expect(build).toContain('html.indexOf("/paste-image.js") < html.indexOf("/app.js")');
});

// `client/debug-panel.js` observes /api/sync through the same runtime replacement
// the paste module uses. The interesting parts are the pure derivations: which
// projection state is "selected", what counts as the streaming text, how the live
// rate is computed, and that the response body is never consumed from under app.js.

function loadDebugPanel({ selectedAgent = null } = {}) {
  const calls = [];
  const payloads = [];
  const base = {
    apiPath: (path, workspaceId) => `/api/workspaces/${workspaceId || "chat"}${String(path).slice(4)}`,
    async fetch(input, options) {
      calls.push({ input, options });
      const payload = payloads.shift() || { ok: true };
      const text = JSON.stringify(payload);
      return {
        ok: true,
        status: 200,
        async text() { return text; },
        clone() { return { async text() { return text; }, async json() { return payload; } }; },
      };
    },
  };
  // The sidebar row is how the module learns which conversation is on screen;
  // `app.js` mirrors `state.selectedAgent` onto it. `select` mutates it so a test
  // can simulate the user switching conversations.
  const selection = { agentId: selectedAgent };
  const sandbox = {
    MeFrontendRuntime: base,
    document: {
      querySelector(selector) {
        if (selector !== ".agent-row.active" || !selection.agentId) return null;
        return { dataset: { agentId: selection.agentId } };
      },
    },
  };
  new Function("globalThis", readFileSync(join(import.meta.dir, "../client/debug-panel.js"), "utf8"))(sandbox);
  return {
    panel: sandbox.MeTricDebugPanel,
    runtime: sandbox.MeFrontendRuntime,
    base, calls, payloads,
    select: (agentId) => { selection.agentId = agentId; },
  };
}

/** One sync payload shaped like `webui.rs::sync_state_payload`. */
function syncPayload({ content = "", tools = [], context = null, usage = null, state = "Streaming", selected = "main" } = {}) {
  const projections = [];
  if (content) projections.push({ kind: "assistant", key: "assistant:1", content, timestamp: 1000 });
  for (const tool of tools) projections.push({ kind: "tool", key: `tool:${tool.id}`, tool });
  return {
    ok: true,
    selected_agent: selected,
    api_activity: { active: state === "Streaming", received_sse_events: 42 },
    snapshot: { agents: [{ id: "main", edb_size_bytes: 2048 }] },
    projection_states: [{
      agent_id: selected,
      revision: "rev-1",
      count: projections.length,
      source_event_count: 9,
      last_event_id: 77,
      changed_from: 0,
      model: "test-model",
      effort: "high",
      api_state: state,
      api_usage: usage,
      turn_state: { state: "active" },
      context: context || { total: 1000, values: { system: 400, compact: 0, memory: 0, user: 300, model: 250, tool: 50 } },
      range: { start: 0, end: projections.length, count: projections.length, projections },
    }],
  };
}

test("the debug panel formats sizes, tokens and durations for humans", () => {
  const { panel } = loadDebugPanel();
  expect(panel.formatBytes(512)).toBe("512 B");
  expect(panel.formatBytes(2048)).toBe("2.0 KB");
  expect(panel.formatBytes(3 * 1024 * 1024)).toBe("3.00 MB");
  expect(panel.formatTokens(null)).toBe("—");
  expect(panel.formatTokens(999)).toBe("999");
  expect(panel.formatTokens(1500)).toBe("1.5k");
  expect(panel.formatTokens(2_500_000)).toBe("2.50M");
  expect(panel.formatDuration(240)).toBe("240 ms");
  expect(panel.formatDuration(2400)).toBe("2.4 s");
  expect(panel.formatDuration(90_000)).toBe("1m 30s");
});

test("the panel reads the selected agent's own projection state", () => {
  const { panel } = loadDebugPanel();
  // `selected_agent` is what the server uses to decide who gets an inline range,
  // so it — not array order — decides which state is authoritative.
  const payload = {
    selected_agent: "worker",
    projection_states: [{ agent_id: "main", count: 1 }, { agent_id: "worker", count: 2 }],
  };
  expect(panel.selectedState(payload).agent_id).toBe("worker");
  // A payload without a match still yields something renderable rather than throwing.
  expect(panel.selectedState({ selected_agent: "gone", projection_states: [{ agent_id: "main" }] }).agent_id).toBe("main");
  expect(panel.selectedState({})).toBe(null);
  expect(panel.edbSize({ selected_agent: "main", snapshot: { agents: [{ id: "main", edb_size_bytes: 2048 }] } })).toBe(2048);
  expect(panel.edbSize({ selected_agent: "main", snapshot: { agents: [] } })).toBe(null);
});

test("the streamed text is the newest assistant part, not the whole transcript", () => {
  const { panel } = loadDebugPanel();
  const state = {
    range: {
      projections: [
        { kind: "user", key: "user:1", content: "看看这个" },
        { kind: "assistant", key: "assistant:1", content: "旧的回答" },
        { kind: "tool", key: "tool:1", tool: { name: "File.Read" } },
        { kind: "assistant", key: "assistant:2", content: "正在流式输出" },
      ],
    },
  };
  expect(panel.latestAssistant(state).key).toBe("assistant:2");
  expect(panel.latestAssistant(state).content).toBe("正在流式输出");
  expect(panel.latestAssistant({ range: { projections: [] } })).toBe(null);
  expect(panel.latestAssistant({})).toBe(null);
});

test("tool rows report a duration only once the tool finished", () => {
  const { panel } = loadDebugPanel();
  const state = {
    range: {
      projections: [
        { kind: "tool", tool: { id: "a", name: "File.Read", started: 1000, result: { state: "succeeded", finished: 1250 } } },
        { kind: "tool", tool: { id: "b", name: "File.Edit", started: 2000, queued: true } },
        { kind: "worker-activity", tool: { id: "c", name: "Worker", started: 3000 } },
      ],
    },
  };
  const rows = panel.toolRows(state);
  expect(rows.map((entry) => entry.name)).toEqual(["File.Read", "File.Edit", "Worker"]);
  expect(rows[0].durationMs).toBe(250);
  expect(rows[0].state).toBe("succeeded");
  // An unfinished tool has no duration, so the UI shows "进行中" instead of a lie.
  expect(rows[1].durationMs).toBe(null);
  expect(rows[1].state).toBe("queued");
  expect(rows[2].state).toBe("running");
});

test("the context list shares are computed from the reported total", () => {
  const { panel } = loadDebugPanel();
  const { total, rows } = panel.contextRows({
    context: { total: 1000, values: { system: 400, compact: 0, memory: 0, user: 300, model: 250, tool: 50 } },
  });
  expect(total).toBe(1000);
  expect(rows.map((entry) => entry.key)).toEqual(["system", "compact", "memory", "user", "model", "tool"]);
  expect(rows[0].share).toBeCloseTo(40, 5);
  expect(rows[5].share).toBeCloseTo(5, 5);
  // No total means no percentages at all, rather than a division by zero.
  const empty = panel.contextRows({});
  expect(empty.total).toBe(null);
  expect(empty.rows.every((entry) => entry.share === null)).toBe(true);
});

test("the live rate measures character growth within one assistant turn", () => {
  const { panel } = loadDebugPanel();
  // First sample: nothing to compare against yet.
  const first = panel.nextRate({ key: "a", length: 100 }, null, 1000);
  expect(first.rate).toBe(null);
  // 200 characters over one second.
  const second = panel.nextRate({ key: "a", length: 300 }, first, 2000);
  expect(second.rate).toBe(200);
  expect(second.length).toBe(300);

  // A new assistant turn restarts from zero instead of counting the old length as
  // a burst of output.
  const third = panel.nextRate({ key: "b", length: 50 }, second, 3000);
  expect(third.rate).toBe(null);
  expect(third.length).toBe(50);
  const fourth = panel.nextRate({ key: "b", length: 150 }, third, 4000);
  expect(fourth.rate).toBe(100);

  // Text that shrinks (a rewrite) never produces a negative rate.
  expect(panel.nextRate({ key: "b", length: 10 }, fourth, 5000).rate).toBe(0);
  // No assistant part at all means no rate.
  expect(panel.nextRate(null, fourth, 6000).rate).toBe(null);
});

test("the panel observes sync responses without consuming them", () => {
  const { panel, runtime, calls, payloads } = loadDebugPanel();
  payloads.push(syncPayload({ content: "你好世界" }));
  return runtime.fetch("/api/workspaces/chat/sync", { method: "POST" }).then((response) => {
    // The core must still be able to read the body it was handed.
    expect(response.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(panel.state.snapshot.api_activity.received_sse_events).toBe(42);
    expect(panel.state.rate.length).toBe(4);
    expect(panel.state.rate.text).toBe("你好世界");
    expect(panel.state.lastBytes).toBeGreaterThan(0);
    expect(panel.state.syncCount).toBe(1);
  });
});

test("only sync polls are inspected, and a broken payload never breaks the core", () => {
  const { panel, runtime, calls } = loadDebugPanel();
  return runtime.fetch("/api/workspaces/chat/snapshot", { method: "POST" })
    .then(() => {
      expect(calls).toHaveLength(1);
      // Nothing was observed, so the counters stayed at their initial values.
      expect(panel.state.syncCount).toBe(0);
      expect(panel.state.snapshot).toBe(null);
      expect(panel.isSyncRequest("/api/workspaces/chat/sync")).toBe(true);
      expect(panel.isSyncRequest("/api/workspaces/chat/sync?x=1")).toBe(true);
      expect(panel.isSyncRequest("/api/workspaces/chat/snapshot")).toBe(false);
    });
});

test("a paused panel freezes its samples", () => {
  const { panel, runtime, payloads } = loadDebugPanel();
  payloads.push(syncPayload({ content: "第一段" }));
  return runtime.fetch("/api/workspaces/chat/sync", { method: "POST" }).then(() => {
    const before = panel.state.rate.text;
    panel.state.paused = true;
    payloads.push(syncPayload({ content: "第二段更长的内容" }));
    return runtime.fetch("/api/workspaces/chat/sync", { method: "POST" }).then(() => {
      // Pausing stops sampling, so the last live text is what the box still shows.
      expect(panel.state.rate.text).toBe(before);
      expect(panel.state.syncCount).toBe(1);
      panel.state.paused = false;
    });
  });
});

test("the panel chains onto the runtime without losing any member", () => {
  const { panel, runtime, base } = loadDebugPanel();
  expect(runtime).not.toBe(base);
  expect(runtime.apiPath("/api/files/list", "chat")).toBe("/api/workspaces/chat/files/list");
  expect(runtime.fetch).not.toBe(base.fetch);
  // Re-installing must not stack a second wrapper.
  const once = runtime.fetch;
  panel.installRuntime();
  expect(runtime.fetch).toBe(once);
});

test("the debug panel is assembled before the core that captures the runtime", () => {
  const build = readFileSync(join(import.meta.dir, "../client/build-frontend.js"), "utf8");
  expect(build).toContain('["debug-panel.js", "debug-panel.js"]');
  expect(build).toContain('["debug-panel.css", "debug-panel.css"]');
  expect(build).toContain('<script src="/debug-panel.js"></script>');
  expect(build).toContain('<link rel="stylesheet" href="/debug-panel.css">');
  expect(build).toContain('html.indexOf("/debug-panel.js") < html.indexOf("/app.js")');
  // The panel is registered after the paste module so both runtime layers chain
  // deterministically and neither one silently replaces the other.
  expect(build.indexOf('["paste-image.js", "paste-image.js"]'))
    .toBeLessThan(build.indexOf('["debug-panel.js", "debug-panel.js"]'));
});

// The panel must not appear to be doing something when nothing is happening: a
// background poll describes another agent, and an idle poll only advances cursors.
// These tests pin both behaviours, plus the launcher's new home in the sidebar row.

test("a response about another agent never becomes the panel's state", () => {
  // The sidebar says "main" is on screen, so a poll naming "worker" is background.
  const { panel, runtime, payloads } = loadDebugPanel({ selectedAgent: "main" });
  payloads.push(syncPayload({ content: "别人的回答", selected: "worker" }));
  return runtime.fetch("/api/workspaces/chat/sync", { method: "POST" }).then(() => {
    expect(panel.state.snapshot).toBe(null);
    expect(panel.state.agentId).toBe(null);
    expect(panel.state.syncCount).toBe(0);
    expect(panel.state.rate.text).toBeUndefined();
  });
});

test("the panel follows the conversation the sidebar marks as active", () => {
  const { panel, runtime, payloads } = loadDebugPanel({ selectedAgent: "main" });
  expect(panel.selectedAgentId()).toBe("main");
  payloads.push(syncPayload({ content: "当前会话", selected: "main" }));
  return runtime.fetch("/api/workspaces/chat/sync", { method: "POST" }).then(() => {
    expect(panel.state.agentId).toBe("main");
    expect(panel.state.rate.text).toBe("当前会话");
  });
});

test("a response without an inline range is a background poll, not the selection", () => {
  const { panel } = loadDebugPanel();
  // The server only attaches `range` to the selected agent's state, so its absence
  // is proof this was a background sync even when the id happens to match.
  const withoutRange = syncPayload({ content: "x" });
  delete withoutRange.projection_states[0].range;
  expect(panel.tracksSelected(withoutRange, null)).toBe(false);
  expect(panel.tracksSelected(syncPayload({ content: "x" }), null)).toBe(true);
  // A payload whose selected id does not match its own state is also rejected.
  const mismatched = syncPayload({ content: "x" });
  mismatched.selected_agent = "other";
  expect(panel.tracksSelected(mismatched, null)).toBe(false);
  // Once tracking one agent, a different one is refused.
  expect(panel.tracksSelected(syncPayload({ content: "x", selected: "worker" }), "main")).toBe(false);
  expect(panel.tracksSelected(syncPayload({ content: "x", selected: "main" }), "main")).toBe(true);
  // A selection read from the sidebar overrides the tracked id entirely.
  expect(panel.tracksSelected(syncPayload({ content: "x", selected: "main" }), null, "worker")).toBe(false);
});

test("only real work counts as activity", () => {
  const { panel } = loadDebugPanel();
  expect(panel.isActive(syncPayload({ state: "Streaming" }), 0)).toBe(true);
  expect(panel.isActive({ api_activity: { active: false }, projection_states: [{ agent_id: "main" }] }, 0)).toBe(false);
  // Text arriving without an active flag still counts.
  expect(panel.isActive({ api_activity: { active: false }, projection_states: [] }, 12)).toBe(true);
  // An active turn counts even before any text arrives.
  const activeTurn = syncPayload({ state: "Completed" });
  activeTurn.projection_states[0].turn_state = { state: "active" };
  expect(panel.isActive(activeTurn, 0)).toBe(true);
});

test("an idle poll advances nothing, so the panel holds still", () => {
  const { panel, runtime, payloads } = loadDebugPanel();
  const idle = () => {
    const payload = syncPayload({ content: "已经写完的回答", state: "Completed" });
    payload.api_activity = { active: false, received_sse_events: 0 };
    payload.projection_states[0].turn_state = { state: "completed" };
    return payload;
  };
  payloads.push(idle());
  return runtime.fetch("/api/workspaces/chat/sync", { method: "POST" }).then(() => {
    const afterFirst = {
      bytes: panel.state.lastBytes,
      count: panel.state.syncCount,
      at: panel.state.lastAt,
    };
    // Repeated identical idle polls must not move any of the volatile counters.
    payloads.push(idle(), idle(), idle());
    return runtime.fetch("/api/workspaces/chat/sync", { method: "POST" })
      .then(() => runtime.fetch("/api/workspaces/chat/sync", { method: "POST" }))
      .then(() => runtime.fetch("/api/workspaces/chat/sync", { method: "POST" }))
      .then(() => {
        expect(panel.state.lastBytes).toBe(afterFirst.bytes);
        expect(panel.state.syncCount).toBe(afterFirst.count);
        expect(panel.state.lastAt).toBe(afterFirst.at);
        // The snapshot itself is still refreshed, so the values shown stay current.
        expect(panel.state.snapshot).not.toBe(null);
      });
  });
});

test("switching conversation resets the sampling window", () => {
  const { panel, runtime, payloads, select } = loadDebugPanel({ selectedAgent: "main" });
  payloads.push(syncPayload({ content: "第一个会话的回答", selected: "main" }));
  return runtime.fetch("/api/workspaces/chat/sync", { method: "POST" }).then(() => {
    expect(panel.state.agentId).toBe("main");
    expect(panel.state.rate.length).toBeGreaterThan(0);
    // The user now selects a different conversation, and its poll arrives.
    select("other");
    payloads.push(syncPayload({ content: "短", selected: "other" }));
    return runtime.fetch("/api/workspaces/chat/sync", { method: "POST" }).then(() => {
      expect(panel.state.agentId).toBe("other");
      // A new conversation starts from zero rather than inheriting the old length.
      expect(panel.state.rate.length).toBe(1);
      expect(panel.state.syncCount).toBe(1);
    });
  });
});

test("the launcher joins the sidebar's settings/theme row", () => {
  const source = readFileSync(join(import.meta.dir, "../client/debug-panel.js"), "utf8");
  const css = readFileSync(join(import.meta.dir, "../client/debug-panel.css"), "utf8");
  // Mounted into the existing footer row instead of floating over the transcript.
  expect(source).toContain('querySelector?.(".sidebar-appearance")');
  expect(source).toContain('"me-tric-debug-toggle theme-control"');
  // The floating placement must be gone, or it would still cover the composer.
  expect(css).not.toContain("position: fixed;\n  z-index: 41;");
  expect(css).not.toContain("bottom: 52px");
});

test("an unchanged frame writes no DOM", () => {
  const source = readFileSync(join(import.meta.dir, "../client/debug-panel.js"), "utf8");
  // Idle polls arrive every second; without this guard each one rewrote six
  // sections of innerHTML and reset any selection inside the stream box.
  expect(source).toContain("debugState.renderSignature");
  expect(source).toContain("if (signature === debugState.renderSignature) return;");
});
