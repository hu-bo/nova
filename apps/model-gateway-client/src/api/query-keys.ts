import type { GetUsageParams } from "./client.js";

export const queryKeys = {
  providers: ["model-config", "providers"] as const,
  models: ["model-config", "models"] as const,
  apiKeys: ["model-config", "api-keys"] as const,
  quotas: ["model-config", "quotas"] as const,
  usage: (filters: GetUsageParams) => ["model-config", "usage", filters] as const,
};
