import { listModels as fetchModels, listProviders as fetchProviders } from "./generated/model-config.js";
import { ApiClientError } from "./errors.js";

export {
  createModel,
  createProvider,
  deleteModel,
  deleteProvider,
  getUsage,
  updateModel,
  updateProvider,
} from "./generated/model-config.js";

// 在查询进入缓存前校验列表结构，让协议错误进入页面的错误/重试状态。
function requireList<T>(data: T[], label: string): T[] {
  if (!Array.isArray(data)) {
    throw new ApiClientError(502, "INVALID_RESPONSE", `${label}列表响应格式错误，请检查服务版本`);
  }
  return data;
}

export async function listProviders(options?: Parameters<typeof fetchProviders>[0]) {
  return requireList(await fetchProviders(options), "Provider ");
}

export async function listModels(options?: Parameters<typeof fetchModels>[0]) {
  return requireList(await fetchModels(options), "模型");
}

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
  UpdateModelBody as UpdateModel,
  UpdateProviderBody as UpdateProvider,
} from "./generated/model-config.js";

export { ApiClientError, errorMessage, formFeedbackFrom } from "./errors.js";
