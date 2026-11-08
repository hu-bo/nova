import type { Block, Message, OutputTail, ProductEvent, Snapshot, ToolOperation } from "@nova/agent-ui-contracts";
import { z } from "zod";

export const toolOutputQuery = z.object({ includeToolResults: z.enum(["true", "false"]).optional() }).strict();

const MAX_OUTPUT_CHARS = 12_000;
// Leave room for the SSE envelope even when every streamed character is JSON-escaped.
const MAX_STREAM_CHARS = 10_000;
const MAX_RESULT_BYTES = 48 * 1024;

function toolResult(block: Block, include: boolean): Block {
  if (block.type !== "tool_result") return block;
  if (!include) return { ...block, content: [] };

  // Older stored results and custom blocks can exceed the current presentation limits.
  const serialized = JSON.stringify(block.content);
  if (Buffer.byteLength(serialized) <= MAX_RESULT_BYTES) return block;
  const marker = "\n\n… 工具结果已截断";
  return {
    ...block,
    content: [{ id: "content", type: "text", text: serialized.slice(0, MAX_OUTPUT_CHARS - marker.length) + marker }],
  };
}

export function chatMessageOutput(message: Message, include: boolean): Message {
  return { ...message, blocks: message.blocks.map((block) => toolResult(block, include)) };
}

function boundTail(tail: OutputTail, limit: number): OutputTail {
  const startOffset = Math.min(tail.startOffset, limit);
  const nextOffset = Math.min(tail.nextOffset, limit);
  return { startOffset, nextOffset, text: tail.text.slice(0, nextOffset - startOffset) };
}

export function chatToolOperationOutput(operation: ToolOperation, include: boolean): ToolOperation {
  const { stdout, stderr, error, ...status } = operation;
  if (!include) return status;
  return {
    ...status,
    ...(stdout && { stdout: boundTail(stdout, MAX_STREAM_CHARS) }),
    ...(stderr && { stderr: boundTail(stderr, MAX_STREAM_CHARS) }),
    ...(error && { error: { ...error, message: error.message.slice(0, MAX_OUTPUT_CHARS) } }),
  };
}

export function chatSnapshotOutput<T extends Snapshot>(snapshot: T, include: boolean): T {
  return {
    ...snapshot,
    messages: snapshot.messages.map((message) => chatMessageOutput(message, include)),
    operations: snapshot.operations.map((operation) => chatToolOperationOutput(operation, include)),
  };
}

export function chatEventOutput(event: ProductEvent, include: boolean): ProductEvent {
  switch (event.type) {
    case "message.started":
    case "message.committed":
      return { ...event, payload: { message: chatMessageOutput(event.payload.message, include) } };
    case "block.upsert":
      return { ...event, payload: { ...event.payload, block: toolResult(event.payload.block, include) } };
    case "tool.changed":
      return { ...event, payload: { operation: chatToolOperationOutput(event.payload.operation, include) } };
    case "tool.output": {
      // Keep the journal sequence and clamp offsets consistently across replay and snapshots.
      const limit = include ? MAX_STREAM_CHARS : 0;
      const { offset, text } = event.payload;
      return {
        ...event,
        payload: {
          ...event.payload,
          offset: Math.min(offset, limit),
          text: text.slice(0, Math.max(0, limit - offset)),
        },
      };
    }
    default:
      return event;
  }
}
