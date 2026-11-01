import { useRunnerTokensQuery, type RunnerToken } from '@/features/runners';

/**
 * 源参考 `apps/agent-web-ui/src/pages/settings/runner/use-runners.ts` 中
 * `useRunnerTokens` 的 nova-dsh 适配版 —— 复用 `useRunnerTokensQuery`，
 * 暴露与 source 同形的 `{ data, isLoading, error, refetch }`。
 */
export function useRunnerTokens(enabled = true) {
  const query = useRunnerTokensQuery();
  return {
    data: (query.data?.items ?? []) as RunnerToken[],
    isLoading: query.isPending,
    error: query.error,
    refetch: query.refetch,
    isEnabled: enabled && Boolean(query),
  };
}
