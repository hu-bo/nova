import { createScope, defineService } from "../../shared/scope.js";
import { createRunnerReader } from "../runners/index.js";
import { createRemoteService } from "../remotes/index.js";
import { ProjectBindingService } from "./project-binding.service.js";
import { createProjectBindingRepository } from "./project-binding.repository.js";
import type { FastifyInstance } from "fastify";
import { createProjectRepository } from "./project.repository.js";
import { projectRoutes } from "./project.routes.js";
import { ProjectService } from "./project.service.js";
export async function projectsModule(app: FastifyInstance): Promise<void> {
  const service = createScope(app.db).get(
    defineService({ repository: createProjectRepository(app.db) }, ({ repository }) => new ProjectService(repository)),
  );
  await app.register(async (scope) => projectRoutes(scope, service, createProjectBindingService(app)), {
    prefix: "/projects",
  });
}

export function createProjectBindingService(app: FastifyInstance) {
  return createScope(app.db).get(
    defineService(
      {
        repository: createProjectBindingRepository(app.db),
        runners: createRunnerReader(app.db),
        remotes: createRemoteService(app),
      },
      ({ repository, transaction }) => new ProjectBindingService(repository, transaction),
    ),
  );
}
export { bindingSchema } from "./project-binding.schema.js";
export type { ProjectBindingService } from "./project-binding.service.js";
