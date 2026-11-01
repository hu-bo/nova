import { z } from "zod";
export const idSchema = z.string().min(1).max(128);
export const decimalSequenceSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n, "Sequence exceeds PostgreSQL bigint");
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
function isJson(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  return Boolean(
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every((item) => isJson(item, depth + 1)),
  );
}
// JSON containers validate recursively, while OpenAPI uses finite container schemas.
export const jsonValueSchema = z
  .union([z.null(), z.boolean(), z.number(), z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
  .refine(isJson, "Invalid JSON value") as z.ZodType<JsonValue>;
export const publicErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    recovery: z.enum(["retry", "reconfigure", "inspect"]).optional(),
  })
  .strict();
const sshPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !/^[a-z]:/i.test(path) && !path.replaceAll("\\", "/").split("/").includes("..") && !/[\x00-\x1f]/.test(path),
    "Invalid remote path",
  );
const pathSchema = sshPathSchema.refine((path) => !path.startsWith("/"), "Workspace path must be relative");
export const fileRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("object"), key: z.string().min(1).max(512), versionId: z.string().optional() }).strict(),
  z.object({ kind: z.literal("runner"), runnerId: idSchema, workspaceId: idSchema, path: pathSchema }).strict(),
  z.object({ kind: z.literal("ssh"), remoteConnectionId: idSchema, path: sshPathSchema }).strict(),
]);
export const attachmentSchema = z
  .object({
    ref: fileRefSchema,
    name: z.string().min(1).max(1024),
    mimeType: z.string().min(1).max(128),
    size: z.number().int().nonnegative().optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
  })
  .strict();
const text = z.object({ id: idSchema, type: z.literal("text"), text: z.string() }).strict();
const thinking = z.object({ id: idSchema, type: z.literal("thinking"), text: z.string() }).strict();
const image = z.object({ id: idSchema, type: z.literal("image"), attachment: attachmentSchema }).strict();
const file = z.object({ id: idSchema, type: z.literal("file"), attachment: attachmentSchema }).strict();
export const contentSchema = z.discriminatedUnion("type", [
  text,
  thinking,
  image,
  file,
  z
    .object({
      id: idSchema,
      type: z.literal("code"),
      language: z.string(),
      code: z.string(),
      path: z.string().optional(),
    })
    .strict(),
  z.object({ id: idSchema, type: z.literal("diff"), path: z.string(), diff: z.string() }).strict(),
  z.object({ id: idSchema, type: z.literal("error"), error: publicErrorSchema }).strict(),
  z
    .object({ id: idSchema, type: z.literal("custom"), name: z.string(), data: jsonValueSchema, fallback: z.string() })
    .strict(),
]);
export const blockSchema = z.discriminatedUnion("type", [
  ...contentSchema.options,
  z
    .object({ id: idSchema, type: z.literal("tool_call"), callId: idSchema, name: z.string(), args: jsonValueSchema })
    .strict(),
  z
    .object({
      id: idSchema,
      type: z.literal("tool_result"),
      callId: idSchema,
      operationId: idSchema,
      outcome: z.enum(["succeeded", "failed", "cancelled", "denied", "unknown"]),
      content: z.array(contentSchema),
    })
    .strict(),
]);
export const messageSchema = z
  .object({
    id: idSchema,
    runId: idSchema.nullable(),
    sequence: decimalSequenceSchema,
    role: z.enum(["user", "assistant", "tool", "system"]),
    state: z.enum(["streaming", "completed", "failed", "cancelled"]),
    blocks: z
      .array(blockSchema)
      .refine((blocks) => new Set(blocks.map((block) => block.id)).size === blocks.length, "Duplicate block ID"),
    createdAt: z.iso.datetime(),
    source: z.object({ agentId: idSchema, parentRunId: idSchema.optional() }).strict().optional(),
  })
  .strict();
export const inputBlockSchema = z.discriminatedUnion("type", [text, image, file]);
export const inputBlocksSchema = z
  .array(inputBlockSchema)
  .min(1)
  .max(64)
  .refine(
    (blocks) =>
      new Set(blocks.map((block) => block.id)).size === blocks.length &&
      blocks.some((block) => block.type !== "text" || block.text.trim().length > 0) &&
      blocks.reduce((size, block) => size + (block.type === "text" ? block.text.length : 0), 0) <= 32000,
    "Input requires content and unique block IDs (text limit 32000)",
  );
export type Attachment = z.infer<typeof attachmentSchema>;
export type FileRef = z.infer<typeof fileRefSchema>;
export type Content = z.infer<typeof contentSchema>;
export type Block = z.infer<typeof blockSchema>;
export type Message = z.infer<typeof messageSchema>;
export type InputBlock = z.infer<typeof inputBlockSchema>;
export type PublicError = z.infer<typeof publicErrorSchema>;
