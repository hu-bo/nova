import { and, asc, eq, gt, lte } from "drizzle-orm";
import { applySessionCommit } from "@nnova/harness";
import { sessionCommits } from "../../../database/index.js";
import type { RepositoryDatabase } from "../../shared/scope.js";
import { nativeSnapshot, type Checkpoint } from "./runtime-adapter.js";
import { checkpointAfter } from "./session-checkpoint.js";

export async function readCheckpoint(
  db: RepositoryDatabase,
  run: { id: string; revision: number; checkpointRevision: number; checkpoint: Checkpoint | null },
): Promise<Checkpoint | null> {
  let checkpoint = run.checkpoint;
  if (!checkpoint || run.checkpointRevision === run.revision || checkpoint.backendId !== "nova") return checkpoint;
  let snapshot = nativeSnapshot(checkpoint, run.checkpointRevision);
  for (const row of await db
    .select()
    .from(sessionCommits)
    .where(
      and(
        eq(sessionCommits.runId, run.id),
        gt(sessionCommits.revision, run.checkpointRevision),
        lte(sessionCommits.revision, run.revision),
      ),
    )
    .orderBy(asc(sessionCommits.revision))) {
    if (row.revision !== snapshot.revision + 1) throw new Error("Checkpoint journal is incomplete");
    snapshot = applySessionCommit(snapshot, row.batch);
    checkpoint = checkpointAfter(checkpoint, snapshot, row.batch);
  }
  if (snapshot.revision !== run.revision) throw new Error("Checkpoint journal is incomplete");
  return checkpoint;
}
