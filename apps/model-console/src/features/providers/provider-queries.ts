import { queryOptions } from "@tanstack/react-query";
import { listProviders, listProviderAdapters } from "@/api/client";

export const providerKeys = { all: ["model-config", "providers"] as const };

export function providerQueryOptions() {
  return queryOptions({ queryKey: providerKeys.all, queryFn: ({ signal }) => listProviders({ signal }) });
}

export function providerAdapterQueryOptions() {
  return queryOptions({
    queryKey: ["model-config", "provider-adapters"],
    queryFn: ({ signal }) => listProviderAdapters({ signal }),
    staleTime: Infinity,
  });
}
