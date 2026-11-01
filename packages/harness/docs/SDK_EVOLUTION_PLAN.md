# SDK 可恢复执行与扩展能力规划

日期：2026-09-16。状态：P0、P1、P2 与 P4 已在 DSH SDK 主线实现；P3、P5、P6 保持待 DSH 能力补齐后排期。

## 1. 目标与设计边界

把当前 SDK 接到 DeepSeek Harness（以下简称 DSH）已有的 Agent、Session、LLM、Tool、Workflow 能力上，并只补 SDK 协议没有暴露的部分。当前仓库的 `contracts → kernel → plugins` 只保留为兼容层；凡是 DSH 已经拥有稳定实现的能力，不再在本仓库重写一套。

首要验收场景分两层：第一层验证 DSH 已支持的 crash recovery——Agent 生成工具调用，进程在模型/工具边界崩溃，重新打开 Session 后由 DSH 修复中断 turn，并继续下一轮且不重复已持久结果；第二层作为待补能力，验证需要跨重启的人类确认。DSH 当前 approval 要求 live open turn，不能把第二层写成现成能力。

本提案把原计划中的“仅进程内、无跨重启恢复”改为复用 DSH 的持久 Session。DSH 的 JSONL 持久化已经提供跨进程打开、写所有权、追加、flush 和崩溃尾部修复；数据库生产插件、分布式调度和具体业务服务仍单独交付。只有接入符合 DSH `SessionPersistence` 语义且通过重启测试的后端，才声明支持 durable 模式。

LocalFlow 暂定义为 SDK 的便利门面。DSH 已有 `@deepseek-ai/dsh-workflow`（`agent()`、`parallel()`、`pipeline()`、`phase()`、`log()` 和 worker-thread engine），但源码明确声明 workflow 没有 journaling/resume，因此只能直接复用其进程内执行；durable LocalFlow 需要补 DSH workflow 的持久化扩展，不能在 SDK 内偷偷复制一套 Flow 引擎。

## 1.1 DSH 源码核查结论（E:\Project\source\deepseek-harness）

| 需求                             | DSH 现有能力                                                                                                                                                                                                                                                                 | 结论与 SDK 计划                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent 可恢复状态机               | `packages/core/agent-loop` 提供 `ctx.agents.create()` / `ctx.agents.resume()`；恢复时通过 `SessionPersistence.open(id, 'write')` 读取日志，并追加 `interruptedTurnClosers`                                                                                                   | **直接复用** AgentLoop。它是“崩溃后关闭未完成 turn，再从日志继续下一轮”，不是 token 级续传或任意中间 phase checkpoint；SDK 只需暴露 resume 与状态。                                           |
| Durable Session/Checkpoint       | `packages/session/session-persistence` 定义 create/open/stat/list/export、SessionHandle append/read/flush；`session-persistence-jsonl` 提供后端；`session-checkpoint-policy` 在模型 dispatch、工具 body 前做 fail-closed flush                                               | **直接复用**。不要新增 `SessionStore`/CAS/JSONL；只做 SDK session id、恢复 API 和 durable flush 语义的映射。                                                                                  |
| 通用 Suspension/Resume           | `interaction/user-questions` 能在 live turn 中等待问答；`user-approval` 有 `approval/asked`/`approval/decided` 持久审计；Agent resume 可恢复 Session；但 approval 要求 open turn，workflow README 明确无 journaling/resume，user-question 没有独立 durable request/answer 流 | **部分复用**。审批/提问直接走 DSH 服务；通用外部等待、跨重启 suspension、workflow resume 仍是缺口，应先定义 SDK 层 capability，再决定是否贡献回 DSH。                                         |
| Message/Block/Tool/Decision 事件 | `core/session` 的 `SessionEventMap` 已有 turn/step、system/user/assistant message、assistant attempt、tool call/result、request header/context；`llm` 有 ContentBlock；approval 有 durable decision 事件；assistant stream 是进程内 live 事件                                | **大部分直接复用**。SDK 传递完整 `SessionEvent`；不另造 Message/Tool 事件。Block delta/decision 统一流和 user-question 审计仍需补协议或 DSH 扩展。                                            |
| Per-session Model Adapter        | `llm` 的 `LlmService` 按 provider 注册 adapter，`prepareCall()` 固定一次调用的 adapter/model/config；Session header 记录 provider/model/request header；SDK 当前 initialize 是进程级 provider/model                                                                          | **复用 DSH adapter**。SDK 增加 session 级 route 覆盖和恢复时保留 header；不实现新的 `ModelAdapter`。同一进程的不同 Session 可选不同 provider/model，但不共享可变的 per-session adapter 对象。 |
| provider adapter 扩展            | `packages/llm/llm` 是 Adapter 注册目录；`llm-deepseek` 和 `llm-pi-ai` 是现成适配器；架构文档要求新增 provider 注册 `ctx.llm`                                                                                                                                                 | **直接复用** `LlmAdapter` / provider registry。SDK 只增加 provider 配置、能力元数据和错误/事件映射。                                                                                          |
| Flow/LocalFlow                   | `@deepseek-ai/dsh-workflow` 支持动态脚本、agent、parallel、pipeline、取消、bounded child lifecycle；README 的 Known Limitations 明确 “No journaling or resume”                                                                                                               | **LocalFlow 直接复用 DSH workflow（进程内）**；durable Flow 不是现成功能，需 DSH workflow 扩展或明确降级为 ephemeral，不能在 SDK 自建 DAG。                                                   |
| Tool batch 并发/顺序/未知结果    | `agent-loop/tool-calls.ts` 已有 exclusive barrier、bounded parallel pool、模型顺序提交、取消时 skipped 合成结果；Session persistence 的 crash repair 将已记录 call 无 result 标为 `TOOL_OUTCOME_UNKNOWN`                                                                     | **直接复用** Tool scheduler 和 crash repair。SDK 补 batch policy/结果字段的 wire 投影；unknown 只通过 DSH 的恢复语义处理，禁止另写 `Promise.all` 调度器。                                     |

### DSH 源码证据索引

- Agent 恢复：`packages/core/agent/src/index.ts`、`packages/core/agent-loop/src/index.ts`、`packages/core/agent-loop/README.md`。
- Session 与 checkpoint：`packages/session/session-persistence/src/index.ts`、`src/handle.ts`、`packages/session/session-persistence-jsonl/`、`packages/session/session-checkpoint-policy/src/index.ts`。
- 事件与消息：`packages/core/session/src/types.ts` 的 `SessionEventMap`、`packages/llm/llm/src/types.ts` 的 `ContentBlock`/`StreamChunk`。
- 交互决策：`packages/interaction/user-approval/README.md`、`packages/interaction/user-questions/README.md`。
- Provider：`packages/llm/llm/src/index.ts`、`packages/llm/llm-deepseek/`、`packages/llm/llm-pi-ai/`。
- Workflow：`packages/workflow/workflow/README.md`、`packages/workflow/workflow-worker-thread/`。
- SDK 当前边界：`packages/sdk/protocol/src/types.ts`、`packages/sdk/client/src/api.ts`；已补 `session/open`、`session/prompt` 的 session route、`session/flush`、`session/events`，通知仍为 `session.event`、`session.status`、`subagent.*`。

## 2. 当前基础与实际缺口

| 能力               | 当前代码证据                                                                                                           | 本次补充                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 可恢复 Agent       | 本仓 `contracts/agent.ts` 有 resume，但 `BasicLoop` 明确拒绝；DSH AgentLoop 已实现 `resume()` 和 crash repair          | 删除自研 Agent 恢复状态机；改为 DSH adapter/SDK 映射，并补 DSH 没有暴露的 wire 状态 |
| Session/Checkpoint | 本仓是同步内存 Store；DSH 已有 SessionPersistence、JSONL 和 checkpoint policy                                          | 删除自研 durable Store；保留最小 compatibility facade，直接委托 DSH                 |
| Suspension/Resume  | 本仓 WaitRegistry 是自有等待实现；DSH 有 user-question、approval 和 Agent resume，但没有通用跨重启 suspension          | 复用 DSH 交互能力；只补通用外部等待和 SDK wire 需要的 capability                    |
| 完整事件           | 本仓 AgentEvent 过窄；DSH SessionEventMap 已覆盖主要持久事件，live stream 另有 agent/assistant-stream                  | 删除平行事件源；直接投影 DSH SessionEvent，补缺少的 user-question/live block 订阅   |
| 会话模型           | 本仓 AgentDefinition.model 仅选 route；DSH `request/header`/`request/context` 记录 provider/model 并固定 prepared call | SDK 增加 session 级 provider/model 覆盖，不做新 adapter binding 实现                |
| Provider 扩展      | 本仓 AI SDK 插件固定 openai-chat；DSH 有 LlmAdapter registry 和 DeepSeek/pi-ai 两套 provider                           | 删除本仓 provider 工厂设计；改为注册/转发 DSH provider                              |
| Flow/LocalFlow     | 本仓 FlowSpec/TaskEngine 自有 DAG；DSH workflow 已有进程内 parallel/pipeline，但无 journaling/resume                   | LocalFlow 直接包 DSH workflow；durable Flow 另做 DSH 扩展，不复制 DAG               |
| Tool batch         | 本仓 `Promise.allSettled` + Admission；DSH scheduler 已有有界并发、exclusive barrier、模型顺序提交和 crash unknown     | 删除本仓批次调度实现；SDK 只补 DSH scheduler 的策略和结果投影                       |

本仓现有 AgentTask 恢复测试使用自定义 executor，不能证明与 DSH AgentLoop 的行为一致。后续测试应以 DSH 的 session log、crash repair、checkpoint policy 和 tool scheduler 为基准；本仓只验证 SDK wire 映射、session 级配置以及恢复后的通知顺序。

## 3. 统一状态与身份

### 3.1 状态 owner

- DSH `Session`/`SessionPersistence`：消息历史、turn/step、工具调用与结果、request header/context 和事实事件的唯一 owner。
- DSH `AgentLoop`：从 Session log 派生下一次请求；本仓 SDK 不再维护另一份 Agent checkpoint 状态机。
- DSH interaction services：approval 的请求/结果持久审计；user-question 负责 live turn 等待。本仓只做 wire 订阅和请求映射。
- DSH workflow engine：进程内 workflow 的生命周期和并发 owner；因其当前没有 journaling/resume，SDK 不为它制造伪 durable 状态。
- SDK server/client：只拥有 JSON-RPC 连接、订阅和 session handle，不拥有模型、工具或持久化状态。

DSH 的身份层次以 `SessionId → turn → step → SessionSeq` 和工具 `callId` 为准；SDK 不另造 `runId/segmentId/attemptId`。跨进程恢复由 Session header、事件 seq 和 `request/header { reason: 'resume' }` 表示。若 SDK 需要活动区间 ID，只作为非 durable wire correlation id，不能替代 DSH 事件身份。

### 3.2 可恢复状态机

SDK 对外只投影 DSH Agent 的 `idle | running`，并以事件观察细粒度状态。DSH 内部状态按 `turn/start → step/start → request → assistant/tool → step/end → turn/end` 推进；恢复后的中断轮次由 `turn/end { reason: 'interrupted' }` 配平，然后下一次输入从持久日志继续。

```text
turn/start → step/start → request → assistant/tool → step/end → turn/end
                                      │
                                      └─ crash → interruptedTurnClosers → resume next turn
```

这不是本仓重新定义的 `ready/running/suspended/completed` 状态机。DSH 当前不提供任意 phase 的 durable suspend；只有 live interaction 等待和 Session resume。任何新状态必须先进入 DSH `SessionEventMap` 或现有 extension seam，不能仅在 SDK 内存里增加一个状态标签。

DSH checkpoint 的可用事实是：Session header、连续事件 log、Session format version、request header/context，以及 checkpoint policy 的 flush barrier。不要在本仓另定义包含函数、client、Signal、凭据的 checkpoint JSON；只有 DSH 明确扩展了该格式后，SDK 才能转发新的字段。

恢复规则：

1. 已提交的 DSH Session events 不重复追加；SDK 只重放从游标之后收到的事件。
2. 中断 turn 由 DSH `interruptedTurnClosers` 修复；不承诺 token 级续传。
3. 已有 `tool/result` 的调用不重复执行；有 `tool/call` 无结果的调用由 DSH crash repair 产生 `TOOL_OUTCOME_UNKNOWN` 语义，不能在 SDK 里盲目重试。
4. checkpoint policy 在模型 dispatch、顶层工具 body 前 fail-closed；SDK 不在这些边界前再加一层自有提交。
5. 恢复时继续使用 DSH 记录的 provider/model/request header；SDK 端不得以 initialize 的新默认值覆盖历史 route。

## 4. Durable Session / Checkpoint 契约

不要将本仓 `SessionStore` 演进成第二套持久化协议。DSH 的 `SessionPersistence` 已是 durable owner；本仓只定义一个薄的 SDK Session facade，把操作映射到 DSH 的 `create/open`、prompt append、event read、`flush`、resume 和 close。

建议 API 形状：

```ts
interface SdkSession {
  id: string;
  prompt(input: SdkPrompt): Promise<{ messageId: string }>;
  open(
    route?: SessionRoute,
  ): Promise<{ resumed: boolean; status: "idle" | "running" }>;
  events(after?: number): Promise<readonly SessionEvent[]>;
  flush(): Promise<void>;
}
```

以上是 SDK facade，不是新的持久化实现。当前 DSH wire 提供 `open`、`events`、`flush`；会话 close 仍随 SDK runtime shutdown 处理。具体类型直接引用 `@deepseek-ai/dsh-session` 和 `@deepseek-ai/dsh-session-persistence`；DSH handle 的 ownership、revision、format 与错误语义保持原样。

- 写所有权与并发恢复：直接使用 DSH `open(id, 'write')` 和 `SessionAlreadyOwnedError` / `SessionOwnershipLostError`。
- durability barrier：直接调用 DSH `SessionHandle.flush()`；`session-checkpoint-policy` 负责模型/工具前的自动 flush。
- 版本：直接使用 DSH `SESSION_FORMAT_VERSION` 与相邻 migration；SDK 不重新编号。
- 生命周期：映射 DSH create/open/stat/list/export/close；释放 SDK handle 不删除 DSH 历史。
- 物理一致性：依赖 DSH contiguous append、torn-tail handling 和 JSONL generation；不再实现 CAS、outbox、writer fencing 或 JSONL。
- 尚未由 DSH 提供的通用 suspension、事件 cursor 保留策略和跨 Store inbox，列为后续 DSH 扩展，不在本仓自建。

首版直接启用 DSH JSONL backend 做重启验收；若宿主安装自有 DSH `SessionPersistence` provider，SDK 不关心其物理存储。测试调用 DSH persistence conformance tests，而不是再维护一套 memory/disk Store conformance。

## 5. 通用 Suspension / Resume

这一项不能直接照搬本仓的 continuation 设计。先复用 DSH 的两个既有路径：`ctx.approval.request()` 用于一次性审批，`ctx.userQuestions.ask()` 用于 live turn 的用户回答，二者都由 DSH AgentLoop 和事件系统管理。`ctx.agents.resume()` 用于持久 Session 的进程重启恢复。

DSH 当前没有可供 SDK 直接调用的通用 `Suspension` 对象。若要支持 external/timer/跨重启等待，新增能力应进入 DSH 的 capability seam，并由 DSH SessionEventMap 记录，而不是在 SDK 中新增 `id/ownerRef/resumePoint/state` 私有协议。

第一阶段 SDK 的 ResumeRequest 只包含 `sessionId`、恢复模式和事件游标；它调用 DSH `ctx.agents.resume()`，不伪造 `suspensionId`。通用 Suspension API 等 DSH 贡献完成后再补 `eventId` 幂等恢复入口。

关键语义：

1. Approval 直接遵循 DSH 一次性授权和 fail-closed 语义；不要在 SDK 重复实现审批策略。
2. UserQuestion 当前要求 live Agent/open turn；跨重启问答需要 DSH 新的 durable interaction seam。
3. Agent resume 读取 DSH 持久 Session；中断 turn 按 DSH crash repair 关闭，不能保证任意代码 phase 的继续。
4. external/timer 等待必须先写 DSH durable event，再派发外部动作；在 DSH 没有该事件前，SDK 不宣称支持。
5. DSH 新增通用等待后，SDK 才实现同 eventId duplicate、不同 payload conflict、过期和已消费收据。

暂不在本仓维护 Agent/Tool/Task 三套 Suspension owner。SDK 的 AgentTask 只转发 DSH 支持的 prompt/resume；跨 Store inbox/outbox 等待 DSH capability seam 确定后再实现。

## 6. Message / Block / Tool / Decision 事件

保留 DSH `SessionEvent` 和 `ContentBlock` 作为唯一事实源。`assistant/message`、`tool/call`、`tool/result` 已带可关联的 turn/step/callId/seq；不要在本仓再定义 `AgentMessage.parts`、Block id 或平行消息存储。SDK 只做类型投影和 wire validation。

| 事件族   | DSH 现状与 SDK 动作                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Run/Step | DSH `turn/start`、`step/start`、`step/end`、`turn/end`；SDK 直接转发，不新增 run 状态事件                                              |
| Message  | DSH `system/message`、`user/message`、`assistant/message`、`assistant/attempt`、`tool/result`；SDK 订阅 `session.event`                |
| Block    | DSH LLM `ContentBlock` 在完整 message/result 中持久化；`agent/assistant-stream` 提供进程内 chunk。没有 durable block delta，SDK 不伪造 |
| Tool     | DSH `tool/call` / `tool/result`，以及 tools pipeline live events；SDK 传递原事件和 DSH presentation meta                               |
| Decision | DSH approval `approval/asked` / `approval/decided`；user-question 当前没有独立 durable audit stream，需 DSH 扩展                       |
| Usage    | DSH `assistant/message.usage` 随消息持久化；SDK 不另发 usage.updated                                                                   |

Decision 先沿用 DSH approval vocabulary；不要把模型内部 reasoning 当 Decision 事件。外部核验、模型切换和通用用户问答只有在 DSH 提供对应 SessionEventMap 后才加入 SDK。

SDK envelope 不替换 DSH envelope：以 DSH `SessionEvent` 的 `type/seq/time/data/ignorable` 和 Session format version 为准；JSON-RPC 外层只补 `sessionId`、通知方法和订阅游标。展示增量继续使用 DSH 的 live assistant stream，不冒充 durable seq。

- **事实事件**由 DSH Session append/flush 产生，SDK 按 DSH seq 重放并在通知层去重；不再定义第二个 eventId/seq。
- **展示增量**由 DSH `agent/assistant-stream` 提供，允许丢弃；重连读取 Session log 后再订阅 live notifications。
- DSH 的 complete assistant message/attempt 和 tool call/result 是恢复边界；SDK 不把每个 token 写入自己的 checkpoint。
- DSH tool scheduler 已保证模型顺序提交，SDK 保持事件顺序，不重新排序。
- Observer/JSON-RPC 断连不会回滚 DSH 已提交事实；游标过期行为沿 DSH persistence backend 的 read semantics。
- provider 扩展数据继续由 DSH adapter/schema 约束；SDK 不透传凭据或原始 provider body。

SDK 兼容期直接把 DSH `SessionEvent` 投影到现有 `session.event`；旧本仓 `assistant.delta/reset`、`tool.finished` 只作为派生通知，不能成为新的持久事实源。

## 7. Per-session Model Adapter 与 Provider 扩展

### 7.1 会话绑定

不引入本仓 `ModelBinding` 实现。DSH 的 `LlmCallConfig`、`request/header` 和 `request/context` 已保存 provider/model/config；`ctx.llm.prepareCall()` 会固定一次请求实际使用的 adapter。SDK 的 session 级配置只映射为 DSH Agent 的 provider/model options。

选择顺序：显式 SDK session route → initialize 默认 route → DSH deployment default。每次请求仍由 DSH `prepareCall()` 解析和固定；恢复时以日志中的历史 request header/context 为准，不能把新 initialize 默认值覆盖到旧调用。

会话 A 的 provider/model 覆盖不得改变会话 B。route 变更通过 DSH `agent/request` / request header 语义记录；SDK 不在请求中途切换 adapter。旧 provider 不可用时返回 DSH `NO_ADAPTER` 或对应 LLM 错误，不自造 MODEL_BINDING_UNAVAILABLE。

durable 模式只保存 provider/model/config 的可序列化标识；凭据由 DSH provider 在恢复时重新解析。adapter、transport、pool 生命周期由 DSH plugin 管理，SDK session close 不重复释放。

### 7.2 Provider adapter

不保留本仓 `ModelAdapter` 作为第二 Loop 边界。直接使用 DSH `LlmAdapter` / `LlmService`；Provider SDK 类型留在 DSH provider package，SDK 只看到 provider/model/config 和标准 `StreamChunk`/`SessionEvent`。

DSH adapter 已负责配置校验、client 生命周期、请求/响应映射、错误分类、usage 与能力声明。新增 provider 按 DSH cookbook 注册 `ctx.llm`，不在 SDK server/client 或本仓 kernel 增加 provider switch。

能力清单沿用 DSH `LlmModelInfo` / adapter metadata。SDK 只传递 DSH 已校验的 reasoning effort、maxTokens、ContentBlock 能力；未注册能力由 DSH 返回错误，不在 SDK 增加任意 provider 参数透传。

provider-specific extensions 复用 DSH `deepseek-llm-api-extensions` 和 adapter-owned fields；provider-executed tools、无法映射的 block 和模型能力继续由 DSH adapter 决定，SDK 不重复执行或静默丢弃。

验收直接使用 DSH `llm-deepseek` 与 `llm-pi-ai` 的既有 adapter tests；SDK 只需验证 session route 选择和 `SessionEvent` 投影，无需再写第二套 provider compatibility suite。

## 8. Flow / LocalFlow 兼容

不继续扩展本仓 `FlowSpec`/`TaskEngine` 作为第二 workflow engine。LocalFlow 先作为 DSH `@deepseek-ai/dsh-workflow` 的 SDK facade，调用既有 worker-thread engine；`agent()`、`parallel()`、`pipeline()`、`phase()`、`log()`、取消和 bounded child lifecycle 全部复用 DSH。

| 能力                              | LocalFlow（复用 DSH）                     | 可恢复 Flow                                        |
| --------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| 串行、并行、pipeline、phase、输出 | DSH workflow script                       | DSH 未提供 durable spec/node checkpoint            |
| 闭包/脚本节点                     | DSH worker 内执行，仅进程内               | durable 模式暂拒绝或要求 DSH 注册 handler/version  |
| Agent 节点                        | DSH workflow 的 `agent()`，复用 AgentLoop | Agent Session 可 durable，但 workflow 本身不可恢复 |
| 外部等待                          | 当前 workflow 没有通用 durable wait       | 等 DSH workflow journaling/resume 扩展             |
| 恢复                              | 仅重新运行新的 workflow                   | 需要 DSH 新 capability，SDK 不自建 DAG             |

SDK 先补 DSH workflow 的 start/result/cancel/dispose 和 workflow event 订阅映射，不补 FlowSnapshot/openFlow。只有 DSH workflow 提供 journaling/resume 后，才增加 durable flow handle；仅把 script 或 meta 存成 JSON 不构成恢复能力。

DSH workflow 当前的 child failure/null、cancel 和 disposal 语义保持不变。race/any-success、补偿、durable winner 选择不在 SDK 自行添加；需要时回到 DSH workflow capability 设计。

## 9. Tool batch 的确定语义

不新增本仓 `ToolBatchPlan` 或批次执行器。DSH `agent-loop/src/tool-calls.ts` 已是工具批次 owner：按 execution mode 分组，exclusive 调用形成 barrier，parallel 调用使用 bounded rolling pool，结果以模型顺序提交，并通过 Session `tool/call` / `tool/result` 持久化。SDK 只暴露 DSH 已有配置和事件。

### 执行与顺序

- DSH `parallel` 工具使用 `maxParallelToolCalls` 有界派发；exclusive 工具自动成为 barrier。SDK 不重写成 `Promise.all`。
- DSH 在模型顺序提交结果和 additional context；工具实际完成顺序只作为 live 观察顺序。
- 取消时 DSH 为未派发调用追加 `TOOL_ABORTED_BEFORE_DISPATCH` 合成结果；内部 scheduler failure 不伪造结果。
- 工具的 execution mode、策略、资源约束由 DSH tools registry 决定；SDK 只传配置，不凭 effects 自行推断因果。

### unknown 与重试

执行状态和 unknown 语义沿用 DSH Session persistence 的 crash repair。DSH 文档明确：有 durable `tool/call` 而没有 `tool/result` 时生成 `TOOL_OUTCOME_UNKNOWN`；它不是普通 failed，也不应由 SDK 自动重试。

1. DSH checkpoint policy 在 top-level tool body 前 flush；调用发生但结果未落盘时由 DSH crash repair 保守标为 unknown。
2. 已有 `tool/result` 由 DSH history 重放；未有 result 的行为按 DSH 工具/模型提示语义处理，SDK 不猜测“未执行”。
3. 外部副作用是否可重试由具体 DSH tool/provider 声明；SDK 不引入 reconcile/idempotencyKey 的平行账本。
4. 取消、超时和输出校验失败继续遵循 DSH tool result/error semantics；SDK 只保留原 SessionEvent。

保证 SDK 记录的幂等和可追溯性；外部副作用的恰好一次依赖下游幂等协议，不作无条件承诺。

## 10. 实施任务与验收门槛

| 阶段                      | 前置  | 改动范围                                                                                                                                                                             | 验收                                                                                                |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| P0 DSH 接入盘点           | 无    | 固定 DSH commit/package versions、profile、session backend、插件清单和 SDK 兼容层；移除本仓重复抽象                                                                                  | 逐项映射到 DSH 源码；确认 SDK 不直接启动第二套 Loop/Store/Tool/Flow                                 |
| P1 SDK Session/事件映射   | P0    | **已实现**：扩展 DSH `packages/sdk/protocol` 与 TypeScript/Python client/server：session open/resume、per-session route、event cursor、flush/status；直接调用 DSH SessionPersistence | JSON-RPC 可恢复 durable session；SessionEvent 按 seq 读取；重复 route 会被拒绝                      |
| P2 DSH 恢复垂直链路       | P1    | **已接入**：SDK server 通过 DSH AgentLoop `agents.resume()`，复用 checkpoint-policy、tool scheduler 与 crash repair；本仓只做 adapter/projection                                     | DSH 负责 `interruptedTurnClosers`、`TOOL_OUTCOME_UNKNOWN`、模型顺序结果；SDK 暴露 open/flush/events |
| P3 交互等待补口           | P2    | 把 approval/user-question 接入 SDK；若需 external/timer suspension，先在 DSH capability seam 立项                                                                                    | live approval/question 可完成；跨重启通用等待明确支持或明确拒绝，不出现私有伪恢复                   |
| P4 Provider/session route | P1    | **已实现**：TypeScript/Python SDK 支持 session route；新会话映射 DSH `AgentOptions`，恢复读取历史 `request/header` 并拒绝冲突路由；复用 DSH adapter registry                         | 两会话可选不同 route；恢复不覆盖历史 request header；错误由 DSH adapter 返回                        |
| P5 LocalFlow 门面         | P1    | SDK 暴露 DSH workflow start/result/cancel/dispose；不复制 FlowSpec/TaskEngine                                                                                                        | parallel/pipeline/agent/cancel 行为与 DSH workflow 一致；明确无 durable resume                      |
| P6 DSH 贡献与发布         | P2–P5 | 只有 DSH 缺口才改 DSH：durable interaction、workflow journaling、missing event vocabulary；同步 TS/Python SDK                                                                        | DSH conformance、SDK wire/client、snapshot/e2e 全部通过；文档标记支持等级                           |

已交付 P0–P2 与 P4：直接以 DSH JSONL + AgentLoop + checkpoint-policy + tool scheduler 闭合恢复链路，并把 provider route 接入 DSH adapter。P3 的通用 suspension、P5 的 durable Flow 只有在 DSH 本身增加能力后再排期；当前 SDK 对这两项保持显式能力缺口，不伪造跨重启语义。

粗估单工程师 12–22 人日：P0 1–2、P1 4–6、P2 3–5、P3 2–4、P4 1–2、P5 1–2、P6 0–3。该估算依赖 DSH 作为唯一 Loop/Session/Tool/Provider owner；若 P3/P5 需要在 DSH 内新增 durable capability，应另估 10–20 人日并纳入 DSH 测试与双 SDK 更新。

### 必测故障矩阵

- 复用并纳入 DSH `session-checkpoint-policy/tests`、`session-persistence` crash-recovery tests、`agent-loop` recovery/tool scheduler tests；SDK 只补 wire-level restart tests。
- SDK 子进程重启后 `session/open`/`resume`，检查 DSH `interruptedTurnClosers`、Session seq 连续、旧消息和已完成 tool result 不重复。
- 三工具批次覆盖 DSH parallel/exclusive barrier、模型顺序提交、取消 skipped 结果和 `TOOL_OUTCOME_UNKNOWN`；不新增一套 scheduler 断言。
- approval/user-question：验证 DSH live turn 要求、approval asked/decided 事件和无 answerer fail-closed；通用 external/timer 等待必须标为 unsupported，直到 DSH seam 完成。
- 两个 SDK session 使用不同 DSH provider/model route；恢复时 request/header/context 与历史一致；错误码来自 DSH adapter。
- DSH workflow：验证 parallel/pipeline/agent/cancel/dispose facade；显式测试 process restart 后 workflow 不支持 resume，而不是把它误报为 durable。
- `session.event` cursor、JSON-RPC 断连、重复通知和 status idle/running 的兼容映射；不维护第二个 event sequence。

实现阶段执行 DSH 相关 focused tests、SDK typecheck/build/test、session snapshot/e2e；只有修改 DSH 源码时才执行 DSH 对应 package gates。本次已修改 DSH SDK protocol/server/client 与 Python SDK，并更新双语包文档。已通过 DSH host typecheck、SDK client package typecheck、SDK protocol/client/server focused tests（93 tests）；Python SDK `tests/test_client.py` 通过（29 tests）。完整 client project typecheck 仍受仓库既有生成 remote 类型缺失影响，与本次 SDK 改动无关。P3 通用跨重启 suspension 与 P5 durable Flow 没有伪造实现，继续等待 DSH capability seam。
