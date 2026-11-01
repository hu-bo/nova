import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ProductEvent } from "@nova/agent-ui-contracts";
export const uiEvents = pgTable(
  "ui_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    runId: uuid("run_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    type: text("type").$type<ProductEvent["type"]>().notNull(),
    payload: jsonb("payload").$type<ProductEvent["payload"]>().notNull(),
  },
  (table) => [
    index("ui_events_conversation_sequence_idx").on(table.conversationId, table.sequence),
    index("ui_events_occurred_at_idx").on(table.occurredAt),
  ],
);
