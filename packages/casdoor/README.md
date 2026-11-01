# @nova/casdoor

Casdoor SDK for browser apps backed by auth-service.

React 使用 `@nova/casdoor/client/react`；Provider 会启动和释放会话刷新。直接 `new CasdoorClient(config)` 时，构造函数只读取状态，挂载后调用 `client.start()`、卸载时 `client.destroy()`；`createCasdoorClient()` 与 Vue `initCasdoor()` 会自动启动。

回调要求同一标签页已保存的 OAuth state，缺失或不一致会拒绝交换。刷新在 client 内合并，退出后的旧异步响应不会恢复会话。需要页面刷新后保留会话时配置 `storage.type: 'sessionStorage'`；业务请求使用 SDK getter 获取当前 token，不拼接存储键。Nova 的完整接线见 [Casdoor 接入](../../docs/casdoor.md)。

## Install

```bash
pnpm add @nova/casdoor
```

## Client

Business code only needs the auth-service app name. Casdoor endpoint, client ID, org name, client secret, and certificate stay in auth-service.

```ts
import { initCasdoor } from '@nova/casdoor/client/vue';

initCasdoor({
  appName: 'trader',
  authApiBase: '/api',
  redirectUri: 'http://localhost:3000/callback',
  logoutRedirectUri: 'http://localhost:3000',
});
```

Tokens are stored in `localStorage` by default together with the calculated expiry time.

Callback page:

```ts
import { useCasdoorCallback } from '@nova/casdoor/client/vue';

// Uses built-in /api/apps/{app}/oauth/token exchange.
const { isLoading, success, error } = useCasdoorCallback();
```

## Business server

业务后端使用独立入口，直接调用 Auth Service，无需加载 Casdoor 管理 SDK 或配置 client secret/certificate：

```ts
import { createAuthServiceClient, AuthServiceError } from '@nova/casdoor/server/auth-service';

const auth = createAuthServiceClient({
  authApiBase: 'https://auth.example.com/api',
  tokenTransport: 'header', // Historical services may explicitly select 'query'.
  timeoutMs: 5000,
});

const identity = await auth.verifyAccessToken(accessToken, abortSignal);
// identity: { identityId, displayName, roles, active }
// Resolve identityId to a local user; check both identity.active and local suspension.
```

`AuthServiceError.code` 为 `INVALID_TOKEN`、`UNAVAILABLE` 或 `INVALID_RESPONSE`。业务 HTTP adapter 将前者映射为 401，后两者映射为 503。返回数据已经校验，只保留启用角色，管理员标志映射为 `admin`；资源归属与本地授权仍由业务服务判断。错误不携带 token、上游响应正文或 fetch cause。

原 `@nova/casdoor/server` 入口的 `CasdoorServer` 用于直接连接 Casdoor 的 Auth Service 或管理服务，仍需 secret/certificate；普通业务后端使用上述独立入口。

## Auth Service API

- `POST /api/apps/{app_name}/oauth/authorize-url`
- `POST /api/apps/{app_name}/oauth/signup-url`
- `POST /api/apps/{app_name}/oauth/token`
- `POST /api/apps/{app_name}/oauth/token/refresh`
- `GET /api/me`

[packages\casdoor\example](packages\casdoor\example)
