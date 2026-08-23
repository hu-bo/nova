# taskflow

> `packages/taskflow` — 编排层，且只是编排层。
> 结构契约见 `repo-layout.md` §4.2。**本包是全仓库风险最高的抽象**，§8 有复核结论。

---

## 1. 定位

**负责**：Task 与依赖、动态追加 Task、Ready Queue + 有界并发、Retry、Timeout、Cancellation 传播、状态机、Task 级事件流。

**不负责**：LLM 推理、Prompt、Message、Tool 语义、Runner 的存在、Provider 级重试、持久化。

**依赖**：无。纯调度器，可独立单测，`package.json` 的 `dependencies` 应为空。

> 本包**不认识** Agent / Tool / Runner / Execution。它只认识"一个会返回 Promise 的函数"和"它们之间的先后关系"。
> 一旦这里出现 `import` 任何 nova 内部包，说明职责划错了。

---

## 2. 对外 API 面

```ts
createFlow(options?: FlowOptions): Flow

interface Flow {
  addTask(task: TaskSpec): TaskId
  run(): AsyncIterable<TaskEvent>
  cancel(taskId?: TaskId): void      // 省略 taskId = 取消整个 flow
}

interface FlowOptions {
  concurrency?: number     // 缺省 8
  defaultTimeoutMs?: number
  defaultRetry?: RetryPolicy
}
```

四个方法。没有 `pause` / `resume` / `getGraph` / `FlowBuilder`。

---

## 3. 核心类型

```ts
interface TaskSpec {
  id?: TaskId                                  // 省略则自动生成
  deps?: TaskId[]
  run: (ctx: TaskContext) => Promise<unknown>
  timeoutMs?: number
  retry?: RetryPolicy
}

interface TaskContext {
  taskId: TaskId
  attempt: number                              // 从 1 开始
  signal: AbortSignal
  addTask(spec: TaskSpec): TaskId              // 动态追加，见 §5
  results: ReadonlyMap<TaskId, unknown>        // 已完成依赖的返回值
}

interface RetryPolicy {
  max: number                                  // 最大重试次数，不含首次
  backoffMs?: number                           // 缺省 500，指数退避 + 抖动
  retryable?: (error: unknown) => boolean      // 缺省：全部可重试
}
```

`TaskSpec` 只有 5 个字段。没有 `name` / `priority` / `tags` / `metadata` —— 需要时由调用方自己在闭包里带。

---

## 4. 状态机

```text
            ┌──────────────────────────────┐
            │                              │
 pending ──► ready ──► running ──► succeeded
    │          │          │
    │          │          ├──► failed ────► ready   (还有 retry 额度)
    │          │          ├──► timedOut ──► ready   (同上)
    │          │          └──► cancelled
    │          │
    └──────────┴──────────────────► skipped         (依赖终态不是 succeeded)
```

| 状态 | 含义 |
|---|---|
| `pending` | 有依赖未完成 |
| `ready` | 依赖全部 succeeded，在队列里等并发额度 |
| `running` | 正在执行 |
| `succeeded` | `run` 正常返回 |
| `failed` | `run` throw 且重试额度耗尽 |
| `timedOut` | 超过 `timeoutMs` 且重试额度耗尽 |
| `cancelled` | 被 `cancel()` 取消 |
| `skipped` | 依赖进入 `failed` / `timedOut` / `cancelled` / `skipped` |

**`skipped` 会沿依赖边传播**。一个任务失败，它的整棵下游变 `skipped`，而不是永远 `pending`。
Flow 在"没有 running 且没有 ready"时结束。

**Task 状态 ≠ Execution 状态。** 一个 Task 可以有多个 Execution（每次 retry 一个），
Execution 是 `proto/` 里的概念，本包不认识。

---

## 5. 动态追加

```ts
ctx.addTask({ deps: [ctx.taskId], run: ... })   // 在任务内部长出后继
flow.addTask({ ... })                           // run() 之前或运行中，从外部追加
```

| 规则 | 说明 |
|---|---|
| 依赖已完成的任务 | 允许，立即 `ready` |
| 依赖 `failed` / `skipped` 的任务 | 允许，立即 `skipped` |
| 依赖不存在的 TaskId | **抛错**，不静默等待 |
| 形成环 | **抛错**，追加时做增量环检测 |
| 给已存在的任务加依赖 | **不支持**。依赖只在 `addTask` 时声明 |

DAG 是**动态状态**，不是启动时一次性固定的结构。但它只增不改。

---

## 6. 并发与取消

**并发**：一个信号量，上限 `concurrency`。ready 队列 FIFO，无优先级。

> **资源限制不在这里。** 并发数是任务数，不是 CPU / 内存。
> 资源上限由 Runner 独立强制（`runner.md` §5），两个维度互不替代（CLAUDE.md Rule 10）。

**取消**：

```text
flow.cancel(taskId)
   ├── running  → abort signal → 等 run 收敛 → cancelled
   ├── ready    → 直接 cancelled，不再启动
   └── pending  → 直接 cancelled
   └── 下游全部 skipped

flow.cancel()  → 上述对全部未终态任务生效
```

取消后 `run()` 的迭代器**正常结束**，不 throw。

**Retry 归属**：Runner 只报告事实（`Failed` / `TimedOut`），重试决策在这里。
Provider 级重试（LLM 429、连接重置）在 `model-adapters`，不在这里（`repo-layout.md` §6.9）。

---

## 7. 事件

```ts
type TaskEvent =
  | { type: "task.ready";     taskId: TaskId }
  | { type: "task.started";   taskId: TaskId; attempt: number }
  | { type: "task.succeeded"; taskId: TaskId; result: unknown; durationMs: number }
  | { type: "task.retrying";  taskId: TaskId; attempt: number; delayMs: number; error: unknown }
  | { type: "task.finished";  taskId: TaskId; status: TerminalStatus; error?: unknown }
  | { type: "flow.finished";  counts: Record<TerminalStatus, number> }

type TerminalStatus = "succeeded" | "failed" | "timedOut" | "cancelled" | "skipped"
```

四个终态用**一个 `task.finished` 带 status**，不用四种事件类型。
`task.succeeded` 单列是因为它要带 `result`。

`run()` 返回 `AsyncIterable<TaskEvent>`，消费完即 flow 结束。**没有回调注册、没有 EventEmitter。**

---

## 8. 复核结论（重要）

Coding Agent 的真实并行度来自两处：

1. 同一条 assistant message 里的多个 tool call（`agent-core.md` §4.2，天然并行）
2. Sub-agent 派生（`agent-core.md` §10）

原计划 Phase 1 结束复核："若 agent-core 的实际用法只有'一批 tool call 并发 + 等全部完成'，
则本包合并进 agent-core 并删除"。

**复核结论（2026-08-17，agent-core 开工前定案）：保留本包，agent-core 复用本包调度。**
tool batch 与 Sub-agent 派生的并发执行都走 `createFlow`（见 §8.1），
agent-core 不再自写信号量/队列/状态机。复用即保留理由，退出条件作废。

### 8.1 agent-core 的并发如何复用本包

**已决：agent-core 复用 `@nova/taskflow`。取代旧决策"三处信号量各自实现，不抽公共模块"。**

| 位置 | 上限 | 实现 |
|---|---|---|
| `agent-core/loop/tool-batch` | `toolConcurrency`，缺省 8 | `createFlow({ concurrency })`，一个 tool call 一个 task；写文件按路径串行用 `deps` 表达 |
| `agent-core/sub-agent` | `subAgent.maxConcurrent`，缺省 4 | `createFlow({ concurrency })` |
| `crates/runner` | Rust 侧队列 | Rust 实现，本来就无法共享 |

改口的理由：tool batch 并非只有"并发 + 等全部完成"——它有**结果按原序回填、按路径串行、
整批 terminate 判定**等调度语义。这些在 agent-core 里重写一遍就是第二个 taskflow（CLAUDE.md Rule 2），
不如直接复用本包的事件流与状态机。若实现中发现 `createFlow` 语义不够，
**扩展本包**，而不是在 agent-core 里另起炉灶。

仍不共享的：**退避数学**。四处退避（本包 / `model-adapters` / `runner-sdk` / web-ui SSE）
判据完全不同且分属不同 owner（§6 / `repo-layout.md` §6.9），各自实现。

---

## 9. Phase 范围

**Phase 1**：§2–§7 全部。

**第一版不做**（idea.md §38 已明确）：Workflow DSL、BPMN、表达式引擎、
分布式 Scheduler、持久化 DAG Engine、Kubernetes Scheduler、优先级队列、任务图可视化导出。
