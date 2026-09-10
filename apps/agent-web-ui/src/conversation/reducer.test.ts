import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@nova/protocol";
import { conversationReducer, initialConversationState } from "./reducer.js";

describe("conversationReducer", () => {
  it("keeps the first question before its reply when a partial history arrives after switching chats", () => {
    const question: ChatMessage = {
      id: "user-1",
      conversationId: "c1",
      role: "user",
      status: "done",
      blocks: [{ type: "text", text: "first question" }],
      // 浏览器时钟领先服务端时，也必须保持提问在回复之前。
      createdAt: 100,
    };
    const reply: ChatMessage = {
      ...question,
      id: "assistant-1",
      role: "assistant",
      status: "streaming",
      blocks: [{ type: "text", text: "live answer" }],
      createdAt: 101,
    };
    const nextQuestion: ChatMessage = { ...question, id: "user-2", createdAt: 102 };
    const state = {
      ...initialConversationState,
      connection: "open" as const,
      isRunning: true,
      messages: [question, reply, nextQuestion],
    };
    const action = {
      type: "hydrate" as const,
      preserveLiveState: true,
      messages: [{ ...reply, createdAt: 1, blocks: [] }],
    };
    const hydrated = conversationReducer(state, action);
    expect(hydrated.messages).toEqual([question, reply, nextQuestion]);
    expect(conversationReducer(hydrated, action)).toEqual(hydrated);
  });

  it("places disjoint older local messages before history while retaining newer local messages", () => {
    const message = (id: string, createdAt: number): ChatMessage => ({
      id,
      createdAt,
      conversationId: "c1",
      role: "user",
      blocks: [{ type: "text", text: id }],
      status: "done",
    });
    const hydrated = conversationReducer(
      { ...initialConversationState, messages: [message("first", 1), message("latest", 3)] },
      { type: "hydrate", preserveLiveState: true, messages: [message("history", 2)] },
    );
    expect(hydrated.messages.map((item) => item.id)).toEqual(["first", "history", "latest"]);
  });

  it("merges late history without clearing a live approval, todo plan or completed run", () => {
    const live = {
      ...initialConversationState,
      connection: "open" as const,
      isRunning: true,
      todos: [{ id: "todo-1", text: "写入文件", status: "in_progress" as const }],
      pendingDecision: {
        kind: "approval" as const,
        decisionId: "approval-1",
        toolName: "write_file",
        risk: "write" as const,
        args: { path: "large.ts" },
      },
      messages: [
        {
          id: "live-1",
          conversationId: "c1",
          role: "assistant" as const,
          status: "streaming" as const,
          blocks: [{ type: "text" as const, text: "等待授权" }],
          createdAt: 2,
        },
      ],
    };
    const loaded = conversationReducer(live, { type: "hydrate", messages: [], preserveLiveState: true });
    expect(loaded).toEqual(live);
    const ended = { ...live, isRunning: false, pendingDecision: null, queueReady: true };
    expect(conversationReducer(ended, { type: "hydrate", messages: live.messages, preserveLiveState: true })).toEqual(
      ended,
    );
    // 显式重同步仍按快照重建临时状态。
    expect(conversationReducer(live, { type: "hydrate", messages: [] }).pendingDecision).toBeNull();
  });

  it("restores history on first open even when the stream connects before history arrives", () => {
    const loaded = conversationReducer(
      { ...initialConversationState, connection: "open" },
      {
        type: "hydrate",
        preserveLiveState: true,
        messages: [
          {
            id: "old-1",
            conversationId: "c1",
            role: "assistant",
            status: "streaming",
            blocks: [{ type: "todo", items: [{ id: "todo-1", text: "继续任务", status: "in_progress" }] }],
            createdAt: 1,
          },
        ],
      },
    );
    expect(loaded.isRunning).toBe(true);
    expect(loaded.todos).toEqual([{ id: "todo-1", text: "继续任务", status: "in_progress" }]);
  });

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
      preserveLiveState: true,
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

it("authoritative paused state settles stale loading and ignores older snapshots", () => {
  const live = conversationReducer(initialConversationState, {
    type: "event",
    conversationId: "c",
    event: { type: "message.start", messageId: "m", role: "assistant" },
  });
  const run = {
    runId: "r",
    version: 10,
    status: "paused" as const,
    phase: "tools" as const,
    reason: "outcome_unknown",
  };
  const paused = conversationReducer(live, {
    type: "event",
    conversationId: "c",
    event: { type: "run.state", state: run },
  });
  expect(paused.isRunning).toBe(false);
  expect(paused.messages[0]?.status).toBe("aborted");
  expect(paused.queueReady).toBe(false);
  expect(
    conversationReducer(paused, {
      type: "event",
      conversationId: "c",
      event: { type: "run.state", state: { ...run, version: 9, status: "running" } },
    }),
  ).toEqual(paused);
  expect(conversationReducer(paused, { type: "hydrate", messages: [], runVersion: 9 })).toEqual(paused);
  expect(
    conversationReducer(paused, {
      type: "event",
      conversationId: "c",
      event: { type: "run.end", runId: "previous-run", stopReason: "done" },
    }),
  ).toEqual(paused);
});
