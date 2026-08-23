# Nova 协作说明

## 核心规则

- 先改现有实现，再考虑新增
- 少抽象，少 wrapper，少 pass-through 层
- 控制流、状态、并发都要有唯一 owner
- Agent、TaskFlow、Runner、Tool 职责分离，决策和执行分离
- 优先组合和显式数据结构，不要为了模式而模式
- 保持 TypeScript 和 Rust 的惯用写法
- 只测试真实行为和边界，不测无意义包装层
- 发现坏设计就重构，不要继续叠补丁

## 生成代码

- 不要直接编辑生成产物
- `packages/runner-sdk/src/gen/`
- `apps/*/src/api/generated/`
- `**/drizzle/meta/`
- Rust `OUT_DIR` 里的 Protobuf 绑定

## 项目结构

- `packages/agent-core`：Agent Loop、上下文、会话、Decision、Record / Entry
- `packages/harness`：静态模块装配与约束校验
- `packages/coding-agent`：Coding 场景 prompt 与工具组合
- `packages/taskflow`：依赖图、并发、重试、超时、取消
- `packages/tools`：工具能力与语义
- `packages/model-adapters`：模型提供方适配
- `packages/runner-sdk`：Node.js / TypeScript 到 Rust Runner 的桥梁
- `packages/protocol`：浏览器与 `agent-server` 的协议层
- `packages/chat-ui`：纯展示组件
- `packages/casdoor`：Casdoor 集成
- `packages/logger`：日志能力
- `packages/skills`：技能资源
- `packages/runner`：Runner 相关脚本与发布入口
- `crates/runner`：Rust Runner 实现
- `apps/agent-server`：控制平面与存储编排
- `apps/agent-web-ui`：Web 外壳与会话界面
- `apps/model-gateway-client`：模型网关管理端
- `docs/`：设计、边界、契约、测试文档
- `proto/`：gRPC 契约源

## 业务文档地图

| 主题 | 入口 |
|---|---|
| 文档总索引 | `docs/README.md` |
| 仓库结构与边界 | `docs/repo-layout.md` |
| 设计原则 | `docs/idea.md` |
| 环境与启动 | `docs/setup.md` |
| 测试策略 | `docs/testing.md` |
| Agent 核心 | `docs/agent-core.md` |
| 编排层 | `docs/taskflow.md` |
| 工具层 | `docs/tools.md` |
| 模型适配层 | `docs/model-adapters.md` |
| Runner SDK | `docs/runner-sdk.md` |
| Rust Runner | `docs/runner.md` |
| Server 设计 | `docs/agent-server.md` |
| Web UI 设计 | `docs/agent-web-ui.md` |
| 模型网关 | `docs/model-gateway.md` |
| Chat UI | `docs/chat-ui.md` |
| Harness | `docs/harness.md` |
| Coding Agent | `docs/coding-agent.md` |
| 协议定义 | `docs/proto.md` / `docs/protocol.md` |

## 工作方式

- 修改前先找现有实现和现有能力，能复用就不新建
- 改某个模块时先确认它的职责边界，再动代码
- 涉及结构、边界、依赖方向时，先同步 `docs/repo-layout.md`
- 涉及协议、字段、状态机时，先同步对应模块文档
