import { render, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageList, type BlockRenderers } from '@nova/chat-ui';
import { initialProjection, reduceRunEvent } from '../src/features/runs/run-event-reducer';
import { event, message, snapshot } from './fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('renders only changed streaming content despite new action callbacks', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const text = vi.fn<NonNullable<BlockRenderers['text']>>(({ block }) => (
    <span>{block.type === 'text' ? block.text : ''}</span>
  ));
  const code = vi.fn<NonNullable<BlockRenderers['code']>>(() => <pre>stable code</pre>);
  const renderers: BlockRenderers = { text, code };
  let state = initialProjection(
    snapshot({
      messages: [
        {
          ...message,
          id: 'history',
          state: 'completed',
          blocks: [{ id: 'old', type: 'text', text: 'history' }],
        },
        {
          ...message,
          sequence: '2',
          blocks: [
            ...message.blocks,
            { id: 'code', type: 'code', language: 'ts', code: 'const x = 1' },
          ],
        },
      ],
    }),
  );
  const view = render(
    <MessageList messages={state.messages} renderers={renderers} onRetry={() => {}} />,
  );
  expect(text).toHaveBeenCalledTimes(2);
  expect(code).toHaveBeenCalledTimes(1);
  for (let index = 0; index < 10; index++) {
    state = reduceRunEvent(
      state,
      event('text.delta', index + 1, { messageId: 'm', blockId: 'b', offset: index, text: 'x' }),
    );
    view.rerender(
      <MessageList messages={state.messages} renderers={renderers} onRetry={() => {}} />,
    );
  }
  expect(text).toHaveBeenCalledTimes(12);
  expect(code).toHaveBeenCalledTimes(1);
});
