import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { forbidden } from "../../errors.js";
import type { ModelConfigStore, UsageReportRow } from "./model-config.store.js";

const UsageStatusSchema = z.enum(["completed", "aborted", "error"]);
const UsageQuerySchema = z
  .object({
    from: z.iso
      .datetime()
      .transform((value) => new Date(value))
      .optional(),
    to: z.iso
      .datetime()
      .transform((value) => new Date(value))
      .optional(),
    apiKeyId: z.uuid().optional(),
    modelId: z.uuid().optional(),
    status: UsageStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: "from must be before to",
    path: ["to"],
  });
const UsageItemSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  apiKeyId: z.uuid(),
  apiKeyName: z.string(),
  modelId: z.uuid(),
  modelName: z.string(),
  status: UsageStatusSchema,
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cost: z.string(),
  estimated: z.boolean(),
});
const UsageReportSchema = z.object({
  items: z.array(UsageItemSchema),
  totals: z.object({
    requests: z.number().int().nonnegative(),
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cost: z.string(),
  }),
  generatedAt: z.iso.datetime(),
});
const ErrorSchema = z.object({ code: z.string(), message: z.string() });

export function usageRoutes(app: FastifyInstance, store: ModelConfigStore): void {
  const requireAdmin = async (request: { currentUser: { isAdmin: boolean; role: string } | null }) => {
    if (!request.currentUser?.isAdmin && request.currentUser?.role !== "admin") throw forbidden();
  };
  app.withTypeProvider<ZodTypeProvider>().get(
    "/usage",
    {
      schema: {
        operationId: "getUsage",
        tags: ["model-config"],
        security: [{ bearerAuth: [] }],
        querystring: UsageQuerySchema,
        response: { 200: UsageReportSchema, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
      preHandler: requireAdmin,
    },
    async (request) => usageView(await store.getUsage(request.query)),
  );
}

function usageView(report: UsageReportRow) {
  return {
    ...report,
    generatedAt: report.generatedAt.toISOString(),
    items: report.items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
  };
}
