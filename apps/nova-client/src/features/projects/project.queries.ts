import { useQueries, useQuery } from '@tanstack/react-query';
import { getProject, getProjectBinding, listProjects } from '@/api/generated/projects';
import { queryKeys } from '@/api/query-keys';
import { useIdentity } from '@/features/auth';
import { useRunnersQuery, runnerStatus, type Runner } from '@/features/runners';
import { useRemoteConnectionsQuery, type RemoteConnection } from '@/features/remotes';
export function useProjectsQuery() {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: queryKeys.projects.list(identity?.identityId ?? 'anonymous', { limit: 100 }),
    enabled: Boolean(identity),
    queryFn: ({ signal }) => listProjects({ limit: 100 }, { signal }),
  });
}
export function useProjectQuery(id: string | null) {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: queryKeys.projects.detail(identity?.identityId ?? 'anonymous', id ?? ''),
    enabled: Boolean(identity && id),
    queryFn: ({ signal }) => getProject(id!, { signal }),
  });
}
export function useProjectBinding(id: string | null) {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: queryKeys.projects.binding(identity?.identityId ?? 'anonymous', id ?? ''),
    enabled: Boolean(identity && id),
    queryFn: ({ signal }) => getProjectBinding(id!, { signal }),
    staleTime: 10000,
  });
}

/** 未拿到绑定数据时，按查询状态区分 error / loading / unbound。 */
function deriveBindingState(
  query: { isError: boolean; isPending: boolean } | undefined,
): 'error' | 'loading' | 'unbound' {
  if (query?.isError) return 'error';
  if (query?.isPending) return 'loading';
  return 'unbound';
}

/** SSH 远程优先于本地 Runner；各自状态不认识时兜底 unknown。 */
function deriveRunnerState(
  remote: RemoteConnection | undefined,
  runner: Runner | undefined,
): string {
  if (remote) {
    if (remote.status === 'verified') return 'verified';
    if (remote.status === 'offline') return 'offline';
    return 'unknown';
  }
  if (runner) return runnerStatus(runner) === 'online' ? 'ready' : 'offline';
  return 'unknown';
}

/** Derive sidebar environment information from owner-scoped bindings and connections. */
export function useProjectSidebarInfo(projectIds: string[]) {
  const { identity } = useIdentity();
  const bindings = useQueries({
    queries: projectIds.map((id) => ({
      queryKey: queryKeys.projects.binding(identity?.identityId ?? 'anonymous', id),
      enabled: Boolean(identity),
      queryFn: ({ signal }: { signal: AbortSignal }) => getProjectBinding(id, { signal }),
      staleTime: 10_000,
    })),
  });
  const runners = useRunnersQuery();
  const remotes = useRemoteConnectionsQuery();
  const runnerById = new Map<string, Runner>();
  for (const runner of runners.data?.items ?? []) {
    runnerById.set(runner.id, runner);
  }
  const map: Record<
    string,
    {
      runnerState: string;
      workspace: string | null;
      runnerId: string | null;
      bindingState: 'loading' | 'error' | 'unbound' | 'bound';
    }
  > = {};
  for (let i = 0; i < projectIds.length; i += 1) {
    const id = projectIds[i];
    if (!id) {
      continue;
    }
    const binding = bindings[i]?.data ?? null;
    if (!binding) {
      map[id] = {
        runnerState: 'unknown',
        workspace: null,
        runnerId: null,
        bindingState: deriveBindingState(bindings[i]),
      };
      continue;
    }
    const runner = binding.runnerId ? runnerById.get(binding.runnerId) : undefined;
    const remote = binding.remoteConnectionId
      ? remotes.data?.items.find((item) => item.id === binding.remoteConnectionId)
      : undefined;
    map[id] = {
      bindingState: 'bound',
      runnerState: deriveRunnerState(remote, runner),
      workspace: binding.canonicalCwd,
      runnerId: remote ? remote.name + ' · SSH' : (runner?.runnerId ?? binding.runnerId),
    };
  }
  return map;
}
