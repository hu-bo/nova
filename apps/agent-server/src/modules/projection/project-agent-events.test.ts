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

it("marks a repetition-stopped response as an error instead of a completed message", async () => {
  const saved: MessageRow[] = [];
  const store: Pick<AgentStore, "appendMessage"> = {
    async appendMessage(message) {
      const row = { ...message, seq: saved.length + 1 };
      saved.push(row);
      return row;
    },
  };
  const project = projectAgentEvents("conversation-1", createEventHub(), store);

  project({ type: "message.start", messageId: "message-1", role: "assistant" });
  project({ type: "message.end", messageId: "message-1", stopReason: "repetition_detected" });
  project({ type: "run.end", runId: "run-1", stopReason: "repetition_detected", usage: { input: 0, output: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(saved[0]!.status).toBe("error");
});

it("turns in-flight tool cards into cancelled terminal states when a run is aborted", async () => {
  const events = createEventHub();
  const project = projectAgentEvents("conversation-1", events, {
    async appendMessage(message) {
      return { ...message, seq: 1 };
    },
  });

  project({ type: "message.start", messageId: "message-1", role: "assistant" });
  project({
    type: "block.end",
    messageId: "message-1",
    index: 0,
    block: { type: "tool_call", callId: "call-1", name: "list_dir", args: { path: "/workspace" } },
  });
  project({ type: "message.end", messageId: "message-1", stopReason: "done" });
  project({ type: "run.end", runId: "run-1", stopReason: "aborted", usage: { input: 0, output: 0 } });

  const replay = events.replay("conversation-1", "0");
  expect(replay).toMatchObject({
    kind: "events",
    events: expect.arrayContaining([
      expect.objectContaining({ event: { type: "message.end", messageId: "message-1", status: "aborted" } }),
      expect.objectContaining({
        event: {
          type: "block.end",
          messageId: "message-1",
          index: 0,
          block: {
            type: "tool_call",
            callId: "call-1",
            name: "list_dir",
            args: { path: "/workspace" },
            status: "cancelled",
          },
        },
      }),
    ]),
  });
});

it("projects estimated context usage without writing a chat message", () => {
  const events = createEventHub();
  const project = projectAgentEvents("conversation-1", events, {
    async appendMessage(message) {
      return { ...message, seq: 1 };
    },
  });

  const usage = {
    estimatedInputTokens: 32_500,
    lastMeasuredInputTokens: 32_000,
    contextWindow: 128_000,
    maxInputTokens: 109_056,
    confidence: "high" as const,
  };
  project({ type: "context.updated", usage });

  const replay = events.replay("conversation-1", "0");
  expect(replay.kind).toBe("events");
  if (replay.kind === "events") {
    expect(replay.events.map((item) => item.event)).toEqual([{ type: "context.updated", ...usage }]);
  }
});

it("keeps approved file changes as diff blocks after the tool completes", async () => {
  const saved: MessageRow[] = [];
  const project = projectAgentEvents("conversation-1", createEventHub(), {
    async appendMessage(message) {
      const row = { ...message, seq: 1 };
      saved.push(row);
      return row;
    },
  });

  project({ type: "message.start", messageId: "message-1", role: "assistant" });
  project({
    type: "decision.requested",
    request: {
      kind: "approval",
      decisionId: "decision-1",
      callId: "call-1",
      toolName: "write_file",
      args: { path: "src/a.ts", content: "const next = true" },
      risk: "write",
      codeChanges: [{ path: "src/a.ts", oldText: "const current = false", newText: "const next = true" }],
    },
  });
  project({ type: "tool.start", callId: "call-1", name: "write_file", args: {} });
  project({ type: "tool.end", callId: "call-1", status: "ok", details: { path: "src/a.ts", bytes: 16 } });
  project({ type: "run.end", runId: "run-1", stopReason: "done", usage: { input: 0, output: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(saved[0]?.blocks).toEqual([
    {
      type: "tool_result",
      callId: "call-1",
      status: "ok",
      blocks: [
        expect.objectContaining({
          type: "diff",
          path: "src/a.ts",
          diff: expect.stringContaining("-const current = false"),
        }),
      ],
    },
  ]);
});
