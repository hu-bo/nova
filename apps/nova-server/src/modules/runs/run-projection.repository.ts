import { applyEvent, productEventSchema, type Snapshot } from "@nova/agent-ui-contracts";
import { eventWriter } from "../events/index.js";
import { defineRepository } from "../../shared/scope.js";

/** A materialized projection plus its durable journal suffix is the current state. */
export const runProjectionReader = defineRepository({ events: eventWriter }, ({ events, requireTransaction }) => ({
  async read(conversation: { id: string; lastEventSequence: bigint }, projection: Snapshot): Promise<Snapshot> {
    requireTransaction();
    let current = projection;
    for (const row of await events.readRange(
      conversation.id,
      BigInt(projection.cursor),
      conversation.lastEventSequence,
    )) {
      current = applyEvent(current, productEventSchema.parse({ ...row, sequence: row.sequence.toString() }));
    }
    if (BigInt(current.cursor) !== conversation.lastEventSequence) throw new Error("Projection journal is incomplete");
    return current;
  },
}));
export type RunProjectionReader = import("../../shared/scope.js").Scoped<{
  read(conversation: { id: string; lastEventSequence: bigint }, projection: Snapshot): Promise<Snapshot>;
}>;
