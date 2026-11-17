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
