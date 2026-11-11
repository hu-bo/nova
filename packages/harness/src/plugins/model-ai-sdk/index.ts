import {
  streamText,
  isStepCount,
  APICallError,
  TypeValidationError,
  InvalidResponseDataError,
  JSONParseError,
  type ToolSet,
  type FinishReason,
} from "ai";
import { z } from "zod";
import type { PluginDefinition } from "../../contracts/plugin.js";
import type { ModelAdapter, ModelChunk, ModelRouteSnapshot, ModelStepRequest } from "../../contracts/model.js";
import type { MessagePart, JsonValue } from "../../contracts/message.js";
import { modelRouter, admission } from "../../contracts/capabilities.js";
import { FrameworkError } from "../../contracts/errors.js";
import { jsonValue, positive } from "../../shared/json.js";
import { modelMessages } from "./messages.js";
export { normalizeModelMessage } from "./messages.js";
import { bindProvider } from "./providers.js";
import { modelProviders, providerIds, resolveProviderId, type ProviderId, type ReasoningFormat } from "./catalog.js";
import { modelTransport, type AiSdkModelOptions } from "./transport.js";
export {
  providerIds,
  providerCatalog,
  modelProviders,
  resolveProviderId,
  type ProviderId,
  type ProviderProtocol,
  type ReasoningFormat,
  type ModelProviderDefinition,
} from "./catalog.js";
export type { AiSdkModelLogger, AiSdkModelOptions } from "./transport.js";
const routeSchema = z
  .object({
    id: z.string().min(1),
    provider: z.enum(providerIds).optional(),
    protocol: z.literal("openai-chat").optional(),
    baseURL: z.url().optional(),
    apiKey: z.string().min(1),
    model: z.string().min(1),
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    images: z.boolean().default(false),
    files: z.boolean().default(false),
    parallelToolCalls: z.boolean().optional(),
    reasoningFormat: z.enum(["none", "openai", "anthropic", "deepseek", "minimax"]).optional(),
  })
  .strict();
const configSchema = z
  .object({
    models: z.array(routeSchema).min(1),
    defaultModel: z.string().min(1),
    maxConcurrentRequests: z.number().int().positive().default(4),
  })
  .strict();
export interface AiSdkModelConfig {
  models: readonly {
    id: string;
    provider?: ProviderId;
    protocol?: "openai-chat";
    baseURL?: string;
    apiKey: string;
    model: string;
    contextWindow: number;
    maxOutputTokens: number;
    images?: boolean;
    files?: boolean;
    parallelToolCalls?: boolean;
    reasoningFormat?: ReasoningFormat;
  }[];
  defaultModel: string;
  maxConcurrentRequests?: number;
}
export function aiSdkModelPlugin(config: AiSdkModelConfig, options: AiSdkModelOptions = {}): PluginDefinition {
  const requestTimeoutMs = positive(options.requestTimeoutMs ?? 180_000, "requestTimeoutMs");
  if (requestTimeoutMs > 2_147_483_647)
    throw new FrameworkError("INVALID_CONFIG", "requestTimeoutMs exceeds the supported timer range.");
  const parseConfiguration = (value: unknown): z.infer<typeof configSchema> => {
    try {
      return configSchema.parse(value);
    } catch {
      throw new FrameworkError("INVALID_CONFIG", "Invalid model configuration.");
    }
  };
  const initial = parseConfiguration(config);
  return {
    manifest: {
      id: "nnova.model.ai-sdk",
      version: "0.1.0",
      apiVersion: 1,
      scope: "kernel",
      requires: [admission],
      provides: [modelRouter],
    },
    config: {
      defaultModel: initial.defaultModel,
      modelCount: initial.models.length,
      maxConcurrentRequests: initial.maxConcurrentRequests,
    },
    setup(context) {
      const resources = context.resolve(admission);
      let version = 0;
      let current = initial;
      const snapshots = new Map<number, z.infer<typeof configSchema>>();
      function update(value: unknown): void {
        const next = parseConfiguration(value);
        const ids = new Set<string>();
        for (const route of next.models) {
          const url = new URL(route.baseURL ?? modelProviders[resolveProviderId(route)].defaultBaseURL);
          if (
            !["https:", "http:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            ids.has(route.id) ||
            route.maxOutputTokens > route.contextWindow
          )
            throw new FrameworkError("INVALID_CONFIG", "Invalid model route configuration.");
          ids.add(route.id);
        }
        if (!ids.has(next.defaultModel)) throw new FrameworkError("UNKNOWN_MODEL", "Default model is not registered.");
        if (snapshots.size >= 128)
          throw new FrameworkError(
            "MODEL_CONFIG_LIMIT",
            "Model configuration retention limit reached; create a new kernel.",
          );
        current = next;
        snapshots.set(++version, next);
      }
      update(initial);
      const model: ModelAdapter = {
        id: "ai-sdk",
        snapshot(id = current.defaultModel): ModelRouteSnapshot {
          const route = current.models.find((item) => item.id === id);
          if (!route) throw new FrameworkError("UNKNOWN_MODEL", "Requested model is not registered.");
          return Object.freeze({
            id,
            configVersion: version,
            contextWindow: route.contextWindow,
            maxOutputTokens: route.maxOutputTokens,
            capabilities: Object.freeze({
              tools: true,
              images: route.images,
              files: route.files,
            }),
          });
        },
        update,
        async *stream(request: ModelStepRequest): AsyncIterable<ModelChunk> {
          const snapshot = request.route ?? model.snapshot?.();
          if (!snapshot) throw new FrameworkError("UNKNOWN_MODEL", "Model route snapshot is required.");
          const configuration = snapshots.get(snapshot.configVersion);
          const route = configuration?.models.find((item) => item.id === snapshot.id);
          if (!route || !configuration) throw new FrameworkError("UNKNOWN_MODEL", "Model snapshot is unavailable.");
          for (const message of request.messages)
            for (const part of message.parts) {
              if ((part.type === "image" && !route.images) || (part.type === "file" && !route.files))
                throw new FrameworkError("MODEL_INCOMPATIBLE", "Model does not support the requested modality.");
            }
          const controller = new AbortController();
          const signal = AbortSignal.any([
            context.signal,
            request.signal,
            controller.signal,
            AbortSignal.timeout(requestTimeoutMs),
          ]);
          const lease = await resources
            .acquire(
              [
                {
                  key: "model.requests",
                  units: 1,
                  limit: configuration.maxConcurrentRequests,
                },
              ],
              signal,
            )
            .catch((error: unknown) => {
              throw modelFailure(error, signal);
            });
          const startedAt = Date.now();
          const log = options.logger?.child({
            component: "model-ai-sdk",
            conversationId: request.sessionId,
            runId: request.runId,
            stepId: request.stepId,
            modelId: route.id,
            provider: resolveProviderId(route),
            protocol: modelProviders[resolveProviderId(route)].protocol,
            upstreamModel: route.model,
          });
          const diagnostics = { readChunks: 0, responseBytes: 0, reachedEof: false };
          try {
            const binding = bindProvider(
              route,
              modelTransport(options, log, startedAt, diagnostics),
              request.reasoningEffort,
            );
            const tools: ToolSet = {};
            for (const tool of request.tools)
              tools[tool.name] = {
                description: tool.description,
                inputSchema: z.fromJSONSchema(z.record(z.string(), z.unknown()).parse(tool.inputSchema)),
              };
            let providerError: unknown;
            const response = streamText({
              model: binding.model,
              providerOptions: binding.providerOptions,
              messages: await modelMessages(request.messages, options.resolveImageUrl),
              tools,
              abortSignal: signal,
              maxOutputTokens: route.maxOutputTokens,
              maxRetries: 0,
              streamRetries: 0,
              stopWhen: isStepCount(1),
              allowSystemInMessages: true,
              experimental_download: async (references) => references.map(() => null),
              onError: ({ error }) => {
                providerError = error;
              },
            });
            const parts: MessagePart[] = [];
            const contentParts = new Map<string, Extract<MessagePart, { type: "text" | "thinking" }>>();
            let metadata: Readonly<Record<string, JsonValue>> | undefined;
            let finished: FinishReason | undefined;
            let rawFinishReason: string | undefined;
            for await (const chunk of response.stream) {
              signal.throwIfAborted();
              if (
                chunk.type === "reasoning-start" ||
                chunk.type === "reasoning-delta" ||
                chunk.type === "reasoning-end" ||
                chunk.type === "text-start" ||
                chunk.type === "text-delta" ||
                chunk.type === "text-end"
              ) {
                const partType = chunk.type.startsWith("reasoning") ? "thinking" : "text";
                const key = partType + ":" + chunk.id;
                const existing = contentParts.get(key);
                let part: Extract<MessagePart, { type: "text" | "thinking" }> = existing ?? {
                  id: chunk.id,
                  type: partType,
                  text: "",
                };
                if (!existing) {
                  contentParts.set(key, part);
                  parts.push(part);
                }
                if (chunk.providerMetadata) {
                  const updated = {
                    ...part,
                    metadata: mergeContinuationMetadata(part.metadata, chunk.providerMetadata),
                  };
                  parts[parts.indexOf(part)] = updated;
                  contentParts.set(key, updated);
                  part = updated;
                }
                if ("text" in chunk) {
                  part.text += chunk.text;
                  yield {
                    type: partType === "thinking" ? "thinking.delta" : "text.delta",
                    partId: chunk.id,
                    text: chunk.text,
                  };
                }
              } else if (chunk.type === "tool-call") {
                if (chunk.providerExecuted)
                  throw new FrameworkError("REMOTE_TOOL_DENIED", "Provider-executed tools are not permitted.");
                const call = {
                  type: "tool-call" as const,
                  callId: chunk.toolCallId,
                  name: chunk.toolName,
                  input: jsonValue(chunk.input),
                  ...(chunk.providerMetadata ? { metadata: continuationMetadata(chunk.providerMetadata) } : {}),
                };
                parts.push(call);
                yield {
                  type: "tool.call",
                  callId: call.callId,
                  name: call.name,
                  input: call.input,
                };
              } else if (chunk.type === "finish-step") {
                rawFinishReason = chunk.rawFinishReason;
                if (chunk.providerMetadata) metadata = continuationMetadata(chunk.providerMetadata);
              } else if (chunk.type === "finish") {
                finished = chunk.finishReason;
                const totalUsage = chunk.totalUsage;
                yield {
                  type: "usage",
                  usage: {
                    inputTokens: tokenCount(totalUsage?.inputTokens),
                    outputTokens: tokenCount(totalUsage?.outputTokens),
                    cachedInputTokens: tokenCount(totalUsage?.inputTokenDetails?.cacheReadTokens),
                    reasoningTokens: tokenCount(totalUsage?.outputTokenDetails?.reasoningTokens),
                  },
                };
              } else if (chunk.type === "error") throw modelFailure(chunk.error, signal, "MODEL_REQUEST_FAILED");
              else if (chunk.type === "tool-error")
                throw new FrameworkError("MODEL_PROTOCOL", "Invalid model tool call.");
              else if (chunk.type === "abort") throw new FrameworkError("CANCELLED", "Model stream aborted.");
              else if (chunk.type === "file" || chunk.type === "reasoning-file" || chunk.type === "custom")
                throw new FrameworkError("MODEL_INCOMPATIBLE", "Unsupported provider content.");
            }
            if (providerError !== undefined) throw modelFailure(providerError, signal, "MODEL_REQUEST_FAILED");
            if (!finished || !rawFinishReason)
              throw new FrameworkError("MODEL_PROTOCOL", "Model stream ended without finish.");
            if (finished === "error") throw new FrameworkError("MODEL_REQUEST_FAILED", "Model stream failed.");
            log?.info(
              { ...diagnostics, elapsedMs: Date.now() - startedAt, finishReason: finished },
              "Model stream completed",
            );
            yield {
              type: "message.completed",
              message: {
                role: "assistant",
                parts,
                ...(metadata ? { metadata } : {}),
              },
            };
            yield { type: "finished", reason: finished };
          } catch (error) {
            const failure = modelFailure(error, signal);
            log?.error(
              {
                ...diagnostics,
                elapsedMs: Date.now() - startedAt,
                errorCode: failure.code,
                errorMessage: failure.message,
                aborted: signal.aborted,
              },
              "Model stream failed",
            );
            throw failure;
          } finally {
            controller.abort();
            lease.release();
          }
        },
      };
      context.provide(modelRouter, model);
      context.onDispose(() => snapshots.clear());
    },
  };
}

function continuationMetadata(value: unknown): Readonly<Record<string, JsonValue>> {
  const parsed = jsonValue(JSON.parse(JSON.stringify(value)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new FrameworkError("MODEL_METADATA", "Invalid provider continuation metadata.");
  return parsed;
}

function mergeContinuationMetadata(
  previous: MessagePart["metadata"],
  value: unknown,
): Readonly<Record<string, JsonValue>> {
  const merged = { ...previous };
  for (const [provider, options] of Object.entries(continuationMetadata(value))) {
    const existing = merged[provider];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      options &&
      typeof options === "object" &&
      !Array.isArray(options)
    )
      merged[provider] = { ...existing, ...options };
    else merged[provider] = options;
  }
  return merged;
}

function tokenCount(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new FrameworkError("MODEL_USAGE", "Invalid provider token usage.");
  return value;
}

function modelFailure(
  error: unknown,
  signal: AbortSignal,
  fallback: "MODEL_REQUEST_FAILED" | "MODEL_TRANSPORT" = "MODEL_TRANSPORT",
): FrameworkError {
  if (signal.aborted) {
    if (signal.reason instanceof Error && signal.reason.name === "TimeoutError")
      return new FrameworkError("MODEL_TIMEOUT", "Model request timed out.");
    return new FrameworkError("CANCELLED", "Model stream aborted.");
  }
  if (error instanceof FrameworkError) return error;
  if (error instanceof Error && error.cause instanceof FrameworkError) return error.cause;
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 429) return new FrameworkError("MODEL_RATE_LIMITED", "Model rate limit exceeded.");
    if (status === 401 || status === 403)
      return new FrameworkError("MODEL_AUTH_FAILED", "Model authentication failed.");
    return new FrameworkError("MODEL_REQUEST_FAILED", "Model request failed.");
  }
  if (
    TypeValidationError.isInstance(error) ||
    InvalidResponseDataError.isInstance(error) ||
    JSONParseError.isInstance(error)
  )
    return new FrameworkError("MODEL_PROTOCOL", "Invalid model stream.");
  return new FrameworkError(fallback, "Model request failed.");
}
