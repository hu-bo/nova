import { queryOptions } from "@tanstack/react-query";
import { listProviders } from "@/api/client";

export const providerKeys = { all: ["model-config", "providers"] as const };

export function providerQueryOptions() {
  return queryOptions({ queryKey: providerKeys.all, queryFn: ({ signal }) => listProviders({ signal }) });
}
