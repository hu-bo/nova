import { createHash } from "node:crypto";
import type { PluginDefinition } from "../../contracts/plugin.js";
import type { AgentMessage, JsonValue } from "../../contracts/message.js";
import type { ToolContext, ToolPolicy } from "../../contracts/tool.js";
import { contextContributions, sessionStore, toolPolicies } from "../../contracts/capabilities.js";
import { canonical } from "../../shared/json.js";

export interface RepeatedToolCallConfirmation {
  /** Stable approval scope for one signature within one assistant message. */
  readonly key: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly occurrences: number;
  readonly context: ToolContext;
}

export interface ToolLoopDetectionOptions {
  readonly confirm: (request: RepeatedToolCallConfirmation) => ReturnType<ToolPolicy["authorize"]>;
}

const THRESHOLD = 3;
const hash = (value: JsonValue) => createHash("sha256").update(canonical(value)).digest("hex");
const signature = (name: string, input: JsonValue) => hash([name, input]);

type ObservedCall = {
  signature: string;
  name: string;
  input: JsonValue;
  message: string | number;
  ordinal: number;
  occurrences: number;
};

class ToolLoopState {
  private processedMessages = 0;
  private readonly streaks = new Map<string, { output: string; count: number }>();
  private readonly pending = new Map<string, ObservedCall>();
  readonly calls = new Map<string, ObservedCall>();
  readonly warnings: string[] = [];

  update(messages: readonly AgentMessage[]) {
    if (messages.length < this.processedMessages) {
      this.processedMessages = 0;
      this.streaks.clear();
      this.pending.clear();
      this.calls.clear();
      this.warnings.length = 0;
    }
    // Session history is append-only. Hash only new facts, including after a cached store commit.
    for (let index = this.processedMessages; index < messages.length; index++) this.record(messages[index]!, index);
    this.processedMessages = messages.length;
  }

  private record(message: AgentMessage, index: number) {
    if (message.role === "user") {
      this.streaks.clear();
      this.pending.clear();
      this.calls.clear();
      this.warnings.length = 0;
      return;
    }
    if (message.role === "assistant") {
      this.warnings.length = 0;
      this.calls.clear();
      const calls = message.parts
        .filter((part) => part.type === "tool-call")
        .map((part) => ({ part, key: signature(part.name, part.input) }));
      const totals = new Map<string, number>();
      const ordinals = new Map<string, number>();
      for (const call of calls) totals.set(call.key, (totals.get(call.key) ?? 0) + 1);
      for (const { part, key } of calls) {
        const ordinal = (ordinals.get(key) ?? 0) + 1;
        ordinals.set(key, ordinal);
        const call: ObservedCall = {
          signature: key,
          name: part.name,
          input: part.input,
          message: message.id ?? index,
          ordinal,
          occurrences: totals.get(key) ?? ordinal,
        };
        this.calls.set(part.callId, call);
        this.pending.set(part.callId, call);
      }
    }
    for (const part of message.parts) {
      if (part.type !== "tool-result") continue;
      const call = this.pending.get(part.callId);
      if (!call || call.name !== part.name) continue;
      this.pending.delete(part.callId);
      if (part.status !== "succeeded") {
        this.streaks.delete(call.signature);
        continue;
      }
      const output = hash(part.value);
      const previous = this.streaks.get(call.signature);
      const count = previous?.output === output ? previous.count + 1 : 1;
      this.streaks.set(call.signature, { output, count });
      if (count === THRESHOLD && this.calls.get(part.callId) === call)
        this.warnings.push(
          `The ${call.name} tool with the same arguments has returned identical results ${THRESHOLD} times. It is not providing new information. Before another call, reassess your hypothesis and choose a different approach or explain what new information you expect. If this is intentional polling, continue only while waiting for a meaningful state change.`,
        );
    }
  }
}

/** Detection derives from authoritative history; the host owns approval and persistence. */
export function toolLoopDetectionPlugin(options: ToolLoopDetectionOptions): PluginDefinition {
  return {
    manifest: {
      id: "nnova.tool-loop-detection",
      version: "0.1.0",
      apiVersion: 1,
      scope: "session",
      requires: [sessionStore],
      provides: [],
      contributes: [toolPolicies, contextContributions],
    },
    setup(context) {
      const store = context.resolve(sessionStore);
      const state = new ToolLoopState();
      const refresh = async () => {
        const snapshot = store.peek?.() ?? (await store.load());
        state.update(snapshot.messages);
      };
      context.contribute(toolPolicies, {
        id: "nnova.tool-loop-detection",
        async authorize({ name, context: toolContext }) {
          toolContext.signal.throwIfAborted();
          await refresh();
          const call = state.calls.get(toolContext.callId);
          if (!call || call.name !== name || call.ordinal < THRESHOLD) return "allow";
          const authorization = await options.confirm({
            key: "tool-loop:" + hash([toolContext.runId, call.message, call.signature]),
            name: call.name,
            input: call.input,
            occurrences: call.occurrences,
            context: toolContext,
          });
          toolContext.signal.throwIfAborted();
          return authorization;
        },
      });
      context.contribute(contextContributions, {
        id: "nnova.tool-loop-detection",
        order: 100,
        async build(input) {
          input.signal.throwIfAborted();
          await refresh();
          const warnings = state.warnings;
          return warnings.length
            ? [{ role: "user", parts: [{ type: "text", text: "[Tool repetition warning]\n" + warnings.join("\n\n") }] }]
            : [];
        },
      });
    },
  };
}
