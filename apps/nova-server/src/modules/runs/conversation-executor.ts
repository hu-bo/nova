import type { EventRetentionService } from "../events/index.js";
import { randomUUID } from "node:crypto";
import type { Database } from "../../../database/index.js";
import type { JobRecord } from "../../jobs/postgres-job-store.js";
import type { UserModelProfilesService } from "../model-config/index.js";
import type { RemoteConnectionService } from "../remotes/index.js";
import type { RunnerConnections } from "../runners/index.js";
import type { RunClaim } from "./run.repository.js";
import { createRunService, type RunService } from "./run.service.js";
import "./nova-runtime.js";
import { runtimeAdapters } from "./runtime-adapter.js";
import type { RuntimeAdapter, RuntimeCommand } from "./runtime-adapter.js";
export class ConversationExecutor {
  private readonly repository: RunService;
  private readonly workerId = randomUUID();
  private readonly closing = new AbortController();
  private readonly active = new Set<Promise<void>>();
  constructor(
    private readonly deps: {
      db: Database;
      eventRetention: Pick<EventRetentionService, "retain">;
      models: UserModelProfilesService;
      remotes: RemoteConnectionService;
      runners: RunnerConnections;
    },
  ) {
    this.repository = createRunService(deps.db);
  }
  async close() {
    this.closing.abort();
    await Promise.allSettled([...this.active]);
  }
  async recoverAndRetain() {
    await this.repository.recover();
    await this.deps.eventRetention.retain();
  }
  handle(job: JobRecord) {
    const task = this.execute(job.aggregateId ?? String(job.payload.conversationId ?? ""));
    this.active.add(task);
    void task.finally(() => this.active.delete(task)).catch(() => undefined);
    return task;
  }
  private async execute(conversationId: string) {
    if (this.closing.signal.aborted) return;
    const prepared = await this.repository.prepare(conversationId, this.workerId);
    if (!prepared) return;
    const claim: RunClaim = { id: prepared.run.id, conversationId, workerId: this.workerId, fence: prepared.run.fence };
    const controller = new AbortController();
    const deadline = prepared.run.deadlineAt?.getTime() ?? Date.now() + 30 * 60000;
    const signal = AbortSignal.any([
      controller.signal,
      this.closing.signal,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    ]);
    let monitoring = false;
    const timer = setInterval(() => {
      if (monitoring) return;
      monitoring = true;
      void (async () => {
        const run = await this.repository.watch(claim);
        if (
          !run ||
          run.state === "cancelling" ||
          (prepared.conversation.metadata.goal?.status === "active" && run.goalStatus === "paused") ||
          !(await this.repository.heartbeat(claim))
        )
          controller.abort();
      })()
        .catch(() => controller.abort())
        .finally(() => {
          monitoring = false;
        });
    }, 1000);
    timer.unref();
    let adapter: RuntimeAdapter | undefined;
    try {
      if (prepared.run.state === "cancelling") {
        await this.repository.finish(claim, "cancelled");
        return;
      }
      if (deadline <= Date.now()) {
        await this.repository.finish(claim, "timed_out", "RUN_DEADLINE");
        return;
      }
      if (prepared.command.kind === "recover" && prepared.run.checkpoint?.outcome) {
        const outcome = prepared.run.checkpoint.outcome;
        await this.repository.finish(claim, outcome.state, outcome.reason);
        return;
      }
      const factory = runtimeAdapters.get(prepared.configuration.backendId)?.create;
      if (!factory) throw new Error("BACKEND_UNAVAILABLE");
      adapter = factory({ ...this.deps, prepared, claim, repository: this.repository });
      let command: RuntimeCommand = prepared.command;
      const goal = prepared.conversation.metadata.goal;
      let iterations = goal?.iterations ?? 0;
      do {
        signal.throwIfAborted();
        if (goal?.status === "active" && command.kind === "start") {
          await this.repository.goalIteration(claim);
          iterations++;
        }
        const current = await this.repository.load(claim);
        const outcome = await adapter.execute(command, {
          runId: claim.id,
          signal,
          checkpoint: current.checkpoint,
          commit: async (batch) => {
            const state = await this.repository.load(claim);
            await this.repository.commit(
              claim,
              state.revision,
              batch.checkpoint ?? state.checkpoint,
              batch.events,
              batch.consumedInputIds,
            );
          },
        });
        if (outcome.kind !== "completed") {
          await this.repository.suspend(claim, outcome.kind);
          return;
        }
        if (outcome.reason === "PERSISTENCE_FAILED") {
          await this.repository.releaseForRecovery(claim);
          return;
        }
        if (outcome.state !== "succeeded") {
          await this.repository.finish(claim, outcome.state, outcome.reason);
          return;
        }
        const checkpoint = await this.repository.load(claim);
        const goalStatus = checkpoint.projection?.goal;
        if (!goal || goalStatus?.status !== "active" || iterations >= goal.maxIterations) break;
        await adapter.dispose();
        adapter = factory({ ...this.deps, prepared, claim, repository: this.repository });
        command = {
          kind: "start",
          messageId: randomUUID(),
          input: {
            blocks: [{ id: "text", type: "text", text: "继续推进当前目标，复核完成标准。满足后调用 finish_goal。" }],
            mode: "next_run",
          },
        };
      } while (!signal.aborted);
      const cancellation = signal.aborted ? await adapter.cancel(claim.id) : "confirmed";
      await this.repository.finish(
        claim,
        signal.aborted ? (cancellation === "confirmed" ? "cancelled" : "cancelled_unconfirmed") : "succeeded",
      );
    } catch (error) {
      const reason = error instanceof Error && "code" in error ? String(error.code) : "EXECUTION_FAILED";
      const cancellation = signal.aborted && adapter ? await adapter.cancel(claim.id) : "confirmed";
      await this.repository.finish(
        claim,
        signal.aborted
          ? cancellation === "unknown"
            ? "cancelled_unconfirmed"
            : Date.now() >= deadline
              ? "timed_out"
              : "cancelled"
          : "failed",
        reason,
      );
    } finally {
      clearInterval(timer);
      await adapter?.dispose();
    }
  }
}
