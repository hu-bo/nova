import { z } from "zod";
import { blockSchema, decimalSequenceSchema, idSchema, messageSchema, publicErrorSchema } from "./messages.js";
import { goalSchema, queuedInputSchema, todoSchema } from "./conversation.js";
import { interactionSchema } from "./interactions.js";
import { capabilitiesSchema, configurationSchema, runViewSchema, toolOperationSchema, usageSchema } from "./runtime.js";
const base = z.object({ sequence: decimalSequenceSchema, runId: idSchema.nullable() });
const event = <T extends string, S extends z.ZodType>(type: T, payload: S) =>
  base.extend({ type: z.literal(type), payload }).strict();
const textTarget = z.object({ messageId: idSchema, blockId: idSchema });
export const productEventSchema = z.discriminatedUnion("type", [
  event("message.started", z.object({ message: messageSchema }).strict()),
  event(
    "block.upsert",
    z.object({ messageId: idSchema, block: blockSchema, index: z.number().int().nonnegative() }).strict(),
  ),
  event("text.delta", textTarget.extend({ offset: z.number().int().nonnegative(), text: z.string() }).strict()),
  event("text.reset", textTarget.extend({ text: z.string() }).strict()),
  event("message.committed", z.object({ message: messageSchema }).strict()),
  event("tool.changed", z.object({ operation: toolOperationSchema }).strict()),
  event(
    "tool.output",
    z
      .object({
        operationId: idSchema,
        channel: z.enum(["stdout", "stderr"]),
        offset: z.number().int().nonnegative(),
        text: z.string(),
      })
      .strict(),
  ),
  event(
    "run.changed",
    z
      .object({
        run: runViewSchema,
        configuration: configurationSchema.optional(),
        capabilities: capabilitiesSchema.optional(),
      })
      .strict(),
  ),
  event("interaction.changed", z.object({ interaction: interactionSchema }).strict()),
  event("input.queued", z.object({ input: queuedInputSchema }).strict()),
  event("input.consumed", z.object({ input: queuedInputSchema }).strict()),
  event("input.removed", z.object({ input: queuedInputSchema }).strict()),
  event("input.rejected", z.object({ input: queuedInputSchema, error: publicErrorSchema }).strict()),
  event(
    "context.changed",
    z.object({ epoch: z.number().int().positive(), action: z.enum(["clear", "compact", "backend_change"]) }).strict(),
  ),
  event("plan.changed", z.object({ plan: z.array(todoSchema) }).strict()),
  event("goal.changed", z.object({ goal: goalSchema.nullable() }).strict()),
  event("usage.changed", z.object({ usage: usageSchema }).strict()),
]);
export type ProductEvent = z.infer<typeof productEventSchema>;
export type RuntimeEvent = ProductEvent extends infer E
  ? E extends ProductEvent
    ? Omit<E, "sequence">
    : never
  : never;
