import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentPropsWithRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/', search: {} }),
  useMatchRoute: () => () => undefined,
  Link: ({
    to,
    params,
    onClick,
    ...props
  }: ComponentPropsWithRef<'a'> & { to: string; params?: Record<string, string> }) => (
    <a
      {...props}
      href={to.replace('$id', params?.id ?? '')}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
      }}
    />
  ),
}));

import { SidebarContent } from '../src/app/sidebar/sidebar';

function mount() {
  const onEditProject = vi.fn();
  const onNavigate = vi.fn();
  render(
    <SidebarContent
      projects={[{ id: 'p1', name: 'Alpha', runnerState: 'ready', workspace: '/workspace/alpha' }]}
      conversations={[]}
      onNewProject={() => {}}
      onNewChat={() => {}}
      onSearch={() => {}}
      onCollapse={() => {}}
      onNewProjectChat={() => {}}
      onEditProject={onEditProject}
      onNavigate={onNavigate}
      onDeleteConversation={() => {}}
      identity={{ displayName: 'Nova', userId: 'u1' }}
      onLogout={() => {}}
    />,
  );
  return { user: userEvent.setup(), onEditProject, onNavigate };
}

afterEach(cleanup);

describe('project details popover', () => {
  it('stays mounted while hovering the project and moving into its details', async () => {
    const { user } = mount();
    const link = screen.getByRole('link', { name: 'Alpha' });
    await user.hover(link);
    const popup = await screen.findByRole('dialog', { name: 'Alpha' });
    expect(screen.getByText('/workspace/alpha')).toBeTruthy();
    expect(screen.getByText('0 个任务')).toBeTruthy();
    expect(document.activeElement).not.toBe(popup);
    expect(document.querySelector('[data-testid="underlay"]')).toBeNull();

    const removed = vi.fn();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node === popup || node.contains(popup)) removed();
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      await act(() => new Promise((resolve) => setTimeout(resolve, 1000)));
      await user.hover(screen.getByRole('button', { name: '编辑项目' }));
      await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
      expect(screen.getByRole('dialog', { name: 'Alpha' })).toBe(popup);
      expect(removed).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
    }
  });

  it('closes after leaving the project and popup, and dismisses with Escape', async () => {
    const { user } = mount();
    const link = screen.getByRole('link', { name: 'Alpha' });
    await user.hover(link);
    await screen.findByRole('dialog', { name: 'Alpha' });
    await user.hover(screen.getByRole('button', { name: '新建普通会话' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.hover(link);
    await screen.findByRole('dialog', { name: 'Alpha' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('edits the project and preserves project link navigation', async () => {
    const { user, onEditProject, onNavigate } = mount();
    const link = screen.getByRole('link', { name: 'Alpha' });
    expect(link.getAttribute('href')).toBe('/projects/p1');
    await user.hover(link);
    await user.click(await screen.findByRole('button', { name: '编辑项目' }));
    expect(onEditProject).toHaveBeenCalledOnce();
    expect(onEditProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(link);
    expect(onNavigate).toHaveBeenCalledOnce();
  });
});
