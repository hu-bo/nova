import type { AgentEvent, Block as CoreBlock, StopReason } from "@nova/agent-core";
import type { Block, UiEvent } from "@nova/protocol";
import type { AgentStore } from "../../store.js";
import type { EventHub } from "../runtime/event-hub.js";
import { createLogger } from "@nova/logger";
import { projectToolDetails } from "./tool-blocks.js";

const logger = createLogger("agent-server").child("projection");

type ProjectedMessage = {
  id: string;
  blocks: Block[];
  status: "done" | "error" | "aborted";
  createdAt: Date;
};

export function projectAgentEvents(conversationId: string, events: EventHub, store: Pick<AgentStore, "appendMessage">) {
  const messages = new Map<string, ProjectedMessage>();
  const toolNames = new Map<string, string>();
  const toolCodeChanges = new Map<string, Array<{ path: string; oldText: string; newText: string }>>();
  let activeMessageId: string | null = null;
  let writes = Promise.resolve();

  const publish = (event: UiEvent) => events.publish(conversationId, event);
  const current = () => (activeMessageId ? messages.get(activeMessageId) : undefined);

  return (event: AgentEvent): void => {
    switch (event.type) {
      case "message.start":
        activeMessageId = event.messageId;
        messages.set(event.messageId, { id: event.messageId, blocks: [], status: "done", createdAt: new Date() });
        publish(event);
        return;
      case "block.start": {
        const message = messages.get(event.messageId);
        if (
          !message ||
          event.blockType === "tool_call" ||
          event.blockType === "tool_result" ||
          event.blockType === "image"
        )
          return;
        const block: Block =
          event.blockType === "thinking" ? { type: "thinking", text: "" } : { type: "text", text: "" };
        message.blocks[event.index] = block;
        publish({ type: "block.start", messageId: event.messageId, index: event.index, block });
        return;
      }
      case "block.delta":
        publish(event);
        return;
      case "block.end": {
        const message = messages.get(event.messageId);
        const block = projectBlock(event.block);
        if (!message || !block) return;
        message.blocks[event.index] = block;
        publish({ type: "block.end", messageId: event.messageId, index: event.index, block });
        return;
      }
      case "message.end": {
        const message = messages.get(event.messageId);
        if (message) message.status = messageStatus(event.stopReason);
        publish({ type: "message.end", messageId: event.messageId, status: messageStatus(event.stopReason) });
        return;
      }
      case "tool.start":
        toolNames.set(event.callId, event.name);
        return;
      case "tool.end": {
        const message = current();
        if (!message) return;
        const name = toolNames.get(event.callId) ?? "tool";
        const index = message.blocks.length;
        const block: Block = {
          type: "tool_result",
          callId: event.callId,
          status: event.status,
        blocks: projectToolDetails(name, event.details, toolCodeChanges.get(event.callId)),
      };
        toolCodeChanges.delete(event.callId);
        message.blocks[index] = block;
        publish({ type: "block.end", messageId: message.id, index, block });
        return;
      }
      case "todo.updated":
        publish(event);
        return;
      case "context.updated":
        publish({ type: "context.updated", ...event.usage });
        return;
      case "decision.requested":
        if (event.request.kind === "approval" && event.request.codeChanges && "callId" in event.request) {
          toolCodeChanges.set(event.request.callId, event.request.codeChanges);
        }
        return;
      case "decision.resolved":
        return;
      case "error": {
        const message = current();
        if (message) {
          const index = message.blocks.length;
          const block: Block = { type: "error", code: event.code, message: event.message };
          message.blocks[index] = block;
          publish({ type: "block.end", messageId: message.id, index, block });
        }
        publish(event);
        return;
      }
      case "run.end": {
        if (event.stopReason === "aborted") {
          for (const message of messages.values()) {
            message.status = "aborted";
            publish({ type: "message.end", messageId: message.id, status: "aborted" });
            message.blocks.forEach((block, index) => {
              if (block?.type !== "tool_call" || block.status !== "running") return;
              const cancelled: Block = { ...block, status: "cancelled" };
              message.blocks[index] = cancelled;
              publish({ type: "block.end", messageId: message.id, index, block: cancelled });
            });
          }
        }
        publish({ type: "run.end", runId: event.runId, stopReason: event.stopReason });
        const completed = [...messages.values()];
        messages.clear();
        activeMessageId = null;
        writes = writes
          .then(async () => {
            for (const message of completed) {
              await store.appendMessage({
                id: message.id,
                conversationId,
                role: "assistant",
                blocks: message.blocks.filter(Boolean),
                status: message.status,
                createdAt: message.createdAt,
              });
            }
          })
          .catch((error) => {
            logger.error(
              { err: error, component: "server", conversationId },
              "failed to persist projected agent messages",
            );
            publish({
              type: "error",
              code: "PERSISTENCE_FAILED",
              message: error instanceof Error ? error.message : "Failed to save assistant message",
            });
          });
      }
    }
  };
}

function messageStatus(stopReason: StopReason): ProjectedMessage["status"] {
  if (stopReason === "aborted") return "aborted";
  if (stopReason === "error" || stopReason === "repetition_detected") return "error";
  return "done";
}

function projectBlock(block: CoreBlock): Block | null {
  switch (block.type) {
    case "text":
      return block;
    case "thinking":
      return { type: "thinking", text: block.text };
    case "tool_call":
      return { type: "tool_call", callId: block.callId, name: block.name, args: block.args, status: "running" };
    case "tool_result":
      return {
        type: "tool_result",
        callId: block.callId,
        status: block.status,
        blocks: block.content.flatMap((part) =>
          part.type === "text" ? [{ type: "text", text: part.text } satisfies Block] : [],
        ),
      };
    case "image":
      return null;
  }
}
