# @nova/chat-ui

Nova 的聊天展示组件库，提供消息、结构化 Block、Decision、TODO 和输入区组件。

组件内部基于 shadcn/ui 的源码分发模式构建，交互原语使用 Base UI，并通过 Tailwind CSS 与 Lucide 图标保持统一视觉语言。

组件只负责渲染和收集用户输入，不请求接口、不保存业务数据，也不持有全局状态。
宿主应用负责 HTTP / SSE、文件上传、会话状态、模型配置和持久化。

## 组件

- `MessageList`：渲染消息列表并配对工具调用与结果。
- `BlockView`：渲染单个 `text`、`thinking`、`code`、`diff`、`file`、`tool_call`、`tool_result`、`todo` 或 `error` Block。
- `DecisionPrompt`：展示审批或反问，并通过回调提交选择。
- `TodoPanel`：展示只读任务清单。
- `Composer`：输入文本、组合 `UploadCover`，以及选择模型和推理强度。
- `UploadCover`：统一处理文件拖放、粘贴、原生选择、附件列表和附件按钮。
- `RemoteExplorer`：浏览宿主提供的远程目录，可复用于目录选择和文件多选。

## 用法

包由 pnpm workspace 管理，仓库内应用可以直接声明依赖：

```json
{
  "dependencies": {
    "@nova/chat-ui": "workspace:*"
  }
}
```

渲染消息：

```tsx
import "@nova/chat-ui/styles.css";
import { MessageList } from "@nova/chat-ui";
import type { ChatMessage } from "@nova/protocol";

export function Conversation({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="nova-chat">
      <MessageList messages={messages} />
    </div>
  );
}
```

使用输入区：

```tsx
import { useState } from "react";
import { Composer, type ComposerSubmission } from "@nova/chat-ui";

const models = [
  { value: "gpt-5", label: "GPT-5" },
  { value: "claude-sonnet", label: "Claude Sonnet" },
];

const reasoningEfforts = [
  { value: "off", label: "关闭" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

export function ChatComposer() {
  const [model, setModel] = useState("gpt-5");
  const [reasoningEffort, setReasoningEffort] = useState("medium");

  function send({ text, files, attachments, model, reasoningEffort }: ComposerSubmission) {
    // 宿主在这里上传本地 files；attachments 是宿主已准备好的受控附件。
    console.log({ text, files, attachments, model, reasoningEffort });
  }

  return (
    <Composer
      models={models}
      model={model}
      onModelChange={setModel}
      reasoningEfforts={reasoningEfforts}
      reasoningEffort={reasoningEffort}
      onReasoningEffortChange={setReasoningEffort}
      accept="image/*,.pdf,.txt,.md"
      onSubmit={send}
    />
  );
}
```

点击“添加文件”可以选择多个文件；在消息输入框粘贴系统截图，会把剪贴板图片加入待发送附件。
也可以把本地文件直接拖入输入区。只有附件、没有文本时也可以发送。`onSubmit` 收到浏览器原生
`File[]` 和通用 `attachments`，实际上传及错误处理由宿主完成。传入 `onAttachmentButtonClick` 后，
附件按钮会调用宿主选择器；未传时继续使用浏览器原生文件选择框。受控附件通过 `attachments` 和
`onAttachmentsChange` 管理，提交成功后 Composer 会用空数组通知宿主清空它们。
这些上传交互由独立的 `UploadCover` 实现；它也可以脱离 Composer 使用，并通过 render prop
把 `trigger` 与 `onPaste` 交给宿主布局。

浏览远程目录：

```tsx
import { RemoteExplorer, type RemoteExplorerListing } from "@nova/chat-ui";

async function loadDirectory(path?: string, signal?: AbortSignal): Promise<RemoteExplorerListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const response = await fetch(`/api/files${query}`, { signal });
  return response.json();
}

<RemoteExplorer
  open={pickerOpen}
  onClose={() => setPickerOpen(false)}
  mode="file"
  multiple
  loadDirectory={loadDirectory}
  onConfirm={(entries) => addAttachments(entries)}
/>;
```

单击选择，双击目录进入；多选支持 `Shift` 连选、`⌘/Ctrl` 切换和 `⌘/Ctrl+A` 全选。
目录模式在未选中子目录时会选择当前目录，因此根目录同样可选。目录数据完全由宿主的
`loadDirectory` 提供，组件不请求业务接口。

## 开发命令

在仓库根目录执行：

```bash
# 安装依赖
pnpm install

# 启动真实模型 Harness Lab（http://127.0.0.1:4175）
pnpm dev

# 类型检查 Harness Lab
pnpm typecheck

# 构建 Harness 与本地 Playground
pnpm build

# 运行 Harness 测试
pnpm --filter @nnova/harness test
```

更完整的职责边界与组件契约见 [`docs/chat-ui.md`](../../docs/chat-ui.md)。

`demo/` 是本地 Harness Playground，兼容 OpenAI Chat Completions 的供应商可通过 Base URL、模型 ID 和 API Key 接入。
它提供单次 Agent Task 和两节点草稿审阅 Flow；模型密钥仅保留在本地服务进程内存中，页面关闭或 Runtime 释放后会清理。

启动后选择 OpenAI、DeepSeek 或自定义兼容端点，填写供应商支持的模型 ID 和 API Key，再创建 Runtime。Task 模式走
Task Engine → Agent → Model/Tool；Flow 模式额外通过输出绑定把草稿传给审阅 Agent。示例工具只有北京时间和四则运算，
不会依赖项目业务服务。模型第一次真实请求发生在发送消息时。






