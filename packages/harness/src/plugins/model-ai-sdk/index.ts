import { createOpenAI } from "@ai-sdk/openai";
import { streamText, isStepCount, type ToolSet, type FinishReason } from "ai";
import { z } from "zod";
import type { PluginDefinition } from "../../contracts/plugin.js";
import type { ModelAdapter, ModelChunk, ModelRouteSnapshot, ModelStepRequest } from "../../contracts/model.js";
import type { MessagePart, JsonValue } from "../../contracts/message.js";
import { modelRouter, admission } from "../../contracts/capabilities.js";
import { FrameworkError } from "../../contracts/errors.js";
import { jsonValue } from "../../shared/json.js";
import { modelMessages } from "./messages.js";
const routeSchema = z
  .object({
    id: z.string().min(1),
    protocol: z.literal("openai-chat"),
    baseURL: z.url(),
    apiKey: z.string().min(1),
    model: z.string().min(1),
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    images: z.boolean().default(false),
    files: z.boolean().default(false),
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
    protocol: "openai-chat";
    baseURL: string;
    apiKey: string;
    model: string;
    contextWindow: number;
    maxOutputTokens: number;
    images?: boolean;
    files?: boolean;
  }[];
  defaultModel: string;
  maxConcurrentRequests?: number;
}
export function aiSdkModelPlugin(
  config: AiSdkModelConfig,
  transport?: { fetch: typeof globalThis.fetch },
): PluginDefinition {
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
          const url = new URL(route.baseURL);
          if (
            !["https:", "http:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            ids.has(route.id) ||
            route.maxOutputTokens >= route.contextWindow
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
          const lease = await resources.acquire(
            [
              {
                key: "model.requests",
                units: 1,
                limit: configuration.maxConcurrentRequests,
              },
            ],
            request.signal,
          );
          const controller = new AbortController();
          const signal = AbortSignal.any([context.signal, request.signal, controller.signal]);
          try {
            const provider = createOpenAI({
              baseURL: route.baseURL,
              apiKey: route.apiKey,
              ...(transport ? { fetch: transport.fetch } : {}),
            });
            const tools: ToolSet = {};
            for (const tool of request.tools)
              tools[tool.name] = {
                description: tool.description,
                inputSchema: z.fromJSONSchema(z.record(z.string(), z.unknown()).parse(tool.inputSchema)),
              };
            let providerError: unknown;
            const response = streamText({
              model: provider.chat(route.model),
              messages: modelMessages(request.messages),
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
            const thinkingParts = new Map<string, { id: string; type: "thinking"; text: string }>();
            const textParts = new Map<string, { id: string; type: "text"; text: string }>();
            let metadata: Readonly<Record<string, JsonValue>> | undefined;
            let finished: FinishReason | undefined;
            for await (const chunk of response.stream) {
              signal.throwIfAborted();
              if (chunk.type === "reasoning-delta") {
                let part = thinkingParts.get(chunk.id);
                if (!part) {
                  part = { id: chunk.id, type: "thinking", text: "" };
                  thinkingParts.set(chunk.id, part);
                  parts.push(part);
                }
                part.text += chunk.text;
                yield { type: "thinking.delta", partId: chunk.id, text: chunk.text };
              } else if (chunk.type === "text-delta") {
                let part = textParts.get(chunk.id);
                if (!part) {
                  part = { id: chunk.id, type: "text", text: "" };
                  textParts.set(chunk.id, part);
                  parts.push(part);
                }
                part.text += chunk.text;
                yield {
                  type: "text.delta",
                  partId: chunk.id,
                  text: chunk.text,
                };
              } else if (chunk.type === "tool-call") {
                if (chunk.providerExecuted)
                  throw new FrameworkError("REMOTE_TOOL_DENIED", "Provider-executed tools are not permitted.");
                const call = {
                  type: "tool-call" as const,
                  callId: chunk.toolCallId,
                  name: chunk.toolName,
                  input: jsonValue(chunk.input),
                };
                parts.push(call);
                yield {
                  type: "tool.call",
                  callId: call.callId,
                  name: call.name,
                  input: call.input,
                };
              } else if (chunk.type === "finish-step" && chunk.providerMetadata) {
                const value = jsonValue(JSON.parse(JSON.stringify(chunk.providerMetadata)));
                if (value && typeof value === "object" && !Array.isArray(value)) metadata = value;
              } else if (chunk.type === "finish") {
                finished = chunk.finishReason;
                const totalUsage = chunk.totalUsage;
                yield {
                  type: "usage",
                  usage: {
                    inputTokens: totalUsage?.inputTokens ?? null,
                    outputTokens: totalUsage?.outputTokens ?? null,
                    cachedInputTokens: totalUsage?.inputTokenDetails?.cacheReadTokens ?? null,
                    reasoningTokens: totalUsage?.outputTokenDetails?.reasoningTokens ?? null,
                  },
                };
              } else if (chunk.type === "error" || chunk.type === "tool-error")
                throw new FrameworkError("MODEL_REQUEST_FAILED", "Model stream failed.");
              else if (chunk.type === "abort") throw new FrameworkError("CANCELLED", "Model stream aborted.");
              else if (chunk.type === "file" || chunk.type === "reasoning-file" || chunk.type === "custom")
                throw new FrameworkError("MODEL_INCOMPATIBLE", "Unsupported provider content.");
            }
            if (providerError !== undefined) throw new FrameworkError("MODEL_REQUEST_FAILED", "Model stream failed.");
            if (!finished) throw new FrameworkError("MODEL_PROTOCOL", "Model stream ended without finish.");
            yield {
              type: "message.completed",
              message: {
                role: "assistant",
                parts,
                ...(metadata ? { metadata } : {}),
              },
            };
            yield { type: "finished", reason: finished };
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
