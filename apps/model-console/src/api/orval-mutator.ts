import { expireSession, getSessionToken, refreshSession } from "../auth/session.js";
import { ApiClientError } from "./errors.js";
import { notifyApiFailure, type ApiFailureKind } from "./api-notify.js";

export type BodyType<BodyData> = BodyData;
export type ErrorType<ErrorData> = ApiClientError & { data?: ErrorData };

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, unknown>;
  body?: BodyInit | null;
  headers?: HeadersInit;
  signal?: AbortSignal;
  responseType?: string;
  /** 后台探测或业务完全接管提示时使用；错误仍会抛出。 */
  silent?: boolean;
}

/** 通知的语义分类：网络、响应解析、服务端与请求错误分别对应不同提示样式。 */
function failureKindOf(error: ApiClientError): ApiFailureKind {
  if (error.status === 0) return "network";
  if (error.code === "INVALID_RESPONSE") return "response";
  return error.status >= 500 ? "server" : "request";
}

/** HTTP 成功但信封携带业务错误码时，以信封码为准；无法归类视为网关错误。 */
function resolveStatus(response: Response, payload: { code?: number } | null): number {
  if (!response.ok) return response.status;
  if (typeof payload?.code !== "number" || payload.code === 200) return 200;
  return payload.code >= 400 && payload.code <= 599 ? payload.code : 502;
}

export async function apiMutator<T>(url: string, options: RequestOptions): Promise<T> {
  try {
    return await sendRequest<T>(url, options);
  } catch (error) {
    if (!options.silent && !options.signal?.aborted && error instanceof ApiClientError) {
      notifyApiFailure(failureKindOf(error), error.message);
      error.notified = true;
    }
    throw error;
  }
}

async function sendRequest<T>(url: string, options: RequestOptions, allowRefresh = true): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const headers = new Headers(options.headers);
  const token = getSessionToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");

  let response: Response;
  try {
    response = await fetch(`${url}${query.size ? `?${query}` : ""}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiClientError(0, "NETWORK_ERROR", "无法连接服务，请检查网络。");
  }

  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch((error: unknown) => {
    if (options.signal?.aborted) throw error;
    return null;
  });
  const payload =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as {
          code?: number;
          subCode?: number | string;
          details?: { reason?: string; fieldErrors?: Record<string, string> };
          message?: string;
          fieldErrors?: Record<string, string>;
          data?: T;
        })
      : null;
  const status = resolveStatus(response, payload);
  if (status === 401) {
    if (allowRefresh && (await refreshSession())) return sendRequest<T>(url, options, false);
    expireSession();
  }
  if (status !== 200) {
    const fallback = status === 403 ? "当前账号没有管理员权限" : `请求失败（${status}）`;
    throw new ApiClientError(
      status,
      String(payload?.details?.reason ?? payload?.subCode ?? payload?.code ?? "REQUEST_FAILED"),
      typeof payload?.message === "string" ? payload.message : fallback,
      payload?.details?.fieldErrors ?? payload?.fieldErrors,
    );
  }
  if (payload?.code !== 200 || !("data" in payload)) {
    throw new ApiClientError(502, "INVALID_RESPONSE", "服务响应不完整");
  }
  return payload.data as T;
}
