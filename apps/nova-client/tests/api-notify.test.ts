import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

const { notifyApiFailure } = vi.hoisted(() => ({ notifyApiFailure: vi.fn() }));
vi.mock('../src/api/api-notify', () => ({ notifyApiFailure }));

import { apiFetch, configureAuth } from '../src/api/transport';
import { ApiError, errorMessage } from '../src/api/api-error';
import { ErrorNotice } from '../src/components/error-notice';

describe('API failures become notifications', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    notifyApiFailure.mockClear();
    configureAuth({ token: () => null, refresh: async () => false, unauthorized: () => {} });
  });

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
    expect(failure).toMatchObject({ status: 500, notified: true });
  });

  it.each([400, 403, 404, 409, 422, 429])(
    'notifies HTTP %i and preserves the error for callers',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(
            JSON.stringify({
              code: status,
              subCode: 'BUSINESS_ERROR',
              requestId: 'request-1',
              details: { field: 'name', reason: 'CONFLICT' },
            }),
            { status, headers: { 'retry-after': '12' } },
          ),
      );
      const failure = await apiFetch('/a').catch((error: unknown) => error);
      expect(notifyApiFailure).toHaveBeenCalledOnce();
      expect(notifyApiFailure).toHaveBeenCalledWith(
        'request',
        errorMessage(failure),
        '请求编号：request-1',
      );
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({
        status,
        code: 'BUSINESS_ERROR',
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
    vi.stubGlobal('fetch', async () => {
      controller.abort();
      throw cancelled;
    });
    await expect(apiFetch('/a', { signal: controller.signal })).rejects.toBe(cancelled);
    expect(notifyApiFailure).not.toHaveBeenCalled();
  });

  it('does not notify a 401 that is recovered by token refresh', async () => {
    configureAuth({ token: () => 'token', refresh: async () => true, unauthorized: vi.fn() });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{"code":401}', { status: 401 }))
        .mockResolvedValueOnce(new Response('{"code":200,"data":"ok"}')),
    );
    await expect(apiFetch('/a')).resolves.toBe('ok');
    expect(notifyApiFailure).not.toHaveBeenCalled();
  });

  it('notifies a final 401 exactly once after refresh fails', async () => {
    const unauthorized = vi.fn();
    configureAuth({ token: () => 'token', refresh: async () => false, unauthorized });
    vi.stubGlobal('fetch', async () => new Response('{"code":401}', { status: 401 }));
    await expect(apiFetch('/a')).rejects.toMatchObject({ status: 401, notified: true });
    expect(notifyApiFailure).toHaveBeenCalledOnce();
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  it('suppresses duplicate inline alerts and retains retry and local validation feedback', () => {
    const failure = new ApiError(400, 'INVALID_NAME', '请输入名称。');
    failure.notified = true;
    const { rerender } = render(createElement(ErrorNotice, { error: failure }));
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(createElement(ErrorNotice, { error: failure, onRetry: vi.fn() }));
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.queryByText(failure.message)).toBeNull();
    failure.notified = false;
    rerender(createElement(ErrorNotice, { error: failure }));
    expect(screen.getByText(failure.message)).toBeTruthy();
  });
});
