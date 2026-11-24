import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listSkills: vi.fn(),
  listAgents: vi.fn(),
  getSkillVersion: vi.fn(),
  refreshRunnerResources: vi.fn(),
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
  binding: null as unknown,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/features/auth', () => ({
  useIdentity: () => ({ identity: { identityId: 'alice' } }),
}));
vi.mock('@/api/generated/skills', () => ({
  listSkills: (params?: Record<string, unknown>) => mocks.listSkills(params),
  listAgents: (params?: Record<string, unknown>) => mocks.listAgents(params),
  getSkillVersion: (skillId: string, version: string) => mocks.getSkillVersion(skillId, version),
}));
vi.mock('@/api/generated/runners', () => ({
  refreshRunnerResources: (id: string, body: unknown) => mocks.refreshRunnerResources(id, body),
}));
vi.mock('@/features/projects', () => ({
  useProjectsQuery: () => ({
    data: { items: [{ id: 'project-1', name: '演示项目' }] },
    isPending: false,
    error: null,
  }),
  useProjectBinding: () => ({
    data: mocks.binding,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/features/runners', () => ({
  useRunnersQuery: () => ({
    data: {
      items: [
        { id: 'runner-1', runnerId: 'desk-1', lastSeenAt: new Date().toISOString(), revokedAt: null },
      ],
    },
  }),
  runnerStatus: () => 'online',
}));
import { ApiError } from '@/api/api-error';
import { SkillsPage } from '../src/features/skills/skills.page';

const DEFAULT_REQUIREMENTS = {
  allowedModes: ['plan', 'build', 'auto'],
  requiredTools: [],
  requiresWorkspace: false,
  requiresPublishing: false,
};
function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    version: '0.0.2',
    name: '部署脚本',
    description: '打包并部署',
    source: 'runner-project',
    requirements: DEFAULT_REQUIREMENTS,
    projectId: null,
    runnerId: null,
    workspaceId: null,
    cwd: null,
    sha256: 'a'.repeat(64),
    applicability: { status: 'available', reasons: [] },
    disabled: false,
    ...overrides,
  };
}
function mountPage(search: Record<string, unknown>) {
  mocks.search = search;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SkillsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.listSkills.mockReset().mockResolvedValue({ items: [makeItem()], nextCursor: null, catalog: null });
  mocks.listAgents.mockReset().mockResolvedValue({ items: [], catalog: null });
  mocks.getSkillVersion.mockReset();
  mocks.refreshRunnerResources.mockReset();
  mocks.binding = null;
});
afterEach(cleanup);

describe('skills page filters and detail', () => {
  it('restores server-scoped filters from the URL on direct visits', async () => {
    await mountPage({ runnerId: 'runner-1' });
    await waitFor(() =>
      expect(mocks.listSkills).toHaveBeenCalledWith(expect.objectContaining({ runnerId: 'runner-1' })),
    );
    // 详情直达：skillId/version search 参数直接触发正文加载。
    cleanup();
    mocks.getSkillVersion.mockResolvedValue({
      ...makeItem(),
      id: 'skill-detail-1',
      body: '# 巡检步骤\n检查构建产物',
      resources: [],
      diagnostics: [],
    });
    await mountPage({ projectId: 'project-1', skillId: 'skill-detail-1', version: '1.0.0' });
    await waitFor(() =>
      expect(mocks.listSkills).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectId: 'project-1' }),
      ),
    );
    await waitFor(() => expect(document.body.textContent).toContain('检查构建产物'));
    expect(mocks.getSkillVersion).toHaveBeenCalledWith('skill-detail-1', '1.0.0');
  });

  it('derives the runner from the project binding and drops mismatched device filters', async () => {
    mocks.binding = {
      id: 'binding-1',
      revision: 1,
      runnerId: 'runner-1',
      workspaceId: 'ws-1',
      canonicalCwd: 'project',
      instructions: {},
    };
    await mountPage({ projectId: 'project-1', runnerId: 'runner-9' });
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ to: '/skills', replace: true }),
      ),
    );
  });

  it('shows shadowed global entries with the shadowing source', async () => {
    mocks.listSkills.mockResolvedValue({
      items: [
        makeItem({
          name: '全局版本',
          source: 'runner-global',
          shadowedBy: { name: 'deploy', source: 'runner-project', runnerId: 'runner-1', projectId: 'project-1' },
        }),
      ],
      nextCursor: null,
      catalog: { runnerId: 'runner-1', status: 'ready', revision: 3, complete: true, diagnostics: [] },
    });
    await mountPage({ runnerId: 'runner-1' });
    await waitFor(() => expect(document.body.textContent).toContain('被 项目同名技能遮蔽'));
  });

  it('carries the exact skill reference into a new conversation draft', async () => {
    await mountPage({ projectId: 'project-1' });
    await waitFor(() => expect(screen.getAllByRole('button', { name: '在会话中使用' }).length).toBeGreaterThan(0));
    await userEvent.click(screen.getAllByRole('button', { name: '在会话中使用' })[0]!);
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/conversations',
        search: {
          projectId: 'project-1',
          skill: { id: makeItem().id, version: '0.0.2' },
        },
      }),
    );
  });

  it('refreshes the selected runner only, with project scope from the binding', async () => {
    mocks.binding = {
      id: 'binding-1',
      revision: 1,
      runnerId: 'runner-1',
      workspaceId: 'ws-1',
      canonicalCwd: 'project',
      instructions: {},
    };
    mocks.refreshRunnerResources.mockResolvedValue({
      status: 'ready',
      revision: 4,
      complete: true,
      online: true,
      writable: true,
      diagnostics: [],
    });
    await mountPage({ projectId: 'project-1' });
    const button = await screen.findByRole('button', { name: '刷新本地技能' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(button);
    await waitFor(() =>
      expect(mocks.refreshRunnerResources).toHaveBeenCalledWith('runner-1', {
        scope: 'project',
        workspaceId: 'ws-1',
        relativeDir: 'project',
      }),
    );
    await waitFor(() => expect(document.body.textContent).toContain('本地技能已刷新：目录版本 4'));
  });
});

describe('skills page status matrix (P0-H5)', () => {
  it('keeps offline, scanning, empty-directory, filter-empty, unsupported and failure states distinct', async () => {
    const cases: Array<{
      name: string;
      search: Record<string, unknown>;
      reply?: { items?: unknown[]; catalog?: Record<string, unknown> };
      reject?: boolean;
      expect: string[];
      forbid?: string[];
    }> = [
      {
        name: 'runner 离线',
        search: { runnerId: 'runner-1' },
        reply: { items: [], catalog: { runnerId: 'runner-1', status: 'offline', revision: 3, complete: false, diagnostics: [] } },
        expect: ['Runner 当前离线，无法读取其上的本地技能'],
        forbid: ['当前范围还没有技能'],
      },
      {
        name: '扫描未完成',
        search: { runnerId: 'runner-1' },
        reply: { items: [], catalog: { runnerId: 'runner-1', status: 'scanning', revision: 3, complete: false, diagnostics: [] } },
        expect: ['仍在扫描'],
        forbid: ['Runner 当前离线'],
      },
      {
        name: '目录为空',
        search: { runnerId: 'runner-1' },
        reply: { items: [], catalog: { runnerId: 'runner-1', status: 'ready', revision: 4, complete: true, diagnostics: [] } },
        expect: ['本地技能目录为空', '这与设备离线或没有权限不同'],
        forbid: ['仍在扫描'],
      },
      {
        name: '筛选无结果',
        search: { q: '不存在' },
        reply: { items: [], catalog: null },
        expect: ['没有匹配的技能', '清除筛选'],
        forbid: ['本地技能目录为空'],
      },
      {
        name: '旧 Runner 不支持本地发现',
        search: { runnerId: 'runner-1' },
        reply: { items: [], catalog: { runnerId: 'runner-1', status: 'unsupported', revision: 0, complete: false, diagnostics: [] } },
        expect: ['未提供本地技能发现能力', '可继续使用内置与平台技能'],
        forbid: ['本地技能目录为空'],
      },
    ];
    for (const item of cases) {
      cleanup();
      mocks.listSkills.mockReset().mockResolvedValue({
        items: item.reply?.items ?? [],
        nextCursor: null,
        catalog: item.reply?.catalog ?? null,
      });
      mountPage(item.search);
      await waitFor(() => expect(document.body.textContent).toContain(item.expect[0]!));
      for (const text of item.expect) expect(document.body.textContent).toContain(text);
      for (const text of item.forbid ?? []) expect(document.body.textContent).not.toContain(text);
      if (item.name === '旧 Runner 不支持本地发现') {
        const button = await screen.findByRole('button', { name: '刷新本地技能' });
        expect((button as HTMLButtonElement).disabled).toBe(true);
      }
    }
  });

  it('renders the interface failure state with retry and keeps the unbound project hint separate', async () => {
    mocks.listSkills.mockReset().mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'network down'));
    const view = mountPage({});
    await waitFor(() => expect(document.body.textContent).toContain('network down'));
    expect(screen.getAllByRole('button', { name: '重试' }).length).toBeGreaterThan(0);
    view.unmount();

    // 项目已选但绑定为空：独立文案 + 配置环境入口，而非「没有技能」。
    cleanup();
    mocks.listSkills.mockReset().mockResolvedValue({ items: [makeItem()], nextCursor: null, catalog: null });
    mountPage({ projectId: 'project-1' });
    await waitFor(() => expect(document.body.textContent).toContain('该项目尚未绑定 Runner 环境'));
    expect(document.body.textContent).not.toContain('本地技能目录为空');
  });
});
