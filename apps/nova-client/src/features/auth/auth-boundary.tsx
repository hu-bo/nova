import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CasdoorProvider, useCasdoor, useCasdoorClient } from '@nova/casdoor/client/react';
import { useQueryClient } from '@tanstack/react-query';
import { configureAuth } from '@/api/transport';
import { Button } from '@/components/ui/button';
import {
  IdentityContext,
  useIdentity,
  type Identity,
  type IdentityState,
} from './identity.context';
const devAuthEnabled = import.meta.env.DEV && import.meta.env.VITE_AUTH_MODE === 'dev';
const DevLogin = devAuthEnabled ? lazy(() => import('./dev-login')) : null;
const authConfigured = !devAuthEnabled;
const authApiBase = import.meta.env.VITE_AUTH_BASE_URL || 'https://auth.8and1.cn/api';
const config = {
  appName: import.meta.env.VITE_AUTH_APP_NAME || 'nova',
  authApiBase:
    window.location.protocol === 'http:' ? authApiBase.replace(/^https:/i, 'http:') : authApiBase,
  redirectUri: `${window.location.origin}/callback`,
  storage: { type: 'sessionStorage' as const, prefix: 'nova_' },
  silentRefresh: true,
};
export function AuthBoundary({ children }: { children: ReactNode }) {
  return (
    <CasdoorProvider config={config}>
      <AuthBridge>{children}</AuthBridge>
    </CasdoorProvider>
  );
}
function AuthBridge({ children }: { children: ReactNode }) {
  const auth = useCasdoor();
  const client = useCasdoorClient();
  const queryClient = useQueryClient();
  const [dev, setDev] = useState<{ identity: Identity; token: string } | null>(null);
  const [ready, setReady] = useState(false);
  const devRef = useRef(dev);
  devRef.current = dev;
  const identity = useMemo<Identity | null>(
    () =>
      dev?.identity ??
      (auth.isAuthenticated && auth.user
        ? {
            identityId: auth.user.id,
            displayName: auth.user.displayName || auth.user.name,
            roles: auth.user.roles?.filter((role) => role.isEnabled).map((role) => role.name) ?? [],
          }
        : null),
    [dev, auth.isAuthenticated, auth.user],
  );
  const scope = identity?.identityId ?? 'anonymous';
  const [cacheScope, setCacheScope] = useState(scope);
  useEffect(
    () =>
      configureAuth({
        token: () => devRef.current?.token ?? client.getState().accessToken,
        refresh: async () => devRef.current !== null || (await client.refreshToken()),
        unauthorized: () => {
          setDev(null);
          client.logout();
        },
      }),
    [client, scope],
  );
  useEffect(() => {
    setReady(true);
  }, []);
  useEffect(() => {
    if (cacheScope !== scope) {
      void queryClient.cancelQueries();
      queryClient.clear();
      setCacheScope(scope);
    }
  }, [scope, cacheScope, queryClient]);
  useEffect(() => {
    if (!('BroadcastChannel' in window)) return;
    const channel = new BroadcastChannel('nova:identity');
    const reset = () => {
      setDev(null);
      client.logout();
      void queryClient.cancelQueries();
      queryClient.clear();
    };
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (
        typeof event.data === 'object' &&
        event.data &&
        'type' in event.data &&
        event.data.type === 'identity-changed'
      )
        reset();
    };
    return () => channel.close();
  }, [client, queryClient]);
  const value = useMemo<IdentityState>(
    () => ({
      identity,
      refreshing: auth.isLoading,
      authConfigured,
      login: auth.login,
      refresh: async () => devRef.current !== null || (await auth.refreshToken()),
      handleCallback: auth.handleCallback,
      signOut: () => {
        void queryClient.cancelQueries();
        queryClient.clear();
        setDev(null);
        client.logout();
        if ('BroadcastChannel' in window) {
          const channel = new BroadcastChannel('nova:identity');
          channel.postMessage({ type: 'identity-changed' });
          channel.close();
        }
      },
      ...(devAuthEnabled
        ? {
            devLogin: (token: string) => {
              const match = /^dev:([a-f0-9-]{36}):([a-z0-9-]{1,128})$/i.exec(token);
              if (!match?.[1] || !match[2]) throw new Error('请输入有效的开发令牌。');
              setDev({
                token,
                identity: {
                  localUserId: match[1],
                  identityId: match[2],
                  roles: [],
                  displayName: '本地开发者',
                },
              });
            },
          }
        : {}),
    }),
    [identity, auth, queryClient, client],
  );
  return (
    <IdentityContext.Provider value={value}>
      {ready && cacheScope === scope ? (
        <div key={scope}>{children}</div>
      ) : (
        <div className="grid min-h-dvh place-items-center" role="status">
          正在加载 Nova…
        </div>
      )}
    </IdentityContext.Provider>
  );
}

/** Public routes stay accessible; workspace routes retain their login boundary. */
export function RequireIdentity({ children }: { children: ReactNode }) {
  const { identity, login, refreshing } = useIdentity();
  const [error, setError] = useState('');
  if (identity) return children;
  return (
    <div className="grid min-h-dvh place-items-center p-5">
      <div className="w-full max-w-md rounded-2xl border bg-surface p-8 shadow-sm">
        <div className="mb-6 text-xl font-semibold tracking-tight text-accent">✦ Nova</div>
        <h1 className="text-2xl font-semibold">开始你的下一项工作</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          与 Agent 对话，连接项目与设备，随时查看执行进展。
        </p>
        {authConfigured ? (
          <Button
            className="mt-6 w-full"
            disabled={refreshing}
            onPress={() => {
              setError('');
              void login().catch(() => setError('暂时无法登录，请稍后重试。'));
            }}
          >
            登录 Nova
          </Button>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">登录服务尚未配置，请联系管理员。</p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
        {DevLogin && (
          <Suspense fallback={null}>
            <DevLogin />
          </Suspense>
        )}
      </div>
    </div>
  );
}
