# Nova 接入 OpenCode 2 设计

**HTTP/SSE 候选设计。** 已用 Windows 上的 OpenCode 2.4.1 验证核心 API 行为。[ACP 试点方案](opencode-runtime-alternatives.md)定义首版范围。若阶段 2 将执行跨 Worker 存活或恢复挂起审批设为硬验收，再评估此方案。

## 1. 目标与首版范围

新建项目会话可以选择 OpenCode 作为执行后端。用户安装官方 CLI，在代码所在机器启动服务即可，执行路径无需安装 Nova Runner。OpenCode 负责模型循环、工作区工具和本地 Skills。Nova 负责项目绑定、会话、输入队列、审批界面、事件持久化和产品工作流。

HTTP/SSE 候选覆盖普通项目会话的文本、多轮、工具卡片、单次审批、取消、断线对账和原生显式选择本地 Skill。Spec、Goal、附件与产物继续走各自已支持的执行路径，逐项完成兼容验证后再接入。后端通过 `backendId` 选择，既有会话继续使用已绑定的后端。需要迁移时新建项目会话，原聊天历史仍可查看。

接入 **OpenCode 2** 的服务 API，首个验证版本为 `2.4.1`。Nova Worker 使用官方 `@opencode/client`，通过版本探测和兼容矩阵控制可用范围。`opencode run --format json` 可用于命令行排查。产品交互通过服务 API 获取会话状态、处理审批和取消。 [OpenCode 安装](https://opencode.ai/docs/) · [CLI 命令](https://opencode.ai/docs/cli/commands/) · [HTTP 客户端](https://opencode.ai/docs/build/client/)

## 2. 架构与用户安装

```mermaid
flowchart LR
    UI[Nova 客户端] --> API[Nova API]
    API --> Worker[Nova Worker / RuntimeAdapter]
    Worker -->|HTTP + SSE| OC[OpenCode 2 serve]
    OC --> WS[工作区 / Skills / 模型配置]
    Worker -->|RuntimeEvent + Checkpoint| DB[Nova 事件与投影]
    DB -->|Nova SSE| UI
```

在代码所在机器安装并启动 OpenCode。试点也可以用 `npm install -g @opencode/cli@2.4.1` 固定到已验证版本。启动前使用 `OPENCODE_PASSWORD` 配置实例凭据，Nova 通过已授权的服务端连接读写该实例。 [服务配置与认证](https://opencode.ai/docs/cli/web/)

```sh
npm install -g @opencode/cli
opencode --version
opencode serve --hostname 127.0.0.1 --port 4096
```

| 部署方式 | Nova Worker 如何访问 |
| --- | --- |
| 单机试点 | Worker 与 OpenCode 同机，连接回环地址 |
| 代码在远程开发机 | 复用 Nova 的 SSH 连接归属与凭据管理，扩展受控端口转发，访问目标机器的回环地址 |
| Nova 在云端，代码在个人电脑 | 使用 Worker 可达的受控私网入口或隧道。个人电脑上的 `127.0.0.1` 只能被该机器直接访问，单独安装 CLI 无法建立云端连接 |

绑定记录保存连接归属、实例标识、目标目录和凭据引用。工作区由 OpenCode 所在机器解释，Nova 校验目录位于绑定允许的范围。按用户或受信工作区隔离实例和操作系统权限。服务凭据由 Worker 使用，实例级事件在适配器按会话和工作区过滤。首版沿用 OpenCode 自身的模型配置与凭据，Nova 的模型选择可在后续映射到可用的 provider/model。 [项目绑定 schema](../../apps/nova-server/src/modules/projects/project-binding.schema.ts) · [SSH 连接服务](../../apps/nova-server/src/modules/remotes/remote.service.ts) · [OpenCode 模型配置](https://opencode.ai/docs/providers/)

## 3. Nova 侧接入

| 代码入口 | 计划改动 |
| --- | --- |
| [RuntimeAdapter](../../apps/nova-server/src/modules/runs/runtime-adapter.ts) 与 [ConversationExecutor](../../apps/nova-server/src/modules/runs/conversation-executor.ts) | 注册 `opencode` 后端。适配器通过 `execute` 处理 `start` 和 `recover`，实现 `cancel` 与 `dispose`，接通现有 Worker、租约和事件提交流程。API 准入与 Worker 都从同一注册入口获取支持的后端 |
| [项目绑定](../../apps/nova-server/src/modules/projects/project-binding.schema.ts) 与 [会话准入](../../apps/nova-server/src/modules/conversations/conversation.service.ts) | 支持 OpenCode 实例与工作目录，提交时校验归属、可用性、输入类型和运行模式。连接重绑后为新执行建立新的运行上下文，存续 Run 使用先前绑定 |
| [Run 持久化](../../apps/nova-server/src/modules/runs/run.repository.ts) 与 [产品事件契约](../../packages/agent-ui-contracts/src/events.ts) | 从通用 `commit` 写入产品事件、消息和 checkpoint。上游字段限制在适配器内部。Run 终态由宿主结算，连续产品序号由 Nova 分配 |
| [有效能力](../../apps/nova-server/src/modules/runs/run-dto.ts) 与 [产品 Skills](../../apps/nova-server/src/modules/skills/index.ts) | 按后端、目标环境和模式暴露实际能力。Skill 目录查询绑定项目和环境，输入框提交确切选择。后端校验与界面开关采用相同的能力判断 |

每个 Nova 会话上下文对应一个 OpenCode `sessionID`，不同 Run 可在这个上游会话继续上下文。每个 Run 保存输入 ID、提交阶段、已处理的上游事件标识及待交互请求映射。Nova 已有 checkpoint 和上下文 epoch，可承载这部分关联。开始执行前保存身份和提交意图，接收事件后将上游进度、投影和输入消费一并提交。试点会话由 Nova 串行提交，避免同一个上游会话的 CLI 并行输入混入当前 Run。 [Run 准备与提交](../../apps/nova-server/src/modules/runs/run.repository.ts)

运行模式需在 OpenCode 生效后才对用户开放。OpenCode 默认 Plan 可以写计划文件，Shell 依权限配置处理。Nova 按执行端实测的写入、Shell、插件和 MCP 边界开放对应能力。两种传输均先提供单次允许和拒绝。待验证 OpenCode `always` 的保存范围后，再评估 Nova「本会话允许」的映射。 [OpenCode Agents](https://opencode.ai/docs/agents/#built-in-agents) · [OpenCode 权限](https://opencode.ai/docs/permissions/) · [Nova 交互契约](../../packages/agent-ui-contracts/src/interactions.ts)

## 4. 事件兼容性

| Nova 产品事件 | ACP 来源与处理 | HTTP/SSE 来源与处理 |
| --- | --- | --- |
| `message.started`、`block.upsert`、`text.delta`、`text.reset`、`message.committed` | `agent_message_chunk`、`agent_thought_chunk`。按消息 ID 和块顺序投影 | `session.text.*`、`session.reasoning.*`。用结束事件或消息快照修复缺片 |
| `block.upsert`、`tool.changed` | `tool_call`、`tool_call_update` | `session.tool.called/success/failed` |
| `interaction.changed` | `session/request_permission`。用户回复映射 `once` 或 `reject`，持租约的 Worker 回覆原请求 | `permission.asked/replied`。保存上游请求 ID 和 Nova revision，接管时查待审批列表 |
| `interaction.changed`（问题） | `elicitation/create`，后续验证 | `form.created/replied/cancelled`。后续支持可表达的单问题表单 |
| `message.committed`、`input.consumed` | Nova 提交记录与 `session/load` 回放中的 `user_message_chunk`。得到可归属的接收证据后确认消费 | `session.inbox.delivered`。提交响应表示入队，到投递时确认消费 |
| `usage.changed` | prompt 响应 `usage` 与 `usage_update` 分别投影回合和会话统计 | `session.usage.updated`。按上游统计口径投影，用消息快照补齐已完成消息的用量 |
| `run.changed` | prompt 响应 `stopReason`、协议错误和传输丢失。收到 `cancelled` 确认取消，响应丢失进入对账 | `session.execution.succeeded/failed/interrupted`。按上游会话和已提交输入归属结算，取消结合中断确认和状态对账 |
| `spec.changed`、`goal.changed`、`plan.changed` | 由 Nova 业务流程校验并结算 | 同 ACP |

两条路径复用 Nova 产品契约和持久化结算。文本 offset 按 Nova 字符串长度计算。工具按 call ID 关联，来源具备可验证的通道、增量和 offset 时才发布 `tool.output`。 [OpenCode API](https://opencode.ai/docs/api) · [OpenCode ACP](https://opencode.ai/docs/cli/acp) · [Nova 产品事件](../../packages/agent-ui-contracts/src/events.ts)

ACP 发出 prompt 前持久化提交意图。响应丢失时按结果未知对账，禁止自动重发。实时和 `session/load` 回放分开处理，回放按消息和工具调用 ID 幂等合并，允许缺失中间增量。审批挂起时 `execute()` 保持连接和租约，失联后按 Run 终态结算，由新 Run 从同一会话继续。 [ACP 试点的审批、投影与验收](opencode-runtime-alternatives.md#4-试点实现和验收)

### 4.1 HTTP/SSE 断线、接管和取消

1. **提交。** 先订阅并确认连接，再提交 prompt。由 Nova 输入 ID 派生稳定的 OpenCode 消息 ID，并保存请求指纹。用同一 ID 重试前确认提交状态。实测重复 ID 只保留一条待投递输入，改变正文后再次提交同一 ID 也返回原输入，因此 Nova 要先校验指纹。
2. **接管。** Worker 恢复时使用已有 `sessionID` 和输入 ID 查上游 inbox、消息历史、活动状态和待审批。利用已确认的消息及终态修复投影。当前 `prepare` 根据 continuation 与 outcome 决定 `recover` 的时机，接入时须把上游已提交和待确认状态纳入该判断。Nova 的 fence 保护数据库提交，调用上游前仍须校验租约及会话归属。
3. **补读。** `/api/event` 只提供实时流。Windows 2.4.1 的实验性 session log 在试验的 `after` 和 `follow` 组合下只返回 `log.synced`。启用 HTTP/SSE 前验收快照对账，恢复最终文本、已完成的工具结果和消息终态，允许丢失中间增量。Nova 已落库的事件继续按产品游标重放。
4. **审批和取消。** 审批请求落库后可挂起 Run 并释放租约。恢复时用已记录的回复和上游待审批状态对账，审批期间 Worker 重启和回复重复投递均需实测。取消调用 `interrupt`，按取消、超时或执行错误收口，并在工具结果中保留可取得的 stderr。验收覆盖接管时 Run 已处于 `cancelling` 的路径；断连后用户可查看错误并决定是否重试。

[OpenCode 事件订阅语义](https://opencode.ai/docs/build/client/#stream-events) · [OpenCode 会话 API](https://opencode.ai/docs/api) · [Nova Run 恢复](../../apps/nova-server/src/modules/runs/run.repository.ts)

## 5. Skills 兼容性

OpenCode 2 原生发现 `.opencode/skills`、`.agents/skills`、`.claude/skills` 及相应全局目录，也可通过 `skills` 配置增加目录和 HTTP 清单。原生 ID 由目录或文件名决定，frontmatter `name` 用于展示。HTTP/SSE 按工作区查询目录，区分加载中、无技能、连接离线和配置错误。ACP 试点开放纯正文固定版本注入。两条路径的准入与 UI 使用同一份后端、传输、环境和模式能力。 [OpenCode Skills](https://opencode.ai/docs/skills/) · [OpenCode API](https://opencode.ai/docs/api) · [试点 Skills 准入](opencode-runtime-alternatives.md#31-skills-准入)

| Nova 中的来源 | 兼容程度与接法 |
| --- | --- |
| 工作区和用户已有的 OpenCode Skills | 实测 HTTP 目录 API 可发现 `.agents/skills` 与显式配置来源，prompt 的 `skills: [{ id }]` 可加载正文。ACP 保留原生发现，首版关闭原生显式选择 |
| Nova 设计中的 `.nova/skills` | 通过 OpenCode 的 `skills` 显式配置纳入，保留用户可编辑的文件来源。可为 OpenCode 项目直接使用 `.opencode/skills`，已有目录无需搬迁 |
| `nova.career-coach` | 首版继续沿用现有聊天入口。迁移时保留 Nova ID、版本和无工具策略。纯 Markdown 正文可以复用 |
| `nova.spec` | 两种传输均待通过 OpenCode 插件或 MCP 提供 `spec_read` 和 `spec_update`，并保留 Nova 的修订校验与结算。调用权限限制在当前 Run 绑定的 Spec 版本 |
| 平台发布的 Skills 和资源包 | 纯正文的固定版本可随 ACP prompt 作为 assistant-only context 提交。含资源的技能需要文件投递通道，将正文、脚本和模板按版本与摘要交付到目标目录，再用 OpenCode `skills` 配置加载 |

准入根据 `skillSelection` 校验技能的 ID、版本及目标传输可用的加载方式。OpenCode 本地目录项与 Nova 平台发布版本各自保留归属。入队后的固定版本使用已接受的快照。源变更导致所选版本无法取得时返回冲突并要求重新选择。尚未具备固定资源交付能力的目录项按实时工作区资源展示。 [Nova Skill 契约](../../packages/agent-ui-contracts/src/skills.ts) · [当前 Skill 准入](../../apps/nova-server/src/modules/runs/agent-profile.ts) · [Spec Skill](../../packages/tools/skills/spec/SKILL.md) · [Nova Skills 与产物设计](nova-skills.md)

## 6. HTTP/SSE 候选的实施与验收

| 阶段 | 范围 | 放行条件 |
| --- | --- | --- |
| 1. 连接验证 | 同机或受控连接、文本多轮、工具卡片、单次审批、取消和原生 Skill 选择 | 安装官方 CLI 的环境完成完整流程。拒绝错误凭据、跨项目会话 ID 和越界目录。技能冷启动可恢复，选择后可观察实际加载 |
| 2. 接管验收 | 断线对账、执行保活、审批接管、超时、取消未知、版本探测与能力开关 | 模拟 prompt 已执行但响应丢失、断线漏掉终态、审批期间 Worker 重启和重复投递。验证待审批可继续、无重复执行、最终消息一致、SSE 游标连续。各受支持平台通过相同验收 |
| 3. 产品能力迁移 | Spec、Goal、附件、产物发布以及其余仍依赖 Runner 的入口 | 逐项验证产品状态、权限和失败恢复。存量依赖完成迁移或关闭后再处理 Runner 注册和协议入口 |

运行期优先观测连接版本、Run 状态、事件流断开与恢复、对账耗时和取消未确认次数。日志用 Nova Run ID 与上游会话 ID 关联，过滤消息正文、技能内容、凭据和工作区敏感数据。

### 已验证与待验证

- **已验证**。Windows 临时目录安装 `@opencode/cli@2.4.1` 并启动 `opencode serve`。使用本地模拟模型验证 HTTP 认证、文本 SSE、输入交付和用量、运行成功与中断、工具读取和单次审批、重复消息 ID，以及 Skills 目录发现和显式加载。
- **实测差异**。服务冷启动时技能列表曾暂时为空。实验性 session log 在试验中未补出历史事件，消息列表能返回完整文本及结束状态。重复 ID 即使正文改变也返回原输入。
- **待验证**。Nova 适配器、数据库事务与前端 SSE 的端到端行为，跨平台及 SSH 部署，断线与 Worker 接管时的审批和取消，Spec、Goal、附件与产物的兼容性。
