import type { EventRetentionService } from "../events/index.js";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { createJobHost } from "../../jobs/job-registry.js";
import type { Registry } from "../../jobs/job-registry.js";
import type { JobRecord } from "../../jobs/postgres-job-store.js";
import { createRemoteService } from "../remotes/index.js";
import { createUserModelProfilesService } from "../model-config/index.js";
import { ConversationExecutor } from "./conversation-executor.js";
import type { UploadStorage } from "../attachments/index.js";
import type { ArtifactService } from "../artifacts/index.js";
export function startConversationExecution(
  app: FastifyInstance,
  config: AppConfig,
  eventRetention: Pick<EventRetentionService, "retain">,
  uploads: UploadStorage,
  artifacts?: ArtifactService,
) {
  const executor = new ConversationExecutor({
    db: app.db,
    eventRetention,
    models: createUserModelProfilesService(app),
    remotes: createRemoteService(app),
    runners: app.runnerConnections,
    localResources: app.localResources,
    artifacts,
    uploads,
    logger: app.log,
  });
  const registry: Registry = new Map([["run.wake", (job: JobRecord) => executor.handle(job)]]);
  // 会话删除的对象清理 Job：删除幂等（NotFound 吞掉），失败由 job 重试兜底（P1-F1）。
  if (artifacts)
    registry.set("artifact.purge", async (job) => {
      await artifacts.handlePurgeJob(job.payload);
    });
  // Run 终态后的工作区 tmp 清理（P1-D3/F1）：全部发布结算后执行；
  // 待核实/未结算发布抛错延迟重试，旧 Runner 无写能力则跳过（无 tmp 也无需清理）。
  if (artifacts)
    registry.set("run.tmp-cleanup", async (job) => {
      const runId = String(job.payload.runId ?? "");
      if (!runId || (await artifacts.hasPendingPublications(runId)))
        throw new Error("Artifact publications not settled yet; retry tmp cleanup later");
      const ownerUserId = String(job.payload.ownerUserId ?? "");
      const runnerRowId = String(job.payload.runnerRowId ?? "");
      const workspaceId = String(job.payload.workspaceId ?? "");
      const relativePath = String(job.payload.relativePath ?? "");
      if (!ownerUserId || !runnerRowId || !workspaceId || !relativePath.startsWith(".nova/runs/")) return;
      const { session } = await app.runnerConnections.require(runnerRowId, ownerUserId);
      if (!session.supportsLocalResourceWrites()) return;
      const result = await session.deleteWorkspacePaths({
        workspaceId,
        relativePaths: [relativePath],
        idempotencyKey: `run-tmp-cleanup:${runId}`,
        timeoutMs: 30_000,
      });
      // 结果未知的删除按幂等处理：交给 Job 重试，Runner 侧不存在即成功。
      if (!result.ok) throw new Error(`tmp cleanup deferred: ${result.error.code}`);
    });
  const host = createJobHost({
    db: app.db,
    workerLeaseSeconds: config.WORKER_LEASE_SECONDS,
    batchLimit: config.WORKER_CONCURRENCY,
    concurrency: config.WORKER_CONCURRENCY,
    registry,
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
  // 孤儿对象扫描兜底（P1-F1）：Job 重试之外的定期对账；仅在存储已配置时运行。
  let scanningOrphans = false;
  const orphanScan = artifacts
    ? setInterval(() => {
        if (scanningOrphans) return;
        scanningOrphans = true;
        void artifacts
          .scanOrphans()
          .then((result) => {
            if (result.removed > 0) app.log.warn(result, "Artifact orphan scan removed objects");
          })
          .catch(() => app.log.warn("Artifact orphan scan failed"))
          .finally(() => {
            scanningOrphans = false;
          });
      }, 6 * 60 * 60 * 1000)
    : undefined;
  orphanScan?.unref();
  app.addHook("onClose", async () => {
    clearInterval(maintenance);
    if (orphanScan) clearInterval(orphanScan);
    const stopped = host.stop();
    await executor.close();
    await stopped;
  });
}
