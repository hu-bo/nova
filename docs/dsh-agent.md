# DSH Business Harness

## 定位

`packages/dsh-agent` 是一套独立的 DeepSeek Harness 业务 Agent 基座，面向低代码、在线表单、工作流配置生成和 Vibe Coding 等宿主。它不替换 `packages/agent-core`，也不依赖任何 `@nova/*` 包。

它负责组装 DSH 的 LLM、Session、Prompt、Tool 和 Agent Loop，并为一次 run 提供进程内并发容量、取消、单轮超时和释放顺序。调用方直接传业务 prompt 和 DSH `ToolDefinition[]`；不再增加 AgentModule、业务 service 或工具 wrapper。

## 边界

- 业务服务/Worker 是队列、租户身份、权限、业务状态、幂等和重试的唯一 owner。
- 本包只提供进程内的并发闸门 `maxConcurrentRuns`（默认 1）；同一个 `runId` 只由一个 Worker 执行这件事，横向部署时由业务侧的队列或租约保证，不在包内。
- 一次 run 的 Tool 仅在自身 agent scope 注册，guard 只允许配置的业务 Tool；不加载本机 FS、Shell、子进程或泛用网络能力。
- Session Event Log 可用于投影和审计，但本包不提供跨进程持久化 backend；业务运行表仍是查询与恢复的事实源。
- Provider route、模型、Base URL 与 credential 环境变量名由服务端配置，不能由 prompt 或 Tool 参数决定。密钥不可写入 prompt、event 或日志。

## 对外 API

```ts
createDshAgentKernel({ models, defaultModel, maxConcurrentRuns? })
kernel.createAgent({ sessionId, model?, systemPrompt, tools?, compression? })
kernel.updateModel(model)
kernel.dispose()

session.send({ text, model?, signal?, timeoutMs?, onEvent? })
session.compact(options?)
session.cancel()
session.dispose()
```

`session.send()` 返回最终 assistant 文本、业务 Tool 调用记录和稳定的终态（`succeeded` / `failed` / `cancelled` / `timed_out`），`onEvent` 逐条投喂 `assistant.delta`、`tool.started`、`tool.finished` 和压缩事件。provider 原始错误、prompt、工具参数和密钥不会被包装进公开错误消息：失败只暴露 `error.code` 与本包自己的说明。

`models` 是模型配置数组，`defaultModel` 指其中一个 `id`；`send.model` 只覆盖本轮。字段语义（含新加的 `reasoning` 推理档位）见 `packages/dsh-agent/README.md`。

## 验证

- `test/kernel.test.ts`：起本地假网关（`test/provider.ts`）拦截真实 HTTP 请求，覆盖并发隔离、容量、取消、压缩、上下文预检，以及**线上请求体**（例如 `thinking` 参数随 `reasoning` 档位变化）。不发真实网络请求。
- `test/live-model.integration.test.ts`：`NOVA_TEST_LIVE=1` 时才跑的真实模型集成测试。它从根 `.env` 加载模型供应商配置，要求真实模型调用受控业务 Tool，再验证最终文本和完整 Tool Event 闭环。测试显式传 `reasoning: "off"`：所连网关默认开启思考，不声明档位就没有 `thinking` 参数，思考会吃掉全部输出预算。

模型配置字段见 `packages/dsh-agent/README.md`。
