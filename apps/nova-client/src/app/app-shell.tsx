import { RequireIdentity } from '@/features/auth';
import { Outlet, useLocation } from '@tanstack/react-router';
import { WorkspaceShell } from './workspace-shell';

export function AppShell() {
  const { pathname } = useLocation();
  if (pathname === '/' || pathname === '/callback') return <Outlet />;
  return (
    <RequireIdentity>
      <WorkspaceShell />
    </RequireIdentity>
  );
}
