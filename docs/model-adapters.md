# model-adapters

> `packages/model-adapters` — 抹平 provider 差异，产出统一流式事件。
> 结构契约见 `repo-layout.md` §4.4。

---

## 1. 定位

**负责**

- 原生 `fetch` + 手写 SSE 解析抹平 provider 差异，输出统一流式事件（不引入 `@ai-sdk`，理由见 §6）
- **Provider 级**重试与限流：429、5xx、连接重置、provider 超时
- 模型能力声明：thinking 档位、是否支持并行 tool call、context window

**不负责**

| 不负责 | 归属 |
|---|---|
| Prompt 构造 | `agent-core/prompts` |
| Execution 级 retry（命令失败、Runner 断连） | `taskflow` |
| 账号、计费、配额、路由 | `model-gateway`（Phase 2） |
| 上下文压缩、截断 | `agent-core/context` |

---

## 2. 对外 API 面

```ts
createModel(ref: ModelRef): Model

interface Model {
  info: ModelInfo
  stream: StreamFn
}

type StreamFn = (req: ModelRequest, signal: AbortSignal) => AsyncIterable<ModelEvent>
```

**`stream` 是 agent-core 唯一消费的东西。** agent-core 不 import 本包，
由 composition root（agent-server 或集成测试）注入 `StreamFn`。

---

## 3. 核心类型

```ts
interface ModelRef {
  provider: "openai" | "anthropic" | "gateway"
  protocol?: "openai" | "anthropic" // wire format；缺省由 provider 推断
  api?: "responses" | "chat-completions" // OpenAI wire API；缺省为 responses
  model: string                    // direct 时为上游名；gateway 时为 public_name
  apiKey?: string                  // gateway 模式下为 gateway 的 token
  baseUrl?: string
  contextWindow?: number
  maxOutput?: number
  thinkingLevels?: ThinkingLevel[]
  parallelToolCalls?: boolean
  reasoningFormat?: "none" | "openai" | "anthropic" | "deepseek" | "minimax"
  inputModalities?: ("text" | "image")[]
}

interface ModelInfo {
  id: string
  contextWindow: number
  maxOutput: number
  thinkingLevels: ThinkingLevel[]  // 空数组 = 不支持
  parallelToolCalls: boolean
  inputModalities: ("text" | "image")[]
}

type ThinkingLevel = "off" | "low" | "medium" | "high" | "max"

interface ModelRequest {
  system: string
  messages: Message[]              // agent-core 的 Message，见 agent-core.md §3.1
  tools: ToolSchema[]
  thinking?: ThinkingLevel
  maxOutput?: number
}

interface ToolSchema { name: string; description: string; parameters: JSONSchema }
```

`ModelRequest` 只有 5 个字段。**没有** `temperature` / `topP` / `stopSequences` / `seed` ——
coding agent 不调这些，需要时再加。

---

## 4. 事件流

```ts
type ModelEvent =
  | { type: "block.start"; index: number; blockType: "text" | "thinking" | "tool_call" }
  | { type: "block.delta"; index: number; delta: string }         // tool_call 时是 JSON 片段
  | { type: "block.end";   index: number; block: Block }
  | { type: "usage";       usage: Usage }
  | { type: "finish";      stopReason: ModelStopReason; errorMessage?: string }

type ModelStopReason = "stop" | "tool_use" | "max_tokens" | "error" | "aborted"
```

**规则**

| 规则 | 说明 |
|---|---|
| `finish` 必发且只发一次 | 它是流的终止标记 |
| **绝不 throw** | 网络/模型失败编码为 `finish{stopReason:"error", errorMessage}` |
| `block.end` 带完整 block | 消费方不必自己拼 delta（虽然也可以） |
| `tool_call` 的 delta 是 JSON 文本片段 | 完整参数在 `block.end` 里已解析好 |
| `usage` 在 `finish` 之前发 | 便于 agent-core 立即更新预算 |

`index` 是块在本次响应中的序号，与 `Message.blocks` 的下标一致。

> 不 throw 是硬契约。见 `agent-core.md` §3.3 —— throw 会打断 loop 的事件序列，UI 卡在半截。

---

## 5. Provider 级重试

```ts
interface RetryConfig {
  max?: number          // 缺省 3
  baseMs?: number       // 缺省 1000，指数退避 + 全抖动
  maxMs?: number        // 缺省 30_000
}
```

| 情况 | 处理 |
|---|---|
| 429 带 `Retry-After` | 按响应头等待，**不叠加退避** |
| 429 无响应头 / 5xx / 连接重置 / 超时 | 指数退避 + 全抖动重试 |
| 4xx（除 429） | **不重试**，直接 `finish{error}` |
| 已产出内容后中断 | **不重试**，直接 `finish{error}`。重试会导致重复内容 |
| `signal` 已 abort | 立即 `finish{stopReason:"aborted"}` |

**"已产出内容后不重试"是关键**：流式响应吐了一半再重试，
消费方会拿到两段拼不起来的内容。这种情况交给上层决定（重发整个 turn，或直接失败）。

---

## 6. Provider 实现

```text
packages/model-adapters/src/
├── index.ts          # createModel
├── types.ts          # §3 §4
├── retry.ts          # §5，provider 无关
├── openai.ts              # OpenAI-compatible Chat Completions
├── responses.ts           # OpenAI Responses API
└── anthropic.ts
```

每个 provider 文件负责：把 `ModelRequest` 转成该 provider 的线上协议、把响应流转成 `ModelEvent`。
**没有 `BaseProvider` / `ProviderFactory` / `ProviderRegistry`** —— `createModel` 里一个 switch 足够。

**为什么不用 `@ai-sdk/*`**（早期文案写过，已纠正）：当前只有 OpenAI Chat Completions 与
Anthropic Messages 两种稳定协议，各由一个文件内的 `fetch` + SSE 解析覆盖 §4 事件语义；
为它们引入 `ai` + provider 包依赖树是死重量（CLAUDE.md Rule 17）。
重试与退避在 provider 之外统一做（`retry.ts`，§5），与协议解析正交。

### 差异点清单

真正需要抹平的只有这几处：

| 差异 | 处理 |
|---|---|
| thinking 的开关方式 | Claude Anthropic 使用 `budget_tokens`；DeepSeek Anthropic 使用 `thinking.type` + `output_config.effort`；MiniMax Anthropic 使用 `adaptive/disabled`；OpenAI wire 使用各自兼容字段 |
| thinking 内容是否可回传 | Anthropic 带 `signature`；DeepSeek 回传 `reasoning_content`；MiniMax 回传完整 `reasoning_details`。内部 thinking block 保存所需元数据，UI Projection 必须剥离 |
| wire protocol | `protocol` 决定 OpenAI Chat Completions 或 Anthropic Messages；gateway 不再固定走 OpenAI |
| provider reasoning | `reasoningFormat` 明确选择 OpenAI / Anthropic / DeepSeek / MiniMax 语义；不能仅凭 `baseUrl` 猜测 |
| 输入模态 | MiniMax M3 可接收图片，MiniMax M2.x 与 DeepSeek Anthropic 不支持；由 `inputModalities` 声明 |
| 并行 tool call | 部分模型不支持。`parallelToolCalls: false` 时，agent-core 的 tool batch 退化为串行 |
| tool_result 的位置 | 有的放 user message，有的独立 role。由 provider 文件转换 |
| 图片编码 | base64 vs URL |
| 错误码 | 统一映射到 §5 的四类 |

---

## 7. Gateway provider（Phase 2）

`model-gateway` 上线后，对 agent-core 表现为**本包内的一个 provider 实现**：

```text
Phase 1   agent-core → model-adapters ──HTTP/SSE──► provider-compatible endpoint
Phase 2   agent-core → model-adapters ──gateway──► model-gateway → provider

❌ agent-core → model-adapters → <gateway client 包> → model-gateway
```

`direct` 与 `gateway` 由 `ModelRef.provider` 配置切换，**调用层级不增加**。
**不允许**为 gateway 单独新增客户端包 —— 那会退化成 pass-through（`repo-layout.md` §4.11）。

gateway 模式的 `ModelRef` 只包含 gateway URL、gateway API key、公开模型名和模型能力。
MiniMax、DeepSeek、OpenAI 中转商的上游 URL、真实模型名和 provider 凭据归 gateway 所有，
不得下发到应用进程。`reasoningFormat` 是模型级能力而不是 provider 类型：OpenAI 中转商可以
同时代理多种 reasoning 协议。

`provider` 表示连接目标，`protocol` 表示线上协议，两者不是一回事。以下两项都直接复用
`anthropic.ts`，不会新增 MiniMax/DeepSeek adapter：

```ts
{ provider: "gateway", protocol: "anthropic", reasoningFormat: "minimax", model: "nova-minimax", ... }
{ provider: "gateway", protocol: "anthropic", reasoningFormat: "deepseek", model: "nova-deepseek", ... }
```

由于 gateway 暴露 OpenAI / Anthropic 兼容接口，不建 `gateway.ts`。`protocol = "openai"`
直接复用对应的 OpenAI adapter，`protocol = "anthropic"` 直接复用 `anthropic.ts`；两者都只替换
`baseUrl`、公开模型名和 gateway token。

OpenAI-compatible 的 Chat Completions gateway 使用 `api: "chat-completions"`：

```ts
createModel({
  provider: "gateway",
  protocol: "openai",
  api: "chat-completions",
  baseUrl: "https://api.orcarouter.ai/v1",
  apiKey: process.env.ORCAROUTER_API_KEY,
  model: "qwen/qwen3.8-27b-free",
})
```

---

## 8. Phase 范围

| Phase | 内容 |
|---|---|
| 1 | OpenAI + Anthropic direct、统一事件流、provider 级重试、能力声明 |
| 2 | gateway provider（若需要独立文件） |
| 按需 | DeepSeek / MiniMax —— 按 `protocol` 共用 `openai.ts` 或 `anthropic.ts`，由 `reasoningFormat` 处理 reasoning 差异，不新增文件 |
