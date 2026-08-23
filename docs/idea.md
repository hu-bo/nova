下面这版我把之前讨论中容易导致复杂化的部分做了收敛，最终定位为：

Coding Agent：负责理解、规划、推理、验证
TaskFlow：负责任务编排、依赖、并发、重试、超时、取消、DAG
Tool：提供语义能力
Runner：负责真实执行环境
agent-server：Control Plane / Host，不是 Agent Runtime 的必要条件
nova-runner npm：纯 Rust Runner 安装/启动包装，不承载业务逻辑
Rust Runner：真正的 Execution Plane
Protocol：跨进程唯一契约
Message/Event：严格区分历史消息、流式事件、执行事件
CLAUDE.md：重点约束代码膨胀、无脑嵌套、重复抽象和过度工程化
# Nova
# Coding Agent + TaskFlow + Remote Runner


> TypeScript + Rust
>
> 一个面向 AI Coding Agent 的轻量执行基础设施。
>
> 核心目标：
> - Agent 负责规划与验证
> - TaskFlow 负责任务编排
> - Tool 提供语义能力
> - Runner 提供真实执行环境
> - 支持 Local / Remote Runner
> - 支持 Streaming / History / Event
> - 支持并发、队列、超时、取消、重试
> - 支持 Dynamic DAG
> - 保持架构简单、代码可维护、可持续扩展
>
> 核心原则：
>
>     模块边界 != 进程边界
>
> 逻辑上高度模块化，运行时尽可能简单。
> 只有真正存在独立资源、生命周期、故障域或部署需求时，才拆分进程。




# 1. Architecture


```text
                         ┌──────────────────┐
                         │  agent-web-ui    │
                         │                  │
                         │ Chat / Task / UI │
                         └────────┬─────────┘
                                  │
                              HTTP + SSE
                                  │
                                  ▼
                    ┌────────────────────────┐
                    │      agent-server      │
                    │                        │
                    │      Control Plane     │
                    │                        │
                    │  Agent                 │
                    │  TaskFlow              │
                    │  Execution             │
                    │  Runner Registry       │
                    │  Tool Orchestration    │
                    │  Persistence            │
                    └────────────┬───────────┘
                                 │
                            gRPC + Proto
                                 │
                 ┌───────────────┼───────────────┐
                 │               │               │
                 ▼               ▼               ▼
           ┌──────────┐    ┌──────────┐    ┌──────────┐
           │ Runner A │    │ Runner B │    │ Runner C │
           │   Rust   │    │   Rust   │    │   Rust   │
           └──────────┘    └──────────┘    └──────────┘

核心运行链路：

User
  ↓
Agent
  ↓
Planning
  ↓
TaskFlow
  ↓
Execution
  ↓
Runner
  ↓
Observe Result
  ↓
Verify
  ↓
Final Result
2. 核心职责
2.1 Agent

Agent 是系统的智能决策层。

负责：

理解用户需求
分析上下文
制定执行计划
创建 Task
决定调用哪些 Tool
决定是否并行执行
根据结果继续规划
验证最终结果
生成最终响应

Agent 不负责：

进程管理
CPU / Memory 限制
Shell 生命周期
Runner 注册
Runner 心跳
DAG 调度细节
网络连接管理
2.2 TaskFlow

TaskFlow 是执行编排层。

负责：

Task
Task Dependency
DAG
Dynamic DAG
并发
队列
Retry
Timeout
Cancellation
Task State
Execution State
Event

典型流程：

Task A
  ├── Task B
  ├── Task C
  │
  └── Task D
       ▲
       │
   B + C 完成

TaskFlow 不负责：

LLM Reasoning
Prompt
Chat Message
UI
Shell 实现
Runner 资源隔离
2.3 Tool

Tool 是 Agent 的语义能力。

例如：

search_code
read_file
write_file
apply_patch
git_diff
git_status
search_symbol
find_reference

Tool 负责：

参数定义
参数校验
执行语义
返回结构化结果

Tool 不负责：

Agent Planning
Task DAG
Runner 生命周期
UI Message

4. Tool 类型

packages/tools/ 不等于 CLI 集合。

Tool 是 Agent 的 Capability Layer。

Tool
├── RunnerTool
├── RemoteTool
├── AgentTool
└── CompositeTool
RunnerTool
bash
read_file
write_file
grep
git_diff
python

流程：

Tool → Runner
RemoteTool
web_search
github
jira
slack

流程：

Tool → HTTP/API
AgentTool
spawn_agent
delegate_task
ask_agent

流程：

Tool → Agent Core / TaskFlow
CompositeTool

由多个 Tool / Model / Task 组合完成。

5. Runner 设计

Rust Runner 是真正的 Execution Runtime。

crates/runner/
├── server/
├── execution/
├── scheduler/
├── process/
├── filesystem/
├── sandbox/
├── resource/
└── runtime/

Runner 不应该知道：

bash
git
grep
python

它只知道：

ExecutionRequest
Execution
ExecutionEvent
ExecutionResult

例如：

interface ExecutionRequest {
  executionId: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;

  resources?: {
    cpu?: number;
    memoryMb?: number;
  };

  sandbox?: {
    network: boolean;
    filesystem: string;
  };
}
6. Runner 只有一种运行边界

Runner 始终是独立 Rust 进程，主动向 Agent Server 建立 outbound persistent
bidirectional gRPC 连接。同机测试也经过真实 process、socket、Protobuf、
gRPC streaming、cancellation 和 timeout。

nova-runner
    │ outbound persistent gRPC
    ▼
Runner SDK
    │
    ▼
Agent Server Runner Module / Registry / Scheduler

7. Runner Control Plane / Execution Plane

必须分离。Runner 只负责 Execution Plane；Runner Module 负责注册、心跳、
调度和用户权限；Runner SDK 只负责 gRPC / Protobuf 技术桥接。

8. 安全边界

用户机器不开放入站执行端口。Runner 缺失 server 或凭据时拒绝启动，
连接身份和用户权限由 Runner Module 校验。
2.4 Execution

Execution 表示一次实际执行。

例如：

Execution
  id
  task_id
  runner_id
  command
  args
  timeout
  resource_limit
  status

Execution 是：

TaskFlow
    ↓
Execution
    ↓
Runner

之间的边界对象。

2.5 Runner

Runner 是 Execution Plane。

负责：

Runner Registration
Heartbeat
Shell
Process
Filesystem
Workspace
PTY
Resource Limit
Timeout
Cancellation
stdout / stderr
Artifact
Execution Result

Runner 不知道：

Conversation
User
Agent
Prompt
Planning
Thinking
Task 的业务含义

Runner 只知道：

Execution

这是整个系统最重要的边界之一。

3. Agent Server

agent-server 是 Control Plane。

职责：

API
Agent Runtime Host
TaskFlow Runtime Host
Execution Coordination
Runner Registry
Persistence
Event Stream

但：

agent-core 必须能够脱离 agent-server 独立运行。

也就是说：

agent-core + TaskFlow + Executor + Runner

必须能够完整完成：

Plan
→ Execute
→ Observe
→ Verify
→ Result

agent-server 不是 Agent Runtime 的前置依赖。

它只是一个 Host / Adapter / Composition Root。

4. 为什么不拆多个 Server

第一阶段不拆：

agent-server
taskflow-server
execution-server
runner-server

原因：

增加 RPC
增加序列化
增加网络故障
增加状态同步
增加部署复杂度
增加调试成本
增加重复 DTO / Mapper

目前应该：

一个 Agent Server
+
多个独立 Runner

只有出现以下需求才拆：

独立扩缩容
独立故障域
独立部署
TaskFlow 成为通用基础设施
Runner 数量巨大
Scheduler / Registry 本身成为独立基础设施

原则：

不要因为模块存在，就把模块变成服务。
5. Runtime Architecture
5.1 Agent Runtime
agent-server
    │
    ├── agent-core
    ├── taskflow
    ├── tools
    └── execution
5.2 Runner Runtime
Rust Runner
    │
    ├── registration
    ├── heartbeat
    ├── execution
    ├── process
    ├── shell
    ├── resource
    ├── sandbox
    └── streaming

两者通过：

Execution Protocol

连接。

6. nova-runner

nova-runner npm 包不属于 Runner Runtime。

它只是 Rust Runner 的：

Distribution / Installation / Launcher Layer

职责：

npm install
    ↓
download / locate Rust binary
    ↓
start Rust Runner

不包含：

Agent
TaskFlow
Tool Runtime
Runner Registry
Execution Logic
Shell Logic

运行时只使用以下结构：

Rust Runner
    │ outbound persistent gRPC
    ▼
agent-server Runner SDK / Runner Module

`nova-runner` 只是 Rust Runner Binary / 产品命令，不是 Node.js package。
7. Rust Runner

Rust Runner 是真正的 Runner。

建议职责：

Runner
├── Registration
├── Heartbeat
├── Execution
├── Process
├── Shell
├── Workspace
├── Resource Control
├── Timeout
├── Cancellation
├── Output Streaming
└── Artifact

Rust 适合承担：

高并发 Execution
Process 生命周期
CPU / Memory 限制
超时
Cancellation
子进程管理
PTY
文件系统
Sandbox
Remote Runner
8. Runner Registration

Runner 启动：

nova-runner
    ↓
Connect agent-server
    ↓
Register
    ↓
Heartbeat
    ↓
Ready
    ↓
Wait Execution

Registration 包含：

runner_id
version
hostname
platform
architecture
capabilities
cpu
memory
workspace
labels

例如：

runner-001


capabilities:
  shell
  git
  docker
  node
  rust


resources:
  cpu: 16
  memory: 32GB
9. Runner 生命周期
Starting
   ↓
Registering
   ↓
Ready
   ↓
Busy
   ↓
Ready
   ↓
Disconnected

Server 必须能够识别：

Ready
Busy
Disconnected
Draining

不要求第一版实现复杂 Runner Scheduler。

10. Runner 与 Server 通信

推荐：

gRPC + Protobuf

原因不是性能，而是：

类型安全
TS / Rust 自动生成
Streaming
明确契约
Schema Evolution
Cancellation
Remote Runner
长连接

Protobuf 是跨进程边界的 Source of Truth。

.proto
  │
  ├── TypeScript generated types
  │
  └── Rust generated types

禁止手工维护：

TS Type
Rust Struct

两套协议定义。

Domain Model 只有在确实存在额外业务语义时才建立。

11. Protocol 设计

Protocol 按边界拆分：

proto/
├── common.proto
├── execution.proto
└── runner.proto

不要设计：

everything.proto

也不要设计一个万能：

Message {
    type
    subtype
    metadata
    payload
}

优先使用：

oneof
enum
typed message

避免：

type + JSON metadata + JSON payload
12. Execution Protocol

核心：

ExecuteRequest
ExecutionEvent
CancelRequest

Execution Request：

execution_id
task_id
command
args
environment
workspace
timeout
resource_limit

Execution Event：

ExecutionStarted
Output
Progress
Artifact
ExecutionCompleted
ExecutionFailed
ExecutionCancelled

第一版只保留真正需要的 Event。

禁止为了“未来扩展”提前创建几十种状态。

13. Runner Streaming

推荐：

rpc Execute(ExecuteRequest)
    returns (stream ExecutionEvent);

Server：

Execute

Runner：

Started
  ↓
stdout
  ↓
stdout
  ↓
stderr
  ↓
Artifact
  ↓
Completed

Cancel 使用独立 RPC：

Cancel(execution_id)

第一版不要为了控制能力过早使用双向 Streaming。

只有确实需要：

stdin
signal
interactive control

时，再引入 Bidirectional Streaming。

14. Remote Runner

Remote Runner 的目标：

Agent Server
      │
      │ Internet / LAN
      ▼
Remote Runner

Runner 可以：

本机
Docker
VM
Remote Machine
Cloud Instance

Server 不关心 Runner 在哪里。

Server 只依赖：

Runner Protocol
15. Runner 并发模型

Runner 不应该：

100 Execution
    ↓
100 OS Thread

应该使用：

Runner
  │
  ├── Execution Scheduler
  │
  ├── Concurrency Limit
  │
  ├── Resource Limit
  │
  └── Execution

例如：

max_concurrency = 16

但真正限制应该同时考虑：

Concurrency
CPU
Memory
Timeout

即：

Concurrency Limit
        +
Resource Limit

不是简单的 Thread Pool。

16. TaskFlow 并发模型

TaskFlow 管理：

Task Queue
Dependency
Concurrency
Retry
Timeout
Cancellation

例如：

          Analyze
         /       \
        ↓         ↓
    Search A    Search B
        \         /
         ↓       ↓
          Modify
             ↓
            Test
             ↓
          Verify

TaskFlow 不应该把每个 Task 都转换成独立 Server Request。

它是进程内的 orchestration engine。

17. Dynamic DAG

TaskFlow 必须支持运行过程中增加 Task：

Task A
  ↓
Agent 分析结果
  ↓
创建 Task B
创建 Task C
  ↓
Task B + C
  ↓
创建 Task D

即：

DAG 是动态状态，而不是启动时一次性固定。

但第一版不要实现：

通用 Workflow DSL
BPMN
超复杂表达式
分布式 DAG Scheduler
K8s Scheduler

只提供：

Task
Dependency
Dynamic Add
Ready Queue
Concurrent Execute
Retry
Timeout
Cancel
Event

足够。

18. Agent / TaskFlow / Tool / Runner 边界
Agent
  ↓
决定做什么


TaskFlow
  ↓
决定什么时候做、哪些可以并行


Tool
  ↓
提供语义能力


Execution
  ↓
表示一次实际执行


Runner
  ↓
真正执行

最重要的边界：

Agent ≠ TaskFlow
TaskFlow ≠ Runner
Tool ≠ Runner
Execution ≠ Task
Message ≠ Event

不要互相吞并职责。

19. Tool 模型

Tool 是语义能力。

例如：

search_code
read_file
write_file
apply_patch
git_diff
find_symbol
find_reference

Tool 可以最终产生：

Execution

但 Tool 自己不应该负责：

Task DAG
Retry Policy
Runner Scheduling
Agent Planning

例如：

Agent
  ↓
Tool Call
  ↓
Task
  ↓
Execution
  ↓
Runner
  ↓
Tool Result
  ↓
Agent
20. Message Architecture

不要设计一个万能 Message。

采用四层：

Message
Block
Event
Snapshot
Message

表达对话语义。

Message
├── id
├── conversation_id
├── parent_id
├── role
├── blocks[]
├── status
└── created_at
Block

表达可展示内容。

Text
Thinking
Code
ToolCall
ToolResult
File
Diff
Error
Artifact
Event

表达实时变化。

MessageStarted
BlockStarted
BlockDelta
BlockCompleted
MessageCompleted
ToolStarted
ToolCompleted
TaskEvent
ExecutionEvent
Error
Snapshot

表达当前完整状态。

用于：

History
Persistence
Recovery

原则：

Stream Event != History Message
21. Streaming

流式传输是增量事件：

MessageStarted
    ↓
BlockStarted
    ↓
BlockDelta
    ↓
BlockDelta
    ↓
BlockCompleted
    ↓
MessageCompleted

不要把每个 delta 当作历史消息保存。

正确流程：

Stream Event
      ↓
Reducer
      ↓
Current Message State
      ↓
Snapshot
      ↓
Persistence

Event 可以用于：

Replay
Debug
Audit
Recovery

但不应该成为 UI History 的唯一数据模型。

22. Chat Message Block

前端最终只处理：

ChatMessage
└── blocks[]

Block 类型：

TextBlock
ThinkingBlock
CodeBlock
ToolCallBlock
ToolResultBlock
DiffBlock
FileBlock
ArtifactBlock

代码应该结构化：

CodeBlock
├── language
├── code
├── file_path
├── start_line
└── end_line

不要让 UI 必须从 Markdown 中解析所有结构。

23. Thinking

Thinking 必须和普通 Text 分离。

Internal Reasoning
    ↓
Agent Internal State


User-visible Summary
    ↓
Thinking / Summary Block

不要默认保存或展示模型不可公开的内部 reasoning。

UI 只消费允许展示的内容。

24. Tool Call

Tool Call：

ToolCallBlock
├── call_id
├── tool_name
└── arguments

Tool Result：

ToolResultBlock
├── call_id
├── status
└── blocks[]

Tool Result 本身也可以包含：

Text
Code
File
Diff
Artifact

不要限制为：

string output
25. Artifact

二进制和大文件不进入 Message。

例如：

screenshot.png
test-report.html
build.zip
logs.txt

使用：

ArtifactBlock
├── artifact_id
├── name
├── mime_type
└── size

实际内容由 Artifact Storage 管理。

26. UI 与内部事件

UI 不直接理解整个 Agent Runtime。

采用：

Agent Event
Task Event
Execution Event
        ↓
Projection
        ↓
UI Event
        ↓
SSE
        ↓
React

UI 是内部状态的 Projection。

不要让 TaskFlow 产生 UI 文案。

不要让 Runner 知道 UI。

27. Web UI 通信

浏览器：

HTTP + SSE

HTTP：

POST /conversations
POST /conversations/:id/messages
POST /tasks/:id/cancel

SSE：

message.started
block.delta
tool.started
tool.completed
task.started
task.completed
execution.output
execution.completed
message.completed

不建议第一版让浏览器直接使用 gRPC。

28. History

History 使用 Message Snapshot：

Conversation
    ↓
Message[]
    ↓
Block[]

读取：

GET /conversations/:id/messages

不要直接把：

Runner Event
Task Event
Stream Delta

暴露为 Chat History。

29. Trace ID

异步系统必须可以追踪完整调用链。

至少：

conversation_id
message_id
task_id
execution_id
runner_id
tool_call_id
event_id

关系：

Conversation
    ↓
Message
    ↓
ToolCall
    ↓
Task
    ↓
Execution
    ↓
Runner

Event 必须可以关联回：

Task
Execution
Message

便于：

Debug
Replay
Failure Analysis
Observability
30. Execution State

Execution 最终状态：

Pending
Running
Completed
Failed
Cancelled
TimedOut
Rejected

Task 状态和 Execution 状态不要混为一谈。

Task
  ↓
Execution 1
  ↓ retry
Execution 2

一个 Task 可以拥有多个 Execution。

31. Retry

Retry 属于 TaskFlow。

不是 Runner 决定：

retry or not

Runner 只报告：

Failed

TaskFlow 根据：

retry_policy
attempt
error
timeout

决定：

Retry
Fail
Cancel

这样 Agent、TaskFlow、Runner 职责不会互相污染。

32. Cancellation

Cancellation 必须贯穿：

User
 ↓
Agent
 ↓
TaskFlow
 ↓
Execution
 ↓
Runner
 ↓
Process

Runner 最终负责真正终止：

Process

TaskFlow 负责决定：

是否取消

Agent 不直接杀进程。

33. Verification

Coding Agent 的闭环不是：

Plan
→ Execute
→ Done

而是：

Plan
→ Execute
→ Observe
→ Verify
→ Repair
→ Verify
→ Final Result

典型：

Analyze
   ↓
Plan
   ↓
Modify
   ↓
Run Test
   ↓
Test Failed
   ↓
Analyze Failure
   ↓
Modify
   ↓
Run Test
   ↓
Pass
   ↓
Verify
   ↓
Final

这是 Agent Core 的核心能力之一。

34. 独立运行 Agent Core

必须支持：

agent-core + Runner

直接运行完整流程。

不需要：

agent-server
HTTP
Web UI

例如：

nova run-test

或者测试代码：

agent-core
    ↓
TaskFlow
    ↓
Executor
    ↓
Rust Runner
    ↓
Result
    ↓
Verify

这样可以直接验证：

Planning
Task Creation
Task Dependency
Parallel Execution
Tool Call
Runner Execution
Result Collection
Verification
Final Answer

agent-server 只是另一个入口。

35. Test Architecture

至少需要三层测试。

Unit Test

测试：

Agent Planning
TaskFlow
DAG
Retry
State Machine
Tool

不启动 Server。

Integration Test

测试：

agent-core
    ↓
TaskFlow
    ↓
Rust Runner

不启动 agent-server。

这是验证核心执行闭环的主要方式。

E2E Test

测试：

Web UI
 ↓
agent-server
 ↓
agent-core
 ↓
TaskFlow
 ↓
Runner

只验证完整产品链路。

原则：

核心能力测试不依赖 Server。
36. 推荐 Monorepo
nova/
│
├── apps/
│   ├── model-gateway/ Model Provider。 Fastify + PostgreSQL + Drizzle 
│   ├── model-gateway-client/  配置openai、anthropic开发 deepseek, minimax模型
│   ├── agent-web-ui/  用户query入口
│   └── agent-server/  存储用户消息历史、断点重试、项目路径、对话权限等数据到 Fastify + PostgreSQL + Drizzle ORM
│
├── packages/
│   ├── agent-core/
│   │   ├── agent-loop/
│   │   ├── planner/
│   │   ├── context/
│   │   └── sub-agent/
│   ├── taskflow/
│   ├── tools/
│   ├── chat-ui/
│   ├── events/
│   ├── model-adapters/  #抹平模型之间的差异 基于@ai-sdk/openai、@ai-sdk/anthropic开发
│   ├── protocol/
│   └── runner-sdk/ # Node.js / TypeScript ↔ Rust Runner 技术桥梁
│
├── crates/
│   └── runner/ rust
│
├── proto/
│   ├── common.proto
│   ├── execution.proto
│   └── runner.proto
│
├── tests/
│   ├── integration/
│   └── e2e/
│
└── docs/

其中：

packages/runner-sdk

只是 gRPC / Protobuf 技术桥梁。

crates/runner

是真正的 Runner。

37. agent-core

不要设计成：

AgentManager
AgentService
AgentExecutor
AgentHandler
AgentController
AgentCoordinator

这种层层包装。

建议围绕领域：

agent-core/
├── agent/
├── planning/
├── runtime/
└── verification/

保持 API 小。

核心：

createAgent()
agent.run()

不要暴露大量内部对象。

38. TaskFlow

TaskFlow 不要演化成通用 Workflow Framework。

第一阶段只提供：

Task
Dependency
Dynamic Task
Ready Queue
Concurrent Execute
Retry
Timeout
Cancellation
Events

不要第一阶段实现：

Workflow DSL
BPMN
复杂表达式
分布式 Scheduler
Kubernetes Scheduler
复杂持久化 DAG Engine

只实现 Coding Agent 真正需要的能力。

39. Runner 最终概念

Runner 相关只保留：

1. `crates/runner`：Rust native execution worker。
2. `packages/runner-sdk`：Node.js / TypeScript 与 Rust 之间的技术桥梁。
3. `apps/agent-server/src/modules/runner`：Registry、调度和用户权限。

Agent 只通过注入的 ToolContext 使用执行能力，不直接依赖 Runner SDK。

40. 不要过度抽象 Runner 边界

不增加 Factory、Manager、Gateway、Provider、Adapter 或平行执行实现。
抽象只解决真实变化点。
41. Remote Runner 的恢复能力

Remote Runner 必须考虑：

Network Disconnect
Runner Restart
Server Restart
Execution Timeout
Client Disconnect

长期设计可以让 Execution Event 带：

event_id
execution_id
sequence
timestamp

例如：

execution_id = exec_001


seq:
1 Started
2 stdout
3 stdout
4 stderr
5 Completed

这样未来可以支持：

Attach
Replay
Resume

第一版可以先保留 sequence/event_id，不必马上实现完整 Event Store。

42. Persistence

第一阶段不要求所有内部状态都持久化。

重点持久化：

Conversation
Message
Task
Execution
Runner
Artifact

Event 是否长期保存取决于：

Recovery
Audit
Replay
Debug

不要因为“Event Sourcing 很先进”就强行 Event Sourcing。

43. 数据模型原则

协议模型：

Protocol Model

业务模型：

Domain Model

持久化模型：

Persistence Model

三者不是必须全部存在。

推荐：

如果协议对象已经足够表达业务：
直接使用。


只有存在真正额外的业务语义：
才创建 Domain Model。


只有数据库结构与业务模型存在明显差异：
才创建 Persistence Model。

禁止机械：

Proto
 ↓
DTO
 ↓
Domain
 ↓
Entity
 ↓
Mapper

这会产生大量无价值代码。

44. CLAUDE.md 核心规则
Architecture
- Prefer simple composition over layered abstraction.
- Keep module boundaries clear.
- Do not create a process boundary merely because a module exists.
- Do not introduce a service when an in-process module is sufficient.
- Keep agent-core executable without agent-server.
- Runner must remain independent from Agent and TaskFlow.
Code Growth
- Do not preserve obsolete code when replacing behavior.
- Do not duplicate old and new implementations.
- Do not add compatibility layers without a concrete consumer.
- Prefer modifying existing code over creating parallel implementations.
- Remove dead code after refactoring.
- Avoid pass-through modules.
Abstraction
- Do not add abstraction layers without a real variation point.
- Do not create Manager/Service/Handler/Adapter wrappers just for structure.
- Prefer one direct function call over multiple forwarding layers.
- Introduce interfaces only at real boundaries.
- Prefer composition over inheritance.
Design
- Design for extension at stable domain boundaries.
- Prefer small cohesive modules.
- Keep dependencies directional.
- Avoid circular dependencies.
- Keep domain logic independent from transport and UI.
- Keep UI concerns out of Agent, TaskFlow and Runner.
Async / Concurrency
- Explicitly model task state and execution state.
- Use bounded concurrency.
- Always define timeout and cancellation behavior for long-running operations.
- Do not equate concurrency with thread count.
- Resource limits must be enforced independently from concurrency limits.
- Retries belong to TaskFlow, not Runner.
Protocol
- Protobuf is the cross-process source of truth.
- Never manually maintain duplicate TypeScript and Rust protocol definitions.
- Prefer typed oneof messages over generic type + JSON payload.
- Keep protocol models small and stable.
- Do not expose internal domain structures through transport protocols.
Messages
- Message represents conversation semantics.
- Block represents renderable content.
- Event represents state changes and streaming updates.
- Snapshot represents persisted state.
- Streaming events are not the history model.
- UI consumes a projection, not internal Agent state.
Runner
- Runner executes; it does not plan.
- Runner does not know conversations or prompts.
- Runner owns process lifecycle and resource enforcement.
- Runner reports facts; TaskFlow decides retry and orchestration.
- nova-runner npm package contains no Runner business logic.
Agent
- Agent owns planning and verification.
- Agent may dynamically create tasks.
- Agent should not directly manage process lifecycle.
- Agent should not know transport details.
- Agent must be testable without agent-server.
TaskFlow
- TaskFlow owns dependency, scheduling, retry, timeout and cancellation.
- TaskFlow is not a generic workflow platform.
- Keep the DAG model minimal.
- Support dynamic task creation.
- Avoid premature distributed scheduling.
Testing
- Core planning + execution must be testable without agent-server.
- Integration tests should validate:
  Planning → TaskFlow → Execution → Runner → Result → Verification.
- E2E tests validate Web/UI/server integration.
- Do not require the full product stack to test core logic.
45. 最终核心调用链

完整 Coding Agent：

User Query
    ↓
Agent
    ↓
Understand
    ↓
Plan
    ↓
TaskFlow
    ↓
Dynamic DAG
    ↓
Task Scheduling
    ↓
Execution
    ↓
Executor
    ↓
Remote Runner
    ↓
Rust Process / Tool
    ↓
Execution Event
    ↓
TaskFlow
    ↓
Agent Observation
    ↓
Verification
    ↓
Repair if needed
    ↓
Verification
    ↓
Final Result
    ↓
Chat Message
    ↓
SSE
    ↓
Web UI
46. 最终运行形态
Core Integration Test
┌──────────────────────┐
│      agent-core      │
│                      │
│ Planning             │
│ TaskFlow             │
│ Verification         │
└──────────┬───────────┘
           │
       Executor
           │
         gRPC
           │
           ▼
┌──────────────────────┐
│     Rust Runner      │
│                      │
│ Process              │
│ Shell                │
│ Resource             │
└──────────────────────┘

不启动：

agent-server
agent-web-ui

即可验证：

Planning
→ Execution
→ Verification
Production
┌──────────────────┐
│  agent-web-ui    │
└────────┬─────────┘
         │
      HTTP/SSE
         │
         ▼
┌────────────────────────┐
│     agent-server       │
│                        │
│ agent-core             │
│ taskflow               │
│ tools                  │
│ runner registry        │
│ persistence            │
└───────────┬────────────┘
            │
        gRPC + Proto
            │
      ┌─────┼─────┐
      ▼     ▼     ▼
   Runner Runner Runner
47. 最终架构原则

整个项目最终只需要记住以下原则：

1. Agent decides what to do.
2. TaskFlow decides how and when tasks execute.
3. Tool provides semantic capabilities.
4. Execution represents one actual execution.
5. Runner executes real processes.
6. Server is the Control Plane, not a mandatory Agent Runtime.
7. Rust Runner is the Execution Plane.
8. nova-runner npm is only a distribution/launcher wrapper.
9. Protobuf is the cross-process source of truth.
10. Message, Block, Event and Snapshot are different concepts.
11. Streaming is incremental state change, not history.
12. UI consumes projections, not internal runtime state.
13. Core Agent + Runner must work without agent-server.
14. TaskFlow supports dynamic DAG but remains intentionally small.
15. Concurrency and resource limits are separate concerns.
16. Retry belongs to TaskFlow.
17. Process/resource enforcement belongs to Runner.
18. Domain models are introduced only when they add real semantics.
19. Avoid pass-through layers.
20. Avoid Manager/Service/Handler/Adapter nesting without real responsibility.
21. Modify existing code instead of preserving parallel implementations.
22. Remove obsolete code after refactoring.
23. Prefer composition over abstraction.
24. Prefer in-process modules over unnecessary services.
25. Split processes only when there is a real lifecycle, resource, scaling or failure-domain boundary.
48. 最终一句话定义

Nova 不是一个“大而全的 Agent Framework”。

它是一个：

以 Agent Planning 为核心、TaskFlow 为编排、Rust Runner 为独立执行平面的轻量 Coding Agent Runtime。

最终最重要的架构边界只有：

Agent
  ↓
TaskFlow
  ↓
Execution
  ↓
Runner

而外围：

Web UI
  ↓
agent-server

只是产品入口；

nova-runner

只是 Rust Runner 的分发入口；

Protobuf

只是跨进程契约。

这能最大限度避免项目后期演化成一个“Agent → Manager → Service → Coordinator → Executor → Adapter → Runner”层层套娃的大型框架。
