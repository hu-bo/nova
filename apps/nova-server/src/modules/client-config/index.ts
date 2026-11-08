import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requirePrincipal } from "../../shared/authorization.js";
import { okEnvelope, success } from "../../shared/response.schema.js";
import { availableModelSchema, createUserModelProfilesService } from "../model-config/index.js";

// Advertise only adapters that are wired. The client must not infer readiness from a route's existence.
export async function clientConfigModule(app: FastifyInstance, uploadsEnabled = false): Promise<void> {
  const modelProfiles = createUserModelProfilesService(app);
  app.withTypeProvider<ZodTypeProvider>().get(
    "/config",
    {
      schema: {
        operationId: "getClientConfig",
        tags: ["config"],
        response: {
          200: okEnvelope(
            z.object({
              capabilities: z.object({
                execution: z.boolean(),
                uploads: z.boolean(),
                remoteFiles: z.boolean(),
                compression: z.boolean(),
                models: z.boolean(),
              }),
              models: z.array(availableModelSchema),
            }),
          ),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return success({
        capabilities: {
          execution: app.executionEnabled,
          uploads: uploadsEnabled,
          remoteFiles: true,
          compression: false,
          models: true,
        },
        models: await modelProfiles.list(principal.localUserId),
      });
    },
  );
}
