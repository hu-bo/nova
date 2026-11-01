import {
  modelRouter,
  FrameworkError,
  type AgentMessage,
  type JsonValue,
  type MessagePart,
  type ModelChunk,
  type ModelStepRequest,
  type PluginDefinition,
} from "@nnova/harness";
import type { ModelRow, ProviderRow } from "../model-config/index.js";

type Route = { model: ModelRow; provider: ProviderRow; credential: string };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const string = (value: unknown) => (typeof value === "string" ? value : "");
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const text = (message: AgentMessage) =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

export function modelRequest(route: Route, request: ModelStepRequest) {
  const { model, provider } = route;
  const anthropic = provider.protocol === "anthropic";
  const messages = request.messages.flatMap((message): Record<string, unknown>[] => {
    if (anthropic) {
      if (message.role === "system") return [];
      const native = message.metadata?.anthropicContent;
      const content = Array.isArray(native)
        ? native
        : message.parts.map((part) => {
            if (part.type === "text") return { type: "text", text: part.text };
            if (part.type === "tool-call")
              return { type: "tool_use", id: part.callId, name: part.name, input: part.input };
            if (part.type === "tool-result")
              return {
                type: "tool_result",
                tool_use_id: part.callId,
                content: JSON.stringify(part.value),
                is_error: part.status !== "succeeded",
              };
            throw new FrameworkError("MODEL_INCOMPATIBLE", "Unsupported model input.");
          });
      return [{ role: message.role === "tool" ? "user" : message.role, content }];
    }
    if (message.role === "tool")
      return message.parts.flatMap((part) =>
        part.type === "tool-result"
          ? [{ role: "tool", tool_call_id: part.callId, content: JSON.stringify(part.value) }]
          : [],
      );
    const calls = message.parts.flatMap((part) =>
      part.type === "tool-call"
        ? [{ id: part.callId, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input) } }]
        : [],
    );
    return [
      {
        role: message.role,
        content: text(message),
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(message.metadata?.reasoningContent ? { reasoning_content: message.metadata.reasoningContent } : {}),
      },
    ];
  });
  const body: Record<string, unknown> = {
    model: model.upstreamName,
    messages,
    stream: true,
    max_tokens: Number(model.maxOutput),
  };
  if (!anthropic) body.stream_options = { include_usage: true };
  if (anthropic)
    body.system = request.messages
      .filter((message) => message.role === "system")
      .map(text)
      .join("\n\n");
  if (request.tools.length) {
    body.tools = request.tools.map((tool) =>
      anthropic
        ? { name: tool.name, description: tool.description, input_schema: tool.inputSchema }
        : {
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
          },
    );
    if (!anthropic) body.parallel_tool_calls = model.parallelToolCalls;
  }
  const effort = request.reasoningEffort;
  if (effort) {
    if (model.reasoningFormat === "anthropic") {
      const maximum = Number(model.maxOutput);
      if (effort !== "off" && maximum < 2048)
        throw new FrameworkError("MODEL_CONFIG", "Thinking requires at least 2048 output tokens.");
      body.thinking =
        effort === "off"
          ? { type: "disabled" }
          : {
              type: "enabled",
              budget_tokens: Math.min(maximum - 1, { low: 1024, medium: 4096, high: 8192, max: 16384 }[effort]),
            };
    } else if (model.reasoningFormat === "deepseek") {
      body.thinking = { type: effort === "off" ? "disabled" : "enabled" };
      if (effort !== "off") body.reasoning_effort = effort;
    } else if (model.reasoningFormat === "minimax" && anthropic) {
      body.output_config = { effort: effort === "off" ? "low" : effort };
    } else if (model.reasoningFormat === "openai" || model.reasoningFormat === "minimax") {
      body.reasoning_effort = effort === "off" ? "none" : effort;
      if (model.reasoningFormat === "openai") {
        delete body.max_tokens;
        body.max_completion_tokens = Number(model.maxOutput);
      }
    }
  }
  const base = provider.baseUrl.replace(/\/$/, "");
  return { url: base + (anthropic ? (/\/v1$/.test(base) ? "/messages" : "/v1/messages") : "/chat/completions"), body };
}

/** The provider's native continuation blocks stay inside Harness, never in the UI event journal. */
export function configuredModelPlugin(route: Route): PluginDefinition {
  return {
    manifest: {
      id: "nova.model.configured",
      version: "0.1.0",
      apiVersion: 1,
      scope: "kernel",
      requires: [],
      provides: [modelRouter],
    },
    setup(context) {
      context.provide(modelRouter, {
        id: route.model.id,
        snapshot: () => ({
          id: route.model.id,
          configVersion: 1,
          contextWindow: Number(route.model.contextWindow),
          maxOutputTokens: Number(route.model.maxOutput),
          capabilities: { tools: true, images: false, files: false },
        }),
        async *stream(request): AsyncIterable<ModelChunk> {
          const { url, body } = modelRequest(route, request);
          const response = await fetch(url, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.any([request.signal, context.signal, AbortSignal.timeout(180_000)]),
            headers: {
              "content-type": "application/json",
              authorization: "Bearer " + route.credential,
              ...(route.provider.protocol === "anthropic"
                ? { "x-api-key": route.credential, "anthropic-version": "2023-06-01" }
                : {}),
            },
            body: JSON.stringify(body),
          });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            const code =
              response.status === 429
                ? "MODEL_RATE_LIMITED"
                : response.status === 401 || response.status === 403
                  ? "MODEL_AUTH_FAILED"
                  : "MODEL_REQUEST_FAILED";
            throw new FrameworkError(code, "Model request failed (HTTP " + response.status + ").");
          }
          const parts: MessagePart[] = [];
          const calls = new Map<number, { id: string; name: string; args: string }>();
          const native = new Map<number, Record<string, unknown>>();
          let answer = "",
            reasoning = "",
            finish = "",
            stopped = false,
            bytes = 0;
          const usage: import("@nnova/harness").UsageSummary = {
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            reasoningTokens: null,
          };
          const tokenCount = (value: unknown): number | null => {
            if (value === undefined || value === null) return null;
            if (!Number.isSafeInteger(value) || Number(value) < 0)
              throw new FrameworkError("MODEL_USAGE", "Invalid provider token usage");
            return Number(value);
          };
          for await (const value of providerEvents(response.body)) {
            request.signal.throwIfAborted();
            if (value === "[DONE]") {
              stopped = true;
              break;
            }
            const event = record(value);
            if (event.error || event.type === "error")
              throw new FrameworkError("MODEL_REQUEST_FAILED", "Model stream failed.");
            let deltaText = "",
              deltaThinking = "";
            const observed = record(event.usage ?? record(event.message).usage);
            if (route.provider.protocol === "anthropic") {
              usage.inputTokens = tokenCount(observed.input_tokens) ?? usage.inputTokens;
              usage.outputTokens = tokenCount(observed.output_tokens) ?? usage.outputTokens;
              usage.cachedInputTokens = tokenCount(observed.cache_read_input_tokens) ?? usage.cachedInputTokens;
            } else {
              usage.inputTokens = tokenCount(observed.prompt_tokens) ?? usage.inputTokens;
              usage.outputTokens = tokenCount(observed.completion_tokens) ?? usage.outputTokens;
              usage.cachedInputTokens =
                tokenCount(record(observed.prompt_tokens_details).cached_tokens) ?? usage.cachedInputTokens;
              usage.reasoningTokens =
                tokenCount(record(observed.completion_tokens_details).reasoning_tokens) ?? usage.reasoningTokens;
            }
            if (route.provider.protocol === "anthropic") {
              const index = Number(event.index ?? 0);
              if (event.type === "content_block_start") {
                const block = record(event.content_block);
                native.set(index, { ...block });
                if (block.type === "tool_use")
                  calls.set(index, { id: string(block.id), name: string(block.name), args: "" });
                if (block.type === "text") deltaText = string(block.text);
              }
              if (event.type === "content_block_delta") {
                const delta = record(event.delta),
                  block = native.get(index);
                if (delta.type === "text_delta") {
                  deltaText = string(delta.text);
                  if (block) block.text = string(block.text) + deltaText;
                }
                if (delta.type === "thinking_delta" && block) {
                  deltaThinking = string(delta.thinking);
                  block.thinking = string(block.thinking) + deltaThinking;
                }
                if (delta.type === "signature_delta" && block)
                  block.signature = string(block.signature) + string(delta.signature);
                if (delta.type === "input_json_delta") {
                  const call = calls.get(index);
                  if (call) call.args += string(delta.partial_json);
                }
              }
              if (event.type === "message_delta") finish = string(record(event.delta).stop_reason);
              if (event.type === "message_stop") stopped = true;
            } else {
              const choices = Array.isArray(event.choices) ? event.choices : [];
              const choice = record(choices[0]),
                delta = record(choice.delta);
              deltaText = string(delta.content);
              deltaThinking = string(delta.reasoning_content);
              reasoning += deltaThinking;
              if (choice.finish_reason) finish = string(choice.finish_reason);
              for (const value of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
                const item = record(value),
                  index = Number(item.index),
                  fn = record(item.function);
                const call = calls.get(index) ?? { id: "", name: "", args: "" };
                call.id += string(item.id);
                call.name += string(fn.name);
                call.args += string(fn.arguments);
                calls.set(index, call);
              }
            }
            bytes += Buffer.byteLength(JSON.stringify(event));
            if (bytes > 8 * 1024 * 1024)
              throw new FrameworkError("MODEL_OUTPUT_LIMIT", "Model output exceeded its limit.");
            if (deltaThinking) yield { type: "thinking.delta", partId: "thinking", text: deltaThinking };
            if (deltaText) {
              answer += deltaText;
              yield { type: "text.delta", partId: "text", text: deltaText };
            }
          }
          if (!stopped || !finish) throw new FrameworkError("MODEL_PROTOCOL", "Model stream ended before completion.");
          if (answer) parts.push({ id: "text", type: "text", text: answer });
          for (const [index, call] of calls) {
            if (!call.id || !call.name) throw new FrameworkError("MODEL_PROTOCOL", "Invalid model tool call.");
            let input: JsonValue;
            try {
              input = json(JSON.parse(call.args || "{}"));
            } catch {
              throw new FrameworkError("MODEL_PROTOCOL", "Invalid model tool arguments.");
            }
            if (native.get(index)) native.get(index)!.input = input;
            parts.push({ type: "tool-call", callId: call.id, name: call.name, input });
            yield { type: "tool.call", callId: call.id, name: call.name, input };
          }
          yield {
            type: "message.completed",
            message: {
              role: "assistant",
              parts,
              ...(native.size || reasoning
                ? {
                    metadata: {
                      ...(native.size ? { anthropicContent: json([...native.values()]) } : {}),
                      ...(reasoning ? { reasoningContent: reasoning } : {}),
                    },
                  }
                : {}),
            },
          };
          yield { type: "usage", usage };
          yield {
            type: "finished",
            reason:
              finish === "tool_use" || finish === "tool_calls"
                ? "tool-calls"
                : finish === "length" || finish === "max_tokens"
                  ? "length"
                  : "stop",
          };
        },
      });
    },
  };
}

async function* providerEvents(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, "\n");
      if (buffer.length > 2 * 1024 * 1024)
        throw new FrameworkError("MODEL_PROTOCOL", "Model stream frame is too large.");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        if (data === "[DONE]") yield data;
        else {
          try {
            yield JSON.parse(data) as unknown;
          } catch {
            throw new FrameworkError("MODEL_PROTOCOL", "Invalid model stream frame.");
          }
        }
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
