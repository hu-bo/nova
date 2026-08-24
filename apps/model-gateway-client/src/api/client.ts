export {
  createModel,
  createProvider,
  deleteModel,
  deleteProvider,
  getUsage,
  listModels,
  listProviders,
  listQuotas,
  updateModel,
  updateProvider,
  updateQuota,
} from "./generated/model-config.js";
import { apiMutator } from "./orval-mutator.js";

export type {
  CreateModelBody as CreateModel,
  CreateModelBodyInputModalitiesItem as InputModality,
  CreateModelBodyReasoningFormat as ReasoningFormat,
  CreateModelBodyThinkingLevelsItem as ThinkingLevel,
  CreateProviderBody as CreateProvider,
  CreateProviderBodyProtocol as Protocol,
  GetUsage200 as UsageReport,
  GetUsage200ItemsItem as UsageItem,
  GetUsageParams,
  GetUsageStatus as UsageStatus,
  ListModels200Item as Model,
  ListProviders200Item as Provider,
  ListQuotas200Item as Quota,
  UpdateProviderBody as UpdateProvider,
  UpdateQuotaBody as UpdateQuota,
} from "./generated/model-config.js";

export interface ApiKey {
  id: string;
  keyPrefix: string;
  name: string;
  ownerId: string;
  enabled: boolean;
  createdAt: string;
}
export interface CreateApiKey {
  name: string;
  ownerId: string;
}
export interface CreatedApiKey {
  apiKey: ApiKey;
  secret: string;
}

export function listApiKeys(options?: { signal?: AbortSignal }) {
  return apiMutator<ApiKey[]>("/admin/model-config/api-keys", {
    method: "GET",
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}
export function createApiKey(input: CreateApiKey) {
  return apiMutator<CreatedApiKey>("/admin/model-config/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}
export function revokeApiKey(id: string) {
  return apiMutator<void>(`/admin/model-config/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export { ApiClientError, errorMessage } from "./errors.js";
