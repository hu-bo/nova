import type { ExecutionRecord, SessionSnapshot } from "@nnova/harness";
import type { UploadStorage } from "../attachments/index.js";
import type {
  Capabilities,
  Configuration,
  Interaction,
  InteractionResponse,
  JsonValue,
  RuntimeEvent,
  RunView,
  SubmitInput,
} from "@nova/agent-ui-contracts";

export interface Checkpoint {
  backendId: string;
  epoch: number;
  configuration: Configuration;
  nativeState: JsonValue;
  executions: ExecutionRecord[];
  interactions: (Interaction & { response?: InteractionResponse; acceptedRevision?: number })[];
  continuation?: JsonValue;
  approvals: string[];
  reservedInputs: { id: string; messageId: string }[];
  outcome?: Extract<RuntimeOutcome, { kind: "completed" }>;
  specExecution?:
    | { kind: "discussion"; specId: string; revision: number }
    | { kind: "generation"; specId: string; revision: number; stage: "requirements" | "design" | "tasks" }
    | { kind: "task"; specId: string; revision: number; taskKey: string; attemptId: string };
}
export interface RuntimeCommit {
  checkpoint?: Checkpoint;
  events?: RuntimeEvent[];
  consumedInputIds?: string[];
}
export type RuntimeOutcome =
  | { kind: "completed"; state: "succeeded" | "failed" | "cancelled" | "timed_out"; reason?: string }
  | { kind: "waiting" | "paused"; reason?: string };
export type RuntimeCommand = { kind: "start"; input: SubmitInput; messageId: string } | { kind: "recover" };
export interface RuntimeContext {
  runId: string;
  signal: AbortSignal;
  checkpoint: Checkpoint;
  commit(batch: RuntimeCommit): Promise<void>;
}
export interface RuntimeAdapter {
  execute(command: RuntimeCommand, context: RuntimeContext): Promise<RuntimeOutcome>;
  cancel(runId: string): Promise<"confirmed" | "unknown">;
  dispose(): Promise<void>;
}
export interface RuntimeDependencies {
  prepared: NonNullable<Awaited<ReturnType<import("./run.service.js").RunService["prepare"]>>>;
  claim: import("./run.repository.js").RunClaim;
  repository: import("./run.service.js").RunService;
  models: import("../model-config/index.js").UserModelProfilesService;
  remotes: import("../remotes/index.js").RemoteConnectionService;
  runners: import("../runners/index.js").RunnerConnections;
  uploads: UploadStorage;
}
export const runtimeAdapters = new Map<
  string,
  { create(dependencies: RuntimeDependencies): RuntimeAdapter; capabilities: Capabilities }
>();
// Native messages remain private. The shared product contract never imports Harness.
export type NovaNativeState = Pick<SessionSnapshot, "messages" | "runs" | "summary">;
export function nativeSnapshot(checkpoint: Checkpoint, revision: number): SessionSnapshot {
  const state = checkpoint.nativeState as unknown as NovaNativeState;
  if (checkpoint.backendId !== "nova" || !state || !Array.isArray(state.messages) || !Array.isArray(state.runs))
    throw new Error("INVALID_CHECKPOINT");
  for (const message of state.messages) {
    if (!message || !["user", "assistant", "tool", "system"].includes(message.role) || !Array.isArray(message.parts))
      throw new Error("INVALID_CHECKPOINT");
  }
  return {
    ...state,
    revision,
    executions: checkpoint.executions,
    ...(checkpoint.continuation !== undefined ? { continuation: checkpoint.continuation } : {}),
  };
}
export const runView = (run: {
  id: string;
  state: RunView["state"];
  failureReason?: string | null;
  pauseReason?: string | null;
}): RunView => ({
  id: run.id,
  state: run.state,
  ...(run.failureReason || run.pauseReason ? { reason: run.failureReason || run.pauseReason || "" } : {}),
  ...(run.state === "waiting" ? { waiting: "interaction" } : {}),
});
