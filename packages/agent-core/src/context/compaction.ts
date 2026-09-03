// §8 压缩 —— 保留首个目标与近期 turn，有界摘要中段；失败时只省略中段，原始 Entry 不删除。
import type { ModelRequest, StreamFn, TokenEstimator } from "@nova/model-adapters";
import type { Entry, EntryId } from "../session/entry.js";
import { toContextMessages } from "../session/tree.js";

export type CompactionTrigger = "manual" | "threshold" | "overflow";

export interface CompactionResult {
  trigger: CompactionTrigger;
  summarized: boolean; // false = 摘要失败硬截断，或没有可压缩内容（replacedFrom 为 null）
  replacedFrom: EntryId | null;
  replacedTo: EntryId | null;
}

export interface CompactionPlan {
  summary: string;
  summarized: boolean;
  startIndex: number;
  endIndex: number; // 替换 entries[startIndex..endIndex)
  replacedFrom: EntryId;
  replacedTo: EntryId;
}

const SUMMARIZER_SYSTEM =
  "你是会话压缩助手。把给定对话历史压缩成一份简洁但完整的摘要：保留用户目标、已做的决定、关键文件/命令/结果、未完成的事项。不遗漏会影响后续工作的细节，不复述寒暄。直接输出摘要正文。";

export async function planCompaction(
  entries: Entry[],
  deps: { stream: StreamFn; signal: AbortSignal; estimator: TokenEstimator; maxInputTokens: number },
  instruction?: string,
): Promise<CompactionPlan | null> {
  const turns = turnRanges(entries);
  if (turns.length === 0) return null;
  if (turns.length === 1 && !isCompleteTurn(entries, turns[0]!)) return null;
  if (turns.length <= 2 && entries[turns[0]!.start]?.kind === "compaction") return null;
  // 三个以上 turn 只压中段；历史较短时把已完成的首 turn 变成摘要。
  const middle = turns.length >= 3 ? turns.slice(1, -1) : [turns[0]!];
  const selected: TurnRange[] = [];
  for (const turn of middle) {
    const candidate = [...selected, turn];
    const request = summaryRequest(
      entries.slice(candidate[0]!.start, candidate.at(-1)!.end),
      deps.estimator,
      instruction,
    );
    if (deps.estimator.estimateRequest(request).tokens > deps.maxInputTokens && selected.length > 0) break;
    selected.push(turn);
    if (deps.estimator.estimateRequest(request).tokens > deps.maxInputTokens) break;
  }
  if (selected.length === 0) return null;
  const startIndex = selected[0]!.start;
  const endIndex = selected.at(-1)!.end;
  const replacedFrom = entries[startIndex]!.id;
  const replacedTo = entries[endIndex - 1]!.id;

  const summary = await summarize(entries.slice(startIndex, endIndex), deps, instruction);
  if (summary !== null) {
    return { summary, summarized: true, startIndex, endIndex, replacedFrom, replacedTo };
  }
  if (turns.length < 3) return null;
  return {
    summary: `[中间 ${selected.length} 个 turn 已从模型上下文省略；原始记录仍保留]`,
    summarized: false,
    startIndex,
    endIndex,
    replacedFrom,
    replacedTo,
  };
}

interface TurnRange {
  start: number;
  end: number;
}

function turnRanges(entries: Entry[]): TurnRange[] {
  const starts: number[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (
      (entry.kind === "message" &&
        entry.message.role === "user" &&
        !entry.message.blocks.some((block) => block.type === "tool_result")) ||
      (entry.kind === "compaction" && starts.length === 0)
    )
      starts.push(i);
  }
  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? entries.length }));
}

function isCompleteTurn(entries: Entry[], turn: TurnRange): boolean {
  let lastMessage: Entry | undefined;
  for (let i = turn.end - 1; i >= turn.start; i -= 1) {
    if (entries[i]?.kind === "message") {
      lastMessage = entries[i];
      break;
    }
  }
  return Boolean(
    lastMessage?.kind === "message" &&
    lastMessage.message.role === "assistant" &&
    !lastMessage.message.blocks.some((block) => block.type === "tool_call"),
  );
}

async function summarize(
  prefix: Entry[],
  deps: { stream: StreamFn; signal: AbortSignal; estimator: TokenEstimator; maxInputTokens: number },
  instruction?: string,
): Promise<string | null> {
  const request = summaryRequest(prefix, deps.estimator, instruction);
  if (deps.estimator.estimateRequest(request).tokens > deps.maxInputTokens) return null;
  if (request.messages.length === 0) return null;

  // 首次 + 临时失败重试 2 次；context overflow 立即停止，避免重复相同请求。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const text = await collectText(deps.stream(request, deps.signal));
      if (text.trim().length > 0) return text;
    } catch (error) {
      if (error instanceof SummaryOverflowError) return null;
    }
  }
  return null;
}

function summaryRequest(prefix: Entry[], estimator: TokenEstimator, instruction?: string): ModelRequest {
  const messages = toContextMessages(prefix, estimator);
  if (instruction)
    messages.push({
      id: `compact-instruction`,
      role: "user",
      createdAt: Date.now(),
      blocks: [{ type: "text", text: `补充要求：${instruction}` }],
    });
  return { system: SUMMARIZER_SYSTEM, messages, tools: [], maxOutput: 2_048 };
}

class SummaryOverflowError extends Error {}

async function collectText(events: AsyncIterable<import("@nova/model-adapters").ModelEvent>): Promise<string> {
  let text = "";
  for await (const event of events) {
    if (event.type === "block.end" && event.block.type === "text") text += event.block.text;
    if (event.type === "finish" && event.stopReason === "error") {
      if (event.errorCode === "context_overflow") throw new SummaryOverflowError();
      throw new Error(event.errorMessage ?? "summarization stream failed");
    }
  }
  return text;
}
