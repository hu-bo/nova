import type { ZodType } from "zod";
import type { JsonValue } from "./message.js";
import type { ToolCallResult } from "./run.js";
import type { AgentEvent } from "./event.js";
export interface ToolContext {
  signal: AbortSignal;
  namespace: string;
  identity: Readonly<Record<string, JsonValue>>;
  sessionId: string;
  runId: string;
  executionId: string;
  callId: string;
  output?(channel: "stdout" | "stderr", text: string): Promise<void>;
  idempotencyKey: string;
}
export interface PreparedTool {
  readonly input: JsonValue;
  execute(context: ToolContext): Promise<JsonValue>;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodType<JsonValue>;
  outputSchema: ZodType<JsonValue>;
  /** Canonical schema for dynamic tools that do not have a Zod definition. */
  inputSchemaJson?: JsonValue;
  outputSchemaJson?: JsonValue;
  effects: "read" | "write" | "external-job";
  timeoutMs?: number;
  retry?: { maxAttempts: number; idempotent?: boolean };
  resourceKey?: (input: JsonValue) => string;
  prepare(input: unknown): PreparedTool;
  execute(input: unknown, context: ToolContext): Promise<JsonValue>;
}
export interface ToolInput<I extends JsonValue, O extends JsonValue> {
  name: string;
  description: string;
  inputSchema: ZodType<I>;
  outputSchema: ZodType<O>;
  effects: ToolDefinition["effects"];
  timeoutMs?: number;
  retry?: ToolDefinition["retry"];
  resourceKey?: ToolDefinition["resourceKey"];
  execute(input: I, context: ToolContext): Promise<O>;
}
export interface ToolPolicy {
  readonly id: string;
  authorize(input: {
    name: string;
    input: JsonValue;
    context: ToolContext;
  }): Promise<"allow" | "deny" | { kind: "ask"; continuationId: string }>;
}
export interface ToolRuntime {
  catalog(): readonly {
    name: string;
    description: string;
    inputSchema: JsonValue;
  }[];
  execute(
    calls: readonly { callId: string; name: string; input: JsonValue }[],
    run: {
      runId: string;
      stepId: string;
      signal: AbortSignal;
      emit(event: AgentEvent): void;
    },
  ): Promise<readonly ToolCallResult[]>;
}
