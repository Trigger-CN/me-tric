/**
 * me-tric device rail.
 *
 * Every ME Gateway the user has connected gets a tab in a vertical rail pinned to
 * the very left edge of the window, plus a `+` tab that opens a connect dialog.
 * Clicking a tab switches which device the shared core talks to, in place.
 *
 * Why this file never reloads the window: `frontend/app.js` is an immutable
 * upstream copy, and its startup path always returns to the "选择设备" screen
 * whenever the `rememberedDevices` capability is present. A reload therefore
 * cannot land back inside a session, so switching devices by reloading is
 * exactly the "bounced back to the login page" bug. Switching the native target
 * and letting the core's own poll pick up the new device keeps the user where
 * they are instead.
 *
 * The shared core stays device-unaware: it omits `deviceId` on every request, so
 * the native registry resolves the active device for it.
 */
(() => {
  "use strict";

  const tauri = globalThis.__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!invoke) return; // browser build: the rail simply does not exist

  const RAIL_ID = "me-tric-device-rail";
  const DIALOG_ID = "me-tric-device-dialog";
  const MAX_ID = 64;

  /** @type {{id:string, endpoint:?string, active:boolean}[]} */
  let devices = [];
  /** Per-device probe results: { productVersion, requiresPassword, authenticated, error } */
  const probes = new Map();
  let busy = false;
  let dialogDeviceId = null;
  const subscribers = new Set();

  function runtime() {
    return globalThis.MeFrontendRuntime || null;
  }

  function notify() {
    for (const subscriber of subscribers) {
      try {
        subscriber(snapshot());
      } catch (error) {
        console.warn("me-tric device listener failed", error);
      }
    }
  }

  function snapshot() {
    return devices.map((device) => ({ ...device, probe: probes.get(device.id) || null }));
  }

  function subscribe(listener) {
    subscribers.add(listener);
    listener(snapshot());
    return () => subscribers.delete(listener);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]
    ));
  }

  function endpointLabel(endpoint) {
    if (!endpoint) return "未设置地址";
    try {
      const url = new URL(endpoint);
      return url.port ? `${url.hostname}:${url.port}` : url.hostname;
    } catch {
      return endpoint;
    }
  }

  /** Two-character badge: first alphanumeric of each of the first two words. */
  function deviceBadge(id) {
    const words = String(id || "")
      .split(/[-_\s]+/)
      .filter(Boolean);
    if (!words.length) return "??";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function deviceState(device) {
    const probe = probes.get(device.id);
    if (!probe) return { state: "unknown", label: "未探测" };
    if (probe.error) return { state: "offline", label: "不可用" };
    if (probe.authenticated === false) return { state: "locked", label: "需登录" };
    return { state: "online", label: `v${probe.productVersion || "?"}` };
  }

  /* ------------------------------------------------------------------ rail */

  function buildRail() {
    const rail = document.createElement("nav");
    rail.id = RAIL_ID;
    rail.className = "me-tric-device-rail";
    rail.setAttribute("aria-label", "设备");
    rail.setAttribute("role", "tablist");
    rail.setAttribute("aria-orientation", "vertical");

    const list = document.createElement("div");
    list.className = "me-tric-device-rail-list";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "me-tric-device-rail-add";
    add.dataset.deviceAction = "add";
    add.title = "添加设备";
    add.setAttribute("aria-label", "添加设备");
    add.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

    rail.append(list, add);
    return rail;
  }

  function renderRail() {
    const rail = document.getElementById(RAIL_ID);
    if (!rail) return;
    const list = rail.querySelector(".me-tric-device-rail-list");
    list.textContent = "";
    for (const device of devices) {
      const { state, label } = deviceState(device);
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "me-tric-device-tab";
      tab.dataset.deviceAction = "activate";
      tab.dataset.deviceId = device.id;
      tab.dataset.state = state;
      tab.dataset.active = String(device.active);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(device.active));
      tab.title = `${device.id}\n${endpointLabel(device.endpoint)}\n${label}`;
      tab.setAttribute("aria-label", `${device.id}，${endpointLabel(device.endpoint)}，${label}`);
      tab.innerHTML = `
        <span class="me-tric-device-tab-badge">${escapeHtml(deviceBadge(device.id))}</span>
        <span class="me-tric-device-tab-dot" aria-hidden="true"></span>
      `;
      list.append(tab);
    }
    rail.classList.toggle("is-empty", devices.length === 0);
  }

  /* ---------------------------------------------------------------- dialog */

  function buildDialog() {
    const backdrop = document.createElement("div");
    backdrop.id = DIALOG_ID;
    backdrop.className = "me-tric-device-backdrop hidden";
    backdrop.innerHTML = `
      <section class="me-tric-device-dialog" role="dialog" aria-modal="true" aria-labelledby="me-tric-device-dialog-title">
        <header>
          <h2 id="me-tric-device-dialog-title">连接设备</h2>
          <button type="button" class="me-tric-device-dialog-close" aria-label="关闭">×</button>
        </header>
        <p class="me-tric-device-dialog-hint">
          每个设备使用独立的加密会话，连接新设备不会影响已经打开的设备。
        </p>
        <form class="me-tric-device-dialog-form">
          <label class="me-tric-device-field">
            <span>设备标识</span>
            <input name="id" placeholder="office" maxlength="${MAX_ID}" autocomplete="off" spellcheck="false">
            <small>仅限字母、数字、- 和 _，用于标签栏显示名。</small>
          </label>
          <label class="me-tric-device-field">
            <span>服务地址</span>
            <input name="endpoint" placeholder="http://192.168.1.10:38200" autocomplete="url" spellcheck="false">
          </label>
          <label class="me-tric-device-field">
            <span>访问密码</span>
            <input name="password" type="password" autocomplete="off">
            <small class="me-tric-device-password-hint">该网关不需要密码时可以留空。</small>
          </label>
          <label class="me-tric-device-remember">
            <input name="remember" type="checkbox">
            <span>记住密码</span>
          </label>
          <div class="me-tric-device-dialog-error" role="alert"></div>
          <footer>
            <button type="button" class="ghost-button me-tric-device-dialog-cancel">取消</button>
            <button type="submit" class="primary-button me-tric-device-dialog-submit">连接</button>
          </footer>
        </form>
      </section>
    `;
    return backdrop;
  }

  function dialog() {
    return document.getElementById(DIALOG_ID);
  }

  function setDialogError(message) {
    const region = dialog()?.querySelector(".me-tric-device-dialog-error");
    if (region) region.textContent = message || "";
  }

  function setDialogBusy(value) {
    const element = dialog();
    if (!element) return;
    const submit = element.querySelector(".me-tric-device-dialog-submit");
    submit.disabled = Boolean(value);
    submit.textContent = value ? "连接中…" : "连接";
    for (const input of element.querySelectorAll("input")) input.disabled = Boolean(value);
    element.querySelector(".me-tric-device-dialog-cancel").disabled = Boolean(value);
  }

  function suggestDeviceId() {
    const taken = new Set(devices.map((device) => device.id));
    if (!taken.has("default")) return "default";
    for (let index = 1; index <= 64; index += 1) {
      const candidate = `device-${index}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `device-${Date.now()}`;
  }

  function openDialog(deviceId = null) {
    const element = dialog();
    if (!element) return;
    dialogDeviceId = deviceId;
    setDialogError("");
    setDialogBusy(false);
    const form = element.querySelector(".me-tric-device-dialog-form");
    form.reset();
    const known = devices.find((device) => device.id === deviceId);
    form.elements.id.value = known ? known.id : suggestDeviceId();
    form.elements.endpoint.value = known?.endpoint || "";
    form.elements.id.readOnly = Boolean(known);
    const remembered = known?.endpoint
      ? runtime()?.savedDevicePasswords?.list?.()
        .find((entry) => entry.endpoint === known.endpoint)
      : null;
    if (remembered?.password) {
      form.elements.password.value = remembered.password;
      form.elements.remember.checked = true;
    }
    element.querySelector("#me-tric-device-dialog-title").textContent =
      known ? "重新连接设备" : "连接设备";
    element.classList.remove("hidden");
    void refreshLocalDeviceHint();
    (known ? form.elements.password : form.elements.id).focus();
  }

  function closeDialog() {
    dialog()?.classList.add("hidden");
    dialogDeviceId = null;
  }

  /** Offer the auto-discovered local Gateway as one-click fill. */
  async function refreshLocalDeviceHint() {
    const form = dialog()?.querySelector(".me-tric-device-dialog-form");
    if (!form || form.elements.endpoint.value) return;
    try {
      const bootstrap = await invoke("client_bootstrap");
      const local = bootstrap?.localDevice;
      if (!local?.online || !local?.endpoint) return;
      if (form.elements.endpoint.value) return;
      form.elements.endpoint.value = local.endpoint;
      if (local.requiresPassword === false) form.elements.password.placeholder = "该网关未设置密码";
    } catch {
      // A failed hint is not an error the user needs to see.
    }
  }

  /* ---------------------------------------------------------------- actions */

  async function refresh() {
    try {
      devices = await invoke("list_devices");
    } catch (error) {
      console.warn("me-tric device list unavailable", error);
    }
    renderRail();
    notify();
  }

  async function probeOne(id) {
    try {
      const result = await invoke("probe_device", { deviceId: id });
      probes.set(id, {
        productVersion: result.productVersion,
        requiresPassword: result.requiresPassword,
        authenticated: result.authenticated,
      });
    } catch (error) {
      probes.set(id, { error: String(error) });
    }
    renderRail();
    notify();
    return probes.get(id);
  }

  async function probeAll() {
    await Promise.all(devices.map((device) => probeOne(device.id)));
  }

  /** Saved password for an endpoint, if the user asked us to keep one. */
  function savedPassword(endpoint) {
    if (!endpoint) return null;
    const rows = runtime()?.rememberedDevices?.list?.() || [];
    const row = rows.find((entry) => entry.endpoint === endpoint);
    return row?.password || null;
  }

  /**
   * Make `id` the device every device-unaware request goes to.
   *
   * Never reloads the window. `app.js` boots to its device picker whenever the
   * `rememberedDevices` capability exists, so a reload could not land back inside
   * a session - that reload was the "thrown back to the start page" report.
   *
   * Refuses to switch to a device that still needs a password: its next request
   * would answer 401 and the core would raise its login screen mid-session.
   */
  async function activateDevice(id) {
    if (busy) return;
    const device = devices.find((entry) => entry.id === id);
    if (!device) return;
    let probe = probes.get(id);
    if (!probe) probe = await probeOne(id);
    if (probe?.error) {
      openDialog(id);
      return;
    }
    if (probe?.authenticated === false) {
      // A remembered password is enough to finish the switch silently.
      const password = savedPassword(device.endpoint);
      if (password) {
        const ok = await loginQuietly(id, password);
        if (!ok) {
          openDialog(id);
          return;
        }
      } else {
        openDialog(id);
        return;
      }
    }
    busy = true;
    renderRail();
    try {
      devices = await invoke("set_active_device", { deviceId: id });
      const shared = runtime();
      if (shared?.selectDevice) {
        try {
          await shared.selectDevice(id);
        } catch (error) {
          console.warn("me-tric could not mirror the active device", error);
        }
      }
      await refresh();
      // Ask the core's own poll to re-read state from the new device instead of
      // rebuilding the page, so the open workspace and scroll position survive.
      requestCoreResync();
    } catch (error) {
      console.warn("me-tric device switch failed", error);
    } finally {
      busy = false;
      renderRail();
    }
  }

  /** Log a device in without opening the dialog. Returns true when usable. */
  async function loginQuietly(id, password) {
    try {
      const login = await invoke("login_device", {
        deviceId: id,
        password: String(password ?? ""),
        browserPort: browserPort(),
      });
      const probe = await probeOne(id);
      return probe?.authenticated !== false && login?.ok !== false;
    } catch (error) {
      console.warn("me-tric silent device login failed", error);
      return false;
    }
  }

  /**
   * Nudge the shared core into re-reading its state from the now-active device.
   *
   * The core owns its own polling loop and exposes no hook, so the least invasive
   * lever is a synthetic visibility/online event, which its reconnect logic
   * already treats as "re-verify the connection".
   */
  function requestCoreResync() {
    try {
      globalThis.dispatchEvent(new Event("online"));
    } catch (error) {
      console.warn("me-tric could not request a core resync", error);
    }
  }

  /**
   * Register a Gateway, authenticate on that device's own transport, and only
   * then make it active.
   *
   * Order matters. `configure_target` runs with `activate: false` so the session on
   * screen keeps its target, and the activation only happens after the login
   * succeeded - activating a password-protected device before it holds a session
   * is what handed the user back to the start page.
   */
  async function connectDevice({ id, endpoint, password, remember }) {
    setDialogError("");
    setDialogBusy(true);
    try {
      const configured = await invoke("configure_target", {
        endpoint: String(endpoint || ""),
        deviceId: String(id || ""),
        activate: false,
      });
      const targetId = configured?.deviceId || id;
      // The device is registered at this point, so surface it in the rail even when
      // the password turns out to be wrong - it becomes a locked tab the user can
      // retry, rather than silently vanishing.
      await refresh();
      const login = await invoke("login_device", {
        deviceId: targetId,
        password: String(password ?? ""),
        browserPort: browserPort(),
      });
      const status = Number(login?.httpStatus || 0);
      if (login?.ok === false || status === 401 || status === 403) {
        const probe = await probeOne(targetId);
        if (probe?.authenticated === false) {
          setDialogError(login?.error ? String(login.error) : "密码错误或认证失败");
          return;
        }
      }
      if (remember && password) {
        try {
          await runtime()?.rememberedDevices?.remember?.(configured.endpoint, password);
        } catch (error) {
          console.warn("me-tric could not remember the device password", error);
        }
      }
      const probe = await probeOne(targetId);
      if (probe?.authenticated === false) {
        setDialogError("该设备仍需要登录，请检查密码");
        return;
      }
      closeDialog();
      await refresh();
      await activateDevice(targetId);
    } catch (error) {
      setDialogError(String(error?.message || error));
    } finally {
      setDialogBusy(false);
      if (!busy) renderRail();
    }
  }

  async function removeDevice(id) {
    const device = devices.find((entry) => entry.id === id);
    if (!device) return;
    const label = `${device.id}（${endpointLabel(device.endpoint)}）`;
    if (!globalThis.confirm?.(`移除设备 ${label}？该设备保存的密码也会被删除。`)) return;
    try {
      devices = await invoke("remove_device", { deviceId: id });
      probes.delete(id);
      renderRail();
      notify();
      if (!devices.some((entry) => entry.active) && devices.length) {
        await activateDevice(devices[0].id);
      } else if (devices.length) {
        const shared = runtime();
        const active = devices.find((entry) => entry.active);
        if (shared?.selectDevice && active) {
          try {
            await shared.selectDevice(active.id);
          } catch {
            // Mirroring is best-effort; the native registry is authoritative.
          }
        }
      }
    } catch (error) {
      console.warn("me-tric device removal failed", error);
    }
  }

  function browserPort() {
    try {
      const explicit = Number(globalThis.location?.port || 0);
      if (explicit) return explicit;
      return String(globalThis.location?.protocol || "").toLowerCase() === "https:" ? 443 : 80;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  function install() {
    if (document.getElementById(RAIL_ID)) return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", install, { once: true });
      return;
    }
    // Appended to `body`, not `#app`: `#app` is hidden while the login screen is
    // up, and the rail has to stay usable in both states.
    document.body.append(buildRail());
    document.documentElement.classList.add("me-tric-has-device-rail");
    document.body.append(buildDialog());

    const rail = document.getElementById(RAIL_ID);
    rail.addEventListener("click", (event) => {
      const add = event.target.closest('[data-device-action="add"]');
      if (add) {
        openDialog(null);
        return;
      }
      const tab = event.target.closest('[data-device-action="activate"]');
      if (!tab) return;
      if (tab.dataset.active === "true") {
        openDialog(tab.dataset.deviceId);
        return;
      }
      void activateDevice(tab.dataset.deviceId);
    });
    rail.addEventListener("contextmenu", (event) => {
      const tab = event.target.closest('[data-device-action="activate"]');
      if (!tab) return;
      event.preventDefault();
      void removeDevice(tab.dataset.deviceId);
    });

    const element = dialog();
    element.querySelector(".me-tric-device-dialog-close").addEventListener("click", closeDialog);
    element.querySelector(".me-tric-device-dialog-cancel").addEventListener("click", closeDialog);
    element.addEventListener("mousedown", (event) => {
      if (event.target === element) closeDialog();
    });
    element.querySelector(".me-tric-device-dialog-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      void connectDevice({
        id: form.elements.id.value.trim(),
        endpoint: form.elements.endpoint.value.trim(),
        password: form.elements.password.value,
        remember: Boolean(form.elements.remember.checked),
      });
    });
    globalThis.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeDialog();
    });

    void refresh().then(() => probeAll());
    globalThis.setInterval(() => {
      if (document.hidden) return;
      if (!document.getElementById("app")?.classList.contains("hidden")) void refresh();
    }, 4000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }

  globalThis.MeTricDevices = Object.freeze({
    subscribe,
    snapshot,
    refresh,
    probe: probeOne,
    open: () => openDialog(null),
    openDevice: openDialog,
    close: closeDialog,
    activate: activateDevice,
  });
})();
