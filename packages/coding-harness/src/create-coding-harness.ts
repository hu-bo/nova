import { createAgentKernel, toolPolicies, type PluginDefinition, type ToolDefinition } from "@nnova/harness";
import { basicLoopPlugin } from "@nnova/harness/plugins/basic-loop";
import { contextPlugin } from "@nnova/harness/plugins/context";
import { memorySessionPlugin } from "@nnova/harness/plugins/session-memory";
import { toolRuntimePlugin } from "@nnova/harness/plugins/tools";
import { aiSdkModelPlugin } from "@nnova/harness/plugins/model-ai-sdk";
import { toToolContext } from "@nova/runner-sdk";
import { createRemoteTools } from "@nova/tools/harness";
import type { CodingHarness, CodingHarnessOptions, CodingModelOptions } from "./contracts.js";
import { resolveConfiguration } from "./configuration.js";
import { PlanGate } from "./plan-gate.js";
import { CodingHarnessRuntime, createDiagnosticReporter } from "./runtime.js";

function modelBinding(model: CodingModelOptions): { id: string; plugin: PluginDefinition } {
  if ("plugin" in model) {
    if (!model.modelId.trim()) throw new TypeError("A model plugin requires a non-empty modelId.");
    return { id: model.modelId, plugin: model.plugin };
  }
  if (!model.model.trim() || !model.apiKey.trim() || !model.baseURL.trim()) {
    throw new TypeError("Coding Harness requires an explicit model, base URL, and API key.");
  }
  const id = "coding";
  return {
    id,
    plugin: aiSdkModelPlugin({
      models: [
        {
          id,
          protocol: "openai-chat",
          ...model,
          contextWindow: model.contextWindow ?? 128_000,
          maxOutputTokens: model.maxOutputTokens ?? 8_192,
        },
      ],
      defaultModel: id,
      maxConcurrentRequests: 1,
    }),
  };
}

export async function createCodingHarness(options: CodingHarnessOptions): Promise<CodingHarness> {
  const configuration = resolveConfiguration(options);
  const model = modelBinding(options.model);
  const report = createDiagnosticReporter(options.onDiagnostic);
  const gate = configuration.plan
    ? new PlanGate(configuration.plan.path, configuration.plan.alreadyWritten)
    : undefined;
  const tools: ToolDefinition[] = [];
  const runner = options.session;
  const workspaceId = options.workspaceId;
  const cwd = options.cwd;
  const createContext = options.createContext;
  if (runner && workspaceId) {
    tools.push(
      ...createRemoteTools({
        createContext: async (input) => {
          input.signal.throwIfAborted();
          const context = createContext
            ? await createContext(input, { workspaceId, ...(cwd === undefined ? {} : { cwd }), session: runner })
            : toToolContext(runner, {
                workspaceId,
                ...(cwd === undefined ? {} : { cwd }),
                signal: input.signal,
                executionId: input.executionId,
                idempotencyKey: input.idempotencyKey,
              });
          input.signal.throwIfAborted();
          return gate ? gate.observe(context) : context;
        },
      }),
    );
  }
  tools.push(...(options.tools ?? []));
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new TypeError("Coding Harness tool names must be unique.");
  }
  const policies = [...(options.policies ?? [])];
  if (new Set(policies.map((policy) => policy.id)).size !== policies.length) {
    throw new TypeError("Coding Harness policy IDs must be unique.");
  }
  const policyPlugin: PluginDefinition = {
    manifest: {
      id: "nova.coding-harness.policies",
      version: "0.1.0",
      apiVersion: 1,
      scope: "session",
      requires: [],
      provides: [],
      contributes: [toolPolicies],
    },
    setup(context) {
      for (const policy of policies) context.contribute(toolPolicies, policy);
    },
  };
  const components = options.components;
  const kernel = await createAgentKernel({
    maxConcurrentRuns: 1,
    maxSessions: 1,
    defaultTimeoutMs: configuration.maxRunMs,
    onDiagnostic: report,
    plugins: [
      model.plugin,
      components?.context ?? contextPlugin(),
      components?.sessionStore ?? memorySessionPlugin(),
      components?.toolRuntime ??
        toolRuntimePlugin({
          maxParallelReads: configuration.maxParallelReads,
          maxParallelWrites: configuration.maxParallelWrites,
          maxOutputBytes: configuration.maxToolOutputBytes,
        }),
      ...(gate ? [gate.plugin()] : []),
      ...(policies.length ? [policyPlugin] : []),
      components?.loop ??
        basicLoopPlugin({ maxSteps: configuration.maxSteps, maxToolCalls: configuration.maxToolCalls }),
      ...(options.plugins ?? []),
    ],
  });
  try {
    const session = await kernel.createAgent({
      sessionId: configuration.sessionId,
      ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
      ...(options.identity === undefined ? {} : { identity: options.identity }),
      systemPrompt: configuration.systemPrompt,
      tools,
      allowedTools: [...(options.allowedTools ?? tools.map((tool) => tool.name))],
      model: model.id,
    });
    return new CodingHarnessRuntime(
      kernel,
      session,
      configuration.maxRunMs,
      {
        onEvent: options.onEvent,
        onRunResult: options.onRunResult,
        onToolResult: options.onToolResult,
      },
      report,
    );
  } catch (error) {
    try {
      await kernel.dispose();
    } catch {
      report({ code: "CLEANUP_FAILED", message: "Coding Harness initialization cleanup failed." });
    }
    throw error;
  }
}
