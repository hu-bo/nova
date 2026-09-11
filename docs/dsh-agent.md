# DSH Business Harness

## 定位

`packages/dsh-agent` 是一套独立的 DeepSeek Harness 业务 Agent 基座，面向低代码、在线表单、工作流配置生成和 Vibe Coding 等宿主。它不替换 `packages/agent-core`，也不依赖任何 `@nova/*` 包。

它负责组装 DSH 的 LLM、Session、Prompt、Tool 和 Agent Loop，并为一次 run 提供进程内容量、取消、deadline、步数上限和释放顺序。调用方直接传业务 prompt 和 DSH `ToolDefinition[]`；不再增加 AgentModule、业务 service 或工具 wrapper。

## 边界

- 业务服务/Worker 是队列、租约、租户身份、权限、业务状态、幂等和重试的唯一 owner。
- `RunLeaseManager` 是可选的外部单写者 seam；横向部署时必须由它或任务队列保证同一个 `runId` 只由一个 Worker 执行。
- 一次 run 的 Tool 仅在自身 agent scope 注册，guard 只允许配置的业务 Tool；不加载本机 FS、Shell、子进程或泛用网络能力。
- Session Event Log 可用于投影和审计，但本包不提供跨进程持久化 backend；业务运行表仍是查询与恢复的事实源。
- Provider route、模型、Base URL 与 credential 环境变量名由服务端配置，不能由 prompt 或 Tool 参数决定。密钥不可写入 prompt、event 或日志。

## 对外 API

```ts
createDshAgentKernel({ model, maxConcurrentRuns, leaseManager })
dshAgentKernel.run({ runId, agentId, systemPrompt, input, tools, signal? })
dshAgentKernel.cancel(runId)
dshAgentKernel.dispose()
```

`dshAgentKernel.run()` 返回 DSH Session events、最终 assistant 文本和稳定的终态；provider 原始错误、prompt、工具参数和密钥不会被包装进公开错误消息。

## 验证

唯一集成测试在 `packages/dsh-agent/test/live-model.integration.test.ts`。它从根 `.env` 加载模型供应商配置，要求真实模型调用受控业务 Tool，再验证最终文本和完整 Tool Event 闭环。
