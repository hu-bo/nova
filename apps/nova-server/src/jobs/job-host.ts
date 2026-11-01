import type { Database } from "../../database/index.js";
import { setTimeout as wait } from "node:timers/promises";
import {
  claim,
  fail,
  succeed,
  heartbeat,
  type ClaimOutcome,
  type JobKind,
  type JobRecord,
} from "./postgres-job-store.js";

/**
 * Job host: 单进程内循环 claim → dispatch → ack/fail.
 *
 * 设计原则:
 * - 每种 job kind 自身需要 at-least-once + idempotent. registry 仅做形状映射.
 * - claim 周期 250 ms; 与 LISTEN/NOTIFY 唤醒结合可降频 (本期未接入).
 * - shutdown 由 process signal + K8s terminationGrace 配合; host.stop() 后新任务不再
 *   claim, 但已 claim 的 lease 不会被立刻撤销 (DB lease 自然过期).
 */
export type JobHandler = (job: JobRecord) => Promise<void>;

export type JobHostConfig = {
  workerLeaseSeconds: number;
  pollIntervalMs: number;
  batchLimit: number;
  concurrency?: number;
};

export class JobHost {
  private running = false;
  private readonly abortController = new AbortController();
  private readonly active = new Set<Promise<void>>();
  private loopTask?: Promise<void>;

  constructor(
    private readonly deps: {
      db: Database;
      config: JobHostConfig;
      registry: Map<JobKind, JobHandler>;
      onError?: (error: unknown) => void;
    },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopTask = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController.abort();
    await this.loopTask;
  }

  signal(): AbortSignal {
    return this.abortController.signal;
  }

  private async loop(): Promise<void> {
    while (this.running && !this.abortController.signal.aborted) {
      try {
        if (this.active.size >= (this.deps.config.concurrency ?? 1)) {
          await Promise.race(this.active);
          continue;
        }
        const outcome = await this.dispatchOnce();
        if (outcome.kind === "empty") {
          await this.sleep(this.deps.config.pollIntervalMs);
        }
      } catch (error) {
        this.deps.onError?.(error);
        await this.sleep(1_000);
      }
    }
    await Promise.allSettled(this.active);
  }

  private async dispatchOnce(): Promise<ClaimOutcome> {
    const kinds = [...this.deps.registry.keys()];
    if (kinds.length === 0) return { kind: "empty" };
    const outcome = await claim({
      db: this.deps.db,
      kinds,
      limit: Math.min(this.deps.config.batchLimit, (this.deps.config.concurrency ?? 1) - this.active.size),
      leaseSeconds: this.deps.config.workerLeaseSeconds,
    });
    if (outcome.kind === "empty") return outcome;

    for (const job of outcome.jobs) {
      if (!this.running) {
        await fail({ db: this.deps.db, jobId: job.jobId, safeErrorCode: "WORKER_STOPPING", rescheduleAfterSeconds: 1 });
        continue;
      }
      const task = this.execute(job)
        .catch((error) => this.deps.onError?.(error))
        .finally(() => this.active.delete(task));
      this.active.add(task);
    }
    return outcome;
  }

  private async execute(job: JobRecord): Promise<void> {
    const handler = this.deps.registry.get(job.kind);
    if (!handler) {
      await fail({ db: this.deps.db, jobId: job.jobId, safeErrorCode: "NO_HANDLER" });
      return;
    }
    const leaseHeartbeat = setInterval(
      () => {
        void heartbeat({
          db: this.deps.db,
          jobId: job.jobId,
          leaseSeconds: this.deps.config.workerLeaseSeconds,
        }).catch(() => undefined);
      },
      Math.max(1000, (this.deps.config.workerLeaseSeconds * 1000) / 3),
    );
    leaseHeartbeat.unref();
    try {
      await handler(job);
      await succeed({ db: this.deps.db, jobId: job.jobId });
    } catch (error) {
      const code = error instanceof Error ? error.name : "UNKNOWN";
      await fail({
        db: this.deps.db,
        jobId: job.jobId,
        safeErrorCode: code,
        rescheduleAfterSeconds: 30,
      });
    } finally {
      clearInterval(leaseHeartbeat);
    }
  }

  private sleep(ms: number): Promise<void> {
    return wait(ms, undefined, { signal: this.abortController.signal, ref: false }).catch((error: unknown) => {
      if (!this.abortController.signal.aborted) throw error;
    });
  }
}
