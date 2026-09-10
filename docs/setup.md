# 本地安装准备

本仓库采用一个 TypeScript `pnpm` workspace 和一个 Rust Cargo workspace。Phase 1 核心链路、浏览器协议包与 Chat 渲染包已有实现；其余应用仍按 Phase 2 推进。

## 前置工具

- Node.js `>= 22.19`
- pnpm `>= 9.15.9`（建议通过 Corepack 管理）
- Rust `>= 1.85`，包含 `cargo` 与 `rustfmt`
- Buf CLI（可由根目录的开发依赖提供）
- Protocol Buffers 编译环境（Rust `tonic-build` 后续会使用）

## 安装依赖

在仓库根目录分别执行：

```powershell
corepack enable
pnpm install
cargo fetch
```

不要手工修改 `packages/runner-sdk/src/gen/`；该目录是 Protobuf 生成产物。协议源变化后用以下命令重新生成：

```powershell
pnpm proto:generate
```

## 当前范围

- Phase 1：`agent-core`、`taskflow`、`tools`、`model-adapters`、`runner-sdk`、`proto`、Rust Runner 与集成测试。
- Phase 2 的 `protocol` 与 `chat-ui` 已实现；`agent-server`、`agent-web-ui`、`model-gateway` 和 `model-gateway-client` 尚未实现。
- `casdoor/` 和 `pi-main/` 是已有内容；前者作为共享鉴权库工作区成员，后者保留为参考项目，不纳入 Nova 的构建或改动范围。

## 持久化运行升级

上线此版本前，在 agent-server 配置正确的 DATABASE_URL 后执行
`pnpm --filter @nova/agent-server db:migrate`，再启动新服务。新增 runs 表保存当前
checkpoint，历史 Entry / Record 保留。SQL 和 Drizzle 生成的 meta 一同进入版本控制，
使新检出的工作区能执行相同迁移；meta 只通过生成器更新，不手工编辑。

数据库恢复测试使用单独的 `NOVA_TEST_DATABASE_URL`，必须指向已迁移的临时数据库，
不会回退读取应用 DATABASE_URL 或 .env。运行：
`pnpm --filter @nova/agent-server exec vitest run src/db/recovery.integration.test.ts`。
默认模型请求上限 20 分钟，逻辑 run 总期限 1 小时、最多 100 turn，同一步骤最多恢复 3 次。
这些限制跨重启累计；配置入口为 AgentConfig，不要通过重复新建 prompt 绕过。
