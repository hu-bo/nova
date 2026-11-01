import { createScope, defineRepository } from "../../shared/scope.js";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { runners, type Database } from "../../../database/index.js";

export type RunnerRow = typeof runners.$inferSelect;
export interface RunnerReader {
  readWorkspace(input: { id: string; ownerUserId: string }): Promise<{ workspaceId: string | null } | undefined>;
}

export const runnerRepository = defineRepository(({ db, requireTransaction }) => {
  const owned = (id: string, owner: string) =>
    and(eq(runners.id, id), eq(runners.ownerUserId, owner), isNull(runners.revokedAt));
  return {
    list: async (owner: string) =>
      db.select().from(runners).where(eq(runners.ownerUserId, owner)).orderBy(asc(runners.runnerId)),
    async findOwned(id: string, owner: string) {
      const [row] = await db.select().from(runners).where(owned(id, owner));
      return row;
    },
    async readWorkspace(input: { id: string; ownerUserId: string }) {
      const [row] = await db
        .select({ workspaceId: runners.workspaceId })
        .from(runners)
        .where(owned(input.id, input.ownerUserId));
      return row;
    },
    async lockOwner(owner: string) {
      requireTransaction();
      await db.execute(sql`select pg_advisory_xact_lock(hashtext(${owner}))`);
    },
    async findIdentity(owner: string, runnerId: string) {
      const [row] = await db
        .select()
        .from(runners)
        .where(and(eq(runners.ownerUserId, owner), eq(runners.runnerId, runnerId)));
      return row;
    },
    async save(input: typeof runners.$inferInsert, id?: string) {
      const [row] = id
        ? await db.update(runners).set(input).where(eq(runners.id, id)).returning()
        : await db.insert(runners).values(input).returning();
      if (!row) throw new Error("Runner registration failed");
      return row;
    },
    async touch(id: string) {
      await db.update(runners).set({ lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(runners.id, id));
    },
  };
});
export function createRunnerRepository(db: Database) {
  return createScope(db).get(runnerRepository);
}
export type RunnerRepository = ReturnType<typeof createRunnerRepository>;
