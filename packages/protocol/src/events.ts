import { z } from "zod";
import { BlockSchema, TodoSchema, type Block, type Todo } from "./block.js";
import { DecisionRequestSchema, type DecisionRequest } from "./decision.js";
import { MessageStatusSchema, type ChatMessage } from "./rest.js";

export type UiEvent =
  | { type: "message.start"; messageId: string; role: "assistant" }
  | { type: "block.start"; messageId: string; index: number; block: Block }
  | { type: "block.delta"; messageId: string; index: number; delta: string }
  | { type: "block.end"; messageId: string; index: number; block: Block }
  | { type: "message.end"; messageId: string; status: ChatMessage["status"] }
  | { type: "tool.output"; callId: string; stream: "stdout" | "stderr"; text: string }
  | { type: "decision.requested"; request: DecisionRequest }
  | { type: "decision.resolved"; decisionId: string }
  | { type: "todo.updated"; items: Todo[] }
  | { type: "context.updated"; inputTokens: number | null; contextWindow: number }
  | { type: "run.end"; runId: string; stopReason: string }
  | { type: "error"; code: string; message: string };

export const UiEventSchema: z.ZodType<UiEvent> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.start"), messageId: z.string(), role: z.literal("assistant") }),
  z.object({
    type: z.literal("block.start"),
    messageId: z.string(),
    index: z.number().int().nonnegative(),
    block: BlockSchema,
  }),
  z.object({
    type: z.literal("block.delta"),
    messageId: z.string(),
    index: z.number().int().nonnegative(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("block.end"),
    messageId: z.string(),
    index: z.number().int().nonnegative(),
    block: BlockSchema,
  }),
  z.object({ type: z.literal("message.end"), messageId: z.string(), status: MessageStatusSchema }),
  z.object({
    type: z.literal("tool.output"),
    callId: z.string(),
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
  }),
  z.object({ type: z.literal("decision.requested"), request: DecisionRequestSchema }),
  z.object({ type: z.literal("decision.resolved"), decisionId: z.string() }),
  z.object({ type: z.literal("todo.updated"), items: z.array(TodoSchema) }),
  z.object({
    type: z.literal("context.updated"),
    inputTokens: z.number().int().nonnegative().nullable(),
    contextWindow: z.number().int().positive(),
  }),
  z.object({ type: z.literal("run.end"), runId: z.string(), stopReason: z.string() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);

export const SseEnvelopeSchema = z.object({
  id: z.string().min(1),
  event: UiEventSchema,
});
export type SseEnvelope = z.infer<typeof SseEnvelopeSchema>;
