import type { JsonValue } from "./message.js";
import type { TaskHandle, TaskResult, TaskSpec, TaskSnapshot } from "./task.js";
import type { SignalReceipt, TaskSignal } from "./continuation.js";
export type FlowPredicate = (output: JsonValue) => boolean;
export interface FlowNode {
  readonly id: string;
  task: TaskSpec;
  dependsOn?: readonly string[];
  inputBindings?: Readonly<Record<string, { nodeId: string; path: readonly string[] }>>;
  join?: "all-success" | "all-settled" | "selected-success" | "any-success" | "race";
  condition?: { predicate: string; nodeId: string };
}
export interface FlowSpec {
  nodes: readonly FlowNode[];
  outputNode: string;
  deadlineAt: number;
  maxConcurrency: number;
  failurePolicy?: "fail-fast" | "continue-independent";
}
export interface FlowResult {
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  nodes: Readonly<Record<string, TaskResult>>;
  output?: JsonValue;
}
export interface FlowHandle {
  readonly flowId: string;
  result(): Promise<FlowResult>;
  cancel(reason?: string): void;
}
export interface TaskEngine {
  submit(spec: TaskSpec): TaskHandle;
  submitFlow(spec: FlowSpec): FlowHandle;
  signal(input: TaskSignal): SignalReceipt;
  cancel(taskId: string, reason?: string): void;
  cancelSession(namespace: string, sessionId: string): Promise<void>;
  drain(options: { timeoutMs: number }): Promise<void>;
}
export interface TaskStore {
  readonly maxTasks: number;
  prune(now: number): void;
  list(): readonly TaskSnapshot[];
  get(taskId: string): TaskSnapshot | undefined;
  set(snapshot: TaskSnapshot): void;
  delete(taskId: string): void;
  retain(taskId: string): () => void;
}
