import type { UiEvent } from "@nova/protocol";
import { describe, expect, it, vi } from "vitest";
import { ConversationStream, type EventSourceLike, type StreamConnection } from "./conversation-stream.js";

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closeCount = 0;

  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  message(event: UiEvent, lastEventId = "") {
    this.onmessage?.({ data: JSON.stringify(event), lastEventId } as MessageEvent<string>);
  }

  fail() {
    this.readyState = 0;
    this.onerror?.({} as Event);
  }

  close() {
    this.readyState = 2;
    this.closeCount += 1;
  }
}

function setup() {
  const sources: FakeEventSource[] = [];
  const connections: StreamConnection[] = [];
  const events: UiEvent[] = [];
  const onResync = vi.fn(async () => {});
  const onRunEnd = vi.fn();
  const stream = new ConversationStream(
    "conversation-1",
    {
      onConnection: (connection) => connections.push(connection),
      onEvent: (event) => events.push(event),
      onOpen: () => {},
      onResync,
      onRunEnd,
    },
    () => {
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    },
  );
  return { stream, sources, connections, events, onResync, onRunEnd };
}

describe("ConversationStream", () => {
  it("stays idle until send asks for a connection and shares the pending open", async () => {
    const { stream, sources, connections } = setup();
    expect(sources).toHaveLength(0);

    const first = stream.ensureConnected();
    const second = stream.ensureConnected();
    expect(first).toBe(second);
    expect(sources).toHaveLength(1);
    expect(connections).toEqual(["connecting"]);

    sources[0]!.open();
    await Promise.all([first, second]);
    expect(connections).toEqual(["connecting", "open"]);
    stream.close();
  });

  it("returns to closed when EventSource construction fails", async () => {
    const connections: StreamConnection[] = [];
    const events: UiEvent[] = [];
    const stream = new ConversationStream(
      "conversation-1",
      {
        onConnection: (connection) => connections.push(connection),
        onEvent: (event) => events.push(event),
        onOpen: () => {},
        onResync: async () => {},
        onRunEnd: () => {},
      },
      () => {
        throw new Error("EventSource unavailable");
      },
    );

    await expect(stream.ensureConnected()).rejects.toThrow("EventSource unavailable");
    expect(connections).toEqual(["connecting", "closed"]);
    expect(events).toContainEqual({
      type: "error",
      code: "SSE_CONNECT_FAILED",
      message: "EventSource unavailable",
    });
  });

  it("lets native EventSource reconnect without creating a second source", async () => {
    const { stream, sources, connections } = setup();
    const initial = stream.ensureConnected();
    sources[0]!.open();
    await initial;

    sources[0]!.fail();
    const reconnected = stream.ensureConnected();
    expect(sources).toHaveLength(1);
    sources[0]!.open();
    await reconnected;
    expect(connections).toEqual(["connecting", "open", "reconnecting", "open"]);
    stream.close();
  });

  it("keeps one stream across run.end so a queued next run cannot lose events", async () => {
    const { stream, sources, events, onRunEnd } = setup();
    const first = stream.ensureConnected();
    sources[0]!.open();
    await first;

    const runEnd = { type: "run.end", runId: "run-1", stopReason: "done" } as const;
    sources[0]!.message(runEnd);
    expect(events).toContainEqual(runEnd);
    expect(onRunEnd).toHaveBeenCalledOnce();
    expect(sources[0]!.closeCount).toBe(0);

    const second = stream.ensureConnected();
    expect(sources).toHaveLength(1);
    await second;
    stream.close();
    expect(sources[0]!.closeCount).toBe(1);
  });

  it("reloads the snapshot before replacing a stream that requests RESYNC", async () => {
    const { stream, sources, onResync } = setup();
    const opened = stream.ensureConnected();
    sources[0]!.open();
    await opened;

    sources[0]!.message({ type: "error", code: "RESYNC", message: "replay expired" });
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    expect(onResync).toHaveBeenCalledOnce();
    expect(sources[0]!.closeCount).toBe(1);
    sources[1]!.open();
    stream.close();
  });

  it("replays from the last received event when a new EventSource is created", async () => {
    const urls: string[] = [];
    const sources: FakeEventSource[] = [];
    const stream = new ConversationStream(
      "conversation-1",
      {
        onConnection: () => {},
        onEvent: () => {},
        onOpen: () => {},
        onResync: async () => {},
        onRunEnd: () => {},
      },
      (url) => {
        urls.push(url);
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
    );

    const first = stream.ensureConnected();
    sources[0]!.open();
    await first;
    sources[0]!.message({ type: "context.updated", inputTokens: 1, contextWindow: 2 }, "42");
    stream.close();

    const second = stream.ensureConnected();
    expect(urls[1]).toBe("/api/conversations/conversation-1/events?after=42");
    sources[1]!.open();
    await second;
    stream.close();
  });
});
