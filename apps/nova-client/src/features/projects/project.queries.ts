import { useQueries, useQuery } from '@tanstack/react-query';
import { getProject, getProjectBinding, listProjects } from '@/api/generated/projects';
import { queryKeys } from '@/api/query-keys';
import { useIdentity } from '@/features/auth';
import { useRunnersQuery, runnerStatus, type Runner } from '@/features/runners';
import { useRemoteConnectionsQuery } from '@/features/remotes';
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
    queryKey: ['nova', identity?.identityId ?? 'anonymous', 'projects', 'binding', id],
    enabled: Boolean(identity && id),
    queryFn: ({ signal }) => getProjectBinding(id!, { signal }),
    staleTime: 10000,
  });
}

/** Derive sidebar environment information from owner-scoped bindings and connections. */
export function useProjectSidebarInfo(projectIds: string[]) {
  const { identity } = useIdentity();
  const bindings = useQueries({
    queries: projectIds.map((id) => ({
      queryKey: ['nova', identity?.identityId ?? 'anonymous', 'projects', 'binding', id] as const,
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
        bindingState: bindings[i]?.isError
          ? 'error'
          : bindings[i]?.isPending
            ? 'loading'
            : 'unbound',
      };
      continue;
    }
    const runner = binding.runnerId ? runnerById.get(binding.runnerId) : undefined;
    const remote = binding.remoteConnectionId
      ? remotes.data?.items.find((item) => item.id === binding.remoteConnectionId)
      : undefined;
    map[id] = {
      bindingState: 'bound',
      runnerState: remote
        ? remote.status === 'verified'
          ? 'verified'
          : remote.status === 'offline'
            ? 'offline'
            : 'unknown'
        : runner
          ? runnerStatus(runner) === 'online'
            ? 'ready'
            : 'offline'
          : 'unknown',
      workspace: binding.canonicalCwd,
      runnerId: remote ? remote.name + ' · SSH' : (runner?.runnerId ?? binding.runnerId),
    };
  }
  return map;
}
