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
- `Composer`：输入文本、选择或移除文件、粘贴系统截图，以及选择模型和推理强度。

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
  return <MessageList messages={messages} />;
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

  function send({ text, files, model, reasoningEffort }: ComposerSubmission) {
    // 宿主在这里上传 files，并把文本、模型和推理强度发送给服务端。
    console.log({ text, files, model, reasoningEffort });
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
只有附件、没有文本时也可以发送。`onSubmit` 收到浏览器原生 `File[]`，实际上传及错误处理由宿主完成。

## 开发命令

在仓库根目录执行：

```bash
# 安装依赖
pnpm install

# 启动带 mock 数据和完整交互的组件 Demo（http://127.0.0.1:4175）
pnpm --filter @nova/chat-ui dev

# 类型检查
pnpm --filter @nova/chat-ui typecheck

# 运行测试
pnpm --filter @nova/chat-ui test

# 运行整个仓库的类型检查
pnpm typecheck

# 运行整个仓库的测试
pnpm test
```

更完整的职责边界与组件契约见 [`docs/chat-ui.md`](../../docs/chat-ui.md)。
