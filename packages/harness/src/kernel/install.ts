import type { PluginDefinition, ScopeKind } from "../contracts/plugin.js";
import { FrameworkError } from "../contracts/errors.js";
import { Registry } from "./registry.js";
import { Scope } from "./scope.js";
import { Context } from "./context.js";
export async function install(
  plugins: readonly PluginDefinition[],
  kind: ScopeKind,
  scope: Scope,
  registry: Registry,
): Promise<void> {
  const context = new Context(kind, { scope, registry });
  try {
    await context.install(plugins);
  } catch (error) {
    try {
      await context.dispose();
    } catch (cleanupError) {
      void cleanupError;
      throw new FrameworkError("SETUP_ROLLBACK_FAILED", "Plugin setup and resource rollback failed.");
    }
    throw error;
  }
}
