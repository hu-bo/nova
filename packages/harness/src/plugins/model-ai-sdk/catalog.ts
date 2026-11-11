import type { ReasoningEffort } from "../../contracts/model.js";

export const providerIds = [
  "openai",
  "openai-compatible",
  "anthropic",
  "deepseek",
  "minimax",
  "minimax-anthropic",
] as const;
export type ProviderId = (typeof providerIds)[number];
export type ProviderProtocol = "openai" | "anthropic";
export type ReasoningFormat = "none" | "openai" | "anthropic" | "deepseek" | "minimax";

export interface ModelProviderDefinition {
  readonly id: ProviderId;
  readonly label: string;
  readonly defaultBaseURL: string;
  readonly protocol: ProviderProtocol;
  readonly reasoningFormat: ReasoningFormat;
  /** Supported parameter mappings; model-level capabilities can restrict these further. */
  readonly thinkingLevels: readonly ReasoningEffort[];
}

const thinkingLevels = ["off", "low", "medium", "high", "max"] as const;
const minimaxThinkingLevels = ["low", "medium", "high", "max"] as const;
export const modelProviders = {
  openai: {
    id: "openai",
    label: "OpenAI",
    defaultBaseURL: "https://api.openai.com/v1",
    protocol: "openai",
    reasoningFormat: "openai",
    thinkingLevels,
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI Compatible",
    defaultBaseURL: "https://api.openai.com/v1",
    protocol: "openai",
    reasoningFormat: "none",
    thinkingLevels: [],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    defaultBaseURL: "https://api.anthropic.com/v1",
    protocol: "anthropic",
    reasoningFormat: "anthropic",
    thinkingLevels,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    defaultBaseURL: "https://api.deepseek.com/v1",
    protocol: "openai",
    reasoningFormat: "deepseek",
    thinkingLevels,
  },
  minimax: {
    id: "minimax",
    label: "MiniMax (OpenAI)",
    defaultBaseURL: "https://api.minimax.io/v1",
    protocol: "openai",
    reasoningFormat: "minimax",
    thinkingLevels: minimaxThinkingLevels,
  },
  "minimax-anthropic": {
    id: "minimax-anthropic",
    label: "MiniMax (Anthropic)",
    defaultBaseURL: "https://api.minimax.io/anthropic/v1",
    protocol: "anthropic",
    reasoningFormat: "minimax",
    thinkingLevels: minimaxThinkingLevels,
  },
} as const satisfies Record<ProviderId, ModelProviderDefinition>;

export const providerCatalog: readonly ModelProviderDefinition[] = providerIds.map((id) => modelProviders[id]);

/** Decode stored legacy routes at the adapter boundary; new configuration selects a provider directly. */
export function resolveProviderId(route: {
  provider?: ProviderId;
  protocol?: ProviderProtocol | "openai-chat";
  reasoningFormat?: ReasoningFormat;
}): ProviderId {
  if (route.provider) return route.provider;
  if (route.reasoningFormat === "minimax") return route.protocol === "anthropic" ? "minimax-anthropic" : "minimax";
  if (route.protocol === "anthropic") return "anthropic";
  if (route.reasoningFormat === "deepseek") return "deepseek";
  if (route.reasoningFormat === "openai") return "openai";
  return "openai-compatible";
}
