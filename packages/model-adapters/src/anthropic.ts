import { ProviderError, providerResponseMessage, retryStream, type RetryConfig } from "./retry.js";
import type { Block, Message, ModelEvent, ModelRef, ModelRequest, StreamFn, Usage } from "./types.js";

export function anthropicStream(ref: ModelRef, retry?: RetryConfig): StreamFn {
  return (request, signal) => retryStream(() => attempt(ref, request, signal), signal, retry);
}

async function* attempt(ref: ModelRef, request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
  if (!ref.apiKey) throw new ProviderError("Missing API key for Anthropic provider");
  let response: Response;
  try {
    response = await fetch(`${(ref.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": ref.apiKey },
      body: JSON.stringify({
        model: ref.model,
        stream: true,
        system: request.system,
        max_tokens: request.maxOutput ?? 16_384,
        messages: messages(request.messages),
        tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
        ...thinking(ref.reasoningFormat ?? "anthropic", request),
      }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ProviderError(`Connection failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    if (isContextOverflow(response.status, body)) throw new ProviderError(providerResponseMessage(response, body, "Provider context overflow"), false, undefined, "context_overflow");
    throw new ProviderError(providerResponseMessage(response, body), response.status === 429 || response.status >= 500, response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : undefined);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let finish: Extract<ModelEvent, { type: "finish" }> | undefined;
  let usage: Usage = { input: 0, output: 0 };
  const blocks = new Map<number, AccumulatedBlock>();

  const processLine = (line: string): ModelEvent[] => {
    if (line.startsWith("event:")) { eventName = line.slice(6).trim(); return []; }
    if (!line.startsWith("data:")) return [];
    const raw = line.slice(5).trim();
    let data: any;
    try { data = JSON.parse(raw); } catch { throw new ProviderError(`Malformed SSE chunk: ${raw.slice(0, 200)}`, true); }
    const type = data.type ?? eventName;
    const events: ModelEvent[] = [];

    if (type === "error") throw new ProviderError(data.error?.message ?? "Anthropic stream error", data.error?.type === "overloaded_error");
    if (type === "message_start") { usage = mergeUsage(usage, data.message?.usage); return events; }
    if (type === "content_block_start") {
      const index = Number(data.index);
      const block = data.content_block;
      if (block?.type === "text") blocks.set(index, { type: "text", text: block.text ?? "" });
      else if (block?.type === "thinking") blocks.set(index, { type: "thinking", text: block.thinking ?? "", signature: block.signature });
      else if (block?.type === "tool_use") blocks.set(index, { type: "tool_call", callId: block.id ?? "", name: block.name ?? "", json: "", input: block.input });
      const current = blocks.get(index);
      if (current) events.push({ type: "block.start", index, blockType: current.type });
      return events;
    }
    if (type === "content_block_delta") {
      const index = Number(data.index);
      const current = blocks.get(index);
      if (!current) return events;
      const delta = data.delta;
      if (current.type === "text" && delta?.type === "text_delta") current.text += delta.text ?? "";
      else if (current.type === "thinking" && delta?.type === "thinking_delta") current.text += delta.thinking ?? "";
      else if (current.type === "thinking" && delta?.type === "signature_delta") current.signature = (current.signature ?? "") + (delta.signature ?? "");
      else if (current.type === "tool_call" && delta?.type === "input_json_delta") current.json += delta.partial_json ?? "";
      const value = delta?.text ?? delta?.thinking ?? delta?.partial_json ?? "";
      if (value) events.push({ type: "block.delta", index, delta: value });
      return events;
    }
    if (type === "content_block_stop") {
      const index = Number(data.index);
      const current = blocks.get(index);
      if (current) events.push({ type: "block.end", index, block: finishBlock(current) });
      return events;
    }
    if (type === "message_delta") {
      usage = mergeUsage(usage, data.usage);
      const reason = data.delta?.stop_reason;
      if (reason) finish = { type: "finish", stopReason: reason === "tool_use" ? "tool_use" : reason === "max_tokens" ? "max_tokens" : "stop" };
      return events;
    }
    if (type === "message_stop") {
      events.push({ type: "usage", usage });
      if (!finish) throw new ProviderError("Anthropic stream ended without stop_reason", true);
      events.push(finish);
    }
    return events;
  };

  try {
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) for (const event of processLine(line.trimEnd())) yield event;
    }
    buffer += decoder.decode();
    for (const line of buffer.split("\n")) for (const event of processLine(line.trimEnd())) yield event;
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`Stream interrupted: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  if (finish) return;
  throw new ProviderError("Stream ended before message_stop", true);
}

type AccumulatedBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature?: string }
  | { type: "tool_call"; callId: string; name: string; json: string; input: unknown };

function finishBlock(block: AccumulatedBlock): Block {
  if (block.type === "text") return block;
  if (block.type === "thinking") return { type: "thinking", text: block.text, ...(block.signature ? { signature: block.signature } : {}) };
  let args = block.input ?? {};
  if (block.json) { try { args = JSON.parse(block.json); } catch { args = {}; } }
  return { type: "tool_call", callId: block.callId, name: block.name, args };
}

function thinking(format: ModelRef["reasoningFormat"], request: ModelRequest): Record<string, unknown> {
  if (format === "none") return {};
  if (format === "deepseek") {
    if (request.thinking === "off") return { thinking: { type: "disabled" } };
    const effort = request.thinking === "max" ? "max" : request.thinking ? "high" : undefined;
    return { thinking: { type: "enabled" }, ...(effort ? { output_config: { effort } } : {}) };
  }
  if (format === "minimax") {
    return { thinking: { type: request.thinking === "off" ? "disabled" : "adaptive" } };
  }
  if (!request.thinking || request.thinking === "off") return {};
  const budget = request.thinking === "low" ? 1_024 : request.thinking === "medium" ? 4_096 : 8_192;
  return { thinking: { type: "enabled", budget_tokens: budget } };
}

function mergeUsage(current: Usage, raw: any): Usage {
  if (!raw) return current;
  return {
    input: current.input + (raw.input_tokens ?? 0),
    output: current.output + (raw.output_tokens ?? 0),
    cacheRead: (current.cacheRead ?? 0) + (raw.cache_read_input_tokens ?? 0),
    cacheWrite: (current.cacheWrite ?? 0) + (raw.cache_creation_input_tokens ?? 0),
  };
}

function messages(source: Message[]): unknown[] {
  return source.map(message => ({ role: message.role, content: message.blocks.flatMap(toAnthropicBlock) }));
}

function toAnthropicBlock(block: Block): unknown[] {
  switch (block.type) {
    case "text": return [{ type: "text", text: block.text }];
    case "thinking": return [{ type: "thinking", thinking: block.text, ...(block.signature ? { signature: block.signature } : {}) }];
    case "image": return [{ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }];
    case "tool_call": return [{ type: "tool_use", id: block.callId, name: block.name, input: block.args }];
    case "tool_result": return [{ type: "tool_result", tool_use_id: block.callId, is_error: block.status === "error", content: block.content.map(part => part.type === "text" ? { type: "text", text: part.text } : { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } }) }];
  }
}

function isContextOverflow(status: number, body: string): boolean {
  if (status !== 400 && status !== 413) return false;
  const normalized = body.toLowerCase();
  return normalized.includes("prompt is too long") || normalized.includes("context window") || normalized.includes("too many tokens");
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}
