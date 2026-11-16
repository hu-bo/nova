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
import { RunPanel } from '../src/features/runs/run-panel';
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
// 状态行与面板不再自带 mutation 状态：页面把共享的 useRunControls 实例同时喂给
// Chat（停止/决策浮层）、标题栏 RunStatus（状态行/停止/重连）与 RunPanel（倒计时摘要），
// 测试沿用同样的组合方式。
function Panel({
  stream,
  onRetry,
}: {
  stream: RunStreamSnapshot;
  onRetry: () => Promise<boolean>;
}) {
  const controls = useRunControls(stream);
  return (
    <>
      <RunStatus stream={stream} controls={controls} onRetry={() => {}} executionEnabled />
      <RunPanel stream={stream} controls={controls} onRetry={onRetry} />
    </>
  );
}
function mount(value: RunStreamSnapshot, onRetry = async () => true) {
  const client = makeClient();
  const ui = (next: RunStreamSnapshot) => (
    <QueryClientProvider client={client}>
      <Panel stream={next} onRetry={onRetry} />
    </QueryClientProvider>
  );
  return { ...render(ui(value)), ui };
}
function mountControls(value: RunStreamSnapshot) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={makeClient()}>{children}</QueryClientProvider>
  );
  return renderHook(() => useRunControls(value), { wrapper });
}
afterEach(() => {
  cleanup();
  mocks.cancel.mockReset();
  mocks.resolve.mockReset();
  mocks.append.mockReset();
  vi.useRealTimers();
});
describe('approval, cancellation and unknown outcomes', () => {
  it('shows that the first message is waiting to start until a run begins', () => {
    const value = stream();
    value.projection = initialProjection(
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
    const view = mount(value);
    expect(screen.getByText('等待运行')).toBeDefined();
    expect(screen.queryByRole('button', { name: '停止运行' })).toBeNull();

    value.projection = initialProjection(snapshot({ run: { id: 'run-1', state: 'running' } }));
    view.rerender(view.ui(value));
    expect(screen.getByText('正在运行')).toBeDefined();
    expect(screen.queryByText('等待运行')).toBeNull();
  });
  it('does not approve an expired decision or make any automatic request', async () => {
    const value = stream();
    value.projection!.decisions = [decision(new Date(Date.now() - 1000).toISOString())];
    mount(value);
    expect(screen.getByText('授权已过期')).toBeDefined();
    // 裁决 UI 已移入 Chat 决策浮层；面板不再提供“允许执行”按钮。
    expect(screen.queryByRole('button', { name: '允许执行' })).toBeNull();
    const { result } = mountControls(value);
    await act(async () => {
      await expect(
        result.current.resolve.mutateAsync({ kind: 'approval', decision: 'allow' }),
      ).rejects.toThrow('Expired decision');
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it('expires an open decision on timeout without auto-approval', async () => {
    vi.useFakeTimers();
    const value = stream();
    value.projection!.decisions = [decision(new Date(Date.now() + 1500).toISOString())];
    const { result } = mountControls(value);
    expect(result.current.remaining).toBeGreaterThan(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.remaining).toBe(0);
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
    value.projection!.decisions = [decision(null)];
    const { result } = mountControls(value);
    expect(result.current.request).toMatchObject({
      kind: 'approval',
      decisionId: 'decision-1',
      toolName: 'exec',
      risk: 'exec',
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
  it('keeps cancellation pending until a terminal server event confirms the result', async () => {
    mocks.cancel.mockResolvedValue({});
    const value = stream();
    const view = mount(value);
    await userEvent.click(screen.getByRole('button', { name: '停止运行' }));
    await waitFor(() => expect(screen.getByText('正在请求停止，等待设备确认')).toBeDefined());
    expect((screen.getByRole('button', { name: '停止运行' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    const settled = {
      ...value,
      projection: {
        ...value.projection!,
        run: { id: 'run-1', state: 'cancelled' as const },
      },
    };
    view.rerender(view.ui(settled));
    expect(screen.getByText('已停止')).toBeDefined();
    expect(screen.queryByRole('button', { name: '停止运行' })).toBeNull();
  });
  it.each([
    ['MODEL_RATE_LIMITED', '模型服务限流或额度不足，请检查配额或切换模型。'],
    ['MODEL_AUTH_FAILED', '模型服务认证失败，请检查模型的 API 密钥和访问权限。'],
    ['MODEL_REQUEST_FAILED', '模型请求失败，请检查模型配置或稍后重试。'],
    ['STEP_LIMIT', '已达到本轮执行步数上限，任务尚未完成。可以发送“继续”，接着当前进度处理。'],
    ['TOOL_LIMIT', '已达到本轮工具调用次数上限，任务尚未完成。可以发送“继续”，接着当前进度处理。'],
  ])('explains run failure %s from a saved snapshot', (reason, message) => {
    const value = stream();
    value.projection = initialProjection(
      snapshot({ run: { id: 'run-1', state: 'failed', reason } }),
    );
    mount(value);
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(screen.queryByRole('button', { name: '停止运行' })).toBeNull();
  });
  it.each([undefined, 'UNRECOGNIZED_ERROR'])(
    'explains failures with an unmapped reason: %s',
    (reason) => {
      const value = stream();
      value.projection!.run = { id: 'run-1', state: 'failed', ...(reason ? { reason } : {}) };
      mount(value);
      expect(screen.getByRole('alert').textContent).toBe(
        '本轮运行失败，可以发送消息继续处理或稍后重试。',
      );
    },
  );
  it('shows step exhaustion from the live stream and clears it when another run starts', () => {
    const value = stream();
    const view = mount(value);
    value.projection = reduceRunEvent(
      value.projection!,
      event('run.changed', 1, { run: { id: 'run-1', state: 'failed', reason: 'STEP_LIMIT' } }),
    );
    view.rerender(view.ui(value));
    expect(screen.getByRole('alert').textContent).toContain('已达到本轮执行步数上限');
    expect(screen.queryByRole('button', { name: '停止运行' })).toBeNull();

    value.projection = reduceRunEvent(
      value.projection,
      event('run.changed', 2, { run: { id: 'run-2', state: 'running' } }),
    );
    view.rerender(view.ui(value));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('正在运行')).toBeDefined();
  });
  it('reports evidence refresh progress without treating it as execution confirmation', async () => {
    const value = stream();
    value.projection!.run!.state = 'cancelled_unconfirmed';
    let finishRefresh!: (success: boolean) => void;
    const onRetry = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise((resolve) => (finishRefresh = resolve)))
      .mockResolvedValueOnce(true);
    mount(value, onRetry);
    expect(screen.getByText('执行结果需要核实')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: '刷新核实材料' }));
    expect(
      (screen.getByRole('button', { name: '正在刷新核实材料…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => finishRefresh(false));
    expect(screen.getByText('未能刷新核实材料，请稍后重试。')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: '刷新核实材料' }));
    expect(screen.getByText('已刷新会话记录，执行结果仍需人工核实。')).toBeDefined();
    expect(screen.getByText('执行结果需要核实')).toBeDefined();
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it('continues an exhausted run once, without replaying the original request or treating it as a failure', async () => {
    mocks.append.mockResolvedValue({});
    const value = stream();
    value.projection = initialProjection(
      snapshot({ run: { id: 'run-1', state: 'budget_exhausted', reason: 'STEP_LIMIT' } }),
    );
    const view = mount(value);
    expect(screen.getAllByText('预算耗尽，任务未完成').length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: '停止运行' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '继续任务' }));
    await waitFor(() => expect(mocks.append).toHaveBeenCalledTimes(1));
    expect(mocks.append.mock.calls[0]?.[1]).toMatchObject({
      mode: 'next_run',
      blocks: [{ type: 'text', text: '继续上轮尚未完成的任务，从已保存的进度接着处理。' }],
    });
    expect((screen.getByRole('button', { name: '正在继续…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    value.projection = reduceRunEvent(
      value.projection!,
      event('run.changed', 1, { run: { id: 'run-2', state: 'running' } }),
    );
    view.rerender(view.ui(value));
    expect(screen.queryByRole('button', { name: '继续任务' })).toBeNull();
  });
  it('reuses the continuation intent after a failed request', async () => {
    mocks.append.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({});
    const value = stream();
    value.projection = initialProjection(
      snapshot({ run: { id: 'run-1', state: 'budget_exhausted', reason: 'TOOL_LIMIT' } }),
    );
    const { result } = mountControls(value);
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
    expect(mocks.append.mock.calls[1]?.[1].configuration.budget).toEqual({ maxSteps: 2 });
    expect(mocks.append.mock.calls[1]?.[2]).toEqual(mocks.append.mock.calls[0]?.[2]);
  });
});
