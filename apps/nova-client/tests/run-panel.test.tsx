import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ cancel: vi.fn(), resolve: vi.fn() }));
vi.mock('@/features/auth', () => ({ useIdentity: () => ({ identity: { identityId: 'alice' } }) }));
vi.mock('../src/features/runs/run.commands', () => ({
  cancelRun: mocks.cancel,
  respondInteraction: mocks.resolve,
}));
import { RunPanel } from '../src/features/runs/run-panel';
import { RunStatus } from '../src/features/runs/run-status';
import { useRunControls } from '../src/features/runs/run-controls';
import { initialProjection } from '../src/features/runs/run-event-reducer';
import type { RunStreamSnapshot } from '../src/features/runs/run-stream-manager';
import { snapshot } from './fixtures';
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
function Panel({ stream }: { stream: RunStreamSnapshot }) {
  const controls = useRunControls(stream);
  return (
    <>
      <RunStatus stream={stream} controls={controls} onRetry={() => {}} executionEnabled />
      <RunPanel stream={stream} controls={controls} onRetry={() => {}} />
    </>
  );
}
function mount(value: RunStreamSnapshot) {
  const client = makeClient();
  const ui = (next: RunStreamSnapshot) => (
    <QueryClientProvider client={client}>
      <Panel stream={next} />
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
  vi.useRealTimers();
});
describe('approval, cancellation and unknown outcomes', () => {
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
  ])('explains model failure %s', (reason, message) => {
    const value = stream();
    value.projection!.run = { id: 'run-1', state: 'failed', reason };
    mount(value);
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(screen.queryByRole('button', { name: '停止运行' })).toBeNull();
  });
  it('requires manual inspection for unknown results and never replays execution', () => {
    const value = stream();
    value.projection!.run!.state = 'cancelled_unconfirmed';
    mount(value);
    expect(screen.getByText('执行结果需要核实')).toBeDefined();
    expect(screen.getByRole('button', { name: '刷新核实材料' })).toBeDefined();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
