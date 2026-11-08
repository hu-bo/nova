import { foreignKey, index, jsonb, pgTable, timestamp, uniqueIndex, uuid, text, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { specRevisions } from "./spec-revision.table.js";

export const specTaskAttempts = pgTable(
  "spec_task_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    specId: uuid("spec_id").notNull(),
    revision: integer("revision").notNull(),
    taskKey: text("task_key").notNull(),
    pendingInputId: uuid("pending_input_id").notNull().unique(),
    requestKey: text("request_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    resolution: jsonb("resolution").$type<{ note: string | null; resolvedBy: string; resolvedAt: string; receiptIds?: string[] } | null>(),
  },
  (table) => [
    uniqueIndex("spec_task_attempts_request_unique").on(table.specId, table.requestKey),
    uniqueIndex("spec_task_attempts_active_unique").on(table.specId).where(sql`${table.releasedAt} is null`),
    index("spec_task_attempts_history_idx").on(table.specId, table.revision, table.taskKey, table.createdAt, table.id),
    index("spec_task_attempts_spec_idx").on(table.specId),
    foreignKey({
      columns: [table.specId, table.revision],
      foreignColumns: [specRevisions.specId, specRevisions.revision],
      name: "spec_task_attempts_revision_fk",
    }).onDelete("cascade"),
  ],
);
