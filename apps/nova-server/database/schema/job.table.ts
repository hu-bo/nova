import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").notNull(),
    aggregateId: uuid("aggregate_id"),
    dedupeKey: text("dedupe_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    attempt: integer("attempt").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    status: text("status").default("queued").notNull(),
    safeErrorCode: text("safe_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("jobs_status_available_idx").on(table.status, table.availableAt),
    uniqueIndex("jobs_kind_aggregate_dedupe_idx").on(table.kind, table.aggregateId, table.dedupeKey),
  ],
);
