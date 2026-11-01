import { setTimeout as wait } from "node:timers/promises";
import type { SseSubscriber } from "../../transport/sse.js";
import { EVENT_BATCH_SIZE } from "./event.repository.js";
import type { EventService } from "./event.service.js";

export type EventStreamInput = {
  service: EventService;
  subscriber: SseSubscriber;
  conversationId: string;
  cursor: string;
};

/** 回放游标之后的一批事件; 返回本次从存储层读到的行数。 */
export async function replayEvents(input: EventStreamInput): Promise<number> {
  const batch = await input.service.readAfter({ conversationId: input.conversationId, cursor: input.cursor });
  for (const event of batch.events) {
    if (
      !input.subscriber.send({
        eventId: input.conversationId + ":" + event.sequence,
        sequence: event.sequence,
        type: event.type,
        data: event,
      })
    )
      return batch.rows;
  }
  // sequence 断档说明 outbox 丢过事件, 客户端必须重新同步而不是继续增量消费。
  if (batch.gap) input.subscriber.close();
  return batch.rows;
}

/** 持续追随事件 outbox: 有数据时低延迟轮询, 空闲时退避。 */
export async function followEvents(input: EventStreamInput) {
  let cursor = input.cursor;
  let pollMs = 50;
  while (!input.subscriber.isClosed()) {
    const count = await replayEvents({ ...input, cursor });
    if (input.subscriber.lastSequence !== "0") cursor = input.subscriber.lastSequence;
    // Keep streaming batches small; idle subscriptions back off to avoid constant database reads.
    pollMs = count > 0 ? 50 : Math.min(1000, pollMs * 2);
    if (count < EVENT_BATCH_SIZE)
      try {
        await wait(pollMs, undefined, { signal: input.subscriber.signal() });
      } catch {
        return;
      }
  }
}
