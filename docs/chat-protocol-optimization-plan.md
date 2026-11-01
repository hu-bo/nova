# Chat 协议重构方案：统一接口与最小持久化

修订日期：2026-10-14。状态：核心协议与可靠状态已实施；验证记录见文末。

本版替换上一版方案：一次性重构，统一 `/api/...`，保持代码精简。公共协议不增加版本路由、版本协商、旧 DTO 兼容层或双协议 projector。历史数据若需要保留，用一次性数据迁移处理；不因此长期保留旧代码，也不自行清空数据库。

核心目标：前端、server、Harness 的消息关联一致，过程信息不丢失，快照可继续消费事件，同后端能从可靠状态继续执行；其他 Harness 通过小型适配器接入。

默认方案新增业务表数量为 **0**。先扩展现有 `conversations / messages / runs / pending_inputs / ui_events / jobs`，只有真实查询或业务需求出现时再拆表。

## 1. 必须收敛的设计

| 项目            | 本期决定                                                              |
| --------------- | --------------------------------------------------------------------- |
| HTTP 路径       | 统一 `/api/conversations`、`/api/runs` 等，无版本前缀                 |
| 公共协议版本    | 单一当前 schema，不发送 protocolVersion，不做版本协商                 |
| 旧 API / DTO    | 直接替换调用方，删除旧入口和兼容分支                                  |
| 产品消息 schema | 在现有 `@nova/agent-ui-contracts` 中集中维护                          |
| 原生上下文      | 保留 Harness 自己的结构，完整存入 checkpoint；不从展示文本重建        |
| 运行状态        | 使用现有 runs，新增有明确结构的 checkpoint / projection JSONB         |
| 附件            | 引用和展示信息嵌入 message block，不默认新增 resource 表              |
| 用户交互        | 保存在所属 run 的 checkpoint，API 明确携带 runId                      |
| 工具执行        | 可靠 intent/result 记录保存在 checkpoint，UI 状态从它投影             |
| 幂等            | 由原业务实体、事务锁、唯一约束和 jobs.dedupeKey 实现                  |
| Harness 接入    | server 中一个小型 port + Nova adapter，不新建框架或微服务             |
| 扩展            | 先支持现有功能；可选 custom block 有 fallback，不建设通用插件注册平台 |

精简的原则是减少重复事实源、派生字段和无实际用途的层。私有 checkpoint、执行 intent、interaction 回应、事务 fence 和事件游标承担真实恢复责任，不能因不拆表而省略。

## 2. 开源依据

本方案基于前期核对的公开一手文档、Pi 源码和本仓库代码。以下是借鉴原则，不代表各项目遵守同一种 JSON，也不代表已完成实际集成。

| 来源                                                                                                                                                                                       | 借鉴原则                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| [AG-UI Events](https://docs.ag-ui.com/concepts/events)、[Messages](https://docs.ag-ui.com/concepts/messages)                                                                               | 结构化消息、工具关联、生命周期与完整快照                            |
| [ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)、[Content](https://agentclientprotocol.com/protocol/v1/content)                                                 | 一次运行包含多消息和工具；内容、权限交互、取消分开                  |
| [Pi Agent](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/agent/README.md)、[types](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/agent/src/types.ts) | 原生 context 和展示转换边界明确，steering 与 follow-up 生效时机不同 |
| [LangGraph Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)                     | checkpoint 保存执行状态，恢复需考虑步骤重新执行                     |
| [Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview)                                                                                                                   | 执行环境、上下文和人机交互可组合，复杂能力按需接入                  |
| [OpenCode SDK](https://docs.opencode.ai/docs/sdk/)                                                                                                                                         | 保留后端原生 session 引用，由适配器映射消息和控制操作               |

统一 wire contract 不意味着 checkpoint 可以跨后端无损迁移。transcript 可作为重建新上下文的素材；同后端连续执行使用完整原生状态。

## 3. 哪些表不新增

### 3.1 原方案五张新增表全部改为按需

| 原拟新增表       | 本期决定 | 当前替代                                                                       | 以后何时需要                                                         |
| ---------------- | -------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| resources        | 不新增   | message block 中附件引用和可见元数据；对象存储保存文件                         | 独立文件库、跨消息共享权限、处理状态、独立删除/检索/审计成为正式功能 |
| runtime_sessions | 不新增   | runs.checkpoint 保存原生状态；conversation 保存最新有效 checkpoint 的 run 引用 | 多个并行原生 session 或独立生命周期                                  |
| interactions     | 不新增   | runs.checkpoint.interactions 有界集合；按 runId 定位                           | 跨 run 审批中心、独立 SLA/报表、全局待办查询                         |
| tool_operations  | 不新增   | runs.checkpoint.executions 保存 intent、结果、attempt、未知状态                | 高频跨 run 查询、独立操作审计/核对、JSONB 更新成本实测过高           |
| command_receipts | 不新增   | 创建/输入按 key 去重；交互保存已接受响应；cancel 自然幂等；job 去重            | 必须跨业务重放全部历史 HTTP 回执，或实体保留期不足                   |

精简的是物理存储，不删除对应语义。不要把记录放入进程内 Map 后宣称支持重启恢复。

### 3.2 最小存储分工

| 现有表         | 保留责任                                        | 必要变化                                                                          |
| -------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| conversations  | 用户归属、项目、标题、epoch、活动 run、当前配置 | metadata 使用明确 schema，保存 latestCheckpointRunId；不新增 backend binding 实体 |
| messages       | 已完成的产品消息与附件引用                      | 加 runId、稳定 message sequence、消息终态；blocks 统一 schema                     |
| runs           | 生命周期、deadline、lease、fence、revision      | 加 checkpoint / projection；budget 仅保存限制                                     |
| pending_inputs | 输入接受、排序、撤回、消费、去重                | 有类型 payload；保存消费后的 run/message 关联，reserve 后不提前 consumed          |
| ui_events      | 可重放事件                                      | sequence 端到端 bigint/string；事件和对应投影同事务更新                           |
| jobs           | 唤醒、恢复、到期核对、清理                      | 复用 dedupeKey，不创建另一套任务引擎                                              |

runs.checkpoint 是可靠执行状态的 owner，runs.projection 是执行事实和已接受事件的 UI 投影，二者从同一事实提交。不能各自独立宣告工具成功。

### 3.3 checkpoint 生命周期

1. 新一轮加载 latestCheckpointRunId 指向的同 backend、同 epoch 状态。
2. 新 run 继承原生对话上下文，当前 execution/interaction 集合从明确初始状态开始。
3. checkpoint 确认提交后，同事务更新 latestCheckpointRunId。
4. waiting/paused 恢复使用原 run，不再次插入原始 user 输入。
5. clear/backend change 创建新 epoch 并清除当前 checkpoint 引用；旧 messages 保留展示。
6. 清理 runs 不能删除仍被引用或仍需恢复/核对的 checkpoint。

每个 run 保存完整上下文有一定复制成本。本期以有界上下文和压缩控制，实测成为瓶颈再拆 session/context 存储。普通 token delta 只更新小型 projection，不重写完整 checkpoint。

## 4. 有云存储是否还需要 resource 表

**当前只有聊天附件时，不需要额外 resource 表。** 云存储负责对象内容，消息行负责引用关系；归属通过 conversation.ownerUserId 判断。

S3 支持对象元数据及 HEAD 检查，可用于上传完成和读取核验。[S3 metadata](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html)、[HeadObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html)。这不替代会话授权、引用关系和必要内容校验。

### 4.1 附件结构

```ts
type Id = string;

type FileRef =
  | { kind: "object"; key: string; versionId?: string }
  | { kind: "runner"; runnerId: Id; workspaceId: string; path: string }
  | { kind: "ssh"; remoteConnectionId: Id; path: string };

interface Attachment {
  ref: FileRef;
  name: string;
  mimeType: string;
  size?: number;
  sha256?: string;
}
```

- 不加 resourceId、resource.revision、资源表状态或文件级 owner。
- object 表示对象存储，换 MinIO/S3/其他厂商只换 storage adapter。
- key 是服务端生成的稳定标识；bucket、endpoint、credentials 保持私有配置。
- name/mimeType 用于显示；size 已知时提供，sha256 用于实际变化检测或完整性验证。
- versionId 仅在实际使用对象版本时提供；否则采用不可覆盖的新 key。
- Runner/SSH 文件是工作区引用，不默认全部复制到云存储。

### 4.2 附件流程

```text
请求上传票据 / 选择工作区文件
  → 服务端生成或验证引用
  → 实际上传与内容核验
  → 接受输入并保存 Attachment block
  → 下载时校验 conversation/message/block 归属
  → 返回授权内容或短期 URL
```

上传完成不能只信任浏览器提供的 size/MIME/hash。授权以服务端归属和已接受引用为准，key 前缀检查不能充当全部授权逻辑。

上传未绑定消息时，用短期签名票据证明 owner、key、限制和有效期，或复用上传后端已有登记能力；不强制增加通用资源目录。孤儿清理须核对 pending input、消息和可恢复 checkpoint，不能误删已引用对象。

历史上下文保存当时实际读取的文本、原生文件句柄或不可变版本；不能用已经变化的工作区文件替换此前输入。大文件按需要固化到对象存储，附件不一律复制。

**当前实现：** UploadStorage 默认关闭，端点不会返回占位 URL 或伪造验证成功；真实云存储需要配置并实现既有 upload-storage adapter。

## 5. 精简后的公共协议

### 5.1 消息与内容块

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface PublicError {
  code: string;
  message: string;
  recovery?: "retry" | "reconfigure" | "inspect";
}

type Content =
  | { id: Id; type: "text"; text: string }
  | { id: Id; type: "thinking"; text: string }
  | { id: Id; type: "image" | "file"; attachment: Attachment }
  | { id: Id; type: "code"; language: string; code: string; path?: string }
  | { id: Id; type: "diff"; path: string; diff: string }
  | { id: Id; type: "error"; error: PublicError }
  | { id: Id; type: "custom"; name: string; data: JsonValue; fallback: string };

type Block =
  | Content
  | { id: Id; type: "tool_call"; callId: Id; name: string; args: JsonValue }
  | {
      id: Id;
      type: "tool_result";
      callId: Id;
      operationId: Id;
      outcome: "succeeded" | "failed" | "cancelled" | "denied" | "unknown";
      content: Content[];
    };

interface Message {
  id: Id;
  runId: Id | null;
  sequence: string; // 消息创建顺序，十进制 bigint
  role: "user" | "assistant" | "tool" | "system";
  state: "streaming" | "completed" | "failed" | "cancelled";
  blocks: Block[];
  createdAt: string;
  source?: { agentId: string; parentRunId?: Id };
}
```

- conversationId 来自 API/snapshot 容器，组件需要时由宿主传入。
- inputId 不重复到每条消息，由 pending_inputs 保存消费关联。
- 用户输入仅允许 text/image/file；不能自报 role、source 或执行者身份。
- 已完成消息不可追加，一轮可以有多条 assistant/tool message。
- block ID 稳定且在消息内唯一；callId 是逻辑调用，operationId 是执行尝试。
- Content 不含工具调用/结果，避免递归执行块和过深 schema。
- 工具状态从 operation 派生，不在 tool_call 保存第二份状态。
- 公共 system 只用于允许显示的通知；原生 prompt、签名和私有 metadata 留在 checkpoint。
- 保留现有 thinking/tool 类型名称，避免无语义价值的改名。
- TodoPanel/GoalPanel 使用有类型独立投影；custom 仅承担额外显示，不能修改执行状态。

### 5.2 操作与日志

```ts
interface OutputTail {
  text: string;
  startOffset: number;
  nextOffset: number;
}

interface ToolOperation {
  id: Id;
  callId: Id;
  messageId: Id;
  blockId: Id;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "denied" | "outcome_unknown";
  attempt?: number;
  stdout?: OutputTail;
  stderr?: OutputTail;
  error?: PublicError;
}
```

runId 从所属 run 投影获得；实际重试才提供 attempt。公开结果内容在 tool message 中，不在 operation 再复制一份。

文本与日志 offset 统一为 UTF-16 code unit，与 JS string.length 一致。跨语言适配器在边界转换；体积限制仍按 UTF-8 字节计算。startOffset > 0 可派生截断状态，nextOffset 保留原始公共流位置；裁剪保持完整 Unicode 字符。

### 5.3 交互

```ts
interface InteractionBase {
  id: Id;
  revision: number; // 回填有并发校验，保留
  state: "pending" | "resolved" | "expired" | "cancelled";
  expiresAt?: string;
  callId?: Id;
}

type Interaction =
  | (InteractionBase & {
      kind: "approval";
      toolName: string;
      args: JsonValue;
      risk: "read" | "write" | "exec";
      allowedScopes: ("once" | "session")[];
      codeChanges?: { path: string; oldText: string; newText: string }[];
    })
  | (InteractionBase & {
      kind: "question";
      question: string;
      options: { id: string; label: string }[];
      multiSelect: boolean;
      allowCustom: boolean;
    });

type InteractionResponse =
  | { kind: "approval"; decision: "allow" | "deny"; scope: "once" | "session" }
  | { kind: "question"; optionIds: string[]; customText?: string };
```

runId 在路径和 run 投影中明确，不在每个 interaction 重复。一个交互对应一个问题，多问题通过多条交互表达，不增加 questionId 层。approval 类型已确定 allow/deny，不再发送 allowedDecisions。

已接受 response 保存到 checkpoint；重复相同回应返回现有状态，不重复恢复；不同回应或旧 revision 返回冲突。期限缺省表示无期限。答案不再伪装成 modify。

### 5.4 Run、输入、配置和能力

```ts
type RunState =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "cancelled_unconfirmed";

interface RunView {
  id: Id;
  state: RunState;
  reason?: string;
  waiting?: "interaction" | "external";
  error?: PublicError;
}

interface Configuration {
  backendId: string;
  modelId: string | null;
  mode: string; // 本期 build/plan，由后端 allowlist 校验
  reasoningEffort?: string;
  remoteConnectionId?: Id;
}

type InputBlock = Extract<Content, { type: "text" | "image" | "file" }>;

interface SubmitInput {
  blocks: InputBlock[];
  mode: "next_run" | "steer";
  configuration?: Configuration;
}

interface InputReceipt {
  id: Id;
  state: "queued" | "consumed" | "removed" | "rejected";
  runId?: Id;
  messageId?: Id;
}

interface Capabilities {
  tools: boolean;
  approval: boolean;
  question: boolean;
  steering: boolean;
  resume: boolean;
  compact: boolean;
  images: boolean;
  files: boolean;
}
```

- 请求 schema 严格接受 text/image/file 子集。只有附件也可以提交，空输入拒绝。
- 不新增 clientMessageId，复用当前 CommandIntent 的 idempotency-key。
- queued 顺序由 pendingInputs 数组表达，需要显示数字时才提供其 sequence。
- consumed 必须表示 checkpoint 确认纳入上下文，不能仅表示读出了队列。
- run 创建时固化 configuration，steer 不改变活动 backend/model/environment。
- 复用项目 Runner binding 和 remoteConnectionId，不新增环境实体。
- backendId 决定 modelId/mode 的校验与映射，不再额外建立 ModelSelection.source。
- 能力由后端、模型、权限和环境求交集；命令服务端重新校验，不加 capabilities.revision。
- plan 的只读约束由执行策略保证；私有 phase/fence/workerId/lease/revision 不进入 RunView。
- goal 保留有类型字段和独立用例；目标完成与单轮 succeeded 分开。

### 5.5 字段精简清单

| 字段 / 结构                                                  | 决定             | 理由                                          |
| ------------------------------------------------------------ | ---------------- | --------------------------------------------- |
| protocolVersion / contractVersion / API version              | 删除             | 单一协议，同步替换调用方                      |
| JSON eventId                                                 | 删除             | SSE id 由会话和 sequence 派生                 |
| event.conversationId                                         | 删除             | 订阅连接按会话隔离                            |
| event.occurredAt                                             | 默认不发送       | journal 保留时间，message 有 createdAt        |
| message.conversationId / operation.runId / interaction.runId | 从容器获得       | 避免嵌套对象重复身份                          |
| Message.actor                                                | 改为可选 source  | role 已表达参与者类别                         |
| message.inputId                                              | 删除             | 队列保存消费关联                              |
| message.completedAt                                          | 删除             | 当前没有单独显示需求                          |
| message/block/operation/usage revision                       | 公共协议删除     | 有序 journal、不变完成消息、显式 reset/upsert |
| interaction/goal revision                                    | 保留             | 回答和目标修改存在并发、过期与重复提交        |
| runs.revision / fence                                        | 私有保留         | CAS、防旧 worker 写入                         |
| resourceId / resource.revision                               | 删除             | 使用稳定 FileRef，无资源目录                  |
| 分散 schemaVersion                                           | 不新增           | 当前单次重构；checkpoint 后续格式升级集中处理 |
| 任意 metadata/options                                        | 不默认提供       | 只增加实际字段或 custom 内容                  |
| diff.added/removed                                           | view 派生        | 不重复维护统计事实                            |
| output.truncated                                             | startOffset 派生 | 不重复保存截断标志                            |
| cost、工具起止时间、恢复等级、多问题嵌套                     | 本期不加         | 真实产品需求出现再补                          |

删除公开 revision 的前提是单会话有序 journal。producer/adapter 必须用 fence、当前模型请求身份或原生 cursor 拒绝旧数据，不能把 reset 前请求的迟到 delta 作为新内容发布。

## 6. 事件与快照

### 6.1 Envelope

```ts
interface EventEnvelope<T extends string, P> {
  sequence: string;
  runId: Id | null;
  type: T;
  payload: P;
}
```

sequence 是 conversation 内全序，不等于 message.sequence 或 pending input 顺序。内部 bigint，JSON 十进制字符串。SSE id 使用 conversationId:sequence，但 JSON 不再重复 eventId。

| 事件                                         | payload                                  | 用途                                           |
| -------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| message.started                              | `{ message }`                            | 建立 streaming 消息，分配稳定 message sequence |
| block.upsert                                 | `{ messageId, block, index }`            | 新增或完整替换 block，位置明确                 |
| text.delta                                   | `{ messageId, blockId, offset, text }`   | text/thinking 追加，不修改已经完成的消息       |
| text.reset                                   | `{ messageId, blockId, text }`           | 重试后明确替换文本，producer 已拒绝旧请求      |
| message.committed                            | `{ message }`                            | 使用相同 ID 提交完整消息，结束该消息草稿       |
| tool.changed                                 | `{ operation }`                          | 操作状态完整替换，含现有日志 tail              |
| tool.output                                  | `{ operationId, channel, offset, text }` | stdout/stderr 追加                             |
| run.changed                                  | `{ run }`                                | 完整 RunView                                   |
| interaction.changed                          | `{ interaction }`                        | 请求/回应/过期/取消的实体状态                  |
| input.queued / consumed / removed / rejected | `{ input, error? }`                      | 输入状态和接受内容，由共享 schema 表达         |
| context.changed                              | `{ epoch, action }`                      | clear/compact/backend change，保留历史消息     |
| plan.changed / goal.changed                  | `{ plan }` / `{ goal }`                  | 当前已有产品功能的完整投影                     |
| usage.changed                                | `{ usage }`                              | 已知 token/上下文使用量；未知值缺省            |

工具结果只通过 tool message 提交，不再复制一套独立 tool.result event 内容。工具参数先在适配器内完整构造，再 upsert tool_call；没有当前产品需要时不增加公共参数 delta 协议。

### 6.2 核心规则

1. SSE 连接只归一个 conversation 和用户 identity，切换身份销毁旧连接/状态。
2. sequence <= cursor 忽略；sequence != cursor + 1 则停止应用并取 snapshot。
3. message.started 先于 block/delta；block ID 在快照和最终提交中稳定。
4. delta.offset 必须匹配目标字符串长度；不匹配触发有界重同步。
5. reset 只来自当前请求/尝试。原生 cursor、模型请求 token、run fence 负责拒绝旧 producer。
6. message.committed 是完成消息的权威内容，覆盖同 ID 草稿；不能再追加。
7. tool.changed 足够独立建立操作；tool.output 需要已知操作及正确 channel offset。
8. 相同 native 消息重复到达时在适配器按原生身份和已接受内容归并，不能重复创建产品 message。
9. 未知 custom 内容显示 fallback；未知核心事件报告不兼容，不无限重取同一快照。
10. 单一 resync owner，退避重试；401/403 与暂时不可用、cursor 过期分别处理。

### 6.3 Snapshot

```ts
interface Snapshot {
  conversation: {
    id: Id;
    title: string | null;
    mode: "chat" | "project";
    projectId: Id | null;
    epoch: number;
    configuration: Configuration;
  };
  cursor: string;
  messages: Message[]; // 最近一页完成消息和所有当前 streaming 消息
  beforeSequence: string | null;
  run: RunView | null;
  operations: ToolOperation[];
  interactions: Interaction[];
  pendingInputs: (InputReceipt & { input: SubmitInput })[];
  plan?: Todo[];
  goal?: Goal;
  usage?: { inputTokens?: number; outputTokens?: number; contextUsed?: number; contextLimit?: number };
  capabilities: Capabilities;
}

interface Todo {
  id: Id;
  text: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
}

interface Goal {
  objective: string;
  acceptanceCriteria: string;
  maxIterations: number;
  iterations: number;
  status: "ready" | "active" | "paused" | "completed";
  revision: number;
}
```

plan/goal 复用已有有类型定义；goal 的 revision 保留用于用户修改的并发校验。messagePage 和 draftMessages 合为 messages，按 ID 去重、sequence 排序；分页游标只针对已完成历史，不包含尚未完成的消息。

必须满足：

```text
同一范围的 Snapshot(C)
  == 从 journal 连续应用到 C 的投影

Snapshot(C) + 后续事件
  == 后续时刻的同范围 Snapshot
```

范围包括当前 run、live messages、关联 operation 和日志偏移、待交互、输入队列、已有 plan/goal/usage。更早历史独立分页，不因为最新快照只有一页就删除已加载历史。历史分页附带相关 operation 摘要或从 tool result 派生最终状态。

server 在主库短 REPEATABLE READ 事务中读取 head 和投影；接受事件时同事务更新 journal、投影、event head。server 和 client 共用一个纯 applyEvent，删除 server 手写 draft 更新与 client 手写 block 校验的重复实现。

日志尾部裁剪规则相同，活动/未知操作不能静默丢失。文本可按约 50–100 ms 合并，不能跨 message/reset/commit/interaction 边界；缓冲有上限。浏览器断线不取消 run，SSE cursor 过期返回 410。retention 必须实际实现，不能只写在注释中。

## 7. 最小运行边界与可靠恢复

### 7.1 私有 checkpoint

checkpoint 是有类型的私有结构，不进入公共消息；外部后端也可只保存原生 session 引用和核对水位。

```ts
import type { ExecutionRecord } from "@nnova/harness";

interface Checkpoint {
  backendId: string;
  epoch: number;
  configuration: Configuration;
  nativeState: JsonValue; // 由适配器验证；完整上下文或原生 session 引用
  executions: ExecutionRecord[]; // 演进现有类型，包括确认的 intent/result
  interactions: (Interaction & { response?: InteractionResponse })[];
  continuation?: JsonValue;
}
```

nativeState/executions 不是任意用户 JSON。Nova 实现复用 Harness 的 AgentMessage/SessionSnapshot/ExecutionRecord；序列化时明确哪些字段由 executions/continuation 保存，再在加载时还原，避免重复持有独立执行记录。后端原生字段以该后端 schema 校验。

公用 private revision 由 runs.revision 提供，数据库 CAS 和 fence 一起核对。对话最新有效 checkpoint 指针与提交同事务更新。控制命令与 checkpoint 提交发生冲突时重新读取状态，不能盲目重放副作用。

projection-only 的 token/log 写入不推进 checkpoint CAS revision，避免每个增量让运行状态提交发生虚假冲突；仍需校验有效 run/fence。heartbeat 不代表新的执行 checkpoint。

预算、执行记录、日志、交互各有明确结构；不继续把所有 JSON 塞进 budget。execution/interaction 集合按当前 run 的限制有界；旧上下文中的工具结果保留在原生消息中，不要求无限保留全部过往执行 attempt。

### 7.2 一个小型适配 port

```ts
// RuntimeEvent 从共享 ProductEvent schema 推导并去掉 sequence；
// 实际实现只允许 adapter 提交的消息/工具/交互/usage payload 子集。
type RuntimeEvent = ProductEvent extends infer E
  ? E extends { sequence: string }
    ? Omit<E, "sequence">
    : never
  : never;

interface RuntimeCommit {
  checkpoint?: Checkpoint;
  events?: RuntimeEvent[];
  consumedInputIds?: Id[];
}

type RuntimeOutcome =
  | { kind: "completed"; state: "succeeded" | "failed" | "cancelled" | "timed_out"; error?: PublicError }
  | { kind: "waiting" | "paused"; reason?: string };

type ResolvedFile =
  | { kind: "text"; text: string }
  | { kind: "binary"; mimeType: string; bytes: Uint8Array }
  | { kind: "native"; handle: JsonValue };

type RuntimeCommand =
  | { kind: "start"; input: SubmitInput }
  | { kind: "resume"; interactionId: Id; response: InteractionResponse }
  | { kind: "recover" };

interface RuntimeContext {
  runId: Id;
  signal: AbortSignal;
  checkpoint: Checkpoint | null;
  commit(batch: RuntimeCommit): Promise<void>;
  resolveFile(ref: FileRef): Promise<ResolvedFile>;
}

interface RuntimeAdapter {
  execute(command: RuntimeCommand, context: RuntimeContext): Promise<RuntimeOutcome>;
  cancel(runId: Id): Promise<"confirmed" | "unknown">;
  dispose(): Promise<void>;
}
```

RuntimeCommit 是 checkpoint、共享事件 payload、已消费输入 ID 的确认提交批次；RuntimeOutcome 表示 completed/waiting/paused。ResolvedFile 是已授权的文本、二进制或原生句柄。它们是 server 私有 port 辅助类型，不再另建一套 message/block/interaction。

Nova adapter 组装 configured model、远程工具、policy 和 CodingHarness；ConversationExecutor 保留 run 驱动、goal 编排和终态处理。registry 只需要 backendId → adapter factory 的 Map，不建通用插件引擎。

公共 journal sequence、授权、队列和 run 资格由 Nova 管；后端自身的 context、模型消息和 continuation 由对应 adapter/state owner 管。模型供应商适配与完整 Harness 适配有不同责任，但不增加无实际行为的转发层。

dispose 只释放当前 adapter 的本地连接和订阅，不删除持久化 session，不把 waiting run 的原生状态清空。多个原生模型步骤可以属于同一个 Nova run，ID 映射不能假设二者一对一。

### 7.3 必要的底层调整

- SessionStore 的 load/commit 提供可等待确认；内存实现同样采用异步契约。
- BasicLoop 保存完整模型消息、待执行调用、结果与 continuation，并等待可靠提交。
- ToolPolicy 支持 ask；ToolRuntime 将待执行调用和交互保存为可恢复等待，不挂起永久轮询 Promise。
- SessionHandle 从 checkpoint 初始化 waiting，恢复后不再插入原输入。
- AgentEvent 暴露 message/block/call/operation 必要关联，不能只给最后 result.text。
- emit(event) 保持同步 void；onEvent/onDiagnostic 保持观察用途。持久化插件同步复制事件到有界缓冲，由后台写入器或显式 flush 排空，不在 emit 中等待 I/O。
- session-checkpoint-policy 不保存状态，在 agent/pre-step、llm/stream、tools/execute 三个边界等待 sessionPersistence.flush；失败阻止后续派发。工具等待 flush 时取消返回 ABORTED_BEFORE_DISPATCH，属于明确未派发。
- 私有状态和公开 committed facts 在持久化 provider 同事务提交；观察者不能再次发布同一事实。
- 同步 inspect 不强转异步 store；需要 authoritative 数据的调用改为异步。

### 7.4 提交顺序

```text
接受输入、创建 run
  → claim/fence
  → 模型请求
  → 完整 assistant 消息和待执行调用确认提交
  → 若需要交互：保存 continuation、进入 waiting、释放 worker 槽位
  → 回应保存 + dedupe resume job
  → 恢复并取得有效执行权
  → 工具 intent/幂等键确认提交
  → 实际执行
  → 确定结果或未知结果确认提交
  → 下一模型步骤
  → 消息及 run 结束
```

网络请求和用户等待在事务外。waiting 释放 worker 槽位，但保留单会话活动 run 资格。已确认工具结果复用；明确未派发可派发；派发后无确定回执的副作用进入 outcome_unknown，不能自动重跑。

取消接受先进入 cancelling，确认停止才 cancelled；无法确认则 cancelled_unconfirmed。未确认操作所属环境要在后续副作用准入时核对，不能清空 activeRunId 后忘记风险。可以先查询相关 runs 的有界 checkpoint，真实需要高频全局核对时再拆 operation 表。

原生后端与 Nova 数据库不能假设跨系统同事务，按原生身份/水位核对；没有持久化恢复能力时明确报错，不把内存 resume 描述成重启恢复。

### 7.5 幂等无需通用收据表

| 操作             | 最小可靠实现                                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| 创建对话         | 当前 owner advisory lock + creationKey/payload 校验；查询字段需要时补唯一索引 |
| 提交输入         | 会话锁 + key/payload 去重，保留接受结果和消费关联                             |
| 回答交互         | run 锁、interaction revision、保存 response；相同回应复用结果                 |
| cancel           | 同一 run 已取消/取消中返回现有状态，不依赖 activeRunId 必须存在               |
| resume           | checkpoint 条件 + jobs.dedupeKey，重复请求不重复派发                          |
| clear / 配置变更 | 明确当前 epoch/state 条件；旧请求重试返回现有结果或冲突，不再次变更           |

不承诺所有历史命令都无限期原样重放 HTTP 回执，但必须保证重试不会重复应用副作用。需要统一长期回执留存时再建立 command_receipts，不能仅用内存缓存。

## 8. 统一 API 与生成链路

| 路径                                                                   | 用途                                   |
| ---------------------------------------------------------------------- | -------------------------------------- |
| GET /api/config                                                        | 可选 backend、模型目录和实际能力       |
| POST /api/conversations                                                | 创建对话，可同事务接受首条输入         |
| GET /api/conversations                                                 | 有界对话列表                           |
| PATCH/DELETE /api/conversations/:id                                    | 标题/删除等管理入口                    |
| GET /api/conversations/:id/snapshot                                    | 统一 Snapshot                          |
| GET /api/conversations/:id/messages                                    | beforeSequence 分页                    |
| POST /api/conversations/:id/inputs                                     | 提交 blocks、mode 和可选 configuration |
| DELETE /api/conversations/:id/inputs/:inputId                          | 撤回 queued 输入                       |
| GET /api/conversations/:id/events                                      | 会话 SSE，cursor/Last-Event-ID         |
| PATCH /api/conversations/:id/configuration                             | 空闲时更新运行配置                     |
| POST /api/conversations/:id/context/clear 或 compact                   | 上下文操作，按能力执行                 |
| POST /api/runs/:runId/cancel 或 resume                                 | 控制已有 run                           |
| POST /api/runs/:runId/interactions/:id/resolve                         | 按 run 点查，无需全局 interaction 表   |
| POST /api/uploads，POST /api/uploads/complete                          | 复用附件模块的真实上传链路             |
| GET /api/conversations/:id/messages/:messageId/blocks/:blockId/content | 下载消息附件，直接验证关联             |

rename/goal 等现有动作保留用例并统一前缀，不另建兼容路由。项目/Runner/模型配置等现有业务 API 也去掉版本前缀；admin 独立权限 scope 保持。

成功保留现有 `{ code: 200, message, data }` 解包方式；业务失败统一真实 4xx/5xx + 错误信封。删除 HTTP 200 表示业务失败的特殊序列化绕行，不为新旧 API 保留两套错误行为。

共享 schema 使用 Zod 4，server compiler 升级到匹配的已验证版本并锁定依赖。[官方兼容表](https://raw.githubusercontent.com/turkerdev/fastify-type-provider-zod/main/README.md)。这项依赖对齐是复用 schema 的前置，不同时迁移 Fastify/ORM/auth。

OpenAPI 继续从 server 导出，Orval 继续生成客户端。保持当前可用的内联导出方式，不为本期新增 named component/ref 自定义解析层；如实际工具链要求 refs 再解决具体问题。生成物不手改，现有业务 DTO 只在需要表达请求/响应时存在。

## 9. 文件改动清单

路径相对仓库根目录。新增仅限有具体职责的文件；删除当前协议重复和兼容层。不新增五张业务表对应 schema、resource service/routes、独立 runtime repository、通用 command-receipts helper。

### 9.1 共享协议

| 文件                                                   | 变更                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| packages/agent-ui-contracts/src/common.ts              | 新增公共 ID/JSON/error/FileRef 基础 schema；小型定义可合并到 messages.ts |
| packages/agent-ui-contracts/src/messages.ts            | 新增 canonical Message/Block/输入子集                                    |
| packages/agent-ui-contracts/src/interactions.ts        | 新增交互/回应 schema                                                     |
| packages/agent-ui-contracts/src/runtime.ts             | 新增 RunView/operation/configuration/capabilities                        |
| packages/agent-ui-contracts/src/conversation.ts        | 新增 Snapshot/输入/现有 Goal/Todo 投影与命令 schema                      |
| packages/agent-ui-contracts/src/events.ts              | 直接替换为唯一事件协议                                                   |
| packages/agent-ui-contracts/src/projection.ts          | 新增纯 applyEvent/snapshot 初始化/裁剪规则                               |
| packages/agent-ui-contracts/src/events-v2.ts           | 删除，不保留 parallel contract                                           |
| packages/agent-ui-contracts/src/index.ts、package.json | 导出、依赖和统一验证入口                                                 |

不再分别新建 capabilities.ts、commands.ts、runs.ts、snapshots.ts 等细碎定义文件。API/事件/投影复用同一 schema；chat-ui 保留实际需要的展示 view。

### 9.2 Server 与数据库

| 文件                                                                                                   | 变更                                                                 |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| apps/nova-server/src/app.ts                                                                            | 所有当前业务路由统一 /api，去掉双注册和版本 module 特例              |
| apps/nova-server/src/plugins/errors.ts、openapi.ts                                                     | 一套 HTTP 错误行为及如实文档                                         |
| apps/nova-server/src/modules/conversations/conversation.schema.ts                                      | 复用共享 schema，不复制 message/block                                |
| apps/nova-server/src/modules/conversations/conversation.routes.ts、service.ts、repository.ts、index.ts | 新请求、输入关联、最新 checkpoint 指针、完整 snapshot 和分页         |
| apps/nova-server/src/modules/runs/run.schema.ts、run.routes.ts、index.ts                               | 新 RunView、按 run 定位的交互和控制                                  |
| apps/nova-server/src/modules/runs/run.service.ts                                                       | 有实际用例责任时新增；承载授权/状态/恢复命令，route 不编排 SQL       |
| apps/nova-server/src/modules/runs/run.repository.ts                                                    | checkpoint、projection、journal 原子提交、锁/fence、幂等             |
| apps/nova-server/src/modules/runs/runtime-adapter.ts                                                   | 新增小型 port 和 factory Map，不建单独 workspace 包                  |
| apps/nova-server/src/modules/runs/nova-runtime.ts                                                      | 新增 Nova adapter，移入 Harness 组装与原生转换                       |
| apps/nova-server/src/modules/runs/postgres-session-store.ts                                            | 新增真实持久化 provider，复用 run repository                         |
| apps/nova-server/src/modules/runs/conversation-executor.ts、execution-host.ts                          | 精简驱动、waiting 释放槽位、wake/resume/recover                      |
| apps/nova-server/src/modules/runs/configured-model.ts、ssh-tool-context.ts                             | 保留原生 metadata，实际 usage/输出和取消回执                         |
| apps/nova-server/src/modules/events/event.routes.ts、transport/sse.ts                                  | 精确 cursor、保留范围、单 serializer、有界重放                       |
| apps/nova-server/src/modules/client-config/index.ts                                                    | 返回实际有效能力，去掉协议版本字段                                   |
| apps/nova-server/src/modules/attachments/attachment.\*、upload-storage.ts                              | Attachment/FileRef、真实对象核验、按消息授权读取；不建 resource 模块 |
| apps/nova-server/src/jobs/job-host.ts、job-registry.ts、postgres-job-store.ts                          | 恢复/到期/核对、dedupe 和清理                                        |
| apps/nova-server/database/schema/run.table.ts                                                          | 新 checkpoint/projection；已有 revision/fence/deadline 保留          |
| apps/nova-server/database/schema/message.table.ts                                                      | runId/sequence/state、canonical blocks，移除重复附件字段             |
| apps/nova-server/database/schema/conversation.table.ts                                                 | metadata 类型和精确 heads；最新指针位于 typed metadata               |
| apps/nova-server/database/schema/pending-input.table.ts                                                | 有类型 payload、消费关联与持久化去重                                 |
| apps/nova-server/database/schema/ui-event.table.ts                                                     | bigint sequence/必要唯一约束，删除协议版本列；保留 DB 时间           |
| apps/nova-server/database/migrations/、meta/                                                           | 新增一次性迁移，不改已应用历史 SQL，不新增默认业务表                 |
| apps/nova-server/package.json、pnpm-lock.yaml                                                          | contracts、Zod/compiler 和 server 综合测试入口                       |
| apps/nova-server/src/modules/\*\* 的路由与 schema                                                      | 前缀/module 名称、Zod 对齐；检索所有调用方统一修改                   |

表格中 service.ts/repository.ts 等短名对应同目录的 conversation.service.ts、conversation.repository.ts；不代表新建通用横向 service/repository 目录。

### 9.3 Harness、CodingHarness、工具

| 文件                                                                           | 变更                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| packages/harness/src/contracts/session.ts                                      | async load/commit、确认结果，复用现有原生 snapshot          |
| packages/harness/src/contracts/agent.ts、event.ts、tool.ts、run.ts、model.ts   | 关联 ID、等待/恢复、ask policy、可等待输出 sink             |
| packages/harness/src/contracts/capabilities.ts、src/index.ts                   | 更新内部能力和导出，不依赖 UI 产品包                        |
| packages/harness/src/kernel/operation.ts                                       | 从 checkpoint 恢复 waiting；同步 inspect 调用改为明确异步   |
| packages/harness/src/plugins/basic-loop/loop.ts、index.ts                      | 完整多消息、continuation、可靠提交，不仅最终 text           |
| packages/harness/src/plugins/tools/runtime.ts、index.ts                        | intent/result、等待集合、确定/未知结果、call/operation 身份 |
| packages/harness/src/plugins/session-memory/index.ts                           | 异步内存实现，不声称 durable                                |
| packages/harness/src/plugins/context/index.ts、compaction/index.ts             | await store，保留工具配对和原生 metadata                    |
| packages/harness/src/plugins/model-ai-sdk/index.ts、messages.ts                | 新内部 chunk/message 映射                                   |
| packages/coding-harness/src/contracts.ts、create-coding-harness.ts、runtime.ts | 注入 store/sink，透传恢复，不通过观察者补写权威状态         |
| packages/tools/src/tools.ts、harness.ts                                        | 复用已有 Runner 输出，贯通执行身份和回执                    |
| demo/harness-api.ts、受影响 fixtures/examples                                  | 跟进异步接口和关联字段                                      |

Runner SDK/protobuf/Rust 先保持不变，只有证明已有输出/回执不够才修改。protobuf 的命名空间与 HTTP 路由不是同一版本概念，不因删除 API 前缀而重写传输协议。

### 9.4 Frontend / chat-ui / 生成物

| 文件                                                                                                                     | 变更                                                                  |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| apps/nova-client/src/features/runs/run-event-reducer.ts                                                                  | 使用共享 projection，删除手写 block 校验和公共实体重复定义            |
| apps/nova-client/src/features/runs/run-stream-manager.ts、run-runtime.tsx                                                | 单协议、完整快照、订阅 owner 和有界 resync                            |
| apps/nova-client/src/features/runs/run-controls.ts、run.commands.ts、run-panel.tsx                                       | 正确 interaction response、操作日志/终态和恢复                        |
| apps/nova-client/src/features/conversations/use-conversation-composer.ts、conversation.page.tsx、conversation.queries.ts | blocks、有效能力、输入确认和新 endpoint                               |
| apps/nova-client/src/features/conversations/conversation-export.ts、goal-panel.tsx                                       | 多消息/附件/goal 状态和 fallback                                      |
| apps/nova-client/src/features/attachments/upload-service.ts、attachment-image.tsx                                        | 稳定引用和短期 URL，复用附件模块                                      |
| apps/nova-client/src/api/sse-client.ts、transport.ts、api-error.ts、health.ts                                            | 无版本路由、统一错误/游标，不保留两套 transport                       |
| packages/chat-ui/src/types.ts、block-view.tsx、message-list.tsx、chat.tsx                                                | canonical content 的 view、稳定 block key、工具关联和 custom fallback |
| packages/chat-ui/src/decision-prompt.tsx、blocks/tool.tsx 等                                                             | 稳定选项 ID、allowedScopes、操作状态；不按后端工具名判断通用功能      |
| packages/chat-ui/package.json、scripts/boundaries.mjs                                                                    | 允许纯 contracts 类型依赖，继续禁止网络/server/runtime                |
| apps/nova-client/orval.config.ts、scripts/api-check.ts                                                                   | 仅为实际生成变化调整，不预建 refs 解析平台                            |
| apps/nova-server/openapi.json、apps/nova-client/src/api/generated/\*                                                     | 从源契约重新生成，不手改                                              |
| apps/nova-client/scripts/check-boundaries.mjs                                                                            | 禁止 client 导入 Harness 和 server adapter                            |

generated 类型重复是生成结果，不是另一套手写事实源。暂不为消除所有生成重复结构引入复杂 transformer。view 映射只有实际展示差异，不再包一层纯参数转发函数。

## 10. 实施顺序

| 阶段         | 工作                                                                | 验收                                           |
| ------------ | ------------------------------------------------------------------- | ---------------------------------------------- |
| 1 契约收敛   | 共享 schema、精简字段、Zod/compiler、统一 /api 和单错误行为         | 类型/生成一致；所有调用方切到同一接口          |
| 2 消息与快照 | 多消息、稳定 call/operation/block ID、共享 projection、精确游标     | 刷新、导出、连续事件一致，不丢中间消息         |
| 3 可靠状态   | runs checkpoint、async store、交互 suspend/resume、输入确认和 fence | 重启可恢复；结果未知不重跑；重复回应只恢复一次 |
| 4 适配边界   | Nova adapter + 第二种行为测试 adapter                               | 前端/API 不出现 backend 名称分支               |
| 5 功能回归   | 现有 goal/plan、附件、取消、目录、模型选择、实际能力                | 原有用户流程通过，删除旧协议/重复状态代码      |

不一次性创建空接口和空目录。schema 收敛不等待全部恢复功能完成，但未贯通的能力维持关闭。原资源/交互/session 独立表建设不作为本期完成条件。

迁移前核对持久化数据：能转换的消息序列/附件做一次迁移，原来已经丢失的工具顺序和 metadata 不伪造。未保存完整状态的旧活动 run 先结束或明确中断，不宣称能恢复；不在运行中切换后端或格式。

## 11. 验收与代码精简约束

| 场景                                      | 结果                                                  |
| ----------------------------------------- | ----------------------------------------------------- |
| 多轮、多次工具、并行工具                  | 消息顺序完整，callId/operationId 不混用               |
| image/file/custom                         | 支持内容可读，fallback 有效，无图片校验缺失           |
| 工具启动后刷新再收到 output/finished      | 快照含实体/offset，不反复 resync                      |
| 任意事件前缀→snapshot→后缀                | 与连续投影等价，同一历史窗口比较                      |
| 中文/emoji/日志裁剪                       | offset 一致，原流位置保留，字符完整                   |
| cursor 超出 Number 精度、重复、缺口、过期 | 精度保持，正确去重/重同步/410                         |
| approval/question、过期和重复答案         | 类型正确，允许范围校验，响应不重复派发                |
| steering/next_run                         | 按边界生效，consumed 有持久化证明                     |
| 后续轮工具与附件上下文                    | 原生信息可用，文件变化不改写历史输入                  |
| 等待时重启、intent/result 前后故障        | 继续原 run，已确认结果复用，未知副作用停止            |
| 旧 worker 迟到提交                        | revision/fence 拒绝写入                               |
| cancel 接受但远端未确认                   | 区分 cancelling 与停止确认，环境准入不忘记未知操作    |
| 慢浏览器/数据库故障                       | 有界缓冲，业务无假成功                                |
| 第二个行为不同的 adapter                  | 只增加适配实现/注册，通用 API、表、前端不增加后端特例 |
| 输入重试、不同 payload 复用 key           | 不重复消息/副作用，冲突明确                           |
| 上传/下载授权和校验                       | 服务端确认对象，按消息归属读取，签名 URL 不持久化     |
| OpenAPI/Orval/边界检查                    | 生成无漂移，chat-ui 无 transport/runtime 依赖         |

数据库提交、进程中断和 fence 用真实 PostgreSQL 与副作用计数器验证；不能只靠 mocked repository。上传真实接入时增加所选对象存储的 HEAD/内容/权限集成测试。

复用现有 Harness、CodingHarness、nova-client、chat-ui 的 typecheck/test/build/boundary 入口；contracts 与 server 增加少量整体综合测试，不为每个类型建立镜像测试。

实施结束应满足：

- 公共协议单一，HTTP 无版本前缀，旧 DTO/分支已删除。
- 默认没有新增五张业务表及其对应无实际用途的模块。
- 每类状态有明确 owner，checkpoint/projection 同事实提交。
- 公共 schema 只维护一次；内部原生消息不向 UI 泄漏。
- 前端看到的过程与实际执行一致，完整历史不通过 text 重建。
- 所有必要身份、offset、回填 revision 和私有 fence 都得到验证。
- plan、goal、文件、审批等已有流程保持可用，未实现能力不误报。
- 只有出现独立生命周期、跨实体查询或实测性能需求，才拆出新表/包。

## 12. 实施记录（2026-10-14）

核心链路已经落地：共享 Message/Block/Interaction/Run/Snapshot schema、单一事件协议与纯 applyEvent、无版本的 /api 对话接口、精确 bigint 游标、可靠 checkpoint 与工具 intent/result、waiting 释放执行槽位、同 run 恢复、输入确认和幂等、revision/fence 校验、Nova adapter 和第二种原生 session 引用 adapter 的行为测试。

本次没有新增业务表。新增迁移为 `apps/nova-server/database/migrations/0006_chat_protocol.sql`，只扩展既有表并转换历史消息与附件。旧活动 run 缺少原生状态时明确中断，无法转换的排队输入标记 rejected；旧 journal 保留至正常过期，旧 cursor 通过持久化 floor 返回 410。尚未对现有用户数据库执行迁移。

实现中有三处有实际用途的补充：

- run.changed 在创建/恢复边界可携带 configuration/capabilities，保证切换模型或环境后，事件投影与快照的配置一致。默认模型首次解析后写入 checkpoint，恢复使用同一个模型；输入幂等按原始请求校验，不受默认配置变化影响。
- 历史分页返回从 tool_result 派生的 operation 摘要，已加载历史跨刷新保留，工具状态不因分页显示为运行中。
- 排队输入改为 steer 使用单事务端点 `POST /api/conversations/:id/inputs/:inputId/steer`；本轮结束前未纳入 checkpoint 的调整明确 rejected，不重复创建输入。

检查入口：contracts、Harness、CodingHarness、chat-ui 和 nova-client 的既有测试；server 新增一套 PostgreSQL 综合测试。综合测试创建独立临时数据库并在结束后删除，使用 `TEST_DATABASE_URL` 指定具备建库权限的测试连接，未配置时明确跳过数据库测试。

```powershell
pnpm --filter @nova/agent-ui-contracts build
pnpm --filter @nnova/harness build
pnpm --filter @nova/coding-harness build
pnpm --filter @nova/agent-ui-contracts test
pnpm --filter @nnova/harness test
pnpm --filter @nova/coding-harness test
# 先设置 TEST_DATABASE_URL 为专用测试 PostgreSQL 的连接，再执行：
pnpm --filter @react-fastify-template/app-server test
pnpm --filter @react-fastify-template/app-web test
pnpm --filter @nova/chat-ui test
pnpm --filter @react-fastify-template/app-server openapi:export
pnpm --filter @react-fastify-template/app-web api:check
```

共 122 项测试通过，覆盖 journal/snapshot 等价、真实 HTTP/SSE、多轮原生工具上下文、推理与用量、审批恢复/重复回应、提交确认丢失、未知副作用不重跑、旧 fence 拒绝、输入幂等、历史迁移和第二种 adapter。未知副作用按实际 Runner/workspace 或 SSH 连接阻断后续派发，切换绑定版本不会绕过约束。已通过 nova-server/nova-client 的类型、lint 和生产构建，Harness/chat-ui/client 依赖边界检查；OpenAPI/Orval 已重新生成并检查漂移。

真实对象存储尚未配置；上传端点明确返回不可用，不再签发占位 URL 或相信浏览器的完成回执。按 conversation/message/block 授权的读取边界已接入。Nova 的 question、images、compact 保持关闭；外部结果未知时保持阻断并提供核实材料，尚未接入自动远端核对或人工结算。实际第三方 Harness 和真实对象存储集成仍需对应环境验证。

### 2026-10-15：同步事件通知与插件 checkpoint

恢复 RunExecution/ToolRuntime 的 emit(event): void，删除 OperationOptions.eventSink 和所有 await emit。新增独立 session-checkpoint-policy 插件，只调用存储插件的 flush，不持有 checkpoint 或缓冲状态。SessionStore 的数据库 load/commit 仍提供异步确认，工具 intent/result 继续在副作用前后可靠提交。

PostgreSQL session 插件通过同步 EventObserver 接收 message.started、文本/推理增量、reset 和工具输出。首个事件开启 200ms 窗口，后续事件不延后截止时间；显式 flush 取消定时等待，共用串行写入链。失败保留原批次及顺序、暂停后台写，显式 flush 重试并向调用方拒绝；批次 ID 与 journal/projection 同事务确认，提交回执丢失后重试不会重复分配序号。缓冲上限为 4MiB / 4096 个事件。原生消息提交也沿同一写入链排在其流式前缀之后，防止完成后再追加 delta。

200ms 只约束主动等待，数据库耗时可能更长。尚未 flush 的流式前缀在硬崩溃时可能丢失；完整原生消息和工具结果仍按已确认 checkpoint 恢复，未知副作用保持阻断。此处沿用现有同 run 恢复，不把它描述成 DSH 的 interruptedTurnClosers 日志修补，也不宣称外部副作用 exactly-once。

本次 52 项相关测试通过（Harness 22、CodingHarness 18、PostgreSQL/HTTP/SSE 12），覆盖三个 checkpoint 边界失败、工具派发前取消、同步返回、后台失败暂停、并发 flush、批次确认丢失去重及既有恢复流程；相关类型、lint、构建和依赖边界检查通过。
