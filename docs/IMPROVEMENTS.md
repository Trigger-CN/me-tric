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
