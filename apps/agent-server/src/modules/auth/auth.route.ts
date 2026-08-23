import { AuthorizeUrlRequestSchema, AuthorizeUrlResponseSchema, ApiErrorSchema } from "@nova/protocol";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AuthServiceClient } from "../../app/auth-service.js";
import { z } from "zod";

const AppParams = z.object({ appName: z.string().trim().min(1).max(128) });

export function authRoutes(app: FastifyInstance, auth: AuthServiceClient): void {
  app.withTypeProvider<ZodTypeProvider>().post("/apps/:appName/oauth/authorize-url", {
    schema: {
      operationId: "createAuthorizeUrl",
      tags: ["auth"],
      params: AppParams,
      body: AuthorizeUrlRequestSchema,
      response: {
        200: AuthorizeUrlResponseSchema,
        400: ApiErrorSchema,
        502: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
  }, request => auth.createAuthorizeUrl(request.params.appName, request.body));
}
