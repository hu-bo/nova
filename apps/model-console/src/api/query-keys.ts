import type { GetUsageParams } from "./client.js";

export const queryKeys = {
  providers: ["model-config", "providers"] as const,
  models: ["model-config", "models"] as const,
  usage: (filters: GetUsageParams) => ["model-config", "usage", filters] as const,
};
