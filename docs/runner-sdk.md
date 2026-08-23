# Runner SDK

> `packages/runner-sdk` — Node.js / TypeScript 与 Rust Runner 之间的技术桥梁。
> 结构契约见 `repo-layout.md` §4.5，跨进程契约见 `proto.md`。

它是生产环境中 `ToolContext.fs` / `ToolContext.exec` 的唯一实现来源。所有文件系统、操作系统、Git 与 Shell 操作都必须经本包发往 Remote Runner；Node.js 进程不提供本地执行 fallback。

---

## 1. 定位

Runner SDK 负责一件事：把 Protobuf / gRPC 连接转换为 Node.js 可使用的
Runner Session。它是技术边界，不是 Control Plane。

**负责**

- 托管 Runner 主动建立的持久双向 gRPC 流
- 使用 `request_id` / `execution_id` 复用连接并关联请求、响应和事件
- Execution 发起、流式事件、取消和文件操作
- Protobuf codegen 与协议错误映射
- keepalive、断连检测、连接级超时和有界缓冲

**不负责**

| 职责 | Owner |
|---|---|
| Runner Registry、调度、用户权限、token 策略 | `apps/agent-server/src/modules/runner` |
| Execution 失败后是否重试 | `packages/taskflow` |
| Agent / Task / Conversation 语义 | 上层 |
| 启动、下载或内嵌 Rust Runner | `packages/runner` 仅负责 npm 分发和启动已构建 binary；`runner-sdk` 不负责 |

SDK 中不存在 Registry、Scheduler、Gateway 或业务 Service 抽象。

---

## 2. 唯一连接模型

Runner 始终是建连方：

```text
crates/runner
    │
    │ outbound persistent gRPC
    ▼
packages/runner-sdk
    │
    ▼
agent-server Runner Module
```

`remote` 表示 RPC / process boundary，不表示必须跨机器。即使两个进程位于同一台机器，
也必须经过真实 socket、Protobuf、gRPC streaming 和 Rust Runner。

跨 NAT 的关键 RPC 是 Runner 发起的双向流：

```proto
rpc Connect(stream RunnerEnvelope) returns (stream ServerEnvelope);
```

- `RunnerEnvelope`：注册信息、心跳、状态、ExecutionEvent、文件操作结果
- `ServerEnvelope`：接纳结果、ExecuteRequest、CancelRequest、文件操作请求、drain / shutdown 控制

不要为 Execute、Cancel 或文件操作再要求 Runner 开放入站端口。

---

## 3. 对外 API

```ts
createRunnerSdk(options: RunnerSdkOptions): RunnerSdk

interface RunnerSdk {
  listen(): Promise<void>
  onSession(listener: (candidate: RunnerSessionCandidate) => void): () => void
  close(): Promise<void>
}

interface RunnerSessionCandidate {
  identity: RunnerIdentity
  accept(): RunnerSession
  reject(code: string, message: string): Promise<void>
}

interface RunnerSession {
  readonly identity: RunnerIdentity
  readonly generation: string
  execute(request: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ExecutionEvent>
  cancel(executionId: string): Promise<void>
  readonly fs: FileSystemOps
  close(): Promise<void>
}

// 组装桥接：把 RunnerSession 转成 agent-core 的 ToolContext
toToolContext(session: RunnerSession, opts: { cwd: string; signal?: AbortSignal }): ToolContext
```

`toToolContext` 由本包导出：聚合 `execute` 事件流为
`Result<ExecOutput, ExecError>`，映射 `session.fs` 为 `FileSystem` 各方法的
`Result<T, FsError>`，fs / exec 不得 throw。集成测试 harness 与未来
agent-server Composition Root 共用这一份桥接（testing.md §3.1 要求两处装配
结构相同）。runner-sdk 对 `@nova/agent-core` 仅 type-only 依赖
（`ToolContext` / `Result` / 错误类型），先例是 `tools` 对 agent-core 的类型依赖；
不构成运行时循环（repo-layout.md §3.1 禁止的是 agent-core → runner-sdk 方向）。

`RunnerSessionCandidate` 只暴露协议上的连接身份。是否接纳、身份属于哪个用户、
如何进入 Registry，由 Runner Module 决定。`onSession` 只允许注册一个接纳处理器：
Runner Module 是接纳决策的唯一 owner，不允许多个订阅者竞争 `accept()` / `reject()`。

`RunnerSdkOptions.admissionTimeoutMs` 缺省为 30 秒。超时、未注册接纳处理器或 SDK
关闭时，尚未接纳的连接会被明确拒绝，不会无限挂起。

`ExecuteRequest` / `ExecutionEvent` 直接使用 Protobuf 生成类型，不再建立 DTO、
Mapper 或 TransportAdapter。

---

## 4. 连接与断线语义

| 关注点 | 契约 |
|---|---|
| 连接 | Runner 主动建立单个长连接 |
| 心跳 | Runner 定期上报；SDK 只暴露事实，Registry 决定状态 |
| 重连 | Runner 对连接做有界指数退避；每次连接产生新 `generation` |
| 执行中断连 | 当前 execution 失败为 `RUNNER_UNAVAILABLE` |
| 请求重放 | **禁止**；`Execute` 会产生真实副作用 |
| 重连后恢复 | 首版不做 Attach / Replay / Resume |

SDK 不将断线的旧 Session 悄悄替换为新 Session。`generation` 变化必须可见，
避免上层把两个 Runner 生命周期误当成一个。

---

## 5. 流式、背压与取消

| 关注点 | 策略 |
|---|---|
| 输出 | Protobuf 传 `bytes`；按 UTF-8 增量解码时保留跨 chunk 的多字节序列 |
| 复用 | 同一连接上用 `execution_id` / `request_id` 关联消息 |
| 有界缓冲 | 每个 session 和 execution 都有上限；不得无界聚合 |
| abort | 发送 `CancelRequest`，继续读取直到终态或连接失效 |
| 输出上限 | 超限后标记 `truncated`，仍消费事件直到 `Finished` |

取消不是关闭 gRPC 流。关闭整个流会同时影响该 Runner 上的其他 execution。

---

## 6. 错误边界

- 命令 `exit_code != 0` 是已完成的执行事实，不是传输错误。
- 协议错误、连接失效、队列满、超时和取消必须保留可区分的错误码。
- SDK 可让 `AsyncIterable` 因传输异常终止；将其转换为 Agent `ToolContext` 结果是组装边界的职责。
- SDK 不将 `BUSY` 自动改成重试，也不重发业务请求。

---

## 7. 目录结构

```text
packages/runner-sdk/src/
├── index.ts        # 唯一 public export
├── server.ts       # gRPC Connect 入口与 session 生命周期
├── session.ts      # 请求关联、execute / cancel / fs
├── tool-context.ts # RunnerSession → agent-core ToolContext 桥接
├── errors.ts       # 协议与连接错误映射
├── decode.ts       # 增量 UTF-8 解码
└── gen/            # Protobuf codegen 产物
```

不新增 Factory、Gateway、Connection Pool、Transport Adapter 或任何透传层。

---

## 8. 测试契约

核心集成测试的装配是：

```text
test process / agent-core
        │
        ▼
packages/runner-sdk 的真实 gRPC listener
        ▲
        │ outbound persistent gRPC
nova-runner 真实 Rust process
```

测试可以在 loopback 上运行，但不得用 stdio execution transport、Node
`child_process` 执行兜底、直接调用 Runner 内部、embedded Runner 或 mock execution
替代核心集成链路。
