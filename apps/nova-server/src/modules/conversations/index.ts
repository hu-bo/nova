import { createScope, defineService } from "../../shared/scope.js";
import type { FastifyInstance } from "fastify";
import { createProjectBindingService } from "../projects/index.js";
import { ConversationService } from "./conversation.service.js";
import { createConversationRepository } from "./conversation.repository.js";
import { conversationRoutes } from "./conversation.routes.js";
import { createRemoteService } from "../remotes/index.js";
import { createUserModelProfilesService } from "../model-config/index.js";

export async function conversationsModule(app: FastifyInstance): Promise<void> {
  const conversationRepo = createConversationRepository(app.db);
  const remotes = createRemoteService(app);
  const service = createScope(app.db).get(
    defineService(
      {
        repository: conversationRepo,
        bindings: createProjectBindingService(app),
        models: createUserModelProfilesService(app),
        remotes,
      },
      ({ repository, transaction }) => new ConversationService(repository, transaction, app.executionEnabled),
    ),
  );
  // 实际路径 /api/conversations/...; 由 app.ts 在 /api 前缀下挂载.
  await app.register(async (scope) => conversationRoutes(scope, service), { prefix: "/conversations" });
}

export {
  createConversationReader,
  createConversationEventHeads,
  type ConversationReader,
  type ConversationEventHeads,
  type MessageReference,
} from "./conversation-reader.repository.js";
