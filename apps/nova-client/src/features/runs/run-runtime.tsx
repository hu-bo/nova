import { useEffect, useMemo, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useIdentity } from '@/features/auth';
import { RunStreamManager } from './run-stream-manager';
import { RunStreamContext } from './run-context';

/**
 * 只导出组件的宿主模块：React Fast Refresh 要求边界模块只导出组件，
 * 上下文与 hook 放在 `run-runtime.context.ts`。
 */
export function RunRuntimeHost({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { identity } = useIdentity();
  const manager = useMemo(
    () => new RunStreamManager(identity?.identityId ?? 'anonymous', queryClient),
    [identity?.identityId, queryClient],
  );
  useEffect(() => manager.retainHost(), [manager]);
  return <RunStreamContext.Provider value={manager}>{children}</RunStreamContext.Provider>;
}
