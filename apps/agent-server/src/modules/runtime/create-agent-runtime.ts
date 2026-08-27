import type { Agent, SessionStorage } from "@nova/agent-core";
import { createHarness } from "@nova/harness";
import { codingAgentModule } from "@nova/coding-agent";
import { createLogger } from "@nova/logger";
import { readUrl, todoWrite } from "@nova/tools";
import { createModel } from "@nova/model-adapters";
import type { ModelRef } from "@nova/model-adapters";
import { toToolContext } from "@nova/runner-sdk";
import { runnerUnavailable } from "../../errors.js";
import type { EntryRoute } from "../../store.js";
import type { PendingDecisions } from "../decision/pending-decisions.js";
import type { RunnerRegistry } from "../runner/registry.js";

const codingHarness = createHarness({ modules: [codingAgentModule] });
const chatHarness = createHarness({ modules: [{ id: "nova.chat", tools: [readUrl, todoWrite] }] });
const logger = createLogger("agent-server").child("agent-runtime");

export interface AgentRuntimeDependencies {
  storage(conversationId: string): SessionStorage;
  decisions: PendingDecisions;
  runners: RunnerRegistry;
}

export function createAgentRuntime(route: EntryRoute, dependencies: AgentRuntimeDependencies): Agent {
  const { conversation, project, userId } = route;
  const ref = resolveModelRef(conversation.modelConfig);
  logger.debug(
    {
      component: "agent-core",
      conversationId: conversation.id,
      provider: ref.provider,
      protocol: ref.protocol,
      model: ref.model,
      projectId: project?.id,
    },
    "creating agent runtime",
  );
  const model = createModel(ref);
  const workspace = project ? requireWorkspace(project.workspace) : undefined;
  const runnerId = conversation.runnerId ?? project?.runnerId;
  const runner = project
    ? dependencies.runners.pick(userId, requireRunner(runnerId), workspace)
    : runnerId
      ? dependencies.runners.pick(userId, runnerId)
      : undefined;
  const ctx = runner ? toToolContext(runner, { cwd: workspace ?? runner.identity.workspace }) : undefined;
  const harness = ctx ? codingHarness : chatHarness;
  return harness.createAgent({
    model: ref,
    stream: model.stream,
    ...(ctx ? { ctx } : {}),
    storage: dependencies.storage(conversation.id),
    decide: dependencies.decisions.createDecide(conversation.id, userId),
    sessionId: conversation.id,
    userId,
    approvalPolicy: { default: "ask", byRisk: { none: "auto", read: "auto", write: "ask", exec: "ask" } },
  });
}

function resolveModelRef(config: EntryRoute["conversation"]["modelConfig"]): ModelRef {
  return {
    provider: config.provider,
    protocol: config.provider,
    ...(config.provider === "openai" ? { wireApi: "chat-completions" as const } : {}),
    model: config.model,
    apiKey: config.credential,
    baseUrl: config.endpoint,
    contextWindow: config.contextWindow,
    maxOutput: config.maxOutput,
    thinkingLevels: config.thinkingLevels,
    parallelToolCalls: config.parallelToolCalls,
    reasoningFormat: config.reasoningFormat,
    inputModalities: config.inputModalities,
  };
}

function requireWorkspace(workspace: string | null): string {
  if (!workspace) throw runnerUnavailable("Project workspace is not bound");
  return workspace;
}

function requireRunner(runnerId: string | null | undefined): string {
  if (!runnerId) throw runnerUnavailable("Project runner is not bound");
  return runnerId;
}
