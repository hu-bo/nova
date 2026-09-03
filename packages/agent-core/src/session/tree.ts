// §5.1 parentId 树：当前分支 = 从叶子回溯到根（storage.loadEntries 已做）。
// 这里负责分支视图：压缩 Entry 是 append-only 树上的标记，加载后按标记折叠被替换的前缀。
import type { TokenEstimator } from "@nova/model-adapters";
import type { Block, Message } from "../types.js";
import type { Entry } from "./entry.js";

// 逐个应用 compaction 标记（按分支顺序；后一次压缩的 replacedFrom 指向前一次的压缩 Entry）。
// 标记在 append-only 树上位于被替换段之后（甚至跨上一次折叠），先移出原位再落位，否则会被重复保留。
export function branchView(branch: Entry[]): Entry[] {
  let view = branch;
  let i = 0;
  while (i < view.length) {
    const entry = view[i]!;
    if (entry.kind !== "compaction") {
      i += 1;
      continue;
    }
    const rest = view.filter((_, index) => index !== i);
    const from = rest.findIndex((candidate) => candidate.id === entry.replacedFrom);
    const to = rest.findIndex((candidate) => candidate.id === entry.replacedTo);
    if (from === -1 || to === -1 || to < from) {
      i += 1;
      continue;
    }
    const preservedConfig = rest
      .slice(from, to + 1)
      .filter(
        (candidate) =>
          candidate.kind === "model" || candidate.kind === "thinking-level" || candidate.kind === "active-tools",
      );
    view = [...rest.slice(0, from), entry, ...preservedConfig, ...rest.slice(to + 1)];
    i = from + 1; // 标记落在 from，从它之后继续
  }
  return view;
}

// 进模型上下文的只有 message；compaction 的摘要以 user message 形式注入。
// model / thinking-level / active-tools 是配置事实，不进消息。
export function toMessages(entries: Entry[]): Message[] {
  const messages: Message[] = [];
  for (const entry of entries) {
    if (entry.kind === "message") messages.push(entry.message);
    else if (entry.kind === "compaction") {
      messages.push({
        id: entry.id,
        role: "user",
        createdAt: entry.ts,
        blocks: [{ type: "text", text: `[以下是早前对话的摘要]\n${entry.summary}` }],
      });
    }
  }
  return messages;
}

// 请求投影不修改 Entry：旧 turn 的 thinking 可省略；tool_result 只在模型请求中按 token 保留头尾。
export function toContextMessages(
  entries: Entry[],
  estimator: TokenEstimator,
  toolResultLimit = 4_096,
  messageTextLimit?: number,
): Message[] {
  const messages = toMessages(entries);
  let currentTurnStart = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "user" && !message.blocks.some((block) => block.type === "tool_result")) {
      currentTurnStart = i;
      break;
    }
  }
  return messages.map((message, index) => ({
    ...message,
    blocks: message.blocks.flatMap((block): Block[] => {
      if (block.type === "thinking" && index < currentTurnStart) return [];
      if (block.type === "text" && messageTextLimit !== undefined)
        return [{ type: "text", text: truncateText(block.text, messageTextLimit, estimator, "消息") }];
      if (block.type !== "tool_result") return [block];
      return [
        {
          ...block,
          content: block.content.map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: truncateText(part.text, toolResultLimit, estimator, "工具输出") }
              : part,
          ),
        },
      ];
    }),
  }));
}

function truncateText(text: string, limit: number, estimator: TokenEstimator, label: string): string {
  const estimated = estimator.estimateText(text).tokens;
  if (estimated <= limit) return text;
  const marker = `\n… [${label}中段已省略，原始约 ${estimated.toLocaleString()} tokens] …\n`;
  const keepChars = Math.max(2, Math.floor((text.length * limit) / estimated) - marker.length);
  const head = Math.ceil(keepChars / 2);
  const tail = Math.floor(keepChars / 2);
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}
