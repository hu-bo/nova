// §8 预算 —— 从最近一次 assistant usage 估算已用 token，对比 model 的 contextWindow。
import type { Usage } from "../types.js";

export const COMPACT_THRESHOLD = 0.8;

// usage.input 是最近一次请求的输入 token 数，即当前上下文的直接量度
export function shouldCompact(lastUsage: Usage | null, contextWindow: number): boolean {
  if (!lastUsage || contextWindow <= 0) return false;
  return lastUsage.input > contextWindow * COMPACT_THRESHOLD;
}
