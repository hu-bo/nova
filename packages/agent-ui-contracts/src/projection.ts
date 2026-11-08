import type { Message } from "./messages.js";
import type { ProductEvent } from "./events.js";
import type { Snapshot } from "./conversation.js";
import type { OutputTail, ToolOperation } from "./runtime.js";
export function operationsFromMessages(messages: Message[], known: ToolOperation[] = []): ToolOperation[] {
  const operations = new Map(known.map((operation) => [operation.id, operation]));
  for (const message of messages)
    for (const block of message.blocks)
      if (block.type === "tool_result" && !operations.has(block.operationId))
        operations.set(block.operationId, { id: block.operationId, callId: block.callId, state: block.outcome });
  return [...operations.values()];
}
export class ProjectionError extends Error {}
const requireState = (valid: unknown, message: string): void => {
  if (!valid) throw new ProjectionError(message);
};
export const sortMessages = (messages: Message[]): Message[] =>
  [...messages].sort((a, b) =>
    BigInt(a.sequence) < BigInt(b.sequence)
      ? -1
      : BigInt(a.sequence) > BigInt(b.sequence)
        ? 1
        : a.id.localeCompare(b.id),
  );
const upsert = <T extends { id: string }>(items: T[], item: T): T[] =>
  items.some((prior) => prior.id === item.id)
    ? items.map((prior) => (prior.id === item.id ? item : prior))
    : [...items, item];
export function outputTail(text: string, nextOffset: number, maxBytes = 262144): OutputTail {
  const bytes = new TextEncoder().encode(text);
  let tail = text;
  if (bytes.length > maxBytes) {
    let start = Math.max(0, bytes.length - maxBytes);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    tail = new TextDecoder().decode(bytes.subarray(start));
  }
  return { text: tail, startOffset: nextOffset - tail.length, nextOffset };
}
export function mergeSnapshot(snapshot: Snapshot, previous?: Snapshot): Snapshot {
  if (!previous) return structuredClone(snapshot);
  const current = new Map(snapshot.messages.map((message) => [message.id, message]));
  for (const message of previous.messages)
    if (message.state !== "streaming" && !current.has(message.id)) current.set(message.id, message);
  return { ...structuredClone(snapshot), messages: sortMessages([...current.values()]) };
}
/** The same ordered journal drives persisted and browser projections. */
export function applyEvent(state: Snapshot, event: ProductEvent): Snapshot {
  if (BigInt(event.sequence) <= BigInt(state.cursor)) return state;
  requireState(BigInt(event.sequence) === BigInt(state.cursor) + 1n, "Event sequence gap");
  let next: Snapshot = { ...state, cursor: event.sequence };
  switch (event.type) {
    case "message.started":
    case "message.committed": {
      const message = event.payload.message;
      const previous = state.messages.find((item) => item.id === message.id);
      requireState(
        event.type === "message.started" ? message.state === "streaming" && !previous : message.state !== "streaming",
        "Invalid message lifecycle",
      );
      if (previous)
        requireState(
          previous.state === "streaming" &&
            previous.sequence === message.sequence &&
            previous.runId === message.runId &&
            previous.role === message.role,
          "Completed message is immutable",
        );
      next.messages = sortMessages(upsert(state.messages, message));
      break;
    }
    case "block.upsert":
    case "text.delta":
    case "text.reset": {
      const message = state.messages.find((item) => item.id === event.payload.messageId);
      requireState(message?.state === "streaming", "Missing or completed message");
      if (!message) break;
      const blocks = [...message.blocks];
      if (event.type === "block.upsert") {
        const { block, index } = event.payload;
        const existing = blocks.findIndex((item) => item.id === block.id);
        requireState(index <= blocks.length && (existing < 0 || existing === index), "Invalid block position");
        if (existing < 0) blocks.splice(index, 0, block);
        else blocks[index] = block;
      } else {
        const index = blocks.findIndex((block) => block.id === event.payload.blockId);
        const block = blocks[index];
        requireState(block && (block.type === "text" || block.type === "thinking"), "Missing text block");
        if (!block || (block.type !== "text" && block.type !== "thinking")) break;
        if (event.type === "text.delta")
          requireState(event.payload.offset === block.text.length, "Text offset mismatch");
        blocks[index] = {
          ...block,
          text: event.type === "text.reset" ? event.payload.text : block.text + event.payload.text,
        };
      }
      next.messages = upsert(state.messages, { ...message, blocks });
      break;
    }
    case "tool.changed":
      next.operations = upsert(state.operations, {
        ...state.operations.find((item) => item.id === event.payload.operation.id),
        ...event.payload.operation,
      });
      break;
    case "tool.output": {
      const { operationId, channel, offset, text } = event.payload;
      const operation = state.operations.find((item) => item.id === operationId);
      requireState(operation && (operation[channel]?.nextOffset ?? 0) === offset, "Tool output offset mismatch");
      if (!operation) break;
      next.operations = upsert(state.operations, {
        ...operation,
        [channel]: outputTail((operation[channel]?.text ?? "") + text, offset + text.length),
      });
      let excess =
        next.operations.reduce(
          (sum, item) => sum + new TextEncoder().encode((item.stdout?.text ?? "") + (item.stderr?.text ?? "")).length,
          0,
        ) - 1048576;
      next.operations = next.operations.map((item) => {
        const updated = { ...item };
        for (const ch of ["stdout", "stderr"] as const)
          if (excess > 0 && updated[ch]) {
            const tail = updated[ch]!;
            const size = new TextEncoder().encode(tail.text).length;
            const bounded = outputTail(tail.text, tail.nextOffset, Math.max(0, size - excess));
            excess -= size - new TextEncoder().encode(bounded.text).length;
            updated[ch] = bounded;
          }
        return updated;
      });
      break;
    }
    case "run.changed":
      if (state.run?.id !== event.payload.run.id) {
        next.operations = [];
        next.interactions = [];
        delete next.usage;
      }
      next.run = event.payload.run;
      if (event.payload.configuration)
        next.conversation = { ...next.conversation, configuration: event.payload.configuration };
      if (event.payload.capabilities) next.capabilities = event.payload.capabilities;
      break;
    case "interaction.changed":
      next.interactions = upsert(state.interactions, event.payload.interaction);
      break;
    case "input.queued":
      next.pendingInputs = upsert(state.pendingInputs, event.payload.input);
      break;
    case "input.consumed":
    case "input.removed":
    case "input.rejected":
      next.pendingInputs = state.pendingInputs.filter((input) => input.id !== event.payload.input.id);
      break;
    case "context.changed":
      next = {
        ...next,
        conversation: { ...state.conversation, epoch: event.payload.epoch },
        plan: [],
        operations: [],
        interactions: [],
      };
      delete next.usage;
      break;
    case "plan.changed":
      next.plan = event.payload.plan;
      break;
    case "goal.changed":
      next.goal = event.payload.goal;
      break;
    case "spec.changed":
      break;
    case "usage.changed":
      next.usage = event.payload.usage;
      break;
  }
  return next;
}
