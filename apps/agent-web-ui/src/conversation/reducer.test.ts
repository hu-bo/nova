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
});
