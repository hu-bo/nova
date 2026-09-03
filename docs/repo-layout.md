# Nova Repo Layout

> 本文档只负责一件事：**敲定仓库结构、模块职责和依赖方向**。
>
> 不包含：具体 API 设计、数据模型字段、协议消息定义、实现细节。
> 这些在本文档确认后，按模块拆分为独立文档。

---

## 1. 目的

本文档是 `docs/idea.md` 的收敛结果。`idea.md` 是设计意图，本文档是**结构契约**。
当两者冲突时，以本文档为准。第 6 节记录了所有相对 `idea.md` 的调整及理由。

本文档确认后已按模块拆出**契约文档**（API 面、字段、状态机、协议消息），见 [README.md](./README.md)。
分工：结构问题以本文档为准，API / 字段问题以模块文档为准。
模块文档中相对本文档的调整，各自在"相对 repo-layout 的调整"一节写明理由。

要回答的问题：

1. 仓库里有哪些模块？
2. 每个模块负责什么、**不负责**什么？
3. 谁依赖谁？哪些依赖被禁止？
4. 哪些是进程边界，哪些只是模块边界？
5. 第一版做什么，什么留到后面？

---

## 2. 顶层结构

```text
nova/
├── apps/
│   ├── agent-server/            # Control Plane：HTTP + SSE + 鉴权 + 持久化 + Runner Registry
│   ├── agent-web-ui/            # React 前端（Chat 组件内联，不单独拆包）
│   ├── model-gateway/           # Model Provider 网关：密钥托管 / 计费 / 配额（Phase 2）
│   └── model-gateway-client/    # 网关管理后台 UI（Phase 2，不在推理数据路径上）
│
├── packages/
│   ├── agent-core/              # Agent Loop / Context / Session / Decision / Sub-agent
│   ├── harness/                 # 可信 AgentModule 的静态组合与故障隔离
│   ├── coding-agent/            # Coding Prompt + 默认 Coding Tool 场景模块
│   ├── taskflow/                # Task 图 + 有界并发 + retry / timeout / cancel
│   ├── tools/                   # Tool 定义与实现（RunnerTool / RemoteTool）
│   ├── model-adapters/          # 抹平 provider 差异，产出统一流式事件
│   ├── chat-ui/                 # Chat 组件与受控 RemoteExplorer（无网络、无全局状态）
│   ├── runner-sdk/              # Node.js / TypeScript ↔ Rust Runner 技术桥梁
│   └── protocol/                # 浏览器 ↔ agent-server 的 HTTP + SSE 契约（纯类型）
│
├── casdoor/                     # @hquant/casdoor —— 已有的外部共享库，不属于 nova 模块划分
│
├── proto/                       # gRPC 契约（agent-server ↔ Runner），TS/Rust codegen 源
│   ├── common.proto
│   ├── execution.proto
│   └── runner.proto
│
├── crates/
│   └── runner/                  # Execution Plane（单 crate，内部分模块）
│
├── tests/
│   ├── integration/             # agent-core + 真实 Rust Runner（不启 server）
│   └── e2e/                     # web-ui + agent-server + 全链路
│
└── docs/
```

### 与 idea.md 的结构差异一览

| idea.md | 本文档 | 理由 |
|---|---|---|
| `apps/model-gateway` | 保留，Phase 2 | 6.2 |
| `apps/model-gateway-client` | 保留（管理后台 UI，不在数据路径上） | 6.2 |
| `packages/events` | **删除** | 6.4 |
| `packages/chat-ui` | **保留独立成包** | 6.5 |
| Runner 相关 package | **只保留 `packages/runner-sdk`** | 6.1 |
| `crates/runner/{server,execution,scheduler,...}` | 单 crate + 内部模块 | 6.7 |
| Runner 的同机与跨机运行 | **统一为真实 RPC / process boundary** | 6.3 |
| `agent-core/{planner,verification}` | **降级为 prompt 资产** | 6.11 |
| agent-core 无 session / queue / decision | **补齐** | 6.12 |

---

## 3. 依赖方向

箭头即允许的 import 方向，**反向 import 一律视为设计错误**。

```text
apps/agent-server / CLI / tests (Composition Root)
  ├──► packages/coding-agent ──► packages/harness ──► packages/agent-core
  │             └──────────────► packages/tools - -type- -► agent-core
  ├──► packages/runner-sdk - -type- -► agent-core
  │             └──────────────► proto generated types
  └──► model / storage / decide / ToolContext providers

packages/agent-core ──► taskflow
                    └─► model-adapters ──HTTP/SSE──► provider-compatible endpoint

crates/runner ──outbound persistent gRPC──► packages/runner-sdk

apps/agent-web-ui ──► packages/chat-ui - -type- -► packages/protocol
apps/model-gateway-client ──HTTP──► apps/model-gateway   (future management path)
```

### 3.1 硬性禁令

| 禁止 | 原因 |
|---|---|
| `tools` 运行时依赖 `agent-core` | 会形成运行时耦合；只允许 type-only 使用 `AgentTool` / `ToolContext` 契约 |
| `taskflow` → 任何 nova 内部包 | 纯调度器，不认识 Agent / Tool / Runner |
| `agent-core` → `runner-sdk` | Agent 不知道传输方式。执行能力经 `ToolContext` 注入 |
| Tool / Host 使用 `node:fs`、`node:child_process` 或 LocalShell 执行 Workspace 操作 | Remote Runner 是唯一执行平面；生产 `ToolContext` 只能由 `runner-sdk.toToolContext` 创建 |
| `runner-sdk` 承担 Registry / 调度 / 用户权限 | SDK 只是技术桥梁，Control Plane 归 Runner Module |
| `agent-core` → `casdoor` | **Agent 不认识 User**。只持有 `userId: string` |
| `agent-core` / `harness` / `coding-agent` / `taskflow` / `tools` → `protocol` | UI 契约不得渗入运行时 |
| `crates/runner` 认识 Conversation / Message / Prompt / Task 语义 | Runner 只认识 Execution |
| `agent-core` / `model-adapters` → `model-gateway-client` | 管理后台不在推理数据路径上 |
| `model-gateway` → 任何 nova 内部包 | 它是独立服务，只暴露 provider 兼容接口 |
| `protocol` 引入运行时依赖 | 必须纯类型，浏览器可直接消费 |
| `protocol` re-export `proto/` 类型 | 两个契约面独立演进 |
| `chat-ui` → `agent-server` / `agent-core` / 任何运行时包 | 它只认识 `protocol` 的 Block 类型 |
| `chat-ui` 内出现 fetch / EventSource / 路由 / 全局 store | 那是宿主应用的职责，见 4.8 |

### 3.2 两个 "protocol" 的区分

| | `proto/` | `packages/protocol/` |
|---|---|---|
| 边界 | 进程边界（agent-server ↔ Runner） | 浏览器边界（web-ui ↔ agent-server） |
| 传输 | gRPC + Protobuf | HTTP + SSE + JSON |
| 内容 | ExecuteRequest / ExecutionEvent / FileOp / Register | ChatMessage / Block / UI Event / Decision / REST schema |
| 跨语言 | 是（TS + Rust） | 否 |

**互不 import。** UI 要展示 Execution 输出时，由 agent-server 做 Projection。

---

## 4. 模块职责

每个模块给出：**负责 / 不负责 / 对外 API 面 / 依赖**。
"对外 API 面"是硬约束，超出的不许 export。

### 4.1 `packages/agent-core`

Agent 是**决策层**。这是本仓库最厚的一个包，结构如下：

```text
packages/agent-core/
├── agent.ts              # 公开面
├── loop/
│   ├── loop.ts           # Turn 循环：model → tool batch → observe → 续跑判定
│   ├── tool-batch.ts     # sequential/parallel、per-tool override、terminate 规则
│   └── hooks.ts          # beforeToolCall / afterToolCall / shouldStopAfterTurn / prepareNextTurn
├── decision/             # 审批 + 反问的统一挂起机制（见 4.1.4）
├── queue/                # steering / follow-up / next-run 三队列与排空点
├── context/
│   ├── budget.ts         # context window、输出与安全空间预算
│   └── compaction.ts     # 请求视图精简、中段摘要与省略
├── session/
│   ├── entry.ts          # 会话内容流（进模型上下文）
│   ├── record.ts         # 运行事实流（不进上下文）
│   ├── tree.ts           # fork / navigate / resume
│   └── storage.ts        # 存储接口（agent-server 提供 PG 实现）
├── prompts/              # system prompt 组装、skills、templates、环境信息注入
├── sub-agent/            # 派生、并发上限、token 预算 owner
└── types.ts              # AgentEvent / AgentTool / ToolContext / Result
```

**负责**

- Turn 循环：组装上下文 → 调模型 → 执行 tool batch → 观察 → 判定是否续跑
- 上下文生命周期：预算、压缩、截断
- 会话状态：Entry / Record 两条流、树、fork / resume
- 人类介入：审批与反问的统一挂起与恢复
- 三条消息队列：steering / follow-up / next-run
- Sub-agent 派生及其并发与 token 预算
- 注册 AgentTool（`spawn_agent` / `delegate_task` / `ask_user`）

**不负责**

- 进程管理、资源限制、Shell 生命周期
- Runner 注册、心跳、连接管理
- 传输方式（HTTP / gRPC / SSE 一概不知）
- **用户身份与登录**（只持有 `userId: string`）
- UI 文案

**对外 API 面**

```ts
createAgent(config): Agent

agent.prompt(input): Promise<RunResult>
agent.steer(msg): void          // 运行中插话，当前 turn 的 tool 跑完后注入
agent.followUp(msg): void       // agent 准备停下时注入，让它继续
agent.nextRun(msg): void        // 排到下一个独立 run
agent.abort(): Promise<void>
agent.compact(opts?): Promise<CompactionResult>
agent.fork(entryId): Promise<Agent>
agent.resume(): Promise<void>   // 崩溃 / 重启后续跑

agent.state: {
  isStreaming, streamingMessage, pendingToolCalls,
  pendingDecision, model, thinkingLevel, activeTools, errorMessage
}
agent.subscribe(listener): Unsubscribe
```

不暴露 loop / context / session 内部对象。

**依赖**：`taskflow`、`model-adapters`。不依赖 tools、runner-sdk、proto、Harness 或任何应用层包。

**关键约束**

- 必须能在**不启动 agent-server** 的情况下跑通 `Plan → Execute → Observe → Verify → Result`
- Sub-agent 的并发上限与 token 预算 owner 在 agent-core，不在 taskflow

---

#### 4.1.1 Turn 与 Tool Batch

一个 turn = 一条 assistant message + 它请求的全部 tool calls + 对应结果。

- 同一条 assistant message 里的多个 tool call 支持 `sequential` / `parallel`，默认 `parallel`
- Tool 可用 `executionMode` 单独覆盖（如写文件类必须 sequential）
- 文件修改经**串行队列**去重，防止并行 tool 写同一路径
- `terminate` 提示：只有 batch 内**每个**结果都置 `terminate` 时才提前结束

> **这是真实并行度的来源，且用不上 DAG。** 参见 4.2 TaskFlow 的退出条件。

Turn 之间可变的状态（都要落 session Entry）：`model`、`thinkingLevel`、`activeTools`。
由 `prepareNextTurn()` 返回替换值；`shouldStopAfterTurn()` 可请求优雅停止。

#### 4.1.2 Tool Result 的双面性

```ts
interface AgentToolResult<T> {
  status: "ok" | "error"                    // Tool 自己声明真实结果
  content: (TextContent | ImageContent)[]  // 喂模型，要截断省 token
  details: T                               // 给 UI，完整可展开
  usage?: Usage
  terminate?: boolean
}
```

**`content` 与 `details` 必须从第一天就分开。** 两者裁剪策略完全不同，混在一起后期极难拆。

#### 4.1.3 上下文生命周期

| 关注点 | 内容 |
|---|---|
| 预算 | 从最近一次 assistant usage 估算 context tokens，对比 model 的 context window |
| 压缩触发 | `manual`（用户主动）/ `threshold`（超过比例）/ `overflow`（provider 报超限） |
| 压缩过程 | 选择合法 cut point → 生成摘要 → 写入 `CompactionEntry` → 重算 usage；摘要失败要重试 |
| 输出截断 | 单个 tool 输出（尤其 `bash`）必须有上限。截断策略在 agent-core，不在 tools |

> 长会话跑不下去，90% 的原因在这一组。

#### 4.1.4 Decision — 审批与反问的统一机制

**审批**（agent 要执行危险 tool）和**反问**（agent 需要用户决策）流程同构：
挂起 → 发出请求 → 等人类 → 恢复。**只做一套。**

```ts
type DecisionRequest =
  | { kind: "approval"; decisionId; toolCallId; toolName; args; risk }
  | { kind: "question"; decisionId; question; options: Option[]; multiSelect }

type DecisionResponse =
  | { kind: "approval"; decision: "allow" | "deny" | "allow_always"; reason? }
  | { kind: "question"; answers: string[] }

// agent-core 只依赖这一个注入回调
type Decide = (req: DecisionRequest, signal: AbortSignal) => Promise<DecisionResponse>
```

**触发点**

| 来源 | 触发 |
|---|---|
| 审批 | `beforeToolCall` 钩子按策略判定需要人工确认 |
| 反问 | agent 调用内置 `ask_user` tool（由 agent-core 注册，不在 `packages/tools`） |

**注入实现**

| 场景 | 实现 |
|---|---|
| 集成测试 / CLI | 自动策略：按 tool 白名单放行；问题走预设默认答案 |
| agent-server | 推 SSE → 挂起 run → 等 HTTP 回填 → 恢复 |

这保证了**无 server 也能完整跑通**，满足核心约束。

**审批策略（保持简单）**

- 三档：`auto` / `ask` / `deny`，按 tool name 配置 + 一个默认档
- 默认：只读工具（`read_file` `grep` `list_dir`）→ `auto`；写工具与 `bash` → `ask`
- `allow_always` 写入 **session 级** allowlist，第一版不跨 session 持久化

**超时与取消**

- 等待人类输入必须有 timeout，超时默认动作 **fail-closed（deny）**
- 等待期间收到 abort，要能干净退出并落 record

**落 Entry 还是 Record**

| 事件 | Record | Entry |
|---|---|---|
| 审批请求发出 | ✅ | ❌ |
| 审批通过 | ✅ | ❌ 模型不需要知道 |
| 审批**拒绝** | ✅ | ✅ 模型必须知道被拒，避免重试 |
| 反问的问题与答案 | ✅ | ✅ 属于对话的一部分 |

**挂起状态必须落 record**，否则 server 重启或断线后无法恢复。

#### 4.1.5 Session — 两条正交的流

| | Entry（会话内容，进模型上下文） | Record（运行事实，不进上下文） |
|---|---|---|
| 内容 | `Message` `ModelChange` `ThinkingLevel` `ActiveTools` `Compaction` `Decision(部分)` | `OperationStarted` `StepAttempt` `ToolStarted` `QueueEnqueued` `DecisionRequested` `DecisionResolved` `Usage` `AbortRequested` `OperationFinished` |

这是 idea.md "Message ≠ Event" 原则在 agent-core 的落地。

还需要：会话树的 `fork` / `navigate` / `resume`；崩溃后依据 Record 判定从哪一步续跑。

**存储接口定义在 agent-core，实现由外部提供**：

- 集成测试 / CLI → 内存或 JSONL 实现
- agent-server → PostgreSQL + Drizzle 实现

否则 agent-core 会被 server 绑死，违反核心约束。

#### 4.1.6 错误契约

两条硬规矩，跨进程时尤其关键：

- **`StreamFn` 不得 throw**。模型 / 网络失败编码进流，以 `stopReason: "error" | "aborted"` + `errorMessage` 收尾
- **`ToolContext` 的 fs / exec 面不得 throw**。返回 `Result<T, E>`，错误带 typed code

理由：跨进程失败是常态而非异常。throw 会打断 loop 的正常事件序列，让 UI 卡在半截状态。

#### 4.1.7 ToolContext — 执行环境

Tool 不直接依赖 `runner-sdk`，而是接收一个窄接口。**必须有 fs 与 exec 两个面**：

```ts
interface ToolContext {
  fs: {                                    // 文件操作不得靠拼 shell 命令
    readTextFile, readTextLines, readBinaryFile,
    writeFile, appendFile, renameFile,
    fileInfo, listDir, exists, canonicalPath,
    createDir, remove, createTempDir, createTempFile,
    cwd
  }
  exec(command, opts): Promise<Result<ExecOutput, ExecutionError>>
  signal: AbortSignal
}
```

> **联动点**：这要求 `proto/execution.proto` 除 `Execute` 外还要有文件操作 RPC 面。
> 若只有 `command / args`，`read_file` 就只能拼 `cat`——不可接受。

由 agent-server / 集成测试在组装时注入。这是真实变化点（测试注入 fake、生产注入 Runner），不是为抽象而抽象。

#### 4.1.8 `packages/harness` 与 `packages/coding-agent`

`harness` 是可信内部 `AgentModule[]` 的静态组合层：创建时一次性校验并冻结 Tool、Prompt、Guard、Observer 快照；Guard 只能收紧审批，Observer 故障彼此隔离。它只依赖 `agent-core`，返回原始 `Agent`，不认识 Server、HTTP、SSE、Protocol 或 UI。

`coding-agent` 只导出 `codingAgentModule`，直接选择 `packages/tools` 的 8 个现有 Tool 并贡献唯一的 `coding-workflow` Prompt。它不创建第二套 Agent，不依赖 runner-sdk，也不读取项目文件。项目绑定的 `AGENTS.md` / `CLAUDE.md` 或自定义提示词、模型、Storage、Decision 和由 runner-sdk 生成的 `ToolContext` 都由 Host 按 Agent 实例注入；workspace 文件只能经 Runner 读取。

未来 Server 以 `Agent.subscribe()` 作为事件投影入口；未来 Chat UI 只消费 Server Projection，并通过实例级 `renderers` 扩展渲染。两者都不反向进入 Harness 或 Coding Module。

---

### 4.2 `packages/taskflow`

TaskFlow 是**编排层**，且只是编排层。

**负责**：Task 与依赖（DAG）、动态追加 Task、Ready Queue + 有界并发、Retry、Timeout、Cancellation 传播、Task/Execution 状态机、Task 级事件流。

**不负责**：LLM 推理、Prompt、Message、Tool 语义、Runner 的存在、Provider 级重试、持久化。

**对外 API 面**

```ts
createFlow(options): Flow
flow.addTask(task): TaskId
flow.run(): AsyncIterable<TaskEvent>
flow.cancel(taskId?): void
```

**依赖**：无内部依赖。纯调度器，可独立单测。

**第一版不做**：Workflow DSL、BPMN、表达式引擎、分布式 Scheduler、持久化 DAG Engine。

**复核结论（2026-08-17，agent-core 开工前定案）**

TaskFlow 是本仓库**风险最高的抽象**。原退出条件：若 agent-core 只用得上
"一批 tool call 并发 + 等全部完成"，则合并进 agent-core 并删除。

**结论：保留。** agent-core 的 tool batch 与 Sub-agent 并发执行复用本包
（`createFlow`），不再自写信号量/队列/状态机——tool batch 有结果按原序回填、
按路径串行、整批 terminate 判定等真实调度语义，不是单纯的并发批处理。
详见 `taskflow.md` §8 / §8.1。

---

### 4.3 `packages/tools`

**负责**：参数 schema 与校验、执行语义、返回结构化的 `AgentToolResult`（见 4.1.2）。

本包保留全部 Tool 定义，但不在 Node.js 本地执行 FS / OS / Git / Shell 操作。所有 RunnerTool 必须调用 `ToolContext`，其生产实现由 Host 通过 `runner-sdk.toToolContext(RunnerSession, ...)` 注入，最终请求 Remote Rust Runner。Runner 断开时返回 typed error，不允许降级到本机执行。

| 类型 | 例子 | 落点 |
|---|---|---|
| RunnerTool | `bash` `read_file` `write_file` `grep` `git_diff` | `packages/tools` |
| StateTool | `todo_write` | `packages/tools`；不访问 FS / OS |
| RemoteTool | `web_search` `github` `jira` | `packages/tools` |
| AgentTool | `spawn_agent` `delegate_task` `ask_user` | **`agent-core`**，不在此包 |
| CompositeTool | 多 Tool / Model 组合 | Phase 3 |

**不负责**：Planning、Task DAG、Retry policy、Runner 调度、输出截断策略、UI 文案。

**依赖**：仅 type-only 使用 `agent-core` 的 `AgentTool` / `ToolContext` 契约；运行时不依赖 core，也不依赖 proto 或 runner-sdk。

---

### 4.4 `packages/model-adapters`

**负责**：使用原生 `fetch` 与 SSE 解析抹平 OpenAI-compatible / Anthropic 差异；输出统一流式事件（text delta / thinking / tool call / usage / finish）；**Provider 级**重试与 typed context overflow；模型能力声明。

**不负责**：Prompt 构造（属 agent-core/prompts）、Execution 级 retry（属 taskflow）、账号 / 计费 / 路由（属未来的 model-gateway）。

**约束**：`model-gateway` 上线后，对 agent-core 表现为**本包内的一个 provider 实现**（`direct` / `gateway` 二选一），不新增调用层。详见 4.11。

---

### 4.5 `packages/runner-sdk`

Node.js / TypeScript 与 Rust Runner 之间的技术桥梁。

**负责**：接收 Runner 主动建立的持久双向 gRPC 流；协议 codegen；按
`request_id` / `execution_id` 关联请求与事件；暴露 execute / cancel / fs 的
Runner Session；处理背压、断连和协议错误。

**不负责**：Registry、调度、用户权限、业务重试、Agent / Task 语义、Runner 进程启动或二进制分发。

```ts
createRunnerSdk(options): RunnerSdk
sdk.onSession(candidate => runnerModule.admit(candidate))
session.execute(req): AsyncIterable<ExecutionEvent>
session.cancel(executionId): Promise<void>
session.fs: FileSystemOps
```

SDK 不拥有 Registry、Scheduler、Gateway 或业务 Service 抽象。

---

### 4.6 `apps/agent-server/src/modules/runner`

agent-server 内的 Runner Control Plane 业务模块。

**负责**：Runner 身份接纳与用户权限；Registry 和心跳状态；Runner 选择与调度；
draining / disconnected 生命周期；将选定的 Runner Session 组装为上层的执行能力。

**不负责**：进程执行、Workspace / Filesystem / Sandbox；gRPC 帧处理；Agent 决策；TaskFlow retry policy。

Runner Module 依赖 Runner SDK，反向依赖禁止。它不拥有第二套传输或执行实现。

---

### 4.7 `packages/protocol`

浏览器 ↔ agent-server 的唯一共享契约。

**负责**：`ChatMessage` / `Block` 类型；SSE 事件类型（含 `decision.requested` / `decision.resolved`）；REST 请求响应 schema。

**不负责**：任何运行时逻辑；转发 gRPC / proto 类型。

**硬约束**：零运行时依赖（schema 校验库除外），浏览器可直接 import。

---

### 4.8 `packages/chat-ui`

Block 渲染组件库。**纯展示：无网络、无存储、无全局状态。**

**负责**

- Block 渲染器：`Text` / `Thinking` / `Code` / `ToolCall` / `ToolResult` / `Diff` / `File` / `Todo` / `Error`
- Decision 交互组件：审批卡片、反问选项（对应 4.1.4 的 `DecisionRequest`）
- 消息列表与流式增量渲染
- 实例级 `renderers?: BlockRenderers`：宿主显式注入自定义 block 渲染器

**不负责**

- SSE / HTTP 连接、重连、订阅
- 状态管理、持久化、路由
- 鉴权、业务编排
- 应用外壳（导航、布局、设置页）

以上全部属于宿主应用（`agent-web-ui`）。

**对外 API 面**

```tsx
<MessageList messages={ChatMessage[]} renderers?={BlockRenderers} onOpenPath?={callback} />
<BlockView block={Block} renderers?={BlockRenderers} onOpenPath?={callback} />
<DecisionPrompt request={DecisionRequest} onResolve={(r: DecisionResponse) => void | Promise<void>} />
```

**所有交互通过 props 回调上抛，组件自己不发请求。** 这是"纯展示"的可检验定义。

**依赖**：React + `packages/protocol`（type-only）+ Markdown / 代码高亮所需的纯渲染库。**零网络、零存储。**

不提供全局渲染注册函数；实例级 `renderers` 是唯一覆盖入口，避免全局状态与 props 两套机制并存。

**为什么独立成包**

"未来可能复用"是推测性理由（CLAUDE.md Rule 18 提示避免）。**当下就成立的理由是边界强制**：
独立包让 chat-ui 在物理上够不到 agent-server 内部和 agent-core 运行时，只能消费
`protocol` 定义的 Block 类型。这把 idea.md 第 26 节"UI 消费 Projection，而非内部状态"
从一条约定变成一条编译期约束。

未来接入 TUI / VSCode 插件 / 可嵌入组件时的复用是附带收益，不是主要理由。

**防腐规则**（防止它退化成第二个 `agent-web-ui`）

1. `package.json` 的运行时依赖只允许 React、`protocol` 和无副作用的内容渲染库；新增网络、状态或存储依赖视为越界
2. 不得 import 任何 nova 运行时包（`agent-core` / `agent-server` / `tools` / …）
3. 组件内不得出现 `fetch` / `EventSource` / `localStorage` / 全局 store

三条中任何一条被打破，说明职责划错了，应先修边界而不是加依赖。

---

### 4.9 `apps/agent-server`

Control Plane / Host / **Composition Root**。

**负责**

- HTTP API + SSE 端点
- **登录鉴权**（见 4.9.1）
- 托管 agent-core 与 taskflow 运行时
- 组装依赖：注入 `ToolContext`、注入 `Decide` 实现、选择 Runner、提供 SessionStorage 的 PG 实现
- Runner Registry：注册 / 心跳 / 状态（Ready / Busy / Draining / Disconnected）
- 持久化：Conversation / Entry / Record / Task / Execution / Runner / Artifact
- **Projection**：内部 Agent / Task / Execution 事件 → `protocol` 定义的 UI 事件

**不负责**：Agent 决策逻辑、调度逻辑、执行。

**技术栈**：Fastify + PostgreSQL + Drizzle ORM

> agent-server **不是** Agent Runtime 的前置依赖。它是 Host / Composition Root，是"另一个入口"。

第一阶段**不拆分**为 `taskflow-server` / `execution-server` / `runner-server`。
拆分触发条件：独立扩缩容、独立故障域、TaskFlow 成为通用基础设施、Runner 规模化、Scheduler 独立化。

#### 4.9.1 鉴权

基于已有的 `@hquant/casdoor`。**只做登录鉴权，不做细粒度权限模型。**

```text
web-ui ──@hquant/casdoor/client/react──► auth-service ──► Casdoor
   │                                          ▲
   │  Bearer token                            │ verifyToken
   ▼                                          │
agent-server ──@hquant/casdoor/server─────────┘
```

- Casdoor endpoint / clientId / secret / 证书全部留在 auth-service，Nova 只需 `appName`
- agent-server 用 `createCasdoorServer()` + `verifyToken()` 校验 Bearer token
- 校验通过后取 `userId`，作为 session metadata 传给 agent-core
- **注意**：`@hquant/casdoor/server` 只导出 Express / Koa middleware。Nova 用 Fastify，需自行写一个 preHandler 调 `verifyToken()`（十几行，不新增包）

**边界**

| | |
|---|---|
| 鉴权（你是谁） | agent-server，Casdoor |
| 授权（能不能做这个操作） | **第一版不做** |
| 工具审批（这次执行要不要放行） | agent-core 的 Decision 机制（4.1.4），与登录无关 |

**agent-core 永远不认识 User**，只持有 `userId: string`。脱离 server 运行时该值为 `"local"`。

---

### 4.10 `apps/agent-web-ui`

**负责**：用户 query 入口、路由与应用外壳、**SSE 订阅与状态管理**、鉴权接入、Task / Execution 可视化编排。

**约束**

- Chat 与 Block 渲染由 `packages/chat-ui` 承担，本 app 不重复实现渲染逻辑
- 只消费 `packages/protocol`（type-only）+ `packages/chat-ui` + `@hquant/casdoor/client/react`
- 只处理 `ChatMessage.blocks[]`，**不从 Markdown 解析结构**
- **一切副作用的 owner 在这里**：SSE 连接、审批 / 反问的回填请求、持久化。chat-ui 只通过回调上抛意图

---

### 4.11 `apps/model-gateway`（Phase 2）

统一的 Model Provider 网关。**它是一个独立服务，不是 Nova 的内部模块。**

**负责**

- Provider 密钥托管（业务侧不再持有 OpenAI / Anthropic / DeepSeek / MiniMax 的密钥）
- 模型注册与映射：对外暴露统一模型名，对内路由到具体 provider
- 用量计量、计费、配额与限流
- 对外提供 **OpenAI / Anthropic 兼容接口**

**不负责**

- Prompt 构造、Agent 语义、会话状态
- Execution / Runner 相关的一切

**技术栈**：Fastify + PostgreSQL + Drizzle ORM（结构遵循 `Fastify.md` 的 Use Case 组织方式）

**依赖**：无 nova 内部包。它对 Nova 是一个外部 provider。

**关键约束**

它对 agent-core 表现为 `packages/model-adapters` 内部的**一个 provider 实现**，调用层级不增加：

```text
Phase 1   agent-core → model-adapters ──HTTP/SSE──► provider-compatible endpoint
Phase 2   agent-core → model-adapters ──gateway──► model-gateway → provider

❌ agent-core → model-adapters → <某个 gateway client 包> → model-gateway
```

`direct` 与 `gateway` 是 `model-adapters` 内的两种 provider 实现，由配置选择。
**不允许**为 gateway 单独新增一个客户端包——那会退化成 pass-through。

---

### 4.12 `apps/model-gateway-client`（Phase 2）

model-gateway 的**管理后台前端**。与 `agent-web-ui` 平级，都是 React 应用。

**负责**

- 配置 provider 凭据（OpenAI / Anthropic）
- 接入与调试新模型（DeepSeek / MiniMax 等）
- 模型映射、配额、限流策略的可视化管理
- 用量与计费报表

**不负责**

- **不在推理数据路径上**。agent-core 的模型调用不经过它
- 不承载任何 Agent / TaskFlow / Execution 语义

**依赖**：仅 `apps/model-gateway` 的 HTTP 接口（+ Casdoor 登录，若需要）

> 命名提示：它叫 "client" 是相对 model-gateway 而言的前端，
> **不是**"调用 gateway 的 SDK"。两者混淆会直接导致 pass-through 层。

---

### 4.13 `crates/runner`

Execution Plane。**单 crate**，内部分模块：

```text
crates/runner/src/
├── main.rs
├── config.rs
├── connection/    # 主动建立出站持久双向 gRPC 流
├── protocol/      # Protobuf 转换与消息路由
├── execution/     # Execution 状态机、并发上限、超时、取消
├── process/       # 子进程 spawn / kill / stdout-stderr 流式转发
└── workspace/     # cwd、文件操作、临时目录、Artifact 落盘
```

**Runner 只认识**：`ExecuteRequest → Execution → ExecutionEvent`，以及 Workspace、
Process、Filesystem、Sandbox、Resource Limit 和 Cancellation。

**Runner 不认识**：`bash` `git` `grep` `python` 等具体命令；Conversation、User、Agent、Prompt、Planning、Task 的业务含义。

**连接方向**

```text
crates/runner
    │ outbound persistent bidirectional gRPC
    ▼
packages/runner-sdk ──► agent-server Runner Module
```

用户机器不开放入站端口。注册、心跳、执行命令、事件、取消和文件操作
全部复用这条由 Runner 发起的连接。

**并发模型**：并发上限 + 资源上限**两个独立维度**共同约束，不是简单线程池（Rule 10）。

**安全默认值**

- `--server` 和 Runner 连接凭据缺失时拒绝启动
- Runner 连接身份与用户使用权限由 Runner Module 判定
- 不提供对用户机器的入站执行 RPC

**Phase 1 范围**：出站连接、注册/心跳、process spawn、输出流式转发、文件操作、
timeout、cancel、workspace 和并发上限。

**Phase 1 不做**：sandbox（网络 / 文件系统隔离）、cgroup 资源限制、PTY。
跨平台成本高（Windows 上基本无法实现），且不阻塞核心闭环。protocol 保留字段但**明确报告"不支持"，不得静默忽略**。

---

### 4.14 `proto/`

跨进程唯一契约，TS 与 Rust 类型的共同生成源。

```text
proto/
├── common.proto      # 共享标量、错误、时间戳
├── execution.proto   # ExecuteRequest / ExecutionEvent / CancelRequest / File ops
└── runner.proto      # Register / Heartbeat / GetStatus
```

**约束**

- 禁止手工维护重复的 TS type 与 Rust struct
- 禁止 `everything.proto`
- 禁止万能 `Message { type, subtype, metadata, payload }`
- 优先 `oneof` / `enum` / typed message
- 第一版只保留真正需要的 Event，不预造几十种状态
- Event 保留 `event_id` / `execution_id` / `sequence` / `timestamp`（为将来 Attach / Replay / Resume 留位），但**第一版不实现 Event Store**

---

### 4.15 测试布局

| 层级 | 位置 | 范围 | 启动 agent-server |
|---|---|---|---|
| Unit | 各 package 的源码旁 `*.test.ts` | Loop、Compaction、Session 树、Decision、DAG、Retry、状态机、Tool | 否 |
| Integration | `packages/coding-agent/test/` | Coding Agent → **真实 Rust Runner** | **否** |
| E2E | `tests/e2e/` | web-ui → agent-server → 全链路（含登录） | 是 |

**核心能力测试不依赖 Server。** Integration 是验证核心执行闭环的主要方式。

---

## 5. 进程边界

**模块边界 ≠ 进程边界。**

| 进程 | 内容 |
|---|---|
| agent-server（1 个） | agent-core + taskflow + tools + model-adapters + Runner Module + runner-sdk + 持久化 + 鉴权 |
| Rust Runner（N 个） | crates/runner |
| model-gateway（Phase 2） | apps/model-gateway，独立服务，独立 PG |
| web-ui / model-gateway-client | 浏览器 |
| auth-service | **已存在的外部服务**，不在本仓库 |

> 不要因为模块存在，就把模块变成服务。

### 两种运行形态

**Core Integration（不启 server）**

```text
agent-core ──► runner-sdk 的真实 gRPC listener
   ├── Decide = 自动策略    SessionStorage = 内存/JSONL    userId = "local"
   └── nova-runner 真实 Rust 进程主动连入
```

即可验证 Planning → Execution → Verification 完整闭环。

**Production**

```text
web-ui ──HTTP/SSE──► agent-server / Runner Module
                                      ▲
                                      │ outbound persistent gRPC
                                  Runner × N
```

测试与生产只有环境配置差异：测试可在 loopback 上运行，但仍必须经过真实
process / socket / Protobuf / gRPC streaming / cancellation / timeout 边界。

---

## 6. 相对 idea.md 的调整及理由

### 6.1 Runner 概念收敛

Runner 领域只保留 `crates/runner`、`packages/runner-sdk` 和 agent-server Runner Module。
`nova-runner` 是 Rust binary / 产品命令，不产生新的 TypeScript package 或 launcher 层。

### 6.2 `model-gateway` 与 `model-gateway-client` 全部保留

**初次评审的误判**：我曾把 `model-gateway-client` 读成"调用 gateway 的 SDK"，据此判定链路
`agent-core → model-adapters → model-gateway-client → model-gateway → provider` 是四层 pass-through 并主张删除。

**实际定位**：`model-gateway-client` 是 gateway 的**管理后台前端**，与 `agent-web-ui` 平级，
**不在推理数据路径上**。不存在 pass-through 问题，两个 app 全部保留。

```text
数据路径   agent-core → model-adapters → model-gateway → provider
管理路径   model-gateway-client ──HTTP──► model-gateway
```

**仍然成立的约束**：不得为 gateway 单独新增客户端包。`direct` 与 `gateway` 是
`packages/model-adapters` 内的两种 provider 实现，由配置切换（4.4 / 4.11）。

**阶段**：两者均为 Phase 2，与 agent-server 同期。
Phase 1 走 `model-adapters → provider-compatible endpoint` 直连，使集成测试不依赖 gateway 服务与建库，
核心闭环最快打通。

### 6.3 统一 Remote Boundary

同机测试和跨机生产使用同一条真实 RPC / process boundary。差异只在网络位置和配置，
不形成第二个执行实现。Runner 始终主动建立出站持久 gRPC 连接。

### 6.4 删除 `packages/events`

`events` 是模糊承载包（同 `utils` / `common`），违反 Rule 13，必然变成垃圾桶。Event 跟随 owner：

| Event | 归属 |
|---|---|
| ExecutionEvent | `proto/execution.proto` |
| TaskEvent | `packages/taskflow` |
| AgentEvent | `packages/agent-core` |
| UI Event | `packages/protocol` |

### 6.5 `chat-ui` 独立成包（保留 idea.md 的原始判断）

**初次评审的意见**：Phase 1 只有 `agent-web-ui` 一个消费者，按 Rule 5 建议内联，出现第二个消费者再抽。

**最终决定：独立成包。** 但采用比"未来可能复用"更硬的理由——**边界强制**。

独立包让 chat-ui 在物理上够不到 agent-server 内部与 agent-core 运行时，只能消费 `protocol`
定义的 Block 类型。这把 idea.md 第 26 节"UI 消费 Projection，而非内部运行时状态"
从一条口头约定变成一条编译期约束。这个收益**当下即成立**，不依赖任何未来假设。

代价是多一个包边界。用 4.8 的三条防腐规则限定：
只允许 React、`protocol` 和纯内容渲染依赖，不得 import 任何 nova 运行时包，
组件内不得出现 `fetch` / `EventSource` / `localStorage` / 全局 store。

三条中任何一条被打破，说明职责划错了，应先修边界而不是加依赖。

### 6.6 `AgentTool` 移出 `packages/tools`

`idea.md` 第 4 节把 `AgentTool(spawn_agent / delegate_task)` 列在 `packages/tools`，但其流程是 `Tool → Agent Core`，会造成 `tools ⇄ agent-core` **循环依赖**。改由 agent-core 自行注册，`ask_user` 同理。

### 6.7 `crates/runner` 收敛为单 crate

`idea.md` 列出八个目录。若作为八个 crate，第一版就要维护八套 `Cargo.toml`、版本与循环依赖约束。改为单 crate + `mod`。`scheduler` 并入 `execution`（并发控制是 Execution 的固有职责），`filesystem` 并入 `workspace`。拆 crate 的触发条件是独立发布需求或编译瓶颈。

### 6.8 Sandbox / Resource Limit 推迟

Linux 需 cgroup v2 / namespace，Windows 与 macOS 路径完全不同，成本高且不阻塞核心闭环。Phase 1 保留 protocol 字段，运行时明确报告"不支持"。

### 6.9 Retry 职责补充

`idea.md` 第 31 节"Retry 属于 TaskFlow"正确但不完整：

| 类型 | 例子 | Owner |
|---|---|---|
| Provider 级 | LLM 429、连接重置、provider 超时 | `model-adapters` |
| Execution 级 | 命令失败、执行超时、Runner 断连 | `taskflow` |

Runner 永远只报告事实（Failed / TimedOut），不做重试决策。

### 6.10 TaskFlow 保留但设退出条件

见 4.2。风险最高的抽象，Phase 1 结束必须复核。

### 6.11 `planning/` 与 `verification/` 降级为 prompt 资产

**问题一**：`idea.md` 两处目录结构不一致——第 36 节是 `agent-loop / planner / context / sub-agent`，第 37 节是 `agent / planning / runtime / verification`。

**问题二**：规划本质是 system prompt + 一个 todo 类工具的输出；验证本质是跑测试的 tool + 模型读结果判断。两者都是**资产 + tool**，没有独立状态和生命周期，撑不起模块。做成目录会引来 `PlanParser / PlanExecutor / Verifier / VerificationStrategy` 这一串——正是 Rule 5 / 14 要防的。

**结论**：合并为 `prompts/` 承载语义，`todo_write` / `run_tests` 落在 `tools/`。参考：pi 的 agent 包没有 planner。

### 6.12 补齐 agent-core 缺失能力

`idea.md` 的 agent-core 只有 `createAgent()` / `agent.run()`。对照 pi 的 `packages/agent`（2368 行核心 + 2941 行实现规范），以下是 coding agent 的必需品而非可选项：

| 缺口 | 落点 | 后果（若不做） |
|---|---|---|
| Steering / Follow-up / Next-run 队列 | `queue/` | 用户在 agent 干活时无法插话 |
| Compaction + 预算 + 输出截断 | `context/` | 长会话必然崩，`npm test` 一次就能撑爆 |
| Session 树 + Entry/Record 二分 + resume | `session/` | 崩溃无法恢复；server 会自长一套模型 |
| Turn 间可变 model / thinkingLevel / activeTools | `loop/` | 无法中途切模型或调推理档位 |
| Tool batch 并行策略 + 文件串行队列 | `loop/tool-batch.ts` | 并行 tool 写坏同一文件 |
| `content` / `details` 双面结果 | `types.ts` | 模型上下文与 UI 展示混死 |
| Decision（审批 + 反问） | `decision/` | 危险操作无人把关；agent 无法向用户提问 |
| 不 throw 的错误契约 | 全局 | 跨进程失败打断 loop，UI 卡半截 |
| `ToolContext` 的 fs 面 | `types.ts` | `read_file` 只能拼 `cat` |
| Usage 计量 / Telemetry | `session/record.ts` | 无法计费与排障 |
| Skills / Prompt Templates / 环境注入 | `prompts/` | 无法复用指令资产 |

---

## 7. 已定决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | `planning/` `verification/` 是否降级 | **降级为 prompt 资产**（6.11） |
| D2 | Session 存储模型定在哪 | **agent-core 定接口与模型，agent-server 只提供 PG 实现**（4.1.5） |
| D3 | 权限 / 审批 / 反问 | **鉴权做（Casdoor，仅登录）；审批做；反问做；三者中后两者共用一套 Decision 机制；不做细粒度授权**（4.1.4 / 4.9.1） |
| D4 | model-gateway 是否进 Phase 1 | 否，**Phase 2**。`model-gateway` 与 `model-gateway-client` 均保留（6.2） |
| D5 | Runner 网络边界 | 只有 Runner 主动建立的出站持久 gRPC 连接 |

### 拆模块文档时定掉的

| # | 问题 | 结论 |
|---|---|---|
| D6 | TaskFlow 是否第一版独立成包 | **独立**。2026-08-17 复核定案：保留，agent-core 复用（tool batch / Sub-agent 并发走 `createFlow`），退出条件作废（`taskflow.md` §8） |
| D7 | agent-server 第一版数据库 | **PostgreSQL**。jsonb / 数组 / 并发写入均用得上，且生产必然是 PG，不维护两套 SQL 方言（`agent-server.md` §4） |
| D8 | `packages/protocol` 是否独立成包 | **独立**。`chat-ui` 抽包后已有三个消费者，且 chat-ui 的边界约束正依赖它 |
| D9 | `casdoor/` 是否移入 `packages/` | **保持原位**。它是外部共享库（`@hquant/*`），不属于 nova 的模块划分 |

---

## 8. 阶段范围

### Phase 1：核心闭环

目标：**不启动 agent-server，验证 Planning → Execution → Verification。**

- `proto/`：common + execution（含文件操作面）+ runner（Phase 1 唯一执行路径的契约）
- `crates/runner`：出站持久连接、process、streaming、文件操作、timeout、cancel、workspace、并发上限
- `packages/runner-sdk`：真实 gRPC listener、Runner Session、协议关联与背压
- `packages/model-adapters`：OpenAI + Anthropic
- `packages/tools`：bash / read_file / write_file / grep / git_diff / todo_write / run_tests
- `packages/taskflow`
- `packages/agent-core`：loop / tool-batch / queue / context / session / decision / prompts
- `packages/coding-agent/test`

**交付判据**：`packages/coding-agent/test` 跑通一个真实的
"改代码 → 跑测试 → 失败 → 分析 → 修复 → 再跑 → 通过 → 验证" 闭环，
其中至少包含一次**审批挂起**和一次**反问挂起**（用自动策略应答）。

### Phase 2：产品链路

- `packages/protocol`
- `packages/chat-ui`：Block 渲染器 + Decision 交互组件 + 渲染注册表
- `apps/agent-server`：HTTP + SSE + Casdoor 鉴权 + PG 持久化 + Runner Module + Projection + Decide 实现
- `apps/agent-web-ui`：应用外壳 + SSE 订阅 + 状态管理，Chat 渲染复用 `chat-ui`
- `apps/model-gateway`：密钥托管 / 模型映射 / 计量 / 配额，暴露 OpenAI / Anthropic 兼容接口
- `apps/model-gateway-client`：网关管理后台
- `packages/model-adapters`：新增 `gateway` provider 实现（与 `direct` 并列，配置切换）
- `tests/e2e`

### Phase 3：按需

- Sandbox / Resource Limit
- Event Store / Attach / Replay / Resume
- 双向 Streaming（stdin / signal / 交互式控制）
- Runner Scheduler
- 细粒度授权（若届时确有需求）

---

## 9. 结构自检清单

新增文件 / 模块 / 包之前逐条确认：

- [ ] 是否已有实现可以修改？（Rule 2）
- [ ] 新增的层是否只做转发？（Rule 3）
- [ ] 抽象是否对应真实变化点？是否已有 ≥2 个实现或明确边界？（Rule 5 / 14）
- [ ] 是否引入第 3.1 节禁止的依赖方向？
- [ ] 状态的 owner 是否唯一？（Rule 8）
- [ ] 并发的 owner 是否明确？是否有上限与 backpressure？（Rule 10）
- [ ] 是否把模块变成了服务？（第 5 节）
- [ ] 被替代的旧代码是否已删除？（Rule 2 / 17）

---

## 10. 一句话定义

> Nova 是一个以 **Agent Loop** 为核心、**TaskFlow** 为编排、**Rust Runner** 为独立执行平面的轻量 Coding Agent Runtime。

最重要的边界只有一条链：

```text
Agent → TaskFlow → Execution → Runner
```

外围一切都是可选入口：

- `agent-server` + `web-ui` 是产品入口，`Casdoor` 是它的门禁
- `nova-runner` 是 Rust Runner 的 binary / 产品命令
- `proto` 是跨进程契约

**Use better boundaries, state models, and data flow to reduce complexity — never use more code to hide complexity.**
