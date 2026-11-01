import type { PluginDefinition } from "../../contracts/plugin.js";
import {
  applySessionCommit,
  type SessionCommit,
  type SessionSnapshot,
  type SessionStore,
} from "../../contracts/session.js";
import { sessionStore } from "../../contracts/capabilities.js";
import { FrameworkError } from "../../contracts/errors.js";
import { positive } from "../../shared/json.js";
export function memorySessionPlugin(
  config: {
    maxMessages?: number;
    maxBytes?: number;
    maxExecutions?: number;
    initialSnapshot?: SessionSnapshot;
    /** In-memory observations only; durable stores implement SessionStore directly. */
    onCommit?: (snapshot: SessionSnapshot) => void;
  } = {},
): PluginDefinition {
  const maxMessages = positive(config.maxMessages ?? 10_000, "maxMessages");
  const maxBytes = positive(config.maxBytes ?? 8_000_000, "maxBytes");
  const maxExecutions = positive(config.maxExecutions ?? 10_000, "maxExecutions");
  return {
    manifest: {
      id: "nnova.session-memory",
      version: "0.1.0",
      apiVersion: 1,
      scope: "session",
      requires: [],
      provides: [sessionStore],
    },
    config,
    setup(context) {
      const emptySnapshot: SessionSnapshot = {
        revision: 0,
        messages: [],
        runs: [],
        executions: [],
      };
      let state = structuredClone(config.initialSnapshot ?? emptySnapshot);
      if (!Number.isSafeInteger(state.revision) || state.revision < 0)
        throw new FrameworkError("SESSION_CORRUPT", "Initial session snapshot revision is invalid.");
      const store: SessionStore = {
        async load() {
          return structuredClone(state);
        },
        async commit(batch: SessionCommit, expectedRevision: number) {
          if (expectedRevision !== state.revision)
            throw new FrameworkError("REVISION_CONFLICT", "Session revision changed.");
          const next = applySessionCommit(state, batch);
          if (
            next.messages.length > maxMessages ||
            next.executions.length > maxExecutions ||
            Buffer.byteLength(JSON.stringify(next)) > maxBytes
          )
            throw new FrameworkError("SESSION_LIMIT", "Session storage capacity exceeded.");
          config.onCommit?.(structuredClone(next));
          state = next;
          return structuredClone(state);
        },
      };
      context.provide(sessionStore, store);
      context.onDispose(() => {
        state = structuredClone(emptySnapshot);
      });
    },
  };
}
