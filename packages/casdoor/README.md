# @nova/casdoor

Casdoor SDK for browser apps backed by auth-service.

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

## Auth Service API

- `POST /api/apps/{app_name}/oauth/authorize-url`
- `POST /api/apps/{app_name}/oauth/signup-url`
- `POST /api/apps/{app_name}/oauth/token`
- `POST /api/apps/{app_name}/oauth/token/refresh`
- `GET /api/me`

[packages\casdoor\example](packages\casdoor\example)