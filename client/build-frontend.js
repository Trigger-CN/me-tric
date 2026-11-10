import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(clientRoot, "..");
// The shared, authoritative frontend core lives at <repo>/frontend (a copy of me-s src/webui).
const webuiRoot = resolve(repositoryRoot, "frontend");
const vendorRoot = resolve(webuiRoot, "vendor");
const outputRoot = resolve(clientRoot, "frontend-dist");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

// Shared core assets: copied verbatim, never edited here. All product differences
// must go through runtime.js (the MeFrontendRuntime adapter) or client.css.
const sharedAssets = [
  ["app.js", "app.js"],
  ["style.css", "style.css"],
  ["theme.js", "theme.js"],
  ["theme.css", "theme.css"],
  ["markdown.js", "markdown.js"],
  ["transcript.js", "transcript.js"],
  ["tool-presenters.js", "tool-presenters.js"],
  ["image-gallery.js", "image-gallery.js"],
  ["file-manager.js", "file-manager.js"],
  ["session-terminal.js", "session-terminal.js"],
  ["remote-control.js", "remote-control.js"],
];

// me-tric only modules. New feature surfaces (device manager, agent inspector, ...)
// are registered here so they ship with the desktop bundle and stay out of the
// browser build of the upstream project.
const clientAssets = [
  ["client-runtime.js", "runtime.js"],
  ["client.css", "client.css"],
  ["device-manager.js", "device-manager.js"],
  ["device-manager.css", "device-manager.css"],
  ["agent-inspector.js", "agent-inspector.js"],
  ["agent-inspector.css", "agent-inspector.css"],
  ["app-icon.svg", "app-icon.svg"],
  ["window-shadow.html", "window-shadow.html"],
];

const vendorAssets = [
  ["markdown-it.min.js", "markdown-it.js"],
  ["katex.min.js", "katex.js"],
  ["katex.min.css", "katex.css"],
  ["xterm.js", "xterm.js"],
  ["xterm.css", "xterm.css"],
  ["xterm-addon-fit.js", "xterm-addon-fit.js"],
  ["xterm-addon-unicode11.js", "xterm-addon-unicode11.js"],
];

for (const [source, destination] of sharedAssets) {
  await copyFile(resolve(webuiRoot, source), resolve(outputRoot, destination));
}
for (const [source, destination] of clientAssets) {
  await copyFile(resolve(clientRoot, source), resolve(outputRoot, destination));
}
for (const [source, destination] of vendorAssets) {
  await copyFile(resolve(vendorRoot, source), resolve(outputRoot, destination));
}
await cp(resolve(vendorRoot, "katex-fonts"), resolve(outputRoot, "fonts"), { recursive: true });

const sourceHtml = await readFile(resolve(webuiRoot, "index.html"), "utf8");
const html = sourceHtml
  .replace("<title>ME</title>", "<title>ME Tric</title>")
  // The desktop build never speaks the browser transport: encryption is owned by the
  // Rust bridge in src-tauri/src/gateway.rs, so the wasm loader must not be shipped.
  // Matched by regex so CRLF checkouts are handled as well as LF.
  .replace(/[ \t]*<script src="\/transport\.js"><\/script>\r?\n/, "")
  .replace(
    '<link rel="stylesheet" href="/theme.css">',
    '<link rel="stylesheet" href="/theme.css">\n  <link rel="stylesheet" href="/client.css">\n  <link rel="stylesheet" href="/device-manager.css">\n  <link rel="stylesheet" href="/agent-inspector.css">',
  )
  .replace("      <p>请输入访问密码。</p>", "      <p>输入服务地址和访问密码。</p>")
  // Feature modules load after the shared core so they can consume MeFrontendRuntime
  // and the Me* globals that app.js already installed.
  .replace(
    '  <script src="/app.js"></script>',
    '  <script src="/agent-inspector.js"></script>\n  <script src="/device-manager.js"></script>\n  <script src="/app.js"></script>',
  );

// Deterministic assertions: if the upstream entry structure changes, fail loudly
// instead of silently emitting a broken bundle.
const checks = [
  [html !== sourceHtml, "frontend entry did not change; replacement anchors are stale"],
  [html.includes("/runtime.js"), "runtime.js is missing from the assembled entry"],
  [html.includes("login-endpoint"), "login endpoint field is missing from the assembled entry"],
  [!html.includes("/transport.js"), "browser transport must not be shipped in the desktop bundle"],
  [html.includes("/device-manager.js"), "device-manager.js failed to register"],
  [html.includes("/agent-inspector.js"), "agent-inspector.js failed to register"],
  [html.includes("/client.css"), "client.css failed to register"],
];
for (const [ok, message] of checks) {
  if (!ok) throw new Error(`me-tric frontend assembly failed: ${message}`);
}

await writeFile(resolve(outputRoot, "index.html"), html, "utf8");

const { readdir } = await import("node:fs/promises");
const produced = await readdir(outputRoot);
if (produced.length < sharedAssets.length + clientAssets.length + vendorAssets.length) {
  throw new Error("me-tric frontend assembly produced fewer files than expected");
}

console.log(`assembled me-tric frontend at ${outputRoot}`);
