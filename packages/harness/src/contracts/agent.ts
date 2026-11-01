import type { AgentEvent } from "./event.js";
import type { AgentMessage, JsonValue } from "./message.js";
import type { PluginDefinition, PluginInspection } from "./plugin.js";
import type { Context } from "./runtime.js";
import type { ToolDefinition } from "./tool.js";
import type { TaskEngine } from "./flow.js";
import type { RunResult } from "./run.js";
import type { ModelRouteSnapshot, ReasoningEffort } from "./model.js";
import type { AdmissionLease, ResourceClaim } from "./admission.js";
export type * from "./run.js";
export interface OperationOptions {
  runId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: AgentEvent) => void;
}
export type SendOptions = OperationOptions & { reasoningEffort?: ReasoningEffort } & (
    { text: string; message?: never } | { message: AgentMessage; text?: never }
  );
export interface AgentDefinition {
  namespace?: string;
  sessionId: string;
  identity?: Readonly<Record<string, JsonValue>>;
  systemPrompt: string;
  tools: readonly ToolDefinition[];
  allowedTools: readonly string[];
  model?: string;
}
export interface SessionDefinition extends AgentDefinition {
  readonly namespace: string;
  readonly identity: Readonly<Record<string, JsonValue>>;
}
export interface CompactResult {
  status: "compacted" | "skipped" | "failed";
  reason?: string;
}
export interface AgentSession {
  readonly namespace: string;
  readonly sessionId: string;
  send(options: SendOptions): Promise<RunResult>;
  compact(options?: OperationOptions): Promise<CompactResult>;
  resume(
    options: OperationOptions & {
      runId: string;
      continuationId: string;
      input: JsonValue;
    },
  ): Promise<RunResult>;
  inspect(): Promise<AgentInspection>;
  cancel(): void;
  dispose(): Promise<void>;
}
export interface AgentInspection {
  readonly namespace: string;
  readonly sessionId: string;
  readonly model?: string;
  readonly allowedTools: readonly string[];
  readonly revision: number;
  readonly active: boolean;
  readonly waiting: boolean;
}
export interface RunExecution {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly model?: ModelRouteSnapshot;
  readonly reasoningEffort?: ReasoningEffort;
  readonly message?: AgentMessage;
  readonly resume?: { continuationId: string; input: JsonValue };
  emit(event: AgentEvent): void;
}
export interface AgentExecutor {
  execute(run: RunExecution): Promise<RunResult>;
  compact(run: RunExecution): Promise<CompactResult>;
}
export interface AgentReference {
  namespace: string;
  sessionId: string;
}
export interface AgentAccess {
  claims(reference: AgentReference): readonly ResourceClaim[];
  start(reference: AgentReference, options: SendOptions, lease: AdmissionLease): Promise<RunResult>;
  resume?(
    reference: AgentReference,
    options: OperationOptions & {
      runId: string;
      continuationId: string;
      input: JsonValue;
    },
    lease: AdmissionLease,
  ): Promise<RunResult>;
  cancel(reference: AgentReference): void;
}
export interface AgentKernel {
  readonly tasks: TaskEngine;
  createAgent(options: AgentDefinition): Promise<AgentSession>;
  inspectPlugins(): readonly PluginInspection[];
  updateModel(config: JsonValue): void;
  dispose(): Promise<void>;
}
export interface KernelConfig {
  maxConcurrentRuns: number;
  maxSessions?: number;
  defaultTimeoutMs?: number;
  cancellationGraceMs?: number;
  plugins?: readonly PluginDefinition[];
  configure?: (context: Context) => void | Promise<void>;
  onDiagnostic?: (error: { code: string; message: string }) => void;
}
