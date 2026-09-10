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

## 数据库结构同步与部署

`src/db/schema.ts` 是数据库结构的来源。配置 `DATABASE_URL` 后运行
`pnpm --filter @nova/agent-server db:push`，Drizzle Kit 会读取实际数据库结构并
执行差异 SQL：已有且一致的表保留，缺少的表或字段新增。此流程不依赖
`drizzle.__drizzle_migrations`，旧库无需补记迁移历史即可创建缺失的 `runs` 表。

`push` 是结构差异同步，不是仅追加模式，也可能生成修改或删除操作。配置关闭
每次必问的 `strict`，部署不使用 `--force`；Drizzle 检测到需要数据丢失确认的操作时，
非交互部署会停止，交由人工检查。同步范围限定在 `public`。结构同步不会执行
历史 SQL 中的数据清理或回填；需要的数据变更单独处理。

Drone 构建从配置中心拉取 `.env`，显式复制到部署包根目录；打包前和服务器解包后
都检查文件非空。宿主机部署目录 `/data/app/agent-server` 整体挂载到容器的
`/app/agent-server`，其中包含 `.env`；Compose 同时通过 `env_file` 注入环境变量。
服务从当前工作目录加载 `.env`。部署包显式包含 `src/db/schema.ts` 和
`drizzle.config.ts`，供容器内的 Drizzle Kit 使用。

Drone 在启动服务前通过同一个 Compose 服务配置执行：

```sh
docker compose run --rm --no-deps -T agent-server node node_modules/drizzle-kit/bin.cjs push --config=drizzle.config.ts
```

输出保存在宿主机 `/data/app/agent-server/logs/schema-sync.log` 并回显到 Drone。
当前 Drizzle Kit 某些失败路径返回零退出码，因此流水线同时要求日志明确报告
`Changes applied` 或 `No changes detected`，否则禁止启动新版本。
同步成功后执行 `docker compose up -d --force-recreate agent-server`。
如果在 CI 遇到每次确认导致的 TTY 错误，检查部署目录中的 `drizzle.config.ts` 是否
仍为 `strict: true`，应更新为 `false`；当前版本的 CLI `--strict=false` 无法覆盖文件中的 `true`。
服务启动仍校验数据库连接及 `runs` 表结构，失败时不启动恢复扫描或监听端口。

历史 SQL、meta 和 `db:migrate` 命令保留供明确采用迁移历史的环境使用；当前部署
统一使用 `db:push`，不混用历史迁移来修复同步过的数据库，不手工修改生成的 meta。

数据库恢复测试使用单独的 `NOVA_TEST_DATABASE_URL`，必须指向已迁移的临时数据库，
不会回退读取应用 DATABASE_URL 或 .env。运行：
`pnpm --filter @nova/agent-server exec vitest run src/db/recovery.integration.test.ts`。
默认模型请求上限 20 分钟，逻辑 run 总期限 1 小时、最多 100 turn，同一步骤最多恢复 3 次。
这些限制跨重启累计；配置入口为 AgentConfig，不要通过重复新建 prompt 绕过。
