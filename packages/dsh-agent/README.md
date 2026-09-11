# `@nnova/dsh-agent`

进程内、多轮业务 Agent。内核管理模型配置和并发额度，会话管理历史、工具、取消和压缩。公共接口不暴露 DSH 类型。

## 使用

```ts
import { createDshAgentKernel, defineTool } from "@nnova/dsh-agent";

// 配置由业务方从数据库读取，apiKey 已解密。
const kernel = await createDshAgentKernel({
  models: [
    {
      id: "qianwen-fast",
      protocol: "anthropic",
      baseURL: modelConfig.baseURL,
      apiKey: modelConfig.apiKey,
      model: "qwen3.8-flash",
      contextWindow: modelConfig.contextWindow,
      maxOutputTokens: 4096,
    },
  ],
  defaultModel: "qianwen-fast",
  maxConcurrentRuns: 1,
});

const quote = defineTool<{ quantity: number; unitPrice: number }>({
  name: "quote_total",
  description: "计算商品报价总额",
  parameters: {
    type: "object",
    properties: {
      quantity: { type: "integer", minimum: 1 },
      unitPrice: { type: "number", minimum: 0 },
    },
    required: ["quantity", "unitPrice"],
    additionalProperties: false,
  },
  async execute({ quantity, unitPrice }, { signal, sessionId }) {
    return { total: quantity * unitPrice };
  },
});

const session = await kernel.createAgent({
  sessionId: "conversation-123",
  systemPrompt: "你是采购助手，金额计算必须调用工具。",
  tools: [quote],
});

await session.send({ text: "项目代号 BLUE-57，报价 3 件商品，每件 19 元。" });
const result = await session.send({
  text: "刚才的项目代号和报价是多少？",
  timeoutMs: 60_000,
  onEvent(event) {
    if (event.type === "assistant.delta") process.stdout.write(event.text);
  },
});
console.log(result.status, result.text, result.toolCalls, result.usage);

await session.dispose();
await kernel.dispose(); // 通常放在应用关闭阶段，异常路径也应执行。
```

工具输入按 JSON Schema draft-07 严格校验，不转换类型或填充默认值。`defineTool<Args>` 的 TypeScript 类型应与 schema 一致；运行时以 schema 为准。工具返回无损 JSON；身份、项目权限和令牌由服务端闭包捕获，不作为模型参数。执行函数接收 `signal` 与 `sessionId`。

## 模型配置与更新

| 字段              | 语义                                                           |
| ----------------- | -------------------------------------------------------------- |
| `id`              | 业务模型配置 ID                                                |
| `protocol`        | `anthropic`、`openai-chat`、`openai-responses`                 |
| `baseURL`         | 与协议匹配的 HTTP(S) 服务基础地址                              |
| `apiKey`          | 直接传入的密钥，不修改环境变量                                 |
| `model`           | 供应商模型 ID                                                  |
| `contextWindow`   | 必填，由部署方确认的上下文容量                                 |
| `maxOutputTokens` | 默认 `min(4096, floor(contextWindow / 4))`，必须小于上下文容量 |

```ts
await kernel.updateModel({
  id: "qianwen-quality",
  protocol: "anthropic",
  baseURL: nextConfig.baseURL,
  apiKey: nextConfig.apiKey,
  model: nextConfig.model,
  contextWindow: nextConfig.contextWindow,
  maxOutputTokens: 8192,
});
await session.send({ text: "检查流程是否遗漏规则", model: "qianwen-quality" });
```

`updateModel` 新增或整体替换配置。会话创建时可指定默认 `model`；`send.model` 只覆盖本轮，省略时回到会话默认模型。每轮开始固定配置，更新不影响该轮的工具循环、摘要或输出上限。密钥不进入历史、事件、结果或日志。

`maxOutputTokens` 是上限，不保证实际生成长度。当前 pi-ai 还会按自己的输入估算预留 4096 token 安全空间，临近容量时可能进一步降低实际请求的输出上限。上下文容量必须填写真实模型能力，不宜为触发压缩而伪造小容量；测试压缩可降低 `thresholdRatio`。

## 压缩与生命周期

```ts
const session = await kernel.createAgent({
  sessionId: "another-conversation",
  systemPrompt: "你是业务助手",
  compression: { enabled: true, thresholdRatio: 0.8 },
});
const compression = await session.compact({ timeoutMs: 60_000 });
// compacted | skipped | failed | cancelled | timed_out

const controller = new AbortController();
const pending = session.send({ text: "分析流程", signal: controller.signal });
controller.abort(); // 或 session.cancel()
await pending;
await session.send({ text: "继续讨论" });
```

- `send()` 只提交新消息，内部完成模型和工具循环。同一会话同时只允许一个 `send` 或 `compact`；不同会话共享 `maxConcurrentRuns`，默认 1，满额立即拒绝，不隐式排队。
- 默认启用自动压缩，阈值为预留输出预算后输入容量的 80%；比例可设置为大于 0.16、小于 1。复用 DSH token meter 与 compaction-basic，保留系统提示词、近期上下文和完整工具配对。原始事件保留在内存。
- 手动压缩使用最近一次已提交轮次的模型配置 ID，解析其最新配置；尚无轮次则用会话默认模型。摘要始终使用当前操作的模型。关闭自动压缩不影响显式 `compact()`。
- 切换小容量模型会先检查历史。若摘要输入或不可压缩内容也无法容纳，操作明确失败。摘要不是无损记忆；摘要失败不会替换原始历史。
- `send` 和 `compact` 默认超时 120 秒。取消是协作式的，工具必须监听或转发 `signal`；内核等待其退出。取消本轮后可继续对话。
- `dispose()` 可重复调用，内核关闭会取消全部操作并释放会话。空闲会话由调用方主动释放；第一版没有持久化、跨进程恢复或自动空闲回收。

## 结果与错误

`send()` 返回 `sessionId`、`turnId`、`status`、最后一步的 `text`、全部 `toolCalls`，以及可获得的 `usage` 和归一化 `error`。终态为 `succeeded`、`failed`、`cancelled`、`timed_out`。模型可能在工具失败后继续回答，应同时检查工具结果。用量来自供应商，包含本轮已记录的摘要用量，不作为独立计费账本。

事件包括 `turn.started`、`assistant.delta`、`tool.started`、`tool.finished`、`compression.started`、`compression.finished`、`turn.finished`。文本增量包括中间步骤；手动压缩事件的 `turnId` 标识维护操作。`onEvent` 为同步通知，异步投递由调用方管理；抛错会取消操作并返回 `EVENT_CALLBACK_FAILED`。工具业务数据由调用方控制，错误不暴露供应商原始响应。

提交错误通过 `DshAgentError.code` 拒绝 Promise，例如 `INVALID_CONFIG`、`INVALID_INPUT`、`UNKNOWN_MODEL`、`DUPLICATE_SESSION`、`BUSY`、`CAPACITY`、`CLOSED`。已开始的失败通过结果表达，例如 `CONTEXT_LIMIT`、`OUTPUT_LIMIT`、`MODEL_FAILED`、`OPERATION_FAILED`。

## 验证与依赖

```sh
pnpm --filter @nnova/dsh-agent typecheck
pnpm --filter @nnova/dsh-agent lint
pnpm --filter @nnova/dsh-agent format:check
pnpm --filter @nnova/dsh-agent test
pnpm --filter @nnova/dsh-agent test:live-model
```

普通测试通过本地 HTTP 服务验证真实 DSH 装配与三种协议，不访问外部模型。真实测试显式加载根 `.env`，将 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`MODEL` 映射为直接传入的配置，缺配置会失败。测试上下文预算默认 32768，可通过 `NOVA_TEST_CONTEXT_WINDOW` 覆盖，不代表对供应商容量的推断。

2026-09-11 已使用 `qwen3.8-flash` 完成真实三轮对话、一次报价工具执行、手动压缩和压缩后的事实回忆。

DSH 统一锁定 `0.1.5-rc.2`，Cordis 为 `4.0.2`。额外直接依赖用于满足上游 peer 契约，不代表挂载文件、Shell、审批或本地执行插件。每个会话独立持有 Context；不包含 Worker、队列或业务服务。
