import { expect, it } from "vitest";
import type { UiEvent } from "@nova/protocol";
import { createEventHub } from "../runtime/event-hub.js";
import { projectAgentEvents } from "./project-agent-events.js";

it("publishes the concrete error and terminal state without owning persistence", () => {
  const events = createEventHub();
  const seen: UiEvent[] = [];
  events.subscribe("conversation-1", (item) => seen.push(item.event));
  const project = projectAgentEvents("conversation-1", events);
  project({ type: "message.start", messageId: "message-1", role: "assistant" });
  project({ type: "error", code: "stream_error", message: "Provider failed" });
  project({ type: "message.end", messageId: "message-1", stopReason: "repetition_detected" });
  project({ type: "run.end", runId: "run-1", stopReason: "error", usage: { input: 0, output: 0 } });
  expect(seen).toContainEqual({ type: "error", code: "stream_error", message: "Provider failed" });
  expect(seen).toContainEqual({ type: "message.end", messageId: "message-1", status: "error" });
});

it("turns in-flight tool cards into cancelled terminal states when a run is aborted", async () => {
  const events = createEventHub();
  const seen: UiEvent[] = [];
  events.subscribe("conversation-1", (item) => seen.push(item.event));
  const project = projectAgentEvents("conversation-1", events);

  project({ type: "message.start", messageId: "message-1", role: "assistant" });
  project({
    type: "block.end",
    messageId: "message-1",
    index: 0,
    block: { type: "tool_call", callId: "call-1", name: "list_dir", args: { path: "/workspace" } },
  });
  project({ type: "message.end", messageId: "message-1", stopReason: "done" });
  project({ type: "run.end", runId: "run-1", stopReason: "aborted", usage: { input: 0, output: 0 } });

  const replay = { kind: "events", events: seen.map((event) => ({ event })) };
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
  const seen: UiEvent[] = [];
  events.subscribe("conversation-1", (item) => seen.push(item.event));
  const project = projectAgentEvents("conversation-1", events);

  const usage = {
    estimatedInputTokens: 32_500,
    lastMeasuredInputTokens: 32_000,
    contextWindow: 128_000,
    maxInputTokens: 109_056,
    confidence: "high" as const,
  };
  project({ type: "context.updated", usage });

  const replay = { kind: "events", events: seen.map((event) => ({ event })) };
  expect(replay.kind).toBe("events");
  if (replay.kind === "events") {
    expect(replay.events.map((item) => item.event)).toEqual([{ type: "context.updated", ...usage }]);
  }
});

it("projects context compaction so the page can explain a usage drop", () => {
  const events = createEventHub();
  const seen: UiEvent[] = [];
  events.subscribe("conversation-1", (item) => seen.push(item.event));
  const project = projectAgentEvents("conversation-1", events);

  project({ type: "context.compacted", trigger: "threshold", summarized: true });

  const replay = { kind: "events", events: seen.map((event) => ({ event })) };
  expect(replay).toMatchObject({
    kind: "events",
    events: [expect.objectContaining({ event: { type: "context.compacted", trigger: "threshold", summarized: true } })],
  });
});

it("keeps approved file changes as diff blocks after the tool completes", async () => {
  const events = createEventHub();
  const seen: UiEvent[] = [];
  events.subscribe("conversation-1", (item) => seen.push(item.event));
  const project = projectAgentEvents("conversation-1", events);

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

  expect(seen.flatMap((event) => (event.type === "block.end" ? [event.block] : []))).toEqual([
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
