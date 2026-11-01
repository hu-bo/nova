import { bigint, jsonb, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import type { SessionCommit } from "@nnova/harness";
import { runs } from "./run.table.js";

export const sessionCommits = pgTable(
  "session_commits",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    batch: jsonb("batch").$type<SessionCommit>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.revision] })],
);
