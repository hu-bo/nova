import type { PluginDefinition } from "../../contracts/plugin.js";
import type { ToolDefinition, ToolPolicy } from "../../contracts/tool.js";
import {
  admission,
  checkpointPolicies,
  sessionDefinition,
  sessionStore,
  toolDefinitions,
  toolPolicies,
  toolRuntime,
} from "../../contracts/capabilities.js";
import { FrameworkError } from "../../contracts/errors.js";
import { positive } from "../../shared/json.js";
import { ToolExecutor } from "./runtime.js";
export { defineTool } from "./define-tool.js";
export { defineDynamicTool } from "./schema.js";
export type { JsonSchema, JsonSchemaType } from "./schema.js";
export function toolRuntimePlugin(
  config: {
    maxParallelReads?: number;
    maxParallelWrites?: number;
    maxOutputBytes?: number;
  } = {},
): PluginDefinition {
  const reads = positive(config.maxParallelReads ?? 4, "maxParallelReads");
  const writes = positive(config.maxParallelWrites ?? 1, "maxParallelWrites");
  const maxOutputBytes = positive(config.maxOutputBytes ?? 100_000, "maxOutputBytes");
  return {
    manifest: {
      id: "nnova.tools",
      version: "0.1.0",
      apiVersion: 1,
      scope: "session",
      requires: [admission, sessionDefinition, sessionStore],
      optional: [toolDefinitions, toolPolicies, checkpointPolicies],
      provides: [toolRuntime],
    },
    config,
    setup(context) {
      const definition = context.resolve(sessionDefinition);
      const catalog = new Map<string, ToolDefinition>();
      let policies: readonly ToolPolicy[] = [];
      const runtime = new ToolExecutor(
        definition,
        context.resolve(sessionStore),
        context.resolve(admission),
        catalog,
        () => policies,
        () => context.collect(checkpointPolicies),
        { reads, writes, maxOutputBytes },
      );
      context.onReady(() => {
        for (const tool of [...definition.tools, ...context.collect(toolDefinitions)]) {
          if (!/^[a-zA-Z][\w.-]*$/.test(tool.name) || catalog.has(tool.name))
            throw new FrameworkError("DUPLICATE_TOOL", "Invalid or duplicate tool name: " + tool.name);
          catalog.set(tool.name, tool);
        }
        for (const name of definition.allowedTools)
          if (!catalog.has(name)) throw new FrameworkError("UNKNOWN_TOOL", "Allowed tool is not registered: " + name);
        policies = context.collect(toolPolicies);
      });
      context.provide(toolRuntime, runtime);
    },
  };
}
