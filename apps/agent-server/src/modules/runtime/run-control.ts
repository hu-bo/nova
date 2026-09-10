import { toUiRequest } from "../decision/pending-decisions.js";
import type { RunCheckpoint, SessionStorage } from "@nova/agent-core";
import type { EntryRoute } from "../../store.js";

export interface RunClaim {
  signal: AbortSignal;
  release(): Promise<void>;
}

export interface RunControl {
  storage(conversationId: string): SessionStorage;
  claim(conversationId: string): Promise<RunClaim | null>;
  candidates(): Promise<EntryRoute[]>;
  runnerGeneration(route: EntryRoute): string | null;
}

export function publicRun(checkpoint: RunCheckpoint | null) {
  if (!checkpoint) return null;
  const { runId, version, status, phase, reason } = checkpoint;
  return {
    runId,
    version,
    status,
    phase,
    reason,
    pendingDecision: checkpoint.pendingDecision ? toUiRequest(checkpoint.pendingDecision) : null,
  };
}

export const automaticRecoveryReasons = new Set([null, "runner_disconnected", "server_restart", "server_shutdown"]);
