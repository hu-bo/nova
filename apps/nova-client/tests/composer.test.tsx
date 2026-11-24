import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '@nova/chat-ui';
import { readDraft, saveDraft } from '../src/features/conversations/draft-storage';

const productSkills = [
  {
    id: 'nova.career-coach',
    version: '1.0.0',
    name: '求职教练',
    description: '简历修改和面试',
    source: 'builtin' as const,
  },
  {
    id: 'test.writing',
    version: '2.0.0',
    name: '写作润色',
    description: '文章编辑',
    source: 'builtin' as const,
  },
];
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
describe('composer acceptance and accessible input', () => {
  it('selects a skill with the keyboard without submitting the message', async () => {
    const select = vi.fn();
    const submit = vi.fn();
    render(
      <Composer productSkills={productSkills} onProductSkillChange={select} onSubmit={submit} />,
    );
    await userEvent.type(screen.getByRole('textbox'), '@');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(select).toHaveBeenCalledWith({ id: 'test.writing', version: '2.0.0' });
    expect(submit).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('searches skill descriptions and replaces only the mention at the cursor', async () => {
    const select = vi.fn();
    render(
      <Composer
        productSkills={productSkills}
        onProductSkillChange={select}
        onSubmit={() => undefined}
      />,
    );
    const textbox = screen.getByRole<HTMLTextAreaElement>('textbox');
    await userEvent.type(textbox, '请修改 @简历 后面的内容');
    textbox.setSelectionRange('请修改 @简'.length, '请修改 @简'.length);
    fireEvent.select(textbox);
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await userEvent.keyboard('{Enter}');
    expect(select).toHaveBeenCalledWith({ id: 'nova.career-coach', version: '1.0.0' });
    expect(textbox.value).toBe('请修改  后面的内容');
  });

  it('opens the same picker from the toolbar and removes a selected skill', async () => {
    const select = vi.fn();
    render(
      <Composer
        initialText="保留正文"
        productSkills={productSkills}
        selectedProductSkill={productSkills[0]}
        onProductSkillChange={select}
        onSubmit={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '选择技能' }));
    await userEvent.click(screen.getByRole('option', { name: /写作润色/ }));
    expect(select).toHaveBeenLastCalledWith({ id: 'test.writing', version: '2.0.0' });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('保留正文');
    await userEvent.click(screen.getByRole('button', { name: '移除技能' }));
    expect(select).toHaveBeenLastCalledWith(null);
  });

  it('ignores email addresses and keeps IME confirmation from selecting a skill', async () => {
    const select = vi.fn();
    const submit = vi.fn();
    render(
      <Composer productSkills={productSkills} onProductSkillChange={select} onSubmit={submit} />,
    );
    const textbox = screen.getByRole('textbox');
    await userEvent.type(textbox, 'contact@example.com');
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.clear(textbox);
    await userEvent.type(textbox, '@求职');
    fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(select).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('dismisses skill search before aborting a run and does not submit unmatched searches', async () => {
    const abort = vi.fn();
    const submit = vi.fn();
    render(
      <Composer
        productSkills={productSkills}
        onProductSkillChange={() => undefined}
        isRunning
        onAbort={abort}
        onSubmit={submit}
      />,
    );
    await userEvent.type(screen.getByRole('textbox'), '@不存在');
    expect(screen.getByText('没有匹配的技能')).toBeTruthy();
    await userEvent.keyboard('{Enter}{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(abort).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(abort).toHaveBeenCalledOnce();
  });

  it('keeps slash command selection separate from product skills', async () => {
    const invoke = vi.fn();
    const select = vi.fn();
    render(
      <Composer
        skills={[{ id: 'plan', command: 'plan', label: '制定计划' }]}
        onSkillInvoke={invoke}
        productSkills={productSkills}
        onProductSkillChange={select}
        onSubmit={() => undefined}
      />,
    );
    await userEvent.type(screen.getByRole('textbox'), '/pl');
    await userEvent.keyboard('{Enter}');
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan' }));
    expect(select).not.toHaveBeenCalled();
  });

  it('shows skill source and server reasons and refuses unavailable skills', async () => {
    const select = vi.fn();
    const entries = [
      ...productSkills,
      {
        id: '00000000-0000-4000-8000-0000000000a2',
        version: '0.0.1',
        name: '仓库巡检',
        description: '需要工作区',
        source: 'runner-global' as const,
        applicability: {
          status: 'unavailable' as const,
          reasons: [{ code: 'workspace_required' as const, message: '技能需要绑定工作区' }],
        },
      },
    ];
    render(<Composer productSkills={entries} onProductSkillChange={select} onSubmit={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: '选择技能' }));
    const option = screen.getByRole('option', { name: /仓库巡检/ });
    expect((option as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('技能需要绑定工作区');
    expect(document.body.textContent).toContain('本机全局');
    await userEvent.click(option);
    expect(select).not.toHaveBeenCalled();
  });

  it('selects agents from a separate picker and removes the agent tag', async () => {
    const selectAgent = vi.fn();
    const agents = [
      {
        refId: '00000000-0000-4000-8000-0000000000b1',
        name: '代码评审员',
        description: '本地评审 Agent',
        source: 'runner-project' as const,
        version: '0.0.1',
        incompatibilities: [],
      },
      {
        refId: '00000000-0000-4000-8000-0000000000b2',
        name: '旧版助手',
        description: '含未支持字段',
        source: 'platform' as const,
        version: '0.0.2',
        incompatibilities: [
          { code: 'mode_not_allowed' as const, message: '包含未支持字段 mode: subagent' },
        ],
      },
    ];
    render(
      <Composer
        productSkills={productSkills}
        onProductSkillChange={() => undefined}
        agents={agents}
        selectedAgent={{ source: 'runner-project', refId: agents[0]!.refId, version: '0.0.1' }}
        onAgentChange={selectAgent}
        onSubmit={() => undefined}
      />,
    );
    // Agent 标签独立于技能标签展示，可移除。
    expect(screen.getByRole('button', { name: '移除 Agent' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '移除 Agent' }));
    expect(selectAgent).toHaveBeenCalledWith(null);
    await userEvent.click(screen.getByRole('button', { name: '选择 Agent' }));
    expect(screen.getByRole('listbox', { name: '选择 Agent' })).toBeTruthy();
    const blockedOption = screen.getByRole('option', { name: /旧版助手/ });
    expect((blockedOption as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('包含未支持字段 mode: subagent');
    await userEvent.click(screen.getByRole('option', { name: /代码评审员/ }));
    expect(selectAgent).toHaveBeenCalledWith({
      source: 'runner-project',
      refId: agents[0]!.refId,
      version: '0.0.1',
    });
  });

  it('retains text after a rejected submission and clears only after acceptance', async () => {
    const submit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<Composer onSubmit={submit} />);
    const textbox = screen.getByRole('textbox');
    await userEvent.type(textbox, 'important draft');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect((textbox as HTMLTextAreaElement).value).toBe('important draft');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect((textbox as HTMLTextAreaElement).value).toBe(''));
    expect(submit).toHaveBeenCalledTimes(2);
  });
  it('keeps Shift+Enter and IME composition from accidentally submitting', async () => {
    const submit = vi.fn();
    render(<Composer onSubmit={submit} />);
    const textbox = screen.getByRole('textbox');
    await userEvent.type(textbox, '中文输入');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(submit).not.toHaveBeenCalled();
  });
  it('continues editing while attachments block submission', async () => {
    const submit = vi.fn();
    render(<Composer onSubmit={submit} submitDisabled />);
    await userEvent.type(screen.getByRole('textbox'), 'still editing');
    await userEvent.keyboard('{Enter}');
    expect(submit).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('still editing');
  });
  it('attaches clipboard images pasted into the input by default', () => {
    const onFilesSelected = vi.fn();
    render(<Composer onFilesSelected={onFilesSelected} onSubmit={() => undefined} />);
    const image = new File(['png'], 'image.png', { type: 'image/png' });
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
        files: [],
        types: ['Files'],
      },
    });
    expect(onFilesSelected).toHaveBeenCalledWith([image]);
  });
  it('leaves a plain text paste to the browser', () => {
    const onFilesSelected = vi.fn();
    render(<Composer onFilesSelected={onFilesSelected} onSubmit={() => undefined} />);
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { items: [], files: [], types: ['text/plain'] },
    });
    expect(onFilesSelected).not.toHaveBeenCalled();
  });
  it('falls back to the async clipboard when the paste event carries no image', async () => {
    const png = new Blob(['bitmap'], { type: 'image/png' });
    const read = vi.fn().mockResolvedValue([{ types: ['image/png'], getType: async () => png }]);
    vi.stubGlobal('navigator', { clipboard: { read } });
    const onFilesSelected = vi.fn();
    render(<Composer onFilesSelected={onFilesSelected} onSubmit={() => undefined} />);
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { items: [], files: [], types: ['Files'] },
    });
    await waitFor(() => expect(onFilesSelected).toHaveBeenCalledOnce());
    const attached = onFilesSelected.mock.calls[0]?.[0]?.[0];
    expect(attached?.type).toBe('image/png');
    expect(attached?.name).toMatch(/^pasted-\d+\.png$/);
    expect(attached?.size).toBe(6);
  });
  it('isolates persisted draft text by identity and conversation', () => {
    saveDraft('alice', 'conversation-1', 'private draft');
    saveDraft('bob', 'conversation-1', 'other draft');
    expect(readDraft('alice', 'conversation-1')).toBe('private draft');
    expect(readDraft('bob', 'conversation-1')).toBe('other draft');
    expect(readDraft('alice', 'conversation-2')).toBe('');
    saveDraft('alice', 'conversation-1', '');
    expect(readDraft('alice', 'conversation-1')).toBe('');
  });
});
