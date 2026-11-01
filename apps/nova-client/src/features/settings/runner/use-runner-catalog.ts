import { useRunnersQuery, type Runner } from '@/features/runners';

/**
 * 源参考 `apps/agent-web-ui/src/pages/settings/runner/use-runners.ts` 中
 * `useRunnerCatalog` 的 nova-dsh 适配版。
 *
 * 源参考基于无限滚动分页 query；nova-dsh 的 `useRunnersQuery` 不分页。
 * 这里直接复用并暴露与 source 同形的 `runners` / `isLoading` 字段，
 * 让 settings runner tab 的渲染层无需关心底层分页机制。
 *
 * 分页相关字段（`hasNextPage` / `fetchNextPage` / `isFetchingNextPage`）
 * 返回占位，UI 层不再触发「加载更多」。
 */
export function useRunnerCatalog(enabled = true) {
  const query = useRunnersQuery();
  return {
    runners: (query.data?.items ?? []) as Runner[],
    isLoading: query.isPending,
    error: query.error,
    refetch: query.refetch,
    hasNextPage: false,
    fetchNextPage: () => undefined,
    isFetchingNextPage: false,
    isEnabled: enabled && Boolean(query),
  };
}
