import type { Runner } from "@nova/protocol";
import type { RemoteExplorerListing } from "@nova/chat-ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { queryKeys } from "../../../api/query-keys.js";
import { useAuth } from "../../../auth/provider.js";

export function runnerStateLabel(state: Runner["state"]) {
  if (state === "ready") return "在线";
  if (state === "busy") return "忙碌";
  if (state === "draining") return "排空中";
  return "离线";
}

export function useRunnerCatalog(enabled = true) {
  const { api } = useAuth();
  const query = useInfiniteQuery({
    queryKey: queryKeys.runners,
    queryFn: ({ pageParam }) => api!.listRunners({ limit: 12, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: enabled && Boolean(api),
    staleTime: 5_000,
  });
  return {
    ...query,
    runners: (query.data?.pages.flatMap((page) => page.items) ?? []) as Runner[],
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

export function useRunnerDirectoryLoader(runnerId: string) {
  const { api } = useAuth();
  return useCallback(
    async (path?: string, signal?: AbortSignal) => {
      if (!api || !runnerId) throw new Error("请先选择 Runner");
      return api.listRunnerDirectories(
        { runnerId, ...(path ? { path } : {}) },
        signal ? { signal } : undefined,
      ) satisfies Promise<RemoteExplorerListing>;
    },
    [api, runnerId],
  );
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
