import { bigint, index, jsonb, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import type { Block, Message } from "@nova/agent-ui-contracts";
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id").notNull(),
    runId: uuid("run_id"),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    role: text("role").$type<Message["role"]>().notNull(),
    state: text("state").$type<Message["state"]>().default("completed").notNull(),
    blocks: jsonb("blocks").$type<Block[]>().default([]).notNull(),
    source: jsonb("source").$type<Message["source"]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("messages_conversation_sequence_idx").on(table.conversationId, table.sequence),
    uniqueIndex("messages_conversation_sequence_unique").on(table.conversationId, table.sequence),
  ],
);
