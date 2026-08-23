import { ApiClientError } from "./errors.js";

export type BodyType<BodyData> = BodyData;
export type ErrorType<ErrorData> = ApiClientError & { data?: ErrorData };

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, unknown>;
  body?: BodyInit | null;
  headers?: HeadersInit;
  signal?: AbortSignal;
  responseType?: string;
}

export async function apiMutator<T>(url: string, options: RequestOptions): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  const headers = new Headers(options.headers);
  const token = localStorage.getItem(tokenStorageKey());
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
    throw new ApiClientError(0, "NETWORK_ERROR", error instanceof Error ? error.message : "无法连接服务器");
  }
  if (response.status === 401) {
    window.dispatchEvent(new Event("nova:unauthorized"));
    throw new ApiClientError(401, "UNAUTHORIZED", "登录状态已失效，请重新登录", response.headers.get("x-request-id") ?? undefined);
  }
  if (!response.ok) {
    const fallback = `请求失败（${response.status}）`;
    const requestId = response.headers.get("x-request-id") ?? undefined;
    try {
      const payload = await response.json() as { code?: string; message?: string };
      throw new ApiClientError(response.status, payload.code ?? "REQUEST_FAILED", payload.message ?? fallback, requestId);
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError(response.status, "REQUEST_FAILED", fallback, requestId);
    }
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function tokenStorageKey() {
  const appName = import.meta.env.VITE_CASDOOR_APP_NAME || "nova";
  return `nova_${appName}_access_token`;
}
