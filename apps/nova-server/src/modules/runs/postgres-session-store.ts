import { randomUUID } from "node:crypto";
import {
  applySessionCommit,
  diagnostics,
  eventObservers,
  FrameworkError,
  sessionPersistence,
  sessionStore,
  type AgentEvent,
  type PluginDefinition,
  type SessionCommit,
  type SessionSnapshot,
  type SessionStore,
} from "@nnova/harness";
import { DomainError } from "../../shared/domain-error.js";
import { nativeSnapshot, type Checkpoint } from "./runtime-adapter.js";
import type { RunClaim } from "./run.repository.js";
import type { RunService } from "./run.service.js";
import { checkpointAfter, createJsonSizer } from "./session-checkpoint.js";

function persistenceError(error: unknown): FrameworkError {
  if (error instanceof FrameworkError) return error;
  if (error instanceof DomainError && error.details?.reason === "REVISION_CONFLICT")
    return new FrameworkError("REVISION_CONFLICT", "Checkpoint revision changed");
  if (error instanceof DomainError && error.details?.reason === "NOT_DISPATCHED")
    return new FrameworkError("NOT_DISPATCHED", "Execution environment requires inspection");
  if (error instanceof DomainError)
    return new FrameworkError(
      error.message.includes("limit") ? "SESSION_LIMIT" : "FENCE_CONFLICT",
      "Checkpoint commit was rejected",
    );
  return new FrameworkError("PERSISTENCE_FAILED", "Checkpoint was not confirmed");
}

/** One owner for background writes, retries, explicit flushes and shutdown. */
class BufferedRunEvents {
  private events: AgentEvent[] = [];
  private bytes = 0;
  private pending: { id: string; events: AgentEvent[]; bytes: number } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private flushing: Promise<void> | undefined;
  private paused = false;
  private overflow?: FrameworkError;

  constructor(
    private readonly write: (id: string, events: readonly AgentEvent[]) => Promise<void>,
    private readonly reportFailure: () => void,
  ) {}

  enqueue(event: AgentEvent): void {
    if (!["message.started", "assistant.delta", "assistant.reset", "tool.output"].includes(event.type)) return;
    if (this.overflow) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.bytes + bytes > 4 * 1024 * 1024 || this.events.length + (this.pending?.events.length ?? 0) >= 4096) {
      this.overflow = new FrameworkError("SESSION_LIMIT", "Event buffer exceeded its storage limit");
      this.reportFailure();
      return;
    }
    this.events.push(structuredClone(event));
    this.bytes += bytes;
    // The first event fixes the deadline; later events do not postpone it.
    if (!this.timer && !this.paused) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch(this.reportFailure);
      }, 50);
      this.timer.unref();
    }
  }

  flush(): Promise<void> {
    return (this.flushing ??= this.serialize(() => this.drain()).finally(() => {
      this.flushing = undefined;
    }));
  }

  mutate<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      // A completed native message must not overtake its buffered stream prefix.
      await this.drain();
      return operation();
    });
  }

  async close(): Promise<void> {
    this.cancelTimer();
    await this.flush();
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async drain(): Promise<void> {
    this.cancelTimer();
    if (this.overflow) throw this.overflow;
    this.paused = false;
    while (this.pending || this.events.length) {
      this.pending ??= {
        id: randomUUID(),
        events: this.events.splice(0),
        bytes: this.bytes,
      };
      try {
        await this.write(this.pending.id, this.pending.events);
      } catch (error) {
        // Retain the exact batch ID and order. Only an explicit flush retries it.
        this.paused = true;
        this.cancelTimer();
        throw persistenceError(error);
      }
      this.bytes -= this.pending.bytes;
      this.pending = undefined;
    }
  }
}

/** Synchronous notifications enqueue; async state commits and policy flushes confirm durability. */
export function postgresSessionPlugin(repository: RunService, claim: RunClaim): PluginDefinition {
  return {
    manifest: {
      id: "nova.session-postgres",
      version: "0.1.0",
      apiVersion: 1,
      scope: "session",
      requires: [],
      optional: [diagnostics],
      provides: [sessionStore, sessionPersistence],
      contributes: [eventObservers],
    },
    setup(context) {
      let cached: { checkpoint: Checkpoint; snapshot: SessionSnapshot } | undefined;
      const size = createJsonSizer();
      const frozen = new WeakSet<object>();
      const immutable = <T>(value: T): T => {
        if (value && typeof value === "object" && !frozen.has(value)) {
          for (const child of Object.values(value)) immutable(child);
          Object.freeze(value);
          frozen.add(value);
        }
        return value;
      };
      const buffer = new BufferedRunEvents(
        (id, events) => repository.publishNativeEvents(claim, id, events),
        () =>
          context.optional(diagnostics)?.({
            code: "PERSISTENCE_FAILED",
            message: "Background event persistence failed; checkpoint flush will retry.",
          }),
      );
      const store: SessionStore = {
        async load() {
          if (cached && cached.snapshot.revision === (await repository.sessionRevision(claim))) return cached.snapshot;
          const { checkpoint, revision } = await repository.load(claim);
          cached = { checkpoint: immutable(checkpoint), snapshot: immutable(nativeSnapshot(checkpoint, revision)) };
          return cached.snapshot;
        },
        commit: (batch, revision) => commitBatch(batch, revision),
        update: (batch) => commitBatch(batch),
      };
      async function commitBatch(batch: SessionCommit, revision?: number): Promise<SessionSnapshot> {
        try {
          return await buffer.mutate(async () => {
            const current =
              revision !== undefined && cached?.snapshot.revision === revision ? cached.snapshot : await store.load();
            if (revision !== undefined && current.revision !== revision)
              throw new FrameworkError("REVISION_CONFLICT", "Checkpoint revision changed");
            const next = applySessionCommit(current, batch);
            const checkpoint = checkpointAfter(cached!.checkpoint, next, batch);
            await repository.commitSession(claim, current.revision, next, batch, size(checkpoint));
            cached = { checkpoint: immutable(checkpoint), snapshot: immutable(next) };
            return cached.snapshot;
          });
        } catch (error) {
          cached = undefined;
          throw persistenceError(error);
        }
      }
      context.provide(sessionStore, store);
      context.provide(sessionPersistence, { flush: () => buffer.flush() });
      context.contribute(eventObservers, { observe: (event) => buffer.enqueue(event) });
      context.onDispose(() => buffer.close());
    },
  };
}
