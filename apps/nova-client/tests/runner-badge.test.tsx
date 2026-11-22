import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/api-error';

const mocks = vi.hoisted(() => ({
  listRunners: vi.fn(),
  listRunnerTokens: vi.fn(),
  getProjectBinding: vi.fn(),
  bind: vi.fn(),
}));

vi.mock('@/api/generated/runners', () => ({
  listRunners: mocks.listRunners,
  listRunnerTokens: mocks.listRunnerTokens,
  listRunnerFiles: vi.fn(),
  createRunnerToken: vi.fn(),
  revokeRunnerToken: vi.fn(),
  rotateRunnerToken: vi.fn(),
}));
vi.mock('../src/features/runners/use-runner-connection', () => ({
  useRunnerConnection: () => ({
    data: { endpoint: 'http://127.0.0.1:9203/api' },
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/api/generated/projects', () => ({
  getProjectBinding: mocks.getProjectBinding,
  bindProjectEnvironment: mocks.bind,
}));
vi.mock('@/features/auth', () => ({ useIdentity: () => ({ identity: { identityId: 'alice' } }) }));
// 弹窗本体（RunnerManager）单独测；这里用桩组件复刻它的选择契约：
// 成功关闭、失败把错误留在弹窗内展示。
vi.mock('../src/features/settings/runner/runner-manager-dialog', async () => {
  const { useState } = await vi.importActual<typeof import('react')>('react');
  return {
    RunnerManagerDialog: ({
      title,
      selectedRunnerId,
      selectionHint,
      onSelect,
      onClose,
    }: {
      title?: string;
      selectedRunnerId?: string;
      selectionHint?: string;
      onSelect?: (runnerId: string) => void | Promise<unknown>;
      onClose: () => void;
    }) => {
      const [error, setError] = useState<unknown>(null);
      async function pick(runnerId: string) {
        if (!onSelect) return;
        setError(null);
        try {
          await onSelect(runnerId);
          onClose();
        } catch (catched) {
          setError(catched);
        }
      }
      return (
        <div role="dialog" aria-label={title}>
          <span>当前 {selectedRunnerId}</span>
          {selectionHint ? <p>{selectionHint}</p> : null}
          {onSelect ? <button onClick={() => void pick('runner-2')}>选择 runner-2</button> : null}
          {error instanceof Error ? <p role="alert">{error.message}</p> : null}
          <button onClick={onClose}>关闭</button>
        </div>
      );
    },
  };
});

import { RunnerBadge } from '../src/features/conversations/runner-badge';
import { RunnerManager } from '../src/features/settings/runner/runner-manager';

const offlineRunner = {
  id: 'runner-1',
  runnerId: 'mac-lab',
  workspaceId: 'ws-1',
  capabilities: [],
  lastSeenAt: null,
  revokedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  bootId: null,
};
const onlineRunner = {
  ...offlineRunner,
  id: 'runner-2',
  runnerId: 'pc-office',
  workspaceId: 'ws-2',
  lastSeenAt: new Date().toISOString(),
};

function mount(badge: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{badge}</QueryClientProvider>);
}

beforeEach(() => {
  mocks.listRunners.mockReset().mockResolvedValue({ items: [offlineRunner, onlineRunner] });
  mocks.listRunnerTokens.mockReset().mockResolvedValue({ items: [] });
  mocks.getProjectBinding.mockReset().mockResolvedValue({
    id: 'binding-1',
    revision: 4,
    runnerId: 'runner-1',
    workspaceId: 'ws-1',
    canonicalCwd: 'project',
    instructions: { source: 'agents', customPrompt: '' },
  });
  mocks.bind.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe('会话头部 RunnerBadge', () => {
  it('把未连接状态渲染成可点击入口，点击后打开 Runner 选择弹窗', async () => {
    mount(<RunnerBadge runnerId="runner-1" projectId="project-1" />);
    const badge = await screen.findByRole('button', { name: /设备未连接/ });
    expect(badge.textContent).toContain('点击连接');
    await userEvent.click(badge);
    expect(
      await screen.findByRole('dialog', { name: '选择 Runner 或复制启动命令' }),
    ).toBeDefined();
    expect(screen.getByText('当前 runner-1')).toBeDefined();
    expect(screen.getByText(/当前会话仍保留原设备/)).toBeDefined();
  });

  it('设备在线时展示在线状态，仍提供同一弹窗入口', async () => {
    mocks.listRunners.mockResolvedValue({ items: [onlineRunner] });
    mount(<RunnerBadge runnerId="runner-2" projectId="project-1" />);
    await userEvent.click(await screen.findByRole('button', { name: /设备在线/ }));
    expect(
      await screen.findByRole('dialog', { name: '选择 Runner 或复制启动命令' }),
    ).toBeDefined();
  });

  it('选择其他 Runner 时按服务端最新修订改绑项目并关闭弹窗', async () => {
    mount(<RunnerBadge runnerId="runner-1" projectId="project-1" />);
    await userEvent.click(await screen.findByRole('button', { name: /设备未连接/ }));
    await userEvent.click(await screen.findByRole('button', { name: '选择 runner-2' }));
    await waitFor(() =>
      expect(mocks.bind).toHaveBeenCalledWith('project-1', {
        runnerId: 'runner-2',
        workspaceId: 'ws-2',
        canonicalCwd: 'project',
        instructionSource: 'agents',
        customPrompt: '',
        expectedRevision: 4,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择 Runner 或复制启动命令' })).toBeNull(),
    );
  });

  it('设备没有工作目录时给出原因而不是直接调用绑定接口', async () => {
    mocks.listRunners.mockResolvedValue({
      items: [offlineRunner, { ...onlineRunner, workspaceId: null }],
    });
    mount(<RunnerBadge runnerId="runner-1" projectId="project-1" />);
    await userEvent.click(await screen.findByRole('button', { name: /设备未连接/ }));
    await userEvent.click(await screen.findByRole('button', { name: '选择 runner-2' }));
    expect(mocks.bind).not.toHaveBeenCalled();
    expect(
      await screen.findByText('该设备还没有上报工作目录，先在设备上运行一次 Runner。'),
    ).toBeDefined();
  });
});

describe('RunnerManager 的选择失败提示', () => {
  it('onSelect 被拒绝时在已注册 Runner 区块显示错误', async () => {
    mocks.bind.mockRejectedValue(new ApiError(409, 409, '绑定已被其他操作更新，请刷新后重试。'));
    mount(
      <RunnerManager
        selectedRunnerId="runner-1"
        onSelect={(runnerId) => mocks.bind(runnerId)}
        onClose={() => undefined}
      />,
    );
    // runner-1 是“当前”，只有 runner-2 行有“选择”按钮。
    await userEvent.click(await screen.findByRole('button', { name: '选择' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(await screen.findByText(/绑定已被其他操作更新/)).toBeDefined();
    expect(mocks.bind).toHaveBeenCalledWith('runner-2');
  });
});
