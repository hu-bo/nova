import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductEvent, RunView } from '@nova/agent-ui-contracts';
import type { SseConnectionOptions } from '../src/api/sse-client';
import { queryKeys } from '../src/api/query-keys';
import { conversationId, event, snapshot } from './fixtures';
import { ArtifactsPanel } from '../src/features/artifacts/artifacts-panel';
import { useConversationArtifactsQuery } from '../src/features/artifacts';
import type { ArtifactEntry, ArtifactsPanelProps } from '../src/features/artifacts';

const mocks = vi.hoisted(() => ({
  connections: [] as { options: SseConnectionOptions; shutdown: ReturnType<typeof vi.fn> }[],
  listConversationArtifacts: vi.fn(),
  previewArtifact: vi.fn(),
  downloadArtifact: vi.fn(),
}));
vi.mock('../src/api/sse-client', () => ({
  SseConnection: class {
    shutdown = vi.fn();
    constructor(options: SseConnectionOptions) {
      mocks.connections.push({ options, shutdown: this.shutdown });
    }
  },
}));
vi.mock('@/api/generated/conversations', () => ({ getConversationSnapshot: vi.fn() }));
vi.mock('@/api/generated/artifacts', () => ({
  listConversationArtifacts: (id: string, params?: unknown, options?: unknown) =>
    mocks.listConversationArtifacts(id, params, options),
  previewArtifact: (id: string, options?: unknown) => mocks.previewArtifact(id, options),
  downloadArtifact: (id: string, options?: unknown) => mocks.downloadArtifact(id, options),
}));
vi.mock('@/features/auth', () => ({
  useIdentity: () => ({ identity: { identityId: 'alice' } }),
}));

import { RunStreamManager } from '../src/features/runs/run-stream-manager';
import { ApiError } from '../src/api/api-error';

const runId = '00000000-0000-4000-8000-0000000000b1';
const baseArtifact: ArtifactEntry = {
  id: '00000000-0000-4000-8000-0000000000a1',
  runId,
  skillVersionId: null,
  name: 'test-report.md',
  mimeType: 'text/markdown',
  size: 1_572_864,
  sha256: 'a'.repeat(64),
  state: 'ready',
  preview: 'markdown',
  runState: 'succeeded',
  createdAt: '2026-11-24T00:00:00Z',
  updatedAt: '2026-11-24T00:00:00Z',
};
function makeArtifact(overrides: Partial<ArtifactEntry> = {}): ArtifactEntry {
  return { ...baseArtifact, ...overrides };
}
const frame = (type: ProductEvent['type'], sequence: number, payload: unknown) => ({
  eventId: conversationId + ':' + sequence,
  eventName: type,
  data: event(type, sequence, payload),
});
function mountPanel(props: Partial<ArtifactsPanelProps> & { artifacts: readonly ArtifactEntry[] }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onRetry = vi.fn();
  return render(
    <QueryClientProvider client={client}>
      <ArtifactsPanel
        isPending={false}
        error={null}
        onRetry={onRetry}
        storageConfigured
        run={null}
        {...props}
      />
    </QueryClientProvider>,
  );
}
/** 列表查询宿主：验证分页游标与面板联动。 */
function ArtifactsHost() {
  const query = useConversationArtifactsQuery(conversationId);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <ArtifactsPanel
        artifacts={items}
        isPending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        storageConfigured
        run={null}
      />
      {query.hasNextPage && (
        <button type="button" onClick={() => void query.fetchNextPage()}>
          加载下一页产物
        </button>
      )}
    </>
  );
}
function mountWithQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  mocks.connections.length = 0;
  mocks.listConversationArtifacts.mockReset();
  mocks.previewArtifact.mockReset();
  mocks.downloadArtifact.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('artifact.changed stream wiring', () => {
  it('invalidates the conversation artifact list when artifact.changed arrives', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const manager = new RunStreamManager('alice', client);
    manager.acquire(conversationId, snapshot());
    mocks.connections[0]!.options.onFrame(
      frame('artifact.changed', 1, { artifactId: baseArtifact.id, runId, state: 'ready' }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.artifacts.list('alice', conversationId),
      refetchType: 'active',
    });
    manager.dispose();
  });
  it('refetches the artifact list once after a reconnect (list endpoint fallback)', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const manager = new RunStreamManager('alice', client);
    manager.acquire(conversationId, snapshot());
    const options = mocks.connections[0]!.options;
    invalidate.mockClear();
    options.onStateChange('offline');
    options.onStateChange('reconnecting');
    expect(invalidate).not.toHaveBeenCalled();
    options.onStateChange('live');
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.artifacts.list('alice', conversationId),
      refetchType: 'active',
    });
    invalidate.mockClear();
    options.onStateChange('live');
    expect(invalidate).not.toHaveBeenCalled();
    manager.dispose();
  });
  it('keeps the projection running: artifact.changed advances the cursor without a snapshot', () => {
    const manager = new RunStreamManager('alice', new QueryClient());
    manager.acquire(conversationId, snapshot());
    mocks.connections[0]!.options.onFrame(
      frame('artifact.changed', 1, { artifactId: baseArtifact.id, runId, state: 'publishing' }),
    );
    expect(manager.session(conversationId).getSnapshot().projection).toMatchObject({
      cursor: '1',
      needsSnapshot: false,
    });
    manager.dispose();
  });
});

describe('artifact list query', () => {
  it('pages through the cursor-paginated list endpoint', async () => {
    mocks.listConversationArtifacts
      .mockResolvedValueOnce({ items: [makeArtifact()], nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({
        items: [makeArtifact({ id: '00000000-0000-4000-8000-0000000000a2', name: 'second.csv' })],
        nextCursor: null,
      });
    mountWithQuery(<ArtifactsHost />);
    await screen.findByText('test-report.md');
    expect(mocks.listConversationArtifacts).toHaveBeenCalledWith(
      conversationId,
      expect.objectContaining({ limit: 50 }),
      expect.anything(),
    );
    await userEvent.click(screen.getByRole('button', { name: '加载下一页产物' }));
    await screen.findByText('second.csv');
    expect(mocks.listConversationArtifacts).toHaveBeenLastCalledWith(
      conversationId,
      expect.objectContaining({ cursor: 'cursor-2' }),
      expect.anything(),
    );
  });
});

describe('artifact cards', () => {
  it('renders name, human-readable size, ready badge and download entry', async () => {
    mountPanel({ artifacts: [makeArtifact()] });
    expect(screen.getByText('test-report.md')).toBeTruthy();
    expect(screen.getByText('1.5 MB')).toBeTruthy();
    expect(screen.getByText('已就绪')).toBeTruthy();
    expect(screen.getByRole('article', { name: '产物 test-report.md' })).toBeTruthy();
    mocks.downloadArtifact.mockResolvedValue({
      name: 'test-report.md',
      mimeType: 'text/markdown',
      size: 1_572_864,
      state: 'ready',
      url: 'https://storage.example/signed/download',
      expiresAt: '2026-11-24T00:15:00Z',
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await userEvent.click(screen.getByRole('button', { name: /下载/ }));
    await waitFor(() =>
      expect(mocks.downloadArtifact).toHaveBeenCalledWith(baseArtifact.id, undefined),
    );
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
  });
  it('keeps publishing artifacts non-downloadable and shows the hint', () => {
    mountPanel({
      artifacts: [makeArtifact({ state: 'publishing', size: 0, preview: 'download' })],
    });
    expect(screen.getByText('正在发布')).toBeTruthy();
    expect(screen.getByText('文件上传中，完成后才能下载。')).toBeTruthy();
    expect(screen.getByText('0 B')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /下载/ })).toBeNull();
  });
  it('shows the server error message for failed artifacts', () => {
    mountPanel({
      artifacts: [
        makeArtifact({
          state: 'failed',
          preview: 'download',
          error: { code: 'SIZE_LIMIT', message: '超过单文件大小上限（20 MiB）' },
        }),
      ],
    });
    expect(screen.getByText('发布失败')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('超过单文件大小上限（20 MiB）');
    expect(screen.queryByRole('button', { name: /下载/ })).toBeNull();
  });
  it('shows the source Run result from list runState, even without the run view', () => {
    mountPanel({
      artifacts: [makeArtifact({ runState: 'failed' })],
    });
    expect(screen.getByText('test-report.md')).toBeTruthy();
    expect(screen.getByText('来源运行：运行失败')).toBeTruthy();
    expect(screen.getByRole('button', { name: /下载/ })).toBeTruthy();
  });
  it('falls back to the current run view only when list omits runState (legacy payloads)', () => {
    const legacy = { ...makeArtifact({ runState: 'failed' }), runId: 'other-run' } as Record<string, unknown>;
    delete legacy.runState;
    mountPanel({
      artifacts: [legacy as unknown as ArtifactEntry],
      run: { id: runId, state: 'succeeded' } satisfies Pick<RunView, 'id' | 'state'>,
    });
    expect(screen.queryByText(/来源运行/)).toBeNull();
    mountPanel({
      artifacts: [legacy as unknown as ArtifactEntry],
      run: { id: 'other-run', state: 'succeeded' } satisfies Pick<RunView, 'id' | 'state'>,
    });
    expect(screen.getByText(/来源运行/)).toBeTruthy();
  });
});

describe('preview matrix', () => {
  it('previews markdown through the existing renderer', async () => {
    mocks.previewArtifact.mockResolvedValue({
      kind: 'markdown',
      name: 'test-report.md',
      mimeType: 'text/markdown',
      text: '# 巡检结果\n全部通过',
      truncated: false,
    });
    mountPanel({ artifacts: [makeArtifact({ preview: 'markdown' })] });
    await userEvent.click(screen.getByRole('button', { name: /预览/ }));
    await waitFor(() =>
      expect(mocks.previewArtifact).toHaveBeenCalledWith(baseArtifact.id, expect.anything()),
    );
    expect(await screen.findByRole('heading', { level: 1, name: '巡检结果' })).toBeTruthy();
    expect(screen.getByText('全部通过')).toBeTruthy();
  });
  it('renders text previews with the truncation notice', async () => {
    mocks.previewArtifact.mockResolvedValue({
      kind: 'text',
      name: 'analysis.csv',
      mimeType: 'text/csv',
      text: 'col_a,col_b\n1,2',
      truncated: true,
    });
    mountPanel({
      artifacts: [makeArtifact({ preview: 'text', name: 'analysis.csv', mimeType: 'text/csv' })],
    });
    await userEvent.click(screen.getByRole('button', { name: /预览/ }));
    await waitFor(() => expect(mocks.previewArtifact).toHaveBeenCalled());
    const pre = await waitFor(() => {
      const node = document.querySelector('pre');
      expect(node).toBeTruthy();
      return node!;
    });
    expect(pre.textContent).toContain('col_a,col_b');
    expect(screen.getByText('预览内容已截断，完整文件请下载查看。')).toBeTruthy();
  });
  it('renders image previews from the short-lived signed URL', async () => {
    mocks.previewArtifact.mockResolvedValue({
      kind: 'image',
      name: 'chart.png',
      mimeType: 'image/png',
      url: 'https://storage.example/signed/chart.png',
      expiresAt: '2026-11-24T00:05:00Z',
    });
    mountPanel({
      artifacts: [makeArtifact({ preview: 'image', name: 'chart.png', mimeType: 'image/png' })],
    });
    await userEvent.click(screen.getByRole('button', { name: /预览/ }));
    const image = await screen.findByRole('img', { name: 'chart.png' });
    expect(image.getAttribute('src')).toBe('https://storage.example/signed/chart.png');
  });
  it('download-only kinds never render a preview button', () => {
    mountPanel({
      artifacts: [makeArtifact({ preview: 'download', name: 'page.html', mimeType: 'text/html' })],
    });
    expect(screen.queryByRole('button', { name: /预览/ })).toBeNull();
    expect(screen.getByRole('button', { name: /下载/ })).toBeTruthy();
  });
});

describe('panel empty states', () => {
  it('distinguishes 没有产物 from 存储未配置', () => {
    const first = mountPanel({ artifacts: [], storageConfigured: true });
    expect(screen.getByText('没有产物')).toBeTruthy();
    expect(screen.queryByText(/存储未配置/)).toBeNull();
    first.unmount();
    mountPanel({ artifacts: [], storageConfigured: false });
    expect(screen.getByText(/存储未配置/)).toBeTruthy();
    expect(screen.queryByText('没有产物')).toBeNull();
  });
  it('surfaces list failures with a retry action', () => {
    const onRetry = vi.fn();
    mountPanel({ artifacts: [], error: new ApiError(404, 404, '暂时无法读取产物'), onRetry });
    expect(screen.getByRole('alert').textContent).toContain('暂时无法读取产物');
  });
  it('shows loading text while the first page is pending', () => {
    mountPanel({ artifacts: [], isPending: true });
    expect(screen.getByRole('status').textContent).toContain('正在加载产物');
  });
});
