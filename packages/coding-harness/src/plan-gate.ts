import {
  sessionDefinition,
  toolDefinitions,
  toolPolicies,
  type PluginDefinition,
  type ToolDefinition,
} from "@nnova/harness";
import type { ToolContext } from "@nova/runner-sdk";
import { relativePath } from "./configuration.js";

/** One instance per Coding Harness session. Only a confirmed Runner write changes state. */
export class PlanGate {
  private written: boolean;

  constructor(
    private readonly path: string,
    alreadyWritten: boolean,
  ) {
    this.written = alreadyWritten;
  }

  plugin(): PluginDefinition {
    return {
      manifest: {
        id: "nova.coding-harness.plan-gate",
        version: "0.1.0",
        apiVersion: 1,
        scope: "session",
        requires: [sessionDefinition],
        optional: [toolDefinitions],
        contributes: [toolPolicies],
        provides: [],
      },
      setup: (context) => {
        const tools = new Map<string, ToolDefinition>();
        context.onReady(() => {
          for (const tool of [...context.resolve(sessionDefinition).tools, ...context.collect(toolDefinitions)]) {
            tools.set(tool.name, tool);
          }
        });
        context.contribute(toolPolicies, {
          id: "nova.coding-harness.plan-first",
          authorize: async ({ name, input }) => {
            if (this.written) return "allow";
            if (tools.get(name)?.effects === "read") return "allow";
            if (
              name === "write_file" &&
              input !== null &&
              typeof input === "object" &&
              !Array.isArray(input) &&
              typeof input.path === "string" &&
              relativePath(input.path) === this.path
            ) {
              return "allow";
            }
            return "deny";
          },
        });
      },
    };
  }

  observe(context: ToolContext): ToolContext {
    const fs = context.fs;
    // SDK implementations may use prototype methods; spreading fs silently drops those methods.
    return {
      cwd: context.cwd,
      signal: context.signal,
      exec: context.exec.bind(context),
      fs: {
        read: fs.read.bind(fs),
        readBytes: fs.readBytes.bind(fs),
        list: fs.list.bind(fs),
        grep: fs.grep.bind(fs),
        patch: fs.patch.bind(fs),
        write: async (path, content, options) => {
          const result = await fs.write(path, content, options);
          if (result.ok && relativePath(path) === this.path) this.written = true;
          return result;
        },
      },
    };
  }
}
