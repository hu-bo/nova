import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requirePrincipal } from "../../shared/authorization.js";
import { errorResponses } from "../../shared/error.schema.js";
import { okEnvelope, success } from "../../shared/response.schema.js";
import {
  artifactDownloadResponseSchema,
  artifactIdParamsSchema,
  artifactListQuerySchema,
  artifactListResponseSchema,
  artifactPreviewResponseSchema,
  conversationIdParamsSchema,
} from "./artifact.schema.js";
import type { ArtifactService } from "./artifact.service.js";

/** 产物读接口（§8.2）：列表恢复、下载换签、受限预览。全部先验归属链再触存储。 */
export async function artifactRoutes(app: FastifyInstance, service: ArtifactService) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/conversations/:id/artifacts", {
    schema: {
      operationId: "listConversationArtifacts",
      tags: ["artifacts"],
      params: conversationIdParamsSchema,
      querystring: artifactListQuerySchema,
      response: { 200: okEnvelope(artifactListResponseSchema), ...errorResponses(400, 401, 404) },
    },
  }, async (request) => {
    const principal = requirePrincipal(request);
    return success(
      await service.list({
        conversationId: request.params.id,
        ownerUserId: principal.localUserId,
        limit: request.query.limit,
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      }),
    );
  });
  typed.get("/artifacts/:artifactId/download", {
    schema: {
      operationId: "downloadArtifact",
      tags: ["artifacts"],
      params: artifactIdParamsSchema,
      response: { 200: okEnvelope(artifactDownloadResponseSchema), ...errorResponses(401, 404, 409) },
    },
  }, async (request) => {
    const principal = requirePrincipal(request);
    return success(await service.download(request.params.artifactId, principal.localUserId));
  });
  typed.get("/artifacts/:artifactId/preview", {
    schema: {
      operationId: "previewArtifact",
      tags: ["artifacts"],
      params: artifactIdParamsSchema,
      response: { 200: okEnvelope(artifactPreviewResponseSchema), ...errorResponses(401, 404, 409) },
    },
  }, async (request) => {
    const principal = requirePrincipal(request);
    return success(await service.preview(request.params.artifactId, principal.localUserId));
  });
}
