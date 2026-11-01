import { createScope, defineService } from "../../shared/scope.js";
import { createConversationReader } from "../conversations/index.js";
import type { FastifyInstance } from "fastify";
import { attachmentRoutes } from "./attachment.routes.js";
import { AttachmentService } from "./attachment.service.js";

export async function attachmentsModule(app: FastifyInstance): Promise<void> {
  const service = createScope(app.db).get(
    defineService(
      { conversations: createConversationReader(app.db) },
      ({ conversations }) => new AttachmentService(conversations),
    ),
  );
  // 实际路径 /api/attachments/...; 由 app.ts 在 /api 前缀下挂载.
  await app.register(async (scope) => attachmentRoutes(scope, service), { prefix: "/attachments" });
}
