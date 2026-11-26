import { bigint, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { productId } from "./product-id.js";
import type { ProductEvent } from "@nova/agent-ui-contracts";
export const uiEvents = pgTable(
  "ui_events",
  {
    conversationId: productId("conversation_id", "conversation").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    runId: productId("run_id", "run"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    type: text("type").$type<ProductEvent["type"]>().notNull(),
    payload: jsonb("payload").$type<ProductEvent["payload"]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.sequence], name: "ui_events_pkey" }),
    index("ui_events_occurred_at_idx").on(table.occurredAt),
  ],
);
