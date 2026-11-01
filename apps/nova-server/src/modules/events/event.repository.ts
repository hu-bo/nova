import { createScope, defineRepository } from "../../shared/scope.js";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { uiEvents, type Database } from "../../../database/index.js";

export type UiEventRow = typeof uiEvents.$inferSelect;
export const EVENT_BATCH_SIZE = 256;
export type EventCursorState = { eventFloorSequence: bigint; lastEventSequence: bigint; oldestSequence: bigint | null };

export const eventRepository = defineRepository(({ db, requireTransaction }) => ({
  async listAfter({
    conversationId,
    cursor,
    limit = EVENT_BATCH_SIZE,
  }: {
    conversationId: string;
    cursor: bigint;
    limit?: number;
  }): Promise<UiEventRow[]> {
    return db
      .select()
      .from(uiEvents)
      .where(and(eq(uiEvents.conversationId, conversationId), gt(uiEvents.sequence, cursor)))
      .orderBy(asc(uiEvents.sequence))
      .limit(limit);
  },
  async oldestSequence(conversationId: string) {
    requireTransaction({ isolationLevel: "repeatable read" });
    const [row] = await db
      .select({ oldest: sql<string | null>`min(${uiEvents.sequence})::text` })
      .from(uiEvents)
      .where(eq(uiEvents.conversationId, conversationId));
    return row?.oldest ? BigInt(row.oldest) : null;
  },
}));
export function createEventRepository(db: Database) {
  return createScope(db).get(eventRepository);
}
export type EventRepository = ReturnType<typeof createEventRepository>;
