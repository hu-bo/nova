import type { AgentMessage, JsonValue } from "./message.js";
import type { RunResult, ToolCallResult } from "./run.js";
import { FrameworkError } from "./errors.js";
export type CheckpointBoundary = "agent/pre-step" | "llm/stream" | "tools/execute";
export interface SessionPersistence {
  flush(): Promise<void>;
}
export interface CheckpointPolicy {
  readonly id: string;
  before(boundary: CheckpointBoundary, signal: AbortSignal): Promise<void>;
}
export interface ExecutionRecord {
  readonly executionId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly idempotencyKey: string;
  readonly dispatch?: "intent" | "dispatched";
  readonly effects?: "read" | "write" | "external-job";
  readonly result?: ToolCallResult;
}
export interface SessionSnapshot {
  readonly revision: number;
  readonly messages: readonly AgentMessage[];
  readonly runs: readonly RunResult[];
  readonly executions: readonly ExecutionRecord[];
  readonly summary?: { text: string; throughMessage: number };
  readonly continuation?: JsonValue;
}
export interface SessionCommit {
  readonly messages?: readonly AgentMessage[];
  readonly run?: RunResult;
  readonly execution?: ExecutionRecord;
  readonly summary?: { text: string; throughMessage: number };
  readonly continuation?: JsonValue | null;
}
export interface SessionStore {
  load(): Promise<SessionSnapshot>;
  commit(batch: SessionCommit, expectedRevision: number): Promise<SessionSnapshot>;
  /** An owned store may serialize additive updates without a separate load/commit race. */
  update?(batch: SessionCommit): Promise<SessionSnapshot>;
}

export function applySessionCommit(state: SessionSnapshot, batch: SessionCommit): SessionSnapshot {
  // Commits own their new facts; immutable history keeps its identity across transitions.
  batch = structuredClone(batch);
  const executions = [...state.executions];
  if (batch.execution) {
    const index = executions.findIndex((item) => item.executionId === batch.execution?.executionId);
    if (index < 0) executions.push(batch.execution);
    else executions[index] = batch.execution;
  }
  const runs = [...state.runs];
  if (batch.run) {
    const index = runs.findIndex((run) => run.runId === batch.run?.runId);
    if (index < 0) runs.push(batch.run);
    else runs[index] = batch.run;
  }
  const next: SessionSnapshot = {
    revision: state.revision + 1,
    messages: [...state.messages, ...(batch.messages ?? [])],
    runs,
    executions,
    ...(batch.summary === undefined ? (state.summary ? { summary: state.summary } : {}) : { summary: batch.summary }),
    ...(batch.continuation === null
      ? {}
      : batch.continuation !== undefined
        ? { continuation: batch.continuation }
        : state.continuation !== undefined
          ? { continuation: state.continuation }
          : {}),
  };
  if (!Number.isSafeInteger(next.revision)) throw new FrameworkError("SESSION_LIMIT", "Session revision is exhausted.");
  return next;
}

/** Retry a conflict after re-reading the version for additive or idempotent commits. */
export async function commitSessionUpdate(
  store: SessionStore,
  batch: SessionCommit,
  maxAttempts = 5,
): Promise<SessionSnapshot> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const snapshot = store.update ? undefined : await store.load();
    try {
      return store.update ? await store.update(batch) : await store.commit(batch, snapshot!.revision);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "REVISION_CONFLICT") || attempt === maxAttempts)
        throw error;
    }
  }
  throw new FrameworkError("REVISION_CONFLICT", "Session update retry limit reached.");
}
