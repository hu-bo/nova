import type { PluginDefinition } from "../contracts/plugin.js";

export function definePlugin<Options = unknown>(definition: PluginDefinition<Options>): PluginDefinition<Options> {
  return { ...definition, manifest: structuredClone(definition.manifest) };
}
