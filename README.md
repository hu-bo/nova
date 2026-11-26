# Nova

Nova 是一个 AI 工作台，支持普通会话、项目会话、Goal、Spec 和产品 Skills。项目可以绑定 Runner 或 SSH 环境。仓库包含工作台、业务服务、模型管理台，以及共享聊天组件和 Agent 执行包。

- [文档导航](docs/README.md)
- [Nova 工作台本地开发](apps/nova-client/README.md)
- [模型管理台](apps/model-console/README.md)
- [Runner 安装](packages/runner/README.md)
- [部署手册](docs/guides/deployment.md)

## 本地 Harness Playground

在仓库根目录安装依赖并启动：

```sh
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:4175`。Playground 支持配置 OpenAI Chat Completions 兼容端点、模型 ID 和 API Key，运行单次 Agent Task 或带草稿审阅的两节点 Flow。代码位于 [demo/](demo/)。

共享聊天组件的用法、组件 Demo 和测试命令见 [Chat UI 包说明](packages/chat-ui/README.md)。Harness 的构建与测试见 [Harness 包说明](packages/harness/README.md)。
