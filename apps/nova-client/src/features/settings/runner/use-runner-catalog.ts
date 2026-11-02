import { useRunnersQuery, type Runner } from '@/features/runners';

/**
 * 源参考 `apps/agent-web-ui/src/pages/settings/runner/use-runners.ts` 中
 * `useRunnerCatalog` 的 nova-dsh 适配版。
 *
 * 源参考基于无限滚动分页 query；nova-dsh 的 `useRunnersQuery` 不分页，
 * 这里只暴露渲染层实际使用的 `runners` / `isLoading` / `error` / `refetch`。
 */
export function useRunnerCatalog() {
  const query = useRunnersQuery();
  return {
    runners: (query.data?.items ?? []) as Runner[],
    isLoading: query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}
