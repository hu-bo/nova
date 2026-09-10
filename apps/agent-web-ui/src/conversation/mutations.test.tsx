import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../api/query-keys.js";
import { useConversationMutations } from "./mutations.js";
import { conversationStore } from "./store.js";

const api = vi.hoisted(() => ({ createConversation: vi.fn(), sendMessage: vi.fn() }));
vi.mock("../auth/provider.js", () => ({ useAuth: () => ({ api }) }));
vi.mock("../pages/settings/model/provider.js", () => ({
  useModelSettings: () => ({
    modelSelection: () => ({ modelId: "model-1" }),
    profiles: [{ id: "profile-1", supportsImages: false }],
  }),
}));

afterEach(() => {
  conversationStore.discard("conversation-1");
  vi.clearAllMocks();
});

describe("first question sidebar title", () => {
  it.each([undefined, "project-1"])("refreshes the visible lists after sending in project %s", async (projectId) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const created = { id: "conversation-1", projectId: projectId ?? null, title: "New conversation" };
    let title = created.title;
    api.createConversation.mockResolvedValue(created);
    api.sendMessage.mockImplementation(async () => {
      title = "first question";
    });
    // QueryObserver represents the mounted sidebar (and the project's list).
    const keys = [queryKeys.conversations()];
    if (projectId) keys.push(queryKeys.conversations(projectId));
    const unsubscribe = keys.map((queryKey) => {
      client.setQueryData(queryKey, { items: [], nextCursor: null });
      return new QueryObserver(client, {
        queryKey,
        staleTime: Infinity,
        queryFn: async () => ({ items: [{ ...created, title }], nextCursor: null }),
      }).subscribe(() => undefined);
    });
    let mutations!: ReturnType<typeof useConversationMutations>;
    const onCreated = vi.fn();
    const ensureStreamConnected = vi.fn().mockResolvedValue(undefined);
    function Harness() {
      mutations = useConversationMutations({
        stateId: "draft-1",
        modelProfileId: "profile-1",
        ensureStreamConnected,
        releaseStream: vi.fn(),
        draft: { ...(projectId ? { projectId } : {}), onPersisted: vi.fn(), onCreated },
      });
      return null;
    }
    try {
      renderToString(createElement(QueryClientProvider, { client }, createElement(Harness)));
      await mutations.send({ text: "first question", files: [], attachments: [] });
      expect(onCreated).toHaveBeenCalledWith(created);
      expect(ensureStreamConnected).toHaveBeenCalledWith(created.id);
      expect(api.createConversation).toHaveBeenCalledWith({
        ...(projectId ? { projectId } : {}),
        modelId: "model-1",
      });
      await vi.waitFor(() => {
        for (const key of keys)
          expect(client.getQueryData(key)).toEqual({
            items: [{ ...created, title: "first question" }],
            nextCursor: null,
          });
      });
      const question = conversationStore.state(created.id).messages[0]!;
      expect(api.sendMessage).toHaveBeenCalledWith(created.id, expect.objectContaining({ requestId: question.id }));
    } finally {
      unsubscribe.forEach((stop) => stop());
      client.clear();
    }
  });
});
