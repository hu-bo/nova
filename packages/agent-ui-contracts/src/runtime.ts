import { z } from "zod";
import { idSchema, publicErrorSchema } from "./messages.js";
export const runStateSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "paused",
  "cancelling",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "cancelled_unconfirmed",
]);
export const runViewSchema = z
  .object({
    id: idSchema,
    state: runStateSchema,
    reason: z.string().optional(),
    waiting: z.enum(["interaction", "external"]).optional(),
    error: publicErrorSchema.optional(),
  })
  .strict();
export const configurationSchema = z
  .object({
    backendId: z.string().min(1).default("nova"),
    modelId: idSchema.nullable().default(null),
    mode: z.enum(["build", "plan"]).default("build"),
    reasoningEffort: z.enum(["off", "low", "medium", "high", "max"]).optional(),
    remoteConnectionId: idSchema.optional(),
  })
  .strict();
export const outputTailSchema = z
  .object({ text: z.string(), startOffset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative() })
  .strict()
  .refine((tail) => tail.nextOffset - tail.startOffset === tail.text.length, "Invalid output offsets");
export const toolOperationSchema = z
  .object({
    id: idSchema,
    callId: idSchema,
    state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "denied", "unknown"]),
    attempt: z.number().int().positive().optional(),
    stdout: outputTailSchema.optional(),
    stderr: outputTailSchema.optional(),
    error: publicErrorSchema.optional(),
  })
  .strict();
export const capabilitiesSchema = z
  .object({
    tools: z.boolean(),
    approval: z.boolean(),
    question: z.boolean(),
    steering: z.boolean(),
    resume: z.boolean(),
    compact: z.boolean(),
    images: z.boolean(),
    files: z.boolean(),
  })
  .strict();
export const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    contextUsed: z.number().int().nonnegative().optional(),
    contextLimit: z.number().int().positive().optional(),
  })
  .strict();
export type RunView = z.infer<typeof runViewSchema>;
export type Configuration = z.infer<typeof configurationSchema>;
export type ToolOperation = z.infer<typeof toolOperationSchema>;
export type OutputTail = z.infer<typeof outputTailSchema>;
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type Usage = z.infer<typeof usageSchema>;
export const isActiveRun = (state: string | undefined) =>
  Boolean(state && ["queued", "running", "waiting", "paused", "cancelling"].includes(state));
