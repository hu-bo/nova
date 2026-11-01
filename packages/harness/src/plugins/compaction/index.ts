import type { PluginDefinition } from "../../contracts/plugin.js";
import type { ContextCompactor } from "../../contracts/context.js";
import type { AgentMessage, MessagePart } from "../../contracts/message.js";
import { contextCompactor, sessionDefinition, sessionStore } from "../../contracts/capabilities.js";
import { FrameworkError } from "../../contracts/errors.js";
import { positive } from "../../shared/json.js";

export interface CompactionConfig {
  thresholdRatio?: number;
  keepRecentMessages?: number;
  maxSummaryCharacters?: number;
}

function messageText(message: AgentMessage): string {
  return message.parts
    .map((part: MessagePart) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "source":
          return `[source:${part.id}] ${part.uri}`;
        case "image":
        case "file":
          return `[attachment:${part.reference.id}]`;
        case "tool-call":
          return `[tool-call:${part.name}] ${JSON.stringify(part.input)}`;
        case "tool-result":
          return `[tool-result:${part.name}:${part.status}] ${JSON.stringify(part.value)}`;
      }
    })
    .join(" ");
}

function boundedSummary(messages: readonly AgentMessage[], maxCharacters: number): string {
  const lines = messages.map((message) => `${message.role}: ${messageText(message)}`);
  const summary = lines.join("\n");
  if (summary.length <= maxCharacters) return summary;
  return summary.slice(0, Math.max(0, maxCharacters - 1)) + "…";
}

function completeBoundary(messages: readonly AgentMessage[], target: number): number {
  const pending = new Set<string>();
  for (let index = 0; index < target; index++) {
    for (const part of messages[index]?.parts ?? []) {
      if (part.type === "tool-call") pending.add(part.callId);
      if (part.type === "tool-result") pending.delete(part.callId);
    }
  }
  if (!pending.size) return target;
  let boundary = target;
  for (let index = 0; index < target; index++)
    if (messages[index]?.parts.some((part) => part.type === "tool-call" && pending.has(part.callId)))
      boundary = Math.min(boundary, index);
  return boundary;
}

/**
 * A deterministic in-memory compactor. It deliberately summarizes only
 * complete message prefixes and commits the projection with the current
 * revision, so a failed or concurrent compaction cannot damage history.
 */
export function summaryCompactionPlugin(config: CompactionConfig = {}): PluginDefinition<CompactionConfig> {
  const thresholdRatio = config.thresholdRatio ?? 0.8;
  const keepRecentMessages = positive(config.keepRecentMessages ?? 6, "keepRecentMessages");
  const maxSummaryCharacters = positive(config.maxSummaryCharacters ?? 20_000, "maxSummaryCharacters");
  if (!Number.isFinite(thresholdRatio) || thresholdRatio <= 0 || thresholdRatio > 1)
    throw new FrameworkError("INVALID_CONFIG", "thresholdRatio must be greater than 0 and no greater than 1.");

  const options = {
    thresholdRatio,
    keepRecentMessages,
    maxSummaryCharacters,
  };
  return {
    manifest: {
      id: "nnova.compaction-summary",
      version: "0.1.0",
      apiVersion: 1,
      scope: "session",
      requires: [sessionDefinition, sessionStore],
      provides: [contextCompactor],
    },
    config: options,
    setup(context) {
      const store = context.resolve(sessionStore);
      const compactor: ContextCompactor = {
        async compact(input) {
          input.signal.throwIfAborted();
          const snapshot = await store.load();
          const requestedBoundary = snapshot.messages.length - keepRecentMessages;
          if (
            input.route &&
            Math.ceil(JSON.stringify(snapshot.messages).length / 2) < input.route.contextWindow * thresholdRatio
          )
            return false;
          const compactThrough = completeBoundary(snapshot.messages, requestedBoundary);
          if (compactThrough < 2) return false;
          const existingThrough = snapshot.summary?.throughMessage ?? 0;
          if (compactThrough <= existingThrough) return false;

          const selected = snapshot.messages.slice(existingThrough, compactThrough);
          if (!selected.length) return false;
          const previous = snapshot.summary?.text;
          const current = boundedSummary(selected, maxSummaryCharacters);
          const text = previous ? `${previous}\n${current}`.slice(0, maxSummaryCharacters) : current;
          if (!text) return false;
          input.signal.throwIfAborted();
          try {
            await store.commit(
              {
                summary: { text, throughMessage: compactThrough },
              },
              snapshot.revision,
            );
          } catch (error) {
            if (error instanceof FrameworkError && error.code === "REVISION_CONFLICT") throw error;
            throw error;
          }
          return true;
        },
      };
      context.provide(contextCompactor, compactor);
    },
  };
}
