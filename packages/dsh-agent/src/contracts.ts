export type JsonSchema = boolean | { readonly [keyword: string]: unknown };

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/**
 * 推理档位。`off` 会显式下发 `thinking: { type: "disabled" }`。
 * 不传则完全不下发 thinking 参数，由网关自行决定——默认开启思考的网关会把
 * maxOutputTokens 全部消耗在思考上，正文一个字都拿不到。
 */
export type ReasoningEffort = "off" | "low" | "medium" | "high";
export interface ModelConfig {
  id: string;
  protocol: "anthropic" | "openai-chat" | "openai-responses";
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxOutputTokens?: number;
  reasoning?: ReasoningEffort;
}
export interface ToolContext {
  signal: AbortSignal;
  sessionId: string;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: any, context: ToolContext): Promise<JsonValue>;
}
export function defineTool<Args = Record<string, unknown>>(tool: {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: Args, context: ToolContext): Promise<JsonValue>;
}): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

export type RunStatus = "succeeded" | "failed" | "cancelled" | "timed_out";
export interface AgentError {
  code: string;
  message: string;
}
export interface ToolCallResult {
  callId: string;
  toolName: string;
  status: "succeeded" | "failed";
  value?: JsonValue;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}
export interface AgentRunResult {
  sessionId: string;
  turnId: string;
  status: RunStatus;
  text: string;
  toolCalls: ToolCallResult[];
  usage?: Usage;
  error?: AgentError;
}
export type AgentEvent = { sessionId: string; turnId: string } & AgentEventPayload;
export type AgentEventPayload =
  | { type: "turn.started" }
  | { type: "turn.finished"; status: RunStatus }
  | { type: "assistant.delta"; text: string }
  | { type: "tool.started"; callId: string; toolName: string }
  | ({ type: "tool.finished" } & ToolCallResult)
  | { type: "compression.started" }
  | { type: "compression.finished"; status: "succeeded" | "failed" };
export interface OperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: AgentEvent) => void;
}
export interface SendOptions extends OperationOptions {
  text: string;
  model?: string;
}
export interface SessionOptions {
  sessionId: string;
  model?: string;
  systemPrompt: string;
  tools?: readonly ToolDefinition[];
  compression?: { enabled?: boolean; thresholdRatio?: number };
}
export interface CompactResult {
  status: "compacted" | "skipped" | "failed" | "cancelled" | "timed_out";
  error?: AgentError;
}
export interface AgentSession {
  readonly sessionId: string;
  send(options: SendOptions): Promise<AgentRunResult>;
  compact(options?: OperationOptions): Promise<CompactResult>;
  cancel(): void;
  dispose(): Promise<void>;
}
export interface KernelConfig {
  models: readonly ModelConfig[];
  defaultModel: string;
  maxConcurrentRuns?: number;
}
export interface DshAgentKernel {
  createAgent(options: SessionOptions): Promise<AgentSession>;
  updateModel(model: ModelConfig): Promise<void>;
  dispose(): Promise<void>;
}
export class DshAgentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DshAgentError";
  }
}
