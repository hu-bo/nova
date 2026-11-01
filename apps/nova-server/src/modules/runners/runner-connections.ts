import { randomUUID } from "node:crypto";
import { createRunnerSdk, type RunnerSession } from "@nova/runner-sdk";
import type { FastifyInstance } from "fastify";
import { createRunnerRepository, type RunnerRepository } from "./runner.repository.js";
import { createRunnerTokenRepository, type RunnerTokenRepository } from "./runner-token.repository.js";
import { RunnerRegistrationService } from "./runner-registration.service.js";
import { createScope, defineService } from "../../shared/scope.js";
import { DomainError } from "../../shared/domain-error.js";

export class RunnerConnections {
  constructor(
    private readonly runners: RunnerRepository,
    private readonly tokens: RunnerTokenRepository,
    private readonly connections = new Map<string, { owner: string; tokenId: string; session: RunnerSession }>(),
  ) {}
  async require(id: string, owner: string) {
    const connection = this.connections.get(id);
    const runner = await this.runners.findOwned(id, owner);
    const token = connection ? await this.tokens.find(connection.tokenId) : undefined;
    if (
      !runner ||
      !connection ||
      connection.owner !== owner ||
      !connection.session.connected ||
      !token ||
      token.status !== "active" ||
      (token.expiresAt && token.expiresAt.getTime() <= Date.now())
    )
      throw new DomainError("CONFLICT", "Runner is offline or its token expired", { reason: "RUNNER_OFFLINE" });
    return { session: connection.session, runner };
  }
  add(id: string, owner: string, tokenId: string, session: RunnerSession) {
    this.connections.set(id, { owner, tokenId, session });
  }
  async refresh() {
    for (const [id, connection] of this.connections) {
      const token = await this.tokens.find(connection.tokenId);
      if (!token || token.status !== "active" || (token.expiresAt && token.expiresAt.getTime() <= Date.now())) {
        await connection.session.close();
        this.connections.delete(id);
        continue;
      }
      if (connection.session.connected) await this.runners.touch(id);
    }
  }
}
declare module "fastify" {
  interface FastifyInstance {
    runnerConnections: RunnerConnections;
    executionEnabled: boolean;
  }
}
export async function registerRunnerConnections(app: FastifyInstance, exportMode: boolean) {
  const runners = createRunnerRepository(app.db);
  const tokens = createRunnerTokenRepository(app.db);
  const scope = createScope(app.db);
  const registration = scope.get(
    defineService(
      { runners, tokens },
      ({ runners, tokens, transaction }) => new RunnerRegistrationService(tokens, transaction),
    ),
  );
  const sessions = new Map<string, { owner: string; tokenId: string; session: RunnerSession }>();
  const connections = scope.get(
    defineService(
      { runners, tokens, sessions },
      ({ runners, tokens, sessions }) => new RunnerConnections(runners, tokens, sessions),
    ),
  );
  app.decorate("runnerConnections", connections);
  if (exportMode) return;
  const sdk = createRunnerSdk({
    server: app.server,
    path: "/runner/v1/connect",
    onDiagnostic: ({ code }) => app.log.warn({ code }, "Runner transport"),
  });
  sdk.onSession(async (candidate) => {
    const registered = await registration.register(candidate.token, candidate.identity);
    if (!registered) {
      candidate.reject("DENIED", "Invalid or expired Runner token");
      return;
    }
    const session = await candidate.accept({ principalId: registered.ownerUserId });
    connections.add(registered.runner.id, registered.ownerUserId, registered.tokenId, session);
  });
  const timer = setInterval(() => {
    void connections.refresh().catch(() => app.log.warn("Runner status refresh failed"));
  }, 10_000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await sdk.close();
  });
}
export function runnerReadContext(session: RunnerSession, workspaceId: string, signal = AbortSignal.timeout(15_000)) {
  return session.createToolContext({ workspaceId, signal, executionId: randomUUID(), idempotencyKey: randomUUID() });
}
