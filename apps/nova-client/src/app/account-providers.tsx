import { useIdentity } from '@/features/auth';
import { RunRuntimeHost } from '@/features/runs/runtime';
import { ModelSettingsProvider } from '@/features/settings';
import type { ReactNode } from 'react';

export function AccountProviders({ children }: { children: ReactNode }) {
  const { identity } = useIdentity();
  if (!identity) return children;
  return (
    <ModelSettingsProvider>
      <RunRuntimeHost>{children}</RunRuntimeHost>
    </ModelSettingsProvider>
  );
}
