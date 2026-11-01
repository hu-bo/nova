import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema/index.js";

export type Database = ReturnType<typeof createDatabase>;

export function createPool(config: PoolConfig): Pool {
  return new Pool(config);
}

export function createDatabase(pool: Pool) {
  return drizzle(pool, { schema });
}
