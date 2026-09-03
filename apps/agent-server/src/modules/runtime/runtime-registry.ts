import type { Agent, CompactionResult, ContextUsage, QueueName } from "@nova/agent-core";
import type { TokenEstimate } from "@nova/model-adapters";
import type { ThinkingLevel } from "@nova/model-adapters";
import { createLogger } from "@nova/logger";
import type { EntryRoute } from "../../store.js";
import { conflict } from "../../errors.js";

const logger = createLogger("agent-server").child("runtime-registry");

export interface ConversationRuntimes {
  send(route: EntryRoute, text: string, queue?: QueueName, thinkingLevel?: ThinkingLevel): Promise<void>;
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
): ConversationRuntimes {
  const entries = new Map<string, RuntimeEntry>();
  const creating = new Map<string, Promise<RuntimeEntry>>();
  const clearing = new Set<string>();

  const get = async (route: EntryRoute): Promise<RuntimeEntry> => {
    const id = route.conversation.id;
    const signature = runtimeSignature(route);
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

  return {
    async send(route, text, queue, thinkingLevel) {
      if (clearing.has(route.conversation.id)) throw conflict("Conversation context is being cleared");
      const { agent } = await get(route);
      if (agent.state.isStreaming) {
        logger.debug(
          { conversationId: route.conversation.id, queue: queue ?? "steering" },
          "queued message for active run",
        );
        switch (queue ?? "steering") {
          case "steering":
            agent.steer(text);
            break;
          case "followUp":
            agent.followUp(text);
            break;
          case "nextRun":
            agent.nextRun(text);
            break;
        }
        return;
      }
      logger.info({ conversationId: route.conversation.id }, "starting agent run");
      void agent
        .prompt(text, thinkingLevel ? { thinkingLevel } : undefined)
        .then((result) => {
          if (result.stopReason === "error") {
            logger.error(
              {
                component: "model-provider",
                conversationId: route.conversation.id,
                runId: result.runId,
                errorMessage: result.errorMessage,
              },
              "model provider returned an error",
            );
            onRunFailure({
              ...failureContext(route),
              runId: result.runId,
              message: result.errorMessage ?? "Conversation run failed",
            });
          }
        })
        .catch((error) => {
          logger.error(
            {
              err: error,
              component: "agent-core",
              conversationId: route.conversation.id,
            },
            "agent run failed",
          );
          onRunFailure({
            ...failureContext(route),
            message: error instanceof Error ? error.message : String(error),
            error,
          });
        });
    },
    async abort(conversationId) {
      const entry = entries.get(conversationId);
      if (!entry) throw conflict("Conversation is not running");
      logger.info({ conversationId }, "aborting agent run");
      await entry.agent.abort();
    },
    async context(route) {
      return (await get(route)).agent.contextUsage();
    },
    async estimatePrompt(route, text) {
      return (await get(route)).agent.estimatePrompt(text);
    },
    async compact(route) {
      const { agent } = await get(route);
      if (agent.state.isStreaming) throw conflict("Conversation is running");
      try {
        return await agent.compact();
      } catch (error) {
        if (error instanceof Error && error.message === "agent is running") {
          throw conflict("Conversation is running");
        }
        throw error;
      }
    },
    async clear(route, clearStorage) {
      const conversationId = route.conversation.id;
      if (clearing.has(conversationId)) throw conflict("Conversation context is being cleared");
      const entry = entries.get(conversationId);
      if (entry?.agent.state.isStreaming) throw conflict("Conversation is running");
      clearing.add(conversationId);
      entries.delete(conversationId);
      try {
        await clearStorage();
        return (await get(route)).agent.contextUsage();
      } finally {
        clearing.delete(conversationId);
      }
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
