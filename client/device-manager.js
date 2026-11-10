/**
 * me-tric device manager.
 *
 * A thin, self-contained panel layered on top of the shared frontend core. It is
 * deliberately *not* wired into `app.js`: the shared core stays byte-identical to
 * upstream so it can be re-synced at any time. Instead this module:
 *
 *  - registers a launcher button inside the sidebar footer,
 *  - lists devices reported by the native bridge (`list_devices`),
 *  - lets the user add/re-point/remove a device and switch the active one,
 *  - exposes `window.MeTricDevices` so future code (and agent-inspector) can react.
 *
 * Everything it needs from the native side already exists as Tauri commands, so
 * adding features here never requires touching the encryption path.
 */
(() => {
  "use strict";

  const tauri = globalThis.__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!invoke) return; // browser build: the panel simply does not exist

  const PANEL_ID = "me-tric-device-panel";
  const LAUNCHER_ID = "me-tric-device-launcher";

  /** @type {{id:string, endpoint:?string, active:boolean}[]} */
  let devices = [];
  /** Per-device probe results: { productVersion, requiresPassword, authenticated } */
  const probes = new Map();
  let busy = false;
  const subscribers = new Set();

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

  function endpointLabel(endpoint) {
    if (!endpoint) return "未设置地址";
    try {
      const url = new URL(endpoint);
      return url.port ? `${url.hostname}:${url.port}` : url.hostname;
    } catch {
      return endpoint;
    }
  }

  function probeLabel(device) {
    const probe = probes.get(device.id);
    if (!probe) return "未探测";
    if (probe.error) return `不可用 · ${probe.error}`;
    const parts = [`v${probe.productVersion || "?"}`];
    if (probe.requiresPassword === false) parts.push("免密");
    else if (probe.authenticated === false) parts.push("需登录");
    return parts.join(" · ");
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "me-tric-device-panel hidden";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "设备管理");

    panel.innerHTML = `
      <header class="me-tric-device-header">
        <h2>设备管理</h2>
        <button type="button" class="me-tric-device-close" aria-label="关闭">×</button>
      </header>
      <p class="me-tric-device-hint">
        每个设备持有独立的加密会话。切换设备只影响后续请求，已打开的工作区不会中断。
      </p>
      <ul class="me-tric-device-list" role="list"></ul>
      <form class="me-tric-device-form">
        <label>标识<input name="id" placeholder="office" maxlength="64" required></label>
        <label>地址<input name="endpoint" placeholder="http://192.168.1.10:38200" required></label>
        <button type="submit" class="primary-button">连接</button>
      </form>
      <div class="me-tric-device-error" role="alert"></div>
    `;
    return panel;
  }

  function render() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const list = panel.querySelector(".me-tric-device-list");
    list.textContent = "";
    if (!devices.length) {
      const empty = document.createElement("li");
      empty.className = "me-tric-device-empty";
      empty.textContent = "尚未添加设备。";
      list.append(empty);
      return;
    }
    for (const device of devices) {
      const row = document.createElement("li");
      row.className = "me-tric-device-row";
      row.dataset.active = String(device.active);

      const main = document.createElement("button");
      main.type = "button";
      main.className = "me-tric-device-main";
      main.dataset.action = "activate";
      main.dataset.deviceId = device.id;
      main.disabled = busy;
      main.innerHTML = `
        <strong>${escapeHtml(device.id)}${device.active ? " · 当前" : ""}</strong>
        <span class="me-tric-device-endpoint">${escapeHtml(endpointLabel(device.endpoint))}</span>
        <span class="me-tric-device-probe">${escapeHtml(probeLabel(device))}</span>
      `;

      const actions = document.createElement("span");
      actions.className = "me-tric-device-actions";
      for (const [action, label] of [["probe", "探测"], ["remove", "移除"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = action;
        button.dataset.deviceId = device.id;
        button.textContent = label;
        button.disabled = busy;
        if (action === "remove") button.classList.add("danger");
        actions.append(button);
      }

      row.append(main, actions);
      list.append(row);
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]
    ));
  }

  function setError(message) {
    const panel = document.getElementById(PANEL_ID);
    const region = panel?.querySelector(".me-tric-device-error");
    if (region) region.textContent = message || "";
  }

  async function refresh() {
    try {
      devices = await invoke("list_devices");
    } catch (error) {
      setError(String(error));
    }
    render();
    notify();
  }

  async function withBusy(task) {
    busy = true;
    render();
    try {
      return await task();
    } finally {
      busy = false;
      render();
    }
  }

  async function connectDevice(id, endpoint) {
    setError("");
    await withBusy(async () => {
      try {
        await invoke("configure_target", { endpoint, deviceId: id });
        await refresh();
        await probeOne(id);
      } catch (error) {
        setError(String(error));
      }
    });
  }

  async function activateDevice(id) {
    setError("");
    await withBusy(async () => {
      try {
        devices = await invoke("set_active_device", { deviceId: id });
        render();
        notify();
        // The shared core caches the active target, so a reload is the honest way
        // to guarantee every view now talks to the newly selected device.
        globalThis.location.reload();
      } catch (error) {
        setError(String(error));
      }
    });
  }

  async function removeDevice(id) {
    setError("");
    await withBusy(async () => {
      try {
        devices = await invoke("remove_device", { deviceId: id });
        probes.delete(id);
        render();
        notify();
      } catch (error) {
        setError(String(error));
      }
    });
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
    render();
    notify();
  }

  async function probeAll() {
    await withBusy(async () => {
      await Promise.all(devices.map((device) => probeOne(device.id)));
    });
  }

  function open() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.classList.remove("hidden");
    void refresh().then(() => probeAll());
  }

  function close() {
    document.getElementById(PANEL_ID)?.classList.add("hidden");
  }

  function installLauncher() {
    const footer = document.querySelector(".sidebar-footer");
    if (!footer || document.getElementById(LAUNCHER_ID)) return;
    const button = document.createElement("button");
    button.id = LAUNCHER_ID;
    button.type = "button";
    button.className = "me-tric-device-launcher";
    button.title = "设备管理";
    button.setAttribute("aria-label", "设备管理");
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
    button.addEventListener("click", open);
    footer.append(button);
  }

  function install() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = buildPanel();
    document.body.append(panel);
    installLauncher();

    panel.querySelector(".me-tric-device-close").addEventListener("click", close);
    panel.querySelector(".me-tric-device-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const id = form.elements.id.value.trim();
      const endpoint = form.elements.endpoint.value.trim();
      if (!id || !endpoint) return;
      void connectDevice(id, endpoint);
    });
    panel.querySelector(".me-tric-device-list").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const { action, deviceId } = button.dataset;
      if (action === "activate") void activateDevice(deviceId);
      else if (action === "remove") void removeDevice(deviceId);
      else if (action === "probe") void withBusy(() => probeOne(deviceId));
    });

    globalThis.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
  }

  install();

  globalThis.MeTricDevices = Object.freeze({
    subscribe,
    snapshot,
    refresh,
    probe: probeOne,
    open,
    close,
  });
})();
