import { expect, it } from "vitest";
import type { AgentStore, MessageRow } from "../../store.js";
import { createEventHub } from "../runtime/event-hub.js";
import { projectAgentEvents } from "./project-agent-events.js";

it("publishes and persists the concrete run error on the failed assistant message", async () => {
  const saved: MessageRow[] = [];
  const store: Pick<AgentStore, "appendMessage"> = {
    async appendMessage(message) {
      const row = { ...message, seq: saved.length + 1 };
      saved.push(row);
      return row;
    },
  };
  const events = createEventHub();
  const project = projectAgentEvents("conversation-1", events, store);

  project({ type: "message.start", messageId: "message-1", role: "assistant" });
  project({ type: "message.end", messageId: "message-1", stopReason: "error" });
  project({ type: "error", code: "stream_error", message: "Provider returned 401: invalid API key" });
  project({ type: "run.end", runId: "run-1", stopReason: "error", usage: { input: 0, output: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(saved).toMatchObject([
    {
      id: "message-1",
      conversationId: "conversation-1",
      status: "error",
      blocks: [{ type: "error", code: "stream_error", message: "Provider returned 401: invalid API key" }],
    },
  ]);
  const replay = events.replay("conversation-1", "0");
  expect(replay.kind).toBe("events");
  if (replay.kind === "events") {
    expect(replay.events.map((item) => item.event)).toContainEqual({
      type: "block.end",
      messageId: "message-1",
      index: 0,
      block: { type: "error", code: "stream_error", message: "Provider returned 401: invalid API key" },
    });
  }
});
