# Nova 接入 OpenCode ACP 试点方案

**试点决策。** Nova Worker 启动 `opencode acp` 并通过 stdio 调用，OpenCode 在代码所在机器执行模型循环和工作区操作。Nova 保留 Run、审批和产品 SSE。审批期间 Worker 保持连接和租约，失联后回放历史并允许用户从同一会话继续。[HTTP/SSE 设计](opencode-runtime-design.md)留作阶段 2 候选，只有跨 Worker 保活或恢复挂起审批成为硬验收时再评估。

## 1. HTTP/SSE 方案的接入成本

| 环节 | `opencode serve` 的接入工作 |
| --- | --- |
| 连接和部署 | Worker 管理服务认证，并通过回环、SSH 端口转发或受控私网入口访问实例 |
| 断线补读 | `/api/event` 提供实时流，需从消息、运行状态和待审批列表对账。Windows 2.4.1 实测实验性 session log 只返回 `log.synced` |
| 提交和投影 | 以稳定的上游输入 ID 和请求指纹核实重复提交，按消息和工具 ID 合并事件与快照 |

ACP 省去 HTTP 实例认证和端口转发，并以 `session/load` 回放作为历史修复来源。Nova 仍需保存提交意图、持久化产品事件，并按取消、超时或错误持久化中断结果。 [HTTP/SSE 对账](opencode-runtime-design.md#4-事件兼容性)

## 2. OpenCode 2.4.1 实测

在 Windows 使用独立子进程、临时工作区和本地模拟模型验证了以下行为。早期 2.0.25 仅用于初步握手，试点以 2.4.1 为基线。

| 验证项 | 结果 |
| --- | --- |
| 握手和建会话 | `initialize` 返回 ACP v1、`agentInfo.version` 和 `loadSession` 等能力。`session/new` 使用目标机绝对 `cwd` 和 `mcpServers: []`，返回 `sessionId` 与 model、effort、mode 配置项 |
| 模型设置和调用 | `session/set_config_option` 可选已配置的自定义模型。模拟模型收到正确的上游模型名、认证头和 `/v1/chat/completions` 请求 |
| 审批与取消 | 收到 `session/request_permission`。回 `once` 后工具完成，prompt 返回 `end_turn`。审批期间发 `session/cancel` 后收到工具终态，prompt 返回 `cancelled` |
| 审批中断与历史回放 | 审批挂起时关闭 stdin，进程退出。重启后用原 `sessionId` 和 `cwd` 调 `session/load`，收到用户消息和失败工具记录，原审批请求没有恢复 |
| Skills 输入 | 在 ACP prompt 上传 `skills: [{ id }]` 时，模型未收到技能正文，命令更新也未列出该技能。以 assistant-only text block 传入固定正文时，模型收到正文 |
| 回合用量 | 观测到 `usage_update` 和 prompt 响应的 `usage`。文档将响应 `usage` 定义为本回合调用合计，将 `usage_update.cost` 定义为会话累计成本 |

ACP 子进程启动私有 OpenCode 服务并以 stdin/stdout 传输换行分隔的 JSON-RPC。日志经 stderr 输出。固定 CLI 版本并用握手检查所需能力。模式通过 `session/set_config_option` 或 `session/set_mode` 选择。OpenCode 默认 Plan 可以写计划文件，Shell 依权限配置处理。Nova 按执行端实测的写入、Shell、插件和 MCP 边界开放 Plan。 [OpenCode ACP](https://opencode.ai/docs/cli/acp) · [OpenCode Agents](https://opencode.ai/docs/agents/#built-in-agents)

## 3. 接入能力

| 维度 | ACP stdio 试点 | HTTP/SSE 候选 | `opencode run --format json` |
| --- | --- | --- | --- |
| 部署 | 同机子进程。远程用 SSH 双向 exec | 独立服务，通过受控连接访问 | CLI 冒烟和排查 |
| 回合终态 | `session/prompt` 响应或协议错误，经 Nova 结算 | execution 事件和状态对账 | 退出码和 JSON |
| 审批 | `session/request_permission`，首版 once/reject | 审批事件和待审批列表 | 使用预置权限，缺少交互通道 |
| 历史恢复 | `session/load` 回放保存的历史 | 消息和状态快照 | 新命令可续已有会话 |
| 显式 Skill | 纯正文固定版本用 assistant-only context | 原生 `skills: [{ id }]`，已验证 | 按 CLI 输入和运行环境提供 |

### 3.1 Skills 准入

| 来源或用法 | ACP stdio | HTTP/SSE |
| --- | --- | --- |
| 工作区和用户已有 Skills | OpenCode 原生发现 `.opencode/skills`、`.agents/skills` 等目录。ACP 试点不开放 OpenCode 本地目录的原生显式选择 | 目录 API 查询并按工作区作用域展示，显式选择由 prompt 原生加载 |
| Nova 固定版本纯正文 | 校验 `skillSelection`、使用已固定的正文快照，在 ACP prompt 加 `annotations.audience: ["assistant"]` 的文本块 | 具备可用 OpenCode ID 时按原生选择提交 |
| 含资源文件的 Skills | 后续增加文件投递通道，以版本和摘要固定目标机目录，通过 OpenCode `skills` 配置纳入。配套文件交付前关闭显式入口 | 原生选择依赖目标工作区已可见的技能及配套文件，平台包同样要完成版本交付 |
| `nova.spec` | 待通过 MCP 或插件提供 `spec_read`、`spec_update`，保留 Nova 修订校验和结算 | 同 ACP |

准入与 UI 使用同一份后端、传输、环境和模式能力。ACP 只接受可通过正文注入实现的显式选择，版本无效、未获授权或依赖未交付资源时拒绝。通过 `skills` 配置纳入的 `.nova/skills` 遵循同样的规则。 [Nova Skill 契约](../../packages/agent-ui-contracts/src/skills.ts) · [OpenCode Skills](https://opencode.ai/docs/skills/) · [ACP prompt 内容](https://opencode.ai/docs/cli/acp#prompt-content)

## 4. 试点实现和验收

### 4.1 审批挂起与答复

1. ACP 适配器收到 `session/request_permission` 后，在同一批提交交互事件和请求映射，保留 ACP 请求 ID、Nova interaction ID 和关联工具调用。Run 保持 `running`，UI 由待审批交互提示用户。`execute()` 等待回复，继续占用一个 Worker 并发槽，沿用 Run deadline 和租约心跳。
2. `RunService.respond` 沿用已有的归属和 revision 校验，将回复持久化。首版由持租约的 Worker 在心跳周期检查已提交回复，按 run、interaction 和 fence 取值。API 与 Worker 分进程时也能送达。同进程的 resolver 可以在事务提交后加速唤醒。适配器只对匹配的请求回一次 `once` 或 `reject`，重复提交按现有幂等规则处理。
3. deadline 到达时沿用取消与超时结算，清理待处理交互。连接退出时清理本地待回复请求。租约丢失时，仍存活的旧适配器关闭连接。持有效租约的一方负责结算。中断按取消、超时或执行错误进入现有终态，并在工具结果中保存可取得的 stderr。连接丢失后用户可检查错误并决定是否重试，新消息以新 Run 继续同一 `sessionId`。

可接受审批在现有 deadline 内占用试点执行槽。验收同时观察等待审批时其他会话的排队情况。 [Run 回复事务](../../apps/nova-server/src/modules/runs/run.service.ts) · [Worker 监控](../../apps/nova-server/src/modules/runs/conversation-executor.ts) · [Nova Run 状态](../../packages/agent-ui-contracts/src/runtime.ts)

### 4.2 ACP 事件投影

| ACP 来源 | Nova 产品事件 | 转换规则 |
| --- | --- | --- |
| `agent_message_chunk`、`agent_thought_chunk` | `message.started`、`block.upsert`、`text.delta`、`text.reset`、`message.committed` | 按上游消息 ID 和块顺序关联文本与推理，按 Nova 字符串长度计算增量 offset，正常收口后提交消息 |
| `tool_call`、`tool_call_update` | `block.upsert`、`tool.changed` | 按工具调用 ID 更新。来源具备可验证的通道、增量和 offset 时才投影 `tool.output` |
| `session/request_permission` 和本地答复 | `interaction.changed` | 按 §4.1 保留连接和租约，首版只映射 once/reject |
| 本轮 prompt 响应与 `session/load` 的 `user_message_chunk` | `message.committed`、`input.consumed` | 根据已归属的 prompt 完成响应或历史消息，在同一批次确认输入消费和用户消息 |
| prompt 响应 `usage`、`usage_update` | `usage.changed` | 分开记录回合统计与会话统计，按上游口径更新 |
| prompt 响应 `stopReason`、协议错误、传输丢失 | `run.changed` | 按当前回合和本地取消状态结算。收到 `cancelled` 确认取消，响应丢失进入对账 |

**实时和回放。** `session/load` 期间隔离回放通知，按消息 ID 和工具调用 ID 与已落库投影幂等合并。仅写入必要的补全和修复事件。允许缺失中间增量，保留 Nova 产品 SSE 游标的连续性。

**提交意图。** 发出 prompt 前持久化输入 ID、上游会话、提交阶段和已知的消息关联。已尝试提交的 checkpoint 进入 `recover`，通过回放核实能够归属的输入及执行记录。消息存在可证明输入已入历史。工具副作用和 Run 终态需要各自的证据。响应丢失且无法确认时保留未知结果，禁止自动重发同一输入。 [ACP 回合规范](https://agentclientprotocol.com/protocol/v1/prompt-turn) · [ACP Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)

### 4.3 SSH 双向 exec

远程 ACP 在 `RemoteConnectionService` 增加常驻双向 exec，只供 ACP adapter 打开远端 `opencode acp`。复用 `requireVerified`、凭据与主机校验，提供 stdin、stdout、stderr 和退出结果，持续传输协议帧，不按一次性命令的累计输出长度截断。连接生命周期受 Run deadline、取消和 Worker 退出管理。现有 `execute()` 继续服务一次性命令。 [Nova SSH 服务](../../apps/nova-server/src/modules/remotes/remote.service.ts)

### 4.4 放行条件

| 验收项 | ACP 试点 | HTTP/SSE 候选 |
| --- | --- | --- |
| 历史恢复 | Worker 重启后 `session/load` 回放与库内投影一致，无重复，产品 SSE 游标连续 | 用消息和状态快照对账 |
| 审批等待 | 保留连接和租约。覆盖 API 与 Worker 分进程、快速回复、重复回复、deadline 和失联。失联收口后由新 Run 继续原会话 | 可释放租约，recover 核实待审批。审批时重启和重复投递仍需验收 |
| 取消 | `session/cancel` 后收到 `stopReason: cancelled` 才确认；异常中断保留错误输出并按取消、超时或失败收口 | `interrupt` 后用中断事件或可验证状态确认，并保留工具错误 |
| 执行跨 Worker 存活 | 只承诺历史恢复。stdin 关闭后审批和当前回合中断 | 阶段 2 要求独立保活或接管待审批时再评估并实测 |

同机试点用固定 2.4.1 验证文本多轮、工具卡片、审批、取消、纯正文 Skill 选择、提交响应丢失和 Worker 重启。远程启用前独立验证 SSH 通道断开、进程清理和审批回复。

## 5. 待验证清单

- `always` 的保存范围，确认是会话级还是目录配置级。
- `usage_update` 的多轮累计口径，与回合 `usage` 对照，覆盖重复事件和回放。
- 同一 ACP 进程内多个会话使用不同 `cwd` 并发时的隔离。`additionalDirectories` 用于会话附加目录，单独验证多会话并发。

## 参考

- [Agent Client Protocol 文档](https://agentclientprotocol.com/protocol/v1/overview) · [官方 TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [Zed 通过 ACP 启动 OpenCode V2](https://zed.dev/acp/agent/opencode-v2) · [OpenClaw 在服务端通过 ACP 调度 OpenCode](https://docs.openclaw.ai/tools/acp-agents) · [OpenChamber 连接 OpenCode Server](https://github.com/openchamber/openchamber/blob/main/packages/docs/content/docs/opencode-server.mdx)
