import { configureAuth } from '@/api/transport';
import { useCasdoor, useCasdoorClient } from '@nova/casdoor/client/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { authConfigured, devAuthEnabled } from './auth-boundary.shared';
import { IdentityContext, type Identity, type IdentityState } from './identity.context';

export function AuthBridge({ children }: { children: ReactNode }) {
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
      ...(import.meta.env.DEV && devAuthEnabled
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
