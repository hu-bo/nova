import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComposerSubmission } from '@nova/chat-ui';
import type { Attachment } from '@nova/agent-ui-contracts';
import { attachmentSchema, CHAT_AGENT_PROFILE } from '@nova/agent-ui-contracts';
import { validWorkspacePath } from '../src/features/projects/project-environment';
import { resolveRemotePath, relativeRemotePath } from '../src/features/remotes/remote.queries';
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  append: vi.fn(),
  remove: vi.fn(),
  removeAsync: vi.fn(),
  steer: vi.fn(),
  directory: vi.fn(),
  summary: vi.fn(),
}));
vi.mock('@/api/generated/remotes', () => ({
  listRemoteConnections: async () => ({
    items: [{ id: 'remote-1', name: 'Test SSH', rootPath: '/home', status: 'verified' }],
  }),
  listRemoteFiles: mocks.directory,
  summariseRemoteFiles: mocks.summary,
}));
vi.mock('@/features/auth', () => ({ useIdentity: () => ({ identity: { identityId: 'alice' } }) }));
vi.mock('@/api/generated/skills', () => ({
  useListSkills: () => ({
    data: {
      items: [
        {
          id: 'nova.career-coach',
          version: '1.0.0',
          name: '求职教练',
          description: '简历和面试',
          source: 'builtin',
        },
      ],
    },
    error: null,
  }),
}));
vi.mock('@/features/models', () => ({
  ModelLabel: () => null,
  useClientConfig: () => ({
    data: {
      capabilities: {
        uploads: false,
        remoteFiles: false,
        compression: false,
        models: false,
        execution: true,
      },
    },
  }),
}));
vi.mock('@/features/settings', () => ({
  useModelSettings: () => ({
    profiles: [{ id: 'server:model', model: 'test', providerName: 'Test', thinkingLevels: [] }],
    resolveModelId: async () => '00000000-0000-4000-8000-000000000005',
    defaultProfileId: '',
    defaultRunnerId: '',
    setDefaultProfileId: () => {},
    setDefaultRunnerId: () => {},
    saveProfile: () => '',
    deleteProfile: () => {},
  }),
}));
vi.mock('../src/features/conversations/conversation.queries', () => ({
  useCreateConversationMutation: () => ({ mutateAsync: mocks.create, isPending: false }),
  useAppendPendingInputMutation: () => ({
    mutateAsync: mocks.append,
    isPending: false,
    error: null,
  }),
  useSteerPendingInputMutation: () => ({ mutateAsync: mocks.steer, isPending: false }),
  useRemovePendingInputMutation: () => ({
    mutate: mocks.remove,
    mutateAsync: mocks.removeAsync,
    isPending: false,
    error: null,
  }),
}));
import {
  useConversationComposer,
  type ConversationComposerOptions,
} from '../src/features/conversations/use-conversation-composer';
const submission = (text: string): ComposerSubmission<Attachment> => ({
  text,
  files: [],
  attachments: [],
});
function mount(options: Partial<ConversationComposerOptions> = {}) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useConversationComposer({
        conversationId: null,
        mode: 'chat',
        binding: null,
        isRunning: false,
        pendingInputs: [],
        ...options,
      }),
    { wrapper },
  );
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  mocks.create.mockReset();
  mocks.append.mockReset();
  mocks.remove.mockReset();
  mocks.removeAsync.mockReset();
  mocks.steer.mockReset();
  mocks.directory.mockReset();
  mocks.summary.mockReset();
});
describe('SSH filesystem selection', () => {
  it('leaves budgets unlimited by default and validates explicit optional limits', async () => {
    mocks.create.mockResolvedValue({ id: 'budgeted' });
    const draft = mount();
    expect(draft.result.current.budgetLimits).toEqual({ maxSteps: '', maxToolCalls: '' });
    await act(async () => {
      await draft.result.current.submit(submission('默认预算'));
    });
    expect(mocks.create.mock.calls[0]?.[0].configuration.budget).toBeUndefined();
    await act(async () => {
      draft.result.current.setBudgetLimits({ maxSteps: '2', maxToolCalls: '3' });
    });
    await act(async () => {
      await draft.result.current.submit(submission('设置预算'));
    });
    expect(mocks.create.mock.calls.at(-1)?.[0].configuration.budget).toEqual({
      maxSteps: 2,
      maxToolCalls: 3,
    });
    const before = mocks.create.mock.calls.length;
    await act(async () => {
      draft.result.current.setBudgetLimits({ maxSteps: '0', maxToolCalls: '3' });
    });
    await act(async () => {
      await draft.result.current.submit(submission('无效预算'));
    });
    expect(mocks.create.mock.calls.length).toBe(before);
    expect(draft.result.current.error).toBeDefined();
  });
  it('can remove a saved execution budget by clearing both limits', async () => {
    mocks.append.mockResolvedValue({});
    const draft = mount({
      conversationId: 'existing',
      runtime: { backendId: 'nova', modelId: null, mode: 'build', budget: { maxSteps: 2 } },
    });
    expect(draft.result.current.budgetLimits.maxSteps).toBe('2');
    await act(async () => {
      draft.result.current.setBudgetLimits({ maxSteps: '', maxToolCalls: '' });
    });
    await act(async () => {
      await draft.result.current.submit(submission('取消预算'));
    });
    expect(mocks.append.mock.calls[0]?.[0].configuration.budget).toBeUndefined();
  });
  it('creates a text-only chat agent and explicitly submits the selected version on every answer', async () => {
    mocks.create.mockResolvedValue({ id: 'career' });
    const onCreated = vi.fn();
    const draft = mount({ careerCoach: true, onCreated });
    await waitFor(() => expect(draft.result.current.selectedSkill?.id).toBe('nova.career-coach'));
    expect(draft.result.current.composer.allowFiles).toBe(false);
    expect(draft.result.current.composer.skills).toEqual([]);
    await act(async () => {
      await draft.result.current.submit(submission('修改简历'));
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'chat',
        configuration: expect.objectContaining({ agentProfile: CHAT_AGENT_PROFILE, mode: 'plan' }),
        initialInput: expect.objectContaining({
          skill: { id: 'nova.career-coach', version: '1.0.0' },
        }),
      }),
    );
    draft.unmount();
    const chat = mount({
      conversationId: 'career',
      contextEpoch: 1,
      initialSkill: { id: 'nova.career-coach', version: '1.0.0' },
      runtime: { backendId: 'nova', modelId: null, mode: 'plan', agentProfile: CHAT_AGENT_PROFILE },
    });
    for (const answer of ['我只负责接口', '结束面试']) {
      await act(async () => {
        await chat.result.current.submit(submission(answer));
      });
      expect(mocks.append.mock.calls.at(-1)?.[0].skill).toEqual({
        id: 'nova.career-coach',
        version: '1.0.0',
      });
    }
    act(() => chat.result.current.setSelectedSkill(null));
    await act(async () => {
      await chat.result.current.submit(submission('普通聊天'));
    });
    expect(mocks.append.mock.calls.at(-1)?.[0]).not.toHaveProperty('skill');
    mocks.append.mockClear();
    await act(async () => {
      await chat.result.current.submit(submission('/goal 自动回答'));
    });
    expect(mocks.append).not.toHaveBeenCalled();
  });
  it('starts a chat agent directly from a skill selected in the ordinary draft', async () => {
    mocks.create.mockResolvedValue({ id: 'skill-chat' });
    const draft = mount();
    expect(draft.result.current.composer.productSkills?.[0]?.id).toBe('nova.career-coach');
    act(() => draft.result.current.composer.onTextChange?.('保留简历正文'));
    act(() =>
      draft.result.current.composer.onProductSkillChange?.({
        id: 'nova.career-coach',
        version: '1.0.0',
      }),
    );
    expect(draft.result.current.chatAgent).toBe(true);
    expect(draft.result.current.composer.value).toBe('保留简历正文');
    await act(async () => {
      await draft.result.current.submit(submission('保留简历正文'));
    });
    expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
      configuration: { agentProfile: CHAT_AGENT_PROFILE, mode: 'plan' },
      initialInput: { skill: { id: 'nova.career-coach', version: '1.0.0' } },
    });
  });
  it('creates a separate skill conversation without changing a coding conversation or its remote', async () => {
    mocks.create.mockResolvedValue({ id: 'new-skill-chat' });
    const onCreated = vi.fn();
    const draft = mount({
      conversationId: 'coding',
      onCreated,
      runtime: { backendId: 'nova', modelId: null, mode: 'build', remoteConnectionId: 'remote-1' },
    });
    act(() =>
      draft.result.current.composer.onProductSkillChange?.({
        id: 'nova.career-coach',
        version: '1.0.0',
      }),
    );
    expect(draft.result.current.composer.placeholder).toContain('独立');
    await act(async () => {
      await draft.result.current.submit(submission('修改简历'));
    });
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0]?.[0].configuration).toMatchObject({
      agentProfile: CHAT_AGENT_PROFILE,
      mode: 'plan',
    });
    expect(mocks.create.mock.calls[0]?.[0].configuration.remoteConnectionId).toBeUndefined();
    expect(onCreated).toHaveBeenCalledWith('new-skill-chat', {
      id: 'nova.career-coach',
      version: '1.0.0',
    });
  });
  it('returns to coding behavior when a draft skill is removed and excludes project skills', () => {
    const draft = mount();
    act(() =>
      draft.result.current.composer.onProductSkillChange?.({
        id: 'nova.career-coach',
        version: '1.0.0',
      }),
    );
    act(() => draft.result.current.composer.onProductSkillChange?.(null));
    expect(draft.result.current.chatAgent).toBe(false);
    expect(draft.result.current.composer.skills?.some((skill) => skill.id === 'build')).toBe(true);
    const project = mount({ mode: 'project', projectId: 'project' });
    expect(project.result.current.composer.productSkills).toBeUndefined();
  });
  it('clears the local skill selection when the context epoch changes', async () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ epoch }) =>
        useConversationComposer({
          conversationId: 'career',
          mode: 'chat',
          binding: null,
          isRunning: false,
          pendingInputs: [],
          contextEpoch: epoch,
          initialSkill: { id: 'nova.career-coach', version: '1.0.0' },
          runtime: {
            backendId: 'nova',
            modelId: null,
            mode: 'plan',
            agentProfile: CHAT_AGENT_PROFILE,
          },
        }),
      { wrapper, initialProps: { epoch: 1 } },
    );
    expect(result.current.selectedSkill).not.toBeNull();
    rerender({ epoch: 2 });
    await waitFor(() => expect(result.current.selectedSkill).toBeNull());
  });
  it('arms Spec locally and starts it only after the first text submission', async () => {
    const onStartSpec = vi.fn().mockResolvedValue(undefined);
    const { result } = mount({ mode: 'project', projectId: 'project', onStartSpec });
    act(() => {
      result.current.setSpecArmed(true);
      result.current.composer.onTextChange?.('导出项目会话');
    });
    expect(onStartSpec).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.submit(submission('导出项目会话'));
    });
    expect(onStartSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '导出项目会话',
        configuration: expect.objectContaining({ mode: 'plan' }),
      }),
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(result.current.composer.value).toBe('');
  });
  it('keeps the first Spec query when creation fails', async () => {
    const { result } = mount({
      mode: 'project',
      projectId: 'project',
      initialSpecMode: true,
      onStartSpec: vi.fn().mockRejectedValue(new Error('offline')),
    });
    act(() => result.current.composer.onTextChange?.('保留这份需求'));
    await act(async () => {
      await result.current.submit(submission('保留这份需求'));
    });
    expect(result.current.composer.value).toBe('保留这份需求');
    expect(result.current.specArmed).toBe(true);
  });
  it('allows an unbound Spec session to discuss drafts in Plan and excludes Build/goal shortcuts', async () => {
    mocks.append.mockResolvedValue({ inputId: 'spec-input' });
    const { result } = mount({
      conversationId: 'spec-conversation',
      mode: 'project',
      projectId: 'project',
      specSession: true,
      binding: null,
      runtime: { backendId: 'nova', modelId: null, mode: 'build' },
    });
    await act(async () => {
      await result.current.submit(submission('修订需求'));
    });
    expect(result.current.unboundOpen).toBe(false);
    expect(mocks.append.mock.calls[0]![0].configuration.mode).toBe('plan');
    expect(
      result.current.composer.skills?.some((skill) => ['build', 'goal', 'auto'].includes(skill.id)),
    ).toBe(false);
    mocks.append.mockClear();
    await act(async () => {
      await result.current.submit(submission('/build run'));
    });
    expect(mocks.append).not.toHaveBeenCalled();
  });
  it('switches to Auto mode via the /auto command and submits with the auto configuration', async () => {
    mocks.append.mockResolvedValue({ inputId: 'auto-input' });
    const { result } = mount({
      conversationId: 'existing',
      runtime: { backendId: 'nova', modelId: null, mode: 'build' },
    });
    await act(async () => {
      await result.current.submit(submission('/auto 直接修复这个问题'));
    });
    expect(result.current.executionMode).toBe('auto');
    const payload = mocks.append.mock.calls[0]![0];
    expect(payload.configuration.mode).toBe('auto');
    expect(payload.blocks).toEqual([{ id: 'text', type: 'text', text: '直接修复这个问题' }]);
    mocks.append.mockClear();
    await act(async () => {
      await result.current.submit(submission('继续无人值守推进'));
    });
    expect(mocks.append.mock.calls[0]![0].configuration.mode).toBe('auto');
  });
  it('ignores the removed SSH selection in old drafts for a new ordinary Chat', async () => {
    localStorage.setItem(
      'nova_composer_options:alice:new:chat:',
      JSON.stringify({ remoteConnectionId: 'remote-1', executionMode: 'build' }),
    );
    mocks.create.mockResolvedValue({ id: 'new-conversation' });
    const { result } = mount();
    expect(result.current.remoteConnectionId).toBe('');
    await act(async () => {
      await result.current.submit(submission('ordinary chat'));
    });
    expect(mocks.create.mock.calls[0]![0].configuration.remoteConnectionId).toBeUndefined();
  });

  it('preserves the server SSH configuration of an existing ordinary Chat', async () => {
    mocks.append.mockResolvedValue({ inputId: 'in-1' });
    const { result } = mount({
      conversationId: 'existing',
      runtime: { backendId: 'nova', modelId: null, mode: 'build', remoteConnectionId: 'remote-1' },
    });
    await waitFor(() => expect(result.current.selectedRemote?.id).toBe('remote-1'));
    await act(async () => {
      await result.current.submit(submission('continue remote chat'));
    });
    expect(mocks.append.mock.calls[0]![0].configuration.remoteConnectionId).toBe('remote-1');
  });

  it('allows absolute SSH project directories and keeps Runner paths relative', () => {
    for (const path of ['/', '/etc', '/var/www', '.', 'projects/web']) {
      expect(validWorkspacePath(path, 'ssh:remote-1')).toBe(true);
    }
    for (const path of ['/', '/etc', '../etc', 'C:/project', '/etc/\0config']) {
      expect(validWorkspacePath(path, 'runner:runner-1')).toBe(false);
    }
    expect(validWorkspacePath('../etc', 'ssh:remote-1')).toBe(false);
    expect(relativeRemotePath('/home', '/etc/config.txt')).toBe('/etc/config.txt');
    expect(resolveRemotePath('/home', '/etc/config.txt')).toBe('/etc/config.txt');
    expect(resolveRemotePath('/home', 'notes.txt')).toBe('/home/notes.txt');
    expect(resolveRemotePath('/', '.')).toBe('/');
  });

  it('starts attachment browsing at / and submits files outside the configured directory', async () => {
    const { result } = mount({
      mode: 'project',
      projectId: 'project-1',
      binding: {
        id: 'binding-1',
        revision: 1,
        runnerId: null,
        remoteConnectionId: 'remote-1',
        workspaceId: 'ssh:remote-1',
        canonicalCwd: '/var/www',
        instructions: {},
      },
    });
    await waitFor(() => expect(result.current.selectedRemote?.id).toBe('remote-1'));
    act(() => result.current.composer.onAttachmentButtonClick?.());
    expect(result.current.explorerProps?.open).toBe(true);
    expect(result.current.explorerProps?.initialPath).toBe('/');
    mocks.directory.mockResolvedValue({ root: '/', path: '/', parent: null, entries: [] });
    await result.current.explorerProps!.loadDirectory();
    expect(mocks.directory).toHaveBeenCalledWith('remote-1', { path: '/' }, {});
    mocks.summary.mockResolvedValue({
      items: [
        {
          path: '/etc/config.txt',
          size: 42,
          sha256: 'a'.repeat(64),
          mtime: '2026-10-24T00:00:00Z',
        },
      ],
    });
    await act(async () => {
      await result.current.explorerProps!.onConfirm([
        { name: 'config.txt', path: '/etc/config.txt', kind: 'file' },
      ]);
    });
    const attachment = result.current.composer.attachments![0]!.metadata;
    expect(attachmentSchema.safeParse(attachment).success).toBe(true);
    expect(attachment.ref).toEqual({
      kind: 'ssh',
      remoteConnectionId: 'remote-1',
      path: '/etc/config.txt',
    });
    expect(result.current.explorerProps?.selectedPaths).toEqual(['/etc/config.txt']);
    mocks.create.mockResolvedValue({ id: 'new-conversation' });
    await act(async () => {
      await result.current.submit({
        text: 'read this file',
        files: [],
        attachments: result.current.composer.attachments!,
      });
    });
    expect(mocks.create.mock.calls[0]![0].initialInput.blocks).toContainEqual(
      expect.objectContaining({ type: 'file', attachment }),
    );
  });
});
describe('conversation commands', () => {
  it('creates a conversation only after the first accepted message and keeps failed text available', async () => {
    mocks.create
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ id: 'new-conversation' });
    const onCreated = vi.fn();
    const { result } = mount({ onCreated });
    act(() => {
      result.current.composer.onTextChange('first message');
    });
    let accepted = true;
    await act(async () => {
      accepted = await result.current.submit(submission('first message'));
    });
    // 提交失败：返回 false 让 Composer 保留草稿，不触发跳转。
    expect(accepted).toBe(false);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(onCreated).not.toHaveBeenCalled();
    expect(result.current.composer.value).toBe('first message');
    await act(async () => {
      accepted = await result.current.submit(submission('first message'));
    });
    expect(accepted).toBe(true);
    expect(onCreated).toHaveBeenCalledWith('new-conversation', null);
    expect(mocks.create.mock.calls[1]![0]).toMatchObject({
      mode: 'chat',
      initialInput: { blocks: [{ id: 'text', type: 'text', text: 'first message' }] },
    });
    // 无附件时不下发 attachments 键；创建成功后草稿被清空。
    expect(mocks.create.mock.calls[1]![0].initialInput).not.toHaveProperty('attachments');
    expect(result.current.composer.value).toBe('');
  });
  it('enqueues follow-up input as next_run while a run is active', async () => {
    mocks.append.mockResolvedValue({ inputId: 'in-1' });
    const { result } = mount({ conversationId: 'existing', isRunning: true });
    await act(async () => {
      await result.current.submit(submission('change direction'));
    });
    expect(mocks.append).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [{ id: 'text', type: 'text', text: 'change direction' }],
        mode: 'next_run',
      }),
    );
  });
  it('converts a queued next_run input into a steering input', async () => {
    mocks.append.mockResolvedValue({ inputId: 'in-2' });
    mocks.removeAsync.mockResolvedValue({});
    const { result } = mount({
      conversationId: 'existing',
      isRunning: true,
      steeringEnabled: true,
      pendingInputs: [
        {
          id: 'in-1',
          state: 'queued',
          input: { mode: 'next_run', blocks: [{ id: 'text', type: 'text', text: 'queued text' }] },
        },
      ],
    });
    expect(result.current.queuedMessages).toEqual([
      { id: 'in-1', text: 'queued text', isSteering: false, canSteer: true },
    ]);
    await act(async () => {
      await result.current.steerQueued('in-1');
    });
    expect(mocks.steer).toHaveBeenCalledWith('in-1');
    expect(mocks.append).not.toHaveBeenCalled();
  });
  it.each([
    { isRunning: false, steeringEnabled: true },
    { isRunning: true, steeringEnabled: false },
    { isRunning: true, steeringEnabled: true, runId: 'reserved-run' },
    { isRunning: true, steeringEnabled: true, mode: 'steer' as const },
  ])('does not steer an ineligible input: %j', async ({ runId, mode, ...options }) => {
    const { result } = mount({
      conversationId: 'existing',
      ...options,
      pendingInputs: [
        {
          id: 'in-1',
          state: 'queued',
          ...(runId ? { runId } : {}),
          input: {
            mode: mode ?? 'next_run',
            blocks: [{ id: 'text', type: 'text', text: 'queued text' }],
          },
        },
      ],
    });
    expect(result.current.queuedMessages[0]?.canSteer).toBe(false);
    await act(async () => {
      await result.current.steerQueued('in-1');
    });
    expect(mocks.steer).not.toHaveBeenCalled();
  });
  it('removes a queued input on demand', async () => {
    const { result } = mount({
      conversationId: 'existing',
      isRunning: true,
      pendingInputs: [
        {
          id: 'in-1',
          state: 'queued',
          input: { mode: 'next_run', blocks: [{ id: 'text', type: 'text', text: 'queued text' }] },
        },
      ],
    });
    act(() => {
      result.current.removeQueued('in-1');
    });
    expect(mocks.remove).toHaveBeenCalledWith('in-1');
  });
  it('preserves editable drafts while an unbound project prevents submission', async () => {
    const { result } = mount({ mode: 'project', projectId: 'project-1' });
    act(() => {
      result.current.composer.onTextChange('project draft');
    });
    let accepted = true;
    await act(async () => {
      accepted = await result.current.submit(submission('project draft'));
    });
    expect(accepted).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(result.current.composer.value).toBe('project draft');
    // 页面依据该标记弹「先不发送 / 去绑定」Dialog。
    expect(result.current.unboundOpen).toBe(true);
    act(() => {
      result.current.closeUnbound();
    });
    expect(result.current.unboundOpen).toBe(false);
  });
});
