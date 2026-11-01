import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { CasdoorClient } from '../../../packages/casdoor/src/client/core';
import type { CasdoorUser } from '../../../packages/casdoor/src/types';
import { AuthBoundary, useIdentity } from '../src/features/auth';
import { CallbackPage } from '../src/features/auth/callback.page';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('../src/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

const user = {
  id: 'casdoor-alice',
  owner: 'org',
  name: 'alice',
  displayName: 'Alice',
  roles: [],
} as unknown as CasdoorUser;
const token = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 120,
  token_type: 'Bearer',
};
const clients: CasdoorClient[] = [];
function client() {
  const value = new CasdoorClient({
    appName: 'nova',
    storage: { type: 'sessionStorage', prefix: 'nova_' },
    silentRefresh: true,
  });
  clients.push(value);
  return value;
}
function callback(state: string | null = 'expected') {
  window.history.replaceState(
    { router: 'keep' },
    '',
    '/callback?code=one-time-code&state=expected',
  );
  if (state) sessionStorage.setItem('casdoor_oauth_state_nova', state);
}
afterEach(() => {
  cleanup();
  clients.forEach((value) => value.destroy());
  clients.length = 0;
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([null, 'other'])(
  'rejects missing/mismatched pending state (%s) before token exchange',
  async (state) => {
    callback(state);
    const exchange = vi.fn();
    const value = client();
    expect(await value.handleCallback(exchange)).toBe(false);
    expect(exchange).not.toHaveBeenCalled();
    expect(value.getState().isAuthenticated).toBe(false);
    expect(window.location.search).toBe('');
  },
);

it('shares a callback exchange, preserves router history state and consumes the code once', async () => {
  callback();
  const exchange = vi.fn(async () => ({ token, user }));
  const value = client();
  expect(
    await Promise.all([value.handleCallback(exchange), value.handleCallback(exchange)]),
  ).toEqual([true, true]);
  expect(exchange).toHaveBeenCalledOnce();
  expect(window.history.state).toEqual({ router: 'keep' });
  expect(await value.handleCallback(exchange)).toBe(false);
  expect(exchange).toHaveBeenCalledOnce();
});

it('shares refresh across timer/requests, retains rotated credentials and ignores completion after logout', async () => {
  callback();
  const value = client();
  await value.handleCallback(async () => ({ token, user }));
  const refresh = vi.fn(async () => ({
    ...token,
    access_token: 'rotated',
    refresh_token: 'rotated-refresh',
  }));
  expect(await Promise.all([value.refreshToken(refresh), value.refreshToken(refresh)])).toEqual([
    true,
    true,
  ]);
  expect(refresh).toHaveBeenCalledOnce();
  expect(value.getState().accessToken).toBe('rotated');
  let finish!: (result: typeof token) => void;
  const pending = value.refreshToken(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  value.logout();
  finish({ ...token, access_token: 'late' });
  expect(await pending).toBe(false);
  expect(value.getState().accessToken).toBeNull();
  expect(sessionStorage.getItem('nova_nova_access_token')).toBeNull();
});

it('restores an expired session with refresh and restarts short-TTL timers after effect cleanup', async () => {
  vi.useFakeTimers();
  callback();
  const value = client();
  await value.handleCallback(async () => ({ token: { ...token, expires_in: 2 }, user }));
  value.destroy();
  vi.advanceTimersByTime(3000);
  const restored = client();
  const refresh = vi.fn(
    async () => new Response(JSON.stringify({ ...token, access_token: 'restored', expires_in: 2 })),
  );
  vi.stubGlobal('fetch', refresh);
  restored.start();
  restored.destroy();
  restored.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(restored.getState()).toMatchObject({
    isAuthenticated: true,
    isLoading: false,
    user,
    accessToken: 'restored',
  });
  expect(refresh).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('clears credentials when refresh fails or no refresh token exists', async () => {
  callback();
  const value = client();
  await value.handleCallback(async () => ({ token, user }));
  expect(
    await value.refreshToken(async () => {
      throw new Error('expired');
    }),
  ).toBe(false);
  expect(value.getState().isAuthenticated).toBe(false);
  expect(sessionStorage.getItem('nova_nova_refresh_token')).toBeNull();
  callback();
  await value.handleCallback(async () => ({ token: { access_token: 'no-refresh' }, user }));
  expect(await value.refreshToken()).toBe(false);
  expect(value.getState().accessToken).toBeNull();
});

it('completes the real auth bridge under StrictMode without a loading/remount callback loop', async () => {
  callback();
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ token, user })));
  vi.stubGlobal('fetch', fetcher);
  function IdentityView() {
    const { identity } = useIdentity();
    return (
      <>
        <CallbackPage />
        <output>{identity?.identityId}</output>
      </>
    );
  }
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <StrictMode>
      <QueryClientProvider client={cache}>
        <AuthBoundary>
          <IdentityView />
        </AuthBoundary>
      </QueryClientProvider>
    </StrictMode>,
  );
  await waitFor(() => expect(screen.getByText('casdoor-alice')).toBeTruthy());
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({ to: '/conversations', replace: true }),
  );
  expect(fetcher).toHaveBeenCalledOnce();
  await act(async () => {
    await Promise.resolve();
  });
  expect(window.location.search).toBe('');
  cache.clear();
});
