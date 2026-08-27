import { jsonSchema, streamText, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { ProviderError, retryStream, type RetryConfig } from "./retry.js";
import type { Block, Message, ModelEvent, ModelRef, ModelRequest, StreamFn } from "./types.js";

export function openAiStream(ref: ModelRef, retry?: RetryConfig): StreamFn {
  return (request, signal) => retryStream(() => attempt(ref, request, signal), signal, retry);
}

async function* attempt(ref: ModelRef, request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
  if (!ref.apiKey) throw new ProviderError("Missing API key for OpenAI-compatible provider");
  console.log(ref)
  try {
    const provider = createOpenAI({ apiKey: ref.apiKey, baseURL: ref.baseUrl ?? "https://api.openai.com/v1" });
    const inputMessages = messages(request.messages);
    const result = streamText({
      model: provider.responses(ref.model),
      system: request.system || undefined,
      ...(inputMessages.length ? { messages: inputMessages } : { prompt: " " }),
      tools: Object.fromEntries(
        request.tools.map((item) => [
          item.name,
          tool({ description: item.description, inputSchema: jsonSchema(item.parameters) }),
        ]),
      ),
      maxOutputTokens: request.maxOutput,
      abortSignal: signal,
      providerOptions: {
        openai: {
          ...(request.thinking && request.thinking !== "off" ? { reasoningEffort: request.thinking } : {}),
        },
      },
    });

    const indexes = new Map<string, number>();
    const states = new Map<number, { kind: "text" | "thinking" | "tool_call"; text: string; ended: boolean }>();
    let nextIndex = 0;
    let finished = false;

    const indexOf = (id: string): number => {
      const existing = indexes.get(id);
      if (existing !== undefined) return existing;
      const index = nextIndex++;
      indexes.set(id, index);
      return index;
    };

    const start = (index: number, kind: "text" | "thinking" | "tool_call"): ModelEvent => {
      if (!states.has(index)) states.set(index, { kind, text: "", ended: false });
      return { type: "block.start", index, blockType: kind };
    };

    for await (const part of result.stream) {
      if (part.type === "text-delta") {
        const index = indexOf(part.id);
        if (part.text) {
          if (!states.has(index)) yield start(index, "text");
          states.get(index)!.text += part.text;
          yield { type: "block.delta", index, delta: part.text };
        }
      } else if (part.type === "reasoning-delta") {
        const index = indexOf(part.id);
        if (part.text) {
          if (!states.has(index)) yield start(index, "thinking");
          states.get(index)!.text += part.text;
          yield { type: "block.delta", index, delta: part.text };
        }
      } else if (part.type === "tool-call") {
        const index = indexOf(part.toolCallId);
        if (!states.has(index)) yield start(index, "tool_call");
        yield {
          type: "block.end",
          index,
          block: { type: "tool_call", callId: part.toolCallId, name: part.toolName, args: part.input },
        };
        states.get(index)!.ended = true;
      } else if (part.type === "finish") {
        for (const [index, state] of states) {
          if (state.ended) continue;
          const block: Block =
            state.kind === "thinking" ? { type: "thinking", text: state.text } : { type: "text", text: state.text };
          yield { type: "block.end", index, block };
          state.ended = true;
        }
        const usage = part.totalUsage;
        yield {
          type: "usage",
          usage: {
            input: usage.inputTokens ?? 0,
            output: usage.outputTokens ?? 0,
            cacheRead: usage.inputTokenDetails?.cacheReadTokens,
          },
        };
        yield { type: "finish", stopReason: finishReason(part.finishReason) };
        finished = true;
      } else if (part.type === "error") {
        throw new ProviderError(errorMessage(part.error));
      }
    }

    if (!finished) throw new ProviderError("OpenAI stream ended before finish", true);
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(errorMessage(error), true);
  }
}

function messages(source: Message[]): any[] {
  return source.flatMap((message): any[] => {
    const content = message.blocks.flatMap((block): any[] => {
      if (block.type === "text") return [{ type: "text", text: block.text }];
      if (block.type === "image") return [{ type: "image", image: `data:${block.mimeType};base64,${block.data}` }];
      if (block.type === "tool_call")
        return [{ type: "tool-call", toolCallId: block.callId, toolName: block.name, input: block.args }];
      if (block.type === "tool_result")
        return [
          {
            type: "tool-result",
            toolCallId: block.callId,
            toolName: "",
            output: {
              type: "text",
              value: block.content
                .map((part) => (part.type === "text" ? part.text : `[image:${part.mimeType}]`))
                .join("\n"),
            },
          },
        ];
      return [];
    });
    return content.length ? [{ role: message.role, content }] : [];
  });
}

function finishReason(reason: string): Extract<ModelEvent, { type: "finish" }>["stopReason"] {
  if (reason === "tool-calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "stop";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
