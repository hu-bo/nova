import { ProviderError, providerResponseMessage, retryStream, type RetryConfig } from "./retry.js";
import type { Block, Message, ModelEvent, ModelRef, ModelRequest, StreamFn } from "./types.js";

export function openAiResponsesStream(ref: ModelRef, retry?: RetryConfig): StreamFn {
  return (request, signal) => retryStream(() => attempt(ref, request, signal), signal, retry);
}

async function* attempt(ref: ModelRef, request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
  if (!ref.apiKey) throw new ProviderError("Missing API key for OpenAI-compatible provider");
  let response: Response;
  try {
    response = await fetch(`${(ref.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`, {
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
        ...(request.system ? { instructions: request.system } : {}),
        input: responseInput(request.messages),
        ...(request.tools.length
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })),
            }
          : {}),
        ...(request.maxOutput ? { max_output_tokens: request.maxOutput } : {}),
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

  const decoder = new TextDecoder();
  let buffer = "";
  let nextIndex = 0;
  let finished = false;
  const output = new Map<number, OutputState>();

  const ensure = (outputIndex: number, kind: OutputState["kind"], item?: any): OutputState => {
    const existing = output.get(outputIndex);
    if (existing) return existing;
    const state: OutputState = {
      kind,
      index: nextIndex++,
      text: kind === "tool_call" && typeof item?.arguments === "string" ? item.arguments : "",
      callId: kind === "tool_call" ? String(item?.call_id ?? item?.id ?? "") : "",
      name: kind === "tool_call" ? String(item?.name ?? "") : "",
      started: false,
      ended: false,
    };
    output.set(outputIndex, state);
    return state;
  };

  const start = (state: OutputState): ModelEvent[] => {
    if (state.started) return [];
    state.started = true;
    return [
      { type: "block.start", index: state.index, blockType: state.kind === "tool_call" ? "tool_call" : state.kind },
    ];
  };

  const end = (state: OutputState): ModelEvent[] => {
    if (state.ended) return [];
    const events = start(state);
    state.ended = true;
    const block: Block =
      state.kind === "tool_call"
        ? { type: "tool_call", callId: state.callId, name: state.name, args: parseArguments(state.text) }
        : state.kind === "thinking"
          ? { type: "thinking", text: state.text }
          : { type: "text", text: state.text };
    events.push({ type: "block.end", index: state.index, block });
    return events;
  };

  const processEvent = (event: any): ModelEvent[] => {
    const events: ModelEvent[] = [];
    const outputIndex = Number(event.output_index ?? 0);
    if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      events.push(...start(ensure(outputIndex, "tool_call", event.item)));
    } else if (event.type === "response.output_text.delta") {
      const state = ensure(outputIndex, "text");
      events.push(...start(state));
      const delta = typeof event.delta === "string" ? event.delta : "";
      state.text += delta;
      if (delta) events.push({ type: "block.delta", index: state.index, delta });
    } else if (event.type === "response.output_text.done") {
      const state = ensure(outputIndex, "text");
      if (typeof event.text === "string") state.text = event.text;
      events.push(...end(state));
    } else if (
      event.type === "response.reasoning_summary_text.delta" ||
      event.type === "response.reasoning_text.delta"
    ) {
      const state = ensure(outputIndex, "thinking");
      events.push(...start(state));
      const delta = typeof event.delta === "string" ? event.delta : "";
      state.text += delta;
      if (delta) events.push({ type: "block.delta", index: state.index, delta });
    } else if (event.type === "response.reasoning_summary_text.done" || event.type === "response.reasoning_text.done") {
      const state = ensure(outputIndex, "thinking");
      if (typeof event.text === "string") state.text = event.text;
      events.push(...end(state));
    } else if (event.type === "response.function_call_arguments.delta") {
      const state = ensure(outputIndex, "tool_call", event.item);
      if (event.call_id) state.callId = String(event.call_id);
      if (event.name) state.name = String(event.name);
      events.push(...start(state));
      const delta = typeof event.delta === "string" ? event.delta : "";
      state.text += delta;
      if (delta) events.push({ type: "block.delta", index: state.index, delta });
    } else if (event.type === "response.function_call_arguments.done") {
      const state = ensure(outputIndex, "tool_call", event.item);
      if (event.call_id) state.callId = String(event.call_id);
      if (event.name) state.name = String(event.name);
      if (typeof event.arguments === "string") state.text = event.arguments;
      events.push(...end(state));
    } else if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      const state = ensure(outputIndex, "tool_call", event.item);
      state.callId = String(event.item.call_id ?? state.callId);
      state.name = String(event.item.name ?? state.name);
      if (typeof event.item.arguments === "string") state.text = event.item.arguments;
      events.push(...end(state));
    } else if (event.type === "response.completed" || event.type === "response.incomplete") {
      for (const state of output.values()) events.push(...end(state));
      const usage = event.response?.usage;
      if (usage)
        events.push({
          type: "usage",
          usage: {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.input_tokens_details?.cached_tokens,
          },
        });
      const incompleteReason = event.response?.incomplete_details?.reason;
      const hasToolCall = [...output.values()].some((state) => state.kind === "tool_call");
      events.push({
        type: "finish",
        stopReason: incompleteReason === "max_output_tokens" ? "max_tokens" : hasToolCall ? "tool_use" : "stop",
      });
      finished = true;
    } else if (event.type === "response.failed" || event.type === "error") {
      const message =
        event.response?.error?.message ?? event.error?.message ?? event.message ?? "Responses API stream failed";
      throw new ProviderError(String(message));
    }
    return events;
  };

  try {
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          throw new ProviderError("Malformed Responses SSE event", true);
        }
        for (const item of processEvent(event)) yield item;
      }
    }
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`Stream interrupted: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  if (!finished) throw new ProviderError("Stream ended before response.completed", true);
}

type OutputState = {
  kind: "text" | "thinking" | "tool_call";
  index: number;
  text: string;
  callId: string;
  name: string;
  started: boolean;
  ended: boolean;
};

function responseInput(messages: Message[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    const content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> = [];
    for (const block of message.blocks) {
      if (block.type === "text") content.push({ type: "input_text", text: block.text });
      if (block.type === "image")
        content.push({ type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}` });
    }
    if (content.length) input.push({ role: message.role, content });
    for (const block of message.blocks) {
      if (block.type === "tool_call") {
        input.push({
          type: "function_call",
          call_id: block.callId,
          name: block.name,
          arguments: JSON.stringify(block.args),
        });
      } else if (block.type === "tool_result") {
        input.push({
          type: "function_call_output",
          call_id: block.callId,
          output: block.content
            .map((part) => (part.type === "text" ? part.text : `[image:${part.mimeType}]`))
            .join("\n"),
        });
      }
    }
  }
  return input;
}

function reasoning(thinking: ModelRequest["thinking"]): Record<string, unknown> {
  return !thinking || thinking === "off" ? {} : { reasoning: { effort: thinking } };
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
  const normalized = body.toLowerCase();
  return (
    normalized.includes("context_length_exceeded") ||
    normalized.includes("maximum context length") ||
    normalized.includes("context window") ||
    normalized.includes("too many tokens")
  );
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}
