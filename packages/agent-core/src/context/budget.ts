import type { ModelRef } from "@nova/model-adapters";

export const COMPACT_THRESHOLD = 0.85;
export const COMPACT_TARGET = 0.65;

export function maxInputTokens(model: ModelRef): number {
  const contextWindow = model.contextWindow ?? 128_000;
  const maxOutput = model.maxOutput ?? 16_384;
  const safetyMargin = Math.max(1_024, Math.ceil(contextWindow * 0.02));
  return Math.max(1, contextWindow - maxOutput - safetyMargin);
}

export function shouldCompact(estimatedInput: number, inputLimit: number): boolean {
  return inputLimit > 0 && estimatedInput >= inputLimit * COMPACT_THRESHOLD;
}

export function compactionTarget(inputLimit: number): number {
  return Math.max(1, Math.floor(inputLimit * COMPACT_TARGET));
}
