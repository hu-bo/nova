# 基于 DeepSeek Harness 的 Greenfield Web、Server 与 Remote Runner 架构方案

> 状态：架构分析与部署方案
>
> 项目性质：全新项目，不集成 Nova、不以兼容 Nova 为目标、不复用 Nova 代码；DSH 官方／社区插件兼容是独立的产品目标
>
> 参考边界：只参考 Nova 已验证的产品体验与控制面／执行面分离思想
>
> 评估基线：本地 `deepseek-harness-master`，版本 `0.1.1-rc.2`
>
> 目标体验：用户访问类似 `https://nova.8and1.cn/` 的公网 Web 站点，在任意服务器、macOS 或 Windows 机器连接自己的 workspace，并通过浏览器聊天驱动远程代码任务

## 1. 执行结论

该 Greenfield 方案可行。正确实现不是把 DeepSeek Harness（下文简称 DSH）现有 Web GUI 直接暴露到公网，也不是把整个 DSH 进程下发到开发机器，而是把系统明确拆成三层：

1. 自研 Web UI 部署在公网服务器，负责登录、项目、Runner 选择、会话和事件展示；
2. 自研 Control Server 部署在服务器，在进程内组装 DSH，持有 Agent 生命周期、模型调用、会话持久化和产品控制面；
3. 自研 Remote Runner 安装在服务器、macOS 或 Windows 开发机，只执行文件与进程操作，通过主动发起的持久双向 gRPC 连接接收请求。

一句话概括核心边界：**云端 Control Server 调度 DSH 核心能力，Remote Runner 只负责操作目标 OS 上的文件、进程和工作区；DSH 通过新项目内部 `packages/` 中的集成包接入，保持上游零修改和公开契约依赖，以较低成本跟随官方仓库升级，并在底层兼容官方与合规的社区 Cordis 插件。**

推荐链路是：

```text
Browser
  │ HTTPS: REST + SSE
  ▼
Control Server
  │ in-process public DSH APIs
  ▼
DeepSeek Harness Agent
  │ tool call: fs / shell
  ▼
Remote FS / Shell Provider
  │ outbound bidirectional gRPC stream
  ▼
Remote Runner on Linux / macOS / Windows
  │
  ▼
real workspace / process / operating system
```

用户 query 不应被原样“派发给 Runner”。Control Server 先把 query 交给 DSH Agent；DSH 决定是否需要工具。只有模型产生文件读取、文件修改或 Shell 调用时，Remote Provider 才把结构化操作通过 gRPC 发给 Runner。Runner 不认识 User、Conversation、Prompt、Agent 或 DSH 类型，也不决定下一步做什么。

### 1.1 关键选型

| 问题 | 决策 |
|---|---|
| Agent Loop 放在哪里 | Control Server 内，由 DSH 运行 |
| Web UI 用什么 | 全新产品 UI，不使用 DSH Web 前端 |
| 产品 Server 用什么 | 全新 Control Server，通过 `ctx.agents` 驱动 DSH |
| workspace 放在哪里 | 只在 Remote Runner 所在机器 |
| Server 是否挂载用户代码目录 | 不挂载，也不提供本地执行 fallback |
| Server 与 Runner 如何通信 | Runner 主动建立出站双向 gRPC 长连接 |
| macOS / Windows / Linux 如何统一 | 统一协议，平台相关路径、Shell 和进程语义由 Runner 实现 |
| 会话如何恢复 | DSH Session Event Log 持久化到 PostgreSQL，产品表是投影 |
| 是否复用 Nova 包、Proto 或数据库 | 不复用；所有包、协议和表在新项目重新定义 |
| 是否修改 DSH 上游 | 不修改；只使用公开 package export 和 Cordis seam |
| 开发机是否安装 DSH / npm 插件 | 不安装；只安装新项目 Remote Runner |
| DSH 与 Cordis 插件运行在哪里 | Control Server 的 Runtime Shard 内，统一安装和治理 |
| 官方／社区插件兼容范围 | 首先兼容 Host 插件；Client/Web 插件通过产品 UI 协议适配 |

### 1.2 为什么不能直接部署 DSH Web

DSH 的 `dsh-web-app` 是本地单用户 GUI 表层，不是互联网产品 Server。它的当前约束包括：

- Host WebServer 不提供 TLS、认证或多租户；
- Web CLI 有意不支持直接以 `0.0.0.0` 方式对公网开放；
- Browser 协议、Settings、Credentials、本机目录选择和 Host 桌面能力面向本地可信环境；
- 部分交互状态只存在于 Host 进程内，Host 重启后不能恢复；
- Client 与 Host 一起发布，协议当前没有独立版本协商。

因此 DSH Web 只能作为以下设计的参考：`ctx.agents` 驱动、Session Event 投影、连接 generation、历史尾页与实时事件的收敛。产品公网入口、认证、权限、稳定 API、跨设备 Runner 和数据库模型必须由新项目拥有。

## 2. 产品模型与不变量

### 2.1 控制面与执行面

Control Server 是控制面，负责：

- 用户认证与租户隔离；
- Project、Workspace Binding 与 Conversation；
- Runner 注册、在线状态、选择和连接代际；
- DSH Runtime 组装与 AgentHandle 生命周期；
- 模型配置、LLM 凭据和调用；
- DSH Session 持久化、产品投影、SSE 和交互；
- 工具请求路由、取消、限流与审计。

Remote Runner 是执行面，负责：

- workspace root 与路径 containment；
- 文件 resolve、stat、read、list、原子 write / edit；
- Shell 进程、输出、超时、进程组取消和资源上限；
- 平台能力上报、心跳、断线清理和背压；
- 对每一项请求再次校验 workspace、generation 和授权范围。

Runner 不负责：Agent Loop、Prompt、模型调用、会话持久化、任务规划、业务重试、用户权限或 UI 投影。

### 2.2 Greenfield 领域对象

| 对象 | 含义 | 持久性 |
|---|---|---|
| User | 登录用户与权限主体 | PostgreSQL |
| Device | 用户的一台逻辑开发设备 | PostgreSQL |
| Runner | 设备上的一个逻辑执行器身份 | PostgreSQL |
| Runner Connection Generation | 一次真实 gRPC 连接生命周期 | Server 内存，必要事实入审计 |
| Workspace Binding | Project 与某个 Runner workspace root 的显式绑定 | PostgreSQL |
| Project | 产品中的代码项目 | PostgreSQL |
| Conversation | UI 会话，固定一个 DSH Session 与 Workspace Binding | PostgreSQL |
| Harness Session | DSH 的事件日志与恢复事实 | PostgreSQL Event Log |
| Runtime Shard | 绑定一个 Runner generation 的 DSH 运行环境 | Server 内存 |

这些是新项目自己的模型。它们不要求与 Nova 的 Project、Conversation、Runner 或协议字段相同。

### 2.3 必须保持的不变量

1. `AgentRuntimeRegistry` 独占 AgentHandle 的 create、resume、cancel、evict 和 dispose。
2. `RunnerRegistry` 独占 Runner connection 的 admission、generation、request correlation 和 disconnect。
3. 一个 Runtime Shard 的 `ctx.fs` 与 `ctx.shell` 永远绑定同一个 Runner generation。
4. Conversation 在活动 turn 内固定 Workspace Binding，不允许中途切换机器。
5. 同一个 DSH Session 在所有 Server 副本中最多一个活动写者。
6. DSH Session Event Log 是 Agent 历史事实，产品 Message / Tool / Status 表是可重建投影。
7. Runner 不可用时明确返回基础设施错误，绝不回退到 Control Server 本机。
8. Server 不解析外部机器的路径语义；路径规范化、符号链接和 containment 由对应 Runner 判断。
9. Runner 断线后不自动重放具有副作用的命令或写操作。
10. DSH 上游目录只读，新项目代码只依赖公开 package root export。

## 3. DSH 可直接复用的公开能力

### 3.1 Agent 生命周期

`@deepseek-ai/dsh-agent` 提供公开 `ctx.agents` 驱动面：

- `ctx.agents.create({ sessionId, meta, agentOptions, setup })`；
- `ctx.agents.resume({ resumeSessionId, agentOptions, setup })`；
- 返回由调用方独占的 `AgentHandle`；
- `agent.followup()` 提交普通用户后续输入；
- `agent.steer()` 在运行中提交下一步骤 steering；
- `agent.inject()` 添加下一步骤上下文但不主动唤醒；
- `agent.cancel()` 中断当前活动；
- `agent.whenIdle()` 等待整个 Agent 达到静止；
- `handle.dispose()` 停止 Loop、注销 Agent、分离 Session 并释放 scope。

这足以让自研 Server 管理长期在线、多轮、可取消、可恢复的 Agent，不需要修改 Agent Loop。

### 3.2 Session 与事件

DSH 的 `session/event` 是可回放 transcript 的权威来源；`agent/*` 事件主要用于实时状态、队列和运行协调。新项目应：

- 持久保存全部已提交 Session Event；
- 用 event seq 作为投影 watermark；
- 从 Session Event 投影产品消息、工具卡、usage、turn 状态和标题；
- 只把稳定、自有的浏览器协议暴露给 Web UI，不直接导出 DSH 联合类型；
- Server 重启后从持久日志恢复 Agent，而不是从浏览器状态恢复。

### 3.3 文件系统 seam

`@deepseek-ai/dsh-fs` 的 `FileSystem` 已把远程实现需要的语义放在公开接口中：

- 异步 `resolve()` 与稳定 `FsTarget`；
- `processPath()`、`fileUrl()` 与 `contains()`；
- `stat()`、`lstat()`、`readText()`、`streamText()`、`readBytes()`；
- 稳定顺序的 `listDir()`；
- 带 version guard 的原子 `writeText()`；
- 把版本校验、literal match 和 rewrite 放在同一临界区的 `editText()`；
- 类型化错误、观察策略和可选 sandbox fact。

新项目实现 `RemoteFileSystem extends FileSystem`，继续复用 DSH 文件工具与 observation policy，不重写模型工具语义。

### 3.4 Shell seam

`@deepseek-ai/dsh-shell` 的 `ShellExecutor` 明确区分：

- `resolve()`：补默认值、限制 cwd、timeout、env 和输出上限；
- `run()`：前台执行，非零退出、超时和取消返回结果，基础设施失败才 reject；
- `start()`：后台进程句柄；
- `sandboxMode`：只能报告真实生效的能力。

第一版只需对外开放前台 `run()`。RemoteShellExecutor 仍需实现抽象的 `start()`，但在后台协议完成前应明确返回 unsupported，同时把 `dsh-tool-bash` / `dsh-tool-pwsh` 配成 `enableRunInBackground: false`，让模型看不到 `run_in_background`。后台任务、PTY、Terminal 和 LSP 可后续增加，不能为了满足接口而伪造能力。

### 3.5 Persistence seam

`@deepseek-ai/dsh-session-persistence` 已提供 `PersistenceCoordinator`。推荐只实现 PostgreSQL `PersistenceBackend` 原语：

- `loadStored()`；
- `readStoredRevision()`；
- 可选 `loadStoredFrom()`；
- `appendBatch()`；
- `commitRepair()`；
- `list()`；
- 可选 `close()`。

Coordinator 继续拥有批写、顺序、准备、恢复、flush、crash repair 和 dispose quiescence。新项目不要复制这套状态机。

### 3.6 不直接复用的 DSH 入口

| DSH 能力 | 用法 |
|---|---|
| `dsh-agent-loop`、Agent、Session、Tools、Prompt、Compaction | 生产直接复用 |
| `dsh-fs`、`dsh-shell` definition 与工具 consumer | 生产直接复用 |
| `dsh-web-app` / Web Frontend | 只参考，不进入产品 |
| `dsh-host-webserver` / connection | 只参考本地 GUI 的传输处理 |
| `dsh-headless` | 只参考一次性任务生命周期 |
| `dsh-sdk-jsonrpc-server` | 只参考 `ctx.agents` 驱动与事件转发 |
| `dsh-base` | 只参考依赖闭包，不作为生产组合直接加载 |
| DSH 本地 FS / Shell / Subprocess / Skill FileSystem | 生产禁止加载 |

`dsh-sdk-jsonrpc-server` 目前没有逐 Session close、逐 prompt cancel 或逐 prompt 最终结果，不适合作为产品 Server。产品 Server 可以复用其“Server 持有 AgentHandle、先订阅事件、`followup()` 立即返回 MessageId、shutdown 完整 dispose”的模式。

### 3.7 DSH 官方与社区 Cordis 插件兼容

新项目不要求每台开发机安装 DSH。DSH、Cordis Loader、插件包和 profile composition 全部属于 Control Server；Remote Runner 只是产品自带的轻量执行守护进程。插件在 Server 端参与 Agent、Tool、Prompt 和事件生命周期，需要访问 workspace 或启动进程时，再通过当前 Runtime Shard 注入的远程 Service 走 gRPC。

```text
Web UI
  │ install / configure / enable / disable
  ▼
Control Server
  ├─ Plugin Registry + policy + lockfile
  ├─ DSH public packages
  ├─ Cordis Context / Loader
  ├─ official and community Host plugins
  └─ Runner-bound compatibility Services
       │ gRPC
       ▼
Remote Runner
  ├─ filesystem
  ├─ shell / PowerShell / process / PTY
  ├─ Git and workspace operations
  └─ OS-specific containment and cancellation
```

DSH profile 已支持通过 `dsh plugin --profile <name> add <package>` 把树外包安装到 profile 的 `node_modules`，再由 bundle、profile manifest 和 `cordis.patch.yml` 组合。新项目可以兼容这套包格式和组合语义，但插件安装由 Server 的 `PluginRegistry` 实现，不要求生产运行 `dsh` CLI，也不把插件下发到 Runner。

#### 3.7.1 兼容级别

| 插件类型 | 兼容目标 | 迁移成本 | 处理方式 |
|---|---|---:|---|
| Prompt、Agent 策略、事件监听 | 原样加载 | 很低 | 直接运行在 Server Cordis Context |
| LLM Provider、重试、Token 统计 | 原样加载 | 很低 | 作为 Server 全局或 Shard 插件 |
| 只通过 `ctx.tools`、`ctx.workspace`、`ctx.subprocess` 等公开 Service 工作的插件 | 源码兼容 | 低 | 注入 Runner-bound 兼容 Service |
| Tool 插件 | 尽量源码兼容 | 中 | Tool 决策留在 Server，OS 操作经 gRPC 执行 |
| 直接使用 Node `fs`、`child_process` 或本机 Git 的插件 | 不承诺透明兼容 | 较高 | 改为 DSH Service，或提供明确的远程适配 |
| Sandbox、PTY、LSP、文件监听插件 | 能力兼容 | 较高 | Server 保留插件逻辑，Runner 实现平台能力和协议 |
| 带原生 Node 依赖的插件 | 按包评估 | 较高 | 在 Server 镜像构建，不允许假定目标 Runner ABI |
| DSH Client/Web 插件 | 不承诺源码直跑 | 较高 | 使用产品自有 UI Contribution 协议或专用 Adapter |
| 依赖非 DSH Cordis 发行版或其他产品 Service 的插件 | 不保证 | 不确定 | 检查 Cordis 包身份、版本和 Service 契约 |

“兼容 Cordis 插件”不能理解为任意 Cordis 生态包都可直接安装。可直接兼容的前提是插件面向当前 DSH 使用的 `@deepseek-ai/cordis` 版本，并且它声明的 Service、Event、配置和生命周期契约在生产 Composition 中真实存在。

#### 3.7.2 通过 Service 兼容，而不是逐插件改写

低成本跟随官方插件的关键，是把迁移成本集中到少数基础 Service：

```text
DSH / Cordis Host plugin
       │ inject
       ▼
Server compatibility Services
├─ ctx.workspace / ctx.fs
├─ ctx.subprocess / ctx.shell
├─ ctx.sandbox
├─ ctx.shellEnv
├─ ctx.attachments
└─ ctx.jobs
       │ RunnerClient
       ▼
gRPC Remote Runner
```

遵守 Service 边界的官方和社区插件可以保持原代码；绕过 Service、直接访问 Server 本机 OS 的插件必须适配。Control Server 不提供本地 workspace fallback，否则这类插件可能误读或修改 Server 容器文件。

#### 3.7.3 Host 插件与 Client 插件分开承诺

第一阶段只承诺 DSH Host 插件兼容，包括 Tool、LLM、Prompt、Agent、Session Hook、Sandbox 策略、Web Search 和 MCP 等服务端能力。自研 Web UI 不运行完整的 DSH Client Runtime，因此插件贡献的 DSH Slot、Overlay、Settings Page、主题或 React 卡片不会自动出现。

产品后续可以定义稳定的 UI Contribution 协议，支持配置 Schema、Tool Result Renderer、审批表单和状态卡片；对高价值官方插件提供 Adapter。只有在社区确实大量依赖 DSH Client 插件时，才评估嵌入 DSH Client Cordis Runtime，不能把它作为 Host 插件兼容的前置条件。

#### 3.7.4 Server 统一安装与治理

Web UI 的“安装插件”操作只调用产品 API，真实流程是：

```text
request install
  → resolve package and exact version
  → verify source, integrity and allow policy
  → install into an isolated Server plugin store
  → persist lockfile and compatibility metadata
  → validate Cordis dependency composition
  → activate in the selected logical profile / Runtime Shard
  → record audit result
```

Server 至少记录插件名、精确版本、来源、完整性哈希、配置、所需 Service、Host/Client 能力声明、启停状态和升级结果。插件是可执行代码：多租户环境默认使用允许列表，并通过容器、Worker 或等价边界隔离不可信插件；不能让普通用户把任意 npm 包加载进 Control Server 主进程。

## 4. 推荐生产部署拓扑

### 4.1 单 Server 副本的第一版

```text
Internet
   │
   ▼
DNS / TLS
   │
   ▼
Nginx or Caddy
   ├─ app.example.com/                 → Web UI static assets
   ├─ app.example.com/api/*            → Control Server HTTP
   ├─ app.example.com/api/*/events     → Control Server SSE
   └─ runner.example.com:443           → Control Server gRPC listener
                                                 ▲
                                                 │ outbound HTTP/2 + TLS
                       ┌─────────────────────────┼─────────────────────────┐
                       │                         │                         │
                Linux server Runner       macOS Runner              Windows Runner
                /srv/workspaces/x         /Users/a/code/x           D:\code\x

Control Server
   ├─ Product HTTP API
   ├─ Runner gRPC Gateway + Registry
   ├─ DSH Runtime Shards
   ├─ AgentRuntimeRegistry
   ├─ Session Projector / Interaction Broker
   └─ PostgreSQL Persistence Provider
             │
             ▼
         PostgreSQL
```

第一版应只运行一个有状态 Control Server 副本。Runner gRPC stream、AgentHandle、Runtime Shard、SSE 在线订阅和待回答交互都属于进程内状态；在没有连接 owner 路由与 Session fencing 前，把 HTTP 横向扩成多个副本会制造双写和请求找不到 Runner 的问题。

### 4.2 进程与端口

| 组件 | 建议形态 | 对外暴露 |
|---|---|---|
| Web UI | Vite 等构建后的静态文件，由 Nginx / CDN 服务 | HTTPS 443 |
| Control Server HTTP | Node.js 24 容器或 systemd 服务 | 仅反向代理可达，例如 9105 |
| Control Server gRPC | 与 Server 同进程的独立 listener | 仅反向代理可达，例如 9106 |
| PostgreSQL | 托管数据库或独立容器 | 只在私网 |
| Object Storage | 仅附件功能需要时增加 | 只经 Server 签名或代理 |
| Remote Runner | 各开发机原生进程或系统服务 | 不开放入站端口 |

本地 `deepseek-harness-master` 要求 Node `^22.19.0 || >=24.0.0`。新 Server 镜像建议直接固定 Node 24，避免开发与生产使用不同主版本。

### 4.3 反向代理要求

Web UI 与 HTTP API 推荐同源部署，浏览器只访问 `https://app.example.com`：

- `/api` 反向代理到 Control Server；
- SPA 路由未命中静态文件时回退 `index.html`；
- SSE 路由关闭代理缓冲和响应压缩，设置足够长的 read timeout；
- Server 定期发送 SSE heartbeat，代理和负载均衡器不得把空闲连接提前关闭；
- Runner 使用独立 `runner.example.com`，代理必须支持端到端 HTTP/2 gRPC streaming；
- HTTP 与 gRPC 入口都只信任代理转发的、经过清洗的来源头；
- Control Server 的内部端口不直接暴露公网。

### 4.4 Server 机器也作为开发机

即使 workspace 位于部署 Server，同样启动一个独立 Remote Runner：

```text
Control Server container ──gRPC──► Runner service ──► /srv/workspaces/project
```

Control Server 容器不挂载 `/srv/workspaces/project`。Runner 可以通过私网入口或同机回环入口连接 gRPC Gateway。这样服务器、macOS、Windows 始终经过同一真实远程边界，测试与生产不会出现第二条执行路径。

## 5. 跨服务器、macOS 与 Windows 的开发模型

### 5.1 Runner 主动连接

每台开发机只需安装新项目自己的 Runner binary，不需要运行 DSH 或 Control Server：

```text
remote-runner connect \
  --server https://runner.example.com \
  --token <one-time-or-device-token> \
  --workspace <local-workspace-root>
```

Windows 使用 PowerShell 参数形式，协议与语义相同。Runner 主动建立出站连接，因此不要求家庭网络、公司网络、NAT、WSL 或开发服务器开放入站端口。

连接注册至少上报：

- logical runner id 与 device id；
- Runner 版本、协议版本范围；
- `linux` / `darwin` / `windows`、CPU 架构；
- 默认 Shell 与可选命令；
- workspace root 的展示值；
- FS、foreground shell、background process、PTY、sandbox 等 capability；
- 最大并发、输出上限和资源事实。

Server 接纳后签发本次连接的 `generation`。重连产生新 generation，旧 generation 的 target、execution 和 process handle 永远不能复用。

### 5.2 Project 与 Workspace Binding

同一个 Project 可以有多条 Workspace Binding：

```text
Project A
  ├─ binding-1 → runner-mac     → /Users/alice/code/project-a
  ├─ binding-2 → runner-win     → D:\code\project-a
  └─ binding-3 → runner-server  → /srv/workspaces/project-a
```

Conversation 创建时必须选择一条 binding，并在每个 turn 内固定它。这样历史中的路径、工具观察和副作用都指向一个明确执行世界。

Control Server 不负责在三台机器之间同步代码。Git、团队同步工具或用户自己的同步方式负责让各 workspace 处于期望版本。产品可以显示 Runner 报告的 Git remote、branch 和 commit 作为提示，但不能据此假设文件内容相同。

### 5.3 切换机器

不允许在运行中的 Conversation 上静默切换 Runner。推荐规则：

1. 当前 Agent 必须 idle；
2. 用户显式选择新的 Workspace Binding；
3. Server 获取新 Runner 的 repo identity、branch、commit 和 dirty 状态快照；
4. 默认 fork 或新建 Conversation，并注入新的 workspace context；
5. 只有用户确认两个 workspace 可承接同一历史时，才允许原 Conversation rebind；
6. 旧 generation 上 outcome unknown 的命令绝不在新机器自动重试。

第一版可以更严格：Conversation 创建后不可换 binding，只允许从历史 fork 到新 binding。这比隐式迁移安全，状态 owner 也更清晰。

### 5.4 跨平台路径与 Shell

- Server 把远程路径视为 opaque display/process path，不用 Node `path.resolve()` 解释 Windows 或 macOS 路径；
- `FsTarget` 同时绑定 runner id、generation、workspace binding 和 opaque target id；
- `processPath()` 由 Runner 返回，供同一执行世界的 Shell 使用；
- POSIX Runner 装配 DSH bash tool，Windows Runner 装配 DSH PowerShell tool；
- Runner 必须对路径大小写、盘符、UNC、符号链接或 junction 使用平台原生规则；
- WSL 与 Windows 原生环境是两个不同 Runner，不混用路径。

### 5.5 三种开发方式

| 方式 | Web / Server | Runner | 用途 |
|---|---|---|---|
| 共享开发环境 | 部署在开发服务器 | 每位开发者本机 | 最接近目标产品，推荐日常联调 |
| 全本地 | 本机 Web + Server + PostgreSQL | 本机真实 Runner 进程 | 离线开发与协议调试 |
| 服务器 workspace | 部署在服务器 | 同机独立 Runner 服务 | 远程开发机、CI workspace 或长期任务 |

共享开发环境中，用户和 Runner token 必须按开发者隔离。前端本地开发可通过 Vite proxy 访问开发 Server，避免为 cookie、CORS 和 SSE 维护另一套行为；OIDC callback 需要显式加入本地开发地址。

## 6. 用户 query 到 Remote Runner 的完整链路

### 6.1 前置条件

在用户发送消息前：

1. 用户已登录 Web UI；
2. Runner 已通过 gRPC 注册并处于 ready；
3. Project 已绑定该 Runner 的 workspace；
4. Conversation 已记录 DSH Session id、Workspace Binding 和模型选择；
5. 浏览器已打开该 Conversation 的 SSE，并持有最近 event id。

### 6.2 时序

```text
Browser          Control Server       DSH Agent       Remote Provider      Remote Runner
   │                    │                  │                   │                  │
   │ POST user message  │                  │                   │                  │
   ├───────────────────►│                  │                   │                  │
   │                    │ auth + route     │                   │                  │
   │                    │ ensure shard     │                   │                  │
   │                    │ create/resume    │                   │                  │
   │                    ├─────────────────►│                   │                  │
   │                    │ subscribe events │                   │                  │
   │                    │ followup(message)│                   │                  │
   │                    ├─────────────────►│                   │                  │
   │ 202 + messageId    │                  │                   │                  │
   │◄───────────────────┤                  │                   │                  │
   │                    │                  │ model request     │                  │
   │                    │                  │ tool: read/bash   │                  │
   │                    │                  ├──────────────────►│                  │
   │                    │                  │                   │ gRPC request     │
   │                    │                  │                   ├─────────────────►│
   │                    │                  │                   │ output/result    │
   │                    │                  │                   │◄─────────────────┤
   │                    │                  │ tool result       │                  │
   │                    │                  │◄──────────────────┤                  │
   │                    │ Session events   │                   │                  │
   │                    │◄─────────────────┤                   │                  │
   │ SSE projection     │                  │                   │                  │
   │◄───────────────────┤                  │                   │                  │
```

具体步骤：

1. Browser 先保持 SSE 在线，再 `POST /api/conversations/:id/messages`，请求带 client-generated idempotency key。
2. Server 验证用户、Conversation、Workspace Binding、Runner 归属和模型配置。
3. `RunnerRegistry` 解析逻辑 Runner 当前 generation；不可用时返回 `RUNNER_UNAVAILABLE`。
4. `AgentRuntimeRegistry` 取得 Session 单写 lease，并在对应 Runtime Shard create 或 resume DSH Agent。
5. Server 在提交输入前订阅 `session/event` 与 `agent/status`，避免丢失同步发出的首批事件。
6. Server 使用 DSH LLM helper 创建带唯一 MessageId 的用户消息，调用 `agent.followup()`。
7. HTTP 返回 `202 Accepted + messageId`。MessageId 只代表 inbox 准入，不代表某一条最终 assistant answer。
8. DSH Agent 调用模型。如果模型只回答文本，链路不会触达 Runner。
9. 如果模型调用文件或 Shell 工具，DSH consumer 调用当前 Shard 的 `ctx.fs` / `ctx.shell`。
10. Remote Provider 把调用转换为带 request id、generation 和 workspace binding 的 gRPC 消息。
11. Runner 再次校验 generation、workspace、路径、并发和 policy，执行真实操作并流式返回事实。
12. Provider 把结果映射回 DSH 约定，Agent 继续下一模型步骤或结束 turn。
13. DSH Session Event 先提交到内存权威日志；PersistenceCoordinator 同步接纳该事件并异步有界批写，Projector 以同一 seq 生成稳定 UI event。`dsh-session-checkpoint-policy` 在模型请求、顶层工具副作用和下一 step 前执行 durability checkpoint。
14. Browser reducer 按 event id / seq 幂等应用；断线后先补历史投影，再接实时事件。
15. Agent 进入 idle 后，Server 显式 `ctx.sessions.flush(agent.session)`，成功后再发布带 durable watermark 的 run-completed 事件；flush 失败则显示运行结果未安全落盘，而不是宣称完成。

### 6.3 取消

取消链路只有一个控制 owner：

```text
Browser cancel
  → Control Server authorizes
  → AgentRuntimeRegistry.agent.cancel('user')
  → active tool AbortSignal
  → Remote Provider sends CancelRequest
  → Runner kills process group or stops file stream
  → terminal result / infrastructure error
  → DSH closes step and turn consistently
  → SSE publishes final status
```

取消不关闭整个 Runner gRPC stream，也不影响同一 Runner 上的其他 Conversation。

### 6.4 Approval 与用户提问

DSH Approval / User Question 通过 Server 的 `InteractionBroker` 投影为持久 interaction：

- SSE 推送 interaction id、Conversation id、问题和允许的响应结构；
- 浏览器通过 REST 回答；
- Server 验证 owner、状态、id 和一次回答约束；
- cancel、Agent dispose、Runner disconnect 或 Server shutdown 必须结算等待者；
- 第一版若不支持 Server 重启后恢复等待中的调用，就必须把旧 interaction 标记为 unavailable，不能继续显示可回答状态。

## 7. Runtime Shard 与路由所有权

### 7.1 每个 Runner generation 一个 Shard

```text
logical runner: runner-mac-1
connection generation: gen-42
        │
        ▼
HarnessRuntimeShard
  ├─ one Cordis Context
  ├─ RemoteFileSystem bound to gen-42
  ├─ RemoteShellExecutor bound to gen-42
  ├─ DSH core plugin graph
  ├─ Agent A / Session A
  └─ Agent B / Session B
```

同一 generation 的多个 Agent 可以共享 Remote Provider 和数据库连接资源，但各自 Session、cwd、scope 和工具调用独立。不同 Runner 或同一 Runner 重连后的新 generation 使用新 Shard，不在旧 Context 中替换连接引用。

这个边界避免：

- 旧 `FsTarget` 在重连后指向另一命名空间；
- 旧进程句柄操作新连接；
- 一个 Context 的同步 `processPath()` 在不同平台间漂移；
- 正在运行的 Agent 被无提示迁移到另一台机器。

### 7.2 Runtime Shard 生命周期

| 事件 | 行为 |
|---|---|
| Runner 接纳 | 创建 generation、RunnerLease 和 Runtime Shard |
| 首次访问 Conversation | 取得 Session lease，create / resume Agent |
| 用户输入 | 先订阅事件，再 `followup()` |
| Agent idle 超时 | flush、dispose Handle、释放 Session lease |
| Runner disconnect | generation 失效，取消请求，dispose Shard 内 Agent |
| Runner reconnect | 新 generation、新 Shard，按需从 Session Event Log 恢复 |
| Server shutdown | 停止准入，cancel、等待、flush、dispose Agent 与 Shard |

### 7.3 两个唯一 Registry

`RunnerRegistry` 只管理连接事实：

- token admission 与 user / runner 绑定；
- current generation；
- heartbeat、ready / busy / draining / disconnected；
- request / execution correlation；
- disconnect 和有界缓冲；
- Shard 创建和 generation 失效通知。

`AgentRuntimeRegistry` 只管理 DSH 生命周期：

- Conversation → AgentHandle；
- create / resume 单航班；
- Session lease 与 fencing；
- followup / steer / cancel；
- idle eviction、flush、dispose 和 shutdown。

Controller、Project Service、SSE Hub 和 Remote Provider 都不能缓存第二份 AgentHandle 或 Runner connection owner。

### 7.4 禁止全局 `currentRunner`

插件在 Server 运行不意味着所有插件共享一个可变的当前机器。并发用户、并发 Conversation 和 Runner 重连会让全局 `currentRunner` 立即产生串 workspace 风险。Runner 选择必须由 Runtime Shard / Cordis 子 Context 持有：

```text
Server Cordis root
├─ global services: plugin registry, LLM routes, logging
├─ Runtime Shard A / child Context
│  ├─ runner = mac-01, generation = 42
│  └─ fs / shell / workspace Services → mac-01#42
└─ Runtime Shard B / child Context
   ├─ runner = windows-02, generation = 7
   └─ fs / shell / workspace Services → windows-02#7
```

插件通过所在 Context 注入的 Service 得到执行目标，不读取进程全局变量，也不在每次调用临时替换共享 Service。Runner generation 变化时销毁旧 Shard 并创建新 Shard，保证旧 target、process handle 和插件 effect 不会漂移到新连接。

## 8. 全新项目建议结构

以下只是 Greenfield 结构建议，不映射 Nova 包：

```text
apps/
├─ web-ui/                    # 公网产品 UI
└─ control-server/            # HTTP、gRPC、认证、产品编排

packages/
├─ harness-runtime/           # 显式 DSH Composition Root
├─ harness-plugin-host/       # Cordis Loader、逻辑 profile 与插件生命周期
├─ harness-plugin-compat/     # DSH Service → Runner-bound 兼容实现
├─ harness-runner-fs/         # DSH FileSystem → Runner client
├─ harness-runner-shell/      # DSH ShellExecutor → Runner client
├─ harness-persistence-pg/    # DSH PersistenceBackend → PostgreSQL
├─ harness-server-bridge/     # Agent lifecycle / event / interaction bridge
├─ plugin-protocol/           # 插件目录、配置与可选 UI Contribution 稳定类型
├─ product-protocol/          # Browser REST / SSE 稳定类型
├─ runner-client/             # Node gRPC session 与消息关联
└─ testkit/                   # fake LLM、真实 Runner harness、协议测试

crates/
└─ remote-runner/             # Rust 原生执行器

proto/
├─ runner.proto               # Connect、Register、Heartbeat、Drain
├─ execution.proto            # foreground process、cancel、output
└─ filesystem.proto           # resolve、stat、read、list、write、edit

deploy/
├─ nginx/
├─ compose/
└─ systemd/
```

不要建立以下 pass-through 层：

- DSH Agent API 的同名 wrapper；
- Protobuf DTO → Transport DTO → Domain DTO 的多段复制；
- Remote Provider 之外的第二套本地 FS / Shell；
- 同时存在 Runner Gateway、Runner Manager、Runner Pool、Runner Adapter 且只做转发的结构；
- Web Controller 持有 Agent 或 Runner 生命周期。

## 9. 最小 DSH 生产组合

生产 Composition Root 应代码式显式装配，而不是直接加载 `dsh-base`：

```text
Cordis Context per Runtime Shard
├─ timer
├─ product-owned Cordis Loader / validated logical profile
├─ dsh-llm + selected provider adapters
├─ dsh-session
├─ PostgreSQL SessionPersistence provider
├─ dsh-session-checkpoint-policy
├─ dsh-system-prompt
├─ dsh-tools
├─ dsh-agent
├─ dsh-llm-retry
├─ RemoteFileSystem
├─ dsh-fs-observation-policy
├─ dsh-tool-fs / editor tools
├─ RemoteShellExecutor
├─ dsh-tool-bash OR dsh-tool-pwsh
│  └─ phase 1: enableRunInBackground = false
├─ optional product instructions
├─ validated official / community Host plugins
├─ optional compaction
└─ dsh-agent-loop
```

生产不得装载：

- DSH local FS；
- DSH local Bash / PowerShell executor；
- DSH local Subprocess；
- DSH 本地 Sandbox provider；
- 从 Control Server 文件系统发现 workspace Skill 的 provider；
- JSONL / SQLite 作为生产 Session 事实源；
- DSH Web Host、Settings UI 或本地 Credentials UI。
- 未经校验的任意 npm 插件；
- 直接把 Server 文件系统当作用户 workspace 的社区插件。

Skill 第一版可以关闭，或只使用随部署发布的只读内置 Skill。若需要读取 workspace 中的 `SKILL.md`，必须实现 Remote Skill Provider 或确认现有 consumer 全程只通过 `ctx.fs`，不能让 Server 本地 Skill FileSystem 读取同名路径。

## 10. 新 Runner gRPC 契约

### 10.1 唯一连接模型

Runner 只主动调用一个 RPC：

```proto
rpc Connect(stream RunnerEnvelope) returns (stream ServerEnvelope);
```

同一双向流复用控制、文件和进程消息：

| Runner → Server | Server → Runner |
|---|---|
| Register | Accepted / Rejected |
| Heartbeat / capability change | Execute / Cancel |
| Execution Started / Output / Finished | Resolve / Stat / Lstat |
| File response / chunks | Read / List / Write / Edit |
| Request-scoped typed error | Drain / Shutdown |

文件或执行请求使用 `request_id` 关联一问一答，长进程额外使用 `execution_id`；所有消息隐式属于当前 connection generation，持久 target 和 handle 还需显式携带 generation 进行防陈旧校验。

### 10.2 DSH FileSystem 对协议的要求

第一版至少定义：

```text
ResolvePath(path, cwd)
  -> target_id, target_key, display_path, process_path, file_url, generation

Stat(target_id, follow_symlink)
  -> kind, size, mtime, revision

Lstat(path, cwd)
  -> kind, size, mtime

ReadText(target_id, max_bytes)
  -> text chunks, revision

ReadBytes(target_id, max_bytes)
  -> byte chunks, revision

ListDir(target_id)
  -> stable ordered children

WriteText(target_id, content, intent, expected_revision?)
  -> operation, revision, before?, after

EditText(target_id, old_text, new_text, replace_all, expected_revision?)
  -> revision, before, after
```

约束：

- target id 绑定 runner、generation 和 workspace binding；
- revision 是 Runner 生成的不透明 token；
- guarded write 的版本检查与原子 publish 在 Runner 同一临界区；
- edit 的版本检查、literal match 和 rewrite 在 Runner 同一临界区；
- read / write 有明确字节上限和取消；
- Runner 每次操作都重新验证 containment 与 symlink / junction 边界；
- Server 不能从 target key 推导远程路径。

### 10.3 Shell 第一版

```text
Execute
  -> Started
  -> Output(stdout | stderr, bytes, sequence)*
  -> Finished(status, exitCode?, signal?, error?, truncated, duration)

Cancel(execution_id)
  -> found / already_finished
```

规则：

- 非零 exit code 是已完成事实，不是 gRPC error；
- timeout、cancel、spawn failure 和 disconnect 保持不同状态；
- 输出按 bytes 分块，Node 端做增量 UTF-8 解码；
- 每个 execution 和整个 connection 都使用有界缓冲；
- 出站阻塞时 Runner 暂停读取 pipe 或进行有界 spill；
- Cancel 终止进程组，不只终止父进程；
- 断线后的副作用 outcome unknown，不自动重放。

后台进程第二阶段增加 `StartProcess / ReadProcess(offset) / KillProcess`。PTY 还需要 stdin、resize、游标、半关闭和断线策略，不能与普通 Shell output 混成一个模糊接口。

### 10.4 协议版本

Register 同时报告：

- Runner semantic version；
- protocol min / max；
- capability name + version；
- platform 与 architecture。

Server 只在存在兼容交集时接纳，并在 Accepted 中冻结本 generation 的协议与 capability snapshot。新字段遵循 Protobuf 兼容规则；删除或改变语义必须发布新版本，不依赖“Server 和 Runner 总会一起升级”。

## 11. Control Server 设计

### 11.1 HTTP / SSE 面

第一版只需以下稳定产品 API：

```text
/api/auth/*
/api/me
/api/runners
/api/runners/tokens
/api/runners/:id/directories
/api/projects
/api/projects/:id/workspace-bindings
/api/conversations
/api/conversations/:id/messages
/api/conversations/:id/events
/api/conversations/:id/cancel
/api/interactions/:id/answer
```

消息 POST 是异步准入：`202 + messageId`。SSE 是结果、状态和工具投影的主通道。浏览器重连提交 `Last-Event-ID`，Server 返回：

1. 数据库中大于 watermark 的持久投影；
2. 当前 interaction、queue 和 Runner state 基线；
3. 在线 Event Hub 的后续事件。

原始 token delta 可以只在线传输；已经提交的 assistant message、tool result 和 turn end 必须可从持久 Session / Projection 恢复。

### 11.2 PostgreSQL 数据边界

建议最小表：

```text
users
devices
runners
runner_credentials
projects
workspace_bindings
conversations
conversation_messages       # 产品查询投影
conversation_events         # 稳定 SSE 投影 / watermark
pending_interactions
dsh_sessions
dsh_session_events
session_leases
```

DSH 持久化可以使用：

```text
dsh_sessions
  session_id PK
  format_version
  header_jsonb
  next_seq
  revision
  created_at
  updated_at

dsh_session_events
  session_id FK
  seq
  event_type
  event_jsonb
  created_at
  PK(session_id, seq)
```

`appendBatch()` 在事务中锁定 session row，验证首 seq 连续，批量插入事件并更新 `next_seq` / `revision`。Session lease 与 DSH revision 是不同职责：revision 检测存储变化，lease / fencing 阻止多 Server 同时驱动同一 Session。

产品 Conversation 表只存 owner、Project、Workspace Binding、模型选择、标题和查询字段，不复制 DSH Loop 状态机。产品 Message / Event 是投影，可以从 DSH Session Event Log 重建。

### 11.3 LLM 与凭据

- LLM 在 Control Server 调用，不在 Runner；
- 模型 API key 只保存在 Server 的凭据存储；
- provider、model、max output、reasoning 等选择在 Conversation / Session 建立时快照；
- DSH `agent/request` 和公开 LLM adapter seam 负责调用，不把网关逻辑写进 Loop；
- 自研 Model Gateway 时实现树外 DSH Adapter，Runner 不认识模型供应商。

### 11.4 多副本演进

第一版不伪装成水平可扩展。需要多副本时，有两条清晰路线：

1. 独立 Runner Gateway 持有全部 gRPC stream，Control Server 通过内部流式 RPC 调用它；
2. 每个 Runner 连接由一个 Server shard 持有，HTTP 层根据 runner owner 和 session owner 做明确路由。

无论哪条路线，都必须增加：

- Runner connection owner 的可查询注册；
- Session lease + fencing token；
- 跨副本 Event Hub；
- interaction owner 与恢复策略；
- drain / deployment handoff；
- 请求在 owner 丢失时的明确失败。

仅增加 Redis Pub/Sub 或让负载均衡器随机分发 HTTP，不能解决流 owner、背压、取消和双写问题。

## 12. 安全边界

### 12.1 浏览器与用户

- 使用 OIDC / OAuth 2.1 Authorization Code + PKCE；
- Session cookie 设置 Secure、HttpOnly、SameSite；
- 有副作用的 cookie API 使用同源与 CSRF 防护；
- 默认不开放跨域 API；
- 每个 Project、Conversation、Workspace Binding、Runner 和 Interaction 都按 user / tenant 校验；
- SSE 订阅同样执行 owner 校验，不能只依赖不可猜 id；
- 错误响应不泄露 Runner 本机绝对路径、命令输出之外的系统信息或 Provider 凭据。

### 12.2 Runner 身份

推荐两阶段凭据：

1. Web UI 创建短时、一次性 enrollment token；
2. Runner 首次连接后换取可撤销、轮换的 device credential，或签发客户端证书。

所有连接必须 TLS。token 在数据库中只存 hash，并绑定 user、runner、过期时间和允许的 workspace scope。Runner 日志不得打印 token。撤销后 Server 关闭对应 stream，并使 generation 失效。

### 12.3 Workspace 与命令

- 一个 Runner 进程只服务启动时声明的一个 root，或显式且有限的 root 列表；
- 所有 cwd 与文件路径经过规范化、realpath 和 containment；
- 新文件的父目录也要验证符号链接边界；
- Windows 额外处理盘符、UNC、junction 和大小写；
- Shell env 使用 allowlist / denylist 清理，不转发 Server 环境；
- 输出、stdin、文件大小、并发和运行时长有硬上限；
- 审批不是 sandbox；只有 Runner 真正 enforce 后才上报 sandbox capability；
- 未实现的资源限制返回 `UNSUPPORTED`，不得静默忽略。

### 12.4 威胁与控制

| 威胁 | 控制 |
|---|---|
| 窃取 Runner token | TLS、短时 enrollment、hash 存储、轮换与撤销 |
| 用户访问他人 Runner | 每次 route 做 tenant + runner + binding 校验 |
| 路径逃逸 | Runner 原生 realpath / containment，Server 不自行判断 |
| 断线后重复副作用 | generation fencing，不自动重放 |
| Server 本机被工具访问 | 生产不加载 local FS / Shell，Server 无 workspace mount |
| 多副本双写 Session | lease + fencing，丢 lease 立即 cancel / dispose |
| 无限输出耗尽内存 | Runner、gRPC client、SSE 三层有界缓冲 |
| 伪造 sandbox | capability 只报告实际 enforce 的事实 |

## 13. 配置、发布与运维

### 13.1 Server 配置

配置名可以调整，但 owner 应保持清晰：

| 配置 | Owner |
|---|---|
| `PUBLIC_ORIGIN` | Web / HTTP 外部地址 |
| `DATABASE_URL` | PostgreSQL Provider 与产品 Store |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` | Auth 模块 |
| `COOKIE_SECRET` | HTTP Session |
| `HTTP_BIND` | Control Server HTTP listener |
| `GRPC_BIND` | Runner gRPC listener |
| `RUNNER_PUBLIC_ENDPOINT` | Web UI 生成连接命令 |
| `RUNNER_HEARTBEAT_MS` | RunnerRegistry |
| `RUNNER_ADMISSION_TIMEOUT_MS` | gRPC admission |
| `SESSION_IDLE_EVICT_MS` | AgentRuntimeRegistry |
| `SESSION_LEASE_TTL_MS` | SessionLeaseManager |
| `DSH_VERSION` | Build / release metadata，不在运行时浮动解析 |

凭据不进入前端 bundle、仓库、镜像层或 Runner 启动命令历史。Runner token 可通过 stdin、受限配置文件、系统 keychain 或一次性 device flow 交付。

### 13.2 健康检查

```text
/health/live   → 进程事件循环可响应
/health/ready  → DB 可用、DSH Composition 完成、HTTP / gRPC 已开始准入
```

ready 不要求至少一个用户 Runner 在线，否则没有连接 Runner 的空系统永远无法部署。Runner 在线状态属于产品 API，不属于 Server readiness。

### 13.3 安全关闭

部署滚动前：

1. readiness 变为 false，停止新消息和新 Runner admission；
2. RunnerRegistry 向 Runner 发送 drain；
3. AgentRuntimeRegistry cancel 活动 Agent；
4. 等待工具和 Agent 收敛；
5. flush Session；
6. dispose AgentHandle 与 Runtime Shard；
7. 结算 interaction；
8. 关闭 SSE、gRPC、HTTP 和数据库连接。

第一版单副本部署会中断在线任务，应把 drain timeout 和维护提示做成真实产品行为。多副本 handoff 在拥有明确 owner 路由前不承诺无中断。

### 13.4 观测

日志和指标使用稳定 id，不记录 prompt、文件内容、token 或完整命令输出：

- request id、conversation id、session id；
- runner id、generation、execution id；
- Agent status、turn / step、stop reason；
- gRPC queue depth、output bytes、backpressure、disconnect reason；
- Session append latency、flush latency、lease fencing；
- SSE subscriber count、replay count 和 lag；
- DSH package version、Runner protocol version。

## 14. DSH 依赖与零上游修改

### 14.1 依赖策略

DSH 当前仓库使用 MIT License，公开包版本为 `0.1.1-rc.2`。实现时应重新选择并精确锁定经过验证的版本：

DSH 不以复制源码的方式并入新项目。`packages/harness-runtime`、`packages/harness-plugin-host` 和各兼容包是产品拥有的集成边界，通过 `package.json` 依赖 DSH 公开 packages；Control Server 构建时把这些依赖和经过批准的插件统一打入镜像或 Server 插件仓库。这样开发机只分发 Remote Runner，DSH 升级也集中在一处完成。

- `package.json` 使用精确版本，不用 `^` 跟随 RC 漂移；
- 提交 lockfile；
- 只从 package root import；即使包暂时导出 `./src/*`，生产也不依赖内部源码路径；
- 不使用 `patch-package`、长期私有补丁或修改 `deepseek-harness-master/packages/**`；
- 完整上游仓库可以作为只读 Git submodule 或 sibling checkout，用于源码阅读与候选验证；
- 新项目不与 DSH monorepo 合并为同一个 pnpm workspace。

低成本跟随官方仓库不等于运行时自动追随最新版。每次升级仍精确锁定官方版本或 commit SHA，通过集成包编译、Composition 验证、官方插件兼容矩阵和跨平台 Runner canary 后再发布。若上游公开 Service 能力不足，优先向官方贡献通用 seam，不维护长期私有 fork。

如需跟踪尚未发布的 DSH commit，应在独立上游 workspace 构建并 pack 公开包，新项目只安装产物。

### 14.2 升级检查

```text
update exact DSH version / SHA
  → build public packages
  → integration packages compile
  → official / approved community plugin composition tests
  → fake-model runtime scenarios
  → PostgreSQL persistence conformance
  → real Linux / macOS / Windows Runner canary
  → old Session backward-read and recovery
  → production composition audit
  → manual release decision
```

CI 至少验证：

- 无 DSH 源码子路径 import；
- 生产组合没有 local FS / Shell / Subprocess；
- Agent create、followup、cancel、idle、dispose；
- Session create、append、flush、resume 和 crash repair；
- FS target、revision、guarded write / edit；
- Shell exit、timeout、cancel、truncation、disconnect；
- Runner 断线无本地 fallback；
- 候选 DSH 能读取受支持的历史 Session。
- 已支持的官方插件能够加载、执行、停止并正确释放 effect；
- Host-only 插件不会把 Client UI 依赖带入生产 Server；
- 插件没有绕过 Remote Service 访问 Server 本地 workspace。

## 15. 实施路线

### Phase 0：DSH 公开契约 Spike（3–5 天）

- 用公开 package 创建最小 Cordis Context；
- fake LLM 完成 create、followup、session event、cancel、dispose；
- 实现最小内存 Remote FS / Shell fake；
- 验证 PostgreSQL Backend 的最小原语；
- 原样加载一个官方 Host 插件和一个最小树外 Cordis 插件，验证 inject、effect 与 dispose；
- 冻结 DSH 版本和 Node 版本。

验收：不启动 DSH Web / CLI，也能通过自研入口完成一轮固定模型对话；无内部 import；上游零修改；dispose 后无悬挂资源。

### Phase 1：真实 gRPC Runner（1–2 周）

- 新建 Greenfield Proto，不复制 Nova package 或生成物；
- Rust Runner 完成注册、心跳、generation、前台 execution 和 cancel；
- 完成 Resolve、stat、lstat、read、list、guarded write / edit；
- 实现 DSH RemoteFileSystem 与 RemoteShellExecutor；
- 在 Linux、macOS、Windows 跑真实边界测试。

验收：三种平台都能由 DSH Agent 远程 list / read / edit / create / execute；并发修改不静默覆盖；断线不重放；Server 无本地 workspace 访问。

### Phase 2：公网 Server 与 Web UI（2–3 周）

- Auth、Project、Workspace Binding、Conversation；
- Runner enrollment、Registry、目录选择与状态 SSE；
- AgentRuntimeRegistry、Runtime Shard 和 Session lease；
- PostgreSQL DSH Persistence；
- Message POST、Session projection、SSE replay、cancel；
- Server Plugin Registry、精确版本 lockfile、允许列表与逻辑 profile；
- Nginx / TLS / gRPC 长连接部署。

验收：用户从公网 UI 登录、选择本机 Runner 与 workspace、发送 coding query，并看到 DSH 经 gRPC 读写真实 workspace；Server 重启可恢复已提交历史。

### Phase 3：交互与多机器体验（1–2 周）

- Approval / User Question InteractionBroker；
- Project 多 Workspace Binding；
- Conversation fork 到另一机器；
- Runner token 撤销、版本升级提示、drain；
- Git identity / branch / commit / dirty 状态提示。

### Phase 4：按产品需求扩展

- 后台进程和 job UI；
- Remote Skill Provider；
- PTY / Terminal；
- LSP；
- 多 Control Server / 独立 Runner Gateway；
- 更强 sandbox 和资源限制。

这些都不是首个“Browser → Server → DSH → gRPC → Remote Runner”闭环的前置条件。

## 16. 验收场景

### 16.1 核心闭环

1. Windows Runner 连接公网 Server，绑定 `D:\code\demo`；
2. 用户在 Web UI 创建 Conversation 并发送“读取 package.json，修改脚本并运行测试”；
3. DSH 在 Server 调用模型；
4. 文件读取、修改和测试命令全部通过 gRPC 到 Windows Runner；
5. Web UI 按顺序显示 user message、reasoning / assistant、tool、result 与 turn end；
6. Server 容器内没有该 workspace，也不能执行 fallback。

同一场景必须分别在 macOS 与 Linux Server Runner 上通过。

### 16.2 断线与恢复

- 执行期间断开 Runner：当前工具以 `RUNNER_UNAVAILABLE` 结算，不自动重放；
- Runner 重连：产生新 generation 和 Runtime Shard；
- 用户再次发送消息：从 PostgreSQL Session 恢复 Agent；
- 旧 target / execution / process handle 在新 generation 被拒绝；
- Web SSE 重连：历史投影与实时事件不重复、不丢失。

### 16.3 安全

- 用户 A 不能列出或选择用户 B 的 Runner；
- `..`、symlink、junction、UNC 等越界被 Runner 拒绝；
- 撤销 token 后长连接断开；
- 未实现 sandbox 的 Runner 不显示或接受 sandboxed 执行；
- Control Server 文件系统上没有任何产品代码 workspace；
- 日志中不出现 OIDC token、Runner token、模型 key 或文件内容。

### 16.4 插件兼容

- Server 安装并加载受支持的官方 Host 插件，开发机不安装 DSH 或该 npm 包；
- 同一插件在 macOS 与 Windows Runtime Shard 中分别操作各自 workspace，不发生串路由；
- 插件 stop、update、Runner disconnect 和 Shard dispose 后，注册的 Tool、Event 与资源 effect 全部撤销；
- 直接调用 Node `fs` 的测试插件不能接触用户 workspace，并被兼容性检查标记为需要适配；
- 带 DSH Client UI 的插件能够继续使用 Host 能力，但 UI 部分明确显示为 unsupported 或由产品 Adapter 接管。

## 17. 风险与 Go / No-Go

| 风险 | 控制 |
|---|---|
| DSH RC API 变化 | 精确锁版本、公开 export、升级契约 CI |
| DSH Session 格式变化 | 保留原始事件、backward-read canary、版本记录 |
| Remote FS 难以满足原子语义 | Runner 内 revision + 同临界区 compare-and-write |
| Windows / POSIX 路径混淆 | Server 不解释路径，Runner 返回 opaque target 与 process path |
| Runner 断线命令结果未知 | generation 失效，不自动重放副作用 |
| Context 串到另一 Runner | generation 对应独立 Runtime Shard |
| 多 Server 双写 | 第一版单副本；扩容前实现 lease、fencing 和 owner 路由 |
| DSH local provider 绕过远程边界 | 代码式组合、启动审计、Server 不挂载 workspace |
| 公网 DSH Web 暴露本地能力 | 不部署 DSH Web，全新产品协议与 Auth |
| 社区插件直接访问 Server OS | 允许列表、静态/运行时审计、隔离执行、禁止本地 workspace fallback |
| 插件把请求路由到错误机器 | 每个 generation 独立 Shard / Context，禁止全局 `currentRunner` |
| DSH Client 插件无法在自研 Web 运行 | 分级兼容，Host 优先，稳定 UI Contribution 协议与按需 Adapter |

正式开发前的 Go 条件：

- [ ] 公开 package root 足以组装所需 Runtime；
- [ ] 自研 Server 能通过 `ctx.agents` 完成多轮、取消和 dispose；
- [ ] PostgreSQL Backend 通过 append、flush、resume 和 repair 测试；
- [ ] Remote FS 通过 target、revision、原子写和路径安全测试；
- [ ] Remote Shell 通过非零退出、超时、取消、截断和断线测试；
- [ ] Linux、macOS、Windows 真实 Runner 均通过；
- [ ] Runner generation 失效可完整清理对应 Shard；
- [ ] 生产组合中不存在本地 workspace Provider；
- [ ] 至少一个官方 Host 插件无需修改即可在 Server 加载并通过 Remote Service 操作 Runner；
- [ ] 插件安装具备精确版本、完整性校验、允许策略、审计和可回滚能力；
- [ ] 团队接受 DSH 的 Agent、Session、Tool、Approval 和 Compaction 语义。

若 DSH 公开 seam 无法满足前三项，不应通过长期私有 patch 绕过。应先向上游贡献通用扩展点，或重新评估 DSH 版本与依赖策略。

## 18. 最终推荐

新项目的推荐组合是：

> **全新 Web UI + 全新 Control Server + `packages/` 内的 DSH/Cordis 集成与插件宿主 + 自有最小 Runtime Composition + PostgreSQL Session Persistence + 自有 Remote FS / Shell 兼容 Service + 全新 gRPC 协议 + 不含 DSH 的跨平台 Rust Remote Runner。**

Nova 只提供产品体验和架构思想参考：公网聊天入口、Server 控制面、Runner 主动出站连接、真实远程执行边界。新项目不依赖 Nova package、数据库、Proto、Runner binary 或内部类型。

第一条生产纵向链路应严格证明：

```text
用户打开公网 Web
  → 登录并选择某台机器的 workspace
  → query 进入 Control Server
  → Server 内 DSH Agent 决策
  → DSH 产生 fs / shell tool call
  → Remote Provider 通过 gRPC 请求指定 Runner generation
  → Runner 在真实 workspace 执行
  → DSH Session Event 持久化
  → 产品投影通过 SSE 回到 Web UI
```

这条链路成立后，服务器、macOS 和 Windows 只是同一 Remote Runner 协议下的不同执行世界，不需要三套 Agent 或三套 Server 实现。

最终产品承诺应表述为：**DSH 核心能力和 Host 插件集中部署在云端 Server，开发机只安装轻量 Remote Runner；新项目通过稳定的内部 integration packages 跟随 DSH 官方升级，并以 DSH 公开 Cordis Service 为兼容面，优先做到官方与社区 Host 插件低成本接入。**

## 19. 本地参考资料

DeepSeek Harness：

- `deepseek-harness-master/package.json`
- `deepseek-harness-master/LICENSE`
- `deepseek-harness-master/docs/architecture.zh.md`
- `deepseek-harness-master/docs/agent-lifecycle.zh.md`
- `deepseek-harness-master/docs/capability-seams.zh.md`
- `deepseek-harness-master/docs/cordis-primer.zh.md`
- `deepseek-harness-master/docs/cordis-tutorial/07-into-the-harness.zh.md`
- `deepseek-harness-master/docs/api-gateway.zh.md`
- `deepseek-harness-master/docs/subsystems/web-server.zh.md`
- `deepseek-harness-master/docs/subsystems/session.zh.md`
- `deepseek-harness-master/docs/subsystems/session-projection.zh.md`
- `deepseek-harness-master/docs/subsystems/filesystem.zh.md`
- `deepseek-harness-master/docs/subsystems/shell.zh.md`
- `deepseek-harness-master/docs/subsystems/subprocess.zh.md`
- `deepseek-harness-master/docs/subsystems/approval.zh.md`
- `deepseek-harness-master/docs/subsystems/user-questions.zh.md`
- `deepseek-harness-master/packages/core/agent/src/index.ts`
- `deepseek-harness-master/packages/core/agent/src/runtime-types.ts`
- `deepseek-harness-master/packages/examples/agent-spine-demo/src/index.ts`
- `deepseek-harness-master/packages/session/session-persistence/src/coordinator.ts`
- `deepseek-harness-master/packages/fs/fs/src/index.ts`
- `deepseek-harness-master/packages/shell/shell/src/index.ts`
- `deepseek-harness-master/packages/sdk/server/src/server.ts`
- `deepseek-harness-master/packages/sdk/server/README.zh.md`
- `deepseek-harness-master/packages/bundle/web-app/README.zh.md`
- `deepseek-harness-master/packages/bundle/README.zh.md`
- `deepseek-harness-master/apps/cli/README.zh.md`
- `deepseek-harness-master/packages/host/webserver/README.zh.md`
- `deepseek-harness-master/packages/client/connection/README.zh.md`

架构思想参考，不是依赖：

- `docs/runner.md`
- `docs/runner-sdk.md`
- `docs/proto.md`
- `docs/agent-server.md`
- `docs/agent-web-ui.md`
