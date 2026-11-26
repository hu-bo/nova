# Nova 文档导航

现行功能页描述仓库当前代码。部署和生产启用情况以目标环境的配置与发布记录为准。

## 产品功能

| 功能 | 正式入口 | 代码归属 |
| --- | --- | --- |
| Chat、项目会话、Goal、Runner 和 SSH | [会话与项目环境](features/chat.md) | [工作台会话](../apps/nova-client/src/features/conversations/) · [会话服务](../apps/nova-server/src/modules/conversations/) · [运行服务](../apps/nova-server/src/modules/runs/) |
| Spec | [Spec 工作台](features/spec.md) | [工作台](../apps/nova-client/src/features/specs/) · [规格服务](../apps/nova-server/src/modules/specs/) |
| Skills 与文件产物 | [Skills 与产物](features/skills.md) | [技能目录](../apps/nova-client/src/features/skills/) · [技能服务](../apps/nova-server/src/modules/skills/) · [产物服务](../apps/nova-server/src/modules/artifacts/) |
| 模型管理与用量 | [模型管理台](../apps/model-console/README.md) | [管理接口](../apps/nova-server/src/modules/model-config/) |

## 使用与运维

- [工作台本地开发](../apps/nova-client/README.md) · [共享 Chat UI](../packages/chat-ui/README.md) · [Harness 测试](../packages/harness/docs/TESTING.md)
- [部署](guides/deployment.md) · [Casdoor 登录](guides/casdoor.md) · [Runner 安装](../packages/runner/README.md) · [Runner 连接与排障](guides/runner-troubleshooting.md)

## 当前架构与实现

- [事务作用域](architecture/transaction-scope.md) · [运行时持久化](architecture/runtime-performance.md) · [Runner 协议源文件](../proto/runner/v1/)

## 设计方案

- 架构和迁移设计见 [前端架构](design/nova-client.md)、[后端架构](design/nova-server.md) 与 [Coding Harness 重构设计](design/coding-harness-architecture.md)。
- 产品原始方案见 [Spec 首版方案](design/nova-sdd-mode.md)、[Skills 与产物设计](design/nova-skills.md)、[Skills 分期任务及进度](design/nova-skills-todo.md) 与 [求职教练 P0 设计](design/career-coach-skill.md)。现行操作步骤以上方功能入口为准。
- OpenCode 资料见 [ACP 试点方案](design/opencode-runtime-alternatives.md) 与 [HTTP/SSE 候选方案](design/opencode-runtime-design.md)。

## 迭代归档

- 会话和重构记录见 [聊天协议重构](archive/chat-protocol-optimization-plan.md)、[早期会话和 SSH 交付](archive/chat-project-goal-ssh.md) 与 [2026-11-12 重构审计](archive/refactoring-audit.md)。
- 运维历史见 [旧 gRPC Runner](archive/runner-features-and-error-handling.md) 与 [发布及登录验证记录](archive/deployment-and-auth-validation.md)。

## 维护文档

跨模块产品行为维护在 `docs/features/` 的对应功能页，包用法跟随包的 README。运维步骤放在 `guides/`，当前实现机制放在 `architecture/`，设计方案及跟踪中的任务放在 `design/`，已结束的验证与历史实现放在 `archive/`。功能、权限、默认值或操作流程变更时，在同一变更更新对应页面。接口和协议更改遵循 [仓库的生成约定](../AGENTS.md)。

提案保留当时的取舍和交付链接。迭代收尾时将已核实的行为补回功能页，讨论和验收从原迭代记录或 Git 历史追溯。
