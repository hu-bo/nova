import type { ToolContext as HarnessToolContext, ToolDefinition } from "@nnova/harness";
import type { ToolContext } from "@nova/runner-sdk";
import { remoteToolDefinitions, withRemoteContextResolver, type RemoteToolContextFactory } from "./tools.js";

export interface CreateRemoteToolsOptions {
  readonly createContext: RemoteToolContextFactory;
}

/** Bind SDK contexts lazily, once per Harness tool call. No Runner connection is created here. */
export function createRemoteTools(options: CreateRemoteToolsOptions): readonly ToolDefinition[] {
  const resolver: RemoteToolContextFactory = async (context) => options.createContext(context);
  return remoteToolDefinitions.map((definition): ToolDefinition => ({
    ...definition,
    prepare(input) {
      const prepared = definition.prepare(input);
      return {
        input: prepared.input,
        execute(context: HarnessToolContext) {
          return withRemoteContextResolver(resolver, () => prepared.execute(context));
        },
      };
    },
    execute(input: unknown, context: HarnessToolContext) {
      return withRemoteContextResolver(resolver, () => definition.execute(input, context));
    },
  }));
}

export type { ToolContext };
