import type { PluginDefinition } from "../../contracts/plugin.js";
import type { ToolContext, ToolDefinition } from "../../contracts/tool.js";
import { toolDefinitions } from "../../contracts/capabilities.js";
import { FrameworkError } from "../../contracts/errors.js";
import { defineDynamicTool, type JsonSchema } from "../../shared/dynamic-tool.js";

export interface McpToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly effects?: ToolDefinition["effects"];
}

export interface McpToolClient {
  listTools(signal: AbortSignal): Promise<readonly McpToolDescription[]>;
  call(
    name: string,
    input: import("../../contracts/message.js").JsonValue,
    context: ToolContext,
  ): Promise<import("../../contracts/message.js").JsonValue>;
  close?(): void | Promise<void>;
}

export interface McpPluginConfig {
  readonly client: McpToolClient;
  readonly closeOnDispose?: boolean;
}

/** Bridges an MCP-like client into the normal session tool catalog. */
export function mcpPlugin(config: McpPluginConfig): PluginDefinition<McpPluginConfig> {
  return {
    manifest: {
      id: "nnova.mcp-tools",
      version: "0.1.0",
      apiVersion: 1,
      scope: "session",
      requires: [],
      provides: [],
      contributes: [toolDefinitions],
    },
    config,
    async setup(context) {
      if (config.closeOnDispose && config.client.close) context.onDispose(() => config.client.close?.());
      let descriptions: readonly McpToolDescription[];
      try {
        descriptions = await config.client.listTools(context.signal);
      } catch (error) {
        if (context.signal.aborted) throw error;
        throw new FrameworkError("MCP_SETUP_FAILED", "MCP tool discovery failed.");
      }
      if (!(descriptions instanceof Array))
        throw new FrameworkError("MCP_SETUP_FAILED", "MCP tool discovery returned an invalid catalog.");
      const names = new Set<string>();
      for (const description of descriptions) {
        if (
          !description ||
          typeof description !== "object" ||
          typeof description.name !== "string" ||
          typeof description.description !== "string" ||
          !description.description.trim() ||
          !description.inputSchema ||
          (description.effects !== undefined && !["read", "write", "external-job"].includes(description.effects))
        )
          throw new FrameworkError("MCP_SETUP_FAILED", "MCP tool discovery returned an invalid tool.");
        if (names.has(description.name)) throw new FrameworkError("DUPLICATE_TOOL", "Duplicate MCP tool.");
        names.add(description.name);
        const inputSchema = structuredClone(description.inputSchema);
        const outputSchema = description.outputSchema ? structuredClone(description.outputSchema) : undefined;
        context.contribute(
          toolDefinitions,
          defineDynamicTool({
            name: description.name,
            description: description.description,
            inputSchema,
            ...(outputSchema ? { outputSchema } : {}),
            effects: description.effects ?? "read",
            execute: (input, toolContext) => config.client.call(description.name, input, toolContext),
          }),
        );
      }
    },
  };
}

export const mcpToolsPlugin = mcpPlugin;
export type { JsonSchema } from "../../shared/dynamic-tool.js";
