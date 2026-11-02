import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requirePrincipal } from "../../shared/authorization.js";
import { errorResponses } from "../../shared/error.schema.js";
import { okEnvelope, success } from "./attachment.schema.js";
import {
  createUploadBodySchema,
  createUploadResponseSchema,
  imageUrlQuerySchema,
  imageUrlResponseSchema,
  readImageBodySchema,
  readImageResponseSchema,
  uploadCompleteBodySchema,
  uploadCompleteResponseSchema,
  uploadKeyParamsSchema,
} from "./attachment.schema.js";
import type { AttachmentService } from "./attachment.service.js";

export async function attachmentRoutes(app: FastifyInstance, service: AttachmentService): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    "/uploads",
    {
      schema: {
        operationId: "createAttachmentUpload",
        tags: ["attachments"],
        body: createUploadBodySchema,
        response: {
          200: okEnvelope(createUploadResponseSchema),
          ...errorResponses(400, 401, 500),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return success(
        await service.createUpload({
          ownerUserId: principal.localUserId,
          ...request.body,
        }),
      );
    },
  );

  typed.post(
    "/uploads/:key/complete",
    {
      schema: {
        operationId: "completeAttachmentUpload",
        tags: ["attachments"],
        params: uploadKeyParamsSchema,
        body: uploadCompleteBodySchema,
        response: {
          200: okEnvelope(uploadCompleteResponseSchema),
          ...errorResponses(400, 401, 403, 500),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const key = request.params.key;
      return success(
        await service.completeUpload({
          ownerUserId: principal.localUserId,
          key,
          ...request.body,
        }),
      );
    },
  );

  typed.post(
    "/read-image",
    {
      schema: {
        operationId: "readAttachmentImage",
        tags: ["attachments"],
        body: readImageBodySchema,
        response: {
          200: okEnvelope(readImageResponseSchema),
          ...errorResponses(400, 401, 403, 500),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return success(await service.readImage({ ownerUserId: principal.localUserId, ...request.body }));
    },
  );

  typed.get(
    "/image-url",
    {
      schema: {
        operationId: "getAttachmentImageUrl",
        tags: ["attachments"],
        querystring: imageUrlQuerySchema,
        response: {
          200: okEnvelope(imageUrlResponseSchema),
          ...errorResponses(400, 401, 403, 500),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return success(await service.imageUrl({ ownerUserId: principal.localUserId, ...request.query }));
    },
  );
}
