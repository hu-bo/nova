# Plugins

Plugins 是框架能力的实现与组合层。每个插件通过 Manifest 声明作用域和依赖，通过 `setup()` 提供 singleton capability 或贡献 collection；宿主决定安装哪些插件及其配置。

插件不直接依赖其他插件实现，只依赖 `src/contracts` 和 `src/shared`。因此同一能力可以替换实现，例如使用不同的 Model Adapter、Session Store、Queue 或业务 Tool。

## 标准插件

| 插件                            | 作用域  | 提供能力               | 用途                                                 |
| ------------------------------- | ------- | ---------------------- | ---------------------------------------------------- |
| `basicLoopPlugin`               | session | `agentExecutor`        | 单步模型/工具循环、多轮执行、协议校验                |
| `contextPlugin`                 | session | `contextBuilder`       | 系统 Prompt、历史、贡献和上下文预算                  |
| `memorySessionPlugin`           | session | `sessionStore`         | 有界内存会话历史；异步 load/commit，支持初始快照恢复 |
| `sessionCheckpointPolicyPlugin` | session | `checkpointPolicies`   | 在模型请求、工具派发和下一步开始前等待存储 flush     |
| `summaryCompactionPlugin`       | session | `contextCompactor`     | 完整消息前缀的有界摘要压缩                           |
| `toolRuntimePlugin`             | session | `toolRuntime`          | 工具目录、allow-list、策略、准入、执行和结果         |
| `telemetryPlugin`               | session | `eventJournal`         | 有界事件保留、重放和隔离 observer                    |
| `skillsPlugin`                  | session | `contextContributions` | 显式选择的有界 Markdown 上下文资源                   |
| `mcpPlugin`                     | session | `toolDefinitions`      | 将宿主提供的 MCP-like client 桥接为动态工具          |
| `aiSdkModelPlugin`              | kernel  | `modelRouter`          | AI SDK/OpenAI Chat 单步模型适配和配置快照            |
| `memoryTaskStorePlugin`         | kernel  | `taskStore`            | Task/Flow 快照、TTL 回收和结果保留                   |
| `memoryTaskQueuePlugin`         | kernel  | `taskQueue`            | 有界 FIFO、优先级、aging 和延迟索引                  |
| `taskEnginePlugin`              | kernel  | `taskEngine`           | Task 验证、资源调度、重试、等待、子任务和 Flow       |
| `agentTaskPlugin`               | kernel  | `taskHandlers`         | 将 Task 调度接入已有 Agent Session                   |

插件工厂返回 `PluginDefinition`，不会自动安装。模型、工具、Task Handler 和业务 client 都必须由宿主显式注入。

## 常见组合

### Agent Runtime

最小 Agent 组合需要：

```text
session-memory + context + tools + basic-loop + model adapter
```

可按需增加 `compaction`、`telemetry`、`skills` 和 `mcp`。

接入持久化时，宿主插件提供 `sessionStore` 和 `sessionPersistence`，通过 `eventObservers` 同步接收通知、管理自己的缓冲与写入生命周期；显式安装 `session-checkpoint-policy` 控制三个执行边界的 flush 时机。通知接口保持同步，checkpoint policy 本身没有存储状态。

### Task Runtime

Task/Flow 组合需要：

```text
task-store-memory + queue-memory + task-engine
```

需要排队调用 Agent 时，再增加 `agent-task` 和一个已创建的 Agent Session。Agent Task 会复用 Agent 的会话互斥和准入，不创建第二套 Agent Loop。

## 写一个工具插件

静态工具使用 `defineTool`，通过 `toolDefinitions` contribution 注入到 Session：

```ts
import { defineTool, toolDefinitions } from "@nnova/harness";
import { z } from "zod";

const plugin = {
  manifest: {
    id: "example.inventory",
    version: "1.0.0",
    apiVersion: 1,
    scope: "session",
    requires: [],
    provides: [],
    contributes: [toolDefinitions],
  },
  setup(context) {
    context.contribute(
      toolDefinitions,
      defineTool({
        name: "inventory_get",
        description: "Read inventory for one SKU.",
        effects: "read",
        inputSchema: z.object({ sku: z.string().min(1) }).strict(),
        outputSchema: z.object({ available: z.number() }).strict(),
        async execute(input, toolContext) {
          toolContext.signal.throwIfAborted();
          return { available: await readInventory(input.sku) };
        },
      }),
    );
  },
};
```

业务 client 应通过插件工厂参数传入，而不是从全局变量、环境变量或 Kernel 私有表读取。工具必须声明 `effects`，使用执行上下文中的受信 identity、namespace、sessionId、executionId 和 AbortSignal。

## 写一个 Task Handler

Task Handler 通过 `taskHandlers` contribution 注册 `kind/version`。普通 Handler 返回 JSON；需要外部等待时使用 `protocol: "outcome"`，先通过 `createWait()` 预注册，再返回 waiting outcome，收到 signal 后由 `resume()` 继续。

```text
validate input → acquire resources → execute/resume
                → commit result or waiting state
                → retry/cancel/timeout → release resources
```

Handler 不应直接更新 Task Store、Queue 或 Flow 状态。子任务使用 `TaskContext.submitChild()`，并通过 `waitFor()` 等待；父任务等待期间会释放当前执行 Lease，子任务结束后重新获取资源。

## 生命周期与安全边界

- `setup()` 只注册能力和 cleanup；跨网络或外部 client 的连接要绑定到插件 Scope。
- `onReady()` 用于读取最终 contribution 集合；ready 后 Registry 冻结。
- 工具执行必须经过 Tool Runtime，不能让模型或 Provider 直接执行远程工具。
- unknown 副作用不能自动重试；写操作只有在明确幂等时才允许重试。
- 外部 Job 是否真正结束由宿主 client 确认，不能因为发出 AbortSignal 就提前释放真实资源。
- 业务插件可以失败某个动作，但不应修改 Kernel 的会话表、调度状态或另一个插件的内部集合。

## 当前范围

本目录提供通用运行时插件和可替换适配边界，不内置 3D/GPU、RAG、订单、客服、数据库、HTTP 服务或跨进程恢复。此类能力应由宿主业务包实现为 Tool、Task Handler、Flow、Context Contribution 或外部 client，再通过上述 Contract 组合。
