import type { EventRetentionService } from "../events/index.js";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { createJobHost } from "../../jobs/job-registry.js";
import { createRemoteService } from "../remotes/index.js";
import { createUserModelProfilesService } from "../model-config/index.js";
import { ConversationExecutor } from "./conversation-executor.js";
export function startConversationExecution(
  app: FastifyInstance,
  config: AppConfig,
  eventRetention: Pick<EventRetentionService, "retain">,
) {
  const executor = new ConversationExecutor({
    db: app.db,
    eventRetention,
    models: createUserModelProfilesService(app),
    remotes: createRemoteService(app),
    runners: app.runnerConnections,
  });
  const host = createJobHost({
    db: app.db,
    workerLeaseSeconds: config.WORKER_LEASE_SECONDS,
    batchLimit: config.WORKER_CONCURRENCY,
    concurrency: config.WORKER_CONCURRENCY,
    registry: new Map([["run.wake", (job) => executor.handle(job)]]),
    onError: (error) => {
      const cause = error instanceof Error ? (error.cause ?? error) : error;
      app.log.error(
        {
          errorName: error instanceof Error ? error.name : "UNKNOWN",
          errorCode: cause && typeof cause === "object" && "code" in cause ? String(cause.code) : undefined,
        },
        "Conversation job dispatch failed",
      );
    },
  });
  app.addHook("onReady", async () => {
    await executor.recoverAndRetain();
    host.start();
  });
  let maintaining = false;
  const maintenance = setInterval(() => {
    if (maintaining) return;
    maintaining = true;
    void executor
      .recoverAndRetain()
      .catch(() => app.log.error("Run recovery failed"))
      .finally(() => {
        maintaining = false;
      });
  }, 10000);
  maintenance.unref();
  app.addHook("onClose", async () => {
    clearInterval(maintenance);
    const stopped = host.stop();
    await executor.close();
    await stopped;
  });
}
