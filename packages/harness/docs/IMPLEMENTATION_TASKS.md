# Agent Framework 分析与实施任务

日期：2026-09-13。范围：已完成架构理解、按依赖排序实施、核心实现和集成验证；以下清单记录实现证据与当前范围，不再是未开始的施工计划。

依据：[架构方案](./PLUGIN_AGENT_FRAMEWORK_PLAN.md)、[原始实施要求](./TODO.md)、[当前测试说明](./TESTING.md)，以及全部 `src`、测试、fixture、包配置和类型配置。本文件是执行清单，不替代架构方案。

## 1. 已确认的项目现状

### 1.1 环境、代码与入口

| 项目           | 检查结果                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 包             | `@nnova/harness@0.1.0`，单包、ESM、`private: true`                                                                                             |
| 环境           | 实测 Node `24.14.0`、pnpm `9.15.9`、Git `2.33.0.windows.2`；Node 声明下限 `22.18.0`                                                            |
| TypeScript     | `5.9.3`，`nodenext`、`strict`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`                                                              |
| 依赖           | 运行依赖包含 Zod `4.6.4`、AI SDK `7.0.99` 和 OpenAI provider `4.0.66`；MCP 通过稳定本地 bridge contract 接入                                   |
| 源码           | 53 个 TypeScript 文件；18 个 contract 文件、9 个 kernel 文件、22 个插件文件，以及根入口和 3 个 shared 文件                                     |
| 公共出口       | 根入口导出创建/定义助手、两个 capability key 和当前类型；插件使用 `./plugins/*` 子路径                                                         |
| 已有可执行逻辑 | `createAgentKernel`、插件装配与回滚、Agent Loop、严格工具运行时、Task/Flow Engine、AI SDK Adapter、压缩、Telemetry、MCP 和 Skills 均有生产实现 |
| 核心入口状态   | `createAgentKernel` 与核心插件 setup 已接通；失败路径返回结构化错误，不保留 `NOT_IMPLEMENTED` 生产错误                                         |
| 预留目录       | `model-ai-sdk`、`compaction`、`telemetry`、`skills`、`mcp` 仅有 `.gitkeep`；examples 只有说明                                                  |
| 测试           | 8 个 TypeScript 测试文件、21 条核心/场景测试；包含真实文件、Git、Node 子进程和受控模型 transport                                               |
| 仓库约定       | 项目及已检查的父目录没有适用的 `AGENTS.md`；当前目录不是 Git 仓库                                                                              |

实现使用已锁定依赖和现有受控 fixture；未读取 `.env` 凭据，也未执行真实供应商网络请求。`dist` 为构建产物，不纳入源码提交。

### 1.2 实测基线

| 检查                           | 结果                                                    | 能证明什么                                                      |
| ------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm typecheck`               | 通过                                                    | 全部生产实现和测试在严格 TypeScript 配置下通过类型检查          |
| `pnpm build`                   | 通过                                                    | 当前 `src` 可以生成 ESM 与声明文件                              |
| `pnpm format:check`            | 通过                                                    | 当前脚本覆盖的文件符合 Prettier 格式                            |
| `pnpm test`                    | 通过：21 项通过，0 项失败，0 项跳过                     | 核心契约、运行时、Adapter、扩展插件和三条 Coding 场景均实际执行 |
| TypeScript AST 导入/再导出检查 | 53 个源文件，未发现静态循环                             | 依赖边界脚本验证 contracts/kernel/shared 与插件层没有反向依赖   |
| 第三方引用检查                 | AI SDK/provider 仅位于 `model-ai-sdk`；MCP 仅位于 `mcp` | 适配器依赖未侵入 contracts、kernel 或其他插件                   |
| lint / 自动依赖门禁            | `pnpm lint` 与 `pnpm check:boundaries` 通过             | 代码规范和主要模块边界均有自动检查                              |

`pnpm test` 通过 `scripts/test.mjs` 自动发现并串行执行全部 `tests/**/*.test.ts`；格式门禁覆盖源码、测试、examples、脚本、配置和交付文档。

## 2. 模块职责、依赖与状态归属

### 2.1 模块责任表

| 层/模块                  | 负责                                                       | 不负责                                     | 当前缺口                                                        |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| `contracts`              | 跨边界类型、版本、错误、Schema 与 capability 契约          | 具体调度、协议请求、业务实现               | 已覆盖 Agent、Task/Flow、等待、事件、工具、模型和 Artifact 契约 |
| `kernel`                 | 插件图、注册表、作用域、会话句柄、互斥、准入、取消和释放   | 模型步骤、工具策略、Task DAG、领域分支     | 已实现，领域逻辑仍保持在插件与宿主 client                       |
| `session-memory`         | 消息、run、工具执行记录、摘要投影、continuation 的原子提交 | Task 调度状态、业务对象事实                | 已实现 session 作用域 Store 和 revision 提交                    |
| `context` / `compaction` | 有序输入投影、贡献、预算、完整轮次摘要                     | 修改身份/授权、直接覆盖原始历史            | 已实现上下文预算、手动/自动压缩和原子摘要投影                   |
| `tools`                  | 工具目录、严格校验、策略、执行意图、资源键、结果和安全重试 | 自动推进模型、替代业务授权服务             | 已实现统一执行流水线和未知副作用标记                            |
| `basic-loop`             | 唯一模型/工具循环、停止与挂起、run 推进                    | 队列排序、Flow 调度、SDK 协议              | 已实现单步流消费、协议对账、工具配对和取消收敛                  |
| `model-ai-sdk`           | 路由快照、能力检查、单步请求、流/消息/错误/usage 映射      | 执行工具、内部多步 Loop、Task 重试         | 已实现 AI SDK/OpenAI Chat Adapter 和配置版本快照                |
| `task-store-memory`      | Task/Flow 快照、尝试、等待登记、事件、去重与引用保留       | 自行启动工作或复制会话历史                 | 已实现有界内存 Store 和引用保留                                 |
| `queue-memory`           | Task ID 的 FIFO/优先级/延迟排序及队列索引容量              | 持有完整 Task 事实、执行 handler、决定重试 | 已实现容量、优先级、aging、延迟和取消索引                       |
| `task-engine`            | 验证接受、状态转换、调度、Flow、重试、子任务、等待、取消   | 另写 Agent Loop、解析模型协议              | 已实现 Scheduler、Flow、重试、等待/信号和子任务边界             |
| `agent-task`             | Task 到已存在 Agent 的适配、准入凭证传递、状态映射         | 创建平行会话/历史、重复申请运行槽          | 已实现直接/排队共用 Agent 运行和 suspended/resume               |
| `telemetry`              | 有界、只读、失败隔离的 observer                            | 授权、Prompt 和状态决策                    | 已实现有界 journal、回放和 observer 隔离                        |
| `skills` / `mcp`         | Markdown 上下文资源、外部工具桥接与连接生命周期            | 自动授予工具权限、绕过 tool-runtime        | 已实现显式 Skills 贡献和动态 Schema/MCP tool bridge             |
| 场景组合                 | Prompt、工具、handler、Flow、宿主 client 适配              | 把 Coding/GPU/订单/检索逻辑写进核心        | Coding 场景已验证；其他业务场景保留为宿主组合                   |

Task Engine 是状态转换与调度的 owner；Task Store 是 Task 数据的存储 owner。两者不各自维护一份可变 Task 真相。Session Store 同理，Loop 通过提交契约写入，不旁路修改内部集合。

### 2.2 必须维持的依赖方向

下列箭头表示导入/消费依赖，不是执行顺序：

```text
kernel               → contracts
session/context/tools→ contracts
basic-loop           → agent/model/tool/context/session contracts
queue-memory         → queue contracts
task-store-memory    → task/flow/store contracts
task-engine          → task/queue/flow contracts + 内核提供的准入/作用域契约
agent-task           → task contracts + 受限 Agent 执行契约
model-ai-sdk         → model/message contracts + 锁定版本的 AI SDK/provider
skills/mcp/scenarios → 对应公共扩展契约 + 宿主 clients
composition          → kernel + 显式插件子路径
```

禁止插件导入 `kernel` 私有实现来取得会话表或资源计数；由内核实现所需公共契约并显式提供。基础 contract 不反向依赖插件。插件安装图与业务 Flow 图分别实现，不抽成一个万能图运行时。

### 2.3 核心数据流

**直接对话：** 宿主创建 Agent → 校验输入、关闭状态和模型 → 原子取得会话互斥及活动额度 → 固定身份/工具/模型/预算快照 → 创建 run 并接受用户消息 → context 构建输入 → Adapter 完成一个模型步骤 → 原子提交 assistant 消息 → tool-runtime 校验、授权并执行完整调用 → 按原调用顺序提交配对结果 → Loop 继续或形成终态 → 真实工作收敛后释放资源。

`tool.call` 与 `message.completed` 可能描述同一调用。现有 ScriptedModel 就会这样输出；必须按步骤中的调用 ID 对账，只执行一次。文本 delta 只用于展示，最终回答来自完成消息，不能再次拼接造成重复。

**排队/Flow：** 宿主 submit → handler/schema/图/容量验证 → Task Store 原子接受 → 已满足依赖的 ID 进入 Queue → Scheduler 选择资源可用项并原子预留 → handler 执行 → Task Store 提交结果 → 推进依赖、绑定输出、唤醒调度。Agent handler 使用同一个 Agent executor 与准入凭证；普通 handler 不必触发模型。

**等待/恢复：** handler 先预注册 wait → 发起外部操作 → 返回可序列化 waiting → 保存状态并释放可释放的活动槽 → 宿主 signal 验证范围/Schema/有效期/去重 → 新活动段调用 resume → 只继续未决动作。提前信号仅缓存在已登记的有界等待槽；取消后不复活任务。

### 2.4 生命周期与关键不变量

| 对象         | 生命周期与释放规则                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| kernel       | 校验/编译插件图 → setup → 冻结 → 接受工作 → 关闭准入 → 取消或有界 drain → 子作用域收敛 → 逆序清理             |
| session      | `(namespace, sessionId)` 唯一活动句柄；持有身份、定义、历史；重复创建拒绝；释放后重建是全新历史               |
| run 活动段   | 一次 send/compact/resume 的 AbortController、快照、预算和步骤状态；挂起后释放活动段，保留可序列化逻辑运行位置 |
| 等待中的 run | 保留同会话逻辑位置，直接 send 返回 BUSY，合法 resume 优先于排队的新消息                                       |
| TaskScope    | kernel 所属任务执行/等待/子任务资源；复用 scope 取消与清理，不新增插件作用域种类                              |
| 实际执行资源 | 模型流、工具、子进程或外部 Job 真实结束后才释放对应配额；发出 AbortSignal 不等于已经停止                      |
| dispose      | 多次调用复用关闭 Promise；所有 cleanup 都尝试执行；错误安全聚合；不合作执行保持占用并使执行单元不可复用       |

- 接受 run 前的错误抛带 code 的异常；接受后的运行失败返回结构化 `RunResult`。
- `cancel()` 表示取消请求；需要等待原操作或 Handle 结果确认实际完成。
- run、Task、模型请求、工具资源、并发键各有清楚计数对象；直接和排队调用共用准入，不双重扣减。
- Task 总 deadline 包含排队、退避和等待；摘要、重试和子任务共用预算；未知 usage 保持 `null`。
- 状态提交后再发事实事件；observer 错误不得撤销提交或改变授权。
- 运行状态与等待数据可序列化；凭据、client、函数、AbortSignal 不进入 Store、事件或 manifest 摘要。
- 所有持有状态的集合都需要上限/保留规则；下游仍依赖的数据不得提前回收。

## 3. 契约缺口与需先处理的冲突

以下区分真正的设计冲突与需要明确边界的契约；处理方向已落实到当前实现和对应测试。

| 编号 | 证据/问题                                                                                                      | 采用的处理方向                                                                                                                                                    | 对应任务      |
| ---- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| D01  | 方案 §3.2/§3.3 指定每 session 一个 Store；`session-memory/index.ts` 却声明 `scope: kernel`                     | 采用 session 作用域的独立 Store；无需为了保留未实现桩增加根 Store 工厂层                                                                                          | T01、T07      |
| D02  | 插件契约只有字符串依赖、`config?: unknown`；缺配置校验、optional、排序、版本化声明、贡献读取和完整 key         | 在现有插件协议内补齐 typed capability/contribution、配置验证和明确可见性；保留 `definePlugin` 使用方式                                                            | T01、T04      |
| D03  | Task Engine 消费 handlers；现有 handler 插件又依赖 `task.engine`                                               | 单例依赖决定 setup 顺序；贡献在各自作用域装配完成时冻结，在对外接受工作前形成 handler 索引；不人为添加 engine→handler 插件的反向必需依赖                          | T04、T13      |
| D04  | kernel 作用域 `agent-task` 不能捕获 session executor；现有 PluginContext 没有会话解析或准入桥接                | 内核提供长生命周期、受限的 Agent 执行入口，执行时验证 session 引用及准入凭证；不暴露可变会话表，不调用会再次抢槽的公开 send                                       | T01、T06、T14 |
| D05  | Agent 接口缺 identity、结构化 message、usage、resume、updateModel、inspect；当前 RunResult 只有 completed      | 按设计补齐判别联合、快照及失败语义；保留已有 send/Task 行为，不维护第二套 RunResult                                                                               | T02、T06、T21 |
| D06  | `model.router` 目前直接承载最小 ModelAdapter；没有路由/能力/usage/error 元数据                                 | 明确 router 与单步 adapter 的责任，现有脚本模型通过同一公共适配边界接入；不能在核心识别 ScriptedModel                                                             | T02、T16      |
| D07  | ToolDefinition 只支持 Zod，defineTool 内部已 parse；未来 runtime 还需在授权前校验                              | 保留静态 Zod 类型推导，固定一次输入校验→策略→执行→一次输出校验的责任，动态 JSON Schema 接入同一执行流水线；不把 Zod 的公开 Schema 用法本身误判为 SDK 内部类型泄漏 | T02、T09、T24 |
| D08  | Task/Handle/Flow 缺 schema、snapshot/events、资源、失败策略、wait/resume、子任务等；execute 目前返回 JsonValue | 以基础完成式 handler 为已有调用边界，显式版本化扩展 outcome 协议；不以任意业务 JSON 的 `kind` 字段猜测等待指令。必要的 fixture 类型迁移保持场景断言不变           | T03、T13、T20 |
| D09  | 现有 agent Task 用例通过 `input.namespace` 引用会话，但 TaskEngine 没有可信 namespace 上下文约定               | 提交边界固定宿主范围和 session 引用校验；模型生成的图/参数不能修改该范围、identity 或可用 handler。保留宿主提交现有 namespace/sessionId 引用的用法                | T03、T14、T30 |
| D10  | Flow inputBindings 在上游完成前无法得出最终 input；方案又要求提交时 Schema 验证                                | 提交时验证静态输入、绑定合法性及可判定的 Schema；派发前解析依赖输出并验证完整输入。不存在路径/危险属性/类型错误明确失败，不用 eval                                | T03、T15      |
| D11  | 方案 §4.3 要求不合作函数不提前释放，§10.3 要求关闭收敛；无限等待本身无法保证                                   | 取消宽限、不可复用状态和宿主可见错误需要明确；实际工作仍被跟踪且资源保留到真正结束。受控进程可终止，同进程函数不能伪报停止                                        | T06、T13、T31 |
| D12  | 方案 §15 末尾和 TESTING.md 保留“当前只写三条 Coding 测试”的初始化要求                                          | 当前用户已授权完整核心验证；后续按行为组补集成/契约测试，不将历史范围限制当作停止实现的条件                                                                       | T01、T31      |
| D13  | 方案目录把模型适配标 P1，阶段表把完善模型/上下文列 P2                                                          | 按实际依赖执行：先 scripted model 打通唯一 Loop，再接真实 AI SDK；最终不遗漏 Adapter                                                                              | T10、T16      |
| D14  | 场景代码原则上属于业务包，但此仓库没有实际场景业务包；fixture 明确不是生产沙箱                                 | 本包提供公共扩展能力；代表场景放在 examples/集成测试，以宿主 client 注入证明组合；受控 Coding 执行边界真实验证，不复制 fixture 为生产沙箱                         | T26–T30       |

另外需要在契约任务中明确：可选 provider 的可见性与冲突、before/after 未知目标的错误规则、同会话 FIFO 与全局优先级的优先关系、事件保留窗过期的读取结果、drain 超时结果、外部 Job 配额归还依据。每项都应有确定的行为，不用静默 fallback。

## 4. 当前测试覆盖情况

| 现有场景      | 预期约束                                                                                      | 当前实际验证进度                                    |
| ------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 修复与追问    | 列目录/读取/先观察失败/修改/复测/diff；6 次工具执行记录；事件 ID 一致；多轮记忆；保留用户修改 | 已通过真实文件、Git、Node 测试和多轮 Agent 集成测试 |
| 双工作区 Flow | 可取消读取屏障证明并发；两分支完成后 review；从 TaskResult.output 绑定 text；工作区互不污染   | 已通过真实临时工作区、DAG 绑定和并发屏障测试        |
| 取消后继续    | 排队修复；取消真正测试进程；进程关闭后 Task 才取消完成；保留补丁；闭合工具消息后同会话继续    | 已通过真实子进程取消、补丁保留和后续验证测试        |

ScriptedModel 只替换模型网络响应；工作区、文件、Git diff、Node 子进程及框架入口是真实的。后续继续保留这个边界。

后续仍可扩展：工具确认的专用 continuation contract、动态 fan-out 的批量 API，以及依赖具体业务 client 的 3D/RAG/客服场景；当前工具策略、`any-success`/`race`、子任务等待和核心 Flow 语义已由下方任务清单和集成测试验证。

## 5. 实施顺序与逐项 TODO

任务编号按前置依赖拓扑排序。阶段标签使用本文任务划分；原方案 P0–P5 是产品实施里程碑，不等于用户的 Phase 1–5 工作流程。

T01–T26 已完成并有对应契约/集成测试证据；T27–T30 是依赖具体业务 client 的宿主组合场景，不属于框架内置后端；T31–T32 的门禁与架构审查已完成。每项变更仍应先检查类型、依赖方向、状态 owner 和行为测试，不用测试专用运行时掩盖生产问题。

### T01–T03：Contract 与验证基础

- [x] **T01：固定插件/内核协作契约与质量门禁**
  - **目标：** 先使插件装配、贡献冻结、作用域和受限内核能力可明确表达。
  - **涉及模块：** `contracts/plugin.ts`、`contracts/capabilities.ts`、必要内核能力契约、package/检查配置。
  - **前置依赖：** 本文 Phase 1 分析。
  - **实现内容：** 配置 Schema、typed 单例/贡献键、协议版本、optional/before/after、声明与解析约束；固定 Agent 执行/准入/作用域桥接和脱敏清单契约；落实 D01–D04。沿用 node:test、tsx、tsc、Prettier，增加完整测试发现、lint 与导入边界检查；开发依赖仅按检查需要添加。
  - **验证方式：** 插件定义类型正反例；既有 fixture 仍可编译或仅作明确 API 类型迁移；验证全量测试入口会包含后续测试；没有基础层反向依赖。

- [x] **T02：固定 Agent、消息、模型、工具、上下文和 Session 契约**
  - **目标：** 明确唯一 Loop 所依赖的数据与失败边界。
  - **涉及模块：** `contracts/agent.ts`、`message.ts`、`model.ts`、`tool.ts`、`event.ts`、`errors.ts`，新增 `session.ts`、`context.ts`、`artifact.ts`。
  - **前置依赖：** T01。
  - **实现内容：** AgentDefinition/可信身份与 namespace、text/message 互斥输入、completed/suspended RunResult、usage 未知值、typed 安全错误；模型 route/capabilities/单步事件；文本/附件/来源/受限 metadata；工具结果/unknown 副作用/幂等与 Schema 边界；Session revision 批提交、context contribution/compactor、事件 envelope 与展示重置。只定义实际跨模块使用的契约。
  - **验证方式：** 非法输入组合不能通过类型约束；状态和 continuation 可序列化；外部 SDK 类型不出现在公共声明中；静态工具仍能从 Schema 推导参数；现有 Coding 行为不变。

- [x] **T03：固定 Task、Queue、Flow、等待与共享预算契约**
  - **目标：** 为调度、异步等待、子任务建立明确边界，避免实现后反复改核心接口。
  - **涉及模块：** `contracts/task.ts`、`flow.ts`，新增 `queue.ts`、`continuation.ts`，任务 Store/预算/事件相关契约。
  - **前置依赖：** T01、T02。
  - **实现内容：** TaskSpec/快照/Handle/事件/drain、handler 输入输出校验与安全重试声明、版本化 outcome/resume；可信提交范围；Queue 候选/延迟/容量接口；Flow 绑定/失败/汇合规则；wait 预注册与信号回执；父子关系、节点/深度/成本上限和资源凭证。Flow 高级语法随 T22/T23 的代表用例细化，不预建通用工作流 DSL。
  - **验证方式：** 状态转换表覆盖全部非终态取消/超时；示例可以表达 A/B→C、单槽父子等待和提前信号；不把任意 JsonValue 隐式解释成控制指令。

### T04–T06：Core

- [x] **T04：实现插件图、能力注册和安装冻结**
  - **目标：** 配置不合法或依赖关系错误时，在接受业务前确定失败。
  - **涉及模块：** `kernel/plugin.ts`、`graph.ts`、`registry.ts`、装配入口。
  - **前置依赖：** T01。
  - **实现内容：** preset 展开、ID/API/config 检查、单例和工具/handler 重名检查、生命周期依赖限制、稳定拓扑排序和完整循环路径；只允许声明过的 resolve/provide/contribute；检测声明未兑现；作用域就绪前冻结贡献集合与注册表；脱敏 inspect 数据和 manifest hash。
  - **验证方式：** 集中的 kernel contract 测试覆盖缺依赖、重复 provider、版本不兼容、越域引用、before/after 环、无关插件顺序稳定、贡献注册顺序及禁止迟到注册。

- [x] **T05：实现作用域、setup 回滚和逆序释放**
  - **目标：** 成功与失败路径都具有确定的资源 owner。
  - **涉及模块：** `kernel/scope.ts`、`registry.ts`、kernel 装配生命周期。
  - **前置依赖：** T04。
  - **实现内容：** kernel/session/run 作用域、子 scope 跟踪、AbortSignal、cleanup 登记；失败插件已登记资源与前序插件一并逆序回滚；所有 cleanup 尝试执行；幂等 dispose 复用 Promise，安全聚合错误。TaskScope 复用这些机制。
  - **验证方式：** setup 取得资源后抛错、多个 cleanup 失败、并发 dispose、子 scope 失败与正常关闭；核对清理顺序、次数、订阅与连接引用。

- [x] **T06：实现内核句柄、共享准入和操作生命周期**
  - **目标：** 直接调用与后续 Task 调度共享不可绕过的会话和资源规则。
  - **涉及模块：** `kernel/kernel.ts`、`operation.ts`、`admission.ts`，公共 Agent 桥接。
  - **前置依赖：** T02、T03、T05。
  - **实现内容：** createAgent/重复会话/关闭校验；会话逻辑位置与实际活动槽分离；资源原子预留、无阻塞试取、已获取凭证启动；send/compact/resume 的统一信号和 timeout 归属；缺 Task 能力明确失败，缺 compactor 返回带原因 skipped；updateModel 委派路由能力。先完成可协作取消，明确不合作执行的隔离和报告契约。
  - **验证方式：** BUSY/CAPACITY/CLOSED/DUPLICATE_SESSION、不同 namespace 同 ID 隔离、并发创建/dispose、直接调用不能绕过配额、取消不提前释放真实资源。用最小 executor 边界验证内核，不在 fixture 复制 Loop。

### T07–T10：基础 Agent Runtime

- [x] **T07：实现内存 Session Store 和提交一致性**
  - **目标：** 会话事实和投影有单一存储 owner。
  - **涉及模块：** `plugins/session-memory`。
  - **前置依赖：** T02、T05、T06。
  - **实现内容：** 修正为 session 作用域；消息/run/执行意图与结果/摘要/continuation；`commit(batch, expectedRevision)` 同步原子提交；只读快照、提交后事件、数量/大小限制和清理。原始历史与摘要投影分别保存。
  - **验证方式：** revision 冲突不留下半提交；输入对象后续变更不污染 Store；会话隔离；成对调用与结果的提交不变量；关闭释放本会话数据。

- [x] **T08：实现上下文构建和有序贡献**
  - **目标：** 由受控投影生成唯一模型输入。
  - **涉及模块：** `plugins/context`。
  - **前置依赖：** T02、T07。
  - **实现内容：** 系统/宿主策略→场景 Prompt→摘要→完整近期轮次→当前输入与外部片段；贡献稳定排序和 provenance；保护身份、授权和未决配对；使用模型快照预留输出、工具 Schema 与附件开销；超限明确报告。
  - **验证方式：** 多轮历史和当前输入同时出现；贡献不能改原始 Store；不完整配对不能进入普通下一步输入；注入文本不升级为系统策略；预算不足明确失败。

- [x] **T09：实现统一工具运行时**
  - **目标：** 静态工具拥有完整、可追踪且不可旁路的执行流水线。
  - **涉及模块：** `plugins/tools`，Session 执行记录和共享资源契约。
  - **前置依赖：** T02、T06、T07。
  - **实现内容：** 唯一目录/快照、模型可见过滤、严格输入校验、allow-list/拒绝优先策略；executionId 与宿主幂等键先提交；有界读并发/写串行/跨任务资源键；timeout 与协作取消；输出校验/脱敏/ArtifactRef；安全工具重试和 unknown 副作用分类；结果按原始调用序配对。确认等待的执行接续在 T21 完成。
  - **验证方式：** 未知/禁用工具和非法参数不执行；无隐式 coercion/default/未知字段放行；同 ID 不重复执行；多读乱序完成仍稳定提交；写冲突不重叠；写后输出校验失败不被当作未执行而重试；取消与输出上限。

- [x] **T10：实现唯一 Agent Loop，打通直接 Coding 流程**
  - **目标：** 通过真实工具完成一轮、追问、失败和取消后的继续。
  - **涉及模块：** `plugins/basic-loop`，现有 scripted model 边界。
  - **前置依赖：** T06–T09。
  - **实现内容：** 固定 run 快照、预算/停止检查；单次模型流消费；完整 assistant 步骤提交后才执行工具；调用事件和完成消息对账；流异常/截断/步数耗尽明确失败；最终文本来自已提交回答；取消后闭合已接受工具调用并等待执行停止。共享 run 状态转换入口。
  - **验证方式：** agent 集成测试覆盖半截 JSON 不执行、重复调用事件不重复执行、缺完成标记、流内异常、超时、取消、多轮工具配对。此时未实现 Task 的原 Coding 装配仍会失败，不据此伪造成功；T15 后统一通过原三条场景。

### T11–T15：基础 Task Runtime 与 Agent Adapter

- [x] **T11：实现内存 Task Store、去重和保留策略**
  - **目标：** 接受、状态、尝试和结果引用可一致查询且有界。
  - **涉及模块：** `plugins/task-store-memory`。
  - **前置依赖：** T03、T05。
  - **实现内容：** Task/Flow 快照、受控事务更新、接受序号、namespace 内幂等键与规范化输入摘要；Task/Flow/等待/结果容量；TTL/LRU 与下游/父任务/Handle 引用保留；事件窗口和清理。图容量由 engine 统一协调，Store 不启动任务。
  - **验证方式：** 同键同输入复用 Handle 语义、同键异输入冲突、跨 namespace 不碰撞；回收不删下游仍需输出；去重保留窗与任务可见期一致；外部不能修改快照。

- [x] **T12：实现有界 FIFO 队列与调度候选接口**
  - **目标：** 队列只维护 ID/索引，明确容量与候选选择边界。
  - **涉及模块：** `plugins/queue-memory`。
  - **前置依赖：** T03、T05。
  - **实现内容：** 稳定接受序号 FIFO、取消移除、候选遍历和容量预留/释放接口；支持 scheduler 跳过暂不可运行 key；与 Task 状态分离。优先级/延迟算法在 T19 补齐。
  - **验证方式：** FIFO、容量满明确拒绝、取消不再派发、被阻塞候选不遮挡其他资源任务；没有无界等待入队 Promise 队列。

- [x] **T13：实现 Task Engine、Scheduler 和 Handle**
  - **目标：** 非模型 handler 可以正确接受、执行、查询、取消和 drain。
  - **涉及模块：** `plugins/task-engine/index.ts`、`scheduler.ts`、`task-state.ts`、`handlers.ts`。
  - **前置依赖：** T03、T05、T06、T11、T12。
  - **实现内容：** 装配完成后固定 kind/version 与 schema；提交同步验证和容量接受；单一状态入口/单个派发循环；原子资源预留、最大实际并发与 per-key 限制；Handle result/snapshot/events/cancel、TaskEngine cancel/drain；绝对 deadline 和活动 cancelling→终态；所有 handler Promise 被跟踪。拒绝超出配置的不可满足资源请求。
  - **验证方式：** 100 Task、并发 4 的实际峰值不超过 4；同 key 不重叠，无队头阻塞；排队取消/执行取消/deadline/drain 超时；没有无人处理的 rejection；等待尚未接入时不宣称支持它。

- [x] **T14：实现 Agent Task Adapter，共用会话与准入**
  - **目标：** 队列 Agent 执行与直接 send 使用同一运行事实。
  - **涉及模块：** `plugins/agent-task`、内核受限 Agent 执行能力。
  - **前置依赖：** T10、T13。
  - **实现内容：** 可信范围中解析现有 session；在调度时声明 Agent/会话资源并携带准入凭证启动；首次接受绑定 runId；RunResult 与 Task 终态准确映射；直接和排队共用取消与状态；同会话接受序 FIFO。禁止 Task 重试从头追加同一用户输入。
  - **验证方式：** 排队与直接调用争用同一槽；不同会话并发、同会话不重叠；失败 RunResult 不被当作成功 Task；Task 取消传到真实工具/子进程，清理后才能同会话继续。

- [x] **T15：实现基础 DAG、输出绑定与整体取消**
  - **目标：** 原有 Coding A/B→review 场景和三条原始测试全部通过。
  - **涉及模块：** `plugins/task-engine/flow.ts`、Flow 结果与 Store。
  - **前置依赖：** T13、T14。
  - **实现内容：** 图原子接受/拒绝；重复 ID、未知依赖、环、输出节点、绑定/schema/容量检查；全部成功后就绪；从上游 TaskResult.output 解析受限路径并再次校验完整输入；Flow 局部并发/总 deadline、默认 fail-fast 与 continue-independent；等待已启动分支真实收敛后形成结果。
  - **验证方式：** 原三条 Coding 场景原有断言全部通过；读取屏障证明两工作区真实并发；review 只执行一次；未知路径/环/容量拒绝无残留图；失败与取消不会制造成功依赖。

### T16–T18：模型、压缩与观测

- [x] **T16：实现 AI SDK 单步模型适配与路由更新**
  - **目标：** 以真实 Adapter 接通至少一个宿主实际采用的协议，同时保持 SDK 类型隔离。
  - **涉及模块：** `plugins/model-ai-sdk`、模型适配契约测试、package/lockfile。
  - **前置依赖：** T02、T06、T10。
  - **实现内容：** 实施时依据官方资料及锁定包类型核验 AI SDK/provider/Node 兼容，仅安装实际协议依赖；路由能力矩阵和不可变配置版本；每步一次 streamText，不传 execute、不启用 SDK 多步与自动重试；自有消息、附件和必要 opaque metadata 映射；finish/error/usage/流关闭；安全模型重试及 delta reset/attempt；凭据只注入 client，不写 process.env 或记录。
  - **验证方式：** 真实 Adapter 接本地协议传输 fixture，检查实际请求、流片段、混合内容、多调用、取消、缺失 usage、协议不兼容、更新仅影响后续 run；根包导入不加载可选 SDK。真实 canary 独立显式启用，未运行就如实记录。

- [x] **T17：实现上下文压缩及手动 compact**
  - **目标：** 长会话可在预算内继续，压缩失败不损坏历史。
  - **涉及模块：** `plugins/context/budget.ts`、`plugins/compaction`、compact 执行路径。
  - **前置依赖：** T07、T08、T10、T16。
  - **实现内容：** 完整旧轮次选择、保留当前请求/系统约束/未决配对/provider 字段；结构化摘要校验、revision 原子投影提交；摘要调用共用模型额度/预算；手动和自动压缩的模型快照规则；无法容纳返回 CONTEXT_LIMIT，无 compactor 明确 skipped。
  - **验证方式：** 压缩成功后关键事实/引用保留；摘要失败、取消、冲突时原始历史和旧投影不变；send/compact 互斥；未知 usage 不作为免费；不无限压缩重试。

- [x] **T18：实现有界观测、事件重读与安全诊断**
  - **目标：** 观察状态而不参与业务控制，慢消费者不导致内存无限增长。
  - **涉及模块：** `plugins/telemetry`、Session/Task 事件投影与订阅接口。
  - **前置依赖：** T07、T10、T11、T13、T16。
  - **实现内容：** schemaVersion/ID/namespace/局部 seq；提交事实与可合并 delta 分离；消息 attempt/offset/reset；有界 observer 队列、异常报告、快照不可变；订阅退出/关闭清理、保留窗内重读与过期结果；配置/错误脱敏。不另造以事件驱动的调度器；OpenTelemetry 仅在实际需要时做独立适配。
  - **验证方式：** 同步抛错及慢 observer 不改变已提交结果；事件次序与提交一致；delta 丢弃可被最终消息校准；读取过期序号明确返回；退订后资源回收；密钥和原始 provider 错误不出现在事件中。

### T19–T23：复杂 Task Runtime

- [x] **T19：实现优先/延迟队列与安全 Task 重试**
  - **目标：** 公平调度、延迟就绪和受限重试不会绕过预算或重复副作用。
  - **涉及模块：** `plugins/queue-memory`、`task-engine/retry.ts`、Scheduler。
  - **前置依赖：** T11–T15。
  - **实现内容：** 优先队列与明确的 aging/轮转公平规则；同会话接受顺序优先；notBefore/退避延迟堆与最近到期 timer；handler 安全分类、attemptId、指数退避上限/抖动；deadline 覆盖所有等待；retry_wait 释放活动槽；Agent Task 只重试安全启动或显式续跑。
  - **验证方式：** 可控时钟验证延迟/退避/attempt 上限；持续高优先级流下低优先级最终被派发；延迟与队列取消不泄漏 timer；写结果 unknown/参数/权限/主动取消不自动重试；总 deadline 不因重试重置。

- [x] **T20：实现预注册等待、signal 和 handler resume**
  - **目标：** 外部等待释放 handler 槽且没有丢信号/重复消费竞态。
  - **涉及模块：** `task-engine/waits.ts`、TaskScope、Task Store、Handle 事件。
  - **前置依赖：** T03、T11、T13、T19。
  - **实现内容：** createWait 的有界预注册；handler/version/范围/schema/state/有效期绑定；waiting 提交与提前信号匹配；eventId 与等待点去重；resume 新活动段；completed/请求失败/取消/过期时清理；未知等待点不缓存；等待中保留仍未结束的外部资源额度。
  - **验证方式：** 信号早于 waiting、重复信号、过期/非法/跨范围信号、取消与信号同时发生、resume 再次 waiting；execute 外部提交只发生一次；单槽可在外部等待期间执行其他 Task。

- [x] **T21：实现 Agent 挂起/恢复与工具确认**
  - **目标：** 需要输入或外部结果的工具可继续原 run，不重复用户消息和已完成调用。
  - **涉及模块：** `basic-loop/run-state.ts`、`tools/policy.ts`、`agent-task`、内核 resume。
  - **前置依赖：** T09、T10、T14、T20。
  - **实现内容：** 同进程 continuation、runId 保持、活动段重建；绑定 executionId/toolVersion/参数 hash/有效期的确认；审批仅补足已允许动作条件；同批调用保存已完成与未决状态；合法恢复重检权限/资源，拒绝确认补入原调用的拒绝结果；等待保留会话逻辑位置，恢复优先后续消息；Agent Task 正确映射 suspended。
  - **验证方式：** 直接 send 等待返回 BUSY；错误/重复 continuation 不执行；参数变更需重新确认；同批已完成写不重跑；拒绝/取消/超时都闭合配对；恢复不重复追加用户输入。

- [x] **T22：实现子任务、动态 fan-out/fan-in 和预算继承**
  - **目标：** 多节点动态工作受控扩展，单执行槽下父子等待无死锁。
  - **涉及模块：** `task-engine/children.ts`、Flow 扩图、TaskScope 与共享预算。
  - **前置依赖：** T15、T19、T20、T21。
  - **实现内容：** parentTaskId/子图归属、深度/节点/项目数上限、扩图原子预留；父任务结构化等待释放槽；独立子 Agent 会话及权限/预算继承；禁止父等待依赖同一被占用会话；fan-out 局部并发、按稳定 node ID 汇合；取消传播和剩余预算不重置。
  - **验证方式：** maxConcurrentTasks=1 父子完成；同会话循环等待明确拒绝；过深/过量扩图不留下部分子图；子任务实际并发和成本受共享上限约束；父取消后全部已启动子任务收敛。

- [x] **T23：实现条件、汇合、race 与显式补偿 Flow**
  - **目标：** 完成设计中的分支语义和部分失败处理。
  - **涉及模块：** `task-engine/flow.ts`、注册判定/补偿扩展及 Flow 类型。
  - **前置依赖：** T15、T19、T20、T22。
  - **实现内容：** 安装时注册纯判定；未选分支 skipped；all-success/all-settled/selected-success 汇合；race/any-success 选择及失败竞争规则；取消输家并等待真实收敛；写分支组合需显式策略；业务显式补偿步骤，保留原失败和补偿结果，不宣称自动事务回滚。
  - **验证方式：** 分支选择、skipped 传播、选中分支汇合、部分成功保留、race 输家无遗留后台执行；补偿失败可见；依赖输出和错误不会被改写成伪成功；图终态等待必要清理。

### T24–T30：扩展 Adapter、Scenario 与用法

- [x] **T24：实现动态 Schema 与 MCP 工具桥接**
  - **目标：** 外部工具和静态工具遵循同一执行与授权规则。
  - **涉及模块：** `plugins/tools/schema.ts`、`plugins/mcp`、package/lockfile。
  - **前置依赖：** T01、T09、T20、T21。
  - **实现内容：** 核验并锁定实际 MCP client/协议；动态 JSON Schema 方言和大小/嵌套约束，按需要加入 Ajv；禁止网络 `$ref`、默认填值及类型强转；目录快照/重名检查，外部调用与结果映射到 tool-runtime；连接取得后即登记清理。SDK 自动 execute 不进入模型 Adapter。
  - **验证方式：** 相同 allow-list/Schema/取消/输出上限用例同时约束静态与动态工具；连接/setup 失败释放；外部名称冲突拒绝；根导入不加载 MCP；本地协议边界测试不替代真实 tool-runtime。

- [x] **T25：实现按需 Skills 上下文资源**
  - **目标：** Markdown 资源可按任务贡献上下文且有版本和能力约束。
  - **涉及模块：** `plugins/skills`、context contribution。
  - **前置依赖：** T01、T08、T17。
  - **实现内容：** 受控资源来源、元数据/版本/适用条件/所需能力、按需加载及大小预算；贡献 provenance；权限来自宿主定义，Skill 命令文本不授予执行能力。资源缓存明确 owner 与生命周期。
  - **验证方式：** 未选资源不加载；缺必需能力与越界来源明确失败；资源内容不修改身份/allow-list；贡献顺序和预算稳定；关闭清理自有资源。

- [x] **T26：完善 Coding 场景与真实执行边界验证**
  - **目标：** 在真实文件/进程上验证框架扩展能力，保留所有原始场景约束。
  - **涉及模块：** `tests/scenarios/coding.scenario.test.ts`、受控 Coding client/场景组合、examples。
  - **前置依赖：** T15、T19、T21、T23。
  - **实现内容：** 从现有行为提取可运行装配；文件/补丁/diff/固定测试任务通过宿主执行器注入；工作区资源键、真实路径/符号链接边界、hash/version 冲突、进程树取消与输出上限；隔离工作区分析与修改/验证 Flow。共享稳定执行逻辑，fixture 只保留测试数据和断言，不把它当不可信代码沙箱。
  - **验证方式：** 原三场景持续通过；越界路径/链接、并发写冲突、子孙进程取消、用户修改保护和输出上限的集中集成验证；不修改样例测试来使缺陷消失；实际支持的平台/执行器边界写清楚。

- [ ] **T27：实现 3D 外部 Job 代表场景**
  - **目标：** 证明受控生成提交、等待、恢复及产物验证可由插件组合完成。
  - **涉及模块：** 3D 场景 tools/handler/Flow、examples、场景集成测试。
  - **前置依赖：** T16、T20–T23。
  - **实现内容：** 宿主注入 Job client；参数确认、预登记等待、幂等提交、Job ID、主动 signal 或有界延迟查询；resume 验证 ArtifactRef/格式/版本；生成资源额度与 JS handler 槽分离；取消调用业务 client 并核实结果，未知结果不重提交付费 Job。
  - **验证方式：** 可控 Job client 驱动真实 Task Engine；重复/提前完成只提交一次；等待释放执行槽但未释放仍活跃的 Job 配额；取消失败/结果未知保留可见状态；不依赖 GPU 后台才能验证框架。

- [ ] **T28：实现 RAG 摄取与问答代表 Flow**
  - **目标：** 检索、来源与受限文档处理通过公共扩展点复用。
  - **涉及模块：** RAG client/handler/context contribution/引用校验、examples、场景集成测试。
  - **前置依赖：** T16、T17、T22、T23。
  - **实现内容：** 受控摄取→解析/切块→批量 embedding→索引 client；查询→向量/关键词检索→去重重排→回答→引用验证；Embedding 能力与文本模型隔离；限制文档/批次/并发；固定一个检索触发位置；保留 document/version/chunk/页码与 ACL 范围；部分失败明确报告。
  - **验证方式：** 可控检索/embedding client 接真实 Flow/Loop；无越权引用、伪造引用被拒、证据不足明确表达；文档失败不吞掉独立成功分支；大量文档不会无限扩图；核心无索引库依赖。

- [ ] **T29：实现客服查询、受控操作与转人工场景**
  - **目标：** 业务身份与审批约束在工具边界真实生效。
  - **涉及模块：** 客服场景 tools/Flow/handoff、examples、场景集成测试。
  - **前置依赖：** T09、T21、T23、T28。
  - **实现内容：** 宿主 identity/订单/知识/工单 client；分类→并行授权查询→有依据答复→必要确认→操作或 handoff 引用；订单归属和金额规则交业务 client 校验；未知结果/来源冲突进入场景确定路径。
  - **验证方式：** 跨身份订单拒绝、模型参数不能改身份、审批不能覆盖权限、确认参数防篡改；安全幂等与 unknown 副作用处理；转人工结果有业务引用，无需建设工单后台。

- [ ] **T30：实现多 Agent 组合验证与完整公共示例**
  - **目标：** 证明扩展新场景和委派不需要修改内核。
  - **涉及模块：** 场景委派插件、`examples/business-agent.ts`、`queued-agents.ts`、`cancellation.ts`、`custom-plugin.ts`、`complex-flow.ts`、`async-generation.ts` 及说明。
  - **前置依赖：** T16–T29。
  - **实现内容：** 独立子会话、最小上下文、权限交集、handler allow-list、深度/总预算与资源键；模型提出图时由宿主验证再提交；补齐报价多轮、自定义插件、排队、取消、复杂 Flow、外部等待示例。示例消费公共 API，真实网络配置通过宿主显式传入。
  - **验证方式：** 示例构建并实际执行无网络路径；多 Agent 不跨会话泄漏身份/历史，不绕过全局资源；新增一个领域 handler 无 kernel/Loop 改动；真实依赖仅在显式选用的 adapter 路径加载。

### T31–T32：完整集成验证与最终审查

- [x] **T31：完成故障、并发与有界资源综合验证并修复**
  - **目标：** 验证所有核心流程、失败路径和关闭收敛，形成量化证据。
  - **涉及模块：** kernel/Agent/Adapter/Task/Flow/场景综合测试、受控时钟和故障 fixture。
  - **前置依赖：** T04–T30。
  - **实现内容：** 整理行为矩阵而非逐函数测试；加入大量 queued/waiting、快速取消、连续重试、慢 observer、高优先级持续进入、动态子图膨胀、setup/commit/流/输出失败；核对对象/订阅/timer/Promise/引用保留。发现问题直接修复对应 owner。
  - **验证方式：** 全量 `test` 通过且包含原 Coding 场景与 Adapter 契约；至少报告任务量、峰值实际并发、内存测量条件/变化、未清理资源数；单槽父子无死锁、早到信号只推进一次、关闭不合作函数不假释放；真实模型 canary 的执行或未执行单独列明。

- [x] **T32：公共 API、包边界、文档与最终架构审查**
  - **目标：** 交付清晰可使用的单包 SDK，所有确定范围内功能可验证。
  - **涉及模块：** 全部 src、package exports、声明文件、检查脚本、README、TESTING、架构状态与本清单。
  - **前置依赖：** T31。
  - **实现内容：** 审查根/子路径导出和公开类型；移除未实现错误与生产 placeholder；检查静态/插件依赖环、职责泄漏、重复校验/调度/状态、巨大 owner、不必要抽象和依赖；更新实际用法、错误、预算、取消/等待/保留窗与内存限制。明确 legacy 兼容层和独立分包仅在出现实际需求时建设，不凭名称宣称兼容。
  - **验证方式：** format、lint、typecheck、build、全量测试、边界检查全部通过；从构建后的公共入口做消费/导入验证；搜索 `TODO`/`FIXME`/`NOT_IMPLEMENTED`/占位代码并逐项排除生产残留；声明不泄漏 SDK 内部类型；核心无领域分支；全部任务有证据后勾选。

## 6. 里程碑与验收对应

| 里程碑 | 任务    | 可以宣称完成的能力                                         |
| ------ | ------- | ---------------------------------------------------------- |
| M0     | T01–T06 | 核心 contract、插件装配/回滚、作用域和统一准入可独立验证   |
| M1     | T07–T10 | 真实 Agent Loop 与静态工具闭环、取消、消息配对             |
| M2     | T11–T15 | 基础 Task/Flow 与 Agent 适配；原三条 Coding 测试全部通过   |
| M3     | T16–T18 | 真实 AI SDK Adapter、配置快照、多模态引用、压缩和有界观测  |
| M4     | T19–T23 | 优先/延迟/安全重试、外部等待/恢复、确认、子任务与高级 Flow |
| M5     | T24–T30 | MCP/Skills、四类代表场景、多 Agent 和公共示例              |
| M6     | T31–T32 | 全量门禁、故障/压力、关闭和最终架构审查完成                |

主要依赖链：`Contract → Core → Agent Runtime / Task Runtime → Agent Task Adapter → 基础 Scenario → 模型与高级 Runtime → 扩展 Adapter / Scenario → 综合验证`。Task Store 与 Queue 不互相依赖；任务列表采用一个合法的执行次序，不要求为了并行建立新的包或抽象。

| 架构验收面                                  | 实现任务                | 主要验证位置                  |
| ------------------------------------------- | ----------------------- | ----------------------------- |
| 插件图、作用域、失败回滚、inspect           | T01、T04–T06            | kernel contract               |
| 会话准入、身份隔离、取消后继续              | T06–T10、T14、T21       | Agent 集成 + 原 Coding        |
| 模型单步、多调用、metadata/usage、配置切换  | T02、T10、T16           | Adapter contract + Agent 集成 |
| 工具严格校验、策略、幂等、unknown、资源冲突 | T09、T21、T24           | Agent/工具边界集成 + 场景     |
| FIFO/公平性、容量、延迟、去重与回收         | T11–T13、T19            | Task Engine 集成              |
| DAG、分支、绑定、部分失败、race/补偿        | T15、T23                | Flow 集成                     |
| 子任务、总预算、节点深度、单槽无死锁        | T22、T30                | Flow/委派集成                 |
| 等待预登记、早到/重复信号、恢复不重执行     | T20、T21、T27           | Flow 等待集成 + 3D 场景       |
| 压缩原子提交、上下文来源与预算              | T07、T08、T17、T25、T28 | Agent 集成 + RAG 场景         |
| 事件上限、慢 observer、提交后通知           | T18                     | 观测集成 + 故障压力           |
| Coding 路径/真实进程、客服范围、RAG 引用    | T26–T29                 | 场景集成                      |
| 关闭、内存、timer/订阅/引用/不合作执行      | T05、T06、T13、T20、T31 | 故障/资源压力                 |
| 公共 API、轻量根入口、依赖方向              | T01、T16、T24、T32      | 类型/导入边界 + 构建消费验证  |

## 7. 范围边界与下一步

当前确定范围包含内存 Task/Flow、复杂异步等待、AI SDK 单步适配，以及通过插件和宿主 client 组合的代表场景。HTTP 服务、数据库/持久化恢复、跨进程调度、GPU/订单/向量库后台、插件热卸载、图形 DAG 编辑器、插件市场、完整 IDE 不在本次实现范围。长期记忆后端、OpenTelemetry、旧 DSH 兼容入口及拆包仅有可选设计，不为了填目录而建设。

真实外部 client 可通过受控测试替身验证其协议边界，框架本体、Loop、队列、调度与 Store 必须使用生产实现。真实模型 canary 不作为离线测试的隐式步骤；SDK Adapter 的真实代码和协议转换验证仍为必做。

本轮完成：架构/源码/契约审查，T01–T26 核心实现，21 项测试，以及 typecheck、lint、build、format 和依赖边界门禁。后续 T27–T30 仅在宿主提供对应业务 client 时增加场景组合，不改变核心内核边界。
