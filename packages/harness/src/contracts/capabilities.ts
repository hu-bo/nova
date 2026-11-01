import type { CapabilityKey, ContributionKey } from "./plugin.js";
import type { ModelAdapter } from "./model.js";
import type { TaskHandler } from "./task.js";
import type { TaskEngine, TaskStore } from "./flow.js";
import type { TaskQueue } from "./queue.js";
import type { Admission } from "./admission.js";
import type { AgentAccess, AgentExecutor, SessionDefinition } from "./agent.js";
import type { CheckpointPolicy, SessionPersistence, SessionStore } from "./session.js";
import type { ContextBuilder, ContextCompactor, ContextContribution } from "./context.js";
import type { ToolDefinition, ToolRuntime, ToolPolicy } from "./tool.js";
import type { EventJournal, EventObserver } from "./event.js";
import type { SafeError } from "./errors.js";
import type { ArtifactWriter } from "./artifact.js";
export const modelRouter: CapabilityKey<ModelAdapter> = {
  id: "model.router",
  version: 1,
};
export const taskHandlers: ContributionKey<TaskHandler> = {
  id: "task.handler",
  version: 1,
  collection: true,
};
export const admission: CapabilityKey<Admission> = {
  id: "kernel.admission",
  version: 1,
};
export const agentAccess: CapabilityKey<AgentAccess> = {
  id: "kernel.agents",
  version: 1,
};
export const sessionDefinition: CapabilityKey<SessionDefinition> = {
  id: "session.definition",
  version: 1,
};
export const sessionStore: CapabilityKey<SessionStore> = {
  id: "session.store",
  version: 1,
};
export const sessionPersistence: CapabilityKey<SessionPersistence> = {
  id: "session.persistence",
  version: 1,
};
export const checkpointPolicies: ContributionKey<CheckpointPolicy> = {
  id: "session.checkpoint-policy",
  version: 1,
  collection: true,
};
export const contextBuilder: CapabilityKey<ContextBuilder> = {
  id: "context.builder",
  version: 1,
};
export const contextCompactor: CapabilityKey<ContextCompactor> = {
  id: "context.compactor",
  version: 1,
};
export const contextContributions: ContributionKey<ContextContribution> = {
  id: "context.contribution",
  version: 1,
  collection: true,
};
export const toolDefinitions: ContributionKey<ToolDefinition> = {
  id: "tool.definition",
  version: 1,
  collection: true,
};
export const toolPolicies: ContributionKey<ToolPolicy> = {
  id: "policy.rule",
  version: 1,
  collection: true,
};
export const toolRuntime: CapabilityKey<ToolRuntime> = {
  id: "tool.runtime",
  version: 1,
};
export const agentExecutor: CapabilityKey<AgentExecutor> = {
  id: "agent.executor",
  version: 1,
};
export const taskQueue: CapabilityKey<TaskQueue> = {
  id: "task.queue",
  version: 1,
};
export const taskStore: CapabilityKey<TaskStore> = {
  id: "task.store",
  version: 1,
};
export const taskEngine: CapabilityKey<TaskEngine> = {
  id: "task.engine",
  version: 1,
};
export const eventObservers: ContributionKey<EventObserver> = {
  id: "event.observer",
  version: 1,
  collection: true,
};
export const eventJournal: CapabilityKey<EventJournal> = {
  id: "event.journal",
  version: 1,
};
export const diagnostics: CapabilityKey<(error: SafeError) => void> = {
  id: "kernel.diagnostics",
  version: 1,
};
export const artifactWriter: CapabilityKey<ArtifactWriter> = {
  id: "artifact.writer",
  version: 1,
};
