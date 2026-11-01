import type { ProductEvent, Snapshot } from "@nova/agent-ui-contracts";
import { DomainError } from "../../shared/domain-error.js";

/** Durable positions contain no generated text or tool output. */
export type StreamState = {
  bytes: number;
  pendingBytes: number;
  pendingOutputBytes: number;
  messages: {
    id: string;
    sequence: string;
    createdAt: string;
    streaming: boolean;
    size: number;
    blocks: { id: string; type: string; offset: number; bytes: number }[];
  }[];
  operations: { id: string; stdout: number; stderr: number }[];
};
const textBytes = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;
export function streamStateOf(
  projection: Snapshot,
  bytes = Buffer.byteLength(JSON.stringify(projection)),
): StreamState {
  return {
    bytes,
    pendingBytes: 0,
    pendingOutputBytes: 0,
    messages: projection.messages.map((message) => ({
      id: message.id,
      sequence: message.sequence,
      createdAt: message.createdAt,
      streaming: message.state === "streaming",
      size: Buffer.byteLength(JSON.stringify(message)),
      blocks:
        message.state === "streaming"
          ? message.blocks.map((block) => ({
              id: block.id,
              type: block.type,
              offset: block.type === "text" || block.type === "thinking" ? block.text.length : 0,
              bytes: block.type === "text" || block.type === "thinking" ? textBytes(block.text) : 0,
            }))
          : [],
    })),
    operations: projection.operations.map((operation) => ({
      id: operation.id,
      stdout: operation.stdout?.nextOffset ?? 0,
      stderr: operation.stderr?.nextOffset ?? 0,
    })),
  };
}
export function advanceStream(state: StreamState, event: ProductEvent): void {
  if (event.type === "message.started") {
    const message = event.payload.message;
    if (state.messages.some((item) => item.id === message.id)) throw new Error("Invalid message lifecycle");
    state.messages.push({
      id: message.id,
      sequence: message.sequence,
      createdAt: message.createdAt,
      streaming: true,
      size: Buffer.byteLength(JSON.stringify(message)),
      blocks: [],
    });
    state.bytes += Buffer.byteLength(JSON.stringify(message)) + 1;
  } else if (event.type === "message.committed") {
    const message = state.messages.find((item) => item.id === event.payload.message.id);
    const size = Buffer.byteLength(JSON.stringify(event.payload.message));
    state.bytes += size - (message?.size ?? 0) + (message ? 0 : 1);
    if (message) {
      message.streaming = false;
      message.blocks = [];
      message.size = size;
    } else {
      const committed = event.payload.message;
      state.messages.push({
        id: committed.id,
        sequence: committed.sequence,
        createdAt: committed.createdAt,
        streaming: false,
        blocks: [],
        size,
      });
    }
  } else if (event.type === "block.upsert" || event.type === "text.delta" || event.type === "text.reset") {
    const message = state.messages.find((item) => item.id === event.payload.messageId);
    if (!message?.streaming) throw new Error("Missing or completed streaming message");
    if (event.type === "block.upsert") {
      const { block, index } = event.payload;
      if (index !== message.blocks.length || message.blocks.some((item) => item.id === block.id))
        throw new Error("Invalid block position");
      message.blocks.push({ id: block.id, type: block.type, offset: 0, bytes: 0 });
      state.bytes += Buffer.byteLength(JSON.stringify(block)) + 1;
      message.size += Buffer.byteLength(JSON.stringify(block)) + 1;
    } else {
      const block = message.blocks.find((item) => item.id === event.payload.blockId);
      if (!block || !["text", "thinking"].includes(block.type)) throw new Error("Missing text block");
      const bytes = textBytes(event.payload.text);
      if (event.type === "text.delta") {
        if (event.payload.offset !== block.offset) throw new Error("Text offset mismatch");
        block.offset += event.payload.text.length;
        block.bytes += bytes;
        state.bytes += bytes;
        message.size += bytes;
      } else {
        state.bytes += bytes - block.bytes;
        message.size += bytes - block.bytes;
        block.offset = event.payload.text.length;
        block.bytes = bytes;
      }
    }
  } else if (event.type === "tool.changed") {
    const operation = event.payload.operation;
    if (!state.operations.some((item) => item.id === operation.id))
      state.operations.push({
        id: operation.id,
        stdout: operation.stdout?.nextOffset ?? 0,
        stderr: operation.stderr?.nextOffset ?? 0,
      });
  } else if (event.type === "tool.output") {
    const { operationId, channel, offset, text } = event.payload;
    const operation = state.operations.find((item) => item.id === operationId);
    if (!operation || operation[channel] !== offset) throw new Error("Tool output offset mismatch");
    operation[channel] += text.length;
    state.pendingOutputBytes += textBytes(text);
  }
  if (state.bytes > 4 * 1024 * 1024) throw new DomainError("CONFLICT", "Run output exceeded its storage limit");
}
