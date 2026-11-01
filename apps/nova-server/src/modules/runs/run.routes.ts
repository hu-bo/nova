import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requirePrincipal } from "../../shared/authorization.js";
import { createRunService } from "./run.service.js";
import {
  errorResponseSchema,
  interactionParamsSchema,
  interactionResponseResultSchema,
  respondInteractionBodySchema,
  runCancelResponseSchema,
  runParamsSchema,
  okEnvelope,
  success,
} from "./run.schema.js";
export async function registerRunRoutes(app: FastifyInstance) {
  const repository = createRunService(app.db);
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    "/runs/:id/cancel",
    {
      schema: {
        operationId: "cancelRun",
        tags: ["runs"],
        params: runParamsSchema,
        body: z.object({}).strict().default({}),
        response: {
          200: okEnvelope(runCancelResponseSchema),
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request) => success(await repository.cancel(request.params.id, requirePrincipal(request).localUserId)),
  );
  typed.post(
    "/runs/:id/interactions/:interactionId/respond",
    {
      schema: {
        operationId: "respondInteraction",
        tags: ["runs"],
        params: interactionParamsSchema,
        body: respondInteractionBodySchema,
        response: {
          200: okEnvelope(interactionResponseResultSchema),
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request) =>
      success(
        await repository.respond(
          request.params.id,
          request.params.interactionId,
          requirePrincipal(request).localUserId,
          request.body.expectedRevision,
          request.body.response,
        ),
      ),
  );
}
