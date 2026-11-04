import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  identity: null as { identityId: string } | null,
  endpoint: 'wss://nova.example/runner/v1/connect',
  connectionError: false,
  copy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/features/auth', () => ({
  useIdentity: () => ({ identity: state.identity, login: vi.fn() }),
}));
vi.mock('@/features/runners', async () => ({
  ...(await import('../src/features/runners/runner.commands')),
  useRunnerConnection: () => ({
    data: { endpoint: state.endpoint },
    isError: state.connectionError,
    isPending: false,
    refetch: vi.fn(),
  }),
  useRunnerTokensQuery: () => ({
    data: { items: [{ status: 'active', token: 'runner-test-token', expiresAt: null }] },
    isError: false,
    isPending: !state.identity,
  }),
}));
vi.mock('@/lib/clipboard', () => ({ copyText: state.copy }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    onPress,
    isIconOnly: _isIconOnly,
    variant: _variant,
    ...props
  }: ComponentProps<'button'> & {
    onPress?: () => void;
    isIconOnly?: boolean;
    variant?: string;
  }) => <button {...props} onClick={onPress} />,
}));

import { ConnectPanel } from '../src/features/landing/connect-panel';

afterEach(cleanup);
beforeEach(() => {
  state.identity = null;
  state.connectionError = false;
  state.copy.mockClear();
});

describe('homepage connection commands', () => {
  it('shows and copies a placeholder command while signed out, ignoring cached tokens', () => {
    const { container } = render(<ConnectPanel />);
    const command = container.querySelector('code')!.textContent!;
    expect(command).toContain("--token '<token>'");
    expect(command).toContain(`--server '${state.endpoint}'`);
    expect(command).not.toContain('runner-test-token');
    fireEvent.click(screen.getByRole('button', { name: '复制启动命令' }));
    expect(state.copy).toHaveBeenCalledWith(command.slice(2));
    fireEvent.click(screen.getByRole('button', { name: '正式部署' }));
    expect(container.querySelector('code')!.textContent).toContain('npx --yes');
    expect(container.querySelector('code')!.textContent).toContain("--token '<token>'");
  });

  it('fills the usable token after login and restores the placeholder after logout', () => {
    const view = render(<ConnectPanel />);
    state.identity = { identityId: 'user-1' };
    view.rerender(<ConnectPanel />);
    expect(view.container.querySelector('code')!.textContent).toContain(
      "--token 'runner-test-token'",
    );
    state.identity = null;
    view.rerender(<ConnectPanel />);
    expect(view.container.querySelector('code')!.textContent).toContain("--token '<token>'");
  });

  it('offers retry when the public connection address cannot load', () => {
    state.connectionError = true;
    render(<ConnectPanel />);
    expect(screen.getByText('连接信息加载失败，请重试。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新加载连接信息' })).toBeTruthy();
  });
});
