# 使用 DeepSeek Harness 替代 Nova agent-core 的可行性分析

> 状态：已完成（基于本地参考版本 `0.1.1-rc.2`）  
> 分析对象：Nova 当前实现与 `deepseek-harness-master` 本地参考项目  
> 目标：判断 DeepSeek Harness 能否直接替代、部分复用或作为架构参考，并给出可执行迁移方案。

## 1. 执行摘要

### 当前结论

**不建议把 DeepSeek Harness 当作 `@nova/agent-core` 的直接依赖并一次性替换。建议先做一个受控 PoC，目标是验证“以 DeepSeek Harness 核心插件重建 Nova Agent Runtime”，而不是做 API 转接。**

原因是 DeepSeek Harness 并不存在与 `agent-core` 一一对应的独立内核包。它把职责拆到一组强协作的 Cordis 插件中：`dsh-agent`、`dsh-agent-loop`、`dsh-session`、`dsh-tools`、`dsh-llm`、`dsh-system-prompt`、`dsh-compaction-*`、`dsh-user-approval`、`dsh-subagent-*` 等。只引入 `dsh-agent-loop` 不可行；采用它实际上等于在 Nova 内部引入一套新的 Agent 运行时和扩展模型。

从能力成熟度看，DeepSeek Harness 对 Nova 最有价值的部分是：

- 单一、可回放的会话事件日志和 model surface 投影；
- 持久 inbox、明确的 turn / step 生命周期和崩溃尾部修复；
- 工具的 pre / guard / execute / post / result 流水线；
- 有界并行工具调度与 exclusive barrier；
- agent 级作用域和插件生命周期；
- “模型可见即已记录”的运行时约束。

但它与 Nova 目前的关键产品接口并不等价：

- DSH 的核心 `followup()` / `steer()` 只入队，不返回某次 run 的结构化结果；`whenIdle()` 只观察整个 agent 空闲。其 SDK 的 `RunResult` 也是客户端拥有的一段“入队到 idle”的观察区间，不是内核 run 实体。
- DSH 使用一条线性 append-only 事件日志加 surface replacement；Nova 使用 Entry 树 + Record 运行事实双流。两者都能分离模型历史与运行事实，但持久模型、fork 成本和查询方式不同。
- DSH 的 fork 复制一个稳定事件前缀到新 Session；Nova 的 Entry 以 `parentId` 共享历史，从任意 Entry 节点长出分支。
- DSH 恢复时先把中断的工具、step、turn 合成为合法的 `interrupted` 尾部；恢复后的 agent 不会自动凭空续做旧任务，必须依赖持久 inbox、目标驱动或新的输入。Nova 当前 `resume()` 会写入未知 tool 结果后主动 prompt 模型继续。
- DSH 工具通过 Cordis capability/service 和闭包装配执行世界；Nova 工具显式接收窄 `ToolContext`。如果失去这一边界，Runner 的唯一 owner 约束会被破坏。
- DSH 的审批/提问等待本身会阻塞工具调用并留下审计事实，但默认崩溃修复收敛的是未知工具结果，不会像 Nova `resume()` 那样重新发出未解决 Decision；若要保持现有行为，Nova 需要拥有可恢复 Decision 状态机。
- DSH 当前版本是 `0.1.1-rc.2`、README 明示开发者预览且无兼容承诺；SDK 协议也无版本协商。

因此，最终更可能成立的选择是：

1. **短期：不替换**，吸收其事件日志、inbox、工具流水线等设计，重构 Nova 当前内核；或
2. **中期：内核重建 PoC**，用 DSH 核心插件组装一个无 UI、无本机执行器的 Nova 专用 runtime，Nova 继续拥有 Server、Runner、协议和 UI；
3. 只有 PoC 证明数据迁移、Runner 桥接、审批、逐 run 结果和多模型支持都能保持后，再考虑完整切换。

## 2. Nova 当前基线

### 2.1 agent-core 的职责

根据 `docs/agent-core.md` 与当前源码，`packages/agent-core` 是一个通过依赖注入独立运行的决策内核，当前集中拥有：

- 模型 turn loop 与流式事件收敛；
- tool batch 调度、并发限制、审批和终止语义；
- 上下文预算、压缩与截断；
- Entry / Record 双流会话、fork 与 resume；
- steering / follow-up / next-run 三类消息队列；
- TODO 状态；
- sub-agent 派生与结果提交协议；
- 对外唯一观测面 `AgentEvent`。

其边界刻意排除了 Provider、Runner、传输、身份和 UI。外部世界主要由 `stream`、`ToolContext`、`SessionStorage`、`Decide` 注入。

### 2.2 替换必须保持的 Nova 约束

后续以这些条件作为“可替代”的判定门槛：

1. 不启动 `agent-server` 仍可独立跑通 Agent 闭环。
2. Runner 仍是执行环境的唯一 owner，Agent 层不能偷渡本机文件或 Shell IO。
3. Message（模型语义）与运行事件/事实分离。
4. 协议层和 UI 层继续由 Nova 自己拥有，不能泄漏参考项目的前端内部类型。
5. tool 结果仍需区分喂模型的裁剪内容与给 UI 的完整详情。
6. fork、resume、审批挂起、abort、steering 等现有产品行为不能仅靠最终文本模拟。
7. `Agent`、`TaskFlow`、`Runner`、`Tool` 的职责不重新混合。

## 3. DeepSeek Harness 架构盘点

### 3.1 它是什么

DeepSeek Harness 是基于 vendored Cordis 的插件化 Agent Runtime。“一切皆插件”不仅指工具：Agent 接口、默认 loop、会话日志、LLM、提示词、审批、压缩和持久化本身都是插件。运行时是一棵由 profile、bundle 和 patch 组合出的插件树。

核心运行链如下：

```text
Cordis Context
  ├─ dsh-llm                 模型消息、流、Provider/Adapter seam
  ├─ dsh-session             内存事件日志、surface、fork
  ├─ dsh-session-persistence JSONL/SQLite 等持久化 seam
  ├─ dsh-system-prompt       提示词段与工具 schema 组装
  ├─ dsh-tools               工具注册与策略流水线
  ├─ dsh-agent               Agent 接口、注册表、inbox、实时事件
  └─ dsh-agent-loop          唯一默认具体循环
       └─ 其他能力插件通过事件或 Service 接入
```

官方仓库提供的 `dsh-agent-spine-demo` 是最接近“无 UI、无执行器的 Agent 主干”的组合参考，但它依然挂载约二十个核心和配套插件。其 README 也明确指出：主干集合大部分固定在代码中；若替换 loop 或删除其他主干成员，需要重新组合一个 bundle。

### 3.2 Turn / Step 模型

DSH 定义：

- 一个 **step** = 一次模型请求 + 该请求产生的工具执行；
- 一个 **turn** = 从领取一条 `next-turn` 输入开始，到没有更多 `next-step` 工作为止，可包含多个 step；
- `followup` 进入 `next-turn` inbox；
- `steer` 进入 `next-step` inbox 并唤醒；
- `inject` 进入 `next-step` inbox 但不唤醒。

每次 step 的主路径为：

```text
claim inbox
→ agent/pre-step
→ session: step/start + user/message
→ system-prompt/assemble
→ agent/request → llm/stream
→ assistant/chunk* + assistant/message
→ tool/call* + 工具流水线 + tool/result*
→ step/end
```

实时控制走 `agent/*`；可回放事实走 `session/event`。这比 Nova 当前一组公开 `AgentEvent` 加内部 Entry/Record 更彻底地事件化。

### 3.3 会话与持久化模型

DSH 的单一真源是一条线性的 `SessionEvent[]`：

- 模型 surface 事件：`user/message`、`assistant/message`、`tool/result`；
- 运行事实：`turn/*`、`step/*`、`tool/call`、`assistant/chunk`、`request/header`；
- 插件状态：`todo/write`、`plan/mode`、`compaction/*`、审批、目标、subagent 等通过 declaration merging 扩展；
- `deriveMessages()` 从 surface 投影模型历史；其他事件不进入模型上下文；
- 压缩不删除旧日志，而是通过 surface replacement 让新摘要遮蔽旧的模型 surface；append-origin 事件仍可还原用户已经看过的 transcript。

持久化服务不另造一套事件类型，只负责把同一日志写入 JSONL / SQLite。写入采用后台批处理，明确的 flush/checkpoint 负责持久性屏障。

崩溃尾部修复值得借鉴：冷加载发现开放 turn 时，不截断已落盘日志，而是依次为未结算工具写入合成 error result、补 `step/end`、补 `turn/end(interrupted)`，得到 Provider 可接受的历史。它区分“工具尚未记录开始，可按需重试”和“已开始但结果未知，副作用工具不得盲目重试”。

### 3.4 工具模型

DSH 的 `ToolDefinition` 不直接返回用于 UI 的任意详情，而是分三层：

1. 工具体返回由 `output.schema` 验证的 lossless JSON canonical value；
2. `output.render(args, value)` 纯函数生成模型可见 `ContentBlock[]`；
3. `presentationMeta(args, value)` 与 `presentCall` / `presentResult` 生成可回放的 UI 展示意图。

完整流水线是：

```text
pre-execute → monotonic guards → approval → around execute
→ tool body → post-execute → finalizeContent → frozen result notification
```

连续 `parallel` 调用进入有界滚动池，`exclusive` 调用形成顺序屏障。默认是 fail-closed：只有工具明确返回 `isConcurrencySafe() === true` 才允许重叠；这与 Nova 当前“默认 parallel，特殊工具 sequential”方向相反。

### 3.5 Agent API 与一次运行

DSH 核心 Agent 公开的是长期存活的 handle：`followup`、`steer`、`inject`、`cancel`、`whenIdle`、`session`、`status`、`inbox`。消息入队返回/携带 `MessageId`，但这个 id 不标识最终 assistant 输出或 turn 结果。

高层 SDK 通过“先订阅 → prompt 入队 → 等待自己的 inbox receipt → 继续收集到 agent idle”合成 `RunResult { sessionId, finalResponse, events, notifications }`。这要求调用方确实独占这段活动区间；并发发送时，它不是天然的逐请求结果关联机制。

### 3.6 成熟度与引入面

- 本地参考版本：`0.1.1-rc.2`。
- 许可证：核心包均为 MIT。
- Node 要求：仓库要求 Node `^22.19 || >=24`，需要和 Nova 的部署基线核对。
- 各核心包把 Cordis 和多个 DSH 包声明为 peer dependency；不能合理地只复制 `agent-loop`。
- README 明示 developer preview、未来会有破坏性变更；磁盘格式版本当前也没有面向外部消费者的升级承诺。

## 4. 逐项能力映射

| Nova 能力 | DeepSeek Harness 对应 | 等价程度 | 初步判断 |
|---|---|---:|---|
| `createAgent(config)` 依赖注入 | Cordis 插件树 + `ctx.agents.create()` | 部分 | 能力更强，但装配模型完全不同 |
| `prompt(): Promise<RunResult>` | `followup()` + `whenIdle()`；SDK 合成 RunResult | 较弱 | 必须由 Nova runtime façade 补逐次活动区间和结果关联 |
| steering / follow-up | `steer` / `followup` + 持久 inbox | 强 | DSH 的 inbox 更完整、可回放 |
| next-run | `next-turn` inbox | 强 | 语义接近，但消息队列模型需统一 |
| inject（不唤醒上下文） | `inject` | DSH 更强 | Nova 当前公开面没有直接等价物 |
| tool 并发与顺序 | bounded rolling pool + exclusive barrier | 强 | DSH 更保守，需重新标注现有工具并发安全性 |
| ToolContext / Runner | capability provider + tool closure | 不等价 | 必须写 Nova Remote Runner provider，并禁止 local provider 混入生产组装 |
| `content` / `details` | rendered content / canonical value / presentation meta | 部分且 DSH 更严格 | 需要迁移每个工具返回模型和 UI 数据的方式 |
| 审批与反问统一 Decision | approval seam + user questions / ask-user 插件 | 部分 | DSH 是两个 capability，且默认不重发崩溃时未解决的 Decision；Nova 需补持久协调层 |
| Entry / Record 双流 | 单一 SessionEvent log + surface 投影 | 目标等价、数据不等价 | 需要新表/事件存储和完整历史迁移策略 |
| fork | 复制稳定事件前缀到子 Session | 部分 | 语义可用，但存储放大，且不能在开放 turn 中普通 fork |
| resume | 冷日志修复 + resume 组装 | 部分 | 安全性强；不会自动重启旧任务，需要明确产品策略 |
| compact | compaction 插件 + surface replace | 强 | DSH 能保留 transcript 与替换模型 surface，设计优于删除/改写历史 |
| TODO | `todo/write` 日志事件 + tool | 强 | 映射直接 |
| sub-agent | 多 provider seam、in-process/out-of-process、continuation | 强 | 能力更广，但 Nova 的结构化 `submit_result` 需保留或重建 |
| `AgentEvent` UI 投影 | `session/event` + `agent/*` + tool presentation | 强但不同 | agent-server projection 基本需要重写 |
| `RunResult.output` | 无核心直接等价；subagent 有自己的 settlement | 弱 | 顶层结构化完成协议必须由 Nova 插件实现 |
| Chat / Project 两模式 | 不同 bundle / capability 组合 | 可实现 | 应在装配期构建两套明确 preset，而不是运行时混装 |

## 5. 可选集成方案

### 方案 A：不替换，选择性吸收设计

保留 `@nova/agent-core` API 和现有存储，只在 Nova 内部依次改进：

- 把三条临时队列收敛成持久 inbox；
- 将 Entry / Record 进一步统一为可投影的 append-only session event，或至少建立统一 seq；
- 引入明确的 turn / step 边界和 interrupted tail repair；
- 将 tool 执行拆成 pre / guard / execute / post / finalize；
- 工具并发改成显式 opt-in safe + exclusive barrier；
- 压缩改用 surface replacement，不丢 transcript。

优点：风险最低，保持 Nova API、Runner 和数据库；可逐项交付。缺点：继续自行维护内核，无法直接获得 DSH 插件生态。

### 方案 B：在进程内组装 Nova 专用 DSH Core（推荐 PoC）

新建一个 Nova runtime 包（临时 PoC，不立刻替换生产 `agent-core`），只装配必要插件：

```text
dsh-llm + dsh-session + dsh-session-persistence
+ dsh-system-prompt + dsh-tools + dsh-agent + dsh-agent-loop
+ NovaModelAdapterProvider
+ NovaRunnerFs/SubprocessProvider
+ NovaDecisionProjection
+ NovaRunResult/submit_result plugin
+ NovaSessionPersistence(PostgreSQL)
+ NovaProtocolProjection
```

明确不引入 DSH 的本机 fs/shell provider、Web UI、认证、Server、默认 profile。这样可保持 Nova 的 Runner、Server 和前端边界。

优点：真正验证 DSH 核心，而不是做失真的外围调用；将来能使用插件生态。缺点：需要接受 Cordis 作为内部运行时，适配工作大，现有 `agent-core` 的 API 和存储无法原样保留。

### 方案 C：通过 DSH JSON-RPC SDK/子进程替换

Nova Server 启动 `dsh-jsonrpc-agent`，通过 SDK 的 `run()` 和通知消费结果。

不推荐作为最终架构，原因：

- SDK 当前没有取消和会话关闭方法，放弃轮次要关闭整个 runtime 进程；
- 审批的 server→client request 尚未落地；
- 协议无版本协商；
- 又引入一层进程管理，与 Nova 已有 Rust Runner / runner-sdk 的职责重叠；
- 自定义工具需要跨 JSON-RPC 回调或直接部署到 DSH 进程，Runner 边界反而更复杂；
- SDK `RunResult` 是活动区间观察，不等价于 Nova 的结构化 run。

它适合快速黑盒体验或基准对比，不适合承接 Nova 生产控制面。

### 方案 D：Fork / Vendor DeepSeek Harness

技术上可行且 MIT 允许，但长期成本最高：需要同步上游大量互相依赖的包、Cordis vendor 版本、磁盘格式和测试门禁。只有当上游 API 无法提供 Nova 必需扩展点，且团队决定把 DSH 作为长期内核基线时才考虑。

## 6. 推荐方案与迁移路线

### 6.1 推荐决策

采用“两条腿”策略：

- **生产主线选方案 A**：暂不移除 `agent-core`，先修正当前最有价值的设计问题；
- **独立 PoC 选方案 B**：验证 DSH Core 是否能成为下一代 Nova Agent Runtime。

不要先写一个长期存在的 `DshAgent implements NovaAgent` 大型兼容层。两边对 run、session、tool、decision 的语义并不相同，长期 facade 会成为同时维护两套状态机的 pass-through 层，违反本项目“控制流、状态、并发都有唯一 owner”的原则。

### 6.2 PoC 目标架构

```text
agent-server
  ├─ Nova Runtime Registry（仍拥有在线 conversation 生命周期）
  ├─ Nova Protocol Projection（仍产出 UiEvent / REST Decision）
  └─ Nova DSH Composition（新的内部实现）
       ├─ Cordis + DSH agent/session/tools/loop
       ├─ Nova LLM Adapter Bridge
       ├─ Nova Runner Capability Provider
       ├─ Nova PostgreSQL Session Persistence
       ├─ Nova Decision / Question Responders
       ├─ Nova submit_result / run correlation plugin
       └─ Nova prompt、tool、TODO、compaction、subagent 插件

Rust Runner ← gRPC / runner-sdk ← Nova Runner Provider
```

所有本地 fs、shell、subprocess provider 必须从生产 composition 中排除。Project agent 的文件和进程能力只能由绑定到该 conversation 的 Remote Runner provider 提供；Chat agent 则根本不装配这些 capability 和工具。

### 6.3 阶段 0：冻结可比较契约

在写 PoC 前，把现有行为整理成黑盒契约测试，至少覆盖：

- Chat / Project 装配校验；
- 流式 text / thinking / tool call 投影；
- 同 batch 并发、顺序、模型顺序回填；
- abort 后所有 tool call 都有结果；
- steering / follow-up / next-run 的排空时点；
- approval / question 挂起、取消、恢复；
- TODO 保活、压缩、fork、resume；
- `submit_result` 结构化成功与失败；
- subagent 深度、并发、父级 token 记账。

这批测试不应断言当前内部 Entry/Record 形状，而应断言外部行为、持久化可恢复性和 UI 事件。

### 6.4 阶段 1：最小纵向 PoC

只实现一条完整路径：

1. 在同进程创建一个 DSH root context 和每 agent scope；
2. 用 Nova `model-adapters` 实现一个 DSH `LlmAdapter` bridge；
3. 只接 `read_file` 与 `bash` 两个代表性工具：一个只读、一个有副作用；
4. 工具实际执行仍通过 `runner-sdk.toToolContext()`；
5. 把 DSH `session/event` 和 `agent/*` 投影成现有 `UiEvent`；
6. 支持一次用户输入、工具执行、流式 UI、审批、取消、最终空闲；
7. 使用内存 Session，不碰现有 PG schema。

此阶段可临时写工具适配器，但只作为证据代码。生产迁移时建议把仅 9 个现有 Nova 工具原生改写为 DSH `ToolDefinition`：显式 canonical value、模型 renderer 和 presentation meta。这样才能完整保留命令非零退出、typed error 和 UI details，而不是在两种工具结果模型之间做脆弱转换。

### 6.5 阶段 2：补齐 Nova 必需插件

#### Run correlation 与结构化完成

不要把 `whenIdle()` 直接伪装成 `prompt()` 的结果。实现 Nova 自己的“owned activity”协调器：

- 先注册观察窗口，再写入有稳定 `MessageId` 的 input；
- 等待该消息被 `agent/inbox/claimed`；
- 记录对应 turn 的开始和结束；
- 同一 conversation 仍由 Runtime Registry 串行拥有正常用户 run；
- `submit_result` 工具以持久事件记录结构化结果，并 `concludesTurn()`；
- 对外产生 Nova `runId`、stop reason、usage 和可选 output。

如果允许多个调用方并发 enqueue，就不能用第一次 `idle` 作为逐消息完成边界；必须由持久 turn/message 关联得出结果。

#### Decision

Nova 必须自己扩展 DSH：

- 审批请求补齐 `args`、risk 和 Nova decision id；
- 支持 `allow_always` 的会话策略存储，或明确删掉该产品能力；
- 为 pending Decision 定义独立持久状态与恢复重发，不能只依赖开放工具调用；
- 保持审批与问题在 Server 层统一成同一 REST/SSE Decision 协议；
- DSH 内部仍可分别消费 approval 和 userQuestions seam。

DSH 默认审批缺少参数、只有 `allowed-once`，不能直接替代 Nova 当前 Decision。

#### Model bridge

短期保留 `packages/model-adapters`，把 `ModelRequest/ModelEvent` 翻译到 DSH `GenerateOptions/StreamChunk`。需要专门验证：

- OpenAI Responses 与 Anthropic 两种协议；
- DeepSeek / MiniMax reasoning replay 元数据；
- tool call arguments 的流式组装；
- usage、cache read/write、max tokens；
- context overflow 的规范错误码；
- 图片输入与输出。

长期再决定是保留 bridge，还是让 model catalog 直接驱动 DSH adapter。PoC 阶段不要同时替换 Agent loop 和全部 Provider adapter，否则失败无法定位。

#### Runner bridge

优先建立 Nova 自己的 Remote Runner capability，而不是引入 DSH local fs/shell：

- 每个 Project agent scope 注入绑定后的 Runner Session；
- `fs`、subprocess/shell 都投影到同一个远端执行世界；
- abort signal 贯穿 DSH tool execution → provider → runner-sdk；
- path 越界、超时、Runner unavailable 保持 typed code；
- Chat composition 不安装这些 provider。

### 6.6 阶段 3：持久化与历史策略

建议新增 DSH 专用会话事件表，而不是继续把事件拆进 `entries` 与 `records`：

```text
agent_session_events
  conversation_id
  session_id
  seq                 # session 内连续
  type
  payload             # 完整 SessionEvent JSON
  created_at
  PRIMARY KEY(session_id, seq)
```

另有 session header / branch metadata 表记录 parent session、seed length、cwd、runtime engine 等。`messages` 表仍可保留为 UI 查询投影，不作为 Agent 真源。

**不要尝试把所有旧 Entry + Record 无损改写成 DSH 日志。** 两条旧流各有独立 seq，缺少它们之间的全局顺序；部分 DSH 所需 turn / step / request header 事实也不存在。可靠策略有两个：

1. 老 conversation 固定走 `runtimeEngine = nova-v1`，新 conversation 走 `dsh-v1`；或
2. 老 conversation 只读展示，用户“继续”时创建一个 dsh-v1 分支，把旧模型 surface 导入为显式 legacy snapshot，随后只在新引擎写入。

推荐第 1 种作为上线策略，第 2 种作为后续显式迁移功能。不要让一次近似转换伪装成可精确 resume 的原始日志。

### 6.7 阶段 4：影子验证与切换

- 先用固定 replay model 对两套 runtime 做确定性轨迹对比；
- 再用少量真实模型做行为与 token/cost 对比，不要求文本相同，只比较终态和关键工具轨迹；
- 新 conversation 按 feature flag 选择 runtime；
- 同一个 conversation 创建后固定 engine，禁止中途切换；
- 保留 Nova v1 的只读和恢复能力，直到旧活跃会话自然清零；
- 达到决策门后再删除旧 `agent-core`，不要长期双写同一会话。

### 6.8 工作量级判断

这不是“小型依赖替换”。仅作量级参考：

- Nova `agent-core/src` 当前约 23 个 TypeScript 文件、3.3k 行、63 个测试用例；
- DSH 的 agent/session/tools/loop/llm/system-prompt 核心约 50 个源码文件、14.6k 行；
- 再加 persistence/compaction/interaction/subagent 相邻能力约 42 个源码文件、9.3k 行。

这些数字不表示都要改，但说明团队要理解和承诺维护的是一套完整 runtime，而不是一个 3k 行 loop 的替代实现。

## 7. 风险、验证清单与决策门

### 7.1 主要风险

| 风险 | 严重度 | 说明与控制 |
|---|---:|---|
| 上游预发布破坏性变更 | 高 | 锁死精确版本；升级单独 PR；保存兼容轨迹测试；不直接跟随 main |
| Cordis 成为新的基础设施 | 高 | 限定在 Agent Runtime 内部；Nova 外部包不直接依赖 Cordis Context |
| 两套 owner / 状态机并存 | 高 | PoC 可以并行，单 conversation 只能有一个 runtime owner；禁止双写 |
| 旧历史无法精确迁移 | 高 | engine 固定；旧会话保留 v1；只提供显式 legacy snapshot 分支 |
| Runner 边界被本地 provider 绕过 | 高 | 生产 bundle allowlist；测试断言无 local fs/shell/subprocess；远端 capability 唯一装配 |
| 审批能力退化 | 高 | args、risk、allow-always 作为上线阻断项，不接受静默降级 |
| per-run 结果关联不可靠 | 高 | 不以 idle 猜测；持久 input/turn/run 关联；并发入队压力测试 |
| 工具错误与 UI details 丢失 | 中高 | 生产工具原生迁移，canonical value/render/presentation 分离 |
| fork 存储放大 | 中 | 评估 seed 前缀复制；必要时 PG 层做共享 chunk/parent 存储，但不改变 DSH 逻辑语义 |
| DSH session 格式无兼容承诺 | 中高 | Nova 自己拥有 schema version 与迁移器；原始事件 JSON 留存；升级前跑历史 corpus |
| Node/TS 工具链差异 | 中 | Node 已兼容（Nova `>=22.19`）；消费构建产物，避免把 DSH TS 6 编译约束扩散到 Nova TS 5.9 |
| 性能与日志体积 | 中 | chunk 也持久化；测首 token、事件写放大、PG 批处理、长会话恢复时间 |

### 7.2 PoC 验收清单

以下全部通过，才进入生产迁移设计：

- [ ] 不启动 agent-server，DSH Nova composition 可独立完成一次 headless Agent 闭环。
- [ ] Chat 模式不存在任何 Runner、本机 fs 或 shell 能力。
- [ ] Project 模式所有 IO 都能在 Rust Runner 侧观测到，取消可收敛。
- [ ] OpenAI-compatible 与 Anthropic 模型各跑通 text、reasoning、tool、usage。
- [ ] 工具并行不超过配置；写/执行工具形成 exclusive barrier；结果保持模型顺序。
- [ ] 非零命令、typed fs error、抛异常、拒绝和取消均产生正确模型结果及 UI details。
- [ ] 审批请求展示工具参数，支持 deny / allow / allow-always，并能断线恢复。
- [ ] ask-user 能挂起、恢复、取消，subagent 不越权向用户提问。
- [ ] steering、follow-up、next-turn/inject 的时序符合现有 API。
- [ ] 每个被接受的用户输入有稳定 run 关联，不因同时入队而串结果。
- [ ] `submit_result` 生成结构化成功/失败 output，不能靠解析最终文本。
- [ ] crash 位于模型流、工具开始后、工具结束后、审批中、压缩中时均能安全恢复。
- [ ] compaction 后模型 surface 缩短，原 transcript 和 UI 历史仍可回放。
- [ ] fork 后父子分离，模型配置、工具集、TODO、权限和 subagent 深度正确继承。
- [ ] PG 持久化 seq 连续，flush 失败不会被误报为已完成。
- [ ] 现有 `UiEvent`、消息分页和 decision REST 无破坏性变化，或有明确的协议迁移方案。

### 7.3 Go / No-Go 决策门

满足以下条件才建议 Go：

1. DSH 允许在不 fork 上游核心的情况下补齐 Nova run、decision 和 Runner 契约；
2. 生产 composition 能静态证明不加载 local executor；
3. replay corpus 中没有无法接受的模型历史、reasoning 或 tool 结果损失；
4. PG 日志写放大、恢复耗时和首 token 延迟在预算内；
5. 团队接受 Cordis/DSH 作为长期内部平台，并愿意承担精确版本升级与磁盘迁移；
6. 老 conversation 的 engine 固定/迁移产品策略已确认。

任一项不满足，则 No-Go：继续方案 A，并把 DSH 作为设计参考，而不是半接入、半自研。

### 7.4 方案决策矩阵

5 分最好。分数是基于当前本地版本与 Nova 现状的工程判断，PoC 后应重评。

| 方案 | 现有契约保持 | 获得 DSH 能力 | 实施风险 | 长期维护 | 可逆性 | 结论 |
|---|---:|---:|---:|---:|---:|---|
| A. 保留 Nova、吸收设计 | 5 | 2 | 5 | 3 | 5 | 生产主线 |
| B. 进程内 DSH Core | 3 | 5 | 2 | 3 | 3 | 推荐 PoC / 候选长期方案 |
| C. DSH SDK 子进程 | 2 | 4 | 3 | 2 | 4 | 仅黑盒评估 |
| D. Vendor / Fork DSH | 3 | 5 | 1 | 1 | 2 | 当前不建议 |

## 8. 参考文件

### Nova

- `docs/agent-core.md`：当前 Agent API、loop、session、Decision、TODO、subagent 契约。
- `docs/harness.md`：Nova 当前静态模块装配边界。
- `docs/repo-layout.md`：Agent / Harness / Tools / Runner / Server 的依赖方向。
- `docs/protocol.md`：浏览器协议、UI projection 和 Decision 结构。
- `packages/agent-core/src/agent.ts`：Agent handle、prompt、fork、resume、subagent 实现。
- `packages/agent-core/src/loop/loop.ts`：turn loop、流式收敛和 batch 执行。
- `packages/agent-core/src/loop/tool-batch.ts`：并发和顺序语义。
- `packages/agent-core/src/session/*`：Entry / Record / Storage。
- `packages/harness/src/index.ts`：模块、guard、observer 的静态组合。
- `packages/tools/src/*`：现有 9 个工具及 `ToolContext` 使用方式。
- `apps/agent-server/src/db/schema.ts`、`pg-session-storage.ts`：当前双流 PG 存储。
- `apps/agent-server/src/modules/runtime/create-agent-runtime.ts`：Chat / Project 与 Runner 装配。
- `apps/agent-server/src/modules/projection/project-agent-events.ts`：内部事件到 UI 的投影。

### DeepSeek Harness

- `deepseek-harness-master/README.zh.md`、`AGENTS.md`：定位、开发者预览状态和仓库边界。
- `docs/architecture.zh.md`：Cordis、插件树、事件域、turn/step 主流程。
- `docs/agent-lifecycle.zh.md`：完整生命周期时序。
- `docs/tool-execution-pipeline.zh.md`：工具策略、guard、审批和结果提交顺序。
- `docs/subsystems/core.zh.md`：Agent/AgentLoop 公共 API。
- `docs/subsystems/session.zh.md`：SessionEvent、surface、fork 和投影。
- `docs/subsystems/persistence.zh.md`：后台持久化、flush 和崩溃修复。
- `docs/subsystems/tools.zh.md`：ToolDefinition、canonical value、presentation、并发。
- `docs/subsystems/compaction.zh.md`：压缩事务与 surface replacement。
- `docs/subsystems/subagent.zh.md`：一次性与可继续 subagent。
- `packages/core/agent-loop/src/agent.ts`、`tool-calls.ts`：默认循环与有界并发调度。
- `packages/core/session/src/index.ts`、`surface.ts`、`repair.ts`：日志、surface 和 interrupted repair。
- `packages/core/tools/src/index.ts`：工具注册和完整执行流水线。
- `packages/examples/agent-spine-demo/README.zh.md`：最小无 UI/无执行器主干的实际插件闭包。
- `packages/sdk/client/src/api.ts`、`types.ts`：SDK 如何合成 owned activity `RunResult`。
- `packages/sdk/protocol/README.zh.md`：JSON-RPC 能力与当前限制。

## 9. 最终建议（一句话）

**DeepSeek Harness 有能力成为 Nova 下一代 Agent Runtime，但不能安全地“代替一个包”；当前最佳方案是保留生产 `agent-core`、并行完成一个严格限定的进程内 DSH Core PoC，以 Runner/Decision/run correlation/历史迁移四个阻断项决定是否正式换核。**
