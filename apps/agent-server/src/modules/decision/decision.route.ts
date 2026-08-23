import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiErrorSchema, ResolveDecisionSchema } from "@nova/protocol";
import type { PendingDecisions } from "./pending-decisions.js";

const Params = z.object({ decisionId: z.string().min(1) });

export function decisionRoutes(app: FastifyInstance, decisions: PendingDecisions): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  server.post("/decisions/:decisionId", {
    schema: {
      operationId: "resolveDecision",
      tags: ["decisions"],
      security: [{ bearerAuth: [] }],
      params: Params,
      body: ResolveDecisionSchema,
      response: { 204: z.null(), 400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    decisions.resolve(request.params.decisionId, request.userId, request.body);
    return reply.code(204).send(null);
  });
}
