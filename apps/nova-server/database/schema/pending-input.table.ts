import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Goal, SubmitInput } from "@nova/agent-ui-contracts";
export type PendingInputStatus = "queued" | "consumed" | "removed" | "rejected";
export const pendingInputs = pgTable(
  "pending_inputs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    mode: text("mode").$type<SubmitInput["mode"]>().notNull(),
    status: text("status").$type<PendingInputStatus>().default("queued").notNull(),
    payload: jsonb("payload")
      .$type<SubmitInput & { goal?: Pick<Goal, "objective" | "acceptanceCriteria" | "maxIterations"> }>()
      .notNull(),
    idempotencyKey: text("idempotency_key"),
    fingerprint: text("fingerprint").notNull(),
    runId: uuid("run_id"),
    messageId: uuid("message_id"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("pending_inputs_conversation_status_sequence_idx").on(table.conversationId, table.status, table.sequence),
  ],
);
