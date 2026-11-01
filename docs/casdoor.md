# Casdoor 接入

Casdoor 管理组织、用户、应用和登录方式，通过 OAuth/OIDC 授权码完成登录。Nova 复用现有 `@nova/casdoor`，业务系统经统一 Auth Service 接入，不配置 Casdoor clientSecret 或证书。

```text
nova-client / model-console → @nova/casdoor/client/react
  → Auth Service /api/apps/nova/oauth/authorize-url
  → Casdoor 登录 → UI /callback
  → Auth Service /api/apps/nova/oauth/token → {token,user}
UI → Authorization: Bearer access_token → nova-server
  → @nova/casdoor/server/auth-service → Auth Service /api/me → verified identity
  → users.identity_id 唯一映射 → Principal.localUserId → 资源 owner predicate
```

历史实现位于 `E:/Project/nova-master/nova-master` 的 `apps/agent-web-ui/src/auth`、`apps/agent-server/src/app/auth-service.ts`。学习结果另存于个人 skill `~/.codex/skills/casdoor-integration/`；项目运行不依赖该技能文件。

## 环境

服务端 `.env.example` 提供 `AUTH_MODE=casdoor`、`AUTH_SERVICE_URL`、`AUTH_SERVICE_TOKEN_TRANSPORT`、`AUTH_SERVICE_TIMEOUT_MS`。URL 是 Auth Service origin，路径由 adapter 添加 `/api/me`。默认 transport 为历史服务使用的 `query`；优先在服务支持后显式改成 `header`。不会自动降级把 token 加入 URL。query 模式需在 Auth Service 和代理上屏蔽 query 日志，Nova 不记录上游 URL 或 fetch error。

两个前端默认 Auth API 为 `https://auth.8and1.cn/api`，appName 为 `nova`；用 `VITE_AUTH_BASE_URL`、`VITE_AUTH_APP_NAME` 覆盖。Auth Service 与 Casdoor application 都必须允许每个实际 UI origin 的 `/callback`，Auth Service CORS 必须允许这些 origin。业务前端不能代替服务端配置白名单。

前后端默认均使用 Casdoor。本地离线开发显式设置前端 `VITE_AUTH_MODE=dev`、服务端 `AUTH_MODE=dev`。生产 loadConfig 拒绝 `NODE_ENV=production` 搭配 dev，前端生产构建也不会启用开发身份。三个应用的 dev 脚本、后端 build 和工作台 typecheck/build 都先构建 `@nova/casdoor`，防止使用缺失或过期的 dist。

nova-server 声明 `@nova/casdoor: workspace:*`，identity adapter 只将环境变量与 SDK 的错误转换为本项目的 DomainError；HTTP 请求、超时、响应校验和角色投影由 SDK 维护。独立服务端入口不导入 `casdoor-nodejs-sdk`，部署无需增加 Casdoor 管理凭据。

## 会话与授权

- 前端会话保存于本标签页 sessionStorage，刷新页面可恢复，关标签页后清除。两个 UI 使用独立 prefix。业务偏好和 Query cache 不保存 token。
- SDK 严格要求 pending state，重复 callback 共享交换；OAuth query 完成后清除。React StrictMode 重挂载会重新启动计时器，loading 不卸载回调与工作台。
- timer、REST 401 和 SSE 401 共享 SDK 刷新。刷新失败或缺少 refresh token 时退出；403 保留会话。退出后返回的旧刷新/回调响应不再恢复身份。
- local UUID 由数据库生成，不从浏览器/Casdoor id 猜测。唯一 identity_id 保证并发首次访问复用同一用户；upsert 不修改本地 active，保留本地封禁。
- `isForbidden` / `isDeleted` 用户拒绝登录；只采纳启用的 role。已验证的 isAdmin/isGlobalAdmin 映射为 admin，业务资源仍按本地 owner 检查。
- 当前每次请求向 Auth Service 验证，不缓存 token 或 principal，使上游撤销和本地 active 尽快生效。网络、超时和损坏响应返回 503；无效凭据返回 401。
- 退出/身份变化清空 Query cache，并由身份子树重建释放 SSE 与运行投影。UI 中的角色不作为服务端授权依据。

## 数据库与部署

运行前向 identity 唯一索引迁移。若已有重复 identity_id，迁移应失败并要求先核实业务资源归属；不能随意删除/合并用户。迁移不连接或修改旧 nova 数据库，部署延续现有 nova-dsh 独立数据库。

配置中心和发布脚本参见 [deployment.md](deployment.md)。配置预检只验证启动配置与导入；真实 SSO 验收需完成正常登录、刷新页面、退出、普通/管理员权限、错误回调及 Auth Service 故障。

## 来源与验证边界

协议参考：[Casdoor 接入](https://casdoor.ai/docs/how-to-connect/overview/)、[OAuth 2.0](https://casdoor.ai/docs/how-to-connect/oauth/)、[API token](https://casdoor.ai/docs/basic/public-api/)。自有 Auth Service 的路径和响应以历史项目实际代码为依据，不是 Casdoor 原生 API。

2026-11-01 Node.js 验证真实 Auth Service 时返回 `CERT_HAS_EXPIRED`，说明 TLS 证书链中存在过期证书，需修复服务端证书后才能验收。尚未核实真实服务的 Bearer 支持、CORS、回调白名单及帐号 SSO。本地测试通过可控服务覆盖认证边界，不能代替真实环境验收。

本次验证：nova-client 全量 112 项通过，nova-server 59 项通过、1 项真实 PostgreSQL 测试因缺少环境而跳过，model-console 21 项通过。SDK、后端和模型控制台构建通过；工作台编译/类型/主题/模块边界检查通过，但既有包体积门禁为 333.1 KiB gzip，超过 300 KiB。真实 PostgreSQL 迁移未执行（本机 Docker daemon 未启动）。

补充包接入验证：Auth Service 能力收拢到 `@nova/casdoor/server/auth-service` 后，SDK 新增 25 项测试通过；nova-server 构建及 59 项测试、model-console 类型检查及 21 项测试通过；nova-client 类型检查和认证/REST/SSE 共 22 项回归测试通过。已从 nova-server 实际导入并检查新入口的 ESM 与 CommonJS 两种产物，均未加载 `casdoor-nodejs-sdk`。

Playwright 使用合成帐号与受控网络响应验证了按钮登录、单次授权/交换、进入工作台、刷新恢复和退出清理；一次验收中捕获 1 次 authorize、1 次 exchange、20 次带 Bearer 的业务请求。证据与检查脚本保存在本地 `output/playwright/casdoor-*`，不包含真实凭据。
