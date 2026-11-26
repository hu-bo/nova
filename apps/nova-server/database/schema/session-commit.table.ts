import { bigint, jsonb, pgTable, primaryKey } from "drizzle-orm/pg-core";
import { productId } from "./product-id.js";
import type { SessionCommit } from "@nnova/harness";
import { runs } from "./run.table.js";

export const sessionCommits = pgTable(
  "session_commits",
  {
    runId: productId("run_id", "run")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    batch: jsonb("batch").$type<SessionCommit>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.revision] })],
);
