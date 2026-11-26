import { bigint, boolean, index, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { conversations } from "./conversation.table.js";
import { runs } from "./run.table.js";

export type ModelUsageStatus = "succeeded" | "failed" | "cancelled" | "timed_out";

/** Immutable billing snapshot written once when a run reaches a terminal state. */
export const modelUsages = pgTable(
  "model_usages",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    conversationTitle: text("conversation_title").notNull(),
    modelId: uuid("model_id").notNull(),
    modelName: text("model_name").notNull(),
    modelConfigVersion: integer("model_config_version").notNull(),
    status: text("status").$type<ModelUsageStatus>().notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull(),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" }).notNull(),
    cost: numeric("cost", { precision: 38, scale: 8 }).notNull(),
    estimated: boolean("estimated").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("model_usages_created_at_idx").on(table.createdAt),
    index("model_usages_model_created_at_idx").on(table.modelId, table.createdAt),
    index("model_usages_status_created_at_idx").on(table.status, table.createdAt),
  ],
);
