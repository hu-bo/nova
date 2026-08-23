// §8 压缩 —— cut point 必须落在完整 turn 边界；摘要失败重试 2 次，仍失败按 overflow 硬截断最早的完整 turn。
import type { ModelRequest, StreamFn } from "@nova/model-adapters";
import type { Entry, EntryId } from "../session/entry.js";
import { toMessages } from "../session/tree.js";

export type CompactionTrigger = "manual" | "threshold" | "overflow";

export interface CompactionResult {
  trigger: CompactionTrigger;
  summarized: boolean;          // false = 摘要失败硬截断，或没有可压缩内容（replacedFrom 为 null）
  replacedFrom: EntryId | null;
  replacedTo: EntryId | null;
}

export interface CompactionPlan {
  summary: string;
  summarized: boolean;
  cutIndex: number;             // 保留 entries[cutIndex..]，前缀被摘要替换
  replacedFrom: EntryId;
  replacedTo: EntryId;
}

const SUMMARIZER_SYSTEM = "你是会话压缩助手。把给定对话历史压缩成一份简洁但完整的摘要：保留用户目标、已做的决定、关键文件/命令/结果、未完成的事项。不遗漏会影响后续工作的细节，不复述寒暄。直接输出摘要正文。";

// 完整 turn 边界（§8：不得切开 tool_call 与 tool_result），从尾部找第一个合法位置：
// ① 新 user message（不含 tool_result）= 一个完整 turn 的起点，切开它之前；
// ② tool_result 回执之后（该 assistant 回合已闭环）——且它后面必须还有内容，
//    否则保留段为空或只剩孤立 tool_result（对应 tool_call 已被摘要替换，请求非法）。
export function findCutPoint(entries: Entry[]): number | null {
  for (let i = entries.length - 1; i >= 1; i -= 1) {
    const item = entries[i]!;
    if (item.kind !== "message" || item.message.role !== "user") continue;
    const hasToolResult = item.message.blocks.some(block => block.type === "tool_result");
    if (!hasToolResult) return i;
    if (i + 1 < entries.length) return i + 1;
  }
  return null;
}

export async function planCompaction(
  entries: Entry[],
  deps: { stream: StreamFn; signal: AbortSignal },
  instruction?: string,
): Promise<CompactionPlan | null> {
  const cutIndex = findCutPoint(entries);
  if (cutIndex === null || cutIndex === 0) return null;
  const replacedFrom = entries[0]!.id;
  const replacedTo = entries[cutIndex - 1]!.id;

  const summary = await summarize(entries.slice(0, cutIndex), deps, instruction);
  if (summary !== null) {
    return { summary, summarized: true, cutIndex, replacedFrom, replacedTo };
  }
  // 摘要失败（已重试 2 次）→ overflow 硬截断最早的完整 turn，用占位摘要保持分支可折叠
  const firstBoundary = findEarliestBoundary(entries);
  if (firstBoundary === null) return null;
  return {
    summary: `[摘要失败，已硬截断早前 ${firstBoundary} 条 Entry]`,
    summarized: false,
    cutIndex: firstBoundary,
    replacedFrom,
    replacedTo: entries[firstBoundary - 1]!.id,
  };
}

function findEarliestBoundary(entries: Entry[]): number | null {
  for (let i = 1; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.kind === "message" && entry.message.role === "user") return i;
  }
  return null;
}

async function summarize(prefix: Entry[], deps: { stream: StreamFn; signal: AbortSignal }, instruction?: string): Promise<string | null> {
  const messages = toMessages(prefix);
  if (messages.length === 0) return null;
  if (instruction) messages.push({ id: `compact-instruction`, role: "user", createdAt: Date.now(), blocks: [{ type: "text", text: `补充要求：${instruction}` }] });
  const request: ModelRequest = { system: SUMMARIZER_SYSTEM, messages, tools: [] };

  // 首次 + 重试 2 次
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const text = await collectText(deps.stream(request, deps.signal));
      if (text.trim().length > 0) return text;
    } catch {
      // 进入下一次重试
    }
  }
  return null;
}

async function collectText(events: AsyncIterable<import("@nova/model-adapters").ModelEvent>): Promise<string> {
  let text = "";
  for await (const event of events) {
    if (event.type === "block.end" && event.block.type === "text") text += event.block.text;
    if (event.type === "finish" && event.stopReason === "error") throw new Error(event.errorMessage ?? "summarization stream failed");
  }
  return text;
}
