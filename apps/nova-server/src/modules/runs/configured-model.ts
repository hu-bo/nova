import { FrameworkError, type PluginDefinition } from "@nnova/harness";
import { aiSdkModelPlugin, resolveProviderId } from "@nnova/harness/plugins/model-ai-sdk";
import type { FastifyBaseLogger } from "fastify";
import type { ModelRow, ProviderRow } from "../model-config/index.js";
import type { UploadStorage } from "../attachments/index.js";

type Route = { model: ModelRow; provider: ProviderRow; credential: string };

/** Bind application credentials and private attachment storage to the shared model adapter. */
export function configuredModelPlugin(
  route: Route,
  uploads: UploadStorage,
  ownerUserId: string,
  logger: FastifyBaseLogger,
): PluginDefinition {
  const { model, provider } = route;
  return aiSdkModelPlugin(
    {
      defaultModel: model.id,
      models: [
        {
          id: model.id,
          provider: resolveProviderId({
            ...(provider.adapterId ? { provider: provider.adapterId } : {}),
            protocol: provider.protocol,
            reasoningFormat: model.reasoningFormat,
          }),
          baseURL: provider.baseUrl,
          apiKey: route.credential,
          model: model.upstreamName,
          contextWindow: Number(model.contextWindow),
          maxOutputTokens: Number(model.maxOutput),
          images: model.inputModalities.includes("image"),
          files: false,
          parallelToolCalls: model.parallelToolCalls,
          reasoningFormat: model.reasoningFormat,
        },
      ],
      maxConcurrentRequests: 1,
    },
    {
      logger: logger.child({ component: "configured-model", providerId: provider.id }),
      resolveImageUrl: async (uri) => {
        const prefix = "nova-object:";
        if (!uri.startsWith(prefix)) throw new FrameworkError("MODEL_INCOMPATIBLE", "Invalid image reference.");
        return (await uploads.imageUrl(ownerUserId, { kind: "object", key: uri.slice(prefix.length) })).url;
      },
    },
  );
}
