import { z } from "zod";
import { decimalSequenceSchema, idSchema, inputBlocksSchema, messageSchema } from "./messages.js";
import { capabilitiesSchema, configurationSchema, runViewSchema, toolOperationSchema, usageSchema } from "./runtime.js";
import { interactionSchema } from "./interactions.js";
export const submitInputSchema = z
  .object({
    blocks: inputBlocksSchema,
    mode: z.enum(["next_run", "steer"]).default("next_run"),
    configuration: configurationSchema.optional(),
  })
  .strict();
export const inputReceiptSchema = z
  .object({
    id: idSchema,
    state: z.enum(["queued", "consumed", "removed", "rejected"]),
    runId: idSchema.optional(),
    messageId: idSchema.optional(),
  })
  .strict();
export const queuedInputSchema = inputReceiptSchema.extend({ input: submitInputSchema }).strict();
export const todoSchema = z
  .object({ id: idSchema, text: z.string(), status: z.enum(["pending", "in_progress", "completed", "blocked"]) })
  .strict();
export const goalInputSchema = z
  .object({
    objective: z.string().trim().min(1).max(32000),
    acceptanceCriteria: z.string().trim().max(8000).default(""),
    maxIterations: z.number().int().min(1).max(100).default(10),
  })
  .strict();
export const goalSchema = goalInputSchema
  .extend({
    iterations: z.number().int().nonnegative(),
    status: z.enum(["ready", "active", "paused", "completed"]),
    revision: z.number().int().positive(),
  })
  .strict();
export const conversationSchema = z
  .object({
    id: idSchema,
    title: z.string().nullable(),
    mode: z.enum(["chat", "project"]),
    projectId: idSchema.nullable(),
    epoch: z.number().int().positive(),
    configuration: configurationSchema,
  })
  .strict();
export const snapshotSchema = z
  .object({
    conversation: conversationSchema,
    cursor: decimalSequenceSchema,
    messages: z.array(messageSchema),
    beforeSequence: decimalSequenceSchema.nullable(),
    run: runViewSchema.nullable(),
    operations: z.array(toolOperationSchema),
    interactions: z.array(interactionSchema),
    pendingInputs: z.array(queuedInputSchema),
    plan: z.array(todoSchema).optional(),
    goal: goalSchema.nullable().optional(),
    usage: usageSchema.optional(),
    capabilities: capabilitiesSchema,
  })
  .strict();
export const messagePageSchema = z
  .object({
    items: z.array(messageSchema),
    beforeSequence: decimalSequenceSchema.nullable(),
    operations: z.array(toolOperationSchema),
  })
  .strict();
export type SubmitInput = z.infer<typeof submitInputSchema>;
export type InputReceipt = z.infer<typeof inputReceiptSchema>;
export type QueuedInput = z.infer<typeof queuedInputSchema>;
export type Todo = z.infer<typeof todoSchema>;
export type Goal = z.infer<typeof goalSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
