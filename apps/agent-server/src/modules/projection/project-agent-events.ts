import { toUiRequest } from "../decision/pending-decisions.js";
import type { AgentEvent, Block as CoreBlock, StopReason } from "@nova/agent-core";
import type { Block, UiEvent } from "@nova/protocol";
import type { EventHub } from "../runtime/event-hub.js";
import { projectToolDetails } from "./tool-blocks.js";

type ProjectedMessage = {
  id: string;
  blocks: Block[];
  status: "done" | "error" | "aborted";
  createdAt: Date;
};

export function projectAgentEvents(conversationId: string, events: EventHub) {
  const messages = new Map<string, ProjectedMessage>();
  const toolNames = new Map<string, string>();
  const toolCodeChanges = new Map<string, Array<{ path: string; oldText: string; newText: string }>>();
  let activeMessageId: string | null = null;

  const publish = (event: UiEvent) => events.publish(conversationId, event);
  const current = () => (activeMessageId ? messages.get(activeMessageId) : undefined);

  return (event: AgentEvent): void => {
    switch (event.type) {
      case "run.state":
        publish({
          ...event,
          state: {
            ...event.state,
            pendingDecision: event.state.pendingDecision ? toUiRequest(event.state.pendingDecision) : null,
          },
        });
        return;
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
        const callIndex = message.blocks.findIndex(
          (block) => block.type === "tool_call" && block.callId === event.callId,
        );
        const call = message.blocks[callIndex];
        if (call?.type === "tool_call") {
          message.blocks[callIndex] = { ...call, status: event.status };
          publish({ type: "block.end", messageId: message.id, index: callIndex, block: message.blocks[callIndex]! });
        }
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
      case "context.compacted":
        publish(event);
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
        if (event.stopReason === "aborted" || event.stopReason === "paused" || event.stopReason === "error") {
          for (const message of messages.values()) {
            if (message.id === activeMessageId) {
              message.status = event.stopReason === "error" ? "error" : "aborted";
              publish({ type: "message.end", messageId: message.id, status: message.status });
            }
            message.blocks.forEach((block, index) => {
              if (block?.type !== "tool_call" || block.status !== "running") return;
              const cancelled: Block = { ...block, status: "cancelled" };
              message.blocks[index] = cancelled;
              publish({ type: "block.end", messageId: message.id, index, block: cancelled });
            });
          }
        }
        publish({ type: "run.end", runId: event.runId, stopReason: event.stopReason });
        messages.clear();
        activeMessageId = null;
      }
    }
  };
}

function messageStatus(stopReason: StopReason): ProjectedMessage["status"] {
  if (stopReason === "aborted" || stopReason === "paused") return "aborted";
  if (stopReason === "error" || stopReason === "repetition_detected") return "error";
  return "done";
}

export function projectBlock(block: CoreBlock): Block | null {
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
