import type { Database } from "../../database/index.js";
import { createScope } from "./scope.js";

/** Explicit context: ports must use the caller's transaction, never a captured pool. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type UnitOfWork = Pick<Database, "transaction">;

export function createUnitOfWork(db: Database): UnitOfWork {
  return createScope(db).unitOfWork();
}
