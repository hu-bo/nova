import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel, streamText } from "ai";
import type { ReasoningEffort } from "../../contracts/model.js";
import { FrameworkError } from "../../contracts/errors.js";
import { modelProviders, resolveProviderId, type ProviderId, type ReasoningFormat } from "./catalog.js";

export interface ProviderRoute {
  provider?: ProviderId;
  protocol?: "openai-chat";
  baseURL?: string;
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  parallelToolCalls?: boolean;
  reasoningFormat?: ReasoningFormat;
}

type ProviderOptions = Parameters<typeof streamText>[0]["providerOptions"];
type ProviderBinding = { model: LanguageModel; providerOptions: ProviderOptions };
type ProviderFactory = (
  route: ProviderRoute,
  fetch: typeof globalThis.fetch,
  effort?: ReasoningEffort,
) => ProviderBinding;

const thinkingBudgets = { low: 1024, medium: 4096, high: 8192, max: 16384 } satisfies Record<
  Exclude<ReasoningEffort, "off">,
  number
>;
// DeepSeek accepts low/high/max; its SDK also maps the standard medium level to high.
const deepseekEfforts = { low: "low", medium: "high", high: "high", max: "max" } as const satisfies Record<
  Exclude<ReasoningEffort, "off">,
  string
>;

function baseURL(route: ProviderRoute, provider: ProviderId): string {
  return (route.baseURL ?? modelProviders[provider].defaultBaseURL).replace(/\/$/, "");
}

function anthropicOptions(route: ProviderRoute, effort?: ReasoningEffort): ProviderOptions {
  const options: Record<string, import("../../contracts/message.js").JsonValue> = {
    disableParallelToolUse: route.parallelToolCalls === false,
  };
  if (!effort || route.reasoningFormat === "none") return { anthropic: options };
  if (effort === "off") return { anthropic: { ...options, thinking: { type: "disabled" } } };
  if (route.maxOutputTokens < 2048)
    throw new FrameworkError("MODEL_CONFIG", "Thinking requires at least 2048 output tokens.");
  return {
    anthropic: {
      ...options,
      thinking: { type: "enabled", budgetTokens: Math.min(route.maxOutputTokens - 1, thinkingBudgets[effort]) },
    },
  };
}

function anthropicModel(route: ProviderRoute, fetch: typeof globalThis.fetch, provider: ProviderId): LanguageModel {
  const base = baseURL(route, provider);
  return createAnthropic({
    baseURL: /\/v1$/.test(base) ? base : base + "/v1",
    apiKey: route.apiKey,
    fetch,
  })(route.model);
}

function compatibleModel(route: ProviderRoute, fetch: typeof globalThis.fetch, provider: ProviderId): LanguageModel {
  return createOpenAICompatible({
    name: provider,
    baseURL: baseURL(route, provider),
    apiKey: route.apiKey,
    fetch,
    includeUsage: true,
    transformRequestBody: (body: Record<string, unknown>) => ({
      ...body,
      ...(route.parallelToolCalls === undefined ? {} : { parallel_tool_calls: route.parallelToolCalls }),
      ...(provider === "minimax" ? { reasoning_split: true } : {}),
    }),
  }).chatModel(route.model);
}

/** Each registered provider owns its SDK and parameter dialect; the stream pipeline is shared. */
const providerFactories = {
  openai(route, fetch, effort) {
    const reasoningEffort = effort === "off" ? "none" : effort;
    return {
      model: createOpenAI({ baseURL: baseURL(route, "openai"), apiKey: route.apiKey, fetch }).chat(route.model),
      providerOptions: {
        openai: {
          ...(route.parallelToolCalls === undefined ? {} : { parallelToolCalls: route.parallelToolCalls }),
          ...(effort && route.reasoningFormat !== "none"
            ? {
                reasoningEffort,
                maxCompletionTokens: route.maxOutputTokens,
                forceReasoning: true,
              }
            : {}),
        },
      },
    };
  },
  "openai-compatible"(route, fetch) {
    return { model: compatibleModel(route, fetch, "openai-compatible"), providerOptions: {} };
  },
  anthropic(route, fetch, effort) {
    return { model: anthropicModel(route, fetch, "anthropic"), providerOptions: anthropicOptions(route, effort) };
  },
  deepseek(route, fetch, effort) {
    const options: ProviderOptions = {};
    if (effort && route.reasoningFormat !== "none")
      options.deepseek = {
        thinking: { type: effort === "off" ? "disabled" : "enabled" },
        ...(effort === "off" ? {} : { reasoningEffort: deepseekEfforts[effort] }),
      };
    return {
      model: createDeepSeek({ baseURL: baseURL(route, "deepseek"), apiKey: route.apiKey, fetch }).chat(route.model),
      providerOptions: options,
    };
  },
  minimax(route, fetch, effort) {
    return {
      model: compatibleModel(route, fetch, "minimax"),
      providerOptions: {
        minimax: effort && route.reasoningFormat !== "none" ? { reasoningEffort: effort } : {},
      },
    };
  },
  "minimax-anthropic"(route, fetch, effort) {
    return {
      model: anthropicModel(route, fetch, "minimax-anthropic"),
      providerOptions: {
        anthropic: {
          disableParallelToolUse: route.parallelToolCalls === false,
          ...(effort && route.reasoningFormat !== "none" ? { effort } : {}),
        },
      },
    };
  },
} satisfies Record<ProviderId, ProviderFactory>;

export function bindProvider(
  route: ProviderRoute,
  fetch: typeof globalThis.fetch,
  effort?: ReasoningEffort,
): ProviderBinding {
  const provider = resolveProviderId(route);
  const definition: import("./catalog.js").ModelProviderDefinition = modelProviders[provider];
  if (effort && route.reasoningFormat !== "none" && !definition.thinkingLevels.includes(effort))
    throw new FrameworkError("MODEL_CONFIG", "Provider does not support the requested reasoning effort.");
  return providerFactories[provider](route, fetch, effort);
}
