import type { PluginDefinition } from "../../contracts/plugin.js";
import type { TaskSnapshot } from "../../contracts/task.js";
import { taskStore } from "../../contracts/capabilities.js";
import { FrameworkError } from "../../contracts/errors.js";
import { positive } from "../../shared/json.js";
export function memoryTaskStorePlugin(config: { maxTasks: number; completedTtlMs: number }): PluginDefinition {
  positive(config.maxTasks, "maxTasks");
  positive(config.completedTtlMs, "completedTtlMs");
  return {
    manifest: {
      id: "nnova.task-store-memory",
      version: "0.1.0",
      apiVersion: 1,
      scope: "kernel",
      requires: [],
      provides: [taskStore],
    },
    config,
    setup(context) {
      const tasks = new Map<string, TaskSnapshot>();
      const pins = new Map<string, number>();
      context.provide(taskStore, {
        maxTasks: config.maxTasks,
        prune(now) {
          for (const [id, task] of tasks)
            if (task.finishedAt !== undefined && task.finishedAt + config.completedTtlMs <= now && !pins.has(id))
              tasks.delete(id);
        },
        list: () => structuredClone([...tasks.values()]),
        get: (id) => {
          const item = tasks.get(id);
          return item ? structuredClone(item) : undefined;
        },
        set(snapshot) {
          if (!tasks.has(snapshot.taskId) && tasks.size >= config.maxTasks)
            throw new FrameworkError("TASK_STORE_FULL", "Task store capacity reached.");
          tasks.set(snapshot.taskId, structuredClone(snapshot));
        },
        delete(id) {
          if (pins.has(id)) throw new FrameworkError("TASK_RETAINED", "Task is retained by a dependent.");
          tasks.delete(id);
        },
        retain(id) {
          if (!tasks.has(id)) throw new FrameworkError("UNKNOWN_TASK", "Cannot retain unknown Task.");
          pins.set(id, (pins.get(id) ?? 0) + 1);
          let released = false;
          return () => {
            if (released) return;
            released = true;
            const count = (pins.get(id) ?? 1) - 1;
            if (count) pins.set(id, count);
            else pins.delete(id);
          };
        },
      });
      context.onDispose(() => {
        tasks.clear();
        pins.clear();
      });
    },
  };
}
