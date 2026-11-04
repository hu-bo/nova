import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
  instructions: { customPrompt: 'legacy prompt' } as {
    source?: 'agents' | 'claude' | 'custom' | 'none';
    customPrompt: string;
  },
}));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'project-1' }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/api/generated/projects', () => ({ bindProjectEnvironment: mocks.bind }));
vi.mock('@/features/auth', () => ({ useIdentity: () => ({ identity: { identityId: 'alice' } }) }));
vi.mock('@/features/settings', () => ({ useModelSettings: () => ({ defaultRunnerId: '' }) }));
vi.mock('@/features/conversations', () => ({
  useConversationsQuery: () => ({ data: { items: [] } }),
}));
vi.mock('@/features/runners', () => ({
  useRunnersQuery: () => ({
    data: { items: [{ id: 'runner-1', runnerId: 'runner-1', workspaceId: 'workspace-1' }] },
  }),
  runnerStatus: () => 'online',
}));
vi.mock('@/features/remotes', () => ({
  useRemoteConnectionsQuery: () => ({ data: { items: [] } }),
}));
vi.mock('@/features/projects/project-environment-picker', () => ({
  ProjectEnvironmentPicker: () => <div>工作目录</div>,
}));
vi.mock('@/features/projects/project.queries', () => ({
  useProjectQuery: () => ({ data: { name: 'Test project' } }),
  useProjectBinding: () => ({
    data: {
      runnerId: 'runner-1',
      canonicalCwd: 'project',
      revision: 2,
      instructions: mocks.instructions,
    },
  }),
}));
import { ProjectPage } from '../src/features/projects/project.page';

beforeEach(() => {
  mocks.bind.mockReset().mockResolvedValue({});
  mocks.instructions = { customPrompt: 'legacy prompt' };
});
afterEach(cleanup);

it.each(['agents', 'claude', 'custom', 'none'] as const)(
  'saves the selected %s instruction source',
  async (source) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ProjectPage />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: '配置环境' }));
    expect((screen.getByRole('radio', { name: '自定义提示词' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      (screen.getByRole('textbox', { name: '自定义提示词' }) as HTMLTextAreaElement).value,
    ).toBe('legacy prompt');
    const labels = {
      agents: '读取 AGENTS.md',
      claude: '读取 CLAUDE.md',
      custom: '自定义提示词',
      none: '不使用项目指令',
    };
    await userEvent.click(screen.getByRole('radio', { name: labels[source] }));
    if (source !== 'custom')
      expect(screen.queryByRole('textbox', { name: '自定义提示词' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '保存环境' }));
    await waitFor(() =>
      expect(mocks.bind).toHaveBeenCalledWith('project-1', {
        runnerId: 'runner-1',
        workspaceId: 'workspace-1',
        canonicalCwd: 'project',
        expectedRevision: 2,
        instructionSource: source,
        customPrompt: source === 'custom' ? 'legacy prompt' : '',
      }),
    );
  },
);
