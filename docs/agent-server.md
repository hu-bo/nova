# agent-server

> `apps/agent-server` — Control Plane / Host / **Composition Root**。
> 结构契约见 `repo-layout.md` §4.9，代码组织遵循 `Fastify.md`。Phase 2。

---

## 1. 定位

**负责**

- HTTP API + SSE 端点（契约见 `protocol.md`）
 - 登录鉴权（调用独立 auth-service）
- 托管 agent-core 运行时
- 保存和校验会话的模型配置，并将配置组装为 `ModelRef`
- **组装依赖**：注入 `ToolContext` / `Decide` / `SessionStorage`，选择 Runner
- Runner Registry：注册 / 心跳 / 状态
- 持久化：Conversation / Entry / Record / Runner
- **Projection**：内部事件 → `protocol` 的 UI 事件

**不负责**：Agent 决策逻辑、调度逻辑、执行；不做代理，不转发模型请求或模型 SSE。
模型 adapter 根据 server 下发的配置直接连接官方或中转商；server 的 SSE 只承载 agent-core 的 UI 事件。
浏览器本地附件不由 server 中转：server 只生成 MinIO PUT/GET 签名地址。Runner 本地附件由
server 在校验用户、Runner 和 root 边界后读取并写入 MinIO，因为浏览器不能直接访问 Runner 文件系统。

**技术栈**：Fastify + `@fastify/swagger` + PostgreSQL + Drizzle ORM

> agent-server **不是** Agent Runtime 的前置依赖。它是 Host / Composition Root，
> 是"另一个入口"。集成测试用另一个入口装配同样的运行时（`testing.md` §3）。

拆分触发条件：独立扩缩容、独立故障域、TaskFlow 成为通用基础设施、Runner 规模化。

### 1.1 Entry Router

Entry Router 是已有 conversation 请求进入 server 后的第一层应用编排。创建 conversation
由独立 Use Case 完成；Router 只加载已持久化的模式和所有权，不重新猜测模式。
它不负责替代 Main Agent 做任务语义决策，也不负责执行 Tool 或选择具体 Runner。

它需要在创建或恢复 Agent 之前完成以下判断：

- 按 `conversation.user_id` 校验当前用户的资源所有权；
- 根据已保存的 `project_id` 恢复 Chat / Project 模式；
- Project 模式加载同一用户拥有的 Project；
- 将已绑定的 Runner、workspace 和用户上下文交给 Composition Root；运行时不再临时选择设备；
- 将已确定的上下文交给 §2 的 Composition Root 创建 Agent。

```text
HTTP / SSE 请求
        │
        ▼
Entry Router
  ├── conversation 所有权
  ├── Chat / Project
  └── project / user context
        │
        ▼
Composition Root
        │
        ▼
agent-core Agent
```

Entry Router 的输出应是明确的路由结果，而不是把判断隐含在多个 handler 中。例如：

```ts
type EntryRoute =
  | { mode: "chat"; conversation: Conversation; userId: string }
  | { mode: "project"; conversation: Conversation; project: Project; userId: string }
```

`mode` 是 `project_id` 的类型化结果，不是第二份可独立修改的状态。Harness 选择只发生在
Composition Root。用户消息进入 Agent 后，是否自行处理、调用 Tool 或派生 Sub-agent，
仍由 Main Agent 和 agent-core 决定。Entry Router 不解析模型输出，也不承担多 Agent 编排。

模式一旦创建 conversation 时确定，恢复时必须沿用原模式；不能因为当前 Runner 不可用，
把 Project conversation 临时降级为 Chat。Project 需要的 Workspace、Runner 和权限上下文
在首次执行前必须明确解析，缺失时返回可解释的错误。

### 1.2 Project 与 Chat

两种模式（`agent-core.md` §1.1）在 server 侧的落地：

```text
Project                        独立 Chat
  workspace  已绑定目录          workspace  未绑定 Runner 时无；绑定后为 Runner root
  Runner     创建后可延后绑定      Runner     可选；绑定且 READY 时注入 coding ToolContext
  │                              │
  ├── Conversation A             └── Conversation（projectId = null，可选绑定 Runner）
  ├── Conversation B
  └── Conversation C
      三个会话共享 workspace 与 Runner，各自独立的上下文与 TODO
```

| | 独立 Chat | Project 下的 Chat |
|---|---|---|
| `conversations.project_id` | `null` | project 的 id |
| workspace | 未绑定 Runner 时无；绑定后为 Runner 的 `root_workspace` | `projects.workspace` |
| Runner | 不要求绑定；绑定后仅使用该 Runner 的 root | 优先使用 conversation 的 `runner_id`，否则使用 Project 的绑定，并校验 workspace（§8） |
| 注入的 `ctx` | 未绑定时 `undefined`；绑定且 READY 时 `toToolContext(runner, { cwd: root_workspace })` | `toToolContext(runner, ...)` |
| 工具集 | 未绑定时 `risk === "none"`；绑定且 READY 时全部 | 全部 |
| TODO | 有，属于该 conversation | 有，属于该 conversation（**不跨会话共享**） |

**Project 是 workspace 的容器，不是会话的容器。** 创建 Project 时不立即绑定 Runner；
用户必须从自己已连接设备的根目录中选择工作目录，绑定完成后才能开始 coding。
它存在的唯一理由是"同一份代码要聊很多次，不该每次重新指定路径"。
除了 `workspace` 和它绑定的设备 Runner，project 不持有任何会话状态。

> **TODO 不跨会话共享**（`agent-core.md` §9.6）：A 会话勾掉的项在 B 会话里凭空消失，
> 这种行为无法解释。project 级的长期待办是 issue tracker，不是这里。

**模式在创建 conversation 时定死，之后不可改。** 把一个已经聊了 20 轮的
Chat 转成 Project，意味着历史里所有"我没有执行环境"的回答突然变成谎话。
要换模式就在 project 下开新会话。

创建 conversation 不要求 Runner：独立 Chat 不使用 Runner，Project Chat 可以先创建并
进入会话。Project 首次执行前必须解析出 Project workspace 和 Runner；缺失时返回可解释的
错误，且绝不降级为独立 Chat。已有会话可通过 `PATCH /api/conversations/:id/runner` 选择
Runner；切换只影响后续 run，正在运行的 run 继续使用原 Runner。Project Chat 切换时还要
校验新 Runner 的 root 包含 Project.workspace。

### 1.3 OpenAPI 与 API 生成

REST 契约只维护一份：`@nova/protocol` 的 Zod schema 直接挂到 Fastify route 的
params、query、body、response；route 只补 security、tag 和稳定的 `operationId`，再经
Zod type provider 与 `@fastify/swagger` 导出 OpenAPI JSON。处理器、页面和 SDK 都不能
各自再定义一份接口字段。

```text
Fastify route schema
        │
        ▼
@fastify/swagger
        │
        ▼
OpenAPI JSON（唯一 REST 契约）
        │
        ├──────────────────────────┐
        ▼                          ▼
      Orval                      Hey API
        │                          │
        ▼                          ▼
React TS API Client         发布型 TS SDK
+ TanStack Query hooks      （非 React 消费者）
```

| 消费者 | 生成器 | 产物 | 使用规则 |
|---|---|---|---|
| `apps/agent-web-ui` | Orval | 请求函数、类型与 TanStack Query hooks | 供 React 页面管理 REST 资源；详见 `agent-web-ui.md` §1.2 |
| `apps/model-gateway-client` | Orval（消费自身 gateway 的 OpenAPI） | 请求函数、类型与 TanStack Query hooks | 不经 agent-server；详见 `model-gateway.md` §7.2 |
| 外部 TS 调用方 | Hey API | 与 React 无关的 TS SDK | 仅在有 CLI、集成方或其他非 React 消费者时发布；不能替代或再包装 Orval 产物 |

**这不是两套服务端 API。** Orval 和 Hey API 读取同一份 OpenAPI，只是分别面向 React 应用
与可发布 SDK。没有外部 SDK 消费者时，不提前生成或维护空的 Hey API 包；已经存在的 React
管理端一律使用 Orval，避免同一应用出现两套请求、缓存和类型来源。

生成与发布约定：

- OpenAPI 导出为稳定、可访问的构建产物（开发环境可由受保护的文档端点提供）；生产环境不得在未鉴权的公网暴露内部管理、Runner 或调试细节。
- 所有 REST route 都要声明成功与失败 response schema；SSE、下载流和长连接可在 OpenAPI 中标注端点与响应语义，但流解析仍由专门客户端实现，不强行生成 Query hook。
- `operationId` 一经对外使用即视为 API 名称，不因 handler 或文件移动而改名；破坏性 schema 变更需版本化或明确迁移策略。
- Orval / Hey API 配置与生成命令必须可由各自 `package.json` 发现。生成目录只读，业务代码只通过稳定出口导入；禁止手改生成文件。
- OpenAPI schema 变更、对应生成产物与 SDK 版本更新在同一提交完成。CI 至少重新生成并检查工作区无 diff；对外 SDK 再加一层破坏性变更检查。

`@fastify/swagger` 只负责从 route schema 导出契约，不替代 Fastify 的运行时校验；
Drizzle 表模型、agent-core 内部事件和 `proto/` gRPC 类型也都不是 HTTP OpenAPI 的来源。

### 1.4 附件直传

`POST /api/uploads` 接收 `{ name }`，为
`uploads/<encoded-user-id>/<uuid>.<ext>` 生成 7 天有效的 MinIO PUT/GET 签名地址。返回值只有
`{ upload, download }`；MinIO access key 和 secret key 永不返回浏览器。HTTPS 页面请求时把
签名地址切到 HTTPS。签名失败映射为稳定的 `UPLOAD_UNAVAILABLE`。

`POST /api/uploads/runner` 接收 `{ runnerId, path }`。应用层先通过 Runner Registry 校验当前用户
拥有在线 Runner、路径位于其 root 内且目标是普通文件，并在读取前执行 20 MiB 上限检查；随后通过
现有 Runner 文件通道读取字节，再由 `UploadStorage` 写入同一用户前缀。Runner / 路径错误保留稳定的
Runner 或输入错误语义；只有对象存储失败映射为 `UPLOAD_UNAVAILABLE`，不得把底层错误泄漏给客户端。

`GET /api/runners/directories` 同时返回目录和普通文件的一层条目，作为 RemoteExplorer 唯一目录源。
Registry 是 root 边界与在线状态的 owner；HTTP handler 不自行拼接或校验跨平台路径。

---

## 2. Composition Root

这是本 app **唯一不可替代**的职责。其余都是围绕它的传输层。

```ts
const codingHarness = createHarness({ modules: [codingAgentModule] })
const chatHarness = createHarness({
  modules: [{ id: "nova.chat", tools: [todoWrite] }],
})

// src/modules/runtime/create-agent-runtime.ts
function createAgentRuntime(conv: Conversation, project: Project | null, userId: string): Agent {
  // Chat 模式：project 为 null → 不连 Runner，不注入 ctx
  const ctx = project
    ? toToolContext(registry.pick(userId, project.runnerId, project.workspace),
                    { cwd: project.workspace })
    : undefined

  const ref = resolveModelRef(conv.modelConfig)
  const model = createModel(ref)
  return (project ? codingHarness : chatHarness).createAgent({
    model:   ref,
    stream:  model.stream,
    ctx,
    storage: pgSessionStorage(db, conv.id),
    decide:  sseDecide(conv.id),          // §6
    userId,
  })
}
```

`todoWrite` 是未绑定 Runner 的 Chat 唯一额外 Module 能力，`risk === "none"`，因此仍有会话级
TODO。普通 Chat 绑定 READY Runner 后使用 coding Harness，并以 Runner 的 `root_workspace` 作为
`cwd`；这不会创建或关联 Project。不要用空 Harness 后再在 handler 中临时塞 Tool。

Provider 与场景选择都在这里（`agent-core.md` §2）。**除了这个文件，没有第二处知道
agent-core / Runner Module / runner-sdk / model-adapters 同时存在。**

`resolveModelRef` 接收 UI 下发并由 server 校验过的模型配置，包含官方或中转商 endpoint、认证信息、模型名和能力字段；它只负责形成 `ModelRef`，不发送模型请求。模型 adapter 使用该配置直接连接官方或中转商，不经过 `agent-server`，也不经过 model-gateway 的推理接口。

模型配置的唯一 owner 是 conversation。创建会话时可写入默认配置；首次发送消息时 UI 必须下发完整配置。首次发送前切换模型仍按首次对话处理；已有消息后的切换更新 conversation，后续新 run 使用新配置，正在运行的 run 不切换。

**两种模式的差别是一份静态 Module 能力快照。** 没有 `ChatRuntime` / `ProjectRuntime`
两个类，没有 `RuntimeFactory`。模式不是一种运行时类型，是一次 Harness 选择 ——
一旦它变成两个类，两条路径就会开始各自演化，然后就再也合不回来了。

**运行时生命周期**：一个 conversation 一个 `Agent` 实例，进程内 Map 缓存，
空闲 30 分钟回收。重启后靠 `agent.resume()` 从 Record 续跑（`agent-core.md` §5.2）。
这个 Map 是有生命周期职责的 Runtime Registry，不对外伪装成通用 Manager。它负责同一
conversation 的创建去重、空闲回收和关闭；HTTP handler 不得各自持有 Agent。

> 单进程内存态 = 单实例部署。多实例需要 conversation 亲和路由或分布式锁 —— **Phase 2 不做**，
> 明确记录为已知限制。真要水平扩展时先加 sticky routing，不要直接上分布式状态。

---

## 3. 目录结构

更推荐 **Feature / Domain-oriented + Fastify Plugin** 的结构。
`app/` 只放 Fastify 实例、全局插件和配置；`modules/` 按业务域收口；`shared/`
只放跨域复用的基础能力。

**组织约束**

- `*.route.ts` 注册 HTTP schema，并用很薄的 handler 将请求交给 Use Case；没有复用价值时不再拆 `*.handler.ts`
- 业务动作按领域边界组织；Project 的小型 CRUD 合并在 `project.service.ts`，复杂流程再单独拆分
- Repository 只在多个 Use Case 真实共享查询或事务时存在；不为每张表机械创建 Repository
- 不建全局 `controllers/`、`services/`、`repositories/`、`utils/` 四段式目录

```text
apps/agent-server/src/
├── server.ts
│
├── app/
│   ├── app.ts                 # 创建 Fastify 实例
│   ├── config.ts
│   └── plugins/               # 全局 Fastify plugins
│       ├── db.ts
│       ├── auth.ts
│       ├── logger.ts
│       ├── openapi.ts          # @fastify/swagger、OpenAPI 导出与文档访问策略
│       └── error-handler.ts
│
├── modules/
│   ├── project/
│   │   ├── project.route.ts
│   │   └── project.service.ts       # create / list / update / delete
│   │
│   ├── conversation/
│   │   ├── conversation.route.ts
│   │   └── conversation.service.ts # create / list
│   ├── messages/
│   │   ├── messages.route.ts
│   │   ├── list-messages.ts
│   │   ├── send-message.ts
│   │   └── abort-conversation.ts
│   ├── runner/
│   │   ├── registry.ts
│   │   └── accept-runner.ts
│   │
│   ├── decision/
│   │   ├── decision.route.ts
│   │   └── resolve-decision.ts
│   │
│   ├── runtime/
│   │   ├── create-agent-runtime.ts
│   │   ├── runtime-registry.ts
│   │   ├── sse-decide.ts
│   │   └── pg-session-storage.ts
│   │
│   └── projection/
│       ├── project.ts      # AgentEvent → UiEvent
│       └── tool-blocks.ts  # tool details → Block[]
│
├── db/
│   ├── schema.ts
│   └── migrations/
│
└── errors.ts                   # 仅跨 feature 共享的应用错误
```

`conversation/` 的创建和列表属于同一组简单会话管理操作，合并在
`conversation.service.ts` 中；发送消息、取消运行和 Decision 回填仍按独立流程保留。
当某个领域流程出现独立生命周期或明显复杂度时再拆分，不按文件数量机械拆目录。

`project/` 是 4 个纯 CRUD，合并在 `project.service.ts` 中，保持一个 feature 的清晰边界。
`project.service.ts` 必须直接承载 Project 的查询、校验和变更逻辑，不是转发调用的
pass-through 层；只有出现独立生命周期或明显复杂度时，才再拆出具体领域文件。

**Handler 不承载业务逻辑**，它只做 HTTP 到 Use Case 的映射：

```text
Route handler → Use Case → (Runtime | DB)          ✅
Route → Controller → Service → Manager → Repository  ❌
```

---

## 4. 数据模型

PostgreSQL + Drizzle。**七张表。** 数据库中有两类 ID：Project / Conversation 是
server 生成的 UUID；Entry / Record / Message / run ID 必须原样保存 agent-core 产生的字符串，
因此使用 `text`，不能假定它们符合 UUID 格式。

```ts
users                                   // Casdoor 用户的本地查询投影
  id          serial pk
  casdoor_id  varchar(128) not null unique
  username    varchar(64)  not null
  display_name varchar(64) not null
  role        varchar(64)  not null
  is_admin    boolean      not null
  is_active   boolean      not null
  created_at  timestamptz  not null
  updated_at  timestamptz  not null

projects                                // §1.2。可选：独立 Chat 不属于任何 project
  id          uuid pk
  user_id     text        not null
  name        text        not null
  workspace   text        null          // 绑定 Runner 后确定的设备目录
  runner_id   text        null          // 绑定的设备 Runner
  created_at  timestamptz not null
  updated_at  timestamptz not null
  unique (user_id, runner_id, workspace) // 同一用户同一设备同一路径只建一个 project
  unique (id, user_id)                  // conversations 的复合所有权外键目标

conversations
  id          uuid pk
  user_id     text        not null      // 来自 Casdoor，agent-core 只见到这个字符串
  project_id  uuid null                 // null = 独立 Chat 模式，见 §1.2
  runner_id   text        not null      // 每个 Chat 当前绑定的设备 Runner
  title       text        not null
  model_config jsonb      not null      // 已校验的模型连接与能力配置；不存 gateway 路由
  created_at  timestamptz not null
  updated_at  timestamptz not null
  fk (project_id, user_id) → projects(id, user_id) on delete cascade
  index (user_id, project_id, updated_at desc, id desc)
  index (user_id, runner_id, updated_at desc)

entries                                 // agent-core.md §5.1 的 Entry
  conversation_id uuid not null fk → conversations on delete cascade
  id              text not null
  seq             bigint generated always as identity
  parent_id       text null             // 同一 conversation 内的树边
  kind            text not null
  payload         jsonb not null
  created_at      timestamptz not null
  pk (conversation_id, id)
  fk (conversation_id, parent_id) → entries(conversation_id, id)
  index (conversation_id, seq)

records                                 // agent-core.md §5.1 的 Record
  conversation_id uuid not null fk → conversations on delete cascade
  id              text not null
  seq             bigint generated always as identity
  run_id          text not null
  kind            text not null
  payload         jsonb not null
  created_at      timestamptz not null
  pk (conversation_id, id)
  index (conversation_id, run_id, seq)
  index (conversation_id, kind, seq desc)

messages                                // protocol.md §3 的 ChatMessage，Projection 产物
  conversation_id uuid not null fk → conversations on delete cascade
  id              text not null
  seq             bigint generated always as identity
  role            text not null
  blocks          jsonb not null
  status          text not null
  created_at      timestamptz not null
  pk (conversation_id, id)
  index (conversation_id, created_at desc, seq desc)

runners                                 // 最近观测事实；活连接仍只在内存 Registry，见 §8
  id              text pk
  owner_id        text not null         // 由 Runner 连接凭据解析，不信任 Register 自报
  generation      text not null
  root_workspace  text not null         // 设备 Runner 的可访问根目录
  version         text not null
  platform        text not null
  capabilities    text[] not null
  labels          jsonb not null
  max_concurrency int  not null
  running         int  not null
  reported_state  text null             // 首次心跳前为 null；没有 disconnected
  registered_at   timestamptz not null
  last_seen_at    timestamptz not null
```

删除 Project 会通过外键级联删除它的 Conversation、Entry、Record 和 Message，属于明确的
破坏性操作；route 必须要求确认并写结构化操作日志。独立 Chat 不受影响。数据库复合外键保证
conversation 不可能引用另一个用户的 project，不能只依赖 application query 过滤。

`users` 是 Casdoor 用户资料的本地投影，不承担密码、登录会话或权限判断。JWT 验证成功后按
`casdoor_id` 幂等 upsert；Project、Conversation 与 Runner 继续保存稳定的 Casdoor ID，并通过
外键关联 `users.casdoor_id`，方便关联查询且不把内部自增 ID 暴露给 agent-core。

### 为什么 payload 用 jsonb

`Entry` 和 `Record` 各有多个 kind，字段互不相同。
拆成 16 张表，或者建一张有 40 个可空列的宽表，都比 jsonb 差。
**类型安全靠 agent-core 的联合类型和 `pg-session-storage` 中唯一一份穷举 codec**，不靠数据库
为每种 kind 建可空列。只有 agent-server 能写这两张表；读取到未知 kind 或非法 payload 时
立即报存储损坏，不静默丢字段。`kind` 与 `payload` 的转换不得再复制到 Repository 或 handler。

`kind` 单独提列是为了能按类型查（"找所有未 resolved 的 decision"、
"取最后一条 `todo-updated` 恢复 TodoState"，见 `agent-core.md` §5.3）。
后者使用上面的 `(conversation_id, kind, seq desc)` 索引。`seq` 是数据库追加顺序，只用于
恢复和分页，不暴露为领域 ID；不能用随机字符串 ID 或毫秒时间戳猜写入先后。

### 为什么 workspace 在 projects 不在 conversations

一个 project 下的多次 chat **必须**指向同一个 workspace（§1.2）。
放 conversations 上等于允许它们各自不同 —— 那 project 就没有任何意义了，
而且迟早会出现"同 project 两个会话 workspace 不一致"的脏数据。

独立 Chat 没有 workspace，`project_id` 为 null 时它压根不存在。
这比在 conversations 上放一个"有时候有意义"的可空 `workspace` 列干净。

### 为什么 messages 单独存

`entries` 是模型上下文，`messages` 是 UI 展示，**两者不是同一份数据**
（`protocol.md` §1）。从 `entries` 实时投影出 `messages` 意味着每次翻历史都要重跑
Projection，且 tool 的 `details` 已经不在 entries 里了（`agent-core.md` §3.2）。

写入时机必须区分角色：

- server 接受发送请求时立即写一条 `user / done` Message，然后启动或排队 Agent；
- assistant 流只走 SSE，在 `message.end` 时聚合写入一条终态 Message；
- abort / error 分别写 `aborted` / `error`；进程在 `message.end` 前崩溃时没有半条 assistant 行，
  重连客户端以已落库历史 + `RESYNC` 为准；
- `streaming` 只属于 SSE 期间的客户端状态，不写数据库，所以 DB 的 status CHECK 不含它。

Message 与 Entry 是两个写模型，不追求跨越整个模型运行的大事务。用户 Message 表示“server 已接受
这次输入”；若 Agent 启动失败，它仍应保留，并由错误事件解释失败。

### 不建的表

| 表 | 理由 |
|---|---|
| `tasks` / `executions` | taskflow 有退出条件（`taskflow.md` §8）；Execution 的事实已在 `records` 里 |
| `todos` | TodoState 由 `records` 里最后一条 `todo-updated` 重建（`agent-core.md` §9.4）。单独建表要处理"两处状态谁为准"，而 records 本来就必须写 |
| `artifacts` | Phase 1/2 无 artifact 存储（`proto.md` §7） |
| `sessions` | token 无状态校验，不存会话 |

`repo-layout.md` §4.9 列了 Task / Execution / Artifact 持久化 —— 上述三条是相对它的收敛。

> **D7 结论**：用 PostgreSQL，不用 SQLite。jsonb 查询、数组类型、并发写入都用得上，
> 且生产必然是 PG，本地用 docker 起一个的成本远低于维护两套 SQL 方言。

---

## 5. 鉴权

agent-server 不直接连接 Casdoor，而是调用独立 auth-service 的 `GET /api/me?token=...`。
auth-service 负责 Token 验证和 Casdoor 用户查询；agent-server 只负责确认“用户是谁”、同步本地用户投影，
不做角色、团队、ACL 或资源授权。
资源所有权由 agent-server 根据认证后的 `userId` 在查询条件中落实。

```text
web-ui ──@nova/casdoor/client/react──► auth-service ──► Casdoor
   │                                          ▲
   │  Bearer token                            │ GET /api/me?token=...
   ▼                                          │
agent-server ────────────────────────────────┘
```

- 浏览器侧只需要 `appName` 和 auth-service 地址；server 侧只配置 `AUTH_SERVICE_URL`
- agent-server 将 Bearer token 转发给 auth-service 的 `/api/me`；401/403 统一返回 401，鉴权服务不可用返回 503
- 通过后只取稳定的 `userId`（不把角色、权限或完整 Casdoor 用户对象传给 agent-core），作为 session metadata
  传给 agent-core

> Nova 使用 Fastify。认证钩子从 `Authorization: Bearer <token>` 取 token，调用 auth-service 的 `/api/me`，
> 成功后执行 `users` 表幂等 upsert；不要在这里增加角色或权限判断。

**SSE 的 token**：`EventSource` 不支持自定义 header。
用 `fetch` + `ReadableStream` 手写 SSE 客户端（`agent-web-ui.md` §4），**不把 token 放 query string**
—— query string 会进 access log。

**边界**

| | |
|---|---|
| 鉴权（你是谁） | 这里，Casdoor |
| 所有权授权 | 所有 Project / Conversation 查询和变更都带 `user_id`；找不到与无权访问统一返回 404 |
| 角色 / 团队 / ACL | 第一版不做 |
| 工具审批（这次执行放不放行） | agent-core 的 Decision（`agent-core.md` §6），与登录无关 |

**agent-core 永远不认识 User**，只持有 `userId: string`。脱离 server 时该值为 `"local"`。

---

## 6. SSE 与 Decision 回填

### 事件流

`GET /api/conversations/:id/events` → 订阅该 conversation 的 `UiEvent`。

| 关注点 | 做法 |
|---|---|
| 事件 id | 进程内每 conversation 一个单调递增计数器，写进 SSE `id:` 字段 |
| 重连 | 客户端带 `Last-Event-ID` header，server 从环形缓冲（每 conversation 最近 500 条）重放 |
| 缓冲区外 | 返回一次 `error{code:"RESYNC"}`，客户端重新拉 `GET /messages` 全量对齐 |
| 心跳 | 每 15s 发注释行 `:ka`，防代理断连 |
| 多标签页 | 同一 conversation 多个订阅者，广播 |

**事件不持久化。** 环形缓冲只在内存里，进程重启后客户端走 RESYNC 全量对齐。
Event Store 是 Phase 3（`proto.md` §7）。

### Decision

```text
agent-core 写 decision-requested Record
     │
     └─► 调 decide(req)
             ├─► server 广播 SSE: decision.requested
             └─► 挂起，等一个 Promise

用户点击 → POST /api/decisions/:decisionId
     │
     ├─► 查进程内 pending map，找到那个 Promise
     ├─► 校验 pending 所属 conversation 的 user_id
     ├─► resolve(response)   →  agent-core 恢复并写 decision-resolved Record
     └─► server 广播 SSE: decision.resolved
```

```ts
// runtime/sse-decide.ts —— 整个文件大约 40 行
function sseDecide(conversationId: string): Decide {
  return (req, signal) => new Promise((resolve, reject) => {
    pending.set(req.decisionId, { conversationId, resolve, reject })
    broadcast(conversationId, { type: "decision.requested", request: req })
    signal.addEventListener("abort", () => {
      pending.delete(req.decisionId)
      reject(signal.reason)
    }, { once: true })
  })
}
```

Decision Record 的唯一 writer 是 agent-core。`sseDecide` 不碰 `records` 表，否则同一次挂起会被
写两遍。pending map 以 `decisionId` 定位，但 value 必须携带 conversation，供 REST 回填做所有权校验。

**`decisionId` 不存在时返回 404**（重启后 pending map 已空）。
客户端据此提示"该请求已失效"，而不是静默丢弃。

超时由 agent-core 管（`agent-core.md` §6），server 不重复实现。

---

## 7. Projection

**这是本 app 的第二个核心职责。** 内部事件 → `protocol` 的 UI 事件，映射表见 `protocol.md` §4。

主要工作量在 `tool.end` 的 `details` → `Block[]`：

```ts
// projection/tool-blocks.ts
const toolBlocks: Record<string, (details: unknown) => Block[]> = {
  read_file:  d => [{ type: "code", language: langOf(d.path), code: d.text, path: d.path, startLine: d.offset }],
  edit_file:  d => [{ type: "diff", path: d.path, diff: d.diff, added: d.added, removed: d.removed }],
  git_diff:   d => [{ type: "diff", ... }],
  bash:       d => [{ type: "code", language: "text", code: d.stdout }, ...(d.stderr ? [errBlock] : [])],
  grep:       d => [{ type: "file", ... }],   // 每个命中文件一条
  list_dir:   d => d.entries.map(e => ({ type: "file", path: e.name, kind: e.kind })),
  todo_write: d => [{ type: "todo", items: d.items }],
}
// 未注册的 tool → 一个 text block，JSON.stringify(details)
```

一个 tool 一个函数，**没有注册表类、没有策略模式**。
未注册时的降级路径保证新增 tool 不会让 UI 崩掉。

`AgentEvent.todo.updated` 另有一条直通映射（`protocol.md` §4）：
除了作为 tool 结果留在消息流里，当前 TODO 还要以独立事件外发，
前端才能把它渲染成常驻面板而不是翻历史找最后一次调用。

**`TaskEvent` 不外发**（`protocol.md` §4）—— 一旦外发，前端就会依赖 taskflow 的存在，
而它有退出条件。

---

## 8. Runner Module / Registry

Runner Module 是 Runner Control Plane 的唯一 owner。它接纳 `runner-sdk` 产生的
Runner Session，维护 Registry，并执行用户权限校验和 Runner 调度。

### 8.1 首次访问与 Runner 绑定

用户首次访问页面时，UI 调用设备 Runner 引导接口：

```text
POST /api/runners/bootstrap
→ { installCommand, startCommand, token: <一次性明文> }
```

server 根据当前认证的 `userId` 生成一次性高熵设备 token，持久化 token digest、`owner_id`、
过期时间和使用状态，并返回安装命令与启动
命令。token 明文只在创建响应中出现一次，不写日志、数据库、URL 或错误对象；重复访问只返回
已脱敏的引导状态，用户明确重新生成时旧 token 立即失效。

```text
nova-runner --server https://<agent-server>/runner-connect --token <runner-token> --root /home/user
```

Runner 使用 token 通过 gRPC metadata 建立连接。server 在接纳连接前校验 token digest、过期时间、
使用状态和绑定的 user/device，并把校验得到的 `ownerId` 交给 Runner Module；Register
消息中的 `runner_id`、root 或 labels 不能改变绑定关系。token 一旦成功接纳即标记为已使用，
连接断线后的重连由该 Runner session 的受信连接凭据完成，不重新使用 bootstrap token。

因此“谁安装谁绑定”表示：安装者使用其已登录用户页面生成的命令，设备 Runner 就绑定该用户；其他用户
不能借助 root、workspace 或 runner_id 接管或调度该 Runner。

Project 绑定设备目录是单独的流程。创建 Project 后，UI 请求该用户的在线 Runner 列表，
通过 Runner 的文件能力从 `root_workspace` 开始浏览目录；用户选择目录后调用
`POST /api/projects/:projectId/workspace { runnerId, path }`。server 必须校验 Runner 属于当前用户、
path 位于该 Runner 的 root 内且目录存在，然后原子写入 `projects.runner_id` 与 `projects.workspace`。
未完成绑定的 Project 可以保存草稿，但不允许创建 coding conversation 或启动 Agent。

```ts
interface Registry {
  register(ownerId: string, session: RunnerSession): void
  pick(userId: string, runnerId: string, workspace: string): RunnerSession
  markDisconnected(id: string): void
}
```

心跳事实已经由 `RunnerSession.lastHeartbeatAt/state` 维护，Registry 读取它们并推导在线状态，
不再提供一个让别处重复写状态的 `heartbeat()` 入口。

| 状态 | 来源 |
|---|---|
| `READY` / `BUSY` / `DRAINING` | Runner 上报；同步为 `runners.reported_state` 的最近观测值 |
| `DISCONNECTED` | **server 推导**：超过 3 个心跳周期未收到。Runner 自己永远不上报它（`proto.md` §5） |

`DISCONNECTED` 不写进 `runners.reported_state`；连接接纳后、首次心跳前该列为 null，UI 同样
视为 disconnected。server 重启时数据库里的所有 runner 都先视为
disconnected，只有新接纳的 `RunnerSession` 才能进入在线 Registry。数据库记录不能恢复网络连接。

Project 的 `runnerState` 是绑定 Runner + workspace 的状态：存在 READY 就是 ready；否则存在
BUSY 就是 busy；否则存在 DRAINING 就是 draining；没有有效活连接就是 disconnected。

Runner 的 Bearer token 必须在接纳 `RunnerSessionCandidate` 前解析为可信的 `ownerId`；Register
自报字段不能决定所有者。`runner-sdk` 的接纳回调必须把已验证的连接身份交给 Runner Module，
否则多用户部署不能上线。bootstrap token 明文不进入 `runners` 表和日志。

**`pick(userId, runnerId, workspace?)` 的第一版策略**：只在 `ownerId === userId`、指定
`runnerId` 为 `READY`，且提供时 workspace 位于该 Runner root 内的 Runner 中选择。未提供 workspace
时以 Runner root 为执行目录。**没有匹配的 Runner 就报错**，不回落到任意一个 ——
回落意味着 agent 会在错误的代码库上改文件。

workspace 必须位于指定 Runner 的 root 内；Project 的 workspace 是设备上的工作目录，Runner
本身是设备级连接，不随 Project 创建或销毁。不做标签匹配、亲和性、加权。

未绑定 Runner 的 Chat 不调 `pick`。已绑定 Runner 的 Chat 调 `pick(userId, runnerId)`，以该
Runner 的 `root_workspace` 作为 `cwd`；Project Chat 仍必须传入并校验 Project workspace。Runner
连接属于 server 级 Control Plane，不与某个 conversation 的生命周期绑定。

Runner 断连时，其上运行的 execution 全部失败为 `RUNNER_UNAVAILABLE`
（`runner-sdk.md` §4），由 taskflow 或 agent-core 决定后续。

**project 尚未绑定或 Runner 未就绪时**：`create-conversation` 允许创建。首次发消息时，
UI 先提示用户绑定 Runner 与 workspace；若绑定后连接仍不可用，`pick` 返回明确错误。
不要静默降级成 Chat 模式 ——
用户以为 agent 能改代码，实际它只会空谈。

---

## 9. 取消链路

```text
POST /api/conversations/:id/abort
   ↓
agent.abort()
   ↓ AbortSignal
tool 的 ctx.signal
   ↓
runner-sdk 沿已有 Runner Session 发 Cancel(execution_id)
   ↓
Runner kill 进程组
```

**每一层都不越级。** server 不直接调 `runner.cancel()`，agent-core 不直接杀进程。
这条链上任何一处走捷径，都会留下杀不掉的孤儿进程。

---

## 10. Model Configuration Module

模型配置服务端属于 `agent-server` 的一个独立模块，但不属于 Agent、Runner 或 SSE
运行时。它与 server 共享进程和部署单元，使用稳定的 HTTP / domain contract 通信；
模块内部不得依赖 conversation、Runner 或 agent-core 的实现细节。未来拆分时，
`modules/model-config` 可以连同自己的表、管理路由和配置 API 独立部署，
`agent-server` 只保留配置 API 的客户端或适配边界。

### 10.1 职责边界

**负责**：Provider 配置、模型目录、模型能力字段、连接配置校验、配置版本和管理 API。

**不负责**：模型推理代理、模型请求转发、模型 SSE 转发、Agent 决策、Runner 调度、
Conversation 业务。模型 adapter 根据最终 `ModelRef` 直接连接官方或中转商。

```text
model-config 管理面 ──配置──► conversation.model_config ──► ModelRef
agent-core → model-adapters ──HTTP/SSE 直连──► 官方或中转商

❌ agent-core → agent-server → model-gateway/provider
❌ model-config → agent-server → model provider（推理代理）
```

### 10.2 模型配置契约

`agent-web-ui` 负责选择模型，并在首次发送消息时下发完整配置。首次发送前切换模型仍
属于首次对话配置；已有消息后的切换更新会话配置，正在运行的 run 不切换，后续新 run
使用新配置。配置 mutation 与发送请求必须串行化。

`agent-server` 是会话当前模型配置的唯一 owner，只保存经过 schema 校验的配置，并在
创建或恢复 Agent 时调用 `resolveModelRef(modelConfig)`。模型配置至少包含：

```ts
type ModelConfig = {
  provider: "openai" | "anthropic"
  endpoint: string          // 官方或中转商 endpoint，不是 agent-server 地址
  model: string
  credential: string       // 由配置模块按部署安全策略保护；不写日志
  contextWindow: number
  maxOutput: number
  thinkingLevels: string[]
  parallelToolCalls: boolean
  reasoningFormat: string
  inputModalities: string[]
}
```

`provider` 表示 wire protocol；`reasoningFormat` 表示同一协议内的供应商差异。
`endpoint` 必须是 HTTPS，并按部署 allowlist 校验，默认拒绝 loopback、link-local 和
私网目标，防止配置形成 SSRF。配置模块不得把 provider 密钥写入日志、URL、query、
错误对象或前端 Query cache。

### 10.3 独立的数据与管理面

模型配置模块拥有自己的 provider / model / usage / quota / api-key 数据。它们不引用
Project、Conversation 或 Runner 表；Conversation 只保存已校验的 `model_config` 快照
及其版本，不保存模块内部路由关系。配置更新不会修改历史消息，也不会改变正在运行的
Agent。

管理 API 统一位于 `/admin/model-config`，使用 Casdoor `admin` 角色；推理请求不经过
这些路由。接口范围为：

| Path | 用途 |
|---|---|
| `/providers` | 官方 / 中转商 endpoint 与凭据配置 |
| `/models` | 公开模型名、上游模型名与能力目录 |
| `/api-keys` | 配置模块管理凭据 |
| `/usage` | 配置模块产生的用量报表 |
| `/quotas` | 配额与限流配置 |

管理前端可以继续作为独立 `model-gateway-client` 应用存在；它只调用上述管理 API，
不进入模型推理路径。若未来拆分服务端，优先整体迁移 `modules/model-config` 与这些
管理路由，保持 `ModelConfig` / `ModelRef` 契约不变。

## 11. Phase 范围

**Phase 2**：§2–§9，包含完整 Runner Module / Registry 与 `proto/runner.proto` 持久连接。

**推迟**

| 项 | 理由 |
|---|---|
| 多实例部署 | 需要 conversation 亲和路由，见 §2 |
| Event Store / Replay | 见 §6 |
| 角色 / 团队 / ACL | 见 §5 |
| Task / Execution 的运维视图 | 没有消费者 |
