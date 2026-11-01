import { createScope, defineRepository } from "../../shared/scope.js";
import { and, desc, eq } from "drizzle-orm";
import { runnerTokens, type Database } from "../../../database/index.js";

export type RunnerTokenRow = typeof runnerTokens.$inferSelect;
export const runnerTokenRepository = defineRepository(({ db, requireTransaction }) => {
  const owned = (id: string, owner: string) => and(eq(runnerTokens.id, id), eq(runnerTokens.ownerUserId, owner));
  return {
    list: async (owner: string) =>
      db.select().from(runnerTokens).where(eq(runnerTokens.ownerUserId, owner)).orderBy(desc(runnerTokens.createdAt)),
    active: async (owner?: string) =>
      db
        .select()
        .from(runnerTokens)
        .where(and(eq(runnerTokens.status, "active"), owner ? eq(runnerTokens.ownerUserId, owner) : undefined))
        .limit(500),
    async find(id: string) {
      const [row] = await db.select().from(runnerTokens).where(eq(runnerTokens.id, id));
      return row;
    },
    async lock(id: string, owner: string) {
      requireTransaction();
      const [row] = await db.select().from(runnerTokens).where(owned(id, owner)).for("update");
      return row;
    },
    async insert(input: typeof runnerTokens.$inferInsert) {
      const [row] = await db.insert(runnerTokens).values(input).returning();
      if (!row) throw new Error("Failed to create runner token");
      return row;
    },
    async revoke(id: string, owner: string) {
      const [row] = await db
        .update(runnerTokens)
        .set({ status: "revoked", statusChangedAt: new Date(), tokenCiphertext: null })
        .where(owned(id, owner))
        .returning({ id: runnerTokens.id });
      return row;
    },
    async markRotated(id: string, owner: string, revoke: boolean) {
      await db
        .update(runnerTokens)
        .set({
          status: revoke ? "revoked" : "rotated",
          statusChangedAt: new Date(),
          rotatedAt: new Date(),
          tokenCiphertext: null,
        })
        .where(owned(id, owner));
    },
    async markUsed(id: string) {
      await db.update(runnerTokens).set({ lastUsedAt: new Date() }).where(eq(runnerTokens.id, id));
    },
  };
});
export function createRunnerTokenRepository(db: Database) {
  return createScope(db).get(runnerTokenRepository);
}
export type RunnerTokenRepository = ReturnType<typeof createRunnerTokenRepository>;
