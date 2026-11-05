import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  identity: null as { identityId: string } | null,
  getConnection: vi.fn(),
  listTokens: vi.fn(),
  copy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/features/auth', () => ({
  useIdentity: () => ({ identity: state.identity, login: vi.fn() }),
}));
vi.mock('@/api/generated/runners', () => ({
  getRunnerConnectionInfo: state.getConnection,
  listRunnerTokens: state.listTokens,
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
  state.getConnection.mockClear();
  state.listTokens.mockReset().mockResolvedValue({
    items: [{ status: 'active', token: 'runner-test-token', expiresAt: null }],
  });
  state.copy.mockClear();
});

function renderConnectPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<ConnectPanel />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...view, client };
}

describe('homepage connection commands', () => {
  it('shows copyable commands with fixed endpoints and makes no requests while signed out', async () => {
    const { container } = renderConnectPanel();
    const code = container.querySelector('code')!;
    fireEvent.click(screen.getByRole('button', { name: '本地开发' }));
    expect(code.textContent).toContain("--server 'ws://127.0.0.1:9203/runner/v1/connect'");
    expect(code.textContent).toContain("--token '<token>'");
    fireEvent.click(screen.getByRole('button', { name: '正式部署' }));
    expect(code.textContent).toContain("--server 'wss://nova.8and1.cn/runner/v1/connect'");
    expect(code.textContent).toContain("--token '<token>'");
    fireEvent.click(screen.getByRole('button', { name: '复制启动命令' }));
    await screen.findByText('启动命令已复制。');
    expect(state.copy).toHaveBeenCalledWith(code.textContent!.slice(2));
    expect(state.getConnection).not.toHaveBeenCalled();
    expect(state.listTokens).not.toHaveBeenCalled();
  });

  it('fills the token after login and restores the placeholder after logout', async () => {
    const view = renderConnectPanel();
    expect(view.container.querySelector('code')!.textContent).toContain("--token '<token>'");
    state.identity = { identityId: 'user-1' };
    view.rerender(<ConnectPanel />);
    await waitFor(() =>
      expect(view.container.querySelector('code')!.textContent).toContain(
        "--token 'runner-test-token'",
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '正式部署' }));
    const command = view.container.querySelector('code')!.textContent!;
    expect(command).toContain('npx --yes');
    expect(state.listTokens).toHaveBeenCalledWith(expect.objectContaining({ silent: true }));
    state.identity = null;
    view.rerender(<ConnectPanel />);
    expect(view.container.querySelector('code')!.textContent).toContain("--token '<token>'");
    expect(state.listTokens).toHaveBeenCalledTimes(1);
    expect(state.getConnection).not.toHaveBeenCalled();
  });

  it('keeps the endpoint and token placeholder when the token request fails', async () => {
    state.identity = { identityId: 'user-1' };
    state.listTokens.mockRejectedValue(new Error('Tokens unavailable'));
    const { container, client } = renderConnectPanel();
    fireEvent.click(screen.getByRole('button', { name: '正式部署' }));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(container.querySelector('code')!.textContent).toContain(
      "--server 'wss://nova.8and1.cn/runner/v1/connect' --token '<token>'",
    );
    expect(screen.queryByText('连接信息加载失败，请重试。')).toBeNull();
  });
});
