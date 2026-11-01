# @nnova/harness

`@nnova/harness` 是一个面向 Node.js / TypeScript 应用的进程内 Agent 与 Task Framework。
它提供插件化运行时、Agent Loop、工具执行、会话记忆、有限并发任务调度、Flow 编排、等待恢复、模型适配和事件观测能力。

框架只负责可复用的运行时能力。订单、代码仓库、GPU Job、RAG 索引和客服系统等业务数据与外部服务，应由宿主应用通过插件、Tool 或 Task Handler 注入。

## 安装与验证

项目当前以 ESM 和严格 TypeScript 配置构建，运行环境要求 Node.js `>=22.18.0`。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm build
pnpm format:check
pnpm check:boundaries
pnpm test
```

## 快速开始

一个可运行的 Agent Kernel 通常由宿主显式安装以下能力：Session Store、Context Builder、Tool Runtime、Basic Loop 和 Model Adapter。

```ts
import { createAgentKernel, defineTool } from "@nnova/harness";
import { z } from "zod";
import { basicLoopPlugin } from "@nnova/harness/plugins/basic-loop";
import { contextPlugin } from "@nnova/harness/plugins/context";
import { memorySessionPlugin } from "@nnova/harness/plugins/session-memory";
import { toolRuntimePlugin } from "@nnova/harness/plugins/tools";

const quote = defineTool({
  name: "quote",
  description: "Calculate a total price.",
  effects: "read",
  inputSchema: z.object({ quantity: z.number(), price: z.number() }).strict(),
  outputSchema: z.object({ total: z.number() }).strict(),
  async execute(input) {
    return { total: input.quantity * input.price };
  },
});

const kernel = await createAgentKernel({
  maxConcurrentRuns: 4,
  configure: async (context) => {
    await context.plugin(memorySessionPlugin());
    await context.plugin(contextPlugin());
    await context.plugin(toolRuntimePlugin());
    await context.plugin(basicLoopPlugin());
    // Install a ModelAdapter plugin here, for example aiSdkModelPlugin(...).
  },
});

try {
  const agent = await kernel.createAgent({
    sessionId: "order-42",
    systemPrompt: "Use the quote tool when a total is needed.",
    tools: [quote],
    allowedTools: ["quote"],
  });

  const result = await agent.send({ text: "What is 3 × 19?" });
  console.log(result.status, result.text, result.usage);
} finally {
  await kernel.dispose();
}
```

直接调用 `agent.send()` 适合普通对话。需要排队、重试、依赖、并发控制或外部等待时，应使用 `kernel.tasks`，而不是在业务代码中自行创建无 owner 的后台 Promise。

## 核心边界

```text
contracts  →  kernel  →  session/run runtime
                    ↘  Agent Loop / Tool Runtime / Model Adapter
                    ↘  Task Engine / Queue / Task Store / Flow
```

- `contracts` 只定义稳定的公共类型、错误和能力键，不依赖具体插件。
- `kernel` 管理插件图、作用域、能力注册、准入、生命周期和资源清理，不包含领域业务逻辑。
- `plugins` 提供可替换能力实现。插件之间通过 Contract 能力通信，不直接导入其他插件的实现文件。
- 宿主应用持有身份、权限范围和业务 client，并通过受控上下文传给 Tool 或 Task Handler。

## 公共入口

根入口导出 `createAgentKernel`、`Context`、`definePlugin`、`defineTool`、`defineDynamicTool`、能力键、`FrameworkError` 以及全部公共 Contract 类型。

具体插件从 `@nnova/harness/plugins/*` 子路径按需导入；根入口不会隐式安装任何插件。

重点 Contract 包括：

- Agent：`AgentKernel`、`AgentSession`、`RunResult`、`AgentExecutor`
- Model：`ModelAdapter`、`ModelChunk`、`ModelRouteSnapshot`
- Tool：`ToolDefinition`、`ToolRuntime`、`ToolPolicy`
- Task / Flow：`TaskSpec`、`TaskHandle`、`TaskHandler`、`FlowSpec`、`FlowHandle`
- Plugin：`PluginManifest`、`PluginContext`、`CapabilityKey`、`ContributionKey`
- Session / Event：`SessionStore`、`SessionPersistence`、`CheckpointPolicy`、`EventJournal`、`EventObserver`

`SessionStore.load()` 和 `commit()` 返回 Promise；`commit()` 校验 `expectedRevision` 并确认状态提交。只有追加或按稳定 ID 幂等更新的 batch 才可用 `commitSessionUpdate()` 在冲突后重读版本并有限重试。`memorySessionPlugin` 支持用 `initialSnapshot` 恢复状态，`onCommit` 只提供内存观察通知。

`RunExecution.emit(event)` 保持同步 `void`，观察回调不阻塞执行。持久化插件可通过 `eventObservers` 同步入队并提供 `sessionPersistence.flush()`；独立的 `sessionCheckpointPolicyPlugin()` 在 `agent/pre-step`、`llm/stream`、`tools/execute` 边界等待 flush，失败阻止继续请求或工具派发。工具 flush 期间取消返回明确未派发的 `ABORTED_BEFORE_DISPATCH`。存储插件负责有界缓冲、串行写入、失败重试和关闭时 flush；尚未确认的流式通知可能在硬崩溃时丢失。

## 生命周期与错误语义

- Kernel、Session、Run、Task 和外部执行分别拥有自己的生命周期边界。
- `dispose()` 会拒绝新工作，取消并等待受管执行，再按逆序释放插件资源；调用可重复且复用关闭 Promise。
- `AbortSignal` 会传递到模型、工具、Task Handler 和外部 client。取消信号不等于底层函数已经停止；不合作的同进程函数在真正结束前不会提前释放资源。
- 接受前的配置、依赖和容量错误会抛出 `FrameworkError`；已接受的 Agent/Task 执行以结构化结果返回失败、取消或超时状态。
- Provider、工具和未知异常不会把 token、secret、原始 provider body 或 stack trace 暴露给公共错误。

## 当前范围

当前实现覆盖核心框架、内存型 Queue/Store、AI SDK/OpenAI Chat Adapter、动态 Schema/MCP-like Tool Bridge、Skills、Telemetry 以及 Coding 场景验证。

持久化数据库、跨进程恢复、HTTP 服务、GPU/3D 后端、RAG 索引和客服业务服务不属于内置实现范围；这些能力应由宿主以明确的 client 和插件组合接入。

更多设计决策和行为约束见：

- [架构设计方案](./docs/PLUGIN_AGENT_FRAMEWORK_PLAN.md)
- [实现任务与验收记录](./docs/IMPLEMENTATION_TASKS.md)
- [测试说明](./docs/TESTING.md)
- [Coding 场景测试](./tests/scenarios/coding.scenario.test.ts)
