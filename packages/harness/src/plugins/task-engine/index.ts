import type { PluginDefinition } from "../../contracts/plugin.js";
import {
  admission,
  diagnostics,
  taskEngine,
  taskHandlers,
  taskQueue,
  taskStore,
} from "../../contracts/capabilities.js";
import { FrameworkError } from "../../contracts/errors.js";
import { positive } from "../../shared/json.js";
import { TaskRuntime } from "./scheduler.js";
import type { FlowPredicate } from "../../contracts/flow.js";
export function taskEnginePlugin(config: {
  maxConcurrentTasks: number;
  maxConcurrentPerKey: number;
  maxNodesPerFlow: number;
  maxDepth?: number;
  retry?: { baseDelayMs?: number; maxDelayMs?: number; jitter?: boolean };
  resources?: Readonly<Record<string, number>>;
  predicates?: Readonly<Record<string, FlowPredicate>>;
}): PluginDefinition {
  const options = {
    maxConcurrentTasks: positive(config.maxConcurrentTasks, "maxConcurrentTasks"),
    maxConcurrentPerKey: positive(config.maxConcurrentPerKey, "maxConcurrentPerKey"),
    maxNodesPerFlow: positive(config.maxNodesPerFlow, "maxNodesPerFlow"),
    maxDepth: positive(config.maxDepth ?? 4, "maxDepth"),
    retryBaseMs: positive(config.retry?.baseDelayMs ?? 50, "retry.baseDelayMs"),
    retryMaxMs: positive(config.retry?.maxDelayMs ?? 10_000, "retry.maxDelayMs"),
    retryJitter: config.retry?.jitter ?? false,
    resources: config.resources ?? {},
    predicates: config.predicates,
  };
  for (const [name, limit] of Object.entries(options.resources)) positive(limit, "resources." + name);
  if (options.predicates) {
    for (const [name, predicate] of Object.entries(options.predicates))
      if (!name || typeof predicate !== "function")
        throw new FrameworkError("INVALID_CONFIG", "Invalid Flow predicate configuration.");
  }
  return {
    manifest: {
      id: "nnova.task-engine",
      version: "0.1.0",
      apiVersion: 1,
      scope: "kernel",
      requires: [admission, taskQueue, taskStore, diagnostics],
      optional: [taskHandlers],
      provides: [taskEngine],
    },
    config,
    setup(context) {
      const runtime = new TaskRuntime(
        context.resolve(taskStore),
        context.resolve(taskQueue),
        context.resolve(admission),
        options,
        context.resolve(diagnostics),
      );
      context.provide(taskEngine, runtime);
      context.onReady(() => runtime.register(context.collect(taskHandlers)));
      context.signal.addEventListener(
        "abort",
        () => {
          for (const task of context.resolve(taskStore).list()) runtime.cancel(task.taskId);
        },
        { once: true },
      );
      context.onDispose(() => runtime.dispose());
    },
  };
}
