# nova-dsh 上线部署

nova-dsh 接替 nova，沿用 nova 的三个独立 Drone 配置。各应用分别构建、打包、SCP 上传并通过 SSH 发布，后端使用 Docker Compose。默认仅在 `master` 分支的 push / 手动构建触发，PR 不发布。

| 源码目录             | 当前包名                             | 服务器目录                     |
| -------------------- | ------------------------------------ | ------------------------------ |
| `apps/nova-client`   | `@nova/nova-client`                 | `/data/app/agent-web-ui/dist`  |
| `apps/nova-server`   | `@nova/nova-server`                 | `/data/app/agent-server`       |
| `apps/model-console` | `@nova/model-console`                | `/data/app/model-console/dist` |

`apps/model-console` 原名 `model-gateway-client`，目录、包名、Drone 任务名、上传路径和服务器目录已一并改名；nova-client、nova-server 仍沿用旧服务器目录。首次发布前先 `mv /data/app/model-gateway-client /data/app/model-console` 并把站点 root 指向新目录，或先发布再改 root，两种方式切换期间该站点都会短暂 404。新的 Drone 缓存卷 `/var/lib/drone-cache/pnpm/nova-dsh-model-console` 首次构建需要重新下载依赖。

## Drone 配置

沿用现有三个 Drone 任务，分别把 Configuration Path 指向对应应用的配置文件，并将源码来源切换为 nova-dsh：

| 应用          | Configuration Path              |
| ------------- | ------------------------------- |
| nova-client   | `apps/nova-client/.drone.yml`   |
| nova-server   | `apps/nova-server/.drone.yml`   |
| model-console | `apps/model-console/.drone.yml` |

每个任务都需要 checkout 整个 nova-dsh 仓库，构建命令从仓库根目录执行。仓库根目录不再提供统一发布的 `.drone.yml`。如果生产分支不是 `master`，修改三个文件中的 `trigger.branch`。停止旧 nova 的发布任务，避免覆盖同一组服务器目录。

日志出现 `does not match branch` / `no matching pipelines` 时，核对触发分支与 `trigger.branch`；`branch` 填 `master`，完整的 `refs/heads/master` 应写在 `trigger.ref`。`push` 和手动构建的 `custom` 事件都需要通过分支条件。修改配置后，使用包含修复的新提交重新构建。

日志出现 `No projects matched the filters` 时，核对 `pnpm --filter` 与应用 `package.json` 的 `name`。三个配置都通过 `APP_PACKAGE` 指定当前应用，并使用 `--fail-if-no-match`，避免未匹配到项目时跳过构建，直到复制产物才失败。

若日志是 `cannot find yaml` 且包含向 HTTP 地址发起的 POST 错误，先核对 Drone Server 的 `DRONE_YAML_ENDPOINT` 与配置扩展服务日志。`context canceled` 表示请求被取消，不能据此认定仓库缺少 YAML；需从 Drone Server 容器内确认扩展地址可达，并检查同一时刻服务是否重启、请求是否被取消或触及超时。配置扩展负责返回 YAML，只有返回 HTTP 204 时才回退到仓库配置，见 [Drone Configuration Extension](https://docs.drone.io/extend/config/)。

复用三个 Drone secrets：

| Secret                    | 用途                                                        |
| ------------------------- | ----------------------------------------------------------- |
| `CURRENT_HOST`            | 目标服务器地址                                              |
| `SSH_PWD`                 | 服务器 root 的 SSH 密码，端口 22                            |
| `API_CONFIG_TOKEN_SECRET` | 仅 nova-server 任务需要，用于拉取配置中心 `nova-server/env` |

构建和运行镜像统一为 `node:22-alpine`，要求 Node ≥ 22.18；pnpm 固定为仓库的 `9.15.9`。三个任务使用各自的缓存目录 `/var/lib/drone-cache/pnpm/nova-dsh-<应用名>`，不再叠加 restore/rebuild 插件。主机缓存卷要求 Drone 仓库设为 trusted，见 [Drone Host Volumes](https://docs.drone.io/pipeline/docker/syntax/volumes/host/)。每条流水线限制并发为 1，上传目录按应用名和构建编号隔离，三个应用可以分别发布。

三个任务均按 lockfile 筛选安装本应用及其 workspace 依赖，各自只构建本应用及所需共享包：

- nova-client 构建 contracts、Casdoor 和工作台前端，从已提交的 `apps/nova-server/openapi.json` 生成客户端，不构建或启动后端。
- nova-server 仅安装服务端及 workspace 依赖，通过 `pnpm -r --filter '@nova/nova-server...' run build` 按依赖顺序统一构建。流水线只有构建打包、SCP、发布三步；构建打包步骤内完成配置中心拉取和产物预检，使用 `pnpm deploy` 打包 `dist`、`database`、迁移 CLI、Compose 和发布预检脚本。入口为 `dist/src/server.js`，与旧 nova 的 `dist/server.js` 不同。
- model-console 通过自身 prebuild 构建 contracts、Casdoor，并从已提交的管理端快照生成客户端。

每个应用的构建、打包和 SSH 发布命令均直接写在自身 `.drone.yml` 中。两个前端直接打包 `dist`，后端打包独立运行目录；发布步骤解压、检查入口文件、备份并替换对应应用目录。前端发布不调用 Docker、拉取服务端配置或执行数据库迁移。契约有变化时，应在开发阶段更新相应 OpenAPI 快照并提交，再分别发布。

## 配置中心与数据库

参考 `apps/nova-server/.env.example`，将新环境变量写入现有配置中心条目：`http://config.8and1.cn/api/pull/nova-server/env`。流水线不读取仓库本地 `.env`。

- `DATABASE_URL` 指向已创建的 nova-dsh 数据库；Docker 内不要用 `127.0.0.1` 指代宿主机。PostgreSQL 可在 `shared_network` 中用服务名连接，宿主机数据库可用 `host.docker.internal`。
- **首次替换使用独立数据库。** 当前迁移从创建 `projects` 等表开始，与旧 nova 不兼容，不能直接指向旧库。若要保留旧 nova 的业务数据，需要另行完成数据迁移。
- `MODEL_CONFIG_ENCRYPTION_KEY` 必须为 64 位十六进制字符串；初次生成后保持稳定，修改会影响已存模型、SSH 和 Runner 凭据的解密。
- 生产设置 `NODE_ENV=production`、`AUTH_MODE=casdoor` 和 `AUTH_SERVICE_URL=https://auth.8and1.cn`；旧 `CASDOOR_ENDPOINT` 暂作 URL 别名，`CASDOOR_AUDIENCE` 不再需要。历史服务使用 `AUTH_SERVICE_TOKEN_TRANSPORT=query`，确认支持 Bearer 后改为 `header`。

Casdoor 验证器已接入 Auth Service `/api/me`，使用稳定身份 ID 唯一映射本地 UUID；新增 identity 唯一索引迁移必须随服务发布。生产预检检查配置和打包依赖，不代表已完成真实 SSO 验收。发布前按 [Casdoor 接入说明](casdoor.md) 核对回调白名单、CORS 与登录流程。

nova-client 的现有生产构建门禁也会中止自身发布：本地使用流水线同样的 Auth 环境变量构建，初始 JS 为 **332.9 KiB gzip**，超过仓库的 **300 KiB** 限额。需要完成前端体积优化后再发布，不影响另外两个任务的执行。

model-console 继续从已提交的管理端 `openapi.json` 快照生成代码；原生成脚本中的 `@nova/agent-server` 包在本仓库已不存在。新服务端目前只提供 Provider / Model 管理接口，尚未实现快照里的用量统计接口，因此用量页不能作为已迁移功能验收。

## 服务器与反向代理

服务器需安装 Docker Engine、Docker Compose v2，并已有 `shared_network` 外部网络。后端 Compose 项目名、服务名和容器名统一为 `nova-server`，工作目录及只读挂载目标为 `/data/app/agent-server`，HTTP 端口为 `9203`。首次改名发布时，流水线会在预检和迁移成功后停止、移除旧的 `nova-agent-server` 容器。当前 Runner 会话存在进程内，Worker 与 Runner 接入使用 `ROLE=all` 同进程，不单独启动 Worker 副本。

nova-client 和 model-console 构建时使用 `VITE_AUTH_BASE_URL=https://auth.8and1.cn/api`、`VITE_AUTH_APP_NAME=nova`；API / SSE 使用同源 `/api`。实际应用名不同需同步调整 Drone 环境变量和 Auth Service 的回调白名单。两个 UI 默认均使用 Casdoor；只有本地显式 `VITE_AUTH_MODE=dev` 才启用开发身份。

`deploy/nginx/nova-proxy.conf` 提供 SPA 回退、`/api/`、`/admin/`、`/health/`、SSE 及 Runner WebSocket 的配置，`nova-sites.conf.example` 展示如何放入现有站点。保留线上实际域名与 TLS 配置，修改后运行 `nginx -t` 再 reload。Nginx 若运行于 `shared_network` 的容器内，把代理地址换为 `nova-server:9203`，静态目录也应映射为容器可见路径。

**Runner 协议已变化：** nova-dsh 使用同一个 `9203` HTTP 服务的 `/runner/v1/connect` WebSocket，不监听旧 `9204` gRPC 端口。保留 `nova-grpc.8and1.cn` 时，要把旧 `grpc_pass` 改为 WebSocket 代理，并将 Runner 升级、地址改为 `wss://nova-grpc.8and1.cn/runner/v1/connect`。流水线不自动修改线上 Nginx 和 Runner。

Runner 单独通过 `.github/workflows/runner-release.yml` 发布，沿用 nova 的 `runner-v*` 标签、`@nnova/runner` npm 包及 Release 资产命名。Linux 保留 Rocky Linux 9 / glibc 2.34 构建，Windows 保留 Inno Setup 安装器。配置仓库的 `NPM_TOKEN` 后推送未发布过的版本标签即可触发四平台构建与发布；安装命令和产物说明见 [Runner 分发文档](../packages/runner/README.md)。安装器已适配当前 WebSocket 地址，Linux 安装脚本的默认下载地址在打包时指向本仓库的 Release。

## 发布顺序与恢复

nova-server 任务：

1. 构建服务端和所需共享包，打包后拉取生产 `.env`，校验生产配置、认证验证器和独立包导入。
2. SCP 上传 `nova-server.tar.gz`；解压到 `/temp/app/nova-dsh/nova-server/<构建编号>/release` 并再次预检。
3. 在暂存版本运行 `drizzle-kit migrate --config=database/drizzle.config.ts`，失败立即终止，旧后端文件和容器保持原状。不使用 schema push。
4. 停止旧容器，将旧后端目录移动到 `/data/app/nova-dsh-backups/nova-server-<构建编号>-<时间戳>/agent-server`，替换后端并启动。
5. 使用 `docker compose up -d --force-recreate --wait` 等待 Compose 中的 `/health/ready` 健康检查通过。失败会输出日志和备份位置。

两个前端任务各自构建并上传自己的压缩包，检查 `dist/index.html` 后备份、切换自己的静态目录，并设置 Nginx 读取权限。不会操作后端或另一个前端。备份位置为 `/data/app/nova-dsh-backups/<应用名>-<构建编号>-<时间戳>/<旧部署目录名>`。

**首次接替 nova 时，先完成新后端和反向代理的验收，再分别发布前端。** 三个任务之间没有自动发布顺序和健康状态依赖，后续按接口兼容关系安排发布。

这是单实例发布，后端重启期间有短暂停机。备份目录不自动清理；上传的临时文件仅在发布成功后清理。首次上线前应备份数据库。迁移可能已提交，**文件备份不等于数据库回滚**；恢复旧应用前先确认数据库兼容性。

需要恢复文件时，先停止新容器，将当前目录移到独立故障目录，再从日志里的备份位置恢复对应应用；在恢复后的 `/data/app/agent-server` 按该版本的 Compose 服务配置启动容器并检查健康状态。使用新配置时执行 `docker compose -p nova-server up -d`；恢复改名前的版本时使用该版本原有的项目名和容器名。不要把应用文件恢复当作旧 nova 数据库迁移方案。

## 本地验证

```bash
pnpm --fail-if-no-match --filter '@nova/nova-server...' install --frozen-lockfile
pnpm -r --fail-if-no-match --filter '@nova/nova-server...' run build
pnpm --fail-if-no-match --filter @nova/nova-server run openapi:export
pnpm --filter @nova/casdoor run build
pnpm --fail-if-no-match --filter @nova/nova-client run build
pnpm --fail-if-no-match --filter @nova/model-console run build
```

Compose 可使用不含真实凭据的独立环境文件执行 `docker compose --env-file <校验文件> -f apps/nova-server/docker-compose.yml config --quiet`。生产预检有意拒绝开发认证和缺失加密密钥，当前 Casdoor 占位实现也会被明确拒绝。

此前在 Windows / Node 24.14.0 / pnpm 9.15.9 下完成：Compose 配置校验、独立目录 frozen-lockfile 检查、服务端构建、模型后台生产构建、`pnpm deploy` 打包及独立包导入、Drizzle 迁移文件检查和 Runner 协议 3 项测试。修正了 Runner 协议包入口指向未打包源码的问题。

发布命令内联后，三个 Drone 配置已通过 YAML / Shell 语法及格式校验，并模拟验证 9 种场景：三个应用发布成功、后端预检失败 / 迁移失败 / 健康检查失败 / 缺少配置、两个前端缺少入口文件。检查覆盖了备份、失败中止、前端不调用 Docker、各任务不改动其他应用目录，以及两个前端压缩包中的 `dist/index.html`。

本机 Docker Engine 未启动，未运行真实 Linux 容器，未连接线上数据库或执行线上发布。真实环境的 Node 22 容器、网络、配置中心、Nginx 和数据库连接仍需在上述阻塞解除后验收。
