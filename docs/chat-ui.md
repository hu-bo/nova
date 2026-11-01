# Chat UI

`packages/chat-ui` 是纯展示、受控的 React 组件包。它不连接网络、不持久化数据、不读取全局状态，也不认识 Runner、Agent、路由或宿主 API。

## 数据流

```text
宿主 HTTP/SSE/reducer/store
          ↓ props
       @nova/chat-ui
          ↓ callbacks
宿主 mutation / uploader / directory loader
```

组件只通过 props 接收 `ChatMessage[]`、`Todo[]`、Decision 和附件状态，并通过回调上抛提交、审批、重试、取消、目录加载和选择结果。

## 公开组件

- `Chat`：高层组合边界。
- `MessageList` / `BlockView`：消息与结构化 Block。
- `DecisionPrompt` / `TodoPanel`：审批、反问和只读计划。
- `Composer` / `UploadCover`：文本、附件、模型、推理强度和 Skill 输入。
- `RemoteExplorer`：宿主提供目录数据的文件/目录选择器。

UI 投影类型暂时位于 chat-ui 自身的 `src/types.ts`，不复制服务端协议 schema。未来接入共享协议时，只在宿主边界增加映射。
