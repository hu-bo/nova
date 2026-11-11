import { afterEach, describe, expect, it, vi } from 'vitest';
import { SseConnection, SseParser, type SseConnectionOptions } from '../src/api/sse-client';
import { configureAuth } from '../src/api/transport';
afterEach(() => {
  vi.useRealTimers();
  configureAuth({ token: () => null, refresh: async () => false, unauthorized: () => {} });
});
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function streaming(init: RequestInit, text = '') {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      init.signal?.addEventListener(
        'abort',
        () => controller.error(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}
function options(extra: Partial<SseConnectionOptions> = {}): SseConnectionOptions {
  return {
    url: '/api/conversations/conversation-id/events',
    cursor: '7',
    onFrame: vi.fn(() => undefined),
    onStateChange: vi.fn(),
    onSnapshotRequired: vi.fn(async () => '20'),
    ...extra,
  };
}
describe('SSE wire framing and reconnection', () => {
  it('handles split CRLF, comments, inherited IDs and multiline payloads', () => {
    const parser = new SseParser();
    expect(parser.push('id: 42\r')).toEqual([]);
    expect(parser.push('\nevent: change\r\ndata: {"x":\r\n: comment\r\ndata: 1}\r\n\r')).toEqual(
      [],
    );
    expect(parser.push('\n')).toEqual([{ eventId: '42', eventName: 'change', data: { x: 1 } }]);
    expect(parser.push('data: raw\n\n')).toEqual([
      { eventId: '42', eventName: 'message', data: 'raw' },
    ]);
  });
  it('bounds each UTF-8 frame while allowing a network chunk containing many frames', () => {
    expect(new SseParser().push('data: x\n\n'.repeat(10000))).toHaveLength(10000);
    expect(() => new SseParser().push(`data: ${'中'.repeat(1400000)}\n\n`)).toThrow(
      'SSE_FRAME_TOO_LARGE',
    );
  });
  it('sends Bearer auth and both cursor forms, and transitions separately from run state', async () => {
    configureAuth({
      token: () => 'bearer-token',
      refresh: async () => false,
      unauthorized: vi.fn(),
    });
    const fetcher = vi.fn(async (url, init) => {
      expect(new URL(String(url)).searchParams.get('cursor')).toBe('7');
      expect(new Headers(init.headers).get('last-event-id')).toBe('conversation-id:7');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer bearer-token');
      return streaming(init, 'id: 8\ndata: {"sequence":"8"}\n\n');
    });
    const onFrame = vi.fn(() => '8');
    const onStateChange = vi.fn();
    const connection = new SseConnection(options({ fetchImpl: fetcher, onFrame, onStateChange }));
    await flush();
    expect(onFrame).toHaveBeenCalledOnce();
    expect(connection.currentState()).toBe('live');
    connection.shutdown();
    await flush();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('resyncs 410 and reconnects from the authoritative snapshot cursor', async () => {
    vi.useFakeTimers();
    const calls: RequestInit[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      calls.push(init);
      return calls.length === 1 ? new Response('{}', { status: 410 }) : streaming(init);
    });
    const onSnapshotRequired = vi.fn(async () => '20');
    const connection = new SseConnection(options({ fetchImpl: fetcher, onSnapshotRequired }));
    await flush();
    await vi.advanceTimersByTimeAsync(1500);
    expect(onSnapshotRequired).toHaveBeenCalledOnce();
    expect(new Headers(calls[1]!.headers).get('last-event-id')).toBe('conversation-id:20');
    connection.shutdown();
    await flush();
  });
  it('drops a buffered network read that completes after shutdown', async () => {
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    const fetcher = vi.fn(
      async () =>
        new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const onFrame = vi.fn(() => '8');
    const connection = new SseConnection(options({ fetchImpl: fetcher, onFrame }));
    await flush();
    connection.shutdown();
    bodyController.enqueue(new TextEncoder().encode('id: 8\ndata: {"sequence":"8"}\n\n'));
    await flush();
    expect(onFrame).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('stops on 403 and 404 without retrying or silently claiming a live stream', async () => {
    for (const status of [403, 404]) {
      const fetcher = vi.fn(async () => new Response('{}', { status }));
      const connection = new SseConnection(options({ fetchImpl: fetcher }));
      await flush();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(connection.currentState()).toBe('offline');
      connection.shutdown();
    }
  });
  it('expires the identity after a refreshed token is still rejected, without another refresh', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => true);
    const unauthorized = vi.fn();
    configureAuth({ token: () => 'rejected-token', refresh, unauthorized });
    const fetcher = vi.fn(async () => new Response('{}', { status: 401 }));
    const connection = new SseConnection(options({ fetchImpl: fetcher }));
    await flush();
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
    expect(unauthorized).toHaveBeenCalledOnce();
    expect(connection.currentState()).toBe('offline');
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    connection.shutdown();
  });
  it('respects Retry-After and lets disposal cancel an in-progress backoff', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '10' } }),
    );
    const connection = new SseConnection(options({ fetchImpl: fetcher }));
    await flush();
    await vi.advanceTimersByTimeAsync(9000);
    expect(fetcher).toHaveBeenCalledOnce();
    connection.shutdown();
    await vi.advanceTimersByTimeAsync(20000);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('recovers a heartbeat timeout from the last successfully applied cursor', async () => {
    vi.useFakeTimers();
    const headers: Headers[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      headers.push(new Headers(init.headers));
      return streaming(init, headers.length === 1 ? 'data: {"sequence":"8"}\n\n' : '');
    });
    const connection = new SseConnection(
      options({ fetchImpl: fetcher, heartbeatTimeoutMs: 1000, onFrame: () => '8' }),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(2500);
    expect(headers[1]?.get('last-event-id')).toBe('conversation-id:8');
    connection.shutdown();
    await flush();
  });
});
