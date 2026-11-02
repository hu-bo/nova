import {
  configurationSchema,
  type Block,
  type Capabilities,
  type InputReceipt,
  type Interaction,
  type Message,
  type Snapshot,
} from "@nova/agent-ui-contracts";
import { projectToolContent } from "./tool-blocks.js";
import { runtimeAdapters, type Checkpoint } from "./runtime-adapter.js";
// 值以类型形式导入: 行类型由 $inferSelect 派生, 持久化访问仍归 repository 文件.
import type { conversations, messages, pendingInputs } from "../../../database/index.js";

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type PendingInputRow = typeof pendingInputs.$inferSelect;

/** Order-insensitive stable hash; backs every idempotency signature in the runs aggregate. */
export const fingerprint = (value: unknown): string =>
  Array.isArray(value)
    ? "[" + value.map(fingerprint).join(",") + "]"
    : value && typeof value === "object"
      ? "{" +
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => JSON.stringify(key) + ":" + fingerprint(item))
          .join(",") +
        "}"
      : (JSON.stringify(value) ?? "null");

export const conversationView = (conversation: ConversationRow) => ({
  id: conversation.id,
  title: conversation.title,
  mode: conversation.mode,
  projectId: conversation.projectId,
  epoch: conversation.contextEpoch,
  configuration: configurationSchema.parse(conversation.metadata.configuration ?? {}),
});

export const inputReceipt = (input: PendingInputRow): InputReceipt => ({
  id: input.id,
  state: input.status,
  ...(input.runId ? { runId: input.runId } : {}),
  ...(input.messageId ? { messageId: input.messageId } : {}),
});

export const queuedInput = (input: PendingInputRow) => ({
  ...inputReceipt(input),
  input: {
    blocks: input.payload.blocks,
    mode: input.mode,
    ...(input.payload.configuration ? { configuration: input.payload.configuration } : {}),
  },
});

export const messageDTO = (row: MessageRow): Message => ({
  id: row.id,
  runId: row.runId,
  sequence: row.sequence.toString(),
  role: row.role,
  state: row.state,
  blocks: row.blocks,
  createdAt: row.createdAt.toISOString(),
  ...(row.source ? { source: row.source } : {}),
});

export function effectiveCapabilities(conversation: ConversationRow, enabled = true): Capabilities {
  const environment = Boolean(conversation.metadata.binding || conversation.metadata.configuration?.remoteConnectionId);
  const backend = runtimeAdapters.get(conversation.metadata.configuration?.backendId ?? "nova")?.capabilities;
  return {
    tools: enabled && Boolean(backend?.tools),
    approval:
      enabled && environment && conversation.metadata.configuration?.mode !== "plan" && Boolean(backend?.approval),
    question: enabled && Boolean(backend?.question),
    steering: enabled && Boolean(backend?.steering),
    resume: enabled && Boolean(backend?.resume),
    compact: enabled && Boolean(backend?.compact),
    images: enabled && Boolean(backend?.images),
    files: enabled && environment && Boolean(backend?.files),
  };
}

export const emptyProjection = (conversation: ConversationRow): Snapshot => ({
  conversation: conversationView(conversation),
  cursor: conversation.lastEventSequence.toString(),
  messages: [],
  beforeSequence: null,
  run: null,
  operations: [],
  interactions: [],
  pendingInputs: [],
  plan: conversation.metadata.plan ?? [],
  goal: conversation.metadata.goal ?? null,
  capabilities: effectiveCapabilities(conversation),
});

export function publicInteraction(interaction: Checkpoint["interactions"][number]): Interaction {
  const { response: _response, acceptedRevision: _revision, ...view } = interaction;
  return view;
}

/** Native parts keep stable identity; text block ids stay compatible with streaming offsets. */
export function nativeBlocks(
  parts: readonly import("@nnova/harness").MessagePart[],
  executions: readonly import("@nnova/harness").ExecutionRecord[],
  messageId: string,
): Block[] {
  let textIndex = 0;
  return parts.map((part, index) => {
    const blockId =
      part.id ??
      (part.type === "text"
        ? textIndex++ === 0
          ? "text"
          : "text:" + textIndex
        : part.type === "tool-call"
          ? "call:" + part.callId
          : part.type === "tool-result"
            ? "result:" + part.callId
            : "part:" + index);
    if (part.type === "text") return { id: blockId, type: "text", text: part.text };
    if (part.type === "thinking") return { id: "thinking", type: "thinking", text: part.text };
    if (part.type === "tool-call")
      return { id: blockId, type: "tool_call", callId: part.callId, name: part.name, args: part.input };
    if (part.type === "tool-result") {
      const execution =
        executions.find((entry) => entry.callId === part.callId && entry.executionId === messageId) ??
        executions.find((entry) => entry.callId === part.callId);
      return {
        id: blockId,
        type: "tool_result",
        callId: part.callId,
        operationId: execution?.executionId ?? messageId,
        outcome:
          execution?.result?.outcome === "unknown"
            ? "unknown"
            : execution?.result?.error?.code === "TOOL_DENIED"
              ? "denied"
              : part.status,
        content: projectToolContent(part.name, part.value),
      };
    }
    return {
      id: blockId,
      type: "custom",
      name: part.type,
      data: JSON.parse(JSON.stringify(part)),
      fallback: part.type === "source" ? (part.title ?? part.uri) : "Attachment",
    };
  });
}

/** Provider-native thinking blocks that prefix a committed message (generic reasoning + Anthropic signed blocks). */
export function nativeThinkingBlocks(metadata: import("@nnova/harness").AgentMessage["metadata"]): Block[] {
  const blocks: Block[] = [];
  if (metadata?.reasoningContent && typeof metadata.reasoningContent === "string")
    blocks.unshift({ id: "thinking", type: "thinking", text: metadata.reasoningContent });
  const nativeContent = metadata?.anthropicContent;
  if (Array.isArray(nativeContent)) {
    const thinking = nativeContent
      .flatMap((part) =>
        part &&
        typeof part === "object" &&
        !Array.isArray(part) &&
        part.type === "thinking" &&
        typeof part.thinking === "string"
          ? [part.thinking]
          : [],
      )
      .join("\n");
    if (thinking) blocks.unshift({ id: "thinking", type: "thinking", text: thinking });
  }
  return blocks;
}
