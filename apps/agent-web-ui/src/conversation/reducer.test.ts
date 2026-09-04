import { describe, expect, it } from "vitest";
import { conversationReducer, initialConversationState } from "./reducer.js";

describe("conversationReducer", () => {
  it("overwrites completed blocks and replaces the current todo plan", () => {
    const started = conversationReducer(initialConversationState, {
      type: "event",
      conversationId: "conversation-1",
      event: { type: "message.start", messageId: "message-1", role: "assistant" },
    });
    const skeleton = conversationReducer(started, {
      type: "event",
      conversationId: "conversation-1",
      event: { type: "block.start", messageId: "message-1", index: 0, block: { type: "text", text: "部分" } },
    });
    const completed = conversationReducer(skeleton, {
      type: "event",
      conversationId: "conversation-1",
      event: { type: "block.end", messageId: "message-1", index: 0, block: { type: "text", text: "完整答案" } },
    });
    const withTodos = conversationReducer(completed, {
      type: "event",
      conversationId: "conversation-1",
      event: { type: "todo.updated", items: [{ id: "todo-1", text: "实现页面", status: "in_progress" }] },
    });
    expect(withTodos.messages[0]?.blocks).toEqual([{ type: "text", text: "完整答案" }]);
    expect(withTodos.todos).toEqual([{ id: "todo-1", text: "实现页面", status: "in_progress" }]);
  });

  it("keeps the concrete send failure for the user", () => {
    const state = conversationReducer(
      {
        ...initialConversationState,
        messages: [
          {
            id: "message-1",
            conversationId: "conversation-1",
            role: "user",
            blocks: [{ type: "text", text: "hello" }],
            status: "done",
            createdAt: 1,
          },
        ],
        isRunning: true,
      },
      {
        type: "optimistic.fail",
        messageId: "message-1",
        keepRunning: false,
        message: "Runner 不可用（请求 ID：request-1）",
      },
    );

    expect(state.error).toBe("Runner 不可用（请求 ID：request-1）");
    expect(state.messages[0]?.status).toBe("error");
  });

  it("keeps next-run messages above the composer until they are steered or the run ends", () => {
    const queuedMessage = {
      id: "message-2",
      conversationId: "conversation-1",
      role: "user" as const,
      blocks: [{ type: "text" as const, text: "change the layout" }],
      status: "done" as const,
      createdAt: 2,
    };
    const running = { ...initialConversationState, isRunning: true };
    const queuedItem = { message: queuedMessage, request: { text: "change the layout" } };
    const queued = conversationReducer(running, { type: "optimistic.queue", queued: queuedItem });
    expect(queued.messages).toEqual([]);
    expect(queued.queuedMessages).toEqual([queuedItem]);

    const steered = conversationReducer(queued, { type: "queue.start", messageId: queuedMessage.id });
    expect(steered.messages).toEqual([queuedMessage]);
    expect(steered.queuedMessages).toEqual([]);

    const queuedAgain = conversationReducer(running, { type: "optimistic.queue", queued: queuedItem });
    const completed = conversationReducer(queuedAgain, {
      type: "event",
      conversationId: "conversation-1",
      event: { type: "run.end", runId: "run-1", stopReason: "done" },
    });
    expect(completed.messages).toEqual([]);
    expect(completed.queuedMessages).toEqual([queuedItem]);
    expect(completed.isRunning).toBe(false);
    expect(completed.queueReady).toBe(true);
  });

  it("replaces context usage with the latest estimated SSE value", () => {
    const usage = {
      estimatedInputTokens: 64_500,
      lastMeasuredInputTokens: 64_000,
      contextWindow: 128_000,
      maxInputTokens: 109_056,
      confidence: "high" as const,
    };
    const measured = conversationReducer(initialConversationState, {
      type: "event",
      conversationId: "conversation-1",
      event: { type: "context.updated", ...usage },
    });
    expect(measured.contextUsage).toEqual(usage);

    const compacted = conversationReducer(measured, {
      type: "context.set",
      usage: { ...usage, estimatedInputTokens: 12_000 },
    });
    expect(compacted.contextUsage).toEqual({ ...usage, estimatedInputTokens: 12_000 });
  });

  it("keeps compaction reason visible until the user dismisses it", () => {
    const compacted = conversationReducer(initialConversationState, {
      type: "event",
      conversationId: "conversation-1",
      event: { type: "context.compacted", trigger: "overflow", summarized: false },
    });
    expect(compacted.contextCompaction).toEqual({
      type: "context.compacted",
      trigger: "overflow",
      summarized: false,
    });

    expect(conversationReducer(compacted, { type: "clear-context-compaction" }).contextCompaction).toBeNull();
  });

  it("keeps an in-memory streaming message when a returning route hydrates persisted history", () => {
    const streaming = conversationReducer(initialConversationState, {
      type: "event",
      conversationId: "conversation-1",
      event: { type: "message.start", messageId: "assistant-1", role: "assistant" },
    });
    const withDelta = conversationReducer(streaming, {
      type: "event",
      conversationId: "conversation-1",
      event: { type: "block.start", messageId: "assistant-1", index: 0, block: { type: "text", text: "仍在生成" } },
    });
    const hydrated = conversationReducer(withDelta, {
      type: "hydrate",
      messages: [
        {
          id: "user-1",
          conversationId: "conversation-1",
          role: "user",
          blocks: [{ type: "text", text: "hello" }],
          status: "done",
          createdAt: 1,
        },
      ],
    });

    expect(hydrated.messages.map((message) => message.id)).toEqual(["user-1", "assistant-1"]);
    expect(hydrated.messages[1]?.status).toBe("streaming");
    expect(hydrated.messages[1]?.blocks).toEqual([{ type: "text", text: "仍在生成" }]);
  });
});
