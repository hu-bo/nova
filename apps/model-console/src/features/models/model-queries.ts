import { queryOptions } from "@tanstack/react-query";
import { listModels } from "@/api/client";

export const modelKeys = { all: ["model-config", "models"] as const };

export function modelQueryOptions() {
  return queryOptions({ queryKey: modelKeys.all, queryFn: ({ signal }) => listModels({ signal }) });
}
