import { describe, expect, it, vi } from "vitest";
import { draftConversationStateId, newConversationPath } from "./new-conversation.js";

describe("newConversationPath", () => {
  it("opens an unpersisted standalone conversation", () => {
    expect(newConversationPath()).toBe("/c/new");
  });

  it("keeps an unpersisted conversation inside its project", () => {
    expect(newConversationPath({ id: "project-1" })).toBe("/p/project-1/c/new");
  });

  it("does not carry the first question into another new project conversation", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    const { conversationStore } = await import("../../conversation/store.js");
    const previousDraft = draftConversationStateId("project-1", "navigation-1");
    const nextDraft = draftConversationStateId("project-1", "navigation-2");
    conversationStore.dispatch(previousDraft, {
      type: "optimistic.add",
      message: {
        id: "message-1",
        conversationId: previousDraft,
        role: "user",
        blocks: [{ type: "text", text: "first question" }],
        status: "done",
        createdAt: 1,
      },
    });

    expect(conversationStore.state(previousDraft).messages).toHaveLength(1);
    expect(conversationStore.state(nextDraft).messages).toEqual([]);

    conversationStore.discard(previousDraft);
  });
});
