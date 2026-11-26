# Nova Client

基于 React、Vite、TanStack Router / Query、HeroUI 和共享 `@nova/chat-ui` 的 AI 工作台。

## 本地启动

1. 在仓库根目录运行 `pnpm install`。
2. 以 [服务端配置示例](../nova-server/.env.example) 为参考在 `apps/nova-server/.env` 配置服务端。使用本地 PostgreSQL，设置 `NODE_ENV=development` 与 `ROLE=all`。使用预设的本地测试身份时，前后端分别显式设置 `AUTH_MODE=dev` 与 `VITE_AUTH_MODE=dev`。默认登录流程见 [Casdoor 接入](../../docs/guides/casdoor.md)。
3. 将需要覆盖的前端变量写入本目录的 `.env`，参考 [前端配置示例](.env.example)。默认开发代理将 `/api` 和 `/health` 转发到 `http://127.0.0.1:9203`。

```powershell
pnpm --filter @nova/nova-server db:migrate
pnpm --filter @nova/nova-server dev
```

另开终端启动前端，打开 `http://127.0.0.1:8003`。

```powershell
pnpm --filter @nova/nova-client dev
```

## 功能说明

- [会话、项目与 Goal](../../docs/features/chat.md)
- [Spec 工作台](../../docs/features/spec.md)
- [Skills 与产物](../../docs/features/skills.md)
- [部署与代理配置](../../docs/guides/deployment.md)

## 验证与生成

```powershell
pnpm --filter @nova/nova-client check:boundaries
pnpm --filter @nova/nova-client test
pnpm --filter @nova/nova-client build
```

前端 REST 客户端使用 [服务端 OpenAPI](../nova-server/openapi.json)，路由树由文件路由生成。修改服务端契约时先运行 `pnpm --filter @nova/nova-server openapi:export`，再运行 `pnpm --filter @nova/nova-client api:generate`。应用的 `typecheck` 和 `build` 会运行生成步骤。仅检查现有源码时可运行 `pnpm --filter @nova/nova-client exec tsc -p tsconfig.app.json --noEmit`。
