import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { UploadStorage } from "./upload-storage.js";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const UploadSchema = z.object({
  url: z.url(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
});
const ErrorSchema = z.object({ code: z.string(), message: z.string() });

export async function uploadRoutes(app: FastifyInstance, storage: UploadStorage): Promise<void> {
  await app.register(multipart, { limits: { files: 1, fileSize: MAX_FILE_SIZE } });
  app.withTypeProvider<ZodTypeProvider>().post("/uploads", {
    schema: {
      operationId: "uploadFile", tags: ["uploads"], security: [{ bearerAuth: [] }],
      consumes: ["multipart/form-data"], response: { 201: UploadSchema, 400: ErrorSchema, 401: ErrorSchema, 413: ErrorSchema },
    },
  }, async (request, reply) => {
    const part = await request.file();
    if (!part) return reply.code(400).send({ code: "FILE_REQUIRED", message: "请选择要上传的文件" });
    const data = await part.toBuffer();
    const uploaded = await storage.put({ userId: request.userId, filename: part.filename, mimeType: part.mimetype, data });
    return reply.code(201).send({ url: uploaded.url, name: part.filename, size: data.byteLength, mimeType: part.mimetype });
  });
}
