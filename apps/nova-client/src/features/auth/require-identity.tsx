import { Button } from '@/components/ui/button';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { devAuthEnabled } from './auth-boundary.shared';
import { useIdentity } from './identity.context';

const DevLogin = import.meta.env.DEV && devAuthEnabled ? lazy(() => import('./dev-login')) : null;

const authConfigured = !devAuthEnabled;

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
