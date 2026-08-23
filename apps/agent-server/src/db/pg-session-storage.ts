import { and, asc, desc, eq } from "drizzle-orm";
import type { Entry, EntryId, SessionStorage } from "@nova/agent-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { entries, records } from "./schema.js";

export function pgSessionStorage<TSchema extends Record<string, unknown>>(
  db: PostgresJsDatabase<TSchema>,
  conversationId: string,
): SessionStorage {
  return {
    async appendEntry(sessionId, entry) {
      assertSession(sessionId, conversationId);
      await db.insert(entries).values({
        conversationId,
        id: entry.id,
        parentId: entry.parentId,
        kind: entry.kind,
        payload: entry,
        createdAt: new Date(entry.ts),
      });
    },
    async appendRecord(sessionId, record) {
      assertSession(sessionId, conversationId);
      await db.insert(records).values({
        conversationId,
        id: record.id,
        runId: record.runId,
        kind: record.kind,
        payload: record,
        createdAt: new Date(record.ts),
      });
    },
    async loadEntries(sessionId, leafId) {
      assertSession(sessionId, conversationId);
      const rows = await db.select({ payload: entries.payload }).from(entries)
        .where(eq(entries.conversationId, conversationId)).orderBy(asc(entries.seq));
      return branch(rows.map(row => row.payload), leafId);
    },
    async loadRecords(sessionId, filter) {
      assertSession(sessionId, conversationId);
      const conditions = [eq(records.conversationId, conversationId)];
      if (filter?.runId) conditions.push(eq(records.runId, filter.runId));
      if (filter?.kind) conditions.push(eq(records.kind, filter.kind));
      return db.select({ payload: records.payload }).from(records).where(and(...conditions))
        .orderBy(filter?.desc ? desc(records.seq) : asc(records.seq))
        .limit(filter?.limit ?? 2_147_483_647)
        .then(rows => rows.map(row => row.payload));
    },
  };
}

function assertSession(sessionId: string, conversationId: string): void {
  if (sessionId !== conversationId) throw new Error("session id does not match conversation id");
}

function branch(all: Entry[], leafId?: EntryId): Entry[] {
  if (all.length === 0) return [];
  const byId = new Map(all.map(entry => [entry.id, entry]));
  let current: EntryId | null = leafId ?? all[all.length - 1]!.id;
  const result: Entry[] = [];
  while (current !== null) {
    const entry = byId.get(current);
    if (!entry) throw new Error(`entry not found: ${current}`);
    result.push(entry);
    current = entry.parentId;
  }
  return result.reverse();
}
