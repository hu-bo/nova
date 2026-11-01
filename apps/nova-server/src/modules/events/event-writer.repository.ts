import { createScope, defineRepository } from "../../shared/scope.js";
import type { Database } from "../../../database/index.js";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { ProductEvent } from "@nova/agent-ui-contracts";
import { uiEvents } from "../../../database/index.js";
import type { ConversationEventHeads } from "../conversations/index.js";

export const eventWriter = defineRepository(({ db, requireTransaction }) => {
  const appendBatch = async (conversationId: string, events: readonly ProductEvent[]) => {
    requireTransaction();
    // Bound SQL parameters even when one native event expands into several UI events.
    for (let start = 0; start < events.length; start += 1000)
      await db.insert(uiEvents).values(
        events.slice(start, start + 1000).map((event) => ({
          conversationId,
          runId: event.runId,
          sequence: BigInt(event.sequence),
          type: event.type,
          payload: event.payload,
        })),
      );
  };
  return {
    async readRange(conversationId: string, after: bigint, through: bigint) {
      requireTransaction();
      return db
        .select({ sequence: uiEvents.sequence, runId: uiEvents.runId, type: uiEvents.type, payload: uiEvents.payload })
        .from(uiEvents)
        .where(
          and(
            eq(uiEvents.conversationId, conversationId),
            gt(uiEvents.sequence, after),
            lte(uiEvents.sequence, through),
          ),
        )
        .orderBy(asc(uiEvents.sequence));
    },
    async append(conversationId: string, event: ProductEvent) {
      await appendBatch(conversationId, [event]);
    },
    appendBatch,
    async deleteConversation(conversationId: string) {
      requireTransaction();
      await db.delete(uiEvents).where(eq(uiEvents.conversationId, conversationId));
    },
    async retain(heads: ConversationEventHeads) {
      requireTransaction();
      const { rows: lease } = await db.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(17356020, 1) as locked`,
      );
      if (!lease[0]?.locked) return;
      const expired = sql`${uiEvents.occurredAt} < now() - interval '24 hours'`;
      const candidates = await db
        .select({ id: uiEvents.conversationId })
        .from(uiEvents)
        .where(expired)
        .groupBy(uiEvents.conversationId)
        .orderBy(asc(uiEvents.conversationId));
      if (!candidates.length) return;
      const ids = candidates.map(({ id }) => id);
      // Acquire conversation locks in a stable order before touching the journal.
      // Recompute cutoffs after locking; another collector may have run meanwhile.
      await heads.lock(ids);
      const limits = await heads.retentionLimits(ids);
      const values = sql.join(
        limits.map((item) => sql`(${item.id}::uuid, ${item.sequence}::bigint)`),
        sql`, `,
      );
      const { rows } = await db.execute<{ conversation_id: string; cutoff: string }>(sql`
        with cutoffs as (
          select ${uiEvents.conversationId} as conversation_id, max(${uiEvents.sequence}) as cutoff
          from ${uiEvents} join (values ${values}) as limits(id, sequence) on limits.id = ${uiEvents.conversationId}
          where ${expired} and ${uiEvents.sequence} <= limits.sequence
          group by ${uiEvents.conversationId}
        ), deleted as (
          delete from ${uiEvents} e using cutoffs p
          where e.conversation_id = p.conversation_id and e.sequence <= p.cutoff
          returning e.conversation_id, e.sequence
        ) select conversation_id, max(sequence)::text as cutoff from deleted group by conversation_id
      `);
      await heads.advanceFloors(
        rows.map((row) => ({ conversationId: row.conversation_id, sequence: BigInt(row.cutoff) })),
      );
    },
  };
});
export function createEventWriter(db: Database) {
  return createScope(db).get(eventWriter);
}
export type UiEventWriter = ReturnType<typeof createEventWriter>;
