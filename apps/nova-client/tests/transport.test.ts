import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, configureAuth, refreshAuth, retryAfterSeconds } from '../src/api/transport';
import { ApiError, errorMessage } from '../src/api/api-error';
import { CommandIntent } from '../src/api/command-intent';

const { notifyApiFailure } = vi.hoisted(() => ({ notifyApiFailure: vi.fn() }));
vi.mock('../src/api/api-notify', () => ({ notifyApiFailure }));

const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 200, data }), {
    headers: { 'content-type': 'application/json' },
  });
afterEach(() => {
  vi.unstubAllGlobals();
  notifyApiFailure.mockClear();
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
    expect(notifyApiFailure).not.toHaveBeenCalled();
  });
  it.each([
    { refreshed: false, attempts: 1 },
    { refreshed: true, attempts: 2 },
  ])(
    'reports a final 401 once (refresh succeeded: $refreshed)',
    async ({ refreshed, attempts }) => {
      const refresh = vi.fn(async () => refreshed);
      const unauthorized = vi.fn();
      configureAuth({ token: () => 'token', refresh, unauthorized });
      const fetcher = vi.fn(async () => new Response('{"code":401}', { status: 401 }));
      vi.stubGlobal('fetch', fetcher);

      await expect(apiFetch('/a')).rejects.toMatchObject({ status: 401, notified: true });
      expect(refresh).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledTimes(attempts);
      expect(unauthorized).toHaveBeenCalledOnce();
      expect(notifyApiFailure).toHaveBeenCalledOnce();
    },
  );

  it('does not automatically retry a write after a 503', async () => {
    const fetcher = vi.fn(async () => new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);

    await expect(apiFetch('/a', { method: 'POST' })).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledOnce();
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
  it('reads date-based Retry-After and ignores invalid values', () => {
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

describe('REST error notifications', () => {
  it('reports a connection failure and retains its readable message', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const failure = await apiFetch('/a').catch((error: unknown) => error);
    expect(notifyApiFailure).toHaveBeenCalledWith(
      'network',
      '无法连接服务，请检查网络。',
      undefined,
    );
    expect(failure).toMatchObject({ status: 0, code: 'NETWORK_ERROR', notified: true });
    expect(errorMessage(failure)).toBe('无法连接服务，请检查网络。');
  });

  it('reports server unavailability as a notification', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>stack trace</html>', { status: 500 }));
    const failure = await apiFetch('/a').catch((error: unknown) => error);
    expect(notifyApiFailure).toHaveBeenCalledWith(
      'server',
      '服务暂时不可用，请稍后重试。',
      undefined,
    );
    expect(failure).toMatchObject({
      status: 500,
      message: '服务暂时不可用，请稍后重试。',
      notified: true,
    });
  });

  it.each([
    [400, '请检查填写的内容后重试。'],
    [403, '权限不足，无法访问此资源。'],
    [404, '资源不存在或已被删除。'],
    [409, '状态已变更，请刷新后确认并重新提交。'],
    [422, '请检查填写的内容。'],
    [429, '请求受到限制，请稍后再试。'],
  ])(
    'notifies HTTP %i with a safe message and preserves the error for callers',
    async (status, message) => {
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(
            JSON.stringify({
              code: status,
              subCode: 'BUSINESS_ERROR',
              message: 'raw server error',
              requestId: 'request-1',
              details: { field: 'name', reason: 'CONFLICT' },
            }),
            { status, headers: { 'retry-after': '12' } },
          ),
      );
      const failure = await apiFetch('/a').catch((error: unknown) => error);
      expect(notifyApiFailure).toHaveBeenCalledOnce();
      expect(notifyApiFailure).toHaveBeenCalledWith('request', message, '请求编号：request-1');
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({
        status,
        code: 'BUSINESS_ERROR',
        message,
        notified: true,
        httpStatus: status,
        requestId: 'request-1',
        field: 'name',
        details: { field: 'name', reason: 'CONFLICT' },
        retryAfterSeconds: 12,
      });
    },
  );

  it.each([0, 400, 500])(
    'leaves silent failures quiet (status %i) while rejecting',
    async (status) => {
      vi.stubGlobal('fetch', async () => {
        if (!status) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ code: status }), { status });
      });
      const silent = await apiFetch('/a', { silent: true }).catch((error: unknown) => error);
      expect(notifyApiFailure).not.toHaveBeenCalled();
      expect(silent).toMatchObject({ notified: false });
    },
  );

  it.each([409, 10001])(
    'notifies business code %i inside HTTP 200 and keeps its original code',
    async (code) => {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code })));
      await expect(apiFetch('/a')).rejects.toMatchObject({
        status: code === 409 ? 409 : 502,
        httpStatus: 200,
        code,
        notified: true,
      });
      expect(notifyApiFailure).toHaveBeenCalledOnce();
    },
  );

  it.each(['<html>error</html>', '{"code":200}', 'null'])(
    'notifies malformed or incomplete successful responses: %s',
    async (body) => {
      vi.stubGlobal('fetch', async () => new Response(body));
      await expect(apiFetch('/a')).rejects.toMatchObject({ status: 502, notified: true });
      expect(notifyApiFailure).toHaveBeenCalledOnce();
    },
  );

  it('notifies timeouts without swallowing the rejection', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      await new Promise<void>((resolve) =>
        init.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw init.signal!.reason;
    });
    await expect(apiFetch('/a', { timeoutMs: 1 })).rejects.toMatchObject({
      code: 'TIMEOUT',
      notified: true,
    });
    expect(notifyApiFailure).toHaveBeenCalledOnce();
    expect(notifyApiFailure).toHaveBeenCalledWith(
      'timeout',
      '请求超时，请重试同一次操作。',
      undefined,
    );
  });

  it('preserves caller cancellation without a notification', async () => {
    const controller = new AbortController();
    const cancelled = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', async (_url: string, { signal }: RequestInit) => {
      expect(signal?.aborted).toBe(false);
      controller.abort();
      expect(signal?.aborted).toBe(true);
      throw cancelled;
    });
    await expect(apiFetch('/a', { signal: controller.signal })).rejects.toBe(cancelled);
    expect(notifyApiFailure).not.toHaveBeenCalled();
  });
});
