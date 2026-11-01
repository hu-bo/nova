import { createScope, defineRepository } from "../../shared/scope.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { remoteConnections, type Database } from "../../../database/index.js";

export type RemoteConnectionRow = typeof remoteConnections.$inferSelect;
type RemoteInsert = typeof remoteConnections.$inferInsert;
const owned = (id: string, owner: string) =>
  and(eq(remoteConnections.id, id), eq(remoteConnections.ownerUserId, owner), isNull(remoteConnections.deletedAt));

export const remoteRepository = defineRepository(({ db }) => {
  return {
    async list(owner: string) {
      return db
        .select()
        .from(remoteConnections)
        .where(and(eq(remoteConnections.ownerUserId, owner), isNull(remoteConnections.deletedAt)))
        .orderBy(desc(remoteConnections.createdAt));
    },
    async get(id: string, owner: string) {
      const [row] = await db.select().from(remoteConnections).where(owned(id, owner)).limit(1);
      return row;
    },
    async create(input: RemoteInsert) {
      const [row] = await db.insert(remoteConnections).values(input).returning();
      if (!row) throw new Error("Failed to persist SSH connection");
      return row;
    },
    async update(id: string, owner: string, patch: Partial<RemoteInsert>) {
      const [row] = await db
        .update(remoteConnections)
        .set({ ...patch, updatedAt: new Date() })
        .where(owned(id, owner))
        .returning();
      return row;
    },
    async remove(id: string, owner: string) {
      const [row] = await db
        .update(remoteConnections)
        .set({ deletedAt: new Date(), credentialCiphertext: "", passphraseCiphertext: null, updatedAt: new Date() })
        .where(owned(id, owner))
        .returning({ id: remoteConnections.id });
      return row;
    },
  };
});
export function createRemoteRepository(db: Database) {
  return createScope(db).get(remoteRepository);
}
export type RemoteRepository = ReturnType<typeof createRemoteRepository>;
