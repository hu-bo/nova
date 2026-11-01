import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { RunStreamContext, useConversationStream } from '../src/features/runs/run-runtime.context';
import * as presentation from '../src/features/runs/run-event-reducer';
import { queryKeys } from '../src/api/query-keys';
import { event, message, snapshot, conversationId } from './fixtures';
import type { SseConnectionOptions } from '../src/api/sse-client';
const mocks = vi.hoisted(() => ({
  connections: [] as { options: SseConnectionOptions; shutdown: ReturnType<typeof vi.fn> }[],
  snapshot: vi.fn(),
}));
vi.mock('../src/api/sse-client', () => ({
  SseConnection: class {
    shutdown = vi.fn();
    constructor(options: SseConnectionOptions) {
      mocks.connections.push({ options, shutdown: this.shutdown });
    }
  },
}));
vi.mock('../src/api/generated/conversations', () => ({ getConversationSnapshot: mocks.snapshot }));
import { RunStreamManager } from '../src/features/runs/run-stream-manager';
afterEach(() => {
  mocks.connections.length = 0;
  mocks.snapshot.mockReset();
  vi.useRealTimers();
});
const frame = (type: Parameters<typeof event>[0], sequence: number, payload: unknown) => ({
  eventId: conversationId + ':' + sequence,
  eventName: type,
  data: event(type, sequence, payload),
});
describe('shared stream ownership', () => {
  it('shows idle input in the conversation from the first render through live startup', () => {
    const manager = new RunStreamManager('alice', new QueryClient());
    const input = {
      id: 'input-1',
      state: 'queued' as const,
      input: {
        mode: 'next_run' as const,
        blocks: [{ id: 'text', type: 'text' as const, text: '直接发送' }],
      },
    };
    const seeded = snapshot({ pendingInputs: [input] });
    const renders: ReturnType<typeof useConversationStream>[] = [];
    const hook = renderHook(
      () => {
        const stream = useConversationStream(conversationId, seeded);
        renders.push(stream);
        return stream;
      },
      {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(RunStreamContext.Provider, { value: manager }, children),
      },
    );
    try {
      expect(renders[0]?.projection?.pendingInputs).toEqual([]);
      expect(renders[0]?.projection?.messages).toMatchObject([
        { role: 'user', blocks: input.input.blocks },
      ]);
      act(() => {
        mocks.connections[0]!.options.onFrame(
          frame('run.changed', 1, { run: { id: 'run-1', state: 'running' } }),
        );
      });
      expect(hook.result.current.projection?.pendingInputs).toEqual([]);
      expect(hook.result.current.projection?.messages).toHaveLength(1);
    } finally {
      hook.unmount();
      manager.dispose();
    }
  });

  it('derives presentation once per published frame while validating every event', async () => {
    vi.useFakeTimers();
    const manager = new RunStreamManager('alice', new QueryClient());
    const seeded = snapshot();
    const project = vi.spyOn(presentation, 'projectRunState');
    const hook = renderHook(() => useConversationStream(conversationId, seeded), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(RunStreamContext.Provider, { value: manager }, children),
    });
    try {
      const options = mocks.connections[0]!.options;
      act(() => {
        options.onFrame(frame('message.started', 1, { message }));
      });
      project.mockClear();
      act(() => {
        for (let index = 0; index < 10; index++)
          options.onFrame(
            frame('text.delta', index + 2, {
              messageId: 'm',
              blockId: 'b',
              offset: index,
              text: 'x',
            }),
          );
      });
      expect(project).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });
      expect(project).toHaveBeenCalledOnce();
      expect(hook.result.current.projection?.messages[0]!.blocks[0]).toMatchObject({
        text: 'xxxxxxxxxx',
      });
    } finally {
      hook.unmount();
      manager.dispose();
    }
  });
  it('shares subscriptions through StrictMode replay', async () => {
    const manager = new RunStreamManager('alice', new QueryClient());
    const release = manager.acquire(conversationId, snapshot());
    release();
    const second = manager.acquire(conversationId, snapshot());
    await Promise.resolve();
    expect(mocks.connections).toHaveLength(1);
    expect(mocks.connections[0]!.shutdown).not.toHaveBeenCalled();
    second();
    await Promise.resolve();
    expect(mocks.connections[0]!.shutdown).toHaveBeenCalledOnce();
    manager.dispose();
  });
  it('batches deltas without REST requests', async () => {
    vi.useFakeTimers();
    const manager = new RunStreamManager('alice', new QueryClient());
    manager.acquire(conversationId, snapshot());
    const options = mocks.connections[0]!.options;
    options.onFrame(frame('message.started', 1, { message }));
    const listener = vi.fn();
    manager.session(conversationId).subscribe(listener);
    for (let index = 0; index < 10; index++)
      options.onFrame(
        frame('text.delta', index + 2, { messageId: 'm', blockId: 'b', offset: index, text: 'x' }),
      );
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15);
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(listener).toHaveBeenCalledOnce();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(
      manager.session(conversationId).getSnapshot().projection?.data.messages[0]?.blocks,
    ).toEqual([{ id: 'b', type: 'text', text: 'xxxxxxxxxx' }]);
    manager.dispose();
  });
  it('resync replaces cursor and data together within the account cache', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const manager = new RunStreamManager('alice', client);
    manager.acquire(conversationId, snapshot());
    mocks.snapshot.mockResolvedValue(snapshot({ cursor: '5' }));
    mocks.connections[0]!.options.onFrame(frame('usage.changed', 5, { usage: {} }));
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.session(conversationId).getSnapshot().projection).toMatchObject({
      cursor: '5',
      needsSnapshot: false,
    });
    expect(
      client.getQueryData(queryKeys.conversations.snapshot('alice', conversationId)),
    ).toMatchObject({ cursor: '5' });
    expect(
      client.getQueryData(queryKeys.conversations.snapshot('bob', conversationId)),
    ).toBeUndefined();
    manager.dispose();
  });
  it('keeps an active run subscribed after navigation and disposes it on identity change', async () => {
    const manager = new RunStreamManager('alice', new QueryClient());
    const release = manager.acquire(
      conversationId,
      snapshot({ run: { id: 'run-1', state: 'running' } }),
    );
    release();
    await Promise.resolve();
    expect(mocks.connections[0]!.shutdown).not.toHaveBeenCalled();
    manager.dispose();
    expect(mocks.connections[0]!.shutdown).toHaveBeenCalledOnce();
  });
  it('ignores a late snapshot after the conversation is released', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const manager = new RunStreamManager('alice', client);
    const release = manager.acquire(conversationId, snapshot());
    let complete!: (value: ReturnType<typeof snapshot>) => void;
    mocks.snapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    mocks.connections[0]!.options.onFrame(frame('usage.changed', 5, { usage: {} }));
    await vi.advanceTimersByTimeAsync(500);
    release();
    await Promise.resolve();
    complete(snapshot({ cursor: '5' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.connections).toHaveLength(1);
    expect(
      client.getQueryData(queryKeys.conversations.snapshot('alice', conversationId)),
    ).toBeUndefined();
    manager.dispose();
  });
  it('stops incompatible core protocols without a snapshot loop', () => {
    const manager = new RunStreamManager('alice', new QueryClient());
    manager.acquire(conversationId, snapshot());
    mocks.connections[0]!.options.onFrame({
      eventId: 'old',
      eventName: 'run.started',
      data: { protocolVersion: 1, type: 'run.started' },
    });
    expect(manager.session(conversationId).getSnapshot()).toMatchObject({
      state: 'offline',
      error: expect.stringContaining('无法识别'),
    });
    expect(mocks.snapshot).not.toHaveBeenCalled();
    manager.dispose();
  });
  it('clears a rate-limit warning after recovery', () => {
    const manager = new RunStreamManager('alice', new QueryClient());
    manager.acquire(conversationId, snapshot());
    const options = mocks.connections[0]!.options;
    options.onError?.({ status: 429, retryAfterSeconds: 10 });
    expect(manager.session(conversationId).getSnapshot().error).toContain('受到限制');
    options.onStateChange('live');
    expect(manager.session(conversationId).getSnapshot()).toMatchObject({
      state: 'live',
      error: null,
      retryAt: null,
    });
    manager.dispose();
  });
});
