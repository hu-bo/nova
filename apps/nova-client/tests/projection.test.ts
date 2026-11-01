import { describe, expect, it } from 'vitest';
import { messageSchema, type QueuedInput } from '@nova/agent-ui-contracts';
import {
  initialProjection,
  reduceRunEvent,
  messageView,
} from '../src/features/runs/run-event-reducer';
import { conversationId, event, message, snapshot } from './fixtures';
describe('shared projection in the chat view', () => {
  const input: QueuedInput = {
    id: 'input-1',
    state: 'queued',
    input: { mode: 'next_run', blocks: [{ id: 'text', type: 'text', text: '直接发送' }] },
  };
  const userMessage = {
    ...message,
    id: 'user-message',
    role: 'user' as const,
    state: 'completed' as const,
    blocks: input.input.blocks,
  };

  it('shows an idle submission in the conversation instead of the queue', () => {
    const state = reduceRunEvent(
      initialProjection(snapshot()),
      event('input.queued', 1, { input }),
    );
    expect(state.pendingInputs).toEqual([]);
    expect(state.data.pendingInputs).toEqual([input]);
    expect(state.messages).toMatchObject([{ role: 'user', blocks: input.input.blocks }]);
  });

  it('queues follow-up input while a run is active', () => {
    const state = reduceRunEvent(
      initialProjection(
        snapshot({ run: { id: 'run-1', state: 'running' }, messages: [userMessage] }),
      ),
      event('input.queued', 1, { input }),
    );
    expect(state.pendingInputs).toEqual([input]);
    expect(state.messages).toHaveLength(1);
  });

  it('keeps the starting message out of the queue through run startup and snapshot refresh', () => {
    let state = initialProjection(snapshot({ pendingInputs: [input] }));
    const createdAt = state.messages[0]?.createdAt;
    state = reduceRunEvent(
      state,
      event('run.changed', 1, { run: { id: 'run-1', state: 'running' } }),
    );
    state = reduceRunEvent(state, event('input.queued', 2, { input: { ...input, id: 'input-2' } }));
    expect(state.messages).toMatchObject([{ role: 'user', createdAt }]);
    expect(state.pendingInputs.map((item) => item.id)).toEqual(['input-2']);
    state = initialProjection(
      snapshot({
        cursor: '2',
        run: { id: 'run-1', state: 'running' },
        pendingInputs: [input, { ...input, id: 'input-2' }],
      }),
      state,
    );
    expect(state.messages).toMatchObject([{ role: 'user', createdAt }]);
    expect(state.pendingInputs.map((item) => item.id)).toEqual(['input-2']);
  });

  it.each(['consume-first', 'commit-first'])(
    'reconciles the starting message without gaps or duplicates: %s',
    (order) => {
      let state = initialProjection(snapshot({ pendingInputs: [input] }));
      state = reduceRunEvent(
        state,
        event('run.changed', 1, { run: { id: 'run-1', state: 'running' } }),
      );
      const payloads = {
        'input.consumed': {
          input: { ...input, state: 'consumed', runId: 'run-1', messageId: userMessage.id },
        },
        'message.committed': { message: userMessage },
      };
      const types =
        order === 'consume-first'
          ? (['input.consumed', 'message.committed'] as const)
          : (['message.committed', 'input.consumed'] as const);
      types.forEach((type, index) => {
        state = reduceRunEvent(state, event(type, index + 2, payloads[type]));
        expect(state.needsSnapshot).toBe(false);
        expect(state.pendingInputs).toEqual([]);
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0]).toMatchObject({ role: 'user', blocks: input.input.blocks });
      });
      expect(state.startingInput).toBeNull();
      expect(state.messages[0]?.id).toBe(userMessage.id);
    },
  );

  it('restores a reserved input in the conversation and leaves other inputs queued', () => {
    const reserved = { ...input, runId: 'run-1', messageId: userMessage.id };
    const state = initialProjection(
      snapshot({
        run: { id: 'run-1', state: 'running' },
        pendingInputs: [reserved, { ...input, id: 'input-2' }],
      }),
    );
    expect(state.messages).toMatchObject([{ id: userMessage.id, role: 'user' }]);
    expect(state.pendingInputs.map((item) => item.id)).toEqual(['input-2']);
  });

  it.each(['input.removed', 'input.rejected'] as const)(
    'clears a starting preview on %s',
    (type) => {
      const state = reduceRunEvent(
        initialProjection(snapshot({ pendingInputs: [input] })),
        event(type, 1, {
          input: { ...input, state: type === 'input.removed' ? 'removed' : 'rejected' },
          ...(type === 'input.rejected'
            ? { error: { code: 'UNAVAILABLE', message: '发送失败' } }
            : {}),
        }),
      );
      expect(state.messages).toEqual([]);
      expect(state.pendingInputs).toEqual([]);
    },
  );

  it('promotes only the first queued input when the active run finishes', () => {
    let state = initialProjection(
      snapshot({
        run: { id: 'run-1', state: 'running' },
        messages: [userMessage],
        pendingInputs: [input, { ...input, id: 'input-2' }],
      }),
    );
    state = reduceRunEvent(
      state,
      event('run.changed', 1, { run: { id: 'run-1', state: 'succeeded' } }),
    );
    expect(state.messages).toHaveLength(2);
    expect(state.pendingInputs.map((item) => item.id)).toEqual(['input-2']);
  });

  it('keeps blocked execution visible in the queue', () => {
    const state = initialProjection(
      snapshot({ run: { id: 'run-1', state: 'cancelled_unconfirmed' }, pendingInputs: [input] }),
    );
    expect(state.pendingInputs).toEqual([input]);
    expect(state.messages).toEqual([]);
  });

  it('retains unrelated messages and blocks while text and tool state change', () => {
    let state = initialProjection(
      snapshot({
        messages: [
          {
            ...message,
            id: 'history',
            state: 'completed',
            sequence: '1',
            blocks: [{ id: 'call', type: 'tool_call', callId: 'call', name: 'read', args: {} }],
          },
          {
            ...message,
            sequence: '2',
            blocks: [
              ...message.blocks,
              { id: 'code', type: 'code', language: 'ts', code: 'const x = 1;' },
            ],
          },
        ],
      }),
    );
    const history = state.messages[0],
      code = state.messages[1]!.blocks[1];
    state = reduceRunEvent(
      state,
      event('text.delta', 1, { messageId: 'm', blockId: 'b', offset: 0, text: 'new' }),
    );
    expect(state.messages[0]).toBe(history);
    expect(state.messages[1]!.blocks[1]).toBe(code);
    const streaming = state.messages[1];
    state = reduceRunEvent(
      state,
      event('tool.changed', 2, {
        operation: { id: 'operation', callId: 'call', state: 'running' },
      }),
    );
    expect(state.messages[0]).not.toBe(history);
    expect(state.messages[0]!.blocks[0]).toMatchObject({ status: 'running' });
    expect(state.messages[1]).toBe(streaming);
    const historicalTool = state.messages[0];
    state = reduceRunEvent(
      state,
      event('tool.output', 3, {
        operationId: 'operation',
        channel: 'stdout',
        offset: 0,
        text: 'log',
      }),
    );
    expect(state.messages[0]).toBe(historicalTool);
    expect(state.messages[1]).toBe(streaming);
  });
  it('keeps stable message/block identity through deltas and final commits', () => {
    let state = initialProjection(snapshot());
    state = reduceRunEvent(state, event('message.started', 1, { message }));
    const delta = event('text.delta', 2, {
      messageId: 'm',
      blockId: 'b',
      offset: 0,
      text: '你好😀',
    });
    state = reduceRunEvent(state, delta);
    expect(reduceRunEvent(state, delta)).toBe(state);
    expect(state.messages[0]?.blocks).toEqual([{ id: 'b', type: 'text', text: '你好😀' }]);
    state = reduceRunEvent(
      state,
      event('message.committed', 3, {
        message: {
          ...message,
          state: 'completed',
          blocks: [{ id: 'b', type: 'text', text: '完成' }],
        },
      }),
    );
    expect(state.messages[0]).toMatchObject({
      id: 'm',
      status: 'done',
      blocks: [{ id: 'b', type: 'text', text: '完成' }],
    });
    expect(
      reduceRunEvent(
        state,
        event('text.delta', 4, { messageId: 'm', blockId: 'b', offset: 2, text: '迟到' }),
      ).needsSnapshot,
    ).toBe(true);
  });
  it('retains an accepted cursor on gaps and handles bigint cursors', () => {
    const state = initialProjection(snapshot({ cursor: '9007199254740993' }));
    expect(
      reduceRunEvent(state, event('message.started', '9007199254740995', { message })),
    ).toMatchObject({ cursor: state.cursor, needsSnapshot: true });
    expect(
      reduceRunEvent(state, event('message.started', '9007199254740994', { message })).cursor,
    ).toBe('9007199254740994');
  });
  it('refresh preserves loaded history, live logs and unknown custom fallback', () => {
    const complete = {
      ...message,
      state: 'completed' as const,
      blocks: [
        {
          id: 'custom',
          type: 'custom' as const,
          name: 'other-backend',
          data: { value: true },
          fallback: '可读内容',
        },
      ],
    };
    const before = initialProjection(snapshot({ messages: [complete] }));
    const after = initialProjection(
      snapshot({
        cursor: '2',
        messages: [{ ...message, id: 'next', sequence: '2' }],
        operations: [
          {
            id: 'operation',
            callId: 'call',
            state: 'running',
            stdout: { text: '尾部', startOffset: 100, nextOffset: 102 },
          },
        ],
      }),
      before,
    );
    expect(after.messages).toHaveLength(2);
    expect(after.messages[0]?.blocks[0]).toMatchObject({ type: 'custom', fallback: '可读内容' });
    expect(after.toolOutputs.operation).toMatchObject({ stdout: '尾部', truncated: true });
  });
  it('maps file references and derives tool state without backend names', () => {
    const value = messageSchema.parse({
      ...message,
      blocks: [
        { id: 'call', type: 'tool_call', callId: 'logical', name: 'some-tool', args: {} },
        {
          id: 'file',
          type: 'file',
          attachment: {
            ref: { kind: 'ssh', remoteConnectionId: 'remote', path: 'src/a.ts' },
            name: 'a.ts',
            mimeType: 'text/plain',
            size: 10,
          },
        },
      ],
    });
    expect(
      messageView(value, conversationId, [{ id: 'attempt', callId: 'logical', state: 'succeeded' }])
        ?.blocks,
    ).toMatchObject([
      { id: 'call', status: 'ok' },
      { id: 'file', path: 'src/a.ts' },
    ]);
  });
});
