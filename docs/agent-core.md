# agent-core

> `packages/agent-core` — 决策层。
> 结构契约见 `repo-layout.md` §4.1，本文档定义 **API 面与字段**。

---

## 1. 定位

**负责**

- Turn 循环：组装上下文 → 调模型 → 执行 tool batch → 观察 → 判定续跑
- 上下文生命周期：预算、压缩、截断
- 会话状态：Entry / Record 两条流、会话树、fork / resume
- Decision：审批与反问的统一挂起与恢复
- 三条消息队列：steering / follow-up / next-run
- Sub-agent 派生及其并发与 token 预算
- 注册内置 AgentTool：`spawn_agent` / `submit_result` / `ask_user`

**不负责**

| 不负责 | 归属 |
|---|---|
| 进程管理、资源限制、Shell 生命周期 | `crates/runner` |
| Runner 注册、心跳、连接管理 | `agent-server` Runner Module / `runner-sdk` |
| 传输方式（HTTP / gRPC / SSE） | 外层 |
| 用户身份与登录 | `agent-server`；本包只持有 `userId: string` |
| UI 文案与渲染 | `chat-ui` / `agent-web-ui` |
| Provider 级重试 | `model-adapters` |

**硬约束**：不启动 agent-server 也能跑通 `Plan → Execute → Observe → Verify → Result`。
一切外部能力经构造期注入，没有全局单例、没有隐式 IO。

### 1.1 两种模式

Agent 有且只有两种运行形态，差别只在**有没有 workspace**。

| | Chat 模式 | Project 模式 |
|---|---|---|
| workspace | 无 | 固定，由 project 定义 |
| `ctx: ToolContext` | 未绑定 Runner 时**不注入**；Host 可为绑定 Runner 的普通会话注入 | 注入 |
| Runner | 未绑定时**不启动**；绑定后由 Host 提供 | 必需 |
| 可用工具 | 无 `ctx` 时仅 `risk: "none"`（`todo_write` 等）；有 `ctx` 时由 Host 选择 | 全部 |
| 典型用途 | 普通提问、方案讨论、纯推理 | 改代码、跑测试、验证 |
| 闭环 | 模型直接回答 | 意图识别 → TODO → 执行 → 勾选 → 验证（§9.5） |

**同一个 loop、同一套 prompt 资产、同一个 TODO 机制。**
模式不是两条代码路径，是**工具集与 `ctx` 的有无**。没有 `if (mode === "chat")` 这种分支。

装配期校验：`ctx` 缺省但工具集里存在 `risk !== "none"` 的 tool → **抛错**。
早失败，不要等模型调了 `bash` 才发现没有执行环境。

> 这是本包唯一的构造期校验。它值得存在：模式配错的表现是"跑到一半才炸"，
> 而那时已经消耗了一次模型调用。

---

## 2. 对外 API 面

```ts
createAgent(config: AgentConfig): Agent

interface Agent {
  prompt(input: string | ContentPart[]): Promise<RunResult>

  steer(msg: string): void        // 运行中插话，当前 tool batch 跑完后注入
  followUp(msg: string): void     // agent 准备停下时注入，让它继续
  nextRun(msg: string): void      // 排到下一个独立 run

  abort(): Promise<void>
  compact(opts?: { instruction?: string }): Promise<CompactionResult>
  contextUsage(): Promise<ContextUsage>
  fork(entryId: EntryId): Promise<Agent>
  resume(): Promise<void>         // 崩溃 / 重启后依据 Record 续跑

  readonly state: AgentState
  subscribe(listener: (e: AgentEvent) => void): Unsubscribe
}
```

**不导出** `loop` / `context` / `session` / `queue` 的内部对象。
需要观测就订阅 `AgentEvent`，需要落盘就实现 `SessionStorage`。

```ts
interface AgentConfig {
  model: ModelRef                    // 见 model-adapters.md；其中 maxOutput 是单次模型输出硬上限
  stream: StreamFn                   // 注入，不在包内选 provider
  tools: AgentTool[]
  ctx?: ToolContext                  // 注入，见 §3.4。缺省 = Chat 模式，见 §1.1
  storage: SessionStorage            // 注入，见 §5.3
  decide: Decide                     // 注入，见 §6
  userId?: string                    // 缺省 "local"
  systemPrompt?: PromptAsset[]
  maxTurns?: number                  // 缺省 100
  toolConcurrency?: number           // 缺省 8，见 §4.2
  subAgent?: { maxConcurrent?: number; maxDepth?: number }   // 缺省 4 / 1
}
```

`stream` / `ctx` / `storage` / `decide` 四个注入点 = 本包全部的外部世界。
集成测试注入内存实现，agent-server 注入 PG + SSE 实现。
其中只有 `ctx` 可缺省 —— Chat 模式没有执行环境。

```ts
interface AgentState {
  isStreaming: boolean
  streamingMessage: Message | null
  pendingToolCalls: ToolCall[]
  pendingDecision: DecisionRequest | null
  model: string
  thinkingLevel: ThinkingLevel
  activeTools: string[]
  errorMessage: string | null
}

interface RunResult {
  runId: string
  stopReason: StopReason
  message: Message | null    // 最后一条 assistant message
  usage: Usage
  output?: AgentTaskResult   // submit_result 提交的结构化任务结果
}

type StopReason =
  | "done"          // 模型不再请求 tool
  | "max_tokens"    // 达到模型输出上限，最终消息可能不完整
  | "repetition_detected" // 流式输出出现长文本连续重复，已保留部分内容并停止
  | "terminate"     // batch 内全部结果置 terminate
  | "max_turns"
  | "aborted"
  | "error"
```

`submit_result` 是 Agent 任务的显式完成协议。它提交成功或失败的结构化结果并终止当前 run；
调用方不得从最终文本或 transcript 猜测任务状态。

```ts
type AgentTaskResult<T = unknown> =
  | { ok: true; summary: string; data?: T }
  | { ok: false; summary: string; error: { code: string; message: string; retryable?: boolean } }
```

---

## 3. 核心类型

### 3.1 Message / Block

Agent 内部的对话表示。**与 `packages/protocol` 的 UI 类型不共享定义**，
由 agent-server 做 Projection（`repo-layout.md` §3.2）。

```ts
interface Message {
  id: string
  role: "user" | "assistant"
  blocks: Block[]
  createdAt: number
}

type Block =
  | { type: "text";       text: string }
  | { type: "thinking";   text: string; signature?: string; data?: ThinkingData }
  | { type: "tool_call";  callId: string; name: string; args: unknown }
  | { type: "tool_result";callId: string; status: "ok" | "error"; content: ContentPart[] }
  | { type: "image";      mimeType: string; data: string }

type ThinkingData =
  | { format: "deepseek" }
  | { format: "minimax"; details: unknown[] }

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
```

`signature` 与 `data` 是下一轮 provider 协议所需的内部回传数据，随 Entry 保存；它们不属于
UI 契约。agent-server Projection 只投影允许展示的 `text`，并剥离这些字段（`protocol.md` §2）。

`tool_result.content` 是**喂模型的那一面**。给 UI 的完整数据走 `details`，见 §3.2，
经 `AgentEvent` 外发，不进 `Message`。

> `code` / `diff` / `file` / `artifact` 这些是**渲染类型**，属于 `protocol` 与 `chat-ui`。
> agent-core 不产出它们，由 Projection 从 `tool_result.details` 派生。

### 3.2 Tool 与结果

```ts
interface AgentTool<A = unknown, D = unknown> {
  name: string
  description: string
  parameters: JSONSchema
  executionMode?: "parallel" | "sequential"        // 缺省 parallel
  risk?: "none" | "read" | "write" | "exec"        // 缺省 exec
  execute(args: A, ctx?: ToolContext): Promise<AgentToolResult<D>>
}

interface AgentToolResult<D> {
  status: "ok" | "error"      // Tool 自己声明，不从 details 猜测
  content: ContentPart[]      // 喂模型，会被截断
  details: D                  // 给 UI，完整可展开
  usage?: Usage
  terminate?: boolean
}
```

**`content` 与 `details` 必须从第一天就分开。** 两者裁剪策略完全不同，
混在一起之后再拆需要改动每一个 tool。

`risk` 是**给 tool 自己声明**的，两个用途：

| 用途 | 读法 |
|---|---|
| 审批策略（§6） | `read` 放行 / `write` `exec` 需确认 |
| 模式筛选（§1.1） | `none` = 不碰 workspace，Chat 模式可用；其余需要 `ctx` |

缺省 `exec` 是 fail-safe：忘了声明的工具按最危险处理。
新增 tool 时不需要改 agent-core —— 名单不在这里。

### 3.3 Result 与错误契约

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }
```

两条硬规矩：

| 规矩 | 理由 |
|---|---|
| `StreamFn` **不得 throw** | 模型/网络失败编码进流，以 `finish{stopReason:"error", errorMessage}` 收尾 |
| `ToolContext` 的 `fs` / `exec` **不得 throw** | 返回 `Result`，错误带 typed code |

跨进程失败是常态而非异常。throw 会打断 loop 的事件序列，让 UI 卡在半截状态。

`AgentTool.execute` **可以** throw —— loop 捕获后转成 `status: "error"` 的 tool_result
喂回模型。这是让模型自己纠错的路径，不是错误处理漏洞。

### 3.4 ToolContext

Tool 不依赖 `runner-sdk`，只接收这个窄接口。

```ts
interface ToolContext {
  fs: FileSystem
  exec(cmd: string, opts?: ExecOptions): Promise<Result<ExecOutput, ExecError>>
  signal: AbortSignal
  cwd: string
}

interface FileSystem {
  read(path: string, opts?: { offset?: number; limit?: number }): Promise<Result<TextFile, FsError>>
  readBytes(path: string): Promise<Result<Uint8Array, FsError>>
  write(path: string, content: string, opts?: { append?: boolean }): Promise<Result<void, FsError>>
  rename(from: string, to: string): Promise<Result<void, FsError>>
  remove(path: string, opts?: { recursive?: boolean }): Promise<Result<void, FsError>>
  mkdir(path: string): Promise<Result<void, FsError>>
  list(path: string): Promise<Result<DirEntry[], FsError>>
  stat(path: string): Promise<Result<FileInfo, FsError>>   // 不存在 → error(NOT_FOUND)
  tempDir(prefix?: string): Promise<Result<string, FsError>>
  // proto.md §4.2 GrepOp：Runner 侧结构化搜索原语，tools.md §3 `grep` 工具的落点，不拼 shell。
  grep(pattern: string, opts?: GrepOptions): Promise<Result<GrepMatch[], FsError>>
}

interface GrepOptions { path?: string; glob?: string; maxResults?: number }
interface GrepMatch   { file: string; line: number; text: string }

interface TextFile  { text: string; totalLines: number; truncated: boolean }
interface FileInfo  { path: string; kind: "file" | "dir" | "symlink"; size: number; mtime: number }
interface DirEntry  { name: string; kind: "file" | "dir" | "symlink" }

interface ExecOptions {
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number                       // 缺省 120_000
  onOutput?: (chunk: OutputChunk) => void  // 流式回调，用于实时上抛
}
interface ExecOutput { exitCode: number; stdout: string; stderr: string; truncated: boolean; durationMs: number }
type OutputChunk = { stream: "stdout" | "stderr"; text: string }

type FsErrorCode   = "NOT_FOUND" | "PERMISSION" | "IS_DIR" | "NOT_DIR" | "EXISTS" | "OUT_OF_WORKSPACE" | "TOO_LARGE" | "IO"
type ExecErrorCode = "TIMEOUT" | "CANCELLED" | "SPAWN_FAILED" | "RUNNER_UNAVAILABLE" | "IO"
type FsError   = { code: FsErrorCode;   message: string; path?: string }
type ExecError = { code: ExecErrorCode; message: string; exitCode?: number }
```

Agent 每个 tool call 也有总时限：`AgentConfig.toolTimeoutMs`，缺省 120 秒。该时限由 TaskFlow
持有，并会 abort 传入工具的 `ToolContext.signal`；Runner 执行因此会收到取消请求。工具未能自行响应
abort 时，Agent 仍会将该调用收敛为 timeout 结果，不会让整个 run 永久停在 loading。

> **联动点**：`fs` 面的存在要求 `proto/execution.proto` 除 `Execute` 外必须有文件操作 RPC。
> 若只有 `command / args`，`read_file` 就只能拼 `cat` —— 不可接受。见 `proto.md` §4。

生产环境中的 `ToolContext` 只能由 `runner-sdk.toToolContext(RunnerSession, ...)` 创建。`agent-core` 仍只依赖这个窄接口，不直接依赖 runner-sdk；Host 负责桥接。不存在使用 `node:fs`、`node:child_process` 或本机 Shell 的 Local ToolContext fallback。单元测试可以使用不接触真实 OS 的内存 fake，集成测试必须经过真实 Remote Runner。

**相对 repo-layout §4.1.7 的字段收敛**（原列 15 个方法）：

| 原 | 现 | 理由 |
|---|---|---|
| `readTextFile` / `readTextLines` | `read(path, {offset, limit})` | 同一操作的两种切片方式 |
| `exists` | `stat` 返回 `NOT_FOUND` | `exists` 后再 `stat` 是 TOCTOU，且多一次 RPC |
| `canonicalPath` | 删除 | 路径规范化与越界检查是 Runner 的强制职责（`runner.md` §6），不是 tool 的可选调用 |
| `createTempFile` | 删除 | `tempDir()` + `write()` 即可 |
| `createDir` / `appendFile` / `writeFile` | `mkdir` / `write(.., {append})` | 命名统一 |
| `cwd()` | `ctx.cwd` 字段 | 它是常量不是操作 |

---

## 4. Turn 循环

### 4.1 主流程

```text
run(input):
  entries.push(userMessage(input))
  runId = newRunId(); record(run-started)

  for turn in 0..maxTurns:
    if budget.shouldCompact(): compact()
    ctx = assemble(entries, todos)           # system prompt + 历史 + TODO 快照 + activeTools

    msg = await reduce(stream(ctx))          # 边流边发 AgentEvent
    entries.push(msg)

    if msg.toolCalls.isEmpty():
      if followUpQueue.nonEmpty():           # 排空点 B
        entries.push(drain(followUpQueue)); continue
      return finish("done")

    results = await runToolBatch(msg.toolCalls)
    entries.push(toolResults(results))

    if steeringQueue.nonEmpty():             # 排空点 A
      entries.push(drain(steeringQueue))

    if results.every(r => r.terminate): return finish("terminate")
    if hooks.shouldStopAfterTurn(): return finish("done")
    hooks.prepareNextTurn()                  # 可替换 model / thinkingLevel / activeTools

  return finish("max_turns")
```

### 4.2 Tool Batch

一个 turn = 一条 assistant message + 它请求的全部 tool call + 对应结果。

| 规则 | 内容 |
|---|---|
| 默认并发 | 同一 batch 内的 tool call 默认 `parallel` |
| **并发上限** | `toolConcurrency`，缺省 **8**。一个信号量，超出的排队 |
| 单独覆盖 | tool 声明 `executionMode: "sequential"` 则该 tool 独占，前后不与他人并行 |
| 结果顺序 | **必须按 `msg.toolCalls` 原始顺序回填**。多数 provider 要求 `tool_result` 与 `tool_call` 一一对序 |
| 文件串行队列 | `risk: "write"` 的 tool 按规范化路径进串行队列，同路径不并发 |
| terminate | 只有 batch 内**每个**结果都置 `terminate` 才提前结束 |
| abort | 收到 abort 后不再启动新 tool；已启动的传 `signal`，等它们收敛后落 record |

**并发上限不是可选项。** 模型一条 message 里请求 20 个 tool call 是常态，
不限流就是 20 个并发 gRPC 请求直接打到 Runner —— Runner 队列满会返回 `BUSY`，
而 `runner-sdk` 把它映射成 `RUNNER_UNAVAILABLE`（`runner-sdk.md` §6），
模型看到的是一堆莫名其妙的"Runner 不可用",然后开始瞎猜。

缺省 8 与 Runner 的队列深度对齐（`runner.md` §8：`--queue-size` 缺省 4 × max-concurrency）。

> **仍有残余风险**：同一 project 下多个会话共享一个 Runner（`runner.md` §10.2），
> 每个会话各自限 8，合起来仍可能触发 `BUSY`。本上限只解决单会话自炸，
> 跨会话的背压依赖 Runner 的 `BUSY` 与用户不并行操作同一 project。
> 若实际跑出来 `BUSY` 频发，第一步是检查 Runner Module 的调度与 worker 容量
> （让它可区分、可等待），而不是继续调小这个数。

> 这是本系统真实并行度的来源，**且用不上 DAG**。参见 `taskflow.md` §6 退出条件。

### 4.3 Hooks

```ts
interface AgentHooks {
  beforeToolCall?(call: ToolCall): Promise<"allow" | "ask" | "deny">
  afterToolCall?(call: ToolCall, result: AgentToolResult<unknown>): void
  shouldStopAfterTurn?(): boolean
  prepareNextTurn?(): { model?: string; thinkingLevel?: ThinkingLevel; activeTools?: string[] } | void
}
```

Turn 之间可变的状态只有三个：`model` / `thinkingLevel` / `activeTools`。
**每次变更都要落 Entry**，否则 fork 与 resume 会拿到错误的模型配置。

---

## 5. Session

### 5.1 两条正交的流

| | Entry | Record |
|---|---|---|
| 语义 | 会话内容 | 运行事实 |
| 进模型上下文 | ✅ | ❌ |
| 用途 | 组装 prompt、fork、导航 | resume、排障、计费、审计 |

这是 idea.md「Message ≠ Event」在 agent-core 的落地。

```ts
interface EntryBase { id: EntryId; parentId: EntryId | null; ts: number }

type Entry = EntryBase & (
  | { kind: "message";        message: Message }
  | { kind: "model";          model: string }
  | { kind: "thinking-level"; level: ThinkingLevel }
  | { kind: "active-tools";   tools: string[] }
  | { kind: "compaction";     summary: string; replacedFrom: EntryId; replacedTo: EntryId }
)

type Record = { id: string; runId: string; ts: number } & (
  | { kind: "run-started";        input: string }
  | { kind: "turn-started";       turn: number; model: string }
  | { kind: "tool-started";       callId: string; name: string; args: unknown }
  | { kind: "tool-finished";      callId: string; status: "ok" | "error"; durationMs: number }
  | { kind: "decision-requested"; decisionId: string; request: DecisionRequest }
  | { kind: "decision-resolved";  decisionId: string; response: DecisionResponse | "timeout" }
  | { kind: "queue-enqueued";     queue: QueueName; message: string }
  | { kind: "todo-updated";       items: Todo[] }
  | { kind: "usage";              model: string; usage: Usage }
  | { kind: "context-compacted";  trigger: CompactionTrigger; summarized: boolean }
  | { kind: "abort-requested" }
  | { kind: "run-finished";       stopReason: StopReason }
)

interface Usage { input: number; output: number; cacheRead?: number; cacheWrite?: number }
```

**Entry 用 `parentId` 构成树**，不是数组。fork 就是从某个 EntryId 长出新分支；
当前分支 = 从叶子沿 `parentId` 回溯到根。这样 fork 不需要复制历史。

### 5.2 Resume

崩溃或重启后：

```text
读 Record → 找最后一条 run-started 且无匹配 run-finished 的 runId
  ├── 恢复 TodoState：取最后一条 todo-updated（跨 run，见 §9）
  ├── 有未完成的 tool-started        → 该 tool 结果不可知，作为 error 结果喂回模型，续跑
  ├── 有未 resolved 的 decision      → 重新发出 DecisionRequest，等人类
  └── 都没有                         → 从最后一条 Entry 之后重新进 turn 循环
```

**挂起状态必须落 Record**，否则断线后无法恢复。这是 Record 存在的首要理由。

### 5.3 存储接口

接口定在 agent-core，实现由外部提供。否则 agent-core 会被 server 绑死。

```ts
interface SessionStorage {
  appendEntry(sessionId: string, entry: Entry): Promise<void>
  appendRecord(sessionId: string, record: Record): Promise<void>
  loadEntries(sessionId: string, leafId?: EntryId): Promise<Entry[]>   // 返回该分支，已按序
  loadRecords(sessionId: string, filter?: RecordFilter): Promise<Record[]>
}

interface RecordFilter { runId?: string; kind?: Record["kind"]; limit?: number; desc?: boolean }
```

| 场景 | 实现 |
|---|---|
| 集成测试 / CLI | 内存 或 JSONL |
| agent-server | PostgreSQL + Drizzle（见 `agent-server.md` §6） |

四个方法，没有 `update` / `delete`。**两条流都是 append-only**，改历史一律靠新增 Entry。

`RecordFilter` 的存在只为一件事：恢复 TodoState 时取最后一条 `todo-updated`
（`loadRecords(id, { kind: "todo-updated", limit: 1, desc: true })`），
不必把整条 Record 流读进内存。

---

## 6. Decision

审批（危险 tool 要人确认）与反问（agent 需要用户决策）流程同构：
挂起 → 发请求 → 等人类 → 恢复。**只做一套。**

```ts
type DecisionRequest =
  | { kind: "approval"; decisionId: string; callId: string; toolName: string; args: unknown; risk: Risk }
  | { kind: "question"; decisionId: string; question: string; options: string[]; multiSelect: boolean }

type DecisionResponse =
  | { kind: "approval"; decision: "allow" | "deny" | "allow_always"; reason?: string }
  | { kind: "question"; answers: string[] }

type Decide = (req: DecisionRequest, signal: AbortSignal) => Promise<DecisionResponse>
```

**agent-core 只依赖 `Decide` 这一个回调。** 这保证了无 server 也能完整跑通。

| 场景 | `Decide` 实现 |
|---|---|
| 集成测试 / CLI | 自动策略：按 `risk` 放行，问题走预设答案 |
| agent-server | 推 SSE → 挂起 run → 等 HTTP 回填 → 恢复 |

**触发点**

| 来源 | 触发 |
|---|---|
| 审批 | `beforeToolCall` 返回 `"ask"` |
| 反问 | 模型调用内置 `ask_user`（agent-core 注册，不在 `packages/tools`） |

**审批策略**

```ts
type ApprovalPolicy = { default: "auto" | "ask" | "deny"; byRisk?: Partial<Record<Risk, Mode>>; byTool?: Record<string, Mode> }
```

缺省：`read → auto`，`write / exec → ask`。
`allow_always` 写入 **session 级** allowlist，第一版不跨 session 持久化。

**超时与取消**

- 等待人类必须有 timeout，缺省 5 分钟，**超时 fail-closed（deny）**
- 等待期间收到 abort：干净退出、落 `decision-resolved: "timeout"` 之外的 `abort-requested`

**落 Entry 还是 Record**

| 事件 | Record | Entry | 理由 |
|---|---|---|---|
| 审批请求发出 | ✅ | ❌ | 模型不需要知道 |
| 审批通过 | ✅ | ❌ | 结果就是 tool 正常执行 |
| 审批**拒绝** | ✅ | ✅ | 模型必须知道被拒，否则会反复重试同一个操作 |
| 反问的问题与答案 | ✅ | ✅ | 属于对话的一部分 |

---

## 7. 三条队列

**这是消息缓冲，不是调度器。** 元素是用户输入的 `string`，出队条件只看 turn 边界，
没有并发、没有依赖、没有重试。

> 与 `taskflow` 的 ready queue **无依赖、无冲突，只是同名**：那边元素是 `Task`，
> 出队条件是"依赖满足 + 有并发额度"。两者共同点仅限"FIFO"三个字。
> `queue/` 不 import taskflow，也不该 import。

```ts
type QueueName = "steering" | "followUp" | "nextRun"
```

| 队列 | 入队时机 | 排空点 | 效果 |
|---|---|---|---|
| `steering` | 运行中 | tool batch 完成后（§4.1 排空点 A） | 作为 user message 注入当前 run |
| `followUp` | 任意时刻 | 模型不再请求 tool 时（排空点 B） | 阻止 run 结束，续跑 |
| `nextRun` | 任意时刻 | 当前 run 结束后 | 触发一个新的独立 run |

**不在 tool 执行中途注入。** 中途注入会让模型看到一个 tool_call 没有对应结果的历史，
多数 provider 直接报错。

入队要落 `queue-enqueued` Record —— 用户插了话但 agent 没反应时，这是唯一的排查依据。

---

## 8. 上下文生命周期

| 关注点 | 内容 |
|---|---|
| 预算 | 从最近一次 assistant `usage` 估算已用 token，对比 model 的 `contextWindow` |
| 压缩触发 | `manual`（`agent.compact()`）/ `threshold`（超过 `contextWindow * 0.8`）/ `overflow`（provider 报超限） |
| cut point | **必须落在完整 turn 边界**：assistant message 及其全部 tool_result 之后。切开 tool_call 与 tool_result 会让请求非法 |
| 压缩过程 | 选 cut point → 生成摘要 → 写 `CompactionEntry` → 重算 usage。摘要失败重试 2 次，仍失败则按 `overflow` 硬截断最早的完整 turn |
| 输出截断 | 单个 tool 的 `content` 有上限（缺省 30_000 字符），超出则**保留头尾、中间省略并标注省略行数**。`details` 不截断 |

**截断策略在 agent-core，不在 tools。** 否则每个 tool 都要自己实现一遍，且策略无法统一调整。

`ContextUsage` 只报告最近一次模型请求的真实 input token 与当前模型的 `contextWindow`；没有模型
用量或刚完成压缩时 `inputTokens = null`，不伪造压缩后的 token 数。每次模型返回 usage 时发出
`context.updated`，压缩成功后清空最近用量并再次发出该事件。`context-compacted` Record 与 usage
Record 共同决定重建 runtime 后的最近状态，避免把压缩前的高水位误报为当前占用。

> 长会话跑不下去，90% 的原因在这一组。`npm test` 一次输出就可能撑爆上下文。

---

## 9. Plan State（TODO）

上下文会被压缩，压缩后模型就忘了"还有哪些没做"。
TODO 是**唯一一份不受压缩影响的进度状态**。

> 它同时是"规划"能力的载体。这就是为什么没有 `planning/` 模块（`repo-layout.md` §6.11）：
> plan 的产物就是这份列表，不需要 `PlanParser` / `PlanExecutor` / `VerificationStrategy`。

### 9.1 类型

```ts
interface Todo {
  id: string
  text: string
  status: "pending" | "in_progress" | "completed" | "blocked"
  note?: string        // 仅 blocked 用：卡在哪
}

interface TodoState { items: Todo[]; updatedAt: number }   // items 有序，顺序即执行顺序
```

四个字段。**没有 `deps` / `priority` / `owner` / `createdAt`。**

`blocked` 值得单列（而不是并进 `pending`）：没有它，模型会把"等 proto 定稿"这类事项
当成待办反复重试。它必须带 `note`，否则等于没标。

**为什么不加 `deps`**：`todo.draft.md` §4③ 建议保留依赖关系。**不采纳** ——
一加依赖字段，TODO 就成了第二个 DAG 引擎，和 `taskflow` 正面撞车（而 taskflow 本身有退出条件，
见 `taskflow.md` §8）。**顺序即隐含依赖**，模型按序做。真需要并发依赖调度时那是 taskflow 的事。

### 9.2 什么算 TODO

一个事项**同时**满足两条才算：

1. 需要一个未来动作才能完成
2. 这个动作**不是当前这轮回答本身**

| 算 | 不算 |
|---|---|
| "先实现 runner，再测远程调用，最后补并发限制" → 3 项 | "Fastify 和 Hono 哪个更适合？" → 单次问答 |
| "设计架构，然后给目录结构，最后写 AGENTS.md" → 3 项 | "解释这个函数为什么报错" → 单次问答 |
| 用户明确说"之后再做 X" | "详细对比三个框架并推荐" → 复杂但只 1 项，本轮做完直接勾掉 |

**复杂 ≠ TODO。** 判据是"回答完还有没有后续动作"，不是"这件事难不难"。

**四类东西永远不进 TODO**，否则它会无限膨胀：

| 反例 | 理由 |
|---|---|
| "以后可以考虑加 Redis" | 是 agent 的建议，不是用户的要求 |
| "可以进一步考虑 DAG" | 是可能性，不是待办 |
| "我先解释 A 再解释 B" | 是本轮回答的内部结构，回答完就该消失 |
| 已做完的事项仍挂 `pending` | 完成即勾；没有其他未完成项就清空 |

**TODO 追踪用户目标，不追踪聊天记录：**

```text
❌  [ ] 回答用户关于 Fastify 的问题        ✅  [ ] 确定 Server 技术栈
    [ ] 回答用户关于 Runner 的问题             [ ] 设计 Runner Runtime
```

这条是 TODO 在压缩之后仍然有用的**全部原因**。左边那种写法压缩完等于噪音。

### 9.3 阈值

```ts
const TODO_SUGGEST = 2    // 未完成项 ≥ 2：建议维护
const TODO_ENFORCE = 3    // 未完成项 ≥ 3：强制注入上下文
```

1 项不需要 TODO；2 项可以直接做但值得开始追踪；3 项以上很容易因上下文变化遗漏。
"未完成"= `pending + in_progress + blocked`。

### 9.4 自动维护 = prompt 判定 + 代码保活

**两层，职责不同：**

| 层 | 谁做 | 内容 |
|---|---|---|
| 创建与勾选 | **prompt**（`prompts/todo.md`） | §9.2 的判定标准写进 system prompt，模型自己调 `todo_write` |
| 保活与注入 | **代码**（`context/todo.ts`） | 保证 TODO 不被压缩掉、到阈值就常驻上下文 |

**判定不写成代码。** 用动词表 + 句法分析去数 action 个数是启发式 NLP：会误判、难调、
且属于"用更多代码隐藏复杂度"（CLAUDE.md 终则）。模型本来就擅长这件事，代码抢过来只会更差。

**代码只保证一件事：模型永远看得见当前 TODO。**

| 规则 | 说明 |
|---|---|
| 注入位置 | **紧邻最后一条 user message 之前**。不放 system prompt —— 它每轮都变，放进去会打掉 prompt 缓存 |
| 注入内容 | `pending` / `in_progress` / `blocked` 全列；`completed` 只给计数 |
| 低于阈值 | **不注入**，省 token。TodoState 仍在，UI 照常显示 |
| 压缩 | `TodoState` **不是 Entry**，压缩完全不动它。这是它存在的意义 |
| 唯一 owner | 只有 `todo_write` 能改（CLAUDE.md Rule 8）。每次变更落一条 `todo-updated` Record |

注入格式就是 markdown 清单，模型天然认得：

```markdown
## 当前 TODO（已完成 2 项）
- [~] 实现 runner 的并发上限
- [ ] 测试远程 runner 调用
- [!] 补 timeout —— 阻塞：等 proto 定稿
```

### 9.5 完整闭环

Project 模式下的流程。**每一步都不是新模块**：

```text
用户输入
   ↓
意图识别      prompt 判定：单次问答，还是多步工作？
   ↓ 多步
plan          todo_write 写入 N 项
   ↓
执行          取第一个 pending → in_progress → 调 tool → Runner
   ↓
勾选          completed，立即 todo_write（不攒着最后一起勾）
   ↓
验证          跑测试的 tool + 模型读结果判断
   ↓ 失败                          ↓ 通过
修复 → 回「执行」                 全部 completed → 清空 → 最终回答
   或 todo_write 追加新项
```

Chat 模式走**同一条路**，只是"执行"步没有 Runner —— 模型直接回答。
`todo_write` 依然可用（`risk: "none"`），所以纯讨论型的多步任务一样有进度追踪。

**"立即勾选"不是风格问题。** 攒到最后一起勾，中途一旦压缩或崩溃，
就分不清哪些做完了 —— 那 TODO 就白建了。

### 9.6 归属

**TodoState 属于 conversation，不跨 chat。**

`todo.draft.md` §6 称之为 "Project State"，那是指**语义上追踪项目目标**而非追踪对话，
不是指存储范围。同一 project 下的多个 chat 共享一份 TODO 会互相踩：
A 会话勾掉的项在 B 会话里凭空消失。

project 级的长期待办是另一个产品概念（issue tracker），不在此列。
两种模式下 TODO 的行为完全一致（`agent-server.md` §1.1）。

---

## 10. Sub-agent

```ts
// 内置 AgentTool，agent-core 注册
spawn_agent(args: { task: string; tools?: string[] }): AgentToolResult<{ transcript: Message[] }>
```

| 约束 | 值 | 理由 |
|---|---|---|
| 最大深度 | 1（缺省） | 子 agent 不能再派生。无上限的递归派生无法预算 |
| 最大并发 | 4（缺省） | 与父 agent 共享一个信号量 |
| token 预算 owner | **父 agent** | 子 agent 的 usage 计入父的预算 |
| 会话 | 独立 Entry 树，共享 `SessionStorage` | 子会话可单独查看，不污染父上下文 |
| 返回 | `content` 为结果摘要，`details` 为完整 transcript | 父上下文只吃摘要 |

**并发上限与 token 预算的 owner 在 agent-core，不在 taskflow。**

`repo-layout.md` §4.1 列了 `delegate_task`。它与 `spawn_agent` 的差别只是"是否等待返回"，
是同一个 tool 的一个参数，不是第二个 tool。**Phase 1 只做 `spawn_agent`（同步等待）。**

---

## 11. AgentEvent

对外唯一的观测面。agent-server 据此做 Projection（见 `protocol.md` §4）。

```ts
type AgentEvent =
  | { type: "message.start";  messageId: string; role: "assistant" }
  | { type: "block.start";    messageId: string; index: number; blockType: Block["type"] }
  | { type: "block.delta";    messageId: string; index: number; delta: string }
  | { type: "block.end";      messageId: string; index: number; block: Block }
  | { type: "message.end";    messageId: string; stopReason: StopReason }
  | { type: "tool.start";     callId: string; name: string; args: unknown }
  | { type: "tool.end";       callId: string; status: "ok" | "error"; details: unknown }
  | { type: "decision.requested"; request: DecisionRequest }
  | { type: "decision.resolved";  decisionId: string }
  | { type: "todo.updated";   items: Todo[] }
  | { type: "context.updated"; usage: ContextUsage }
  | { type: "run.end";        runId: string; stopReason: StopReason; usage: Usage }
  | { type: "error";          code: string; message: string }
```

- `block.end` 带完整 block，订阅方**不需要自己累积 delta**（虽然也可以）
- `tool.end` 带 `details`（完整数据），`content`（喂模型那份）不外发 —— UI 不需要
- 事件流**不是历史模型**。历史读 Entry

---

## 12. 目录结构

```text
packages/agent-core/
├── agent.ts              # createAgent，唯一公开面
├── loop/
│   ├── loop.ts           # §4.1 主流程
│   ├── tool-batch.ts     # §4.2
│   └── hooks.ts          # §4.3
├── decision/             # §6
├── queue/                # §7
├── context/
│   ├── budget.ts
│   ├── compaction.ts
│   ├── truncate.ts
│   └── todo.ts           # §9.4 保活与注入
├── session/
│   ├── entry.ts
│   ├── record.ts
│   ├── tree.ts           # fork / navigate / resume
│   └── storage.ts        # 接口，无实现
├── prompts/              # system prompt 组装、skills、templates、环境注入
│   └── todo.md           # §9.2 判定标准
├── sub-agent/            # §10
└── types.ts              # §3
```

`planning/` 与 `verification/` **不建目录**。
规划 = system prompt + `todo_write` 的输出；验证 = 跑测试的 tool + 模型读结果判断。
两者都是**资产 + tool**，没有独立状态和生命周期，撑不起模块（`repo-layout.md` §6.11）。

---

## 13. Phase 范围

**Phase 1**：loop / tool-batch / queue / context / session / decision / prompts / sub-agent / **todo**。全部。
两种模式（§1.1）都是 Phase 1 —— Chat 模式是 Project 模式去掉 `ctx`，不是额外工作量。

**推迟**

| 项 | 推到 | 理由 |
|---|---|---|
| `allow_always` 跨 session 持久化 | Phase 2 | 要先有 server 的用户态 |
| 跨 run 的 Entry 树 UI 导航 | Phase 2 | 前端未就绪，接口已留 |
| `delegate_task`（异步派生） | 按需 | 见 §9 |
