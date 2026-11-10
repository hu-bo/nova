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
import type { UploadStorage } from "../attachments/index.js";
import type { FastifyBaseLogger } from "fastify";
import { createHash } from "node:crypto";

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
const tokenCount = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new FrameworkError("MODEL_USAGE", "Invalid provider token usage");
  return Number(value);
};
/** Accumulated per-stream facts; protocol consumers mutate it, the generator reads it after the loop. */
type ProviderStreamState = {
  calls: Map<number, { id: string; name: string; args: string }>;
  native: Map<number, Record<string, unknown>>;
  usage: import("@nnova/harness").UsageSummary;
  finish: string;
  stopped: boolean;
  reasoning: string;
};
type ProviderEventResult = { text: string; thinking: string };
type StreamDiagnostics = {
  readChunks: number;
  responseBytes: number;
  frames: number;
  pendingCharacters: number;
  reachedEof: boolean;
};
// Native continuation blocks and signed thinking stay in `native`/`reasoning` for the Harness replay.
function consumeAnthropicEvent(event: Record<string, unknown>, state: ProviderStreamState): ProviderEventResult {
  const observed = record(event.usage ?? record(event.message).usage);
  state.usage.inputTokens = tokenCount(observed.input_tokens) ?? state.usage.inputTokens;
  state.usage.outputTokens = tokenCount(observed.output_tokens) ?? state.usage.outputTokens;
  state.usage.cachedInputTokens = tokenCount(observed.cache_read_input_tokens) ?? state.usage.cachedInputTokens;
  let deltaText = "",
    deltaThinking = "";
  const index = Number(event.index ?? 0);
  if (event.type === "content_block_start") {
    const block = record(event.content_block);
    state.native.set(index, { ...block });
    if (block.type === "tool_use") state.calls.set(index, { id: string(block.id), name: string(block.name), args: "" });
    if (block.type === "text") deltaText = string(block.text);
  }
  if (event.type === "content_block_delta") {
    const delta = record(event.delta),
      block = state.native.get(index);
    if (delta.type === "text_delta") {
      deltaText = string(delta.text);
      if (block) block.text = string(block.text) + deltaText;
    }
    if (delta.type === "thinking_delta" && block) {
      deltaThinking = string(delta.thinking);
      block.thinking = string(block.thinking) + deltaThinking;
    }
    if (delta.type === "signature_delta" && block) block.signature = string(block.signature) + string(delta.signature);
    if (delta.type === "input_json_delta") {
      const call = state.calls.get(index);
      if (call) call.args += string(delta.partial_json);
    }
  }
  if (event.type === "message_delta") state.finish = string(record(event.delta).stop_reason);
  if (event.type === "message_stop") state.stopped = true;
  return { text: deltaText, thinking: deltaThinking };
}
function consumeOpenAIEvent(event: Record<string, unknown>, state: ProviderStreamState): ProviderEventResult {
  const observed = record(event.usage ?? record(event.message).usage);
  state.usage.inputTokens = tokenCount(observed.prompt_tokens) ?? state.usage.inputTokens;
  state.usage.outputTokens = tokenCount(observed.completion_tokens) ?? state.usage.outputTokens;
  state.usage.cachedInputTokens =
    tokenCount(record(observed.prompt_tokens_details).cached_tokens) ?? state.usage.cachedInputTokens;
  state.usage.reasoningTokens =
    tokenCount(record(observed.completion_tokens_details).reasoning_tokens) ?? state.usage.reasoningTokens;
  const choices = Array.isArray(event.choices) ? event.choices : [];
  const choice = record(choices[0]),
    delta = record(choice.delta);
  const deltaText = string(delta.content),
    deltaThinking = string(delta.reasoning_content);
  state.reasoning += deltaThinking;
  if (choice.finish_reason) state.finish = string(choice.finish_reason);
  for (const value of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    const item = record(value),
      index = Number(item.index),
      fn = record(item.function);
    const call = state.calls.get(index) ?? { id: "", name: "", args: "" };
    call.id += string(item.id);
    call.name += string(fn.name);
    call.args += string(fn.arguments);
    state.calls.set(index, call);
  }
  return { text: deltaText, thinking: deltaThinking };
}

/** Failed HTTP status maps to a stable code; rate limits stay distinguishable from auth failures. */
function requestFailureCode(status: number): "MODEL_RATE_LIMITED" | "MODEL_AUTH_FAILED" | "MODEL_REQUEST_FAILED" {
  if (status === 429) return "MODEL_RATE_LIMITED";
  if (status === 401 || status === 403) return "MODEL_AUTH_FAILED";
  return "MODEL_REQUEST_FAILED";
}
/** Provider stop reasons map onto Harness finished reasons; unknown reasons read as a normal stop. */
function finishedReason(finish: string): "tool-calls" | "length" | "stop" {
  if (finish === "tool_use" || finish === "tool_calls") return "tool-calls";
  if (finish === "length" || finish === "max_tokens") return "length";
  return "stop";
}

export async function modelRequest(
  route: Route,
  request: ModelStepRequest,
  getImageUrl: (uri: string) => Promise<string>,
) {
  const { model, provider } = route;
  const anthropic = provider.protocol === "anthropic";
  const messages: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (anthropic) {
      if (message.role === "system") continue;
      const native = message.metadata?.anthropicContent;
      const content = Array.isArray(native)
        ? native
        : await Promise.all(
            message.parts.map(async (part) => {
              if (part.type === "text") return { type: "text", text: part.text };
              if (part.type === "tool-call")
                return { type: "tool_use", id: part.callId, name: part.name, input: part.input };
              if (part.type === "image")
                return { type: "image", source: { type: "url", url: await getImageUrl(part.reference.uri) } };
              if (part.type === "tool-result")
                return {
                  type: "tool_result",
                  tool_use_id: part.callId,
                  content: JSON.stringify(part.value),
                  is_error: part.status !== "succeeded",
                };
              throw new FrameworkError("MODEL_INCOMPATIBLE", "Unsupported model input.");
            }),
          );
      messages.push({ role: message.role === "tool" ? "user" : message.role, content });
      continue;
    }
    if (message.role === "tool") {
      messages.push(
        ...message.parts.flatMap((part) =>
          part.type === "tool-result"
            ? [{ role: "tool", tool_call_id: part.callId, content: JSON.stringify(part.value) }]
            : [],
        ),
      );
      continue;
    }
    const calls = message.parts.flatMap((part) =>
      part.type === "tool-call"
        ? [{ id: part.callId, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input) } }]
        : [],
    );
    const content: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] = [];
    for (const part of message.parts) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
      else if (part.type === "image")
        content.push({ type: "image_url", image_url: { url: await getImageUrl(part.reference.uri) } });
    }
    messages.push({
      role: message.role,
      content: content.length === 1 && content[0]?.type === "text" ? content[0].text : content,
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(message.metadata?.reasoningContent ? { reasoning_content: message.metadata.reasoningContent } : {}),
    });
  }
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
  let path = "/chat/completions";
  if (anthropic) path = /\/v1$/.test(base) ? "/messages" : "/v1/messages";
  return { url: base + path, body };
}

/** The provider's native continuation blocks stay inside Harness, never in the UI event journal. */
export function configuredModelPlugin(
  route: Route,
  uploads: UploadStorage,
  ownerUserId: string,
  logger: FastifyBaseLogger,
): PluginDefinition {
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
          capabilities: { tools: true, images: true, files: false },
        }),
        async *stream(request): AsyncIterable<ModelChunk> {
          const startedAt = Date.now();
          let log = logger.child({
            component: "configured-model",
            conversationId: request.sessionId,
            runId: request.runId,
            stepId: request.stepId,
            providerId: route.provider.id,
            protocol: route.provider.protocol,
            modelId: route.model.id,
            upstreamModel: route.model.upstreamName,
            reasoningFormat: route.model.reasoningFormat,
            reasoningEffort: request.reasoningEffort ?? null,
            maxOutputTokens: Number(route.model.maxOutput),
            contextWindow: Number(route.model.contextWindow),
            parallelToolCalls: route.model.parallelToolCalls,
            messageCount: request.messages.length,
            toolCount: request.tools.length,
          });
          const state: ProviderStreamState = {
            calls: new Map(),
            native: new Map(),
            usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null },
            finish: "",
            stopped: false,
            reasoning: "",
          };
          const diagnostics: StreamDiagnostics = {
            readChunks: 0,
            responseBytes: 0,
            frames: 0,
            pendingCharacters: 0,
            reachedEof: false,
          };
          let answer = "",
            bytes = 0,
            eventCount = 0,
            reasoningCharacters = 0;
          const summary = () => ({
            ...diagnostics,
            elapsedMs: Date.now() - startedAt,
            eventCount,
            finishReason: state.finish,
            stopped: state.stopped,
            outputCharacters: answer.length,
            reasoningCharacters,
            toolCalls: [...state.calls].slice(0, 32).map(([index, call]) => ({
              index,
              hasId: Boolean(call.id),
              hasName: Boolean(call.name),
              argumentCharacters: call.args.length,
            })),
            toolCallCount: state.calls.size,
          });
          const signal = AbortSignal.any([request.signal, context.signal, AbortSignal.timeout(180_000)]);
          try {
            const { url, body } = await modelRequest(route, request, async (uri) => {
              const prefix = "nova-object:";
              if (!uri.startsWith(prefix)) throw new FrameworkError("MODEL_INCOMPATIBLE", "Invalid image reference.");
              return (await uploads.imageUrl(ownerUserId, { kind: "object", key: uri.slice(prefix.length) })).url;
            });
            const endpoint = new URL(url);
            const requestBody = JSON.stringify(body);
            // Never record the serialized request, credentials, URL query or provider payloads.
            log = log.child({
              providerOrigin: endpoint.origin,
              providerPath: endpoint.pathname,
              requestBytes: Buffer.byteLength(requestBody),
              requestHash: createHash("sha256").update(requestBody).digest("hex"),
            });
            log.info("Model request started");
            const response = await fetch(url, {
              method: "POST",
              redirect: "error",
              signal,
              headers: {
                "content-type": "application/json",
                authorization: "Bearer " + route.credential,
                ...(route.provider.protocol === "anthropic"
                  ? { "x-api-key": route.credential, "anthropic-version": "2023-06-01" }
                  : {}),
              },
              body: requestBody,
            });
            log = log.child({
              httpStatus: response.status,
              contentType: response.headers.get("content-type"),
              contentEncoding: response.headers.get("content-encoding"),
              upstreamRequestId: (response.headers.get("x-request-id") ?? response.headers.get("request-id"))?.slice(
                0,
                200,
              ),
            });
            log.info({ elapsedMs: Date.now() - startedAt }, "Model response received");
            if (!response.ok || !response.body) {
              await response.body?.cancel();
              const code = requestFailureCode(response.status);
              throw new FrameworkError(code, "Model request failed (HTTP " + response.status + ").");
            }
            const parts: MessagePart[] = [];
            const consume = route.provider.protocol === "anthropic" ? consumeAnthropicEvent : consumeOpenAIEvent;
            for await (const value of providerEvents(response.body, diagnostics)) {
              request.signal.throwIfAborted();
              eventCount++;
              if (value === "[DONE]") {
                state.stopped = true;
                break;
              }
              const event = record(value);
              const choice = record(Array.isArray(event.choices) ? event.choices[0] : undefined);
              log.debug(
                {
                  eventNumber: eventCount,
                  eventType: string(event.type).slice(0, 80) || "chat.completion.chunk",
                  finishReason: string(choice.finish_reason || record(event.delta).stop_reason).slice(0, 80),
                  hasError: Boolean(event.error || event.type === "error"),
                },
                "Model stream event",
              );
              if (event.error || event.type === "error")
                throw new FrameworkError("MODEL_REQUEST_FAILED", "Model stream failed.");
              const delta = consume(event, state);
              reasoningCharacters += delta.thinking.length;
              bytes += Buffer.byteLength(JSON.stringify(event));
              if (bytes > 8 * 1024 * 1024)
                throw new FrameworkError("MODEL_OUTPUT_LIMIT", "Model output exceeded its limit.");
              if (delta.thinking) yield { type: "thinking.delta", partId: "thinking", text: delta.thinking };
              if (delta.text) {
                answer += delta.text;
                yield { type: "text.delta", partId: "text", text: delta.text };
              }
            }
            const { calls, native, usage, finish, stopped, reasoning } = state;
            if (!stopped || !finish)
              throw new FrameworkError("MODEL_PROTOCOL", "Model stream ended before completion.");
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
            const metadata = {
              ...(native.size ? { anthropicContent: json([...native.values()]) } : {}),
              ...(reasoning ? { reasoningContent: reasoning } : {}),
            };
            log.info({ ...summary(), usage }, "Model stream completed");
            yield {
              type: "message.completed",
              message: {
                role: "assistant",
                parts,
                ...(native.size || reasoning ? { metadata } : {}),
              },
            };
            yield { type: "usage", usage };
            yield { type: "finished", reason: finishedReason(finish) };
          } catch (error) {
            log.error(
              {
                ...summary(),
                errorCode: error instanceof FrameworkError ? error.code : "MODEL_TRANSPORT",
                errorMessage: error instanceof FrameworkError ? error.message : undefined,
                errorName: error instanceof Error ? error.name : "UNKNOWN",
                transportCode: string(record(error instanceof Error ? error.cause : undefined).code),
                aborted: signal.aborted,
                abortReason: signal.aborted && signal.reason instanceof Error ? signal.reason.name : undefined,
              },
              "Model stream failed",
            );
            throw error;
          }
        },
      });
    },
  };
}

async function* providerEvents(
  body: ReadableStream<Uint8Array>,
  diagnostics: StreamDiagnostics,
): AsyncIterable<unknown> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      diagnostics.readChunks++;
      diagnostics.responseBytes += chunk.value?.byteLength ?? 0;
      diagnostics.reachedEof = chunk.done;
      // Normalize after joining reads: a CRLF pair can straddle network chunks.
      buffer = (buffer + decoder.decode(chunk.value, { stream: !chunk.done })).replace(/\r\n/g, "\n");
      diagnostics.pendingCharacters = buffer.length;
      if (buffer.length > 2 * 1024 * 1024)
        throw new FrameworkError("MODEL_PROTOCOL", "Model stream frame is too large.");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        diagnostics.frames++;
        diagnostics.pendingCharacters = buffer.length;
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
