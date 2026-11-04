import { queryOptions } from "@tanstack/react-query";
import { getUsage, type GetUsageParams } from "@/api/client";

export function usageQueryOptions(filters: GetUsageParams) {
  return queryOptions({
    queryKey: ["model-config", "usage", filters] as const,
    queryFn: ({ signal }) => getUsage(filters, { signal }),
    refetchInterval: 30_000,
  });
}
