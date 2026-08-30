// §5.1 Record —— 运行事实流：不进模型上下文，供 resume / 排障 / 计费 / 审计。
import type { DecisionRequest, DecisionResponse, QueueName, StopReason, Todo, Usage } from "../types.js";
import type { CompactionTrigger } from "../context/compaction.js";

export type Record = { id: string; runId: string; ts: number } & (
  | { kind: "run-started"; input: string }
  | { kind: "turn-started"; turn: number; model: string }
  | { kind: "tool-started"; callId: string; name: string; args: unknown }
  | { kind: "tool-finished"; callId: string; status: "ok" | "error"; durationMs: number }
  | { kind: "decision-requested"; decisionId: string; request: DecisionRequest }
  | { kind: "decision-resolved"; decisionId: string; response: DecisionResponse | "timeout" }
  | { kind: "queue-enqueued"; queue: QueueName; message: string }
  | { kind: "todo-updated"; items: Todo[] }
  | { kind: "usage"; model: string; usage: Usage }
  | { kind: "context-compacted"; trigger: CompactionTrigger; summarized: boolean }
  | { kind: "abort-requested" }
  | { kind: "run-finished"; stopReason: StopReason }
);

let counter = 0;
export function newRecordId(): string {
  counter += 1;
  return `record-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Omit 对联合类型不逐成员分发（同 entry.ts），需要 distributive 版本
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type RecordParts = DistributiveOmit<Record, "id" | "runId" | "ts">;

export function record(runId: string, parts: RecordParts): Record {
  return { id: newRecordId(), runId, ts: Date.now(), ...parts } as Record;
}
