# agent-web-ui

> `apps/agent-web-ui` — 用户 query 入口。
> 结构契约见 `repo-layout.md` §4.10。Phase 2。

---

## 1. 定位

**负责**

- 应用外壳：路由、布局、导航、设置
- **Project 管理**：创建、选择、Runner 状态展示（§7）
- **Chat 与 Runner 绑定**：每个 Chat 的 Runner 选择、切换和状态展示（§3.1）
- **SSE 订阅与状态管理**（一切副作用的 owner 在这里）
- 鉴权接入
- 把 `ChatMessage[]` 与 `Todo[]` 喂给 `chat-ui` 渲染
- 取得附件签名地址后把文件直接上传 MinIO

**不负责**

- Block 渲染逻辑 —— 由 `packages/chat-ui` 承担，本 app 不重复实现
- 从 Markdown 解析结构 —— 结构已经在 `Block` 里
- 代理或持有 MinIO 凭证

**依赖**：`packages/protocol`（type-only）+ `packages/chat-ui` + `@nova/casdoor/client/react`

> **一切副作用的 owner 在这里**：SSE 连接、Decision 回填请求、本地持久化。
> chat-ui 只通过回调上抛意图（`chat-ui.md` §3）。

### 1.1 技术栈与职责边界

```text
Fastify → OpenAPI → Orval → React Router → TanStack Query
                                      │
                     ┌────────────────┴────────────────┐
                     ▼                                 ▼
            路由 / 页面组合                      服务端资源缓存
                     │                                 │
                     └──────────────┬──────────────────┘
                                    ▼
                           conversation reducer
                           （SSE 实时增量状态）
```

| 层 | 选型 | 在本 app 中的职责 | 不承担的职责 |
|---|---|---|---|
| HTTP 服务 | Fastify | 提供 REST、SSE 与 OpenAPI 描述；真实 API 语义以 `agent-server.md` 为准 | 不向前端泄漏数据库或 Runner 内部模型 |
| 契约与客户端 | OpenAPI + Orval | 从 OpenAPI 生成请求函数、请求/响应类型与 TanStack Query hooks | 不手写与 schema 重复的 DTO 或 fetch 封装 |
| 路由 | React Router | URL、嵌套路由、页面级 loader / error boundary 与参数校验 | 不保存对话流状态 |
| 服务端状态 | TanStack Query | project、会话列表、历史消息、设置等可重新获取的资源；失效、预取与轮询 | 不缓存逐 token 的 SSE 增量 |
| 实时 UI 状态 | `useReducer` + Context（或 zustand 量级 store） | §3 的 `ConversationState`、SSE 生命周期与去重 | 不替代 HTTP 缓存 |
| 组件基础 | shadcn/ui + Base UI | 可访问的基础控件与组合式对话框、菜单、Popover 等 | 不把聊天 Block 的渲染从 `chat-ui` 复制过来 |
| 样式 | Tailwind CSS v4 | token 化样式、响应式布局、暗色模式和状态样式 | 不创建第二套 CSS 设计系统 |
| 表单 | React Hook Form + Zod | 新建 project / conversation、设置、Decision 的输入收集与客户端校验 | 不替代服务端校验 |
| 视觉反馈 | Lucide + Motion | 图标、微交互、折叠/展开和非阻塞反馈 | 不用动画掩盖网络或 Runner 失败 |

**状态分界必须明确。** `useQuery` 的数据可以被 `invalidateQueries` 后重新取得；
`ConversationState` 则是当前 SSE 流的局部、可变投影。发送消息、Decision 成功、
Runner 状态改变后，应失效相关 query；`block.delta`、`tool.output` 和重连去重只进入 reducer。

### 1.2 OpenAPI / Orval 约定

- Fastify 的 OpenAPI 文档是 REST 契约的唯一来源；前端不得根据页面需要自行猜测路径、字段或枚举值。
- Orval 生成代码放在 `src/api/generated/`（或等价的明确生成目录），**只读、不手改**；生成命令与配置应在 app 的 `package.json` 中可发现。
- 业务代码只从 `src/api/` 的稳定出口导入生成类型和 hooks。该目录可放 query key、轮询策略和少量 UI 适配，不能重新声明 API type。
- SSE 是流式传输，不适合由 OpenAPI client / Query hook 消费；按 §4 使用浏览器原生 `EventSource`。其事件 payload 使用 `packages/protocol` 的 type-only 类型。
- 生成产物更新必须与服务端 OpenAPI 变更同一提交；CI 至少校验生成后工作区没有 diff，防止契约漂移。

推荐的资源 key 形状：

```ts
const queryKeys = {
  projects: ["projects"] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  conversations: (projectId?: string) =>
    ["conversations", { projectId: projectId ?? null }] as const,
  messages: (conversationId: string) =>
    ["conversations", conversationId, "messages"] as const,
  settings: ["settings"] as const,
}
```

不要把 token、`AbortController`、SSE event id 或乐观消息对象放进 query key 或 query cache；
它们的生命周期只属于当前对话实例。

---

## 2. 页面结构

```text
/                          开源工具产品首页（未登录）
/app                       Project 列表 + 最近会话 + 新建入口
/p/:projectId              该 project 的会话列表
/p/:projectId/c/:convId    Project 模式对话页
/c/:convId                 独立 Chat 对话页（无 project）
/settings                  模型选择、默认配置
/callback                  Casdoor 回调承接
```

七条路由。两个对话页**复用同一个组件**，差别只在有没有 project 上下文
（`agent-server.md` §1.1）—— 不是两个页面。

**没有** `/tasks` / `/runners` / `/executions` 页面 ——
Task 与 Execution 作为对话里的 Block 呈现（`protocol.md` §3），
运维视图等真的需要时再加。

对话页布局：

```text
┌──────────┬────────────────────────────┬─────────────┐
│ 会话列表  │  <MessageList/>            │ <TodoPanel/>│
│          │                            │             │
│ ─────────│                            │ 未完成 ≥1   │
│ project  │  ┌──────────────────────┐  │ 时才显示    │
│ 名称与    │  │ <DecisionPrompt/>    │  │             │
│ Runner   │  └──────────────────────┘  │             │
│ 状态灯    │  <Composer/>               │             │
└──────────┴────────────────────────────┴─────────────┘
```

TODO 面板**常驻右侧，不在消息流里滚走**。它是"现在的计划"，
消息流里的 `todo` block 是"当时的计划"（`protocol.md` §4）。
独立 Chat 模式下同样显示 —— 多步讨论一样需要进度追踪。

### 2.1 模型选择与下发时机

模型选择由 `agent-web-ui` 负责。UI 只选择并下发模型配置，不把模型请求转发给
`agent-server`，也不经 `model-gateway` 代理推理或 SSE。

- 创建会话时可保存默认模型，但首次发送消息时必须再次带上当前模型配置；这一步是首次对话的模型配置下发。
- 如果用户在会话尚未发送消息前切换模型，切换后的配置在首次发送消息时下发，仍视为该会话的首次对话配置。
- 如果会话已经有消息，切换模型时立即向 `agent-server` 下发新的模型配置；下一次发送使用新配置。切换不回写历史消息，也不重建会话。
- `agent-server` 保存会话当前模型配置，并在新建或恢复 Agent 时将其转换为 `ModelRef`。模型 adapter 根据配置直接连接官方或中转商。

同一会话的模型切换和发送必须由 UI 串行化：先完成模型配置 mutation，再允许发送消息，避免一次运行读取到半套配置。

---

## 3. 状态

```ts
interface ConversationState {
  messages: ChatMessage[]
  todos: Todo[]
  pendingDecision: DecisionRequest | null
  connection: "connecting" | "open" | "reconnecting" | "closed"
  isRunning: boolean
  error: string | null
}
```

**六个字段。** 每个都对应界面上一处必须变化的东西。

`project` **不在这里** —— 它是路由参数派生的，属于上层的 project 上下文，
不随对话变化。放进来就会出现"切会话时 project 短暂为 null"的闪烁。

**技术选型**：一个 `useReducer` + Context，或一个轻量 store（zustand 量级）。
**不上 Redux / RTK / Saga** —— 状态只有一个 conversation 的消息流，
中间件与 devtools 的成本高于收益。

`messages` 是唯一真相，`chat-ui` 是它的纯函数投影。

### 3.1 会话 Runner 绑定

Runner 选择属于 `apps/agent-web-ui` 的会话页面，不属于 `packages/chat-ui`。新建普通
Chat 或 Project 会话直接进入会话页面，不为 Runner 弹窗。独立 Chat 不需要 Runner；
Project 尚未绑定 Runner/workspace 时，用户首次发送才提示完成绑定。用户也可在会话页面
随时切换到自己拥有的其他 Runner；切换通过 server mutation 完成，当前运行中的 run 不迁移，
下一次发送才使用新 Runner。

```text
Chat 页面
  ├── 当前 Runner：Linux Server / Windows PC
  ├── Runner 状态与 workspace
  └── 切换 Runner → PATCH /api/conversations/:id/runner
```

切换控件由 Chat 页面组合，`chat-ui` 只接收展示数据和回调，不知道 Runner、设备、权限
或 API 路径。Project Chat 还必须校验新 Runner 能访问 Project 已绑定的 workspace；独立
Chat 不执行文件工具，因此不保存 Runner 绑定。

### 3.2 产品首页

`/` 是面向未登录用户的开源工具首页，`/app` 是登录后的工作台。首页目标是让用户在
3 秒内理解产品、看到运行效果并开始安装，不把首页做成文档目录。

首屏结构：

```text
开源 AI Coding Agent，直接在你的设备上工作
让 Agent 连接你的 Linux 服务器或 Windows PC，在真实 workspace 中完成任务。

[快速开始]  [GitHub / View Source]

npm install / docker run / nova-runner 安装命令                 [复制]
动态终端录屏或交互式 Playground：选择 Runner → 选择 workspace → coding
```

设计要求：

- 价值主张使用“目标 + 痛点 + 优势”，避免只写 Rust、异步或架构名词。
- 主 CTA 为“快速开始”，进入安装和 Runner 绑定流程；次 CTA 为 GitHub / View Source。
- 动态演示优先于静态架构图，展示 Runner、workspace 选择和 coding 结果。
- 安装命令显眼展示，一键复制并有成功反馈动画；复制失败提供可选文本选择。
- 视觉风格兼顾技术可信度与商业产品精致感：深色代码背景、清晰层级、克制动效、
  键盘可操作和 `prefers-reduced-motion` 支持。
- 首页不要求登录才能浏览；点击快速开始或进入工作台时再触发 Casdoor 登录。

---

## 4. SSE 客户端

使用浏览器原生 `EventSource`。对话消息的 `POST /messages` 已完成身份与 Conversation
所有权校验；只读事件流不再重复携带 token，也不把 token 放进 query string。

```ts
await stream.ensureConnected() // 内部等待 EventSource.open
await api.sendMessage(id, input)
```

| 关注点 | 做法 |
|---|---|
| 建连 owner | 页面挂载不建流。第一次发送事务调用 `ensureConnected()`，等待 `EventSource.open` 后才 POST；运行中的后续发送复用同一连接 |
| 生命周期 | 首次发送建流后跨 run 复用，`run.end` 不关闭，避免 `nextRun` 紧接当前 run 时丢事件。React effect 只负责页面卸载时 cleanup，不负责建连 |
| 重连 | 交给 `EventSource`；浏览器自动携带最后收到的 SSE `id` |
| `error{code:"RESYNC"}` | 关闭旧 `EventSource`，重新 `GET /messages` 全量对齐，再创建一个没有旧 event id 的新连接 |
| 并发发送 | `ensureConnected()` 共享同一个 pending-open Promise，不得创建第二个 EventSource |
| 幂等 | 按 `messageId + index` 更新，重放不会产生重复块 |

**幂等这条是重连正确性的全部依赖。** reducer 必须写成"设置成这个值"而不是"追加这段" ——
除了 `block.delta` 和 `tool.output`，那两个用 `lastEventId` 去重。

---

## 5. Reducer

```text
message.start      → push 一条 status:"streaming" 的空消息
block.start        → 该消息 blocks[index] = 骨架
block.delta        → blocks[index] 追加 delta（仅 text/thinking/code）
block.end          → blocks[index] = 完整 block（覆盖，不合并）
message.end        → status = done | error | aborted
tool.output        → 找到 callId 对应的 tool_call block，追加输出
decision.requested → pendingDecision = request
decision.resolved  → pendingDecision = null
todo.updated       → todos = items（整体替换，不合并）
run.end            → isRunning = false
error              → error = message（RESYNC 特判，见 §4）
```

**`block.end` 覆盖而不是合并**：服务端发的是完整 block，
本地累积的 delta 可能因重连而缺失或重复，以服务端为准。

**`todo.updated` 整体替换**同理，且源头就是全量的（`tools.md` §3 的 `todo_write`）。
增量合并会在丢一个事件后永久错位。

进对话页时先 `GET /messages` 拿历史，TODO 的初值从**最后一个 `todo` block** 取 ——
它和事件通道最终会一致，先渲染出来避免面板空一拍。

reducer 在这里不在 chat-ui —— 它需要知道重连、乱序、去重这些传输层的事
（`chat-ui.md` §4）。

---

## 6. 交互

### 发送

```ts
onSubmit(text) {
  optimisticAppend(userMessage(text))         // 立即显示
  POST /conversations/:id/messages { text, queue }
  // 失败 → 该条标红 + 重试按钮，不静默丢
}
```

Composer 接受两种附件来源。浏览器拖入 / 粘贴的本地 `File` 先调用
`POST /api/uploads { name }`，再直接 `PUT` 到返回的 `upload` 地址；MinIO 请求不携带 Nova Bearer token。
点击附件按钮时，宿主打开 `chat-ui` 的 `RemoteExplorer`，通过 `GET /api/runners/directories`
浏览当前 Runner 并支持多选，提交时对每个远程路径调用 `POST /api/uploads/runner`。两条结果统一成
附件 Markdown。提交后 Composer 立即清空可见草稿并显示发送中状态；任一上传或发送失败都恢复
提交前的草稿和附件，避免用户重新输入。

Project workspace 绑定也复用同一个 `RemoteExplorer`，但使用 `mode="directory"` 和单选。
Runner id、目录请求、已选路径和上传 mutation 全部由 `agent-web-ui` 持有；`chat-ui` 不知道 Runner。

`queue` 的选择规则（对应 `agent-core.md` §7 的三条队列）：

| 情况 | queue |
|---|---|
| 没在运行 | 不传，新开一个 run |
| 运行中，默认发送 | 前端暂存，不立即请求 server；当前 run 结束后逐条发送 |
| 运行中，用户点击待处理项的“调整方向” | 立即以 `steering` 发送该本地待处理项 |

运行中但 Composer 为空时，发送位保留中断按钮；用户开始输入下一条消息后，按钮切回发送。
普通发送立即清空草稿并展示在 Composer 上方的紧凑本地待处理列表中，不在输入框里提前展示
queue 选项，也不立即请求 server。每个待处理项提供“调整方向”，点击后才以 `steering`
发送；否则 `run.end` 到达后，前端按 FIFO 自动取一条作为新 run 发送。

`followUp` 不暴露给用户手动选 —— 它的语义（"它想停下时让它继续"）
对用户不可见，由 server 在特定场景使用。

### 中断

对话输入区在 `isRunning` 且没有新草稿时将发送按钮替换为中断按钮 → `POST /abort`；
有新草稿时恢复发送按钮，让用户提交下一轮消息；steering 由已发送待处理项的“调整方向”触发。
**中断必须随时可点**，这是长任务体验的底线。

### Decision

```tsx
<DecisionPrompt request={pendingDecision} onResolve={r =>
  fetch(`/api/decisions/${r.decisionId}`, { method: "POST", body: JSON.stringify(r) })
} />
```

404 → 提示"该请求已失效"（server 重启导致，见 `agent-server.md` §6）。

---

## 7. 两种模式的 UI 差异

### 7.1 新建时选一次，之后不再问

```text
[ + 新建 ]
   ├── 直接开始聊              → POST /conversations {}              → Chat 模式
   └── 在项目里工作
         ├── 选一个已有 project → POST /conversations { projectId }   → Project 模式
         └── 新建 project       → POST /projects { name }
                                      → 选择已连接 Runner
                                      → 从设备根目录选择 workspace
                                      → POST /projects/:id/workspace { runnerId, path }
```

**模式创建后不可改**（`agent-server.md` §1.1）。Project 必须先完成 Runner 和 workspace 绑定，
才能发送 coding 消息。UI 不提供"转成 Project 模式"按钮 ——
把聊了 20 轮的 Chat 转过去，历史里所有"我没有执行环境"的回答会突然变成谎话。
想换就在 project 下开新会话。

### 7.2 界面上的差别

| | Chat 模式 | Project 模式 |
|---|---|---|
| 侧栏 | 只有会话标题 | project 名 + workspace 路径 + Runner 状态灯 |
| Composer 占位符 | "问点什么" | "让 agent 做点什么" |
| TODO 面板 | 有 | 有 |
| 审批卡片 | 不会出现（无 `write`/`exec` 工具） | 会出现 |

差别只有这些。**不做两套页面、两套 store、两套路由守卫。**

### 7.3 Runner 未连接

`Project.runnerState === "disconnected"` 时（`protocol.md` §3）：

- 侧栏状态灯变红，hover 显示 workspace 路径
- 用户首次访问时，UI 请求 Runner 引导信息；页面展示安装命令、启动命令和一次性设备 token。命令和 token 都提供“复制”按钮，token 只显示一次，刷新后不再返回明文
- token 只绑定当前登录用户和设备 Runner，不绑定 Project 或 workspace；谁使用该命令启动 Runner，设备 Runner 就归谁所有
- Composer **不禁用**，但发送前弹提示，附上启动命令：
  ```
nova-runner --server https://<agent-server>/runner-connect --token <runner-token> --root /home/user
  ```
- 若用户仍要发，请求会返回明确错误（`agent-server.md` §8），展示为 `error` block

**不静默降级成 Chat 模式。** 用户以为 agent 能改代码、实际它只会空谈，
这是最糟糕的失败方式 —— 它会给出一堆看起来做完了的回答。

Runner 恢复后状态灯自动转绿（Registry 状态随 `GET /projects` 轮询或 SSE 推送刷新）。

---

## 8. 鉴权

```tsx
// @nova/casdoor/client/react
<CasdoorProvider
  config={{
    appName: import.meta.env.VITE_CASDOOR_APP_NAME || 'nova',
    authApiBase: '/api',
    redirectUri: `${window.location.origin}/callback`,
    logoutRedirectUri: window.location.origin,
    storage: {
      type: 'localStorage',
      prefix: 'nova_webui_',
      accessTokenKey: 'access_token',
    },
    silentRefresh: true,
  }}
>
  <App />
</CasdoorProvider>
```

登录只做身份认证，不在浏览器判断角色、团队或 ACL。完整流程是：

```text
未登录 → auth-service 生成 Casdoor authorize URL → Casdoor 登录
       → /callback → auth-service 用 code 换 token
       → web-ui 持久化 token → 请求 agent-server 时加 Bearer header
```

- `appName` 从 `VITE_CASDOOR_APP_NAME` 读取，缺省为 `aflow`
- `authApiBase` 使用同源 `/api`；Casdoor endpoint、client secret、证书留在 auth-service
- `redirectUri` 为当前 origin 的 `/callback`，退出登录回到当前 origin
- access token 使用 `localStorage` 持久化，并使用 `af_webui_` 前缀和 `access_token` 键名，避免与其他应用冲突
- 开启 `silentRefresh`；刷新失败时清除 token 并回到登录流程
- REST 请求统一带 `Authorization: Bearer <access_token>`
- `GET /api/conversations/:id/events` 使用原生 `EventSource`，不携带 Authorization；Conversation UUID 是该只读流的订阅能力标识
- 消息提交、历史读取、Decision 和中断仍由 REST 完成鉴权与所有权校验；事件流只能观察，不能发起执行或修改状态
- 401 → 清除本地 token，回到登录页，**不自动刷新后重试**，避免无限循环
- auth state 只暴露 `isAuthenticated`、当前 `userId` 和登录错误；角色/权限不进入 UI 契约

---

## 9. 目录结构

```text
apps/agent-web-ui/src/
├── main.tsx
├── app.tsx                   # QueryClient、全局 provider 组合
├── routers/
│   └── index.tsx             # BrowserRouter、Routes 与页面懒加载
├── api/
│   ├── generated/            # Orval 输出：禁止手改
│   ├── query-keys.ts         # §1.2 的稳定 key 工厂
│   └── client.ts             # token 注入、统一错误映射
├── pages/
│   ├── home.tsx              # project 列表 + 最近会话
│   ├── project/              # 某 project 的会话列表与创建表单
│   ├── conversation.tsx      # 主战场，两种模式共用
│   └── settings/             # 设置页、模型配置与 Runner 管理
├── pages/project/
│   ├── use-projects.ts       # CRUD；Runner 状态由事件刷新
│   ├── new-conversation.tsx  # §7.1 的模式选择
│   └── schemas.ts            # Zod schema；由 RHF 表单复用
├── conversation/
│   ├── store.tsx             # §3
│   ├── reducer.ts            # §5
│   ├── conversation-stream.ts     # §4，EventSource 生命周期与并发 owner
│   ├── conversation-stream.test.ts # controller 的真实状态机边界
│   ├── use-conversation-stream.ts # controller 的 React 适配与卸载 cleanup
│   ├── mutations.ts          # 发送 / 中断 / Decision，成功后失效 query
│   └── reducer.test.ts       # reducer 的事件投影边界
└── auth/
    └── provider.tsx
```

**没有业务型 `components/` 目录** —— 通用聊天 Block 在 `chat-ui`，
这里只有页面和它们的状态。shadcn/ui 安装的基础原语可放在 `components/ui/`；
它们不承载业务逻辑。真出现第二处业务复用再抽。

---

### 9.1 表单、可访问性与视觉约定

所有会提交用户输入的交互（新建 project、创建会话、设置、Decision）使用
React Hook Form 管理，Zod schema 同时提供字段校验和提交前解析：

```ts
const newProjectSchema = z.object({
  name: z.string().trim().min(1, "请输入项目名称").max(80),
  workspace: z.string().trim().min(1, "请输入 workspace 路径"),
})
```

- 表单错误显示在字段旁，并把焦点移到第一个无效字段；服务端返回的字段错误映射到对应字段，其余错误显示为可关闭的表单级提示。
- `pending` 时禁用重复提交但保留用户输入；失败后不清空。创建成功后才 reset 并导航。
- 优先采用 shadcn/ui 的组合方式和 Base UI 的语义/焦点管理。Dialog、Popover、Menu、Sheet 必须支持键盘操作、Esc 关闭、焦点恢复和可读名称。
- 使用 Tailwind v4 的主题 token（颜色、圆角、间距、阴影），不在业务页面散落硬编码色值。错误、运行中、断开等状态不能只依赖颜色，应同时有文字、图标或 aria 文本。
- Lucide 图标仅作辅助；纯装饰图标 `aria-hidden`，图标按钮必须有可访问名称。Motion 仅用于 150–250ms 的非关键反馈，并尊重 `prefers-reduced-motion`。

### 9.2 Query、Mutation 与 SSE 协作

| 事件 | 立即更新 | 同步 / 失效策略 |
|---|---|---|
| 进入会话 | `GET /messages` 作为 reducer 的初始快照 | 不创建 SSE；空闲连接状态为 `closed`，Composer 可立即输入和提交 |
| 发送消息 | reducer 乐观插入用户消息；controller 首次建流并等待 `open` | `open` 后才 POST；后续发送复用该流；成功后只把会话列表标记 stale，不立即 GET；失败按 §6 标红 |
| 收到 `message.end` / `run.end` | reducer 结束当前 run 状态 | SSE 跨 run 保持连接，避免紧接的 `nextRun` 丢事件；只把会话列表与 project runner 状态标记 stale，不立即 GET |
| 提交 Decision / 中断 | mutation pending 驱动按钮状态 | 成功后失效当前会话与相关列表；SSE 仍是进行中界面的即时来源 |
| Runner 状态轮询或推送改变 | project query 更新 | 只刷新 project / conversations 范围，不清空对话 reducer |
| `RESYNC` | 停止应用后续增量 | 按 §4 全量拉取、重建 reducer 基线后再恢复订阅 |

`QueryClient` 应在应用根部只创建一次。默认缓存时间、重试次数和窗口聚焦刷新需按
资源区分：会话/项目列表可刷新；SSE 只能由发送事务创建，不得因 mount、focus、token 刷新或 query 刷新建流。
所有 mutation error 都要映射为用户可理解的提示，保留服务端错误码供诊断。

`GET /messages` 只用于首次进入页面、显式重试历史加载和 `RESYNC`。正常发送、流式输出与
run 结束都不能靠重新拉历史消息刷新聊天窗口，否则页面会把真实流退化成终态快照模拟。

---

## 10. Phase 范围

**Phase 2**：§2–§9 全部。

**按需**：会话搜索、消息导出、Entry 树的分支导航 UI、Runner 运维视图、
project 归档、TODO 历史对比。都等实际用起来觉得缺再做。
