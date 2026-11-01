import { createScope, defineRepository } from "../../shared/scope.js";
import { sql, type Database } from "../../../database/index.js";

export const healthRepository = defineRepository(({ db }) => {
  return {
    checkDatabase: async () => {
      await db.execute(sql`select 1`);
    },
  };
});
export function createHealthRepository(db: Database) {
  return createScope(db).get(healthRepository);
}
