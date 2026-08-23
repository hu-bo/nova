import type { Conversation, CreateConversation } from "@nova/protocol";
import type { AgentStore, ConversationRow } from "../../store.js";
import type { RunnerRegistry } from "../runner/registry.js";
import type { ConversationRuntimes } from "../runtime/runtime-registry.js";
import type { ModelConfigStore } from "../model-config/model-config.store.js";
import { resolveCatalogModel } from "../model-config/model-config.store.js";
import type { CredentialCipher } from "../model-config/credential.js";

export function createConversationService(store: AgentStore, runners: RunnerRegistry, runtimes: ConversationRuntimes, models: ModelConfigStore, cipher: CredentialCipher) {
  const view = (conversation: ConversationRow): Conversation => ({
    id: conversation.id,
    projectId: conversation.projectId,
    runnerId: conversation.runnerId,
    title: conversation.title,
    createdAt: conversation.createdAt.getTime(),
    updatedAt: conversation.updatedAt.getTime(),
  });

  return {
    async create(userId: string, input: CreateConversation) {
      const modelConfig = input.modelConfig ?? await resolveCatalogModel(models, cipher, userId, input.modelId!);
      const conversation = await store.createConversation({
        userId,
        projectId: input.projectId ?? null,
        runnerId: input.runnerId,
        title: input.title ?? "New conversation",
        modelConfig,
      });
      return view(conversation);
    },
    async list(userId: string, input: { projectId?: string; limit: number; cursor?: string }) {
      const result = await store.listConversations({ userId, ...input });
      return { items: result.items.map(view), nextCursor: result.nextCursor };
    },
    async changeRunner(userId: string, id: string, runnerId: string) {
      const route = await store.routeConversation(userId, id);
      if (route.project?.workspace) await runners.verifyWorkspace(userId, runnerId, route.project.workspace);
      const updated = await store.updateConversationRunner({ userId, id, runnerId });
      runtimes.invalidate(id);
      return view(updated);
    },
  };
}
