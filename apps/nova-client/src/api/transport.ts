import { z } from 'zod';
import { ApiError } from './api-error';
import { notifyApiFailure, type ApiFailureKind } from './api-notify';

const envelopeSchema = z.object({
  code: z.number(),
  subCode: z.union([z.number(), z.string()]).optional(),
  message: z.string().optional(),
  requestId: z.string().max(100).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  data: z.unknown().optional(),
});
type Envelope = z.infer<typeof envelopeSchema>;

/** HTTP 成功但信封携带业务错误码时，以信封码为准；无法归类视为网关错误。 */
function resolveStatus(response: Response, envelope: Envelope | null): number {
  if (!response.ok) return response.status;
  if (envelope?.code === 200) return 200;
  if (envelope && envelope.code >= 400 && envelope.code <= 599) return envelope.code;
  return 502;
}

/** 通知的语义分类：网络/超时、响应解析、服务端与请求错误分别对应不同提示样式。 */
function failureKindOf(error: ApiError): ApiFailureKind {
  if (error.status === 0) return error.code === 'TIMEOUT' ? 'timeout' : 'network';
  if (error.code === 'INVALID_RESPONSE') return 'response';
  return error.status >= 500 ? 'server' : 'request';
}
const messages: Record<number, string> = {
  400: '请检查填写的内容后重试。',
  401: '登录状态已过期，请重新登录。',
  403: '权限不足，无法访问此资源。',
  404: '资源不存在或已被删除。',
  409: '状态已变更，请刷新后确认并重新提交。',
  410: '订阅已过期，正在重新获取快照。',
  413: '内容过大，请精简后重试。',
  422: '请检查填写的内容。',
  429: '请求受到限制，请稍后再试。',
  500: '服务暂时不可用，请稍后重试。',
  503: '服务繁忙，请稍后重试。',
};
let tokenProvider: () => string | null = () => null;
let refreshProvider: () => Promise<boolean> = async () => false;
let onUnauthorized: () => void = () => {};
let refreshInFlight: Promise<boolean> | null = null;
let authGeneration = 0;
export function configureAuthTokenProvider(provider: () => string | null): void {
  tokenProvider = provider;
}
export function configureAuth(input: {
  token: () => string | null;
  refresh: () => Promise<boolean>;
  unauthorized: () => void;
}): () => void {
  authGeneration += 1;
  const generation = authGeneration;
  tokenProvider = input.token;
  refreshProvider = input.refresh;
  onUnauthorized = input.unauthorized;
  refreshInFlight = null;
  return () => {
    if (authGeneration === generation) {
      authGeneration += 1;
      tokenProvider = () => null;
      refreshProvider = async () => false;
      onUnauthorized = () => {};
    }
  };
}
export const getAuthToken = () => tokenProvider();
export const expireAuth = () => onUnauthorized();
export async function refreshAuth(): Promise<boolean> {
  if (!refreshInFlight) {
    const generation = authGeneration;
    const pending = refreshProvider()
      .catch(() => false)
      .then((ok) => {
        if (!ok && generation === authGeneration) onUnauthorized();
        return ok && generation === authGeneration;
      })
      .finally(() => {
        if (refreshInFlight === pending) refreshInFlight = null;
      });
    refreshInFlight = pending;
  }
  return refreshInFlight;
}
export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}
export type ApiFetchOptions = RequestInit & {
  idempotencyKey?: string;
  timeoutMs?: number;
  /** 失败不弹通知，错误仍抛出；用于后台探测或业务完全接管提示。 */
  silent?: boolean;
};
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { idempotencyKey, timeoutMs = 30000, silent = false, ...init } = options;
  const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
  const generation = authGeneration;
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const send = async (allowRefresh: boolean): Promise<T> => {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type') && typeof init.body === 'string')
      headers.set('content-type', 'application/json');
    const token = getAuthToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        ...init,
        signal,
        headers,
        credentials: 'same-origin',
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const timedOut = signal.aborted;
      const message = timedOut ? '请求超时，请重试同一次操作。' : '无法连接服务，请检查网络。';
      throw new ApiError(0, timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', message);
    }
    if (generation !== authGeneration) throw new DOMException('Identity changed', 'AbortError');
    if (response.status === 204) return undefined as T;
    const parsed = envelopeSchema.safeParse(
      await response.json().catch((error: unknown) => {
        if (init.signal?.aborted) throw error;
        if (signal.aborted) throw new ApiError(0, 'TIMEOUT', '请求超时，请重试同一次操作。');
        return null;
      }),
    );
    const envelope: Envelope | null = parsed.success ? parsed.data : null;
    const status = resolveStatus(response, envelope);
    if (status === 401 && allowRefresh && (await refreshAuth())) {
      if (generation !== authGeneration) throw new DOMException('Identity changed', 'AbortError');
      return send(false);
    }
    if (status !== 200) {
      if (status === 401 && !allowRefresh && generation === authGeneration) expireAuth();
      const code = envelope?.subCode ?? envelope?.code ?? status;
      const reason = envelope?.details?.reason;
      const message =
        reason === 'EXECUTION_OUTCOME_UNKNOWN' || code === 'EXECUTION_OUTCOME_UNKNOWN'
          ? '执行结果需要核实，请查看日志或 Diff。'
          : (messages[status] ?? '服务返回了无法识别的响应，请稍后重试。');
      const field =
        typeof envelope?.details?.field === 'string' ? envelope.details.field : undefined;
      const failure = new ApiError(
        status,
        code,
        message,
        envelope?.requestId,
        field,
        envelope?.details,
        retryAfterSeconds(response.headers.get('retry-after')),
        response.status,
      );
      throw failure;
    }
    if (!envelope || !('data' in envelope)) {
      throw new ApiError(502, 'INVALID_RESPONSE', '服务响应不完整，请稍后重试。');
    }
    return envelope.data as T;
  };
  try {
    return await send(true);
  } catch (error) {
    if (!silent && !init.signal?.aborted && error instanceof ApiError) {
      notifyApiFailure(
        failureKindOf(error),
        error.message,
        error.requestId ? `请求编号：${error.requestId}` : undefined,
      );
      error.notified = true;
    }
    // 提示只是副作用，保留同一个错误对象供调用方判断和特殊处理。
    throw error;
  }
}
export type ErrorType<T> = ApiError & { readonly serverErrorType?: T };
export type BodyType<T> = T;
