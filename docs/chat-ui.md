# chat-ui

> `packages/chat-ui` — Block 渲染组件库。**纯展示：无网络、无存储、无全局状态。**
> 结构契约见 `repo-layout.md` §4.8。Phase 2。

---

## 1. 定位

**负责**

- Block 渲染器：`text` / `thinking` / `code` / `diff` / `file` / `tool_call` / `tool_result` / `error`
- Decision 交互组件：审批卡片、反问选项
- 消息列表与流式增量渲染
- `UploadCover` 文件拖放、文件选择、剪贴板截图和附件列表交互
- Composer 文本草稿、提交编排、模型和推理强度选择
- `RemoteExplorer`：由宿主提供目录数据的远程文件 / 目录选择弹窗
- **实例级渲染覆盖**：宿主可替换某种已知 block 的默认渲染

**不负责**（全部属于宿主 `agent-web-ui`）

- SSE / HTTP 连接、重连、订阅
- 状态管理、持久化、路由
- 鉴权、业务编排
- 应用外壳（导航、布局、设置页）

**依赖**：React + `packages/protocol`（type-only）+ shadcn/ui 风格的无状态交互原语、内容与图标渲染库。
当前使用 Base UI、Tailwind CSS、`react-markdown`、`remark-gfm`、`prism-react-renderer` 与 `lucide-react`，不自行维护 Markdown parser、tokenizer 或图标资产。

---

## 2. 为什么独立成包

"未来可能复用"是推测性理由（CLAUDE.md Rule 18 要防的）。
**当下就成立的理由是边界强制**：

独立包让 chat-ui 在**物理上**够不到 agent-server 内部和 agent-core 运行时，
只能消费 `protocol` 定义的 Block 类型。这把 idea.md §26 "UI 消费 Projection，
而非内部状态"从一条口头约定变成一条**编译期约束**。

未来接入 TUI / VSCode 插件时的复用是附带收益，不是主要理由。

### 防腐规则

1. 运行时依赖只允许 React、`protocol` 和无副作用的 UI / 内容渲染库；新增网络、全局状态或存储依赖视为越界
2. 不得 import 任何 nova 运行时包（`agent-core` / `agent-server` / `tools` / …）
3. 组件内不得出现 `fetch` / `EventSource` / `localStorage` / 全局 store

三条中任何一条被打破，说明职责划错了，**应先修边界而不是加依赖**。
建议用 lint 规则固化第 2、3 条，别靠 review 记性。

---

## 3. 对外 API 面

```tsx
<MessageList
  messages={ChatMessage[]}
  renderers?={BlockRenderers}
  onRetry?={(messageId: string) => void}
  onOpenPath?={(path: string, line?: number) => void}
/>

<BlockView block={Block} renderers?={BlockRenderers} onOpenPath?={callback} />

<DecisionPrompt
  request={DecisionRequest}
  resolved?={DecisionResponse}
  onResolve={(r: DecisionResponse) => void | Promise<void>}
/>

<TodoPanel items={Todo[]} collapsed?={boolean} />

<Composer
  disabled?={boolean}
  isRunning?={boolean}
  isAborting?={boolean}
  onAbort?={() => void | Promise<void>}
  models?={ComposerOption[]}
  model?={string}
  onModelChange?={(model: string) => void}
  reasoningEfforts?={ComposerOption[]}
  reasoningEffort?={string}
  onReasoningEffortChange?={(effort: string) => void}
  accept?={string}
  attachments?={ComposerAttachment[]}
  onAttachmentsChange?={(attachments: ComposerAttachment[]) => void}
  onAttachmentButtonClick?={() => void | Promise<void>}
  onSubmit={({ text, files, attachments, model, reasoningEffort }: ComposerSubmission) => void}
/>

<UploadCover
  files={File[]}
  onFilesChange={(files: File[]) => void}
  attachments?={UploadAttachment[]}
  onAttachmentsChange?={(attachments: UploadAttachment[]) => void}
>
  {({ trigger, onPaste }) => ReactNode}
</UploadCover>

<RemoteExplorer
  open={boolean}
  mode={"file" | "directory"}
  multiple?={boolean}
  loadDirectory={(path?, signal?) => Promise<RemoteExplorerListing>}
  onConfirm={(entries: RemoteExplorerEntry[]) => void}
  onClose={() => void}
/>

type BlockRenderer = (props: { block: Block; onOpenPath? }) => ReactNode
type BlockRenderers = Record<string, BlockRenderer>
```

`RemoteExplorer` 与 Composer 一样只管理瞬时交互；实例级 `renderers` 是唯一渲染扩展入口，不提供全局注册表。

`Composer` 只组合独立的 `UploadCover`，不直接实现上传交互。`UploadCover` 支持把浏览器本地文件
拖入覆盖区域、粘贴系统截图，并在宿主未提供
`onAttachmentButtonClick` 时使用原生文件选择器。宿主提供该回调时，附件按钮只上抛“打开选择器”意图；
宿主选择的远程附件通过受控 `attachments` 回传。组件通过 `onSubmit` 同时上抛本地 `File[]`
和受控附件元数据，文件读取、上传、进度、失败重试与持久化仍由宿主负责。只有附件而没有文本时也允许提交。

`RemoteExplorer` 不知道 Runner、HTTP 路径或权限。它只调用宿主传入的 `loadDirectory`，并负责
导航历史、面包屑、单击选择、双击进入目录、Cmd/Ctrl 切换、Shift 连选和键盘操作。
目录数据与最终选择的业务 owner 都是宿主；组件关闭后不缓存跨会话状态。
宿主传入 `isRunning` 与 `onAbort` 时，发送按钮会替换为中断按钮；中断请求及其状态仍由宿主负责。

模型与推理强度是受控选择：选项和当前值由宿主传入，变更通过回调上抛；没有选项时
不渲染对应控件。这样模型能力、默认值和持久化仍只有宿主一个 owner。

**所有交互通过 props 回调上抛，组件自己不发请求。** 这是“纯展示”的可检验定义：
消息、Decision、Composer 和 RemoteExplorer 都只能调用各自声明的 props 回调，没有隐式对外通路。

`TodoPanel` **没有 `onToggle`**：TODO 只能由 agent 通过 `todo_write` 修改
（`agent-core.md` §9.4 的唯一 owner 规则）。给用户一个勾选框会立刻产生
"用户勾了但模型不知道"的状态分裂。用户想改计划就直接说。

---

## 4. 流式渲染

组件是**受控的**：宿主把 `ChatMessage[]` 传进来，组件负责画。
增量更新由宿主改 state 驱动，chat-ui 不订阅事件流。

```text
SSE ──► agent-web-ui 的 reducer ──► ChatMessage[] ──► <MessageList/>
                （在宿主）              （props）
```

**reducer 在宿主不在这里。** 理由：reducer 需要知道重连、乱序、去重这些传输层的事，
那是宿主的职责。chat-ui 只认最终的 `ChatMessage[]`。

渲染性能三件事：

| 关注点 | 做法 |
|---|---|
| 长列表 | 消息级 `memo`，key 用 `message.id`；超过一定条数再上虚拟滚动，**不预先上** |
| 流式块 | 只有 `status === "streaming"` 的最后一条消息重渲染 |
| 自动滚动 | 用户手动上滚后停止跟随，回到底部恢复。这个交互不做会很难用 |

---

## 5. 各 Block 的渲染约定

| Block | 渲染 |
|---|---|
| `text` | Markdown（**只渲染，不解析结构**。结构已经在 Block 里了） |
| `thinking` | 默认折叠，视觉弱化。它是过程不是结论 |
| `code` | 语法高亮 + 复制按钮；有 `path` 时显示文件名并可点击（回调上抛） |
| `diff` | 行级 +/- 着色，折叠未变更区域，头部显示 `+added / -removed` |
| `file` | 单行文件条目，图标区分 file/dir |
| `tool_call` | 折叠卡片，标题是工具名 + 关键参数摘要；`status: "running"` 显示进度指示 |
| `tool_result` | 挂在对应 `tool_call` 卡片内展开，递归渲染 `blocks` |
| `todo` | 只读清单，`[ ] [~] [x] [!]` 四态；出现在消息流里表示"当时的计划" |
| `error` | 醒目样式，展示 `code` 与 `message` |

**`tool_call` 与 `tool_result` 用 `callId` 配对渲染成一个卡片**，不是两条独立消息。
这是最影响可读性的一处 —— 分开显示会让对话被工具噪音淹没。

`todo_write` 的 `tool_call` **不显示卡片**，只显示它产出的 `todo` block。
把"调用了 todo_write 工具"这件事讲给用户听没有意义，用户关心的是清单本身。

---

## 6. Decision 组件

```tsx
// approval
┌────────────────────────────────────────┐
│ ⚠ 需要确认                              │
│ bash: rm -rf ./build                   │
│                                        │
│ [ 允许 ]  [ 总是允许 ]  [ 拒绝 ]         │
└────────────────────────────────────────┘

// question
┌────────────────────────────────────────┐
│ ? 用哪种方式实现缓存？                    │
│ ○ Redis    ○ 内存    ○ 文件              │
│                        [ 提交 ]         │
└────────────────────────────────────────┘
```

| 要求 | 说明 |
|---|---|
| `risk: "exec"` 的审批要显示**完整命令**，不截断 | 截断会让人批准自己没看见的东西 |
| 已解决的 Decision 传入 `resolved` 后显示最终选择 | 回看时要知道当时批了什么 |
| 提交后立即禁用，等待 `onResolve` 返回 | 防重复提交；宿主返回 Promise 即可覆盖 REST 请求全过程，失败后重新启用 |
| 组件不做超时 | 超时是 agent-core 的策略（`agent-core.md` §6），UI 只反映状态 |

---

## 7. 目录结构

```text
packages/chat-ui/src/
├── index.ts
├── types.ts
├── message-list.tsx
├── block-view.tsx        # 分发 + 注册表
├── blocks/
│   ├── text.tsx
│   ├── thinking.tsx
│   ├── code.tsx
│   ├── diff.tsx
│   ├── file.tsx
│   ├── todo.tsx          # 与 TodoPanel 共用一个清单渲染
│   ├── tool.tsx          # tool_call + tool_result 配对渲染
│   └── error.tsx
├── decision-prompt.tsx
├── todo-panel.tsx
├── composer.tsx
├── upload-cover.tsx
├── remote-explorer.tsx
└── chat-ui.test.tsx
```

**没有 `theme/` / `hooks/` / `utils/` / `context/`。** 样式用 CSS 变量暴露给宿主覆盖，
不做主题系统 —— 只有一个消费者时那是纯成本。

---

## 8. Phase 范围

**Phase 2**：§3–§6 全部。

**按需**：虚拟滚动、代码块折叠、diff 的 side-by-side 视图、消息搜索。
都是"用起来觉得难受再做"的东西，不预先做。
