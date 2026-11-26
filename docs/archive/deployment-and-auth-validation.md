# 发布及登录验证记录

本文保留切换 nova-dsh 和接入 Auth Service 期间的测量与验证。现行操作见 [部署手册](../guides/deployment.md) 和 [Casdoor 接入](../guides/casdoor.md)。

## 发布验证

早期前端流水线使用 300 KiB gzip 作为门槛，当时的初始 JS 测量值为 332.9 KiB。当前命令以部署手册为准。

此前在 Windows / Node 24.14.0 / pnpm 9.15.9 下完成：Compose 配置校验、独立目录 frozen-lockfile 检查、服务端构建、模型后台生产构建、`pnpm deploy` 打包及独立包导入、Drizzle 迁移文件检查和 Runner 协议 3 项测试。修正了 Runner 协议包入口指向未打包源码的问题。

发布命令内联后，三个 Drone 配置已通过 YAML / Shell 语法及格式校验，并模拟验证 9 种场景：三个应用发布成功、后端预检失败 / 迁移失败 / 健康检查失败 / 缺少配置、两个前端缺少入口文件。检查覆盖了备份、失败中止、前端不调用 Docker、各任务不改动其他应用目录，以及两个前端压缩包中的 `dist/index.html`。

本机 Docker Engine 未启动，未运行真实 Linux 容器，未连接线上数据库或执行线上发布。真实环境的 Node 22 容器、网络、配置中心、Nginx 和数据库连接仍需在上述阻塞解除后验收。

## 登录验证

2026-11-01 Node.js 验证真实 Auth Service 时返回 `CERT_HAS_EXPIRED`，说明 TLS 证书链中存在过期证书，需修复服务端证书后才能验收。尚未核实真实服务的 Bearer 支持、CORS、回调白名单及帐号 SSO。本地测试通过可控服务覆盖认证边界，不能代替真实环境验收。

本次验证：nova-client 全量 112 项通过，nova-server 59 项通过、1 项真实 PostgreSQL 测试因缺少环境而跳过，model-console 21 项通过。SDK、后端和模型控制台构建通过；工作台编译/类型/主题/模块边界检查通过，但既有包体积门禁为 333.1 KiB gzip，超过 300 KiB。真实 PostgreSQL 迁移未执行（本机 Docker daemon 未启动）。

补充包接入验证：Auth Service 能力收拢到 `@nova/casdoor/server/auth-service` 后，SDK 新增 25 项测试通过；nova-server 构建及 59 项测试、model-console 类型检查及 21 项测试通过；nova-client 类型检查和认证/REST/SSE 共 22 项回归测试通过。已从 nova-server 实际导入并检查新入口的 ESM 与 CommonJS 两种产物，均未加载 `casdoor-nodejs-sdk`。

Playwright 使用合成帐号与受控网络响应验证了按钮登录、单次授权/交换、进入工作台、刷新恢复和退出清理；一次验收中捕获 1 次 authorize、1 次 exchange、20 次带 Bearer 的业务请求。证据与检查脚本保存在本地 `output/playwright/casdoor-*`，不包含真实凭据。
