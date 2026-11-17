import type { JsonValue } from "./message.js";

export interface SafeError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  /** Verbatim provider error text for user-facing display; absent when the provider gave none. */
  readonly detail?: string;
}
export class FrameworkError extends Error implements SafeError {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "FrameworkError";
  }
}
/** Structured failure returned by an effectful tool without losing its remote outcome. */
export class ToolFailureError extends FrameworkError {
  constructor(
    code: string,
    message: string,
    readonly outcome: "known" | "unknown",
    readonly details?: JsonValue,
  ) {
    super(code, message, outcome === "unknown");
    this.name = "ToolFailureError";
  }
}
/** Provider text is only ever carried in `detail`; `message` keeps safe, stable wording. */
export function safeError(error: unknown, code = "EXECUTION_FAILED"): SafeError {
  return error instanceof FrameworkError
    ? {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      }
    : { code, message: "The operation failed." };
}

/** Kernel setup and agent execution use the same cancellation precedence. */
export function runFailureStatus(signal: AbortSignal): "failed" | "cancelled" | "timed_out" {
  if (!signal.aborted) return "failed";
  if (signal.reason instanceof FrameworkError && signal.reason.code === "TIMED_OUT") return "timed_out";
  return "cancelled";
}

/** Authorization suspension preserves the pending tool batch for resumption. */
export class ToolSuspended extends Error {
  constructor(readonly continuationId: string) {
    super("Tool authorization requires input.");
  }
}
