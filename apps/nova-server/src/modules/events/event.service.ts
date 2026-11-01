import type { ServiceTransaction } from "../../shared/scope.js";
import type { ConversationEventHeads, ConversationReader } from "../conversations/index.js";
import type { UiEventWriter } from "./event-writer.repository.js";
import { decimalSequenceSchema, productEventSchema, type ProductEvent } from "@nova/agent-ui-contracts";
import { DomainError } from "../../shared/domain-error.js";
import type { EventRepository, EventCursorState } from "./event.repository.js";

/** 一批事件的读取结果: 连续前缀 + 断档标记。 */
export type EventBatch = {
  /** 通过契约校验且 sequence 连续的事件; 断档时只含断档之前的前缀。 */
  events: ProductEvent[];
  /** sequence 不连续, 订阅方需要重新同步。 */
  gap: boolean;
  /** 本次从存储层读到的行数, 供 follow 循环决定退避节奏。 */
  rows: number;
};

export class EventService {
  constructor(
    private readonly repository: EventRepository,
    private readonly transaction: ServiceTransaction<{
      repository: EventRepository;
      conversations: Pick<ConversationReader, "readOwnedHead">;
    }>,
  ) {}

  cursorState(input: { conversationId: string; ownerUserId: string }): Promise<EventCursorState | null> {
    return this.transaction(
      async ({ repository, conversations }) => {
        const head = await conversations.readOwnedHead(input);
        if (!head) return null;
        return { ...head, oldestSequence: await repository.oldestSequence(input.conversationId) };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /**
   * 解析并校验订阅游标: 越过保留窗口(过早)或超前于会话头部(过晚)都视为过期。
   * Last-Event-ID 头优先于查询参数, 且必须与当前会话匹配。
   */
  async resolveCursor(input: {
    conversationId: string;
    ownerUserId: string;
    cursor?: string;
    lastEventId?: string;
  }): Promise<string> {
    const state = await this.cursorState({
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
    });
    if (!state) throw new DomainError("NOT_FOUND", "Conversation not found");
    let value = input.cursor;
    if (input.lastEventId !== undefined) {
      const [conversationId, sequence, ...extra] = input.lastEventId.split(":");
      if (conversationId !== input.conversationId || extra.length || !decimalSequenceSchema.safeParse(sequence).success)
        throw new DomainError("EVENT_CURSOR_EXPIRED", "Event cursor expired");
      value = sequence!;
    }
    const position = BigInt(value ?? state.lastEventSequence.toString());
    if (
      position < state.eventFloorSequence ||
      position > state.lastEventSequence ||
      (state.oldestSequence ? position < state.oldestSequence - 1n : position < state.lastEventSequence)
    )
      throw new DomainError("EVENT_CURSOR_EXPIRED", "Event cursor expired");
    return position.toString();
  }

  /** 读取游标之后的一批事件, 并校验 sequence 连续性。 */
  async readAfter(input: { conversationId: string; cursor: string | bigint }): Promise<EventBatch> {
    const cursor = BigInt(input.cursor);
    const rows = await this.repository.listAfter({ conversationId: input.conversationId, cursor });
    const events: ProductEvent[] = [];
    let expected = cursor + 1n;
    for (const row of rows) {
      if (row.sequence !== expected) return { events, gap: true, rows: rows.length };
      events.push(
        productEventSchema.parse({
          sequence: row.sequence.toString(),
          runId: row.runId,
          type: row.type,
          payload: row.payload,
        }),
      );
      expected = row.sequence + 1n;
    }
    return { events, gap: false, rows: rows.length };
  }
}

/** Owns the retention transaction so deletion and cursor floors commit together. */
export class EventRetentionService {
  constructor(
    private readonly transaction: ServiceTransaction<{ writer: UiEventWriter; heads: ConversationEventHeads }>,
  ) {}
  retain() {
    return this.transaction(({ writer, heads }) => writer.retain(heads));
  }
}
