import { okEnvelope, success } from "../../shared/response.schema.js";
import { errorResponses } from "../../shared/error.schema.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requirePrincipal } from "../../shared/authorization.js";
import { z } from "zod";
import { providerCatalog } from "@nnova/harness/plugins/model-ai-sdk";
import {
  createModelBodySchema,
  createProviderBodySchema,
  modelIdParamsSchema,
  modelSchema,
  providerIdParamsSchema,
  providerSchema,
  providerAdapterDescriptorSchema,
  updateModelBodySchema,
  updateProviderBodySchema,
} from "./model-config.schema.js";
import type { ModelConfigService } from "./model-config.service.js";

const adminErrorResponses = errorResponses(400, 401, 403, 404, 409, 500, 503);

export async function modelConfigRoutes(app: FastifyInstance, service: ModelConfigService): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    "/provider-adapters",
    {
      schema: {
        operationId: "listProviderAdapters",
        tags: ["model-config"],
        response: { 200: okEnvelope(providerAdapterDescriptorSchema.array()), ...adminErrorResponses },
      },
    },
    async () => success(providerAdapterDescriptorSchema.array().parse(providerCatalog)),
  );
  typed.get(
    "/providers",
    {
      schema: {
        operationId: "listProviders",
        tags: ["model-config"],
        response: { 200: okEnvelope(providerSchema.array()), ...adminErrorResponses },
      },
    },
    async () => success(await service.listProviders()),
  );

  typed.post(
    "/providers",
    {
      schema: {
        operationId: "createProvider",
        tags: ["model-config"],
        body: createProviderBodySchema,
        response: { 200: okEnvelope(providerSchema), ...adminErrorResponses },
      },
    },
    async (request, reply) =>
      reply.send(success(await service.createProvider(request.body, requirePrincipal(request)))),
  );

  typed.patch(
    "/providers/:providerId",
    {
      schema: {
        operationId: "updateProvider",
        tags: ["model-config"],
        params: providerIdParamsSchema,
        body: updateProviderBodySchema,
        response: { 200: okEnvelope(providerSchema), ...adminErrorResponses },
      },
    },
    async (request) =>
      success(await service.updateProvider(request.params.providerId, request.body, requirePrincipal(request))),
  );

  typed.delete(
    "/providers/:providerId",
    {
      schema: {
        operationId: "deleteProvider",
        tags: ["model-config"],
        params: providerIdParamsSchema,
        response: { 200: okEnvelope(z.null()), ...adminErrorResponses },
      },
    },
    async (request, reply) => {
      await service.deleteProvider(request.params.providerId);
      return reply.send(success(null));
    },
  );

  typed.get(
    "/models",
    {
      schema: {
        operationId: "listModels",
        tags: ["model-config"],
        response: { 200: okEnvelope(modelSchema.array()), ...adminErrorResponses },
      },
    },
    async () => success(await service.listModels()),
  );

  typed.post(
    "/models",
    {
      schema: {
        operationId: "createModel",
        tags: ["model-config"],
        body: createModelBodySchema,
        response: { 200: okEnvelope(modelSchema), ...adminErrorResponses },
      },
    },
    async (request, reply) => reply.send(success(await service.createModel(request.body))),
  );

  typed.patch(
    "/models/:modelId",
    {
      schema: {
        operationId: "updateModel",
        tags: ["model-config"],
        params: modelIdParamsSchema,
        body: updateModelBodySchema,
        response: { 200: okEnvelope(modelSchema), ...adminErrorResponses },
      },
    },
    async (request) => success(await service.updateModel(request.params.modelId, request.body)),
  );

  typed.delete(
    "/models/:modelId",
    {
      schema: {
        operationId: "deleteModel",
        tags: ["model-config"],
        params: modelIdParamsSchema,
        response: { 200: okEnvelope(z.null()), ...adminErrorResponses },
      },
    },
    async (request, reply) => {
      await service.deleteModel(request.params.modelId);
      return reply.send(success(null));
    },
  );
}
