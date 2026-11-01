import { createScope, defineService } from "../../shared/scope.js";
import type { FastifyInstance } from "fastify";
import { createModelConfigRepository } from "./model-config.repository.js";
import { modelConfigRoutes } from "./model-config.routes.js";
import { ModelConfigService } from "./model-config.service.js";
import { requireRole } from "../../shared/authorization.js";
export {
  availableModelSchema,
  createUserModelProfilesService,
  userModelProfilesModule,
  UserModelProfilesService,
} from "./user-model-profiles.js";
export type ModelConfigAdminOptions = { encryptionKey?: string };
export async function modelConfigAdminModule(app: FastifyInstance, options: ModelConfigAdminOptions) {
  const service = createScope(app.db).get(
    defineService(
      { repository: createModelConfigRepository(app.db) },
      ({ repository, transaction }) => new ModelConfigService(repository, options.encryptionKey, transaction),
    ),
  );
  await app.register(async (scope) => {
    scope.addHook("preHandler", async (request) => {
      requireRole(request, "admin");
    });
    scope.addHook("onSend", async (_request, reply, payload) => {
      reply.header("cache-control", "no-store");
      return payload;
    });
    await scope.register(async (routes) => modelConfigRoutes(routes, service), { prefix: "/model-config" });
  });
}

export type { ModelRow, ProviderRow } from "./model-config.repository.js";
