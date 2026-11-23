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
  updateBinding: vi.fn(),
}));

vi.mock('@/api/generated/runners', () => ({
  listRunners: mocks.listRunners,
  listRunnerTokens: mocks.listRunnerTokens,
  listRunnerFiles: vi.fn(),
  createRunnerToken: vi.fn(),
  revokeRunnerToken: vi.fn(),
  rotateRunnerToken: vi.fn(),
}));
vi.mock('@/api/generated/projects', () => ({
  getProjectBinding: mocks.getProjectBinding,
  bindProjectEnvironment: mocks.bind,
}));
vi.mock('@/api/generated/conversations', () => ({
  updateConversationBinding: mocks.updateBinding,
}));
vi.mock('../src/features/runners/use-runner-connection', () => ({
  useRunnerConnection: () => ({
    data: { endpoint: 'ws://127.0.0.1:9203/runner/v1/connect' },
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/features/auth', () => ({ useIdentity: () => ({ identity: { identityId: 'alice' } }) }));
// 弹窗本体（RunnerManager）单独测；这里用桩组件复刻会话入口契约：
// 「选择」只上报意图，由宿主（徽章）负责确认并直接切换会话与项目绑定。
vi.mock('../src/features/settings/runner/runner-manager-dialog', () => ({
  RunnerManagerDialog: ({
    title,
    selectedRunnerId,
    selectionHint,
    onSelectRequest,
    onClose,
  }: {
    title?: string;
    selectedRunnerId?: string;
    selectionHint?: string;
    onSelectRequest?: (runnerId: string) => void;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label={title}>
      <span>当前 {selectedRunnerId}</span>
      {selectionHint ? <p>{selectionHint}</p> : null}
      {onSelectRequest ? <button onClick={() => onSelectRequest('runner-2')}>选择 runner-2</button> : null}
      <button onClick={onClose}>关闭</button>
    </div>
  ),
}));

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
  mocks.updateBinding.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

async function openPickerAndRequestSwitch() {
  mount(
    <RunnerBadge runnerId="runner-1" projectId="project-1" conversationId="conversation-1" />,
  );
  await userEvent.click(await screen.findByRole('button', { name: /设备未连接/ }));
  await userEvent.click(await screen.findByRole('button', { name: '选择 runner-2' }));
  return screen.findByRole('dialog', { name: '切换会话设备' });
}

describe('会话头部 RunnerBadge', () => {
  it('把未连接状态渲染成可点击入口，点击后打开 Runner 选择弹窗', async () => {
    mount(<RunnerBadge runnerId="runner-1" projectId="project-1" conversationId="conversation-1" />);
    const badge = await screen.findByRole('button', { name: /设备未连接/ });
    expect(badge.textContent).toContain('点击切换');
    await userEvent.click(badge);
    expect(
      await screen.findByRole('dialog', { name: '选择 Runner 或复制启动命令' }),
    ).toBeDefined();
    expect(screen.getByText('当前 runner-1')).toBeDefined();
    expect(screen.getByText(/绑定的设备离线时可直接/)).toBeDefined();
  });

  it('选择 Runner 前显示旧/新执行环境确认', async () => {
    const confirm = await openPickerAndRequestSwitch();
    expect(confirm).toBeDefined();
    expect(screen.getByText(/当前会话：mac-lab → pc-office/)).toBeDefined();
    expect(await screen.findByText(/已开始或暂停的运行留在原设备完成/)).toBeDefined();
  });

  it('确认后直接切换会话绑定，再同步切换项目绑定并关闭弹窗', async () => {
    await openPickerAndRequestSwitch();
    await userEvent.click(screen.getByRole('button', { name: '切换' }));
    await waitFor(() =>
      expect(mocks.updateBinding).toHaveBeenCalledWith(
        'conversation-1',
        { runnerId: 'runner-2' },
        { silent: true },
      ),
    );
    await waitFor(() =>
      expect(mocks.bind).toHaveBeenCalledWith(
        'project-1',
        {
          runnerId: 'runner-2',
          workspaceId: 'ws-2',
          canonicalCwd: 'project',
          instructionSource: 'agents',
          customPrompt: '',
          expectedRevision: 4,
        },
        { silent: true },
      ),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '切换会话设备' })).toBeNull();
      expect(screen.queryByRole('dialog', { name: '选择 Runner 或复制启动命令' })).toBeNull();
    });
  });

  it('会话与项目都已是目标设备时不再发起任何写请求', async () => {
    mocks.getProjectBinding.mockResolvedValue({
      id: 'binding-1',
      revision: 5,
      runnerId: 'runner-2',
      workspaceId: 'ws-2',
      canonicalCwd: 'project',
      instructions: { source: 'agents', customPrompt: '' },
    });
    mount(<RunnerBadge runnerId="runner-2" projectId="project-1" conversationId="conversation-1" />);
    await userEvent.click(await screen.findByRole('button', { name: /设备在线|设备未连接/ }));
    // 绑定的 runner-2 在线：确认流程仍可发起（弹窗桩里直接触发），但目标==当前时两端都应跳过。
    await userEvent.click(await screen.findByRole('button', { name: '选择 runner-2' }));
    await userEvent.click(await screen.findByRole('button', { name: '切换' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '切换会话设备' })).toBeNull());
    expect(mocks.updateBinding).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it('服务端拒绝切换（绑定设备在线）时给出中文原因且不切项目', async () => {
    mocks.updateBinding.mockRejectedValue(
      new ApiError(409, 409, '状态已变更，请刷新后确认并重新提交。', undefined, undefined, {
        reason: 'RUNNER_ONLINE',
      }),
    );
    await openPickerAndRequestSwitch();
    await userEvent.click(screen.getByRole('button', { name: '切换' }));
    expect(
      await screen.findByText('当前绑定的设备在线，不能切换；请等设备离线或先停止任务。'),
    ).toBeDefined();
    expect(mocks.bind).not.toHaveBeenCalled();
    // 失败后确认弹窗保留（其下内容被模态遮挡，只断言弹窗本身）。
    expect(screen.getByRole('dialog', { name: '切换会话设备' })).toBeDefined();
  });

  it('设备没有工作目录时给出原因而不是发起切换', async () => {
    mocks.listRunners.mockResolvedValue({
      items: [offlineRunner, { ...onlineRunner, workspaceId: null }],
    });
    await openPickerAndRequestSwitch();
    await userEvent.click(screen.getByRole('button', { name: '切换' }));
    expect(
      await screen.findByText('该设备还没有上报工作目录，先在设备上运行一次 Runner。'),
    ).toBeDefined();
    expect(mocks.updateBinding).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });
});

describe('RunnerManager 会话入口与设备操作', () => {
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

  it('绑定设备在线时禁用选择按钮（不允许把运行好的会话切走）', async () => {
    mocks.listRunners.mockResolvedValue({ items: [onlineRunner, { ...offlineRunner, id: 'runner-3' }] });
    const requested = vi.fn();
    mount(
      <RunnerManager
        selectedRunnerId="runner-2"
        onSelectRequest={requested}
        onClose={() => undefined}
      />,
    );
    const selectButton = (await screen.findByRole('button', { name: '选择' }) as HTMLButtonElement);
    expect(selectButton.disabled).toBe(true);
    await userEvent.click(selectButton);
    expect(requested).not.toHaveBeenCalled();
  });

  it('设备行提供「复制启动命令」，点击打开启动命令弹窗', async () => {
    mocks.listRunnerTokens.mockResolvedValue({
      items: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          token: 'runner-secret-token-0001',
          label: '办公室电脑',
          capabilities: ['exec'],
          status: 'active',
          statusChangedAt: '2026-01-01T00:00:00Z',
          rotatedAt: null,
          expiresAt: null,
          lastUsedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mount(
      <RunnerManager selectedRunnerId="runner-1" onSelect={() => undefined} onClose={() => undefined} />,
    );
    const commandButtons = await screen.findAllByRole('button', { name: '复制启动命令' });
    // 表格顺序：runner-1（当前绑定）在前，按钮为主操作样式并打开命令弹窗。
    await userEvent.click(commandButtons[0]!);
    expect(await screen.findByRole('dialog', { name: 'Runner 启动命令' })).toBeDefined();
  });
});
