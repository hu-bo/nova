import { z } from "zod";
import { okEnvelope, success } from "../../shared/response.schema.js";
import { MAX_ATTACHMENT_BYTES } from "./attachment-policy.js";

export const createUploadBodySchema = z
  .object({
    filename: z.string().trim().min(1).max(256),
    mime: z.string().trim().min(1).max(128),
    size: z.coerce.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  })
  .strict();

export const createUploadResponseSchema = z.object({
  key: z.string(),
  upload: z.object({
    url: z.string().url(),
    method: z.literal("PUT"),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string().datetime(),
  }),
  download: z.object({
    url: z.string().url(),
    expiresAt: z.string().datetime(),
  }),
});

export const uploadKeyParamsSchema = z.object({ key: z.string().min(1).max(512) }).strict();

export const uploadCompleteBodySchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    mime: z.string().trim().min(1).max(128),
    size: z.coerce.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  })
  .strict();

export const uploadCompleteResponseSchema = z.object({
  key: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
});

export const readImageBodySchema = z
  .object({ conversationId: z.uuid(), messageId: z.uuid(), blockId: z.string().min(1).max(128) })
  .strict();

export const readImageResponseSchema = z.object({
  data: z.string(), // base64
  mimeType: z.string(),
});

export const imageUrlQuerySchema = readImageBodySchema;

export const imageUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
});

export { okEnvelope, success };
export type CreateUploadInput = z.infer<typeof createUploadBodySchema>;
