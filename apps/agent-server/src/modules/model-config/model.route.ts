import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { forbidden } from "../../errors.js";
import type { ModelConfigStore, ModelRow } from "./model-config.store.js";

const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high", "max"]);
const ReasoningFormatSchema = z.enum(["none", "openai", "anthropic", "deepseek", "minimax"]);
const InputModalitySchema = z.enum(["text", "image"]);
const MoneySchema = z.string().regex(/^\d+(\.\d{1,8})?$/);
const CreateModelSchema = z.strictObject({
  publicName: z.string().trim().min(1).max(100),
  providerId: z.uuid(),
  upstreamName: z.string().trim().min(1).max(150),
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  thinkingLevels: z.array(ThinkingLevelSchema).refine(items => new Set(items).size === items.length),
  parallelToolCalls: z.boolean(),
  reasoningFormat: ReasoningFormatSchema,
  inputModalities: z.array(InputModalitySchema).min(1).refine(items => new Set(items).size === items.length && items.includes("text")),
  enabled: z.boolean(),
  priceIn: MoneySchema,
  priceOut: MoneySchema,
  priceCacheRead: MoneySchema,
}).superRefine((model, context) => {
  if (model.maxOutput > model.contextWindow) context.addIssue({ code: "custom", path: ["maxOutput"], message: "maxOutput cannot exceed contextWindow" });
  if (model.reasoningFormat === "none" && model.thinkingLevels.length) context.addIssue({ code: "custom", path: ["thinkingLevels"], message: "thinkingLevels must be empty when reasoningFormat is none" });
  if (model.reasoningFormat !== "none" && !model.thinkingLevels.length) context.addIssue({ code: "custom", path: ["thinkingLevels"], message: "thinkingLevels is required for reasoning-enabled models" });
});
const ModelSchema = CreateModelSchema.extend({
  id: z.uuid(),
  providerName: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const ModelParams = z.object({ modelId: z.uuid() });
const ErrorSchema = z.object({ code: z.string(), message: z.string() });

export function modelRoutes(app: FastifyInstance, store: ModelConfigStore): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const requireAdmin = async (request: { currentUser: { isAdmin: boolean; role: string } | null }) => {
    if (!request.currentUser?.isAdmin && request.currentUser?.role !== "admin") throw forbidden();
  };
  server.get("/models", {
    schema: { operationId: "listModels", tags: ["model-config"], security: [{ bearerAuth: [] }], response: { 200: z.array(ModelSchema), 401: ErrorSchema, 403: ErrorSchema } },
  }, async request => (await store.listModels(request.userId)).map(modelView));
  server.post("/models", {
    schema: { operationId: "createModel", tags: ["model-config"], security: [{ bearerAuth: [] }], body: CreateModelSchema, response: { 201: ModelSchema, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema } },
    preHandler: requireAdmin,
  }, async (request, reply) => reply.code(201).send(modelView(await store.createModel(request.body))));
  server.patch("/models/:modelId", {
    schema: { operationId: "updateModel", tags: ["model-config"], security: [{ bearerAuth: [] }], params: ModelParams, body: CreateModelSchema, response: { 200: ModelSchema, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema } },
    preHandler: requireAdmin,
  }, async request => modelView(await store.updateModel({ id: request.params.modelId, ...request.body })));
  server.delete("/models/:modelId", {
    schema: { operationId: "deleteModel", tags: ["model-config"], security: [{ bearerAuth: [] }], params: ModelParams, response: { 204: z.null(), 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema } },
    preHandler: requireAdmin,
  }, async (request, reply) => {
    await store.deleteModel(request.params.modelId);
    return reply.code(204).send(null);
  });
}

function modelView(model: ModelRow) {
  const { deletedAt: _, ...view } = model as ModelRow & { deletedAt?: Date | null };
  return { ...view, createdAt: model.createdAt.toISOString(), updatedAt: model.updatedAt.toISOString() };
}
