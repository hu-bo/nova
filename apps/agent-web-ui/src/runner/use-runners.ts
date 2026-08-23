import type { Runner } from "@nova/protocol";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { queryKeys } from "../api/query-keys.js";
import { useAuth } from "../auth/provider.js";

export function useRunnerCatalog(enabled = true) {
  const { api } = useAuth();
  const query = useInfiniteQuery({
    queryKey: queryKeys.runners,
    queryFn: ({ pageParam }) => api!.listRunners({ limit: 12, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: enabled && Boolean(api),
    staleTime: 5_000,
  });
  return {
    ...query,
    runners: (query.data?.pages.flatMap(page => page.items) ?? []) as Runner[],
  };
}

export function useRunnerTokens(enabled = true) {
  const { api } = useAuth();
  return useQuery({
    queryKey: queryKeys.runnerTokens,
    queryFn: () => api!.listRunnerTokens(),
    enabled: enabled && Boolean(api),
  });
}

export function useRunnerDirectories(runnerId: string, path?: string) {
  const { api } = useAuth();
  return useQuery({
    queryKey: queryKeys.runnerDirectories(runnerId, path),
    queryFn: () => api!.listRunnerDirectories({ runnerId, ...(path ? { path } : {}) }),
    enabled: Boolean(api && runnerId),
  });
}

export function useRunnerConnection(enabled = true) {
  const { api } = useAuth();
  return useQuery({
    queryKey: queryKeys.runnerConnection,
    queryFn: () => api!.getRunnerConnectionInfo(),
    enabled: enabled && Boolean(api),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
