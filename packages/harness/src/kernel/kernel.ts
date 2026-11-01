import type { AgentDefinition, AgentKernel, KernelConfig, SessionDefinition } from "../contracts/agent.js";
import type { JsonValue } from "../contracts/message.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ScopeKind } from "../contracts/plugin.js";
import {
  admission,
  agentAccess,
  sessionDefinition,
  taskEngine,
  modelRouter,
  diagnostics,
  agentExecutor,
} from "../contracts/capabilities.js";
import { FrameworkError, safeError } from "../contracts/errors.js";
import { positive, jsonValue } from "../shared/json.js";
import { Context } from "./context.js";
import { ResourceAdmission } from "./admission.js";
import { SessionHandle } from "./operation.js";
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || value instanceof Array) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isPlainRecord(value: unknown): value is { [key: string]: JsonValue } {
  return isObjectRecord(value);
}
function isToolList(value: unknown): value is readonly ToolDefinition[] {
  return (
    value instanceof Array &&
    value.every(
      (item: unknown) =>
        isObjectRecord(item) &&
        typeof item.name === "string" &&
        typeof item.description === "string" &&
        typeof item.prepare === "function" &&
        typeof item.execute === "function",
    )
  );
}
function isStringList(value: unknown): value is readonly string[] {
  return value instanceof Array && value.every((item: unknown) => typeof item === "string");
}
export async function createAgentKernel(config: KernelConfig): Promise<AgentKernel> {
  positive(config.maxConcurrentRuns, "maxConcurrentRuns");
  const maxSessions = positive(config.maxSessions ?? 1_000, "maxSessions");
  const timeout = positive(config.defaultTimeoutMs ?? 60_000, "defaultTimeoutMs");
  const builtins = new Map<string, ScopeKind>([
    [admission.id, "kernel"],
    [agentAccess.id, "kernel"],
    [diagnostics.id, "kernel"],
    [sessionDefinition.id, "session"],
  ]);
  const context = new Context("kernel", { builtins });
  const resources = new ResourceAdmission();
  const sessions = new Map<string, SessionHandle>();
  const creating = new Set<string>();
  let closing: Promise<void> | undefined;
  const sessionKey = (namespace: string, sessionId: string) => JSON.stringify([namespace, sessionId]);
  const lookup = (reference: { namespace: string; sessionId: string }) => {
    const session = sessions.get(sessionKey(reference.namespace, reference.sessionId));
    if (!session) throw new FrameworkError("UNKNOWN_SESSION", "Session is not active.");
    return session;
  };
  context.provide(admission, resources);
  context.provide(diagnostics, (error) => {
    if (config.onDiagnostic) {
      try {
        config.onDiagnostic(error);
      } catch {
        process.emitWarning("Diagnostic callback failed.", {
          code: "DIAGNOSTIC_FAILED",
        });
      }
    } else process.emitWarning(error.message, { code: error.code });
  });
  context.provide(agentAccess, {
    claims: (reference) => lookup(reference).claims(),
    start: (reference, options, lease) => lookup(reference).sendWithLease(options, lease),
    resume: (reference, options, lease) => lookup(reference).resumeWithLease(options, lease),
    cancel: (reference) => lookup(reference).cancel(),
  });
  if (config.configure && config.plugins)
    throw new FrameworkError("INVALID_CONFIG", "Choose configure or plugins, not both.");
  try {
    if (config.configure) {
      await config.configure(context);
      await context.ready();
    } else await context.install(config.plugins ?? []);
  } catch (error) {
    try {
      await context.dispose();
    } catch {
      throw new FrameworkError("SETUP_ROLLBACK_FAILED", "Plugin setup and resource rollback failed.");
    }
    throw error;
  }
  return {
    get tasks() {
      if (closing) throw new FrameworkError("CLOSED", "Kernel is closing.");
      return context.resolve(taskEngine);
    },
    async createAgent(options: AgentDefinition) {
      if (closing) throw new FrameworkError("CLOSED", "Kernel is closing.");
      if (
        !options ||
        typeof options !== "object" ||
        Array.isArray(options) ||
        typeof options.sessionId !== "string" ||
        !options.sessionId ||
        options.sessionId.length > 512 ||
        typeof options.systemPrompt !== "string" ||
        options.systemPrompt.length > 1_000_000 ||
        !isToolList(options.tools) ||
        !isStringList(options.allowedTools) ||
        options.allowedTools.some((name) => !name || name.length > 256) ||
        new Set(options.allowedTools).size !== options.allowedTools.length
      )
        throw new FrameworkError("INVALID_INPUT", "Invalid Agent definition.");
      const namespace = options.namespace ?? "local";
      if (typeof namespace !== "string" || !namespace || namespace.length > 512)
        throw new FrameworkError("INVALID_INPUT", "Invalid namespace.");
      const identity = jsonValue(options.identity ?? {});
      if (!isPlainRecord(identity)) throw new FrameworkError("INVALID_INPUT", "Invalid Agent identity.");
      if (options.model !== undefined && (typeof options.model !== "string" || !options.model))
        throw new FrameworkError("INVALID_INPUT", "Invalid model ID.");
      const key = sessionKey(namespace, options.sessionId);
      if (sessions.has(key) || creating.has(key))
        throw new FrameworkError("DUPLICATE_SESSION", "Session already exists.");
      if (sessions.size + creating.size >= maxSessions)
        throw new FrameworkError("CAPACITY", "Session capacity reached.");
      const definition: SessionDefinition = Object.freeze({
        ...options,
        namespace,
        identity,
        tools: Object.freeze([...options.tools]),
        allowedTools: Object.freeze([...options.allowedTools]),
      });
      creating.add(key);
      const sessionContext = context.fork("session");
      sessionContext.provide(sessionDefinition, definition);
      try {
        await sessionContext.install(context.registrations);
        sessionContext.resolve(agentExecutor);
        if (closing) throw new FrameworkError("CLOSED", "Kernel closed while creating session.");
        const session = new SessionHandle(
          definition,
          sessionContext,
          resources,
          context.registrations,
          config.maxConcurrentRuns,
          timeout,
          () => closing !== undefined,
          () => {
            sessions.delete(key);
          },
          async () => {
            await context.optional(taskEngine)?.cancelSession(namespace, options.sessionId);
          },
        );
        sessions.set(key, session);
        return session;
      } catch (error) {
        try {
          await sessionContext.dispose();
        } catch (cleanupError) {
          context.resolve(diagnostics)(safeError(cleanupError));
        }
        throw error;
      } finally {
        creating.delete(key);
      }
    },
    inspectPlugins: () => context.inspectPlugins(),
    updateModel(value) {
      if (closing) throw new FrameworkError("CLOSED", "Kernel is closing.");
      const model = context.resolve(modelRouter);
      if (!model.update)
        throw new FrameworkError("CAPABILITY_UNAVAILABLE", "Model configuration updates are unavailable.");
      model.update(jsonValue(value));
    },
    dispose() {
      closing ??= Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        for (const session of [...sessions.values()]) {
          try {
            await session.dispose();
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          await context.dispose();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) throw new FrameworkError("CLEANUP_FAILED", "Kernel resource cleanup failed.");
      });
      return closing;
    },
  };
}
