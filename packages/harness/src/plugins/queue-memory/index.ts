import type { PluginDefinition } from "../../contracts/plugin.js";
import type { QueueItem } from "../../contracts/queue.js";
import { taskQueue } from "../../contracts/capabilities.js";
import { FrameworkError } from "../../contracts/errors.js";
import { positive } from "../../shared/json.js";
export function memoryTaskQueuePlugin(config: { maxPending: number; agingMs?: number }): PluginDefinition {
  positive(config.maxPending, "maxPending");
  const agingMs = positive(config.agingMs ?? 1_000, "agingMs");
  return {
    manifest: {
      id: "nnova.queue-memory",
      version: "0.1.0",
      apiVersion: 1,
      scope: "kernel",
      requires: [],
      provides: [taskQueue],
    },
    config,
    setup(context) {
      const items = new Map<string, QueueItem>();
      context.provide(taskQueue, {
        maxPending: config.maxPending,
        put(item) {
          if (!items.has(item.taskId) && items.size >= config.maxPending)
            throw new FrameworkError("QUEUE_FULL", "Pending queue capacity reached.");
          items.set(item.taskId, Object.freeze({ ...item }));
        },
        remove(id) {
          items.delete(id);
        },
        candidates(now) {
          const score = (item: QueueItem) => item.priority + Math.floor((now - item.acceptedAt) / agingMs);
          return [...items.values()]
            .filter((item) => item.readyAt <= now)
            .sort((a, b) => score(b) - score(a) || a.sequence - b.sequence);
        },
        nextReadyAt(now) {
          let next: number | undefined;
          for (const item of items.values())
            if (item.readyAt > now && (next === undefined || item.readyAt < next)) next = item.readyAt;
          return next;
        },
        clear() {
          items.clear();
        },
      });
      context.onDispose(() => {
        items.clear();
      });
    },
  };
}
