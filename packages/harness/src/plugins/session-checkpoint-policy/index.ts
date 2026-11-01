import type { PluginDefinition } from "../../contracts/plugin.js";
import { checkpointPolicies, sessionPersistence } from "../../contracts/capabilities.js";

/** Timing policy only; buffers and durable state belong to the persistence plugin. */
export function sessionCheckpointPolicyPlugin(): PluginDefinition {
  return {
    manifest: {
      id: "nnova.session-checkpoint-policy",
      version: "0.1.0",
      apiVersion: 1,
      scope: "session",
      requires: [sessionPersistence],
      provides: [],
      contributes: [checkpointPolicies],
    },
    setup(context) {
      const persistence = context.resolve(sessionPersistence);
      context.contribute(checkpointPolicies, {
        id: "session-checkpoint-policy",
        before: () => persistence.flush(),
      });
    },
  };
}
