import type { ModelEvent } from "./types.js";

// docs/model-adapters.md §5 —— Provider 级重试唯一的家。provider 无关：
// provider 的 attempt 用 ProviderError 抛失败（而不是 yield finish{error}），
// retryStream 统一决定重试还是收尾。硬契约不变：包出来的流绝不 throw，finish 必发且只发一次。

export interface RetryConfig {
  max?: number;     // 重试次数（不含首次尝试），缺省 3
  baseMs?: number;  // 缺省 1000，指数退避 + 全抖动
  maxMs?: number;   // 缺省 30_000
}

export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly code: "context_overflow" | undefined;
  constructor(message: string, retryable: boolean = false, retryAfterMs?: number, code?: "context_overflow") {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

export function providerResponseMessage(response: Response, body: string, prefix = "Provider returned"): string {
  let message = "";
  let code = "";
  let parsedJson = false;
  try {
    const payload = JSON.parse(body) as {
      error?: string | { message?: unknown; code?: unknown; type?: unknown };
      message?: unknown;
      detail?: unknown;
      error_description?: unknown;
      code?: unknown;
      type?: unknown;
    };
    parsedJson = true;
    const error = typeof payload.error === "object" && payload.error !== null ? payload.error : undefined;
    const rawMessage = error?.message ?? payload.message ?? payload.detail ?? payload.error_description
      ?? (typeof payload.error === "string" ? payload.error : undefined);
    message = typeof rawMessage === "string" ? rawMessage : "";
    const rawCode = error?.code ?? error?.type ?? payload.code ?? payload.type;
    code = typeof rawCode === "string" ? rawCode : "";
  } catch {
    // Non-JSON provider bodies are intentionally not copied into logs or UI.
  }
  const detail = message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
  const statusText = safeToken(response.statusText, 80);
  const requestId = providerRequestId(response.headers);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const fallback = body.trim().length === 0
    ? "empty error response"
    : contentType.includes("html") || /^\s*</.test(body)
      ? "HTML error response (likely gateway or WAF rejection)"
      : parsedJson ? "unrecognized JSON error response" : `unrecognized ${contentType || "non-JSON"} error response`;
  return `${prefix} ${response.status}${statusText ? ` ${statusText}` : ""}${code ? ` (${safeToken(code, 120)})` : ""}: ${detail || fallback}${requestId ? ` [upstream request ID: ${requestId}]` : ""}`;
}

function providerRequestId(headers: Headers): string {
  for (const name of ["x-request-id", "request-id", "x-correlation-id", "cf-ray", "x-amzn-requestid", "x-goog-request-id"]) {
    const value = safeToken(headers.get(name) ?? "", 160);
    if (value) return value;
  }
  return "";
}

function safeToken(value: string, limit: number): string {
  return value.replace(/[^\w.:/-]+/g, " ").trim().slice(0, limit);
}

export function retryStream(
  attempt: () => AsyncIterable<ModelEvent>,
  signal: AbortSignal,
  config: RetryConfig = {},
): AsyncIterable<ModelEvent> {
  const max = config.max ?? 3;
  const baseMs = config.baseMs ?? 1000;
  const maxMs = config.maxMs ?? 30_000;

  async function* run(): AsyncIterable<ModelEvent> {
    let failure = "provider stream ended without a finish event";
    for (let retries = 0; ; retries += 1) {
      if (signal.aborted) { yield { type: "finish", stopReason: "aborted" }; return; }
      let produced = false;
      try {
        for await (const event of attempt()) {
          produced = true;
          yield event;
          if (event.type === "finish") return;
        }
        // provider 违约：流结束但没有 finish。按可重试失败处理。
        failure = "provider stream ended without a finish event";
        if (produced || retries >= max) { yield { type: "finish", stopReason: "error", errorMessage: failure }; return; }
      } catch (error) {
        if (signal.aborted) { yield { type: "finish", stopReason: "aborted" }; return; }
        failure = error instanceof Error ? error.message : String(error);
        // 已产出内容后不重试：两段拼不起来（§5）。只有标记 retryable 的 ProviderError 才重试。
        const retryable = error instanceof ProviderError && error.retryable;
        if (produced || retries >= max || !retryable) {
          yield {
            type: "finish",
            stopReason: "error",
            errorMessage: failure,
            ...(error instanceof ProviderError && error.code ? { errorCode: error.code } : {}),
          };
          return;
        }
        if (error instanceof ProviderError && error.retryAfterMs !== undefined) {
          // 429 带 Retry-After：按响应头等，不叠加退避
          if (!await sleep(Math.min(error.retryAfterMs, maxMs), signal)) { yield { type: "finish", stopReason: "aborted" }; return; }
          continue;
        }
      }
      // 指数退避 + 全抖动：random() * min(maxMs, baseMs * 2^retries)
      if (!await sleep(Math.random() * Math.min(maxMs, baseMs * 2 ** retries), signal)) { yield { type: "finish", stopReason: "aborted" }; return; }
    }
  }
  return run();
}

// 等到时返回 true；signal 先 abort 返回 false
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted || ms <= 0) { resolve(!signal.aborted); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(true); }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
