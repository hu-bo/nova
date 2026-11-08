# Nova 仓库协作指南

## 工作方式

- 开工先看 `git status --short` 和适用的 `AGENTS.md`。保留已有改动，只编辑任务涉及的文件。交付前检查自己的 diff。
- 用 `rg` / `rg --files` 定位入口、现有实现、调用方和测试。先查对应 workspace，按需扩到依赖方。默认跳过生成目录、构建产物和 `submodule/`。
- 批量重构先用语法树或结构化规则圈定候选，再逐处确认语义。独立的读取和搜索可以并行，修改和验证按依赖顺序进行。
- 遇到局部缺陷，从正常入口追到负责该行为的模块，在源头修复。修改公共行为前，核对调用方、已有数据和失败路径。

## 代码要求

- 选择能完整解决问题的最小改动。沿用现有类型、函数、组件和模块边界。只有存在实际复用或清晰职责时，才提取 helper、公共模块或抽象层。
- 禁止新增嵌套三元。简单二选一可用三元。同一状态对应的文案、图标和样式放在同一张表，用 `satisfies Record<状态类型, 配置类型>` 检查覆盖。带优先级的分支用 guard clause、`if` 或 `switch`，保留既有判断顺序和兜底行为。
- 每份业务事实保留一个来源。从现有数据派生值，避免重复状态、平行类型和只转发参数的包装。命名写清业务含义，注释只解释约束或原因。
- 输入在边界校验，内部用明确的类型和错误处理。禁止用 `any`、随意断言或关闭 lint 来绕过类型问题。
- 数据访问优先用 drizzle-orm 类型化操作符，表名列名走 schema 对象引用，字段改名要编译报错。裸 SQL 只在 drizzle 表达不了或必须 set-based 时保留（advisory lock、SKIP LOCKED、VALUES 批量更新、INSERT..SELECT、jsonb 路径取值），且片段内用类型化列插值，不写手造列名字符串。
- 保持 diff 聚焦。依赖升级、全仓格式化、无关重命名和顺手清理单独处理。

## 从哪里找

| 改动                         | 入口与约束                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 产品页面、会话、查询和 SSE   | `apps/nova-client/src/features/`、`apps/nova-client/src/routes/`，模型管理页面在 `apps/model-console/`                                                                                                       |
| 聊天组件和跨端消息、事件契约 | `packages/chat-ui/` 负责展示和输入，宿主负责网络与持久化。共享契约和事件投影在 `packages/agent-ui-contracts/`                                                                                                |
| API、Worker 和数据           | `apps/nova-server/src/modules/`，数据库定义在 `apps/nova-server/database/`。跨业务模块走公开 `index.ts`，SQL 留在 Repository 或已有持久化层，事务由 Service 管理。见 [事务作用域](docs/transaction-scope.md) |
| Agent 执行和工具             | 从实际调用方追到 `packages/harness/`、`packages/coding-harness/` 或 `packages/tools/`                                                                                                                        |
| Runner、SDK 和通信协议       | `crates/runner/`、`packages/runner-sdk/`、`proto/runner/v1/`                                                                                                                                                 |

通过源定义更新生成物。产品 API 从服务端 schema 导出 OpenAPI，再生成客户端。模型管理台的输入在 `apps/model-console/openapi.json`。路由由文件路由生成，Runner 协议由 `proto/runner/v1/` 生成。

## 验证

- 从改动的包开始，先跑相关测试和类型检查，再按影响扩大范围。包名和脚本以各自 `package.json` 为准。根目录 `pnpm typecheck` 检查 Demo，应用和包用 `pnpm --filter <包名> typecheck`。
- 单文件测试用对应包的测试运行器。Vitest 用 `pnpm --filter <包名> exec vitest run <测试文件>`，服务端用 `pnpm --filter @nova/nova-server exec node --import tsx --test <测试文件>`。涉及数据库的集成测试使用专用的 `TEST_DATABASE_URL`，Runner 用 `cargo test -p nova-runner`。
- 执行生成命令前检查目标路径的已有改动。`@nova/nova-client` 的 `typecheck` 会重新生成 API 和路由。只检查现有客户端源码可运行 `pnpm --filter @nova/nova-client exec tsc -p tsconfig.app.json --noEmit`。
- 行为变更优先补到现有测试中。纯重构用已有测试或输入输出对照验证。收尾跑 `git diff --check`，总结实际通过、失败或跳过的检查。
