import type { JsonValue } from "./message.js";
import type { SafeError } from "./errors.js";
import type { Schema } from "./plugin.js";
import type { AdmissionLease, ResourceClaim } from "./admission.js";
import type { HandlerOutcome, TaskSignal, WaitDefinition } from "./continuation.js";
export interface TaskSpec {
  namespace?: string;
  kind: string;
  version: number;
  input: JsonValue;
  idempotencyKey?: string;
  priority?: number;
  notBefore?: number;
  deadlineAt: number;
  maxAttempts?: number;
  concurrencyKey?: string;
  resources?: Readonly<Record<string, number>>;
}
export type TaskStatus =
  "blocked" | "queued" | "running" | "cancelling" | "waiting" | "retry_wait" | TaskResult["status"];
export interface TaskResult {
  taskId: string;
  status: "succeeded" | "failed" | "cancelled" | "timed_out" | "skipped";
  output?: JsonValue;
  error?: SafeError;
}
export interface TaskSnapshot {
  readonly taskId: string;
  readonly namespace: string;
  readonly status: TaskStatus;
  readonly spec: TaskSpec;
  readonly sequence: number;
  readonly attempts: number;
  readonly acceptedAt: number;
  readonly finishedAt?: number;
  readonly result?: TaskResult;
  readonly parentTaskId?: string;
  readonly flowId?: string;
  readonly wait?: { readonly waitId: string; readonly expiresAt: number };
}
export interface TaskEvent {
  schemaVersion: 1;
  eventId: string;
  taskId: string;
  namespace: string;
  seq: number;
  timestamp: number;
  status: TaskStatus;
}
export interface TaskHandle {
  readonly taskId: string;
  result(): Promise<TaskResult>;
  snapshot(): TaskSnapshot;
  events(): AsyncIterable<TaskEvent>;
  cancel(reason?: string): void;
}
export interface TaskContext {
  readonly taskId: string;
  readonly namespace: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly attemptId: string;
  readonly lease: AdmissionLease;
  createWait(definition: WaitDefinition): string;
  submitChild(spec: TaskSpec): TaskHandle;
  /** Releases this execution segment while waiting for a child to finish. */
  waitFor(child: TaskHandle): Promise<TaskResult>;
}
interface HandlerDefinition {
  kind: string;
  version: number;
  inputSchema?: Schema<JsonValue>;
  outputSchema?: Schema<JsonValue>;
  retrySafe?: boolean;
  claims?(input: JsonValue): readonly ResourceClaim[];
  cancel?(input: JsonValue, namespace?: string): void;
}
export interface ValueTaskHandler extends HandlerDefinition {
  protocol?: "value";
  execute(input: JsonValue, context: TaskContext): Promise<JsonValue>;
}
export interface ResumableTaskHandler extends HandlerDefinition {
  protocol: "outcome";
  execute(input: JsonValue, context: TaskContext): Promise<HandlerOutcome>;
  resume(state: JsonValue, signal: TaskSignal, context: TaskContext): Promise<HandlerOutcome>;
}
export type TaskHandler = ValueTaskHandler | ResumableTaskHandler;
