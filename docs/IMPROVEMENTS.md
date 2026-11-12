# me-tric 改进清单

本文记录 me-tric 相对上游 `me-client` 的改进项，分三类：**已交付**、**计划中**、**明确不做**。

约束前提：**不改变 UI 技术栈**（Tauri 2 + 原生 JS + 共享权威核心 `frontend/app.js`），**优先纯客户端改动**（不复制、不修改 me-s 服务端源码）。

---

## A. 已交付（本版本 0.1.0）

### A1. 多设备注册表 `DeviceRegistry`

**问题**：上游 `me-client` 只有单个 `Arc<RwLock<Connection>>`。`rememberedDevices` 只记住凭据，无法同时连接多个 Gateway——每次切换都要拆掉旧连接。

**做法**：
- 新增 `client/src-tauri/src/devices.rs`。
- `Arc<RwLock<BTreeMap<String, GatewayTransport>>>` + `Arc<RwLock<Option<String>>>`（活动设备）。
- `configure` / `restore` / `set_active` / `active_id` / `resolve` / `remove` / `status` / `cancel_download`。
- `DEFAULT_DEVICE_ID = "default"`、`MAX_DEVICES = 16`。
- `validate_device_id`：非空、≤64 字节、`[A-Za-z0-9_-]`。

**关键不变量**：一个设备一个 `GatewayTransport`。`Transport` 内部是 `Mutex<Option<Session>>` + 单个 cookie jar + 按通道递增的请求号，跨设备共享必然导致会话、cookie、nonce 互相污染。`GatewayTransport` 的 `Clone` 只克隆指向**同一连接**的 `Arc`。

### A2. 可选的 `device_id`：零侵入兼容链

**问题**：共享核心 `app.js` 的登录页调用 `configureTarget(endpoint)` 只传一个参数，`fetch()` 里也没有"设备"概念。任何强制要求 `device_id` 的设计都会立刻破坏共享核心。

**做法**：`device_id: Option<String>` 贯穿全部相关命令。解析顺序：

```
显式 id → 活动 id（若仍注册）→ "default" → 字典序第一个
```

这是整个设计里最重要的兼容性约定。结果是 `app.js` 一行未改就能在多设备环境下工作。

### A3. `probe_device`：补齐客户端↔服务端版本协商

**问题**：上游的 `managed_protocol` 强制 `me-gateway` 与其 `me-s` 子进程版本严格相等，但**客户端与 Gateway 之间的版本兼容性既没被强制、也没被上报**。用户只能看到"连上了但界面怪怪的"。

**做法**：`probe_device` 读取 `GET /api/auth/status`，返回

```json
{ "deviceId": "...", "status": 200, "productVersion": "0.1.116",
  "requiresPassword": true, "authenticated": false }
```

设备管理面板据此显示 `v<version> · 免密|需登录`。这也是未来加"版本不匹配横幅"的数据来源。

### A4. 设备持久化复用 `client_settings`（无 schema 迁移）

**问题**：新增 SQLite 表意味着在 `storage.rs` 已有的 `PRAGMA user_version = 1` + `VACUUM` 迁移机制上再加一步，风险与收益不成比例。

**做法**：
- `device.<id>.endpoint` —— 每个设备的端点
- `device.active` —— 活动设备 id

新增的存储原语只有两个：`delete_setting()` 与 `setting_keys_with_prefix()`（后者对 `%` / `_` / `\` 做了转义，并使用 `LIKE ?1 ESCAPE '\'`——设备 id 允许下划线，所以这不是理论问题）。

`client_bootstrap` 通过 `setting_keys_with_prefix("device.")` 枚举所有已存设备，剥掉前后缀还原 id 后 `restore()` 进注册表。

### A5. `cancel_download` 改为广播

**问题**：前端从进度通道拿到的 `requestId` 是不透明的，它并不知道这个下载属于哪个设备。

**做法**：`cancel_download` 从同步无返回改为 `async -> Result<(), String>`，向**所有**设备广播；每个设备用自己的下载登记表过滤，不匹配的自然忽略。这比在每个进度事件里穿一个 `device_id` 更简单，也完全正确。

### A6. 设备管理面板 `device-manager.js` / `.css`

独立浮层，追加启动按钮到 `.sidebar-footer`，暴露 `globalThis.MeTricDevices`。

- 列表：id、`host:port`、探测结果、当前标记
- 操作：切换 / 探测 / 移除
- 切换后 `location.reload()`——共享核心缓存了 target，重载是保证所有视图一致的最诚实做法
- 移除时先按 id 读端点、删设置、移出注册表，再**按端点**删密码行（密码表的键是端点不是 id，顺序不能反）
- 纯浏览器环境（无 `__TAURI__`）静默退出

### A7. Agent 检视面板 `agent-inspector.js` / `.css`

**这是"更详细的 agent 状态信息"的落点。**

`ui_backend.rs::tool_chat_presentation()` 会把 `CHAT_HIDDEN_TOOL_NAMES` / `CHAT_HIDDEN_TOOL_PREFIXES` 里的工具标记为 `Hidden`，`ui_projection.rs` 随之把对应 `ToolCall` 从 `UiPartProjection` 里整条丢弃。**投影层面无法恢复这些信息。**

因此本面板绕过投影，直接读 `/api/events/:agent?after=&mutation=` 的原始 `Event` 流：

- 自带每个 agent 的游标（`count` / `mutation`），与 `app.js` 状态完全隔离
- 服务端返回 `reset` 时整段替换缓存
- 上限：400 行、单条 body 4,000 字符
- 概览字段：标识 / 标题 / 类型 / 父会话 / 编排模式 / EDB / 事件数 / mutation / prompt rev / 输入草稿 rev / API 状态 / 当前轮 / 模型 / 推理强度 / Token 用量 / 上下文 / 上下文分项 / 压缩中 / WorkMap
- `仅内部工具` 复选框只筛出被投影隐藏的事件
- agent 列表从 DOM 只读抓取（`#agent-list [data-agent-row]` + `.active` / `aria-current`），因为 `app.js` 的 `state` 没有导出

### A8. `build-frontend.js` 结构化断言

从 3 条弱断言升级为 7 条表驱动断言 + 产物文件数下限：

1. HTML 确实变了（锚点未失效）
2. `/runtime.js` 存在
3. `login-endpoint` 存在
4. **`/transport.js` 必须不存在**（安全相关：桌面端加密在 Rust，wasm 传输层不得随包）
5. `/device-manager.js` 已注册
6. `/agent-inspector.js` 已注册
7. `/client.css` 已注册

任一失败抛 `me-tric frontend assembly failed: <原因>`。

> 实测这条断言确实拦下过一次真实缺陷：`index.html` 在 Windows 上是 CRLF，而删除 transport 的 `replace` 用了 `\n` 锚点，静默失效。现在改成 `/[ \t]*<script src="\/transport\.js"><\/script>\r?\n/`。

### A9. 测试套件本地化

上游 `tests/me_client.test.js` 混了两类关注点：(a) 客户端行为断言，(b) 只在 me-s 单体仓库里成立的发布打包断言。me-tric 只保留 (a)，并把 (b) 换成一条轻量的本仓版本一致性测试。

同时修复：测试顶部把 `readFileSync` 包一层统一 `\r\n` → `\n`。上游套件在同一台 Windows 机器上跑会因 CRLF 有 3 个失败；归一化后 me-tric 的 16 项测试全绿。

### A10. 独立命名与标识

`me-tric` / `me_tric_lib` / `ME Tric` / `studio.me-tric.desktop` / `me-tric.sqlite3` / `ME_TRIC_*` / `newMeTricWindow:` —— 全部重写，路径依赖修正为 `../../transport` 与 `../../vendor/tauri-runtime-wry`。旧数据目录**不迁移**。

### A11. 工具卡片的修改 diff（`tool-diff.js` / `.css`）

**问题**：共享核心把文件编辑渲染为"修改 N 的新内容"——只有新文本，没有旧文本，看不出改了什么。这不是渲染遗漏，而是**数据在服务端就不存在**：`File.Edit` 的结果只回行数（`selected_lines` / `new_line_count` / `replacement_bytes`）与 `previous_hash`，`default_file_toolbox.py` 刻意不给原文。

**做法**：`client/tool-diff.js` 在 `tool-presenters.js` 之后、`app.js` 之前加载，**替换**（而不是修改）`globalThis.MeToolPresenters`，包裹 `describe` / `renderDetails` / `imageAttachments`：

- `imageAttachments()` 是所有工具卡片都会经过的唯一出口，借此缓存 `File.Read` 的结果（`lines` 映射 + 内容 hash + `total_lines`）。
- `summarize()` / `describe()` 顺带缓存 `File.Create` / `File.Replace` 的 `content`（整文件写入）。
- `describe()` 命中 `File.Edit` / `File.EditBytes` / `File.Create` / `File.Replace` / `File.Append` 时，在 `details` 上挂一个 `diff` 模型，供卡片渲染取用。

**为什么旧文本可信**：服务端拒绝“未经 `File.Read` 就编辑”的调用（`read_required` / `stale_read` / `unread_range`），并在写入前校验内容 hash。因此读取必然紧邻编辑之前，且其 hash 等于编辑的 `previous_hash`。**只有 hash 完全匹配才复用该文本**——不匹配时删除侧只显示真实行号加“原内容未记录”占位符，绝不编造内容。整文件写入无法在客户端同步算 sha256，退化为“同路径 + 同行数”的推断匹配，并在提示里**明说这是推断**。

**降级行为**：编辑进行中、失败、或结果缺失时不产生任何 diff，卡片与上游逐字节一致（有测试断言）。行数上限 400 行，超出显示截断提示。

**diff 不需要展开就能看到**：共享核心只为“展开集合”里的卡片渲染详情（`toolCardView` 返回 `details: expanded ? describe(...) : null`），而这个集合 `state.expandedTools` 是 `app.js` 模块作用域的 `Set`，没有导出、没有钩子，外部无法写入。更关键的是：**折叠卡片只调 `summarize(name, args)`，拿不到 output**，所以即使注入状态也生不出 diff。

因此改法是**不碰展开状态**，而是把 diff 放到头部下方、`.tool-details` **之外**，并包住两个顶层卡片构建器：

- `createMessageNode`（首次渲染）与 `updateToolCardNode`（结果后到、卡片被重写）拿到构建完成的卡片节点后，插入一个 `.tool-diff-inline`，位置是 `.tool-header` 之后。
- 这两个函数在本模块加载时**还不存在**（`app.js` 尚未执行），所以在 `DOMContentLoaded` / `load` 时重试安装；模块底部也先试一次（`app.js` 先加载时立即生效）。
- 插入前比对上一次写入的 HTML（`WeakMap`），避免正在跑的工具卡片每帧重建 diff；`click` 事件被`stopPropagation`，点 diff 不会收起卡片（与 `.tool-details` 一致）。
- 因为 diff 不在详情里，`.tool-details` 的 HTML 与上游**逐字节相同**（有测试断言），同一个 hunk 不会印两遍。

被否掉的替代方案：驱动 `state.expandedTools`——那需要修改 `app.js`，违反 `frontend/` 只读约束。

**为什么不读 `/api/events` 回填**：`gateway.rs::validate_proxy_path` 不转发该路径，经 Gateway 连接时不可达；做成 best-effort 会让同一功能在两种部署下表现不一致，不如统一只依赖已渲染的卡片内容。

**构建约束**：`build-frontend.js` 新增两条断言——`tool-diff.js` 必须晚于 `tool-presenters.js`（否则没有可包裹的注册表）且早于 `app.js`（否则核心已捕获旧引用）。

### A12. 输入框粘贴图片（`paste-image.js` / `.css`）

**需求**：对话输入框可以直接粘贴剪贴板里的图片，缩略图堆叠在输入框**左侧**并带 `上传中 → 已上传 / 失败` 状态；发送时只把图片路径交给 agent。

**约束（已验证，不是推测）**：

1. 用户提示词只有文本：`submit_user_prompt(agent_id, content: String)` → `UserPromptEvent { content }`，模型看到的是 `<user_prompt>` 里的 XML 转义文本。所以**没有给提示词挂图的通道**。
2. 图片内容只能由工具产生：`EventDataBase::append_image_content` 硬校验 `crate::image_toolbox::stores_image_content(&call.name)`，只放行 `Image.View` / `Image.Send` / `WebBrowser.Snapshot`。
3. `Image.View` 读本地文件：`data:` / `http(s)://` / `file:` / 绝对路径 / **相对路径按 `workspace.join(path)` 解析**，上限 60 MiB。
4. 工作区在服务端，客户端**没有写文件的命令**（`invoke_handler` 只有窗口、设备、`gateway_request`、下载）。远程 Gateway 部署时客户端磁盘也不是服务端磁盘。
5. 剪贴板图片不需要 Tauri 插件：`paste` 事件的 `clipboardData.items` 里 `kind === "file" && type.startsWith("image/")` 直接 `getAsFile()` 就能拿到 Blob。

**做法**：上传到 `workspace/.me/attachments/`，再把相对路径写进提示词（每张图一行 `[图片] <相对路径>`），由 agent 自己决定要不要 `Image.View`——不发任何指令句。

上传走服务端自己的文件 API（三步，全部在 Gateway 白名单 `files/*` 内）：

1. `POST /api/files/list` `{path: null, roots: false}` → 返回的 `path` 就是 workspace 绝对路径（`host_files.rs:243-246` 空 path 解析为 `self.workspace`）。这是唯一可靠的来源。
2. `POST /api/files/mkdir` `{parent, name}` 建 `.me` 再建 `.me/attachments`。服务端用的是非递归 `fs::create_dir`，目录已存在会报错，所以“已存在”按正常情况处理（失败后 `files/list` 找回该目录）。
3. `POST /api/files/uploads/create` → 循环 `uploads/chunk`（384 KiB 一片，服务端上限 512 KiB）→ `uploads/finish`，校验 `state === "completed"`，失败则 `uploads/cancel`。

几个具体取舍：

- **`conflict_policy: "keep_both"`**：不给策略会返回 `requires_confirmation` 且 `upload: null`（死路）；`skip` 直接丢弃。文件名带时间戳 + 随机后缀，正常情况下不会碰撞。
- **相对化路径**：从 `target_path` 减去 workspace 绝对路径，因为 `Image.View` 是按 workspace 解析相对路径的；不在 workspace 内则保留绝对路径（宁可长也不指向错文件）。
- **空输入框也要能发图**：`app.js::submitOrOpenSendSettings()` 在输入框为空时打开“发送设置”抽屉而不是提交，所以发送前把路径行填进 `#prompt-input`（并派发 `input` 事件，让草稿同步跟上）。
- **只清空已接受的提交**：`fetch` 拦截器看响应是否被接受，被拒时保留缩略图供重试；上传中/失败（无 `path`）的缩略图永远不进提示词。
- **不重复写路径**：同一路径在文本里已存在则不再追加，因为一次提交可能经过“预填”与“请求体重写”两道。

**接入点**：替换 `globalThis.MeFrontendRuntime`（`Object.create` 出的原型子对象，只覆写 `fetch`），因此其余 getter / 方法全部保留（有测试断言）。必须**早于 `app.js` 加载**：核心在加载时就把这个全局存进模块作用域，之后再换无效——这与 `tool-diff.js` 的“运行时解析”不同，装配脚本因此各自断言顺序。

**DOM**：缩略图容器插在 `.prompt-input-stack` **之前**，给 `.composer-shell` 加一个类切成两列网格（`auto minmax(0,1fr)`），动作行跨两列；堆叠用负 `margin-left` + 递增 `z-index` + hover 抬升。`frontend/` 一行未改。

被否掉的方案：给 `UserPrompt` 加图片字段（需要改服务端协议、事件校验和上下文投影，违反 C1）；前端直接写本地文件（`fetch` 被拦截成 `gateway_request`，且无原生写文件命令）；本地写文件后传绝对路径（工作区在服务端）；把 `data:` URL 写进提示词（会被 XML 转义，且几十 MB base64 进上下文不可接受）；加 Tauri 剪贴板插件（`paste` 事件已经够用）。

**已接受的残留风险**：

- 缩略图只存在内存里，刷新后不保留（避免与草稿 revision 协议缠斗；已上传的文件仍在服务端）。
- 非多模态模型会拒绝 `Image.View`，而客户端**在发送前无法知道**模型是否支持图片——这一点没有任何本地信号可查。拒绝只会以工具错误的形式出现在对话里，缩略图不会预警。
- 本项只能在 bun 测试与装配脚本里验证；缩略图的实际排版、堆叠与滚动未经真实窗口实测。

### A13. 右侧调试侧边栏（`debug-panel.js` / `.css`）

**需求**：底部状态栏已展示模型名、推理强度与 SSE 计数，但看不到实际在发生什么。需要一个可展开/收起的右侧调试侧边栏，展示：接收到的流式数据、token 输出速度、上下文占用明细，以及补充的其他调试信息。

**数据来源（已核实）**：`app.js` 的 `state` 全在模块作用域且无导出，但 `/api/sync` 的响应体里就有全部原料，所以模块再包一层 `MeFrontendRuntime.fetch`，`clone()` 出响应体读 JSON：

| 字段 | 内容 |
| --- | --- |
| `projection_states[].range.projections[]` | assistant 流式 `content`、`tool`（含 `started` / `result.finished`）、turn-toolbar |
| `projection_states[].context` | `total` + `values{system,compact,memory,user,model,tool}` |
| `projection_states[].api_state / api_usage / model / effort / turn_state` | 概览行 |
| `projection_states[].revision / count / last_event_id / changed_from / source_event_count` | 事件与游标 |
| `api_activity {active, received_sse_events}` | 本轮 SSE |
| `snapshot.agents[].edb_size_bytes` | EDB 体积 |

**面板分区**：概览 / 输出速度 / 流式数据文本框 / 上下文占用 / 工具调用 / 事件与游标。头部有暂停、清空、收起；展开按钮在侧边栏底部的设置/主题那一行，展开状态存 localStorage。

**只跟踪当前会话（修复）**：`app.js` 同时跑两类同步——前台轮询（选中会话，带 `range`）与后台轮询（`backgroundSyncRequestBody`，其他工作区/其他会话）。两者都打 `/api/sync`，所以初版把后台响应也当成当前会话渲染了，且 `selectedState` 会 fallback 到 `states[0]`。修正后：

- 当前会话从侧边栏 DOM 读取（`.agent-row.active` 的 `data-agent-row` → `dataset.agentRow`），因为 `state.selectedAgent` 不可导出；
- 只接受 `selected_agent` 与侧边栏一致、且 `projection_states[].range` 存在的响应。服务端只为选中会话附 `range`（`webui.rs:0441-0445` 只对 `selected_agent` 传 `projection_window`），所以它的缺失就是后台轮询的铁证；
- 会话切换时重置采样窗口、计数与渲染签名。

**空闲时不跳动（修复）**：即使无对话在工作，轮询仍每秒到达并推进游标，初版把每次必然变化的字段直接渲染了。修正后：

- 只有 `api_activity.active`、turn_state 为 active/aborting、或 assistant 文本增长才算“活动”；
- `响应体积` / `采样次数` / `响应时间` 只在活动时推进，空闲时停在最后一次活动值；
- `render()` 用 JSON 签名去重，签名不变直接 return，不写 DOM。

**实测与估算的界线（这是本项最重要的诚实约束）**：

| 指标 | 性质 |
| --- | --- |
| SSE 事件数、响应体积、上下文分项、工具耗时、字符/秒 | 实测 |
| tok/s | **估算**：字符数 ÷ 4 |
| 服务端用量（`api_usage`） | 实测，但只在 API 完成后才存在 |

**为什么不能实测 token/s**：`ui_projection.rs` 里 `api_usage` 仅在 `ApiState::Completed` 与 `Interrupted` 两个分支被赋值（:0868、:0888），`ModelChanged` 与压缩完成时还会置 `None`。流式过程中它恒为 `null`。同理 `received_sse_events` 在每次 API 调用开始时清零（orchestrator.rs `ApiActivity::begin`），所以它是“本轮”而不是“累计”。面板对两者都按真实语义措辞，不把估算包装成实测。

**速率恒为零（修复）**：用户反馈“右边栏的输出速度相关数据一直是零”。实测复现后确认是两个缺陷叠加：

1. **采样窗口绑在了 assistant 部件身份上。** 服务端的 `key` 是 `assistant:{prompt_id}:{response.id}`，只在部件创建时生成（`ui_projection.rs:0836`），之后流式分块只更新 `content` / `revision`，所以它在单个部件内确实稳定。但**一轮会发多次 API 调用**（每个工具轮次一次），每次都 `append` 一个**新的** assistant 部件、带**新的** `key`。按部件身份计数时，每个工具边界都会把窗口重置成单元素，而单元素永远算不出速率。编码回合里工具轮次占大头，于是速率基本一直是 `null`。
2. **无文本的轮询会把窗口清空。** `nextRate(null, …)` 直接返回 `samples: []`；只要窗口尾部暂时没有 assistant 部件（只剩工具，或本轮还没出字），之前攒的样本就全丢了。

修正后速率以**整轮**为窗口：从最新的 `user` 部件之后累加所有 assistant 文本长度，工具边界不会重置它；无 assistant 文本的轮询**保留**已有窗口（`grown: 0`）而不是清空；只有用户发新消息（新轮）或文本变短（窗口滚动/部件被替换，旧样本描述的是另一段后缀）才重新起算。

同时修掉两个让读数看起来“死”的问题：

- 亚 1 字符/秒的速率被 `Math.round` 归零，显示成“0 字符/秒”。现在小于 10 的值保留一位小数（`formatRate`）。
- 速度区块新增“采样点”行，且空闲（非活动）时不再显示“采样中…”，改为“—”，避免整块读数看起来像还没工作。

顺带修掉一个潜伏缺陷：`selectedAgentId()` 读的是 `row.dataset.agentId`，但 `app.js::createAgentRow` 发出的是 `data-agent-row`（即 `dataset.agentRow`），所以生产环境恒返回 `null`，“侧边栏优先”这条规则实际是死的（行为上只是退回 `trackedAgentId` 分支，所以一直没暴露）。测试里的 mock 也用了错的字段名，因此没抓住它。

**流式框为空（修复）**：用户反馈“窗口底部的 AI 思考或回复长度增长时，右边栏的流式数据还是空的”。三个独立原因，前一个是服务端限制，后两个是客户端缺陷：

1. **思考文本根本到不了前端（服务端限制，客户端无法修复）。** 底部状态栏的 `↓ N` 是 `api_activity.received_sse_events`——服务端每收到一个 SSE 事件就 `fetch_add(1)`，**包含推理分块**，所以思考阶段它在涨。但 `model.rs::openai_stream_event` 只解析 `/choices/0/delta/content`（`:0403-0406`），完全不读 `reasoning_content` / `reasoning` / `thinking`；只有推理增量的分块在 `:0430-0431` 被归为 `OpenAiStreamEvent::Other` 后**直接丢弃**。`orchestrator.rs:02261` 也只写 `chunk.content`，`UiPartProjection::Assistant`（`ui_projection.rs:0239-0245`）根本没有 reasoning 字段。所以面板无法显示不存在的数据——这不是面板的问题。
2. **投影窗口滑动被误判成换轮。** `app.js` 发 `projection_window`，服务端只返回尾部（最近 64 条）或变更后缀（`ui_projection.rs:0074-0114`），所以 `user` 部件会在同一轮中途滑出窗口。上一版用 `user` 部件的 `key` 做轮次标识，滑出后标识变成空串，与之前不同 → 视为新轮 → 采样窗口重置。现在 `currentTurn` 在无 `user` 部件时返回 `turn: null`，`nextRate` 把 `null` 理解为“窗口滑动，仍是同一轮”，只有两个**非 null** 且不同的标识才算换轮。
3. **流式框被整段清空。** 文本取自当前窗口内的 assistant 文本，窗口尾部变成工具部件时就是空串，于是框被清空——这直接造成了“底部在涨、右边框是空的”的观感。现在窗口内无 assistant 文本且未真正换轮时**保留上一段文本**，与采样窗口的保留策略一致。

另外，空框现在会说明原因：`api_state` 为 `Streaming` / `Requesting` 时显示“暂无可见文本：正在思考或等待首个内容增量（服务端只转发 delta.content，推理文本不入投影）”，否则显示“暂无可见文本”。同时修掉了 `render()` 调用 `renderStream()` 漏传 `state` 的问题（否则提示永远不会出现）。

**结论：想要看到思考文本，必须在服务端 `model.rs` 里解析并转发 reasoning 字段，并给 `UiPartProjection::Assistant` 加对应字段——这超出 me-tric 的范围（me-tric 不修改 me-s 服务端）。** 面板只能如实说明“没有可见文本”，不能凭空造出它。

**几个实现细节**：

- 速率按“同一轮”比较：新一轮从零开始，不把上一轮长度当成突发；文本变短时重新起算而不是给出负数。
- 只采样 `/api/sync`：注意 `app.js` 先调 `apiPath()` 把它改写成 `/api/workspaces/<id>/sync`，正则必须同时匹配两种形式——否则在生产环境下会静默永不采样（实现时正是这个 bug，测试才抳住）。
- 未完成的工具不给耗时，显示“进行中”，不编造数字。
- 面板展开时给 `.workspace` 加右内边距而不是盖住对话；窗口窄于 1000px 时改为覆盖式。
- 状态栏的 `⇣ 12.3 KB · 42 SSE` 是本模块自己插入的 span，因为 `frontend/` 只读。
- 按钮带 `theme-control` 类并 append 进 `.sidebar-appearance`：窄屏（<620px）下 `.sidebar-settings` 被 `display:none` 而该容器保留，所以按钮始终可见；`setOpen` 会检测侧边栏被重建后重新挂载。
- 与 `paste-image.js` 共存：两者都用 `Object.create` 链式包裹，各覆写 `fetch` 并委派给上一层。

**已接受的残留风险**：

- 采样依赖轮询频率（活跃时 250 ms、空闲时 1000 ms），所以“字符/秒”的采样粒度也受此限制，不是逐 token 精确。
- **思考（reasoning）内容在服务端就被丢弃，面板永远看不到。** 这是 me-s `model.rs` 的设计，不是本项目的缺陷；面板只能提示“推理文本不入投影”。
- 侧边栏的排版、滚动与展开动画未经真实窗口实测，只能在 bun 测试里验证纯函数与响应解析。
- 面板数据不持久化，刷新后从空开始（包括采样次数与速率窗口）。
- 当前会话依赖侧边栏 `.agent-row.active` 这个 DOM 结构；如果上游改了行标记，面板会退化为“无选中会话”（不采样），而不是默默展示错会话。

### A14. 窗口造型与拖动的四处修正（`client.css` / `client-runtime.js` / `debug-panel.css`）

窗口是 `transparent: true` + `decorations: false`（`tauri.conf.json`），所有圆角、阴影与边框都由 CSS 自绘，原生 `WM_NCHITTEST` 只负责缩放边框与圆角命中（`lib.rs` 的 `windows_main_hit_test`）。四个用户可见问题及其成因：

**1. 左边直角、右边圆角。** `body` 有 `border-radius`，但 **CSS 的 `border-radius` 不会裁剪子元素**（只有配合 `overflow: hidden` 才裁）。`#app` 是 `position: absolute; inset: 0` 且带 `background: var(--bg)`，设备栏（`position: fixed; left: 0`）与侧边栏各自也是不透明背景，这些直角矩形直接画在窗口圆角之外。右侧因为对话区有留白，反而看得到圆角。

修法：让每个“贴到窗口边缘的面”自己持有对应的圆角——`#app` 整体加圆角并 `overflow: hidden`；`.sidebar` 与 `.me-tric-device-rail` 取左侧上下角；`.workspace` 与右侧固定的调试面板取右侧上下角。设备栏存在时 `#app` 已经不贴左边缘，因此用 `html.me-tric.me-tric-has-device-rail #app` 去掉它的左圆角，否则设备栏与 `#app` 之间会出现一个缺口。

**2. 顶部拖动区域难用。** 拖动依赖 Tauri 的 `data-tauri-drag-region`，而 **这个属性只对携带它的元素自身的命中区域生效，不会传递给子元素**。原来的标记落在 `.workspace-heading`、`.view-tabs` 外层等容器上，它们内部全是 `<span>` 和按钮，所以只有元素之间的缝隙能拖。覆盖整条 38px 顶部的 `.client-titlebar` 又是 `pointer-events: none`，根本不接收事件。原生侧也不提供 `HTCAPTION`，所以没有后备路径。

修法：改为 `mousedown` 事件委托（捕获阶段），只要 `clientY` 落在 `--client-chrome-height` 内、且目标不在豁免清单（`button` / `a[href]` / `input` / `select` / `textarea` / `label` / `[contenteditable]` / `[role=button]` / `[role=tab]` / 窗口控制组 / agent 行 / 设备栏 / 调试按钮）内，就 `preventDefault()` 并调用 `plugin:window|start_dragging`（权限 `core:window:allow-start-dragging` 已在 `capabilities/default.json`）。**不插入任何覆盖层**，所以不会有控件被遮住——这是先用覆盖层方案试过后放弃的原因：`.view-tabs` 与 `.sidebar-heading` 都没有独立层叠上下文，任何高 `z-index` 的覆盖层都会吃掉它们的点击。

**3. 设置遮罩不覆盖设备栏。** `.modal-backdrop` 上游是 `z-index: 50`，设备栏是 `900`，所以遮罩压在设备栏下面：设置打开时设备栏仍然亮着且可点。修法：`html.me-tric .modal-backdrop { z-index: 950 }`，同时把抽屉提到 `960`，保持上游 modal(50) < drawer(65) 的相对顺序。

**4. 模型/上下文弹层不居中。** 两者都是 `.drawer-backdrop` + `.choice-drawer`，上游把它们设计成**底部抽屉**：`align-items: flex-end`、`border-radius: 16px 16px 0 0`、`border-bottom: 0`。所以在屏幕靠下是设计行为，不是 bug。修法：在 me-tric 样式里把这两个 `#id` 的 `align-items` / `justify-content` 改成居中，并把抽屉造型改回四角 16px 的对话框（完整边框、`max-height: min(680px, calc(100dvh - 40px))`）。选择器带 `#id` 是必要的：`frontend/style.css` 在 `@media (max-height: 520px)` 里又设了一次 `align-items: end`。

**已接受的残留风险**：

- 四处修改都只能在 bun 测试里验证 CSS/JS 文本与断言；圆角观感、拖动手感、遮罩覆盖与弹层居中都需要在真实 Tauri 窗口里肉眼确认，本环境无法渲染 WebView。
- 拖动豁免依赖一份选择器清单。若上游新增了带自定义指针交互的控件且不是 button/a/input 类，它会被当成空白区而触发拖窗。
- 若未来 `frontend/` 把这两个弹层改成居中，上面的覆盖规则会变成冗余（但不影响正确性）。



---

## B. 计划中（按建议顺序）

### B1. 凭据迁移到操作系统钥匙串

**现状**：`remembered_devices.password` 明文存在 SQLite 里。这是上游行为，me-tric 未改动。

**建议**：Windows Credential Manager / macOS Keychain / libsecret。以端点为 key，数据库里只留一个引用标记。迁移时保留"从明文平滑升级"的一次性路径。

**优先级**：最高。这是本项目里唯一真正意义上的安全债。

### B2. 每设备轮询调度器

**现状**：`app.js` 的 sync 是自调度的 HTTP 长轮询（`HTTP_SYNC_ACTIVE_MS = 250`、`HTTP_SYNC_IDLE_MS = 1000`、超时 15 s），只针对"当前 target"。切到多设备后，如果一个视图同时看 N 个设备，请求量会线性乘 N。

**建议**：在 `DeviceRegistry` 之上加一层调度器：
- 活动设备保持高频（沿用现有常量）
- 非活动设备降频到 `BACKGROUND_SYNC_IDLE_MS`（5 s）或更低，或干脆只在面板可见时轮询
- 每设备独立的 `syncInFlight` + `syncGeneration` + `AbortController`（共享核心已有这套结构，可参照）

### B3. Agent 树（基于 `parent_agent_id`）

**现状**：检视面板把 `parent_agent_id` 当普通字段显示。

**待确认**：`GET /api/snapshot` 的 `visible_agent_ids()` 是否包含子 agent。如果只返回顶层会话，那么子 agent 根本拿不到 id，建树就无从谈起——需要先确认再设计。

**建议**：确认可用后，在面板里用 `parent_agent_id` 组织成树，父子折叠；顶部显示编排模式（orchestration mode）。

### B4. 版本不匹配横幅

**现状**：`probe_device` 已经返回 `productVersion`，但面板只做展示，没有判定。

**建议**：维护一个已知兼容区间，命中不兼容时在面板顶部和主界面显示醒目横幅，而不是让用户面对"连上了但行为异常"。

### B5. 图标与视觉标识

`client/src-tauri/icons/*` 仍是上游 ME 的图标，而 `productName` 与 `app-icon.svg` 已经叫 ME Tric。需要一套新图标（含 Windows `.ico` 多尺寸、macOS `.icns`、iOS AppIcon）。

### B6. Rust 侧编译与测试验证 —— **已完成**

**状态**：已用 rustc 1.99.1 / cargo 1.99.1 (x86_64-pc-windows-msvc) 完整验证通过。

| 命令 | 结果 |
| --- | --- |
| `cargo check` | 通过（依赖树首次编译后，增量 4.55s） |
| `cargo test` | **14 passed, 0 failed**（3.23s，14 个测试逐项 ok） |
| `cargo build` | 通过，`target\debug\me-tric.exe` 23,853,568 字节 |
| `me-tric version` | 输出 `me-tric 0.1.0`，exit 0 |
| `cargo check --locked` | 通过（`Cargo.lock` 与 `Cargo.toml` 一致） |

**编译阶段修复的 3 个真实缺陷**（均为本次手写遗留，静态审阅未能发现）：

1. `lib.rs:42-43` —— `const DEVICE_PREFERENCE_KEYS: [&str; 4] = [` 这行被写了两遍，重复的开括号导致 `mismatched closing delimiter`。
2. `lib.rs:96` —— `ConfiguredTarget` 结构已在第 95 行正确闭合，第 96 行多出一个孤立的 `}`。
3. `devices.rs:128` —— `E0382: borrow of moved value: id`。`.map(|t| (id, t)).ok_or_else(|| format!("设备 {id} 未连接"))` 中 `id` 先被 move 进闭包、又借用于错误信息。改为 `match`，让 `id` 只在 `Some` 分支移动。

**唯一遗留 warning**：`transport/src/lib.rs:176` 使用了已 deprecated 的 `Atomic::<u32>::fetch_update`（上游代码，非本项目引入）。

**关于 MSVC**：本机没有 MSVC Build Tools + Windows SDK，但纯 Rust 依赖不需要——rustc 1.99 默认用自带的 `rust-lld` 链接。若将来引入需要 C/C++ 编译器构建的 crate（部分 `-sys` 包），则必须补装 MSVC。

**仍未做的事**：`#[tauri::command]` 的参数形状（`device_id: Option<String>`）通过编译了，但**与前端实际 IPC payload 的运行时匹配**仍需真机启动验证 —— 编译期无法覆盖这一点。

### B7. 首次人工运行的两个待确认假设

1. **`.active` 类名**：检视面板用 `.active` / `aria-current` 判断当前选中 agent。若 `app.js` 用的是别的类名，面板会退化为"第一个 agent"——行为错误但不崩溃。
2. **`me-tric*` CSS 钩子**：`client.css` 里的 `me-client*` 选择器是一次性批量替换成 `me-tric*` 的，漏改只会掉样式，不会报错。

### B8. 面板可访问性

两个面板都是 `position: fixed` 浮层 + `Escape` 关闭。缺少：焦点陷阱、打开时焦点转移、`aria-expanded` 同步、返回焦点到启动按钮。

---

## C. 明确不做（在当前约束下）

### C1. 服务端新端点

SSE 推送、设备配对、工具级取消——这些都需要改 me-s 服务端。**没有明确指示前不开工。**

理由：一旦改服务端，"扩展一个客户端"就变成"维护一个 me-s fork"，每次上游更新都要在三个白名单/路由文件上 rebase：

| 文件 | 需要同步的内容 |
| --- | --- |
| `src/webui.rs` | `operational_route()` 路由表 |
| `src/gateway.rs` | `validate_proxy_path()` 转发白名单 |
| `src/gateway_webui/runtime.js` | `scopedApiPath` 路径重写表 |

**客户端的能力上限就是服务端的路由表**——客户端无法凭空发明端点。

### C2. 编辑 `frontend/app.js`

一旦改动就失去从 me-s 同步更新的能力，同时违反"不改变 UI 技术栈"。所有客户端差异必须走 `MeFrontendRuntime` 钩子或独立脚本。

### C3. 跨设备共享 `Transport`

会直接破坏 Noise 会话、cookie jar 和请求号计数器。

### C4. 为设备新增 SQLite 表

会迫使在现有 `user_version = 1` + `VACUUM` 迁移机制上再加一步。`client_settings` 足够。

### C5. 从上游移植 me-s 专属资产

`build.sh`、`release.sh`、`packaging/*`、`install.sh`、`install.ps1`、`src/updater.rs`、`scripts/product-version.cjs` —— 这些属于 me-s 单体仓库的发布流水线，不是客户端的一部分。

---

## D. 附：踩过的坑

供后续维护参考，避免重复。

| 坑 | 说明 |
| --- | --- |
| CRLF vs LF | 仓库在 Windows 上以 CRLF 检出。测试断言与 `build-frontend.js` 的字符串锚点若写死 `\n` 会静默失效。**断言里涉及多行的，一律用正则 + `\r?\n`，或先归一化。** |
| `Set-Content -Encoding UTF8`（PowerShell 5.1） | 会写入 UTF-8 BOM。仓库约定无 BOM。批量文本替换后必须用 `[System.IO.File]::WriteAllBytes` 再清一遍。 |
| 对象字面量重复键 | `client-runtime.js` 一度同时存在 `configureTarget(value)` 和 `configureTarget(value, deviceId)`，后者被前者覆盖且**不报错**（JS 允许重复键，后者胜出但这里是前者的位置在后面）。加方法后务必 `node --check` 并肉眼核对该对象。 |
| `gateway_request` 会整体缓冲 body | 大文件必须走 `download_file` 的流式通道。 |
| Tauri IPC 只有 JSON | 二进制一律 base64。 |
| `#[tokio::test]` 不可用 | `tokio` 的 features 只有 `fs`/`io-util`/`macros`/`rt-multi-thread`/`sync`，`macros` 覆盖的是 `select!` / `main`，不含测试宏。`devices.rs` 因此只保留纯函数单元测试。 |
| `Transport::endpoint()` 是 `async fn` | 没有 `endpoint_blocking()`。`status()` 需要先快照 `(id, transport)` 再逐个 `await`，不能持锁 await。 |
| DevTools 关闭 | `tauri.conf.json` 里 `devtools: false`，调试面板要么改配置要么用 `console` + `tauri-plugin-log`。 |
