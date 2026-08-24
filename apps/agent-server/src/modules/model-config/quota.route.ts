import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { forbidden } from "../../errors.js";
import type { ModelConfigStore, QuotaRow } from "./model-config.store.js";

const UpdateQuotaSchema = z.strictObject({
  rpm: z.number().int().positive().nullable(),
  tpm: z.number().int().positive().nullable(),
  monthlyCost: z
    .string()
    .regex(/^\d+(\.\d{1,8})?$/)
    .nullable(),
});
const QuotaSchema = UpdateQuotaSchema.extend({
  apiKeyId: z.uuid(),
  keyName: z.string(),
  keyPrefix: z.string(),
  updatedAt: z.iso.datetime(),
});
const ApiKeyParams = z.object({ apiKeyId: z.uuid() });
const ErrorSchema = z.object({ code: z.string(), message: z.string() });

export function quotaRoutes(app: FastifyInstance, store: ModelConfigStore): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const requireAdmin = async (request: { currentUser: { isAdmin: boolean; role: string } | null }) => {
    if (!request.currentUser?.isAdmin && request.currentUser?.role !== "admin") throw forbidden();
  };
  server.get(
    "/quotas",
    {
      schema: {
        operationId: "listQuotas",
        tags: ["model-config"],
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(QuotaSchema), 401: ErrorSchema, 403: ErrorSchema },
      },
      preHandler: requireAdmin,
    },
    async () => (await store.listQuotas()).map(quotaView),
  );
  server.patch(
    "/quotas/:apiKeyId",
    {
      schema: {
        operationId: "updateQuota",
        tags: ["model-config"],
        security: [{ bearerAuth: [] }],
        params: ApiKeyParams,
        body: UpdateQuotaSchema,
        response: { 200: QuotaSchema, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
      preHandler: requireAdmin,
    },
    async (request) => quotaView(await store.updateQuota({ apiKeyId: request.params.apiKeyId, ...request.body })),
  );
}

function quotaView(quota: QuotaRow) {
  return { ...quota, updatedAt: quota.updatedAt.toISOString() };
}
