import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '@nova/chat-ui';
import { readDraft, saveDraft } from '../src/features/conversations/draft-storage';
afterEach(() => {
  cleanup();
  localStorage.clear();
});
describe('composer acceptance and accessible input', () => {
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
