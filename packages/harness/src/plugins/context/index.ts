import type { PluginDefinition } from "../../contracts/plugin.js";
import type { AgentMessage } from "../../contracts/message.js";
import type { ContextContribution } from "../../contracts/context.js";
import { sessionDefinition, sessionStore, contextBuilder, contextContributions } from "../../contracts/capabilities.js";
import { FrameworkError } from "../../contracts/errors.js";
export function contextPlugin(): PluginDefinition {
  return {
    manifest: {
      id: "nnova.context",
      version: "0.1.0",
      apiVersion: 1,
      scope: "session",
      requires: [sessionDefinition, sessionStore],
      optional: [contextContributions],
      provides: [contextBuilder],
    },
    setup(context) {
      const definition = context.resolve(sessionDefinition);
      const store = context.resolve(sessionStore);
      let contributions: readonly ContextContribution[] = [];
      context.onReady(() => {
        contributions = [...context.collect(contextContributions)].sort(
          (left, right) => left.order - right.order || left.id.localeCompare(right.id),
        );
        if (new Set(contributions.map((item) => item.id)).size !== contributions.length)
          throw new FrameworkError("DUPLICATE_CONTRIBUTION", "Duplicate context contribution.");
      });
      context.provide(contextBuilder, {
        async build(input) {
          input.signal.throwIfAborted();
          const additions: AgentMessage[] = [];
          for (const contribution of contributions) additions.push(...(await contribution.build(input)));
          const snapshot = await store.load();
          const messages: AgentMessage[] = [
            {
              role: "system",
              parts: [{ type: "text", text: definition.systemPrompt }],
            },
          ];
          if (snapshot.summary)
            messages.push({
              role: "system",
              parts: [
                {
                  type: "text",
                  text: "Lossy conversation summary:\n" + snapshot.summary.text,
                },
              ],
            });
          messages.push(...snapshot.messages.slice(snapshot.summary?.throughMessage ?? 0));
          {
            if (
              additions.some(
                (message) =>
                  message.role === "system" ||
                  message.parts.some((part) => part.type === "tool-call" || part.type === "tool-result"),
              )
            )
              throw new FrameworkError("INVALID_CONTEXT", "External context cannot replace policy or tool history.");
            messages.push(...structuredClone(additions));
          }
          const pending = new Set<string>();
          for (const message of messages)
            for (const part of message.parts) {
              if (part.type === "tool-call") {
                if (pending.has(part.callId))
                  throw new FrameworkError("INVALID_HISTORY", "Duplicate pending tool call.");
                pending.add(part.callId);
              }
              if (part.type === "tool-result" && !pending.delete(part.callId))
                throw new FrameworkError("INVALID_HISTORY", "Tool result has no matching call.");
            }
          if (pending.size) throw new FrameworkError("INVALID_HISTORY", "Tool history contains pending calls.");
          if (input.route) {
            const estimate = Math.ceil((JSON.stringify(messages).length + input.toolSchemaCharacters) / 2);
            if (estimate + input.route.maxOutputTokens + 256 > input.route.contextWindow)
              throw new FrameworkError("CONTEXT_LIMIT", "Context exceeds the configured model window.");
          }
          return messages;
        },
      });
    },
  };
}
