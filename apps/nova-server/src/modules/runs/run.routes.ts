import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requirePrincipal } from "../../shared/authorization.js";
import { errorResponses } from "../../shared/error.schema.js";
import { createRunService } from "./run.service.js";
import {
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
          ...errorResponses(401, 404, 409, 500),
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
          ...errorResponses(400, 401, 404, 409, 500),
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
