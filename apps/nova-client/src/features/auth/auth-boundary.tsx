import { CasdoorProvider } from '@nova/casdoor/client/react';
import { type ReactNode } from 'react';
import { AuthBridge } from './auth-bridge';

const authApiBase = import.meta.env.VITE_AUTH_BASE_URL || 'https://auth.8and1.cn/api';

const config = {
  appName: import.meta.env.VITE_AUTH_APP_NAME || 'nova',
  authApiBase:
    window.location.protocol === 'http:' ? authApiBase.replace(/^https:/i, 'http:') : authApiBase,
  redirectUri: `${window.location.origin}/callback`,
  storage: { type: 'localStorage' as const, prefix: 'nova_' },
  silentRefresh: true,
};

export function AuthBoundary({ children }: { children: ReactNode }) {
  return (
    <CasdoorProvider config={config}>
      <AuthBridge>{children}</AuthBridge>
    </CasdoorProvider>
  );
}
export { RequireIdentity } from './require-identity';
