import type { Database } from "../../database/index.js";
import { JobHost, type JobHandler } from "./job-host.js";

/**
 * Job registry: 业务 handler 注册点.
 *
 * 注册的 handler 必须自身是 at-least-once + idempotent. registry 不引入新的 Agent
 * DAG/Task 调度; 这些仍由 Harness Task Engine 拥有. Server jobs 仅负责业务唤醒
 * (run.wake, context.maintenance), GC (attachment.gc) 与外部通知 (outbox).
 */
export type Registry = Map<import("./postgres-job-store.js").JobKind, JobHandler>;

export function createJobHost(input: {
  db: Database;
  workerLeaseSeconds: number;
  pollIntervalMs?: number;
  batchLimit?: number;
  concurrency?: number;
  registry: Registry;
  onError?: (error: unknown) => void;
}): JobHost {
  return new JobHost({
    db: input.db,
    config: {
      workerLeaseSeconds: input.workerLeaseSeconds,
      pollIntervalMs: input.pollIntervalMs ?? 250,
      batchLimit: input.batchLimit ?? 1,
      concurrency: input.concurrency ?? 1,
    },
    registry: input.registry,
    ...(input.onError ? { onError: input.onError } : {}),
  });
}
