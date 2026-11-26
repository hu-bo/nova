import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { productId, randomProductId } from "./product-id.js";
import type { Goal, SubmitInput } from "@nova/agent-ui-contracts";
import type { AcceptedExecution } from "../../src/modules/runs/agent-profile.js";
export type PendingInputStatus = "queued" | "consumed" | "removed" | "rejected";
export type SpecInputMetadata =
  | { kind: "generation"; specId: string; revision: number; stage: "requirements" | "design" | "tasks" }
  | { kind: "task"; specId: string; revision: number; taskKey: string; attemptId: string };
export const pendingInputs = pgTable(
  "pending_inputs",
  {
    id: productId("id", "pendingInput").default(randomProductId).primaryKey(),
    conversationId: productId("conversation_id", "conversation").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    mode: text("mode").$type<SubmitInput["mode"]>().notNull(),
    status: text("status").$type<PendingInputStatus>().default("queued").notNull(),
    payload: jsonb("payload")
      .$type<SubmitInput & { execution?: AcceptedExecution; goal?: Pick<Goal, "objective" | "acceptanceCriteria" | "maxIterations">; spec?: SpecInputMetadata }>()
      .notNull(),
    idempotencyKey: text("idempotency_key"),
    fingerprint: text("fingerprint").notNull(),
    runId: productId("run_id", "run"),
    messageId: uuid("message_id"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("pending_inputs_conversation_status_sequence_idx").on(table.conversationId, table.status, table.sequence),
  ],
);
