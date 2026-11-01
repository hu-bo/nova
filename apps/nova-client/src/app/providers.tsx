import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { Spinner, Toast } from '@heroui/react';
import type { ReactNode } from 'react';

/** 与下方 <Toast.Provider placement> 及 <Toast placement> 保持一致（堆叠方向/变换原点依赖它）。 */
const TOAST_PLACEMENT = 'top' as const;
import { AuthBoundary, useIdentity } from '@/features/auth';
import { RunRuntimeHost } from '@/features/runs/runtime';
import { ModelSettingsProvider, PreferencesProvider } from '@/features/settings';

export function AppProviders({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      {/*
        HeroUI 默认渲染在 ≤768px 时把操作按钮塞进文字列导致换行（源码 isMobile 分支）。
        这里复刻默认结构但让按钮始终留在行内右侧，并抵消移动端为堆叠布局准备的 mt。
      */}
      <Toast.Provider placement={TOAST_PLACEMENT}>
        {({ toast: item }) => {
          const { actionProps, description, indicator, isLoading, title, variant } =
            item.content ?? {};
          return (
            <Toast placement={TOAST_PLACEMENT} toast={item} variant={variant}>
              {indicator === null ? null : (
                <Toast.Indicator variant={variant}>
                  {isLoading ? <Spinner color="current" size="sm" /> : indicator}
                </Toast.Indicator>
              )}
              <Toast.Content>
                {title ? <Toast.Title>{title}</Toast.Title> : null}
                {description ? <Toast.Description>{description}</Toast.Description> : null}
              </Toast.Content>
              {actionProps?.children ? (
                <Toast.ActionButton
                  {...actionProps}
                  className={'mt-0 shrink-0 self-center ' + (actionProps.className ?? '')}
                />
              ) : null}
              <Toast.CloseButton />
            </Toast>
          );
        }}
      </Toast.Provider>
      <PreferencesProvider>
        <AuthBoundary>
          <AccountProviders>{children}</AccountProviders>
        </AuthBoundary>
      </PreferencesProvider>
    </QueryClientProvider>
  );
}

function AccountProviders({ children }: { children: ReactNode }) {
  const { identity } = useIdentity();
  if (!identity) return children;
  return (
    <ModelSettingsProvider>
      <RunRuntimeHost>{children}</RunRuntimeHost>
    </ModelSettingsProvider>
  );
}
