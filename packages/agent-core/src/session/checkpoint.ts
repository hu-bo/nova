import type { Message, Usage, ContentPart, QueueName, StopReason, DecisionRequest } from "../types.js";
import type { Entry } from "./entry.js";
import type { Record } from "./record.js";

export interface RunCheckpoint {
  runId: string;
  version: number;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  phase: "model" | "tools" | "finish";
  reason: string | null;
  turns: number;
  recoveries: number;
  startedAt: number;
  deadline: number;
  usage: Usage;
  draft: Message | null;
  completion?: StopReason;
  pendingDecision?: DecisionRequest | null;
  queues?: { [K in QueueName]: ContentPart[][] };
}

export interface SessionCommit {
  /** Compare-and-swap on the conversation's current checkpoint. Null means none exists. */
  expectedVersion: number | null;
  checkpoint: RunCheckpoint;
  entry?: Entry;
  record?: Record;
}

export class CheckpointConflict extends Error {
  constructor() {
    super("Run checkpoint changed; this execution no longer owns the run");
  }
}
