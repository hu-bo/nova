import type { AgentMessage, JsonValue } from "./message.js";
import type { UsageSummary } from "./run.js";
import type { SafeError } from "./errors.js";
export type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";
export interface ModelRouteSnapshot {
  readonly id: string;
  readonly configVersion: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly capabilities: { tools: boolean; images: boolean; files: boolean };
}
export interface ModelStepRequest {
  sessionId: string;
  runId: string;
  stepId: string;
  messages: readonly AgentMessage[];
  tools: readonly {
    name: string;
    description: string;
    inputSchema: JsonValue;
  }[];
  signal: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  route?: ModelRouteSnapshot;
}
export type ModelChunk =
  | { type: "text.delta"; partId: string; text: string }
  | { type: "thinking.delta"; partId: string; text: string }
  | { type: "tool.call"; callId: string; name: string; input: JsonValue }
  | { type: "message.completed"; message: AgentMessage }
  | { type: "usage"; usage: UsageSummary }
  | { type: "error"; error: SafeError }
  | { type: "reset"; attempt: number }
  | {
      type: "finished";
      reason: "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other";
    };
export interface ModelAdapter {
  readonly id: string;
  snapshot?(modelId?: string): ModelRouteSnapshot;
  update?(config: JsonValue): void;
  stream(request: ModelStepRequest): AsyncIterable<ModelChunk>;
}
