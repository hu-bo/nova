import { bigint, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { Configuration, Goal, Todo } from "@nova/agent-ui-contracts";
import type { z } from "zod";
import type { bindingSchema } from "../../src/modules/projects/index.js";
export interface ConversationMetadata {
  configuration?: Configuration;
  latestCheckpointRunId?: string | null;
  latestRunId?: string | null;
  lastEventBatchId?: string;
  binding?: z.infer<typeof bindingSchema> | null;
  goal?: Goal | null;
  plan?: Todo[];
  creationKey?: string | null;
  creationPayload?: string;
  toolApprovals?: { environment: string; names: string[] } | null;
}
export type ConversationMode = "chat" | "project";
export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull(),
  mode: text("mode").$type<ConversationMode>().notNull(),
  projectId: uuid("project_id"),
  title: text("title"),
  contextEpoch: bigint("context_epoch", { mode: "number" }).default(1).notNull(),
  activeRunId: uuid("active_run_id"),
  lastEventSequence: bigint("last_event_sequence", { mode: "bigint" })
    .default(sql`0`)
    .notNull(),
  eventFloorSequence: bigint("event_floor_sequence", { mode: "bigint" })
    .default(sql`0`)
    .notNull(),
  lastMessageSequence: bigint("last_message_sequence", { mode: "bigint" })
    .default(sql`0`)
    .notNull(),
  metadata: jsonb("metadata").$type<ConversationMetadata>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
