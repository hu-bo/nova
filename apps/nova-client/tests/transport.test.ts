import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, configureAuth, refreshAuth, retryAfterSeconds } from '../src/api/transport';
import { CommandIntent } from '../src/api/command-intent';
const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 200, data }), {
    headers: { 'content-type': 'application/json' },
  });
afterEach(() => {
  vi.unstubAllGlobals();
  configureAuth({ token: () => null, refresh: async () => false, unauthorized: () => {} });
});
describe('REST boundary and submission intent', () => {
  it('replays a request after one shared refresh, preserving its key and body', async () => {
    let token = 'old';
    const refresh = vi.fn(async () => {
      token = 'new';
      return true;
    });
    configureAuth({ token: () => token, refresh, unauthorized: vi.fn() });
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        calls.push(init);
        return new Headers(init.headers).get('authorization') === 'Bearer old'
          ? new Response('{}', { status: 401 })
          : ok('accepted');
      }),
    );
    const values = await Promise.all([
      apiFetch('/a', { method: 'POST', body: '{"text":"draft"}', idempotencyKey: 'intent' }),
      apiFetch('/b'),
    ]);
    expect(values).toEqual(['accepted', 'accepted']);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(new Headers(calls[2]!.headers).get('idempotency-key')).toBe('intent');
    expect(calls[2]!.body).toBe(calls[0]!.body);
  });
  it('does not repeatedly replay 401 or automatically retry writes after a 503', async () => {
    const unauthorized = vi.fn();
    configureAuth({ token: () => 'token', refresh: async () => true, unauthorized });
    const fetcher = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(apiFetch('/a')).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(unauthorized).toHaveBeenCalledOnce();
    fetcher.mockImplementation(async () => new Response('busy', { status: 503 }));
    fetcher.mockClear();
    await expect(apiFetch('/a', { method: 'POST' })).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps raw server errors out of the UI and retains request IDs and retry hints', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            code: 429,
            message: 'secret database connection string',
            requestId: 'request-1',
          }),
          { status: 429, headers: { 'retry-after': '12' } },
        ),
    );
    await expect(apiFetch('/a')).rejects.toMatchObject({
      status: 429,
      requestId: 'request-1',
      retryAfterSeconds: 12,
      message: '请求受到限制，请稍后再试。',
    });
    vi.stubGlobal('fetch', async () => new Response('<html>stack trace</html>', { status: 500 }));
    await expect(apiFetch('/a')).rejects.toMatchObject({
      status: 500,
      message: '服务暂时不可用，请稍后重试。',
    });
  });
  it('discards requests from an identity that changed during a response', async () => {
    let complete!: (response: Response) => void;
    configureAuth({ token: () => 'alice', refresh: async () => false, unauthorized: vi.fn() });
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = apiFetch('/a');
    configureAuth({ token: () => 'bob', refresh: async () => false, unauthorized: vi.fn() });
    complete(ok('private alice data'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('isolates a refresh already in flight when a new identity installs its providers', async () => {
    let finish!: (ok: boolean) => void;
    configureAuth({
      token: () => 'alice',
      refresh: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      unauthorized: vi.fn(),
    });
    const alice = refreshAuth();
    const bobRefresh = vi.fn(async () => true);
    configureAuth({ token: () => 'bob', refresh: bobRefresh, unauthorized: vi.fn() });
    expect(await refreshAuth()).toBe(true);
    expect(bobRefresh).toHaveBeenCalledOnce();
    finish(true);
    expect(await alice).toBe(false);
  });
  it('honors caller cancellation and understands date-based Retry-After', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeDefined();
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(apiFetch('/a', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(
      retryAfterSeconds('Tue, 06 Oct 2026 00:00:10 GMT', Date.parse('2026-10-06T00:00:00Z')),
    ).toBe(10);
    expect(retryAfterSeconds('invalid')).toBeUndefined();
  });
  it('keeps one key for retries and creates a fresh intent after an accepted identical message', () => {
    const intent = new CommandIntent();
    const first = intent.prepare({ text: 'hello' });
    expect(intent.prepare({ text: 'hello' })).toBe(first);
    expect(intent.prepare({ text: 'edited' })).not.toBe(first);
    const edited = intent.prepare({ text: 'edited' });
    intent.accepted();
    expect(intent.prepare({ text: 'edited' })).not.toBe(edited);
  });
});
