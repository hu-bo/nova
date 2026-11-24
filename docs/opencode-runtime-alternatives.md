# OpenCode 接入替代方案调研（ACP）

**调研笔记**。针对 [Nova 接入 OpenCode 2 设计](opencode-runtime-design.md)（下称"原方案"，走 `opencode serve` + HTTP/SSE）。结论先用一句话:

> 有更简单的方案:用 `opencode acp`(Agent Client Protocol over stdio)作为交互路径。它能整段删掉原方案里实例凭据管理、端口转发、SSE 断线补读、experimental session log 对账、重复消息 ID 指纹这些最重的部分,且是 opencode 官方文档明确写给"第三方客户端作者"的接口。代价是执行不再独立于连接存活,这与阶段 2 的 Worker 接管验收冲突,需要取舍或分阶段混用。

## 1. 原方案复杂度的来源

原方案(serve + `@opencode/client`)的重头不在"事件 → 产品事件"投影本身(那部分无论什么传输都要写),而在它选了一个**网络服务**作为对接面,于是必须处理:

| 复杂度 | 出处 |
| --- | --- |
| 实例凭据(`OPENCODE_PASSWORD`)、Basic auth、实例级事件过滤 | 原方案 §2、§3 |
| SSH 受控端口转发、云端私网入口/隧道 | 原方案 §2 部署表 |
| `/api/event` 只有实时流,断线后需快照对账;Windows 2.4.1 的实验性 session log 实测不可用(`after`/`follow` 只回 `log.synced`) | 原方案 §4.1 第 3 条 |
| 文本增量 offset 修复、缺片补齐 | 原方案 §4 表第 1 行 |
| 用 Nova 输入 ID 派生上游消息 ID + 指纹校验,对抗"重复 ID 改变正文仍返回原输入"的实测行为 | 原方案 §4.1 第 1 条 |
| 版本探测与兼容矩阵、待审批列表核实 | 原方案 §1、§4.1 |

## 2. 实测:opencode 自带 ACP 服务端

本地 `opencode v2.0.25` 实测(临时脚本 spawn `opencode acp --print-logs`,newline-delimited JSON-RPC over stdio):

- `initialize` 返回 `protocolVersion: 1`、`agentInfo.version`、能力:`loadSession: true`,会话能力 `list / resume / fork / close / delete / additionalDirectories`,`promptCapabilities: { embeddedContext, image }`,认证方法 `opencode-login`。版本探测由协议内能力协商替代。
- `session/new` 只需 `cwd`,返回 `sessionId` 和 `configOptions`,其中 `mode` 选项就是 **build / plan(只读)/ 自定义 agent**,`model` 选项是完整 `provider/model@variant` 列表,Nova 的模型映射与 Plan 限制在传输层之下就有现成落点。原方案"Plan 限制应由执行端权限落实"直接对应 `session/set_mode`。
- `session/load` 实测可用;v2 文档明确 **load 会回放历史**(包括每次已完成/失败的压缩各回放一条 update),替代原方案"基于快照对账"和失效的 session log。
- 内部实现上 `opencode acp` 会自己拉起 `opencode serve --stdio --port 0` 私有实例——ACP 只是同一执行核的 stdio 门面,ACP 会话与终端/TUI 共用同一个 session store(双向可见)。

官方 v2 文档《ACP → Protocol reference》(opencode.ai/v2/docs/cli/acp,"This section is for ACP client authors")给出:

- **审批**:`session/request_permission`,固定三选项 `once`(allow_once)/ `always`(allow_always)/ `reject`(reject_once);改文件时附 diff 预览;取消 prompt 时待审批自动按拒绝处理。与 Nova"单次允许/拒绝"逐字对应,`always` ↔ 「本会话允许」的映射也变成协议级语义。
- **回合与终态**:`session/prompt` 是请求/响应,响应携带 `stopReason`(end_turn / cancelled)与 `usage`(inputTokens/outputTokens/totalTokens);响应前还有 `usage_update`(used/size/cost)。Run 终态 = prompt 响应,**不需要**再从 `session.execution.*` 事件推断归属、中断确认。
- **取消**:`session/cancel` 通知,规格要求之后仍会收到最终 tool 更新再收口——原方案"取消结合中断确认和状态对账"与 `cancelled_unconfirmed` 路径大幅收窄到"进程失联"一种情况。
- **流式**:文本/推理/工具经 `session/update`(`agent_message_chunk`、`thought_message_chunk`、`tool_call`/`tool_call_update`)推送,无 SSE 游标、无分通道缺口修复需求。
- 子代理以 `_meta["opencode/child-session"]` 标注,工具 ID 带 `ses_child:` 前缀;MCP 经 `session/new` 传入;`OPENCODE_ENABLE_QUESTION_TOOL=1` 打开交互式问题工具(对应表单类交互,待验证)。
- 远程机器场景:`load/resume/fork 必须带原目录作为 cwd`,同一进程可开多会话(`session/list` 支持按 cwd 过滤)。

## 3. 三种接入面对比

| 维度 | serve + HTTP/SSE(原方案) | **ACP stdio(`opencode acp`)** | `opencode run --format json` |
| --- | --- | --- | --- |
| 传输与部署 | 常驻服务 + 凭据 + 端口转发/隧道 | 子进程 stdin/stdout;远程机复用既有 SSH exec 通道,**无需开新端口** | 同 ACP,一次性子进程 |
| Worker 断线/接管 | **执行存活**,重连对账即可续跑 | 进程随 stdin 关闭退出,存续 Run 被打断;接管后靠 `session/load` 回放恢复投影 | 同 ACP |
| 断线补读 | 实时流 + 快照对账;session log 实测不可用 | `session/load` 协议内建历史回放 | 无(重跑或续 `--session`) |
| 审批 | 事件 + 待审批列表核实 | `session/request_permission` 请求/响应,once/always/reject | 无交互通道,只能 `--auto` 或预置 allow/deny 规则 |
| Run 终态 | 由 execution 事件结算 | prompt 响应即终态 | 进程退出码 + 末条 JSON |
| 取消 | `interrupt` + 中断事件确认 | `session/cancel` + 响应 stopReason | kill 进程 |
| 模型/模式选择 | provider/model 配置 | `configOptions`(实测含 model/effort/mode) | `--model`/`--agent` 旗标 |
| 用量 | `session.usage.updated` | `usage_update` + prompt 响应 `usage` | JSON 事件内 |
| 显式 Skill 选择 | prompt 带 `skills:[{id}]` | 待验证(可用 `available_commands_update` 清单 + `_meta` 扩展) | `--command`/消息内提及 |
| Steer / 输入队列 | inbox 语义,首版 Nova 串行提交规避 | 无(v1 串行提交同样够用) | 无 |
| 规格来源 | 私有 API,以实测为准 | 开放标准,有官方 TS 库 `@agentclientprotocol/sdk`(client 侧 fluent API)与兼容性测试套件 | CLI 帮助 |

`run --format json` 是最低成本的冒烟路径(装好 CLI 就能验证事件投影和工具卡片渲染),但缺交互审批,不适合作为产品路径;ACP 是"去掉网络服务化"后的完整替代;serve 保留的唯一硬优势是**执行生命周期独立于 Worker 连接**。

## 4. 建议

1. **阶段 1(新项目试点)改走 ACP**:适配器 = 进程监管 + `@agentclientprotocol/sdk` client + `session/update → 产品事件`投影。可删除原方案 §2 的端口转发/凭据管理和 §4.1 的提交幂等指纹、补读、待审批对账三条最重的链路。同机场景 spawn 子进程即可,与"安装官方 CLI、无需 Nova Runner"的目标一致。
2. **阶段 2 放行条件需要重新措辞**:"审批期间 Worker 重启"在 ACP 下意味着该 Run 被中断、由接管方 `session/load` 回放对账后引导用户继续,而不是存续执行无缝续跑。若产品坚持"执行必须挺过 Worker 故障",保留 serve 路径作为该场景的升级方案,两条路共用同一套投影与 Run 结算代码;若可接受"中断 + 回放恢复",ACP 一路走到底。
3. **冒烟验证**可先用 `opencode run --format json --auto` 打通投影,再切 ACP 加审批。
4. 原方案 §4 的事件映射表、§5 Skills 兼容矩阵、§6 的阶段划分仍然成立,可平移:只需把"OpenCode 2 来源"一列从 `session.*` 事件名换成对应 ACP 方法/`sessionUpdate` 类型。

## 5. 待验证清单

- 2.4.x(原方案验证版本)与 2.0.25(本地实测)的 ACP 差异:增量粒度(`delta`/`messageId`)、`usage_update` 的会话累计口径、`configOptions` 中 model 是否允许客户端设置及鉴权。
- 同一 ACP 进程多会话并发:是否支持不同 `cwd`(`additionalDirectories` 能力的语义),还是需按项目目录各起一个进程。
- 显式 Skill 选择随 ACP prompt 提交的表达(`available_commands` 是否覆盖 skills、`_meta` 扩展)。
- 审批挂起语义:opencode 在 `request_permission` 等待期间 prompt 请求是否阻塞、Worker 可否安全把 Run 置 waiting 并落库。
- `plan` 模式对写入/shell 的实际拒绝行为(原方案"Plan 限制应由执行端权限落实"在 ACP 下的等价验证)。
- QuestionTool(`OPENCODE_ENABLE_QUESTION_TOOL=1`)与 Nova 单个问题交互契约的映射。
- Windows 下进程监管细节:stdin 关闭退出是否可靠、崩溃后 stderr 日志采集(`--print-logs`)。

## 参考

- OpenCode v2《CLI 命令》《Web》《ACP Protocol reference》(opencode.ai/docs)
- Agent Client Protocol 规范与 schema(agentclientprotocol.com),官方 TS 库 `@agentclientprotocol/sdk`
- Zed ACP Registry 已收录 "OpenCode V2"(zed.dev/acp/agent/opencode-v2)
- 本地实测:Windows,opencode v2.0.25,`initialize` / `session/new` / `session/load` 握手(2026-11-24)
