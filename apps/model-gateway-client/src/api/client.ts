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

export type { GetUsageParams } from "./generated/model/index.js";
export type { CreateModelBody as CreateModel } from "./generated/model/createModelBody.js";
export type { CreateProviderBody as CreateProvider } from "./generated/model/createProviderBody.js";
export type { UpdateProviderBody as UpdateProvider } from "./generated/model/updateProviderBody.js";
export type { UpdateQuotaBody as UpdateQuota } from "./generated/model/updateQuotaBody.js";
export type { ListModels200Item as Model } from "./generated/model/listModels200Item.js";
export type { ListProviders200Item as Provider } from "./generated/model/listProviders200Item.js";
export type { ListQuotas200Item as Quota } from "./generated/model/listQuotas200Item.js";
export type { GetUsage200 as UsageReport } from "./generated/model/getUsage200.js";
export type { GetUsage200ItemsItem as UsageItem } from "./generated/model/getUsage200ItemsItem.js";
export type { GetUsageStatus as UsageStatus } from "./generated/model/getUsageStatus.js";
export type { CreateProviderBodyProtocol as Protocol } from "./generated/model/createProviderBodyProtocol.js";
export type { CreateModelBodyReasoningFormat as ReasoningFormat } from "./generated/model/createModelBodyReasoningFormat.js";
export type { CreateModelBodyThinkingLevelsItem as ThinkingLevel } from "./generated/model/createModelBodyThinkingLevelsItem.js";
export type { CreateModelBodyInputModalitiesItem as InputModality } from "./generated/model/createModelBodyInputModalitiesItem.js";

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
