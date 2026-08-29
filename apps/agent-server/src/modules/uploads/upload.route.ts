import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiErrorSchema,
  CreateUploadSchema,
  UploadedFileSchema,
  UploadRunnerFileSchema,
  UploadTicketSchema,
} from "@nova/protocol";
import type { RunnerRegistry } from "../runner/registry.js";
import type { UploadStorage } from "./upload-storage.js";
import { createUploadService } from "./upload.service.js";

export async function uploadRoutes(
  app: FastifyInstance,
  storage: UploadStorage,
  runners: RunnerRegistry,
): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const uploads = createUploadService(storage, runners);
  server.post(
    "/uploads",
    {
      schema: {
        operationId: "createUpload",
        tags: ["uploads"],
        security: [{ bearerAuth: [] }],
        body: CreateUploadSchema,
        response: { 200: UploadTicketSchema, 400: ApiErrorSchema, 401: ApiErrorSchema, 503: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const ticket = await uploads.createTicket(request.userId, request.body.name);
      if (request.headers.referer?.startsWith("https://")) {
        ticket.upload = ticket.upload.replace(/^http:/, "https:");
        ticket.download = ticket.download.replace(/^http:/, "https:");
      }
      return reply.send(ticket);
    },
  );

  server.post(
    "/uploads/runner",
    {
      schema: {
        operationId: "uploadRunnerFile",
        tags: ["uploads"],
        security: [{ bearerAuth: [] }],
        body: UploadRunnerFileSchema,
        response: {
          200: UploadedFileSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          409: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await uploads.uploadRunnerFile(request.userId, request.body.runnerId, request.body.path);
      if (request.headers.referer?.startsWith("https://")) result.url = result.url.replace(/^http:/, "https:");
      return reply.send(result);
    },
  );
}
