import { createAgent } from "./agent.js";
import { fail, positive, modelSnapshot } from "./validation.js";
import type { AgentSession, DshAgentKernel, KernelConfig, ModelConfig, SessionOptions } from "./contracts.js";
export async function createDshAgentKernel(config: KernelConfig): Promise<DshAgentKernel> {
  const models = new Map<string, ModelConfig>();
  for (const value of config.models) {
    const model = modelSnapshot(value);
    if (models.has(model.id)) fail("INVALID_CONFIG", "Duplicate model configuration id");
    models.set(model.id, model);
  }
  if (!models.has(config.defaultModel)) fail("INVALID_CONFIG", "Unknown default model");
  const limit = config.maxConcurrentRuns ?? 1;
  positive(limit, "maxConcurrentRuns");
  const defaultModel = config.defaultModel;
  const sessions = new Map<string, Promise<AgentSession>>();
  let active = 0;
  let closed = false;
  let disposal: Promise<void> | undefined;
  const ensureOpen = () => {
    if (closed) fail("CLOSED", "Kernel is closed");
  };
  const resolve = (id: string) => {
    ensureOpen();
    const model = models.get(id);
    if (!model) return fail("UNKNOWN_MODEL", "Unknown model configuration id");
    return model;
  };
  return {
    async updateModel(value) {
      ensureOpen();
      const model = modelSnapshot(value);
      models.set(model.id, model);
    },
    async createAgent(options) {
      ensureOpen();
      if (!options.sessionId?.trim() || typeof options.systemPrompt !== "string")
        fail("INVALID_CONFIG", "sessionId and systemPrompt are required");
      if (sessions.has(options.sessionId)) fail("DUPLICATE_SESSION", "Session already exists");
      const initial = resolve(options.model ?? defaultModel);
      const ratio = options.compression?.thresholdRatio ?? 0.8;
      if (!Number.isFinite(ratio) || ratio <= 0.16 || ratio >= 1)
        fail("INVALID_CONFIG", "thresholdRatio must be greater than 0.16 and less than 1");
      const snapshot: SessionOptions = {
        ...options,
        tools: (options.tools ?? []).map((tool) => ({ ...tool, parameters: structuredClone(tool.parameters) })),
        compression: { enabled: options.compression?.enabled ?? true, thresholdRatio: ratio },
      };
      const pending = createAgent(
        snapshot,
        initial,
        resolve,
        () => {
          ensureOpen();
          if (active >= limit) fail("CAPACITY", "Concurrent operation limit reached");
          active++;
          return () => {
            active--;
          };
        },
        () => {
          sessions.delete(options.sessionId);
        },
      );
      sessions.set(options.sessionId, pending);
      try {
        return await pending;
      } catch (error) {
        sessions.delete(options.sessionId);
        throw error;
      }
    },
    dispose() {
      if (disposal) return disposal;
      closed = true;
      disposal = (async () => {
        const results = await Promise.allSettled(
          [...sessions.values()].map(async (pending) => (await pending).dispose()),
        );
        sessions.clear();
        models.clear();
        const failure = results.find((result) => result.status === "rejected");
        if (failure) fail("DISPOSE_FAILED", "One or more sessions failed to dispose");
      })();
      return disposal;
    },
  };
}
