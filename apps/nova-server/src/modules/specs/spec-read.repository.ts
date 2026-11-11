import { and, asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import { pendingInputs, projects, runs, specs, specTaskAttempts } from "../../../database/index.js";
import { defineRepository } from "../../shared/scope.js";

export const specReadRepository = defineRepository(({ db, requireTransaction }) => ({
  async findOwnedProject(projectId: string, ownerId: string) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, ownerId), isNull(projects.deletedAt)))
      .limit(1);
    return project;
  },
  async list(projectId: string, ownerId: string, limit: number, cursor?: { updatedAt: Date; id: string }) {
    return db
      .select({
        id: specs.id,
        projectId: specs.projectId,
        title: specs.title,
        currentRevision: specs.currentRevision,
        conversationId: specs.conversationId,
        updatedAt: specs.updatedAt,
      })
      .from(specs)
      .innerJoin(projects, eq(projects.id, specs.projectId))
      .where(
        and(
          eq(specs.projectId, projectId),
          eq(projects.ownerUserId, ownerId),
          isNull(projects.deletedAt),
          cursor
            ? or(
                lt(specs.updatedAt, cursor.updatedAt),
                and(eq(specs.updatedAt, cursor.updatedAt), lt(specs.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(specs.updatedAt), desc(specs.id))
      .limit(limit + 1);
  },
  async findOwnedSpec(projectId: string, specId: string, ownerId: string) {
    const [spec] = await db
      .select({ id: specs.id })
      .from(specs)
      .innerJoin(projects, eq(projects.id, specs.projectId))
      .where(
        and(
          eq(specs.id, specId),
          eq(specs.projectId, projectId),
          eq(projects.ownerUserId, ownerId),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);
    return spec;
  },
  async listAttempts(specId: string, revision: number, taskKey?: string, cursor?: string) {
    return db
      .select({ attempt: specTaskAttempts, runId: pendingInputs.runId, runState: runs.state })
      .from(specTaskAttempts)
      .innerJoin(pendingInputs, eq(pendingInputs.id, specTaskAttempts.pendingInputId))
      .leftJoin(runs, eq(runs.id, pendingInputs.runId))
      .where(
        and(
          eq(specTaskAttempts.specId, specId),
          eq(specTaskAttempts.revision, revision),
          taskKey ? eq(specTaskAttempts.taskKey, taskKey) : undefined,
          cursor ? lt(specTaskAttempts.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(specTaskAttempts.createdAt), desc(specTaskAttempts.id))
      .limit(51);
  },
  async latestAttemptsByTask(specId: string, revision: number) {
    const tx = requireTransaction();
    const attempts = await tx
      .selectDistinctOn([specTaskAttempts.taskKey], {
        id: specTaskAttempts.id,
        taskKey: specTaskAttempts.taskKey,
        releasedAt: specTaskAttempts.releasedAt,
        inputStatus: pendingInputs.status,
        runId: pendingInputs.runId,
        runState: runs.state,
      })
      .from(specTaskAttempts)
      .innerJoin(pendingInputs, eq(pendingInputs.id, specTaskAttempts.pendingInputId))
      .leftJoin(runs, eq(runs.id, pendingInputs.runId))
      .where(and(eq(specTaskAttempts.specId, specId), eq(specTaskAttempts.revision, revision)))
      .orderBy(asc(specTaskAttempts.taskKey), desc(specTaskAttempts.createdAt), desc(specTaskAttempts.id));
    return new Map(attempts.map((attempt) => [attempt.taskKey, attempt]));
  },
}));
