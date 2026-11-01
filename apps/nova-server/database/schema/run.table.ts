import { bigint, index, jsonb, pgTable, text as pgTableText, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Snapshot } from "@nova/agent-ui-contracts";
import type { Checkpoint } from "../../src/modules/runs/runtime-adapter.js";
import type { StreamState } from "../../src/modules/runs/stream-state.js";

/**
 * 运行表:
 * - state 与 phase 严格分离 (见 docs/nova-server.md §7.1):
 *   state = 生命周期; phase = 恢复位置 (prepare/model_request/tool_dispatch/...).
 * - 单会话非终态 run 互斥由 runs 部分唯一索引保证 (state IN 非终态集合);
 *   此处不声明唯一索引, 留给后续 migration 阶段补齐。
 * - worker_id/lease_until 表达当前 worker claim; fence 表达单调 token, 防 lease
 *   失效后旧 worker 写回。
 */
export type RunState =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "cancelled_unconfirmed";

export type RunPhase =
  | "prepare"
  | "model_request"
  | "model_committed"
  | "tool_batch_prepared"
  | "tool_dispatch"
  | "tool_results_committed"
  | "finalizing";

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id").notNull(),
    state: pgTableText("state").$type<RunState>().notNull(),
    phase: pgTableText("phase").$type<RunPhase>().default("prepare").notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    pauseReason: pgTableText("pause_reason"),
    failureReason: pgTableText("failure_reason"),
    budget: jsonb("budget").$type<Record<string, unknown>>().default({}).notNull(),
    checkpoint: jsonb("checkpoint").$type<Checkpoint>(),
    checkpointMetadata: jsonb("checkpoint_metadata").$type<Omit<Checkpoint, "nativeState" | "executions">>(),
    checkpointRevision: bigint("checkpoint_revision", { mode: "number" }).default(1).notNull(),
    effectState: pgTableText("effect_state").$type<"known" | "pending" | "unknown">().default("known").notNull(),
    projection: jsonb("projection").$type<Snapshot>(),
    streamState: jsonb("stream_state").$type<StreamState>(),
    fence: bigint("fence", { mode: "number" }).default(1).notNull(),
    workerId: pgTableText("worker_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    revision: bigint("revision", { mode: "number" }).default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("runs_conversation_state_idx").on(table.conversationId, table.state),
    index("runs_worker_lease_idx").on(table.workerId, table.leaseUntil),
  ],
);
