import type { CreateModel, Model } from "@/api/client";

/**
 * 模型目录条目去掉服务端元信息后的完整注册体。
 * 编辑表单回填与状态切换（停用/启用需要重新提交完整能力配置）共用这一投影。
 */
export type ModelInput = Required<CreateModel>;

export function toModelInput(model: Model): ModelInput {
  return {
    publicName: model.publicName,
    providerId: model.providerId,
    upstreamName: model.upstreamName,
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    thinkingLevels: model.thinkingLevels,
    parallelToolCalls: model.parallelToolCalls,
    reasoningFormat: model.reasoningFormat,
    inputModalities: model.inputModalities,
    enabled: model.enabled,
    priceIn: model.priceIn,
    priceOut: model.priceOut,
    priceCacheRead: model.priceCacheRead,
  };
}
