import { anthropicStream } from "./anthropic.js";
import { openAiChatStream } from "./openai.js";
import { openAiResponsesStream } from "./responses.js";
import type { Model, ModelRef } from "./types.js";
export type * from "./types.js";
export type { RetryConfig } from "./retry.js";
export { ProviderError, retryStream } from "./retry.js";
export { openAiChatStream, openAiStream } from "./openai.js";
export { openAiResponsesStream } from "./responses.js";

export function createModel(ref: ModelRef): Model {
  const protocol = ref.protocol ?? (ref.provider === "anthropic" ? "anthropic" : "openai");
  const stream =
    protocol === "anthropic"
      ? anthropicStream(ref)
      : ref.wireApi === "chat-completions"
        ? openAiChatStream(ref)
        : openAiResponsesStream(ref);
  const reasoningFormat =
    ref.reasoningFormat ?? (protocol === "anthropic" ? "anthropic" : ref.provider === "openai" ? "openai" : "none");
  return {
    info: {
      id: ref.model,
      contextWindow: ref.contextWindow ?? 128_000,
      maxOutput: ref.maxOutput ?? 16_384,
      thinkingLevels: ref.thinkingLevels ?? (reasoningFormat === "none" ? [] : ["off", "low", "medium", "high", "max"]),
      parallelToolCalls: ref.parallelToolCalls ?? true,
      inputModalities: ref.inputModalities ?? ["text", "image"],
    },
    stream,
  };
}
