import { createAgentKernel } from "../../src/index.js";
import type { PluginDefinition } from "../../src/index.js";
import { basicLoopPlugin } from "../../src/plugins/basic-loop/index.js";
import { contextPlugin } from "../../src/plugins/context/index.js";
import { memorySessionPlugin } from "../../src/plugins/session-memory/index.js";
import { toolRuntimePlugin } from "../../src/plugins/tools/index.js";
import { memoryTaskQueuePlugin } from "../../src/plugins/queue-memory/index.js";
import { memoryTaskStorePlugin } from "../../src/plugins/task-store-memory/index.js";
import { taskEnginePlugin } from "../../src/plugins/task-engine/index.js";
import { agentTaskPlugin } from "../../src/plugins/agent-task/index.js";
import type { ScriptedModel } from "./scripted-model.js";

/** 真实生产入口；禁止在这个 fixture 中实现测试专用 Agent/队列。 */
export function createCodingKernel(
  model: ScriptedModel,
  extra: readonly PluginDefinition[] = [],
) {
  return createAgentKernel({
    maxConcurrentRuns: 2,
    configure: async (ctx) => {
      await ctx.plugin(memorySessionPlugin());
      await ctx.plugin(model.plugin);
      await ctx.plugin(contextPlugin());
      await ctx.plugin(
        toolRuntimePlugin({ maxParallelReads: 2, maxParallelWrites: 1 }),
      );
      await ctx.plugin(basicLoopPlugin({ maxSteps: 12, maxToolCalls: 12 }));
      await ctx.plugin(
        memoryTaskStorePlugin({ maxTasks: 100, completedTtlMs: 60_000 }),
      );
      await ctx.plugin(memoryTaskQueuePlugin({ maxPending: 20 }));
      await ctx.plugin(
        taskEnginePlugin({
          maxConcurrentTasks: 2,
          maxConcurrentPerKey: 1,
          maxNodesPerFlow: 10,
        }),
      );
      await ctx.plugin(agentTaskPlugin());
      for (const plugin of extra) await ctx.plugin(plugin);
    },
  });
}
