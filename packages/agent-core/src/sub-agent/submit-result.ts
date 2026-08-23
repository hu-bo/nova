import type { AgentTaskResult, AgentTool } from "../types.js";
import { z } from "../tool-schema.js";

const success = z.object({
  ok: z.literal(true),
  summary: z.string().trim().min(1),
  data: z.unknown().optional(),
});

const failure = z.object({
  ok: z.literal(false),
  summary: z.string().trim().min(1),
  error: z.object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    retryable: z.boolean().optional(),
  }),
});

const schema = z.discriminatedUnion("ok", [success, failure]);

export const submitResultTool: AgentTool<AgentTaskResult, AgentTaskResult> = {
  name: "submit_result",
  description: "Submit the structured result of an assigned task. Call this once, by itself, when the task is complete or cannot be completed.",
  schema,
  executionMode: "sequential",
  risk: "none",
  async execute(result) {
    return {
      status: "ok",
      content: [{ type: "text", text: result.summary }],
      details: result,
      terminate: true,
    };
  },
};
