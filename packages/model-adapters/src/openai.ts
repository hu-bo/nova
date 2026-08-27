import { ProviderError, providerResponseMessage, retryStream, type RetryConfig } from "./retry.js";
import type { Block, Message, ModelEvent, ModelRef, ModelRequest, StreamFn, Usage } from "./types.js";

/** OpenAI Chat Completions-compatible adapter, including OpenAI-compatible gateways. */
export function openAiChatStream(ref: ModelRef, retry?: RetryConfig): StreamFn {
  return (request, signal) => retryStream(() => attempt(ref, request, signal), signal, retry);
}

/** @deprecated Use openAiChatStream for the Chat Completions wire format. */
export const openAiStream = openAiChatStream;

async function* attempt(ref: ModelRef, request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
  if (!ref.apiKey) throw new ProviderError("Missing API key for OpenAI-compatible provider");
  let response: Response;
  try {
    response = await fetch(`${chatCompletionsBaseUrl(ref.baseUrl)}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${ref.apiKey}`,
      },
      body: JSON.stringify({
        model: ref.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: chatMessages(request),
        ...(request.tools.length
          ? {
              tools: request.tools.map((item) => ({
                type: "function",
                function: { name: item.name, description: item.description, parameters: item.parameters },
              })),
            }
          : {}),
        ...(request.maxOutput ? { max_tokens: request.maxOutput } : {}),
        ...reasoning(request.thinking),
      }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ProviderError(`Connection failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new ProviderError(
      providerResponseMessage(response, body),
      response.status === 429 || response.status >= 500,
      response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : undefined,
      isContextOverflow(response.status, body) ? "context_overflow" : undefined,
    );
  }

  const states = new Map<number, OutputState>();
  const decoder = new TextDecoder();
  let buffer = "";
  let stopReason: Extract<ModelEvent, { type: "finish" }>["stopReason"] | undefined;
  const getState = (index: number, kind: OutputState["kind"]): OutputState => {
    const existing = states.get(index);
    if (existing) return existing;
    const created: OutputState = { kind, text: "", callId: "", name: "", started: false, ended: false };
    states.set(index, created);
    return created;
  };
  const end = (index: number, state: OutputState): ModelEvent[] => {
    if (state.ended) return [];
    state.ended = true;
    const block: Block =
      state.kind === "tool_call"
        ? { type: "tool_call", callId: state.callId, name: state.name, args: parseArguments(state.text) }
        : state.kind === "thinking"
          ? { type: "thinking", text: state.text }
          : { type: "text", text: state.text };
    return [
      ...(state.started ? [] : [{ type: "block.start", index, blockType: state.kind } as ModelEvent]),
      { type: "block.end", index, block },
    ];
  };
  const process = (chunk: any): ModelEvent[] => {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? {};
    const events: ModelEvent[] = [];
    if (typeof delta.content === "string" && delta.content) {
      const state = getState(0, "text");
      if (!state.started) {
        state.started = true;
        events.push({ type: "block.start", index: 0, blockType: "text" });
      }
      state.text += delta.content;
      events.push({ type: "block.delta", index: 0, delta: delta.content });
    }
    const reasoningText = typeof delta.reasoning_content === "string" ? delta.reasoning_content : delta.reasoning;
    if (typeof reasoningText === "string" && reasoningText) {
      const state = getState(1, "thinking");
      if (!state.started) {
        state.started = true;
        events.push({ type: "block.start", index: 1, blockType: "thinking" });
      }
      state.text += reasoningText;
      events.push({ type: "block.delta", index: 1, delta: reasoningText });
    }
    for (const call of delta.tool_calls ?? []) {
      const index = Number(call.index ?? 0) + 2;
      const state = getState(index, "tool_call");
      if (call.id) state.callId = String(call.id);
      if (call.function?.name) state.name = String(call.function.name);
      if (!state.started) {
        state.started = true;
        events.push({ type: "block.start", index, blockType: "tool_call" });
      }
      if (typeof call.function?.arguments === "string" && call.function.arguments) {
        state.text += call.function.arguments;
        events.push({ type: "block.delta", index, delta: call.function.arguments });
      }
    }
    if (chunk.usage) events.push({ type: "usage", usage: chatUsage(chunk.usage) });
    if (choice?.finish_reason) {
      for (const [index, state] of states) events.push(...end(index, state));
      stopReason = finishReason(choice.finish_reason);
    }
    return events;
  };
  try {
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          for (const event of process(JSON.parse(data))) yield event;
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          throw new ProviderError("Malformed Chat Completions SSE event", true);
        }
      }
    }
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`Stream interrupted: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  if (!stopReason) throw new ProviderError("Chat Completions stream ended before finish", true);
  yield { type: "finish", stopReason };
}

/** Accept both SDK-style roots (https://host) and API prefixes (https://host/v1). */
function chatCompletionsBaseUrl(baseUrl: string | undefined): string {
  const value = (baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  try {
    const url = new URL(value);
    if (!url.pathname || url.pathname === "/") url.pathname = "/v1";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

type OutputState = {
  kind: "text" | "thinking" | "tool_call";
  text: string;
  callId: string;
  name: string;
  started: boolean;
  ended: boolean;
};

function chatMessages(request: ModelRequest): unknown[] {
  return [
    ...(request.system ? [{ role: "system", content: request.system }] : []),
    ...request.messages.flatMap(messageToChat),
  ];
}
function messageToChat(message: Message): unknown[] {
  const content: unknown[] = [],
    toolCalls: unknown[] = [],
    toolResults: unknown[] = [];
  for (const block of message.blocks) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    if (block.type === "image")
      content.push({ type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
    if (block.type === "tool_call")
      toolCalls.push({
        id: block.callId,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.args) },
      });
    if (block.type === "tool_result")
      toolResults.push({
        role: "tool",
        tool_call_id: block.callId,
        content: block.content
          .map((part) => (part.type === "text" ? part.text : `[image:${part.mimeType}]`))
          .join("\n"),
      });
  }
  const messages: unknown[] = [];
  if (content.length || toolCalls.length)
    messages.push({
      role: message.role,
      content:
        content.length === 1 && (content[0] as any).type === "text"
          ? (content[0] as any).text
          : content.length
            ? content
            : null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
  messages.push(...toolResults);
  return messages;
}
function reasoning(thinking: ModelRequest["thinking"]): Record<string, unknown> {
  return !thinking || thinking === "off" ? {} : { reasoning_effort: thinking };
}
function chatUsage(value: any): Usage {
  return {
    input: value.prompt_tokens ?? 0,
    output: value.completion_tokens ?? 0,
    cacheRead: value.prompt_tokens_details?.cached_tokens,
  };
}
function finishReason(reason: string): Extract<ModelEvent, { type: "finish" }>["stopReason"] {
  return reason === "tool_calls" || reason === "function_call"
    ? "tool_use"
    : reason === "length"
      ? "max_tokens"
      : "stop";
}
function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}
function isContextOverflow(status: number, body: string): boolean {
  if (status !== 400 && status !== 413) return false;
  const text = body.toLowerCase();
  return (
    text.includes("context_length_exceeded") ||
    text.includes("maximum context length") ||
    text.includes("context window") ||
    text.includes("too many tokens")
  );
}
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}
