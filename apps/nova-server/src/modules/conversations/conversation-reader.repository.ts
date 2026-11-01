import { createScope, defineRepository } from "../../shared/scope.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Block } from "@nova/agent-ui-contracts";
import { conversations, messages, runs, type Database } from "../../../database/index.js";

export type MessageReference = { ownerUserId: string; conversationId: string; messageId: string; blockId: string };
export interface ConversationReader {
  readOwnedHead(input: {
    conversationId: string;
    ownerUserId: string;
  }): Promise<{ eventFloorSequence: bigint; lastEventSequence: bigint } | undefined>;
  readMessageBlock(input: MessageReference): Promise<Block | undefined>;
}

export const conversationReader = defineRepository(({ db }): ConversationReader => {
  return {
    async readOwnedHead(input) {
      const [row] = await db
        .select({
          eventFloorSequence: conversations.eventFloorSequence,
          lastEventSequence: conversations.lastEventSequence,
        })
        .from(conversations)
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.ownerUserId, input.ownerUserId)))
        .limit(1);
      return row;
    },
    async readMessageBlock(input) {
      const [row] = await db
        .select({ blocks: messages.blocks })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(
          and(
            eq(messages.id, input.messageId),
            eq(messages.conversationId, input.conversationId),
            eq(conversations.ownerUserId, input.ownerUserId),
          ),
        )
        .limit(1);
      return row?.blocks.find((block) => block.id === input.blockId);
    },
  };
});
export function createConversationReader(db: Database) {
  return createScope(db).get(conversationReader);
}

/** Journal retention shares the conversation lock used by append/delete. */
export const conversationEventHeads = defineRepository(({ db, requireTransaction }) => ({
  async retentionLimits(ids: readonly string[]) {
    requireTransaction();
    if (!ids.length) return [];
    return db
      .select({
        id: conversations.id,
        sequence: sql<string>`coalesce((${runs.projection}->>'cursor')::bigint, ${conversations.lastEventSequence})::text`,
      })
      .from(conversations)
      .leftJoin(
        runs,
        sql`${runs.id} = coalesce(${conversations.activeRunId}, (${conversations.metadata}->>'latestRunId')::uuid)`,
      )
      .where(inArray(conversations.id, [...ids]));
  },
  async lock(ids: readonly string[]) {
    requireTransaction();
    if (!ids.length) return;
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.id, [...ids]))
      .orderBy(asc(conversations.id))
      .for("update");
  },
  async advanceFloors(cutoffs: readonly { conversationId: string; sequence: bigint }[]) {
    requireTransaction();
    if (!cutoffs.length) return;
    const values = sql.join(
      cutoffs.map(({ conversationId, sequence }) => sql`(${conversationId}::uuid, ${sequence}::bigint)`),
      sql`, `,
    );
    await db
      .update(conversations)
      .set({ eventFloorSequence: sql`greatest(${conversations.eventFloorSequence}, cutoffs.sequence)` })
      .from(sql`(values ${values}) as cutoffs(id, sequence)`)
      .where(sql`${conversations.id} = cutoffs.id`);
  },
}));
export function createConversationEventHeads(db: Database) {
  return createScope(db).get(conversationEventHeads);
}
export type ConversationEventHeads = ReturnType<typeof createConversationEventHeads>;
