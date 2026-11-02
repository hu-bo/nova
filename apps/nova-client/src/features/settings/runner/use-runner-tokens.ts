import { useRunnerTokensQuery, type RunnerToken } from '@/features/runners';

/**
 * 源参考 `apps/agent-web-ui/src/pages/settings/runner/use-runners.ts` 中
 * `useRunnerTokens` 的 nova-dsh 适配版 —— 复用 `useRunnerTokensQuery`，
 * 只暴露渲染层实际使用的 `{ data, isLoading, error, refetch }`。
 */
export function useRunnerTokens() {
  const query = useRunnerTokensQuery();
  return {
    data: (query.data?.items ?? []) as RunnerToken[],
    isLoading: query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}
