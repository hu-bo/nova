# Nova

Nova 是一个以 Agent Loop 为核心、以 Rust Runner 为唯一执行平面的轻量 Coding Agent Runtime。

## 现状

- 已实现 `agent-core`、`harness`、`coding-agent`、`taskflow`、`tools`、`model-adapters`、`runner-sdk`、`crates/runner`
- 已具备 OpenAI / Anthropic 原生流适配、Runner SDK 与 Remote Rust Runner 主链路
- `apps/agent-server`、`apps/agent-web-ui`、`apps/model-gateway-client` 属于产品层，和执行核心分开演进

## 边界

- `@nova/runner-sdk` 是给服务端/Node 使用的 TypeScript gRPC SDK
- `crates/runner` 里的 `nova-runner` 是运行在用户机器上的 Rust 执行器
- 不要把二进制职责塞进 SDK，不要把 HTTP / SSE / UI 逻辑塞进核心包

## 项目结构

- `packages/agent-core`：Agent Loop、上下文、会话、Decision、Record / Entry 基础模型
- `packages/harness`：静态模块装配与约束校验
- `packages/coding-agent`：Coding 场景 prompt 与工具编排
- `packages/taskflow`：依赖图、并发、重试、超时、取消
- `packages/tools`：工具语义与具体能力
- `packages/model-adapters`：模型提供方适配
- `packages/runner-sdk`：Node.js / TypeScript 到 Rust Runner 的桥梁
- `packages/protocol`：浏览器与 `agent-server` 的协议层
- `packages/chat-ui`：纯展示组件
- `packages/casdoor`：Casdoor 集成封装
- `packages/logger`：日志能力
- `packages/skills`：技能资源
- `packages/runner`：Runner 相关脚本与发布入口
- `crates/runner`：Rust Runner 实现
- `apps/agent-server`：控制平面与存储编排
- `apps/agent-web-ui`：Web 外壳与会话界面
- `apps/model-gateway-client`：模型网关管理端
- `docs/`：设计、边界、契约与测试文档
- `proto/`：gRPC 契约源

## 常用命令

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm proto:generate
```

## 业务文档地图

| 主题 | 入口 |
|---|---|
| 文档总索引 | [docs/README.md](docs/README.md) |
| 仓库结构与边界 | [docs/repo-layout.md](docs/repo-layout.md) |
| 设计原则 | [docs/idea.md](docs/idea.md) |
| 环境与启动 | [docs/setup.md](docs/setup.md) |
| 测试策略 | [docs/testing.md](docs/testing.md) |
| Agent 核心 | [docs/agent-core.md](docs/agent-core.md) |
| 编排层 | [docs/taskflow.md](docs/taskflow.md) |
| 工具层 | [docs/tools.md](docs/tools.md) |
| 模型适配层 | [docs/model-adapters.md](docs/model-adapters.md) |
| Runner SDK | [docs/runner-sdk.md](docs/runner-sdk.md) |
| Rust Runner | [docs/runner.md](docs/runner.md) |
| Server 设计 | [docs/agent-server.md](docs/agent-server.md) |
| Web UI 设计 | [docs/agent-web-ui.md](docs/agent-web-ui.md) |
| 模型网关 | [docs/model-gateway.md](docs/model-gateway.md) |
| Chat UI | [docs/chat-ui.md](docs/chat-ui.md) |
| Harness | [docs/harness.md](docs/harness.md) |
| Coding Agent | [docs/coding-agent.md](docs/coding-agent.md) |
| 协议定义 | [docs/proto.md](docs/proto.md) / [docs/protocol.md](docs/protocol.md) |

## 使用顺序

第一次看这个仓库，优先读 [docs/repo-layout.md](docs/repo-layout.md) 和 [docs/README.md](docs/README.md)，再看对应模块文档。要改某个模块时，先确认它的职责边界，再动代码。
