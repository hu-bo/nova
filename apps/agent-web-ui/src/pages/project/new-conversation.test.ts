import { describe, expect, it } from "vitest";
import { newConversationPath } from "./new-conversation.js";

describe("newConversationPath", () => {
  it("opens an unpersisted standalone conversation", () => {
    expect(newConversationPath()).toBe("/c/new");
  });

  it("keeps an unpersisted conversation inside its project", () => {
    expect(newConversationPath({ id: "project-1" })).toBe("/p/project-1/c/new");
  });
});
