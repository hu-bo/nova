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

Drone 构建从配置中心拉取 `.env`，显式复制到部署包根目录；打包前和服务器解包后
都检查文件非空。宿主机部署目录 `/data/app/agent-server` 整体挂载到容器的
`/app/agent-server`，其中包含 `.env`，无需单独挂载；Compose 同时通过 `env_file`
注入环境变量。服务从当前工作目录
加载 `.env`，本地通过应用的 pnpm 脚本启动，容器通过 `working_dir` 保持相同约定，
避免打包改变源码相对路径后找不到配置文件。

Drone 部署在启动服务前，通过同一个 Compose 服务配置运行
`docker compose run --rm --no-deps -T agent-server node dist/migrate.js`。
本地 `db:migrate` 与部署使用同一个 `src/db/migrate.ts` 入口，读取环境变量
`DATABASE_URL`，直接调用 Drizzle ORM migrator，沿用 `drizzle/` 下的 SQL、journal
及数据库中的 `drizzle.__drizzle_migrations`。当前 Drizzle Kit 进度条在迁移失败时
直接退出而不打印异常，因此迁移入口自行打印错误及其 cause（含 PostgreSQL 错误码），
关闭连接后以非零状态退出。不要删除迁移记录来消除 already exists 的 NOTICE。
迁移与服务使用相同的 `.env` 和网络；迁移失败立即终止部署。服务启动先验证连接与
`runs` 表结构，再启动 Runner 监听和恢复扫描，避免缺表时持续刷错误日志。
流水线迁移关闭 TTY，将标准输出和错误先写入容器 `logs/migrate.log`，再回显到 Drone，
并保留迁移退出码。失败后可在宿主机 `/data/app/agent-server/logs/migrate.log`
查看本次完整日志；后续重新部署会替换部署目录，排查时应先保留该日志。
已有部署遇到 `relation "runs" does not exist` 时，在 `/data/app/agent-server` 执行上述
迁移命令，成功后执行 `docker compose up -d --force-recreate agent-server`。

数据库恢复测试使用单独的 `NOVA_TEST_DATABASE_URL`，必须指向已迁移的临时数据库，
不会回退读取应用 DATABASE_URL 或 .env。运行：
`pnpm --filter @nova/agent-server exec vitest run src/db/recovery.integration.test.ts`。
默认模型请求上限 20 分钟，逻辑 run 总期限 1 小时、最多 100 turn，同一步骤最多恢复 3 次。
这些限制跨重启累计；配置入口为 AgentConfig，不要通过重复新建 prompt 绕过。
