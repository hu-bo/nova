import { index, pgTable, timestamp, uuid, text, integer } from "drizzle-orm/pg-core";

export const specs = pgTable(
  "specs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    conversationId: uuid("conversation_id").notNull().unique(),
    title: text("title").notNull(),
    currentRevision: integer("current_revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("specs_project_updated_idx").on(table.projectId, table.updatedAt, table.id)],
);
