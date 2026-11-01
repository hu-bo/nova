import type { PluginDefinition } from "../../contracts/plugin.js";
import {
  agentExecutor,
  checkpointPolicies,
  contextBuilder,
  contextCompactor,
  modelRouter,
  sessionDefinition,
  sessionStore,
  toolRuntime,
} from "../../contracts/capabilities.js";
import { positive } from "../../shared/json.js";
import { BasicLoop } from "./loop.js";
export function basicLoopPlugin(
  config: { maxSteps?: number; maxToolCalls?: number; maxLengthContinuations?: number } = {},
): PluginDefinition {
  const maxSteps = positive(config.maxSteps ?? 12, "maxSteps");
  const maxToolCalls = positive(config.maxToolCalls ?? 24, "maxToolCalls");
  const maxLengthContinuations = positive(config.maxLengthContinuations ?? 2, "maxLengthContinuations");
  return {
    manifest: {
      id: "nnova.basic-loop",
      version: "0.1.0",
      apiVersion: 1,
      scope: "session",
      requires: [sessionDefinition, modelRouter, sessionStore, contextBuilder, toolRuntime],
      optional: [contextCompactor, checkpointPolicies],
      provides: [agentExecutor],
    },
    config,
    setup(context) {
      context.provide(
        agentExecutor,
        new BasicLoop(
          context.resolve(sessionDefinition),
          context.resolve(sessionStore),
          context.resolve(contextBuilder),
          context.resolve(modelRouter),
          context.resolve(toolRuntime),
          () => context.optional(contextCompactor),
          () => context.collect(checkpointPolicies),
          { maxSteps, maxToolCalls, maxLengthContinuations },
        ),
      );
    },
  };
}
