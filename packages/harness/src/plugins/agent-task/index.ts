import { z } from "zod";
import type { PluginDefinition } from "../../contracts/plugin.js";
import { agentAccess, taskEngine, taskHandlers } from "../../contracts/capabilities.js";
import { FrameworkError } from "../../contracts/errors.js";
import { jsonValue } from "../../shared/json.js";
const inputSchema = z
  .object({
    namespace: z.string().min(1).optional(),
    sessionId: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();
export function agentTaskPlugin(): PluginDefinition {
  return {
    manifest: {
      id: "nnova.agent-task",
      version: "0.1.0",
      apiVersion: 1,
      scope: "kernel",
      requires: [agentAccess, taskEngine],
      provides: [],
      contributes: [taskHandlers],
    },
    setup(context) {
      const agents = context.resolve(agentAccess);
      context.contribute(taskHandlers, {
        kind: "agent.send",
        version: 1,
        protocol: "outcome",
        inputSchema,
        claims(value) {
          const input = inputSchema.parse(value);
          return agents.claims({
            namespace: input.namespace ?? "local",
            sessionId: input.sessionId,
          });
        },
        async execute(value, task) {
          const input = inputSchema.parse(value);
          const waitId = task.createWait({ expiresAt: task.deadlineAt });
          const result = await agents.start(
            {
              namespace: input.namespace ?? task.namespace,
              sessionId: input.sessionId,
            },
            {
              text: input.text,
              signal: task.signal,
              timeoutMs: Math.max(1, task.deadlineAt - Date.now()),
            },
            task.lease,
          );
          if (result.kind === "suspended")
            return {
              kind: "waiting" as const,
              waitId,
              state: {
                namespace: input.namespace ?? task.namespace,
                sessionId: input.sessionId,
                runId: result.runId,
                continuationId: result.continuationId,
              },
              expiresAt: task.deadlineAt,
            };
          if (result.status !== "succeeded") {
            if (result.status === "cancelled" || result.status === "timed_out") task.signal.throwIfAborted();
            throw new FrameworkError(
              result.error?.code ?? "AGENT_FAILED",
              result.error?.message ?? "Agent run did not complete successfully.",
            );
          }
          return { kind: "completed" as const, output: jsonValue(result) };
        },
        async resume(state, signal, task) {
          const saved = z
            .object({
              namespace: z.string().min(1),
              sessionId: z.string().min(1),
              runId: z.string().min(1),
              continuationId: z.string().min(1),
            })
            .strict()
            .parse(state);
          const result = await agents.resume?.(
            {
              namespace: saved.namespace,
              sessionId: saved.sessionId,
            },
            {
              runId: saved.runId,
              continuationId: saved.continuationId,
              input: jsonValue(signal.payload),
              signal: task.signal,
              timeoutMs: Math.max(1, task.deadlineAt - Date.now()),
            },
            task.lease,
          );
          if (!result) throw new FrameworkError("CAPABILITY_UNAVAILABLE", "Agent continuation resume is unavailable.");
          if (result.kind === "suspended")
            return {
              kind: "waiting" as const,
              waitId: task.createWait({ expiresAt: task.deadlineAt }),
              state: {
                namespace: saved.namespace,
                sessionId: saved.sessionId,
                runId: result.runId,
                continuationId: result.continuationId,
              },
              expiresAt: task.deadlineAt,
            };
          if (result.status !== "succeeded")
            throw new FrameworkError(
              result.error?.code ?? "AGENT_FAILED",
              result.error?.message ?? "Agent run did not complete successfully.",
            );
          return { kind: "completed" as const, output: jsonValue(result) };
        },
        cancel(value, namespace) {
          const input = inputSchema.parse(value);
          agents.cancel({
            namespace: input.namespace ?? namespace ?? "local",
            sessionId: input.sessionId,
          });
        },
      });
    },
  };
}
