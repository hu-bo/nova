import { ApiErrorSchema, AvailableModelSchema } from "@nova/protocol";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ModelConfigStore } from "./model-config.store.js";

export function availableModelRoutes(app: FastifyInstance, store: ModelConfigStore): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/models",
    {
      schema: {
        operationId: "listAvailableModels",
        tags: ["models"],
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(AvailableModelSchema), 401: ApiErrorSchema },
      },
    },
    (request) => store.listAvailableModels(request.userId),
  );
}
