import { randomUUID } from "node:crypto";
import type { ChatMessage, SendMessage } from "@nova/protocol";
import type { AgentStore, MessageRow } from "../../store.js";
import type { ConversationRuntimes } from "../runtime/runtime-registry.js";
import type { ModelConfigStore } from "../model-config/model-config.store.js";
import { resolveCatalogModel } from "../model-config/model-config.store.js";
import type { CredentialCipher } from "../model-config/credential.js";

export function createMessagesService(
  store: AgentStore,
  runtimes: ConversationRuntimes,
  models: ModelConfigStore,
  cipher: CredentialCipher,
) {
  const view = (message: MessageRow): ChatMessage => ({
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    blocks: message.blocks,
    status: message.status,
    createdAt: message.createdAt.getTime(),
  });

  return {
    async list(userId: string, conversationId: string, query: { before?: string; limit: number }) {
      const result = await store.listMessages({ userId, conversationId, ...query });
      return { items: result.items.map(view), nextCursor: result.nextCursor };
    },
    async send(userId: string, conversationId: string, input: SendMessage) {
      let route = await store.routeConversation(userId, conversationId);
      if (input.modelConfig || input.modelId) {
        const modelConfig = input.modelConfig ?? (await resolveCatalogModel(models, cipher, userId, input.modelId!));
        await store.updateConversationModel({ userId, id: conversationId, modelConfig });
        runtimes.invalidate(conversationId);
        route = await store.routeConversation(userId, conversationId);
      }
      await store.appendMessage({
        id: randomUUID(),
        conversationId,
        role: "user",
        blocks: [{ type: "text", text: input.text }],
        status: "done",
        createdAt: new Date(),
      });
      if (route.conversation.title === "New conversation") {
        await store.setConversationTitleIfUntitled({ userId, id: conversationId, title: titleFromMessage(input.text) });
      }
      await runtimes.send(route, input.text, input.queue, input.reasoningEffort);
    },
    async abort(userId: string, conversationId: string) {
      await store.routeConversation(userId, conversationId);
      await runtimes.abort(conversationId);
    },
    async context(userId: string, conversationId: string) {
      const route = await store.routeConversation(userId, conversationId);
      return runtimes.context(route);
    },
    async estimatePrompt(userId: string, conversationId: string, text: string) {
      const route = await store.routeConversation(userId, conversationId);
      return runtimes.estimatePrompt(route, text);
    },
    async compact(userId: string, conversationId: string) {
      const route = await store.routeConversation(userId, conversationId);
      const result = await runtimes.compact(route);
      return {
        compacted: result.replacedFrom !== null,
        summarized: result.summarized,
        context: await runtimes.context(route),
      };
    },
    async clear(userId: string, conversationId: string) {
      const route = await store.routeConversation(userId, conversationId);
      return {
        context: await runtimes.clear(route, () => store.clearConversationContext({ userId, id: conversationId })),
      };
    },
  };
}

function titleFromMessage(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized || "New conversation";
}
