export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";
export type ModelProtocol = "openai" | "anthropic";
export type OpenAiWireApi = "responses" | "chat-completions";
export type ReasoningFormat = "none" | "openai" | "anthropic" | "deepseek" | "minimax";
export type InputModality = "text" | "image";
export interface ModelRef {
  provider: "openai" | "anthropic" | "gateway";
  protocol?: ModelProtocol;
  wireApi?: OpenAiWireApi;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxOutput?: number;
  thinkingLevels?: ThinkingLevel[];
  parallelToolCalls?: boolean;
  reasoningFormat?: ReasoningFormat;
  inputModalities?: InputModality[];
}
export interface ModelInfo {
  id: string;
  contextWindow: number;
  maxOutput: number;
  thinkingLevels: ThinkingLevel[];
  parallelToolCalls: boolean;
  inputModalities: InputModality[];
}
export type ContentPart = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };
export type ThinkingData = { format: "deepseek" } | { format: "minimax"; details: unknown[] };
export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature?: string; data?: ThinkingData }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; status: "ok" | "error"; content: ContentPart[] }
  | { type: "image"; mimeType: string; data: string };
export interface Message {
  id: string;
  role: "user" | "assistant";
  blocks: Block[];
  createdAt: number;
}
export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  thinking?: ThinkingLevel;
  maxOutput?: number;
}
export type ModelEvent =
  | { type: "block.start"; index: number; blockType: "text" | "thinking" | "tool_call" }
  | { type: "block.delta"; index: number; delta: string }
  | { type: "block.end"; index: number; block: Block }
  | { type: "usage"; usage: Usage }
  | {
      type: "finish";
      stopReason: "stop" | "tool_use" | "max_tokens" | "error" | "aborted";
      errorMessage?: string;
      errorCode?: "context_overflow";
    };
export type StreamFn = (request: ModelRequest, signal: AbortSignal) => AsyncIterable<ModelEvent>;
export interface Model {
  info: ModelInfo;
  stream: StreamFn;
}
