import type { Runner, RunnerToken } from "@nova/protocol";
import { conflict } from "../../errors.js";
import { createRunnerTokenSecret, type AgentStore, type RunnerRow, type RunnerTokenRow } from "../../store.js";
import type { RunnerRegistry } from "./registry.js";

export function createRunnerService(store: AgentStore, registry: RunnerRegistry) {
  const tokenView = async (token: RunnerTokenRow): Promise<RunnerToken> => ({
    id: token.id,
    token: token.token,
    createdAt: token.createdAt.getTime(),
    boundRunnerIds: await store.listRunnerIdsByToken({ userId: token.userId, tokenId: token.id }),
  });
  const runnerView = (runner: RunnerRow): Runner => ({
    id: runner.id,
    tokenId: runner.tokenId,
    rootWorkspace: runner.rootWorkspace,
    version: runner.version,
    platform: runner.platform,
    capabilities: runner.capabilities,
    maxConcurrency: runner.maxConcurrency,
    running: runner.running,
    state: registry.status(runner.ownerId, runner.id),
    registeredAt: runner.registeredAt.getTime(),
    lastSeenAt: runner.lastSeenAt.getTime(),
  });

  return {
    async listTokens(userId: string) {
      return Promise.all((await store.listRunnerTokens(userId)).map(tokenView));
    },
    async createToken(userId: string) {
      return tokenView(await store.createRunnerToken({ userId, token: createRunnerTokenSecret() }));
    },
    async deleteToken(userId: string, id: string) {
      const bound = await store.deleteRunnerToken({ userId, id });
      if (bound.length) throw conflict(`Runner token is still bound to: ${bound.join(", ")}`);
    },
    async list(userId: string, input: { limit: number; cursor?: string }) {
      const page = await store.listRunners({ userId, ...input });
      return { items: page.items.map(runnerView), nextCursor: page.nextCursor };
    },
    listDirectories(userId: string, runnerId: string, path?: string) {
      return registry.listDirectories(userId, runnerId, path);
    },
    async remove(userId: string, id: string) {
      if (registry.isOnline(userId, id)) throw conflict("Stop the runner before deleting it");
      await store.deleteRunner({ userId, id });
    },
  };
}
