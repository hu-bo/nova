import type { Database } from "../../../database/index.js";
import type { ConversationReader, ConversationEventHeads } from "../conversations/index.js";
import { createScope, defineService } from "../../shared/scope.js";
import { createEventWriter, eventWriter } from "./event-writer.repository.js";
import type { FastifyInstance } from "fastify";
import { createEventRepository } from "./event.repository.js";
import { EventService, EventRetentionService } from "./event.service.js";
import { eventRoutes } from "./event.routes.js";

export async function eventsModule(
  app: FastifyInstance,
  options: { conversations: ConversationReader },
): Promise<void> {
  const service = createEventService(app.db, options.conversations);
  // 实际路径 /api/conversations/:id/events; 由 app.ts 在 /api 前缀下挂载.
  await app.register(async (scope) => eventRoutes(scope, service), { prefix: "" });
}

export function createUiEventWriter(db: Database) {
  return createEventWriter(db);
}
export type { UiEventWriter } from "./event-writer.repository.js";

export function createEventRetentionService(db: Database, heads: ConversationEventHeads) {
  return createScope(db).get(
    defineService(
      { writer: createEventWriter(db), heads },
      ({ transaction }) => new EventRetentionService(transaction),
    ),
  );
}
export type { EventRetentionService } from "./event.service.js";

export { eventWriter } from "./event-writer.repository.js";
export function createEventService(db: Database, conversations: Pick<ConversationReader, "readOwnedHead">) {
  return createScope(db).get(
    defineService(
      { repository: createEventRepository(db), conversations },
      ({ repository, transaction }) => new EventService(repository, transaction),
    ),
  );
}
