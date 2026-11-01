import { createRootRouteWithContext } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { AppShell } from '@/app/app-shell';
import { RouteNotFound } from '@/app/route-feedback';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: AppShell,
  notFoundComponent: RouteNotFound,
});
