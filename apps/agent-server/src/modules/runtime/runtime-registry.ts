import { randomUUID } from "node:crypto";
import { automaticRecoveryReasons, publicRun, type RunControl, type RunClaim } from "./run-control.js";
import type { RunState } from "@nova/protocol";
import type { Agent, CompactionResult, ContextUsage, QueueName } from "@nova/agent-core";
import type { TokenEstimate } from "@nova/model-adapters";
import type { ThinkingLevel } from "@nova/model-adapters";
import { createLogger } from "@nova/logger";
import type { EntryRoute } from "../../store.js";
import { conflict } from "../../errors.js";
import type { ContentPart } from "@nova/agent-core";

const logger = createLogger("agent-server").child("runtime-registry");

export interface ConversationRuntimes {
  status?(conversationId: string): Promise<RunState | null>;
  resume?(route: EntryRoute): Promise<void>;
  close?(): Promise<void>;
  send(
    route: EntryRoute,
    text: string | ContentPart[],
    queue?: QueueName,
    thinkingLevel?: ThinkingLevel,
    requestId?: string,
  ): Promise<void>;
  abort(conversationId: string): Promise<void>;
  context(route: EntryRoute): Promise<ContextUsage>;
  estimatePrompt(route: EntryRoute, text: string): Promise<TokenEstimate & { model: string }>;
  compact(route: EntryRoute): Promise<CompactionResult>;
  clear(route: EntryRoute, clearStorage: () => Promise<void>): Promise<ContextUsage>;
  invalidate(conversationId: string): void;
}

type RuntimeEntry = {
  agent: Agent;
  signature: string;
  lastUsedAt: number;
};

export function createRuntimeRegistry(
  create: (route: EntryRoute) => Promise<Agent>,
  onEvent: (conversationId: string, agent: Agent) => void,
  onRunFailure: (failure: {
    conversationId: string;
    runId?: string;
    provider: string;
    model: string;
    endpointHost: string;
    message: string;
    error?: unknown;
  }) => void,
  idleMs = 30 * 60 * 1000,
  control?: RunControl,
): ConversationRuntimes {
  const active = new Map<
    string,
    { agent: Agent; claim: RunClaim; route: EntryRoute; generation: string | null; task: Promise<unknown> }
  >();
  const sending = new Map<string, Promise<void>>();
  const starting = new Set<string>();
  let closed = false;
  let scanning = false;
  const entries = new Map<string, RuntimeEntry>();
  const creating = new Map<string, Promise<RuntimeEntry>>();
  const clearing = new Set<string>();

  const get = async (route: EntryRoute): Promise<RuntimeEntry> => {
    const id = route.conversation.id;
    const signature = runtimeSignature(route) + ":" + (control?.runnerGeneration(route) ?? "");
    const existing = entries.get(id);
    if (existing && existing.signature === signature) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (existing?.agent.state.isStreaming) return existing;
    const pending = creating.get(id);
    if (pending) {
      await pending;
      return get(route);
    }
    const creation = create(route).then((agent) => {
      logger.debug({ conversationId: id, runnerId: route.conversation.runnerId }, "created conversation runtime");
      onEvent(id, agent);
      const entry = { agent, signature, lastUsedAt: Date.now() };
      entries.set(id, entry);
      return entry;
    });
    creating.set(id, creation);
    try {
      return await creation;
    } finally {
      if (creating.get(id) === creation) creating.delete(id);
    }
  };

  const interval = setInterval(
    () => {
      const threshold = Date.now() - idleMs;
      for (const [id, entry] of entries) {
        if (!entry.agent.state.isStreaming && entry.lastUsedAt < threshold) entries.delete(id);
      }
    },
    Math.min(idleMs, 60_000),
  );
  interval.unref();

  const withIdle = async <T>(route: EntryRoute, operation: () => Promise<T>): Promise<T> => {
    const id = route.conversation.id;
    if (closed || active.has(id) || starting.has(id) || clearing.has(id)) throw conflict("Conversation is running");
    clearing.add(id);
    let claim: RunClaim | null = null;
    try {
      if (control) {
        claim = await control.claim(id);
        if (!claim) throw conflict("Conversation is owned by another runtime");
        const cp = await control.storage(id).loadCheckpoint(id);
        if (cp && ["running", "paused"].includes(cp.status))
          throw conflict("Stop the unfinished run before changing its context");
      }
      return await operation();
    } finally {
      clearing.delete(id);
      if (claim) await claim.release();
    }
  };

  const launch = async (
    route: EntryRoute,
    resume: boolean,
    text?: string | ContentPart[],
    thinkingLevel?: ThinkingLevel,
    requestId?: string,
  ) => {
    const id = route.conversation.id;
    if (closed || clearing.has(id) || starting.has(id) || active.has(id) || active.size + starting.size >= 4)
      throw conflict("Conversation is running");
    starting.add(id);
    let claim: RunClaim | null = null;
    try {
      claim = control ? await control.claim(id) : { signal: new AbortController().signal, release: async () => {} };
      if (!claim) throw conflict("Conversation is owned by another runtime");
      if (resume && control) {
        const storage = control.storage(id);
        const cp = await storage.loadCheckpoint(id);
        if (
          !cp ||
          (!["running", "paused"].includes(cp.status) && !(cp.status === "completed" && cp.queues?.nextRun.length))
        )
          return;
        // The Core has already committed this outcome; completing it needs no Runner or model.
        if (cp.phase === "finish" && cp.completion && cp.status !== "completed" && !cp.queues?.followUp.length) {
          const stopReason = cp.completion;
          const status =
            stopReason === "aborted"
              ? ("cancelled" as const)
              : ["error", "max_tokens", "max_turns", "repetition_detected"].includes(stopReason)
                ? ("failed" as const)
                : ("completed" as const);
          await storage.commit(id, {
            expectedVersion: cp.version,
            checkpoint: {
              ...cp,
              version: cp.version + 1,
              status,
              reason: status === "failed" ? stopReason : null,
              pendingDecision: null,
            },
            record: { id: randomUUID(), runId: cp.runId, ts: Date.now(), kind: "run-finished", stopReason },
          });
          return;
        }
        if (cp.reason && !automaticRecoveryReasons.has(cp.reason))
          throw conflict("This run requires inspection; cancel it before starting a new task");
        if (cp.phase !== "finish" && cp.deadline <= Date.now()) {
          await storage.commit(id, {
            expectedVersion: cp.version,
            checkpoint: { ...cp, version: cp.version + 1, status: "failed", reason: "deadline_exceeded" },
          });
          return;
        }
      }
      if (
        resume &&
        control &&
        (route.conversation.runnerId ?? route.project?.runnerId) &&
        !control.runnerGeneration(route)
      ) {
        const storage = control.storage(id);
        const cp = await storage.loadCheckpoint(id);
        if (cp && (cp.status !== "paused" || cp.reason !== "runner_disconnected"))
          await storage.commit(id, {
            expectedVersion: cp.version,
            checkpoint: {
              ...cp,
              version: cp.version + 1,
              status: "paused",
              reason: "runner_disconnected",
              pendingDecision: null,
            },
          });
        return;
      }
      entries.delete(id);
      let agent: Agent;
      try {
        agent = (await get(route)).agent;
      } catch (error) {
        if (resume && control) {
          const storage = control.storage(id);
          const cp = await storage.loadCheckpoint(id);
          if (cp)
            await storage.commit(id, {
              expectedVersion: cp.version,
              checkpoint: {
                ...cp,
                version: cp.version + 1,
                status: "paused",
                reason: "runtime_failed",
                pendingDecision: null,
              },
            });
        }
        throw error;
      }
      if (closed) return;
      if (claim.signal.aborted) throw new Error("Run ownership was lost during startup");
      // A persisted run.state is the acceptance barrier. Never acknowledge an uncommitted prompt.
      let accepted!: () => void;
      const ready = new Promise<void>((resolve) => {
        accepted = resolve;
      });
      const unsubscribe = agent.subscribe((event) => {
        if (event.type === "run.state") accepted();
      });
      const operation = resume
        ? agent.resume()
        : agent.prompt(text!, { ...(thinkingLevel ? { thinkingLevel } : {}), ...(requestId ? { requestId } : {}) });
      const ownedClaim = claim;
      const onLost = () => {
        void agent.pause("ownership_lost").catch(() => undefined);
      };
      ownedClaim.signal.addEventListener("abort", onLost, { once: true });
      if (ownedClaim.signal.aborted) onLost();
      const task = operation
        .catch((error) => {
          onRunFailure({
            ...failureContext(route),
            message: error instanceof Error ? error.message : String(error),
            error,
          });
        })
        .finally(async () => {
          unsubscribe();
          ownedClaim.signal.removeEventListener("abort", onLost);
          active.delete(id);
          entries.delete(id); // Every run rebinds its Runner session and reloads committed context.
          await ownedClaim.release();
        })
        .catch((error) => logger.error({ err: error, conversationId: id }, "failed to release run ownership"));
      active.set(id, { agent, claim, route, generation: control?.runnerGeneration(route) ?? null, task });
      claim = null;
      await Promise.race([ready, operation.then(() => undefined)]);
    } finally {
      starting.delete(id);
      if (claim) await claim.release();
    }
  };

  const recover = async () => {
    if (!control || closed || scanning) return;
    scanning = true;
    try {
      for (const item of active.values()) {
        if (item.generation !== control.runnerGeneration(item.route))
          void item.agent.pause("runner_disconnected").catch(() => undefined);
      }
      if (active.size + starting.size >= 4) return;
      for (const route of await control.candidates()) {
        const id = route.conversation.id;
        if (active.has(id) || starting.has(id)) continue;
        if (active.size + starting.size >= 4 || closed) break;
        try {
          await launch(route, true);
        } catch (error) {
          if (!(error instanceof Error && "statusCode" in error))
            logger.debug({ conversationId: id }, "run recovery deferred");
        }
      }
    } catch (error) {
      logger.error({ err: error }, "run recovery scan failed");
    } finally {
      scanning = false;
    }
  };
  const recoveryTimer = control
    ? setInterval(() => {
        void recover();
      }, 1000)
    : undefined;
  recoveryTimer?.unref();

  return {
    async status(id) {
      return control ? publicRun(await control.storage(id).loadCheckpoint(id)) : null;
    },
    async resume(route) {
      await launch(route, true);
    },
    async close() {
      closed = true;
      clearInterval(interval);
      clearInterval(recoveryTimer);
      await Promise.all(
        [...active.values()].map(async (item) => {
          await item.agent.pause("server_shutdown");
          await item.task;
        }),
      );
    },
    async send(route, text, queue, thinkingLevel, requestId) {
      const id = route.conversation.id;
      const task = (sending.get(id) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          if (requestId && control) {
            const facts = await control.storage(route.conversation.id).loadRecords(route.conversation.id);
            if (
              facts.some((f) => (f.kind === "run-started" || f.kind === "queue-enqueued") && f.requestId === requestId)
            )
              return;
          }
          if (clearing.has(route.conversation.id)) throw conflict("Conversation context is being cleared");
          const agent = active.get(route.conversation.id)?.agent ?? entries.get(route.conversation.id)?.agent;
          if (agent?.state.isStreaming) {
            logger.debug(
              { conversationId: route.conversation.id, queue: queue ?? "steering" },
              "queued message for active run",
            );
            switch (queue ?? "steering") {
              case "steering":
                await agent.steer(text, requestId);
                break;
              case "followUp":
                await agent.followUp(text, requestId);
                break;
              case "nextRun":
                await agent.nextRun(text, requestId);
                break;
            }
            return;
          }
          await launch(route, false, text, thinkingLevel, requestId);
        });
      sending.set(id, task);
      try {
        await task;
      } finally {
        if (sending.get(id) === task) sending.delete(id);
      }
    },
    async abort(conversationId) {
      const running = active.get(conversationId);
      if (running) {
        await running.agent.abort();
        return;
      }
      if (!control) {
        const entry = entries.get(conversationId);
        if (!entry) throw conflict("Conversation is not running");
        await entry.agent.abort();
        return;
      }
      const claim = await control.claim(conversationId);
      if (!claim) throw conflict("Conversation is owned by another runtime");
      try {
        const storage = control.storage(conversationId);
        const cp = await storage.loadCheckpoint(conversationId);
        if (cp && ["running", "paused"].includes(cp.status))
          await storage.commit(conversationId, {
            expectedVersion: cp.version,
            checkpoint: { ...cp, version: cp.version + 1, status: "cancelled", reason: null, phase: "finish" },
          });
        entries.delete(conversationId);
      } finally {
        await claim.release();
      }
    },
    async context(route) {
      return (await get(route)).agent.contextUsage();
    },
    async estimatePrompt(route, text) {
      return (await get(route)).agent.estimatePrompt(text);
    },
    async compact(route) {
      return withIdle(route, async () => {
        entries.delete(route.conversation.id);
        return (await get(route)).agent.compact();
      });
    },
    async clear(route, clearStorage) {
      return withIdle(route, async () => {
        entries.delete(route.conversation.id);
        await clearStorage();
        return (await get(route)).agent.contextUsage();
      });
    },
    invalidate(conversationId) {
      const entry = entries.get(conversationId);
      if (!entry?.agent.state.isStreaming) entries.delete(conversationId);
    },
  };
}

function failureContext(route: EntryRoute) {
  const config = route.conversation.modelConfig;
  let endpointHost = "invalid endpoint";
  try {
    endpointHost = new URL(config.endpoint).host;
  } catch {
    /* validation reports the malformed endpoint elsewhere */
  }
  return { conversationId: route.conversation.id, provider: config.provider, model: config.model, endpointHost };
}

function runtimeSignature(route: EntryRoute): string {
  return JSON.stringify({
    modelConfig: route.conversation.modelConfig,
    runnerId: route.conversation.runnerId ?? route.project?.runnerId ?? null,
    workspace: route.project?.workspace ?? null,
    instructions: route.project?.instructions ?? null,
  });
}
