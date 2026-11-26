import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ cancel: vi.fn(), resolve: vi.fn(), append: vi.fn() }));
vi.mock('@/api/generated/conversations', () => ({ appendConversationInput: mocks.append }));
vi.mock('@/features/auth', () => ({ useIdentity: () => ({ identity: { identityId: 'alice' } }) }));
vi.mock('../src/features/runs/run.commands', () => ({
  cancelRun: mocks.cancel,
  respondInteraction: mocks.resolve,
}));
import { RunStatus } from '../src/features/runs/run-status';
import { useRunControls } from '../src/features/runs/run-controls';
import { initialProjection, reduceRunEvent } from '../src/features/runs/run-event-reducer';
import type { RunStreamSnapshot } from '../src/features/runs/run-stream-manager';
import { event, snapshot } from './fixtures';
const stream = (): RunStreamSnapshot => ({
  state: 'live',
  error: null,
  retryAt: null,
  projection: initialProjection(
    snapshot({
      run: { id: 'run-1', state: 'running' },
    }),
  ),
});
const decision = (expiresAt: string | null) => ({
  id: 'decision-1',
  callId: 'tool-1',
  revision: 3,
  state: 'pending' as const,
  kind: 'approval' as const,
  ...(expiresAt ? { expiresAt } : {}),
  allowedScopes: ['once' as const, 'session' as const],
  toolName: 'exec',
  args: { command: 'pnpm', args: ['check'] },
  risk: 'exec' as const,
});
function makeClient() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}
function makeWrapper() {
  const client = makeClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function Status({ stream }: { stream: RunStreamSnapshot }) {
  const controls = useRunControls(stream);
  return (
    <>
      <RunStatus stream={stream} controls={controls} onRetry={() => {}} />
      <button disabled={!controls.canCancel} onClick={() => controls.cancel.mutate()}>
        触发停止
      </button>
    </>
  );
}

afterEach(() => {
  cleanup();
  mocks.cancel.mockReset();
  mocks.resolve.mockReset();
  mocks.append.mockReset();
  vi.useRealTimers();
});

describe('run status and controls', () => {
  it('shows a queued input, then waits for the server to confirm cancellation', async () => {
    mocks.cancel.mockResolvedValue({});
    const value = stream();
    const queued = initialProjection(
      snapshot({
        pendingInputs: [
          {
            id: 'input-1',
            state: 'queued',
            input: { mode: 'next_run', blocks: [{ id: 'text', type: 'text', text: '开始' }] },
          },
        ],
      }),
    );
    const view = render(<Status stream={{ ...value, projection: queued }} />, {
      wrapper: makeWrapper(),
    });
    expect(screen.getByRole('status').textContent).toBe('等待运行');

    view.rerender(<Status stream={value} />);
    expect(screen.getByRole('status').textContent).toBe('正在运行');
    const stop = screen.getByRole<HTMLButtonElement>('button', { name: '触发停止' });
    await userEvent.click(stop);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('正在请求停止，等待设备确认'),
    );
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(stop.disabled).toBe(true);

    const projection = initialProjection(snapshot({ run: { id: 'run-1', state: 'cancelled' } }));
    view.rerender(<Status stream={{ ...value, projection }} />);
    expect(screen.getByRole('status').textContent).toBe('已停止');
  });

  it('shows the status of the next run after a failure', () => {
    const value = stream();
    const view = render(<Status stream={value} />, { wrapper: makeWrapper() });
    const failed = reduceRunEvent(
      value.projection!,
      event('run.changed', 1, { run: { id: 'run-1', state: 'failed', reason: 'STEP_LIMIT' } }),
    );
    view.rerender(<Status stream={{ ...value, projection: failed }} />);
    expect(screen.getByRole('status').textContent).toBe('运行失败');

    const next = reduceRunEvent(
      failed,
      event('run.changed', 2, { run: { id: 'run-2', state: 'running' } }),
    );
    view.rerender(<Status stream={{ ...value, projection: next }} />);
    expect(screen.getByRole('status').textContent).toBe('正在运行');
  });

  it('expires an open decision on timeout without auto-approval', async () => {
    vi.useFakeTimers();
    const value = stream();
    value.projection!.decisions = [decision(new Date(Date.now() + 1500).toISOString())];
    const { result } = renderHook(() => useRunControls(value), { wrapper: makeWrapper() });
    expect(result.current.remaining).toBeGreaterThan(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.remaining).toBe(0);
    expect(mocks.resolve).not.toHaveBeenCalled();
    await act(async () => {
      await expect(
        result.current.resolve.mutateAsync({ kind: 'approval', decision: 'allow' }),
      ).rejects.toThrow('Expired decision');
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it('submits the displayed revision and reuses an intent after a failed decision request', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({});
    const value = stream();
    value.projection!.decisions = [
      {
        ...decision(null),
        message: '同一条助手消息中包含 3 次相同调用，请确认。',
        allowedScopes: ['once'],
      },
    ];
    const { result } = renderHook(() => useRunControls(value), { wrapper: makeWrapper() });
    expect(result.current.request).toMatchObject({
      kind: 'approval',
      decisionId: 'decision-1',
      toolName: 'exec',
      risk: 'exec',
      message: '同一条助手消息中包含 3 次相同调用，请确认。',
      allowedScopes: ['once'],
    });
    await act(async () => {
      await expect(
        result.current.resolve.mutateAsync({ kind: 'approval', decision: 'allow' }),
      ).rejects.toThrow('network');
    });
    await act(async () => {
      await result.current.resolve.mutateAsync({ kind: 'approval', decision: 'allow' });
    });
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.resolve.mock.calls[0]![2]).toMatchObject({
      expectedRevision: 3,
      response: { kind: 'approval', decision: 'allow', scope: 'once' },
    });
    expect(mocks.resolve.mock.calls[1]![3]).toBe(mocks.resolve.mock.calls[0]![3]);
  });

  it('continues from saved progress and reuses the same intent after a failed request', async () => {
    mocks.append.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({});
    const value = stream();
    const exhausted = initialProjection(
      snapshot({ run: { id: 'run-1', state: 'budget_exhausted', reason: 'TOOL_LIMIT' } }),
    );
    const { result, rerender } = renderHook((next) => useRunControls(next), {
      initialProps: { ...value, projection: exhausted },
      wrapper: makeWrapper(),
    });
    const configuration = {
      backendId: 'nova',
      modelId: null,
      mode: 'build' as const,
      budget: { maxSteps: 2 },
    };
    await act(async () => {
      await expect(result.current.continueRun.mutateAsync(configuration)).rejects.toThrow(
        'network',
      );
    });
    await act(async () => {
      await result.current.continueRun.mutateAsync(configuration);
    });
    expect(mocks.append).toHaveBeenCalledTimes(2);
    expect(mocks.append).toHaveBeenNthCalledWith(
      2,
      exhausted.conversationId,
      {
        mode: 'next_run',
        blocks: [
          {
            id: 'text',
            type: 'text',
            text: '继续上轮尚未完成的任务，从已保存的进度接着处理。',
          },
        ],
        configuration,
      },
      { idempotencyKey: expect.any(String) },
    );
    expect(mocks.append.mock.calls[1]?.[2]).toEqual(mocks.append.mock.calls[0]?.[2]);
    await waitFor(() => expect(result.current.continueRun.isSuccess).toBe(true));

    const projection = reduceRunEvent(
      exhausted,
      event('run.changed', 1, { run: { id: 'run-2', state: 'running' } }),
    );
    rerender({ ...value, projection });
    await waitFor(() => expect(result.current.continueRun.isIdle).toBe(true));
  });
});
