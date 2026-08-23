# protocol

> `packages/protocol` — 浏览器 ↔ agent-server 的唯一共享契约。
> 结构契约见 `repo-layout.md` §4.7。Phase 2。

---

## 1. 定位

**负责**：`ChatMessage` / `Block` 类型、SSE 事件类型、REST 请求响应 schema。

**不负责**：任何运行时逻辑；转发或 re-export `proto/` 类型。

**硬约束**

| 约束 | 检验方式 |
|---|---|
| 零运行时依赖（schema 校验库除外） | `package.json` 的 `dependencies` 只允许 `zod` |
| 浏览器可直接 import | 无 `node:` import |
| 不 re-export `proto/` 类型 | 两个契约面独立演进（`repo-layout.md` §3.2） |
| 不被 `agent-core` / `taskflow` / `tools` import | UI 契约不得渗入运行时 |

**为什么不复用 agent-core 的 `Message`**：两者演进节奏不同。UI 需要 `code` / `diff` / `file`
这些**渲染类型**，模型上下文不需要；模型需要 `content` 的截断版本，UI 需要完整 `details`。
强行共用会让任一侧的改动都波及另一侧。

---

## 2. Block

```ts
type Block =
  | { type: "text";     text: string }
  | { type: "thinking"; text: string }
  | { type: "code";     language: string; code: string; path?: string; startLine?: number }
  | { type: "diff";     path: string; diff: string; added: number; removed: number }
  | { type: "file";     path: string; kind: "file" | "dir"; size?: number }
  | { type: "tool_call";   callId: string; name: string; args: unknown; status: ToolStatus }
  | { type: "tool_result"; callId: string; status: "ok" | "error"; blocks: Block[] }
  | { type: "todo";     items: Todo[] }
  | { type: "error";    code: string; message: string }

type ToolStatus = "running" | "ok" | "error" | "cancelled"

interface Todo {
  id: string
  text: string
  status: "pending" | "in_progress" | "completed" | "blocked"
  note?: string
}
```

**代码是结构化的，不让 UI 从 Markdown 里解析。** `CodeBlock` 带 `language` / `path` / `startLine`，
前端直接高亮并给出"跳转到文件"的入口。

**`tool_result.blocks` 递归嵌 Block**，这样 tool 结果可以是 diff、可以是文件列表、
可以是代码，而不是被压成一个 string（idea.md §24）。

`thinking` 只承载**允许展示的摘要**。provider 为后续工具调用轮次要求回传的
`reasoning_content` / `reasoning_details` 属于 agent-core 的内部 Entry payload，可以随会话保存，
但 Projection 必须只取可展示文本并剥离 provider 元数据；它不进入这里定义的 UI Block，也不进入
`messages.blocks`（idea.md §23）。

> 没有 `artifact` block。Phase 1/2 没有 artifact 存储（`proto.md` §7），
> 加了就是一个渲染不出东西的空类型。

---

## 3. REST

所有路径前缀 `/api`，全部要 Bearer token。

| Method | Path | Body / Query | Response |
|---|---|---|---|
| `GET` | `/projects` | — | `Project[]` |
| `POST` | `/projects` | `{ name, workspace }` | `Project` |
| `PATCH` | `/projects/:id` | `{ name }` | `Project` |
| `DELETE` | `/projects/:id` | — | `204` |
| `POST` | `/conversations` | `{ title?, projectId? }` | `Conversation` |
| `GET` | `/conversations` | `?projectId&limit&cursor` | `Page<Conversation>` |
| `GET` | `/conversations/:id/messages` | `?before&limit` | `Page<ChatMessage>` |
| `POST` | `/conversations/:id/messages` | `SendMessage` | `202` |
| `POST` | `/conversations/:id/abort` | — | `204` |
| `POST` | `/decisions/:decisionId` | `DecisionResponse` | `204` |
| `GET` | `/conversations/:id/events` | `Last-Event-ID` header（可选） | **SSE 流** |

```ts
interface Project {
  id: string
  name: string
  workspace: string          // 创建后不可改
  runnerState: "ready" | "busy" | "draining" | "disconnected" // 派生自 Registry，非存储字段
  createdAt: number
}

interface Conversation {
  id: string
  projectId: string | null   // null = 独立 Chat 模式
  title: string
  createdAt: number
  updatedAt: number
}
```

`POST /conversations` **不带 `projectId` 就是 Chat 模式**，没有单独的 `mode` 字段 ——
模式完全由 `projectId` 是否存在决定，两个字段会有不一致的可能。

`Project.workspace` 只能在创建时给。改 workspace 等于换了个项目，
应该建新 project（`agent-server.md` §4）。

`DELETE /projects/:id` 会级联删除该 Project 下的 Conversation 及其历史，UI 必须在调用前
明确展示影响范围并确认。独立 Chat 不属于 Project，不受该操作影响。

`runnerState` 是 Registry 的实时派生值，不是数据库列。前端靠它决定
是否提示"Runner 未连接"（`agent-web-ui.md` §7.3）。
多个 Runner 匹配同一 Project 时按 `ready > busy > draining > disconnected` 聚合；draining
表示已有连接正在排空但不再接收新执行。

```ts
interface ChatMessage {
  id: string
  conversationId: string
  role: "user" | "assistant"
  blocks: Block[]
  status: "streaming" | "done" | "error" | "aborted"
  createdAt: number
}

interface SendMessage {
  text: string
  queue?: "steering" | "followUp" | "nextRun"   // 缺省：无运行时新开 run，运行中入 steering
}

interface Page<T> { items: T[]; nextCursor: string | null }
interface ApiError { code: string; message: string }     // 非 2xx 一律这个形状
```

所有 cursor 都是不透明字符串。Conversation cursor 编码 `(updated_at, id)`，Message cursor
编码 `(created_at, seq)`；客户端不得解析，server 必须用完整复合游标做 keyset pagination，
不能只按时间戳翻页而造成同毫秒数据重复或遗漏。

发送消息返回 `202 Accepted` 且没有响应体。当前 `agent.prompt()` 只在 run 结束时返回 `runId`，
HTTP 层不能为了凑 `{ runId }` 阻塞到模型完成，也不能在 server 伪造第二套 run ID。运行进度和
最终 `runId` 通过 SSE 的 `run.end` 观察。conversation 空闲时，无论 `queue` 是否给出都启动
一个新 run；运行中缺省进入 steering，显式值按对应队列处理。

**十一个端点**，其中 4 个是 project 的纯 CRUD。没有 `/tasks` / `/executions` / `/runners` 的 CRUD ——
Phase 2 的 UI 只需要看到对话与其中的 tool 执行，Task / Execution 作为 Block 呈现，
不需要独立资源。真需要运维视图时再加。

---

## 4. SSE

`GET /conversations/:id/events`，`text/event-stream`。

```ts
type UiEvent =
  | { type: "message.start";  messageId: string; role: "assistant" }
  | { type: "block.start";    messageId: string; index: number; block: Block }   // 骨架
  | { type: "block.delta";    messageId: string; index: number; delta: string }
  | { type: "block.end";      messageId: string; index: number; block: Block }   // 完整
  | { type: "message.end";    messageId: string; status: ChatMessage["status"] }
  | { type: "tool.output";    callId: string; stream: "stdout" | "stderr"; text: string }
  | { type: "decision.requested"; request: DecisionRequest }
  | { type: "decision.resolved";  decisionId: string }
  | { type: "todo.updated";   items: Todo[] }
  | { type: "run.end";        runId: string; stopReason: string }
  | { type: "error";          code: string; message: string }
```

每条 SSE 消息带 `id:`（单调递增），断线重连时客户端发 `Last-Event-ID` header，
server 从该点之后重放（缓冲区见 `agent-server.md` §6）。
不接受 query 参数形式的 event ID，避免同一语义出现两个输入来源。

### Projection 映射

agent-server 负责这层翻译。**UI 消费 Projection，不是内部运行时状态**（idea.md §26）。

| 内部 | UI |
|---|---|
| `AgentEvent.block.*` (text/thinking) | 同名 UiEvent，block 类型直传 |
| `AgentEvent.tool.start` | `block.start` + `{type:"tool_call", status:"running"}` |
| `AgentEvent.tool.end` | `block.end`，由 `details` 派生 `code`/`diff`/`file` 子 block |
| `ExecutionEvent.Output`（经 tool 的 `onOutput`） | `tool.output` |
| `AgentEvent.todo.updated` | `todo.updated` **且** 消息流里保留一个 `todo` block |
| `TaskEvent.*` | **不外发**。taskflow 是内部编排细节 |
| `AgentEvent.decision.*` | 同名 UiEvent |

**`tool.end` 的 details → Block 转换是 Projection 的主要工作量**，
每个 tool 一个转换函数（`agent-server.md` §7）。这是"UI 不解析 Markdown"的实现处。

`TaskEvent` 不外发是刻意的：一旦外发，前端就会开始依赖 taskflow 的存在，
而 taskflow 有退出条件（`taskflow.md` §8）。

**TODO 是唯一一个双通道外发的东西**，两条通道语义不同：

| 通道 | 语义 | UI 用途 |
|---|---|---|
| `todo` block（在消息流里） | "第 N 轮时计划长这样" | 历史记录，可回看计划怎么演变的 |
| `todo.updated` 事件 | "现在的计划是这样" | 常驻面板 |

只有 block 的话，面板得翻历史找最后一次调用；只有事件的话，刷新页面就丢了。
两者都要，且**面板永远以事件为准**。

---

## 5. Decision

类型与 `agent-core.md` §6 **结构相同但独立定义**，不 import agent-core。

```ts
type DecisionRequest =
  | { kind: "approval"; decisionId: string; toolName: string; args: unknown; risk: "read" | "write" | "exec" }
  | { kind: "question"; decisionId: string; question: string; options: string[]; multiSelect: boolean }

type DecisionResponse =
  | { kind: "approval"; decision: "allow" | "deny" | "allow_always"; reason?: string }
  | { kind: "question"; answers: string[] }
```

相比 agent-core 的定义少了 `callId`（前端不需要），其余一致。

**回填走 REST（`POST /decisions/:decisionId`）而不是 SSE 反向通道**：
SSE 是单向的，且回填需要明确的成功/失败响应。

---

## 6. 目录结构

```text
packages/protocol/src/
├── index.ts
├── block.ts       # §2
├── rest.ts        # §3
├── events.ts      # §4
└── decision.ts    # §5
```

只有类型和 zod schema。**任何函数体超过"返回一个 schema"都说明放错了地方。**

---

## 7. 版本演进

Phase 2 内不做版本协商。前后端同仓库同步发布。

破坏性变更的规矩：**先加新字段并双写，再切前端，最后删旧字段**，三步分开发布。
路径里不加 `/v1` —— 加了就要维护，而现在没有外部消费者。
