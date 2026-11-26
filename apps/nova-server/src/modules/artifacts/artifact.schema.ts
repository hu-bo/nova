import { z } from "zod";
import { conversationIdSchema } from "@nova/agent-ui-contracts";
import { artifactSummarySchema } from "@nova/agent-ui-contracts";

export const conversationIdParamsSchema = z.object({ id: conversationIdSchema }).strict();
export const artifactIdParamsSchema = z.object({ artifactId: z.uuid() }).strict();

export const artifactListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(256).optional(),
  })
  .strict();

export const artifactListResponseSchema = z
  .object({
    items: z.array(artifactSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const artifactDownloadResponseSchema = z
  .object({
    name: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    state: z.literal("ready"),
    url: z.string().url(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

/** 预览响应按 kind 判别：HTML/SVG 等主动内容只得到下载指引，绝不返回可执行内容。 */
export const artifactPreviewResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["markdown", "text"]),
      name: z.string(),
      mimeType: z.string(),
      text: z.string(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({ kind: z.literal("image"), name: z.string(), mimeType: z.string(), url: z.string().url(), expiresAt: z.iso.datetime() })
    .strict(),
  z.object({ kind: z.literal("download"), name: z.string(), mimeType: z.string() }).strict(),
]);
