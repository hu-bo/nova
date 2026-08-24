import type { Agent, QueueName } from "@nova/agent-core";
import { createLogger } from "@nova/logger";
import type { EntryRoute } from "../../store.js";
import { conflict } from "../../errors.js";

const logger = createLogger("agent-server").child("runtime-registry");

export interface ConversationRuntimes {
  send(route: EntryRoute, text: string, queue?: QueueName): Promise<void>;
  abort(conversationId: string): Promise<void>;
  invalidate(conversationId: string): void;
}

type RuntimeEntry = {
  agent: Agent;
  signature: string;
  lastUsedAt: number;
};

export function createRuntimeRegistry(
  create: (route: EntryRoute) => Agent,
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

  const get = (route: EntryRoute): RuntimeEntry => {
    const id = route.conversation.id;
    const signature = runtimeSignature(route);
    const existing = entries.get(id);
    if (existing && existing.signature === signature) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (existing?.agent.state.isStreaming) return existing;
    const agent = create(route);
    logger.debug({ conversationId: id, runnerId: route.conversation.runnerId }, "created conversation runtime");
    onEvent(id, agent);
    const entry = { agent, signature, lastUsedAt: Date.now() };
    entries.set(id, entry);
    return entry;
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
    async send(route, text, queue) {
      const { agent } = get(route);
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
        .prompt(text)
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
  });
}
