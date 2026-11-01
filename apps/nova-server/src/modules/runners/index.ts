import type { Database } from "../../../database/index.js";
import type { RunnerReader } from "./runner.repository.js";
import { createScope, defineService, type Scoped } from "../../shared/scope.js";
import { createRunnerRepository } from "./runner.repository.js";
import { createRunnerTokenRepository } from "./runner-token.repository.js";
import type { FastifyInstance } from "fastify";
import { runnerRoutes } from "./runner.routes.js";
import { RunnerService } from "./runner.service.js";
import { RunnerTokenService } from "./runner-token.service.js";
export { registerRunnerConnections, RunnerConnections } from "./runner-connections.js";
export { fileListingQuerySchema, remoteFileListingSchema, fileSummaryResponseSchema } from "./runner.schema.js";

export async function runnersModule(app: FastifyInstance): Promise<void> {
  const scope = createScope(app.db);
  const tokenService = scope.get(
    defineService(
      { repository: createRunnerTokenRepository(app.db) },
      ({ repository, transaction }) => new RunnerTokenService(repository, transaction, app.credentialEncryptionKey),
    ),
  );
  const runnerService = scope.get(
    defineService(
      { repository: createRunnerRepository(app.db), connections: app.runnerConnections },
      ({ repository, connections }) => new RunnerService(repository, connections),
    ),
  );
  // 实际路径 /api/runner-tokens, /api/runners; 由 app.ts 在 /api 前缀下挂载.
  await app.register(async (scope) => runnerRoutes(scope, tokenService, runnerService), { prefix: "" });
}

export { type RunnerReader } from "./runner.repository.js";

export function createRunnerReader(db: Database): Scoped<RunnerReader> {
  return createRunnerRepository(db);
}
