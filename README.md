# ME Tric

ME Tric 是 [ME](https://github.com/me-s/me-s) 桌面客户端（`me-client`）的一个独立派生项目，保留了原有的 **Tauri 2 + 原生 JavaScript** UI 技术栈，在此基础上准备了两项客户端改进的基础设施：

1. **多设备（多 Gateway）管理** —— 一个客户端同时持有多个 Gateway 连接，可切换、探测、移除。
2. **更详细的 Agent 状态信息** —— 一个直接读取 `/api/events` 原始事件流的检视面板，可以看到被共享投影刻意隐藏的内部工具调用。

当前版本 `0.1.0`，尚未发布。

---

## 1. 与上游的关系

```
me-tric/
├── client/                    # 桌面壳：Tauri 2 应用 + 客户端专属前端资源
│   ├── src-tauri/             # Rust：窗口、IPC、加密桥接、SQLite 存储
│   ├── client-runtime.js      # MeFrontendRuntime 适配器（共享核心 ↔ 原生）
│   ├── client.css             # 客户端专属样式
│   ├── device-manager.{js,css}
│   ├── agent-inspector.{js,css}
│   ├── tool-diff.{js,css}     # 工具卡片的文件修改 diff
│   ├── paste-image.{js,css}   # 输入框粘贴图片：上传到 .me 并附路径
│   ├── debug-panel.{js,css}   # 右侧调试侧边栏：流式数据、速率、上下文、工具
│   └── build-frontend.js      # 把 frontend/ + client/ + vendor 装配成 frontend-dist/
├── frontend/                  # 共享权威前端核心（来自 me-s 的 src/webui，逐字节复制）
├── transport/                 # Noise 加密 HTTP 传输层（me-transport crate）
├── vendor/tauri-runtime-wry/  # 打了 patch 的 wry 运行时（Windows 透明窗必需）
├── tests/me_tric.test.js      # 客户端行为测试（bun test）
└── docs/IMPROVEMENTS.md       # 改进项清单：已交付 / 计划中 / 明确不做
```

### 硬性约定：`frontend/` 只读

`frontend/app.js`（约 252 KB、5,542 行）是 me-s WebUI、Gateway WebUI 和桌面壳**共用的唯一权威前端核心**。本项目把它当作**不可修改的上游依赖**，逐字节复制、永不编辑。

这样做的原因：一旦改动 `app.js`，从 me-s 同步更新就会产生冲突；而它同时也是"不改变 UI 技术栈"这条约束的落点。

因此 me-tric 的所有功能只能通过两条路接入：

| 接入方式 | 位置 | 适用 |
| --- | --- | --- |
| `globalThis.MeFrontendRuntime` 钩子 | `client/client-runtime.js` | 需要影响共享核心行为的改动（fetch、endpoint、capabilities、偏好存储……） |
| 独立脚本，在 `app.js` 之后加载 | `client/device-manager.js`、`client/agent-inspector.js` | 新增独立 UI（浮层面板），不侵入共享 DOM 渲染模型 |
| 包裹共享全局对象，在 `app.js` **之前**加载 | `client/tool-diff.js`、`client/paste-image.js`、`client/debug-panel.js` | 需要改变共享核心行为的改动；`app.js` 在调用时才解析 `MeToolPresenters`，而 `MeFrontendRuntime` 则是加载时读取一次，所以必须在它之前替换（后两个模块通过 `Object.create` 链式叠加，互不覆盖） |

`build-frontend.js` 里三张资产表（`sharedAssets` / `clientAssets` / `vendorAssets`）就是这个边界：新增功能模块只往 `clientAssets` 里加一行。

---

## 2. 构建

### 前置条件

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| Bun | 1.3+ | 运行 `build-frontend.js`、跑测试 |
| Rust | 1.85+（edition 2024） | 编译 `src-tauri`、`transport`、`vendor/tauri-runtime-wry` |
| Tauri 平台依赖 | 见 Tauri 2 文档 | Windows: WebView2 + MSVC；macOS: Xcode CLT；Linux: webkit2gtk 等 |

> **验证状态**（rustc 1.99.1 / cargo 1.99.1, x86_64-pc-windows-msvc）：
> - `cargo check` 通过
> - `cargo test` → **14 passed, 0 failed**
> - `cargo build` 通过，产出 `me-tric.exe`（23.8 MB），`me-tric version` 输出 `me-tric 0.1.0`
> - `cargo check --locked` 通过（`Cargo.lock` 与 `Cargo.toml` 一致）
>
> 关于 Windows 上是否需要 MSVC：**纯 Rust 依赖不需要**，rustc 1.99 默认用自带的 `rust-lld` 完成链接。但若将来引入需要 C/C++ 编译器构建的 crate（部分 `-sys` 包），仍需安装 MSVC Build Tools + Windows SDK。
>
> 首次构建会下载并编译整个 Tauri 依赖树，约 2–3 分钟；之后增量检查约 1–5 秒。

### 命令

```bash
# 1. 装配前端（先跑这个，产物进 client/frontend-dist/）
cd client
bun run build-frontend.js

# 2. 跑客户端测试
cd ..
bun test tests/me_tric.test.js

# 3. 开发模式 / 构建（需要 Rust + Tauri CLI）
cd client/src-tauri
cargo check
cargo test
cargo build            # 或 bunx @tauri-apps/cli@2.11.3 build
```

`package.json` 里的 `build` 脚本就是 `bun run build-frontend.js`，Tauri 的 `beforeDevCommand` / `beforeBuildCommand` 会自动调用它。

### `build-frontend.js` 会做什么

1. 清空并重建 `client/frontend-dist/`。
2. 从 `frontend/` 复制共享核心（`app.js`、`style.css`、主题、Markdown、transcript、工具渲染、图库、文件管理、终端、远程控制）。
3. 从 `client/` 复制客户端资源（`client-runtime.js` → `runtime.js`、`client.css`、两个新模块与 diff 模块及其样式、图标、阴影窗口）。
4. 从 `frontend/vendor/` 复制 markdown-it / KaTeX / xterm，并把 KaTeX 字体搬到 `fonts/`。
5. 改写 `index.html`：
   - 标题 `ME` → `ME Tric`
   - **删除** `<script src="/transport.js"></script>`
   - 在 `/theme.css` 之后插入六份客户端样式表
   - 在 `/app.js` **之前**插入 `agent-inspector.js`、`device-manager.js`、`tool-diff.js`（必须排在 `tool-presenters.js` 之后）、`paste-image.js` 与 `debug-panel.js`（后两者必须早于 `app.js` 读取 `MeFrontendRuntime`）
   - 登录页文案改为"输入服务地址和访问密码。"
6. 逐条断言，任一失败即抛 `me-tric frontend assembly failed: <原因>`。

其中"桌面包里不得出现 `/transport.js`"是一条安全断言：桌面端的加密由 Rust 侧（`gateway.rs`）承担，如果 wasm 传输层被打进包里，就会出现双重加密或绕过原生桥接。

---

## 3. 运行时架构

frontend-dist/index.html
  ├── runtime.js             ← client-runtime.js：安装 globalThis.MeFrontendRuntime
  ├── agent-inspector.js     ← 面板 2（依赖 MeFrontendRuntime）
  ├── device-manager.js      ← 面板 1（直接调用 Tauri invoke）
  ├── tool-presenters.js     ← 共享核心：工具卡片注册表 globalThis.MeToolPresenters
  ├── tool-diff.js           ← 包裹 MeToolPresenters + 卡片构建器，内联文件修改 diff
  ├── paste-image.js         ← 替换 MeFrontendRuntime：粘贴图片上传 + 提示词附路径
  ├── debug-panel.js         ← 再包一层 MeFrontendRuntime：观察 /api/sync 驱动调试侧边栏
  └── app.js                 ← 共享核心，原封不动（加载时读取 MeFrontendRuntime）
```

`tool-diff.js`、`paste-image.js` 与 `debug-panel.js` 都是“改变共享核心行为”的模块，但切入点不同：`tool-diff.js` 不碰 `app.js`，因为共享核心在每次渲染工具卡片时才去读 `globalThis.MeToolPresenters`，所以在它之前替换这个冻结对象就能生效（卡片构建器 `createMessageNode` / `updateToolCardNode` 要等 `app.js` 执行后才有，所以在 `DOMContentLoaded` 时再包一次）；后两者替换的是 `globalThis.MeFrontendRuntime` 本身——`app.js` 在加载时就把它存进模块作用域，之后再换就无效了。两个运行时补丁用 `Object.create` 链式叠加，各自只覆写 `fetch` 并委派给上一层，因此互不覆盖。装配脚本对三者各有顺序断言。
```

### 数据出口只有一个

所有业务数据都必须经过同一个 Tauri 命令 `gateway_request`：

- 只接受以 `/api/` 开头的路径，拒绝 CR/LF；
- 丢掉调用方传来的 `cookie` / `host` / `content-length` / `accept-encoding`；
- 强制 `Accept-Encoding: gzip` 并自行解压；
- 文本类响应回 `bodyText`，二进制回 `bodyBase64`（Tauri IPC 只有 JSON）。

大文件下载走另一条流式通道 `download_file` + `tauri::ipc::Channel<DownloadProgress>`，因为 `gateway_request` 会把整个 body 缓冲进内存。

### `device_id` 是可选的

这是本项目最重要的兼容性约定：共享核心完全不知道"设备"的存在。

| 命令 | 签名 |
| --- | --- |
| `configure_target` | `(endpoint, device_id?: String)` |
| `gateway_request` | `(request, device_id?: String)` |
| `download_file` | `(path, filename, device_id?, progress)` |

`app.js` 的登录页只调用 `configureTarget(endpoint)` 一个参数，`device_id` 缺省时落到原生侧的活动设备上。`DeviceRegistry::resolve` 的解析顺序：

```
显式 id → 活动 id（若仍注册）→ "default" → 字典序第一个
```

### 一设备一 transport

`me_transport::Transport` 内部持有 `Mutex<Option<Session>>`、单个 cookie jar 和按通道递增的请求号。**transport 绝不在设备之间共享或克隆**——`GatewayTransport` 的 `Clone` 只克隆指向同一连接的 `Arc`。

`DeviceRegistry` 因此是 `Arc<RwLock<BTreeMap<String, GatewayTransport>>>` 外加一个 `Arc<RwLock<Option<String>>>` 记录活动设备。

---

## 4. 两个新面板与一个渲染包装

### 设备管理（`device-manager.js`）

- 侧边栏底部新增一个 32×32 的启动按钮（追加到 `.sidebar-footer`）。
- 面板列出所有设备：id、`host:port`、探测结果（`未探测` / `不可用 · <err>` / `v<version> · 免密|需登录`）。
- 操作：**切换**（调用 `set_active_device` 成功后 `location.reload()`——共享核心会缓存当前 target，重载是保证所有视图都指向新设备的唯一诚实做法）、**探测**、**移除**。
- 表单：id（≤64 字节，仅 `[A-Za-z0-9_-]`）+ endpoint → `configure_target`，随后自动探测。
- 暴露 `globalThis.MeTricDevices = { subscribe, snapshot, refresh, probe, open, close }`。
- 在纯浏览器环境（无 `__TAURI__`）下直接静默退出，不留任何痕迹。

### Agent 检视（`agent-inspector.js`）

这是"更详细的 agent 状态"的落点。它**不使用** `/api/ui-projections/:agent/state`，而是直接读 `/api/events/:agent?after=&mutation=` 的原始事件流，因为共享投影会通过 `ui_backend.rs::tool_chat_presentation()` 把内部工具（`CHAT_HIDDEN_TOOL_NAMES` / `CHAT_HIDDEN_TOOL_PREFIXES`）标记为 `Hidden` 并整条丢弃 `ToolCall`。

- 自带每个 agent 的游标（`count` / `mutation`），完全不碰 `app.js` 的状态，出 bug 也不会污染对话视图。
- 服务端回 `reset` 时整段替换该 agent 的缓存；列数上限 400，单条 body 上限 4,000 字符。
- 概览表：标识 / 标题 / 类型 / 父会话 / 编排模式 / EDB / 事件数 / mutation / prompt rev / 输入草稿 rev / API 状态 / 当前轮 / 模型 / 推理强度 / Token 用量 / 上下文 / 上下文分项 / 压缩中 / WorkMap。
- `仅内部工具` 复选框只显示被投影隐藏的那些事件——这是投影本身给不出的信息。
- agent 列表是**从 DOM 只读抓取**的（`#agent-list [data-agent-row]` + `.active` / `aria-current`），因为 `app.js` 的 `state` 在模块作用域里没有导出。抓不到就退化为"无 agent"，不抛错。

### 修改 diff（`tool-diff.js`）

对话里的文件编辑卡片原本只显示新内容，而且详情要点开才看得到。`tool-diff.js` 把它变成带行号的双栏 diff（`-` 红底 / `+` 绿底 / 上下文行），覆盖 `File.Edit`、`File.EditBytes`、`File.Create`、`File.Replace`、`File.Append`。

**diff 默认就在卡片里，不用展开。** 它被放在头部下方、`.tool-details` 之外，因此卡片折叠着也能直接看到改了什么；点开详情仍然给出原来的输入/输出 JSON。diff 不会重复出现两次，`.tool-details` 的 HTML 与上游逐字节相同。

做不到“改 `expandedTools`”：那个 Set 在 `app.js` 的模块作用域里，没有导出也没有钩子，而折叠卡片只调 `summarize(name, args)`（拿不到 output），根本不会产生详情。所以改法是包住两个顶层卡片构建器 `createMessageNode` / `updateToolCardNode`（它们在本模块加载时还不存在，所以在 `DOMContentLoaded` / `load` 时重试安装），在渲染完成后的卡片节点里插入一个 `.tool-diff-inline`。这样既覆盖首次渲染，也覆盖“结果后到、卡片被重写”的更新路径。

旧文本从哪来——这是唯一需要解释的地方：

| 来源 | 何时可用 | 可信度 |
| --- | --- | --- |
| 同会话中的 `File.Read` 结果（`lines` + hash + `total_lines`） | 编辑前的读取 | 高：只有 hash 与 `previous_hash` **完全相等**才用 |
| 同会话中的 `File.Create` / `File.Replace` 的 `content` | 整文件写入后 | 中：客户端无法同步算 sha256，按“同路径 + 同行数”推断，并在提示里明说是推断 |
| 都没有 | — | 删除侧只给真实行号 + “原内容未记录”占位符，**绝不编造** |

这个配对不是碰运气：服务端拒绝未经 `File.Read` 的编辑（`read_required` / `stale_read` / `unread_range`），并在写入前校验 hash，所以读取必然紧邻编辑之前且 hash 一致。

降级行为：编辑进行中、失败、或输出缺失时不产生 diff（卡片与上游逐字节一致）；单卡片最多渲染 400 行；`File.EditBytes` 按字节计数，不假装是行 diff。

### 粘贴图片（`paste-image.js`）

输入框支持直接粘贴剪贴板里的图片。粘贴后缩略图堆叠显示在输入框**左侧**，并带有 `上传中 → 已上传 / 失败` 的状态；发送时把图片路径写进提示词，由 agent 自己决定要不要 `Image.View` 去读。

**为什么只能放路径，不能直接传图。** 服务端给用户的提示词只有 `content: String`（`submit_user_prompt` → `UserPromptEvent { content }`），模型看到的是 `<user_prompt>` 里的 XML 转义文本；而 `EventDataBase::append_image_content` 只允许 `Image.View` / `Image.Send` / `WebBrowser.Snapshot` 三个工具产生图片内容。所以客户端没有“给提示词挂图”的通道，只能把路径放到 agent 眼前。

**为什么走上传而不是写本地文件。** 工作区在服务端：远程 Gateway 部署时客户端磁盘不是服务端磁盘，而原生桥接里根本没有写文件的命令（`invoke_handler` 只有窗口、设备、`gateway_request`、下载相关）。所以图片用服务端自己的 `files/uploads/*` 接口传到 `workspace/.me/attachments/`，再把 `target_path` 减去 `files/list` 返回的 workspace 绝对路径，得到 `Image.View` 能直接解析的相对路径。

几个具体取舍：

- 目录用 `files/mkdir` 逐级建（`.me` → `.me/attachments`），因为服务端用的是非递归 `fs::create_dir`，目录已存在会报错，所以“已存在”按正常情况处理。
- 上传用 `conflict_policy: "keep_both"`：不给策略会返回 `requires_confirmation` 且没有 upload，`skip` 则直接丢弃。文件名带时间戳与随机后缀，正常情况下不会碰撞。
- 提示词里每张图一行 `[图片] <相对路径>`，不发任何指令句；重复发送不会把同一路径写两次。
- 输入框为空时会在发送前把路径行填进去，否则 `app.js` 会当成空消息、去开“发送设置”抽屉而不是发出去。
- 只有提交被接受才清空缩略图；上传中/失败的缩略图永远不进提示词。
- 接入点是替换 `globalThis.MeFrontendRuntime`（原型子对象，只覆写 `fetch`），因为 `app.js` 在加载时就把这个全局存进模块作用域了。
- 缩略图容器插在 `.prompt-input-stack` 之前，靠给 `.composer-shell` 加类切成两列网格；`frontend/` 一行未改。

### 调试侧边栏（`debug-panel.js`）

底部状态栏只给出模型、推理强度与一个 SSE 计数，看不出 agent 到底在干什么。右侧调试侧边栏补齐这部分：原始流式文本、输出速率、上下文明细、工具调用耗时、事件游标。右上角的悬浮按钮展开/收起，展开状态存 localStorage。

**数据从哪来。** `app.js` 的 `state` 全在模块作用域且无导出，但每次 `/api/sync` 的响应体里就有全部原料：`projection_states[].range.projections[]`（assistant 流式 `content`、tool 调用、turn toolbar）与 `api_activity`。所以模块再包一层 `MeFrontendRuntime.fetch`，`clone()` 出响应体读 JSON，**不影响** 原响应。

**实测与估算的界线（重要）**：

| 指标 | 来源 | 性质 |
| --- | --- | --- |
| 本轮 SSE 事件数 | `api_activity.received_sse_events` | 实测，但每轮 API 调用归零，不是累计 |
| 响应体积 | 客户端自己量响应体 UTF-8 字节 | 实测 |
| 上下文分项 / 总计 | `context.values` / `context.total` | 实测 |
| 工具耗时 | `result.finished - tool.started` | 实测；未完成时显示“进行中”而不编造 |
| 字符/秒 | 同一 assistant key 的 `content.length` 差分 | 实测 |
| tok/s | 字符数 ÷ 4 | **估算**：流式期间服务端不返回 `api_usage`（只在 `ApiState::Completed` / `Interrupted` 时写入），无法实测 |
| 服务端用量 | `api_usage` | 实测，但只在 API 完成后出现 |

**为什么不能直接测 token/s。** `ui_projection.rs` 里 `api_usage` 仅在 `ApiState::Completed` 与 `Interrupted` 两个分支被赋值，`ModelChanged` 与压缩完成时还会置 `None`。流式过程中它恒为 `null`，因此任何“实时 token/s”都只能是换算值——面板里明确标为“估算”，并在下方附一行说明。

**几个实现细节**：

- 速率按“同一个 assistant key”比较，新的一轮从零开始，不把上一轮的文本长度当成突发；文本变短（重写）时速率归零而不是负数。
- 面板展开时 `html.me-tric-debug-open` 给 `.workspace` 加右内边距，而不是盖住对话；窗口窄于 1000px 时改为覆盖式。
- “暂停”冻结采样（包括流式文本），便于看清楚某一帧；“清空”重置全部计数。
- 状态栏新增的 `⇣ 12.3 KB · 42 SSE` 是本模块自己插入的 span，因为 `frontend/` 只读、不能改 `index.html`。
- 与 `paste-image.js` 共存：两者都用 `Object.create` 链式包裹 `MeFrontendRuntime`，各覆写 `fetch` 并委派给上一层。



---

## 5. 数据与存储

| 内容 | 位置 |
| --- | --- |
| 数据库 | `<app_data_dir>/me-tric.sqlite3`，可用 `ME_TRIC_DATA_DIR` 覆盖 |
| 设备端点 | `client_settings` 表：`device.<id>.endpoint` |
| 活动设备 | `client_settings` 表：`device.active` |
| UI 偏好 | `client_settings` 表：四个白名单键 |
| 记住的密码 | `remembered_devices` 表 |

设备信息刻意复用现有的 `client_settings(key, value)` 表，**没有新增表、没有 schema 迁移**：`storage.rs` 里已有一套 `PRAGMA user_version = 1` + `VACUUM` 的旧数据处理逻辑，加表会迫使再加一步迁移。

设备 id 的校验是 `[A-Za-z0-9_-]`、非空、≤64 字节。它同时充当 SQLite 主键片段和未来的 URL 路径段，所以斜杠和 `..` 必须在入口就被拒绝。

设备上限 `MAX_DEVICES = 16`：每个设备保持一条 Noise 通道，可能还有在途轮询，无上限会耗尽宿主机的 socket 与文件描述符。

### 已知安全风险（继承自上游，非本次引入）

`remembered_devices.password` **以明文存储**。这是 me-client 原本的行为，本项目未做改动。若要扩展凭据存储，应先迁移到操作系统钥匙串（见 `docs/IMPROVEMENTS.md`）。

---

## 6. 测试

```bash
bun test tests/me_tric.test.js
```

53 项测试（`53 pass, 0 fail`，509 expect），覆盖：

- 原生 UTF-8 JSON 响应 + 前端静态资源仍走浏览器 `fetch`
- 就绪门控（`data-me-tric-startup="pending"` → `visibility:hidden` → `windowReady()` 一次性放行）
- iOS 不产生桌面窗口动作
- 窗口标题去重缓存
- 浏览器快捷键抑制（F5 / Ctrl+R / Ctrl+A / Alt+←→ / 右键菜单），同时不破坏 `.xterm` 与文本编辑
- 平台窗口造型（compositor 圆角、Windows 阴影子窗口、`WS_EX_NOREDIRECTIONBITMAP`）
- 文本可选中边界
- UI 偏好白名单（4 个键，`gateway.endpoint` 必须被拒）
- 记住设备的增删与在线状态
- macOS 关闭=隐藏、Reopen=恢复而非新开窗口
- page-close JSON beacon 走原生传输
- 前端装配（`frontend/` 来源、新模块注册、`/transport.js` 必须 absent、`tool-diff.js` / `paste-image.js` / `debug-panel.js` 的加载顺序）
- 版本一致性（`package.json`、`tauri.conf.json`、`Cargo.toml`、`Cargo.lock` 全为 `0.1.0`）
- 下载取消的注册时序与预取消
- 设备列左栏、非激活保存不抢 target
- 反复观察同一份写入文本不会把已验证的读取挤出缓存
- **粘贴图片**：文件名是单一安全路径组件且不碰撞；上传地址相对化到 workspace（`Image.View` 的口径）；提示词只加一行路径且不重复；只有 `kind=file` 且 `image/*` 的剪贴板项被接管；替换运行时后其余成员完好且不重复包裹；空输入框发图片也能发出；上传中/失败的缩略图不进提示词；提交被拒时保留缩略图；其他请求直接透传
- **调试侧边栏**：字节/token/时长格式化；以 `selected_agent` 而非数组顺序定位会话状态；流式文本取最新 assistant 部分；未完成工具不给耗时；上下文份额由 `total` 推导且无 total 时不除零；速率按同一 assistant key 计算且文本变短不产生负值；采样 sync 但不消费响应体；非 sync 请求不采样；暂停后不再采样；运行时链式包裹不丢失成员也不重复叠加

> 测试顶部把 `readFileSync` 包了一层，统一 `\r\n` → `\n`。仓库在 Windows 上以 CRLF 检出，而多处断言写的是 `\n`。上游 `me-s` 在同一台机器上跑自己的测试套件会有 3 个失败，原因正是这个；本项目通过归一化解决。

---

## 7. 命名对照

| 上游 | me-tric |
| --- | --- |
| crate `me-client` | `me-tric` |
| lib `me_client_lib` | `me_tric_lib` |
| 产品名 `ME Client` | `ME Tric` |
| identifier | `studio.me-tric.desktop` |
| 数据库 `me-client.sqlite3` | `me-tric.sqlite3` |
| `ME_CLIENT_DATA_DIR` | `ME_TRIC_DATA_DIR` |
| `ME_CLIENT_TEST_DATA_DIR` | `ME_TRIC_TEST_DATA_DIR` |
| `new_me_client_window` / `newMeClientWindow:` | `new_me_tric_window` / `newMeTricWindow:` |
| CSS 钩子 `me-client*` | `me-tric*` |
| 启动属性 `data-me-client-startup` | `data-me-tric-startup` |

旧数据目录**故意不迁移**：这是一个独立产品，不应悄悄接管已安装的 ME 的数据。

`client/src-tauri/icons/` 目前仍是上游 ME 的图标，尚未替换为 ME Tric 专属图标。

---

## 8. 许可

见 `LICENSE`（MIT），与上游一致。
