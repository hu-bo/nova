import type { SseEnvelope, UiEvent } from "@nova/protocol";

export type EventReplay =
  | { kind: "events"; events: SseEnvelope[] }
  | { kind: "resync" };

export interface EventHub {
  publish(conversationId: string, event: UiEvent): SseEnvelope;
  replay(conversationId: string, lastEventId?: string): EventReplay;
  subscribe(conversationId: string, listener: (event: SseEnvelope) => void): () => void;
}

interface Channel {
  nextId: number;
  buffer: SseEnvelope[];
  listeners: Set<(event: SseEnvelope) => void>;
}

export function createEventHub(capacity = 500): EventHub {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("event capacity must be positive");
  const channels = new Map<string, Channel>();

  const channel = (conversationId: string): Channel => {
    let value = channels.get(conversationId);
    if (!value) {
      value = { nextId: 1, buffer: [], listeners: new Set() };
      channels.set(conversationId, value);
    }
    return value;
  };

  return {
    publish(conversationId, event) {
      const value = channel(conversationId);
      const envelope = { id: String(value.nextId++), event };
      value.buffer.push(envelope);
      if (value.buffer.length > capacity) value.buffer.shift();
      for (const listener of value.listeners) listener(envelope);
      return envelope;
    },
    replay(conversationId, lastEventId) {
      if (!lastEventId) return { kind: "events", events: [] };
      const requested = Number(lastEventId);
      if (!Number.isSafeInteger(requested) || requested < 0) return { kind: "resync" };
      const value = channel(conversationId);
      const earliest = Number(value.buffer[0]?.id ?? value.nextId);
      const latest = value.nextId - 1;
      if (requested > latest || requested < earliest - 1) return { kind: "resync" };
      return { kind: "events", events: value.buffer.filter(item => Number(item.id) > requested) };
    },
    subscribe(conversationId, listener) {
      const value = channel(conversationId);
      value.listeners.add(listener);
      return () => value.listeners.delete(listener);
    },
  };
}
