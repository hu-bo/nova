import { bigint, boolean, index, jsonb, pgTable, text as pgTableText, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Runner token 表:
 * - token hash 用于连接校验，AES-GCM 密文供所属用户复制连接凭据；旧记录密文可为空。
 * - status: active / rotated / revoked; 同一 (owner_user_id, token_hash) 唯一索引保证
 *   不重复使用; prev_token_hash 在轮换时写入, 用于回溯审计。
 */
export type RunnerTokenStatus = "active" | "rotated" | "revoked";

export const runnerTokens = pgTable(
  "runner_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id").notNull(),
    tokenHash: pgTableText("token_hash").notNull(),
    tokenCiphertext: pgTableText("token_ciphertext"),
    prevTokenHash: pgTableText("prev_token_hash"),
    label: pgTableText("label"),
    capabilities: jsonb("capabilities").$type<readonly string[]>().default([]).notNull(),
    status: pgTableText("status").$type<RunnerTokenStatus>().default("active").notNull(),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).defaultNow().notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("runner_tokens_owner_hash_idx").on(table.ownerUserId, table.tokenHash),
    index("runner_tokens_status_idx").on(table.status, table.statusChangedAt),
  ],
);

/**
 * Runner 设备表:
 * - owner + runnerId 复合唯一; 同一 owner 不允许重名设备。
 * - lastSeenAt 由 heartbeat 持续更新, 离线判定阈值由 server 运维常量给出。
 */
export const runners = pgTable(
  "runners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id").notNull(),
    runnerId: pgTableText("runner_id").notNull(),
    bootId: pgTableText("boot_id"),
    workspaceId: pgTableText("workspace_id"),
    capabilities: jsonb("capabilities").$type<readonly string[]>().default([]).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("runners_owner_runner_idx").on(table.ownerUserId, table.runnerId)],
);

/**
 * Runner operation mailbox: 派发记录 + 持久化回执关联。
 * - status: queued / dispatch_reserved / dispatched / acked / failed / unknown;
 *   dispatch_reserved 之后的同一 operation 不会再次 Execute, 只能 query/reconcile。
 * - resultPayload 由 Gateway 在 durable commit 后写入; ack 阶段可早于此值存在。
 */
export type RunnerOperationStatus = "queued" | "dispatch_reserved" | "dispatched" | "acked" | "failed" | "unknown";

export const runnerOperations = pgTable(
  "runner_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    operationId: pgTableText("operation_id").notNull(),
    runId: uuid("run_id").notNull(),
    toolCallId: pgTableText("tool_call_id").notNull(),
    boot: pgTableText("boot"),
    status: pgTableText("status").$type<RunnerOperationStatus>().default("queued").notNull(),
    payloadHash: pgTableText("payload_hash"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    resultPayload: jsonb("result_payload").$type<Record<string, unknown>>(),
    knownOutcome: boolean("known_outcome").default(false).notNull(),
    revision: bigint("revision", { mode: "number" }).default(1).notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("runner_operations_run_tool_idx").on(table.runId, table.toolCallId),
    index("runner_operations_status_idx").on(table.status, table.deadlineAt),
  ],
);
