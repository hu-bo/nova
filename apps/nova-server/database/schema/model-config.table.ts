import { boolean, index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";
export type ReasoningFormat = "none" | "openai" | "anthropic" | "deepseek" | "minimax";
export type InputModality = "text" | "image";

/** Model catalog entries are soft-deleted so public names remain reserved. */
export const modelConfigs = pgTable(
  "model_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    publicName: text("public_name").notNull(),
    providerId: uuid("provider_id").notNull(),
    upstreamName: text("upstream_name").notNull(),
    contextWindow: numeric("context_window", { precision: 10, scale: 0 }).notNull(),
    maxOutput: numeric("max_output", { precision: 10, scale: 0 }).notNull(),
    thinkingLevels: jsonb("thinking_levels").$type<ThinkingLevel[]>().default([]).notNull(),
    parallelToolCalls: boolean("parallel_tool_calls").default(true).notNull(),
    reasoningFormat: text("reasoning_format").$type<ReasoningFormat>().default("none").notNull(),
    inputModalities: jsonb("input_modalities").$type<InputModality[]>().default(["text"]).notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    priceIn: numeric("price_in", { precision: 20, scale: 8 }).default("0").notNull(),
    priceOut: numeric("price_out", { precision: 20, scale: 8 }).default("0").notNull(),
    priceCacheRead: numeric("price_cache_read", { precision: 20, scale: 8 }).default("0").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("model_configs_public_name_unique").on(table.publicName),
    index("model_configs_provider_id_idx").on(table.providerId),
    index("model_configs_deleted_at_idx").on(table.deletedAt),
  ],
);
