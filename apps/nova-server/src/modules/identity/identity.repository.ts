import { users } from "../../../database/index.js";
import type { Database } from "../../../database/index.js";
import type { VerifiedIdentity } from "./auth-service.js";

export function createIdentityRepository(db: Database) {
  return {
    async upsert(identity: VerifiedIdentity) {
      const [user] = await db
        .insert(users)
        .values({
          identityId: identity.identityId,
          displayName: identity.displayName,
        })
        .onConflictDoUpdate({
          target: users.identityId,
          // Local account suspension is independent from profile synchronization.
          set: { displayName: identity.displayName, updatedAt: new Date() },
        })
        .returning({ id: users.id, active: users.active });
      if (!user) throw new Error("Identity projection was not persisted");
      return user;
    },
  };
}
