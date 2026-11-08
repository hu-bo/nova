import { useQuery } from '@tanstack/react-query';
import { listRunners, listRunnerFiles, listRunnerTokens } from '@/api/generated/runners';
import type {
  ListRunners200ItemsItem,
  ListRunnerTokens200ItemsItem,
} from '@/api/generated/projectsAPI.schemas';
import { queryKeys } from '@/api/query-keys';
import { useIdentity } from '@/features/auth';
export type Runner = ListRunners200ItemsItem;
export type RunnerToken = ListRunnerTokens200ItemsItem;
export function runnerStatus(runner: Runner, now = Date.now()): 'online' | 'offline' | 'revoked' {
  if (runner.revokedAt) return 'revoked';
  if (runner.lastSeenAt && now - Date.parse(runner.lastSeenAt) < 60000) return 'online';
  return 'offline';
}
export function useRunnerTokensQuery({ silent = false } = {}) {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: queryKeys.runners.tokens(identity?.identityId ?? 'anonymous'),
    enabled: Boolean(identity),
    queryFn: ({ signal }) => listRunnerTokens({ signal, silent }),
  });
}
export function useRunnersQuery() {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: queryKeys.runners.list(identity?.identityId ?? 'anonymous'),
    enabled: Boolean(identity),
    queryFn: ({ signal }) => listRunners({ signal }),
    staleTime: 10000,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });
}
export function loadRunnerDirectory(runnerId: string, path = '.', signal?: AbortSignal) {
  return listRunnerFiles(runnerId, { path: path || '.' }, { ...(signal ? { signal } : {}) });
}
