import type { JsonValue } from "./message.js";

export interface SafeError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}
export class FrameworkError extends Error implements SafeError {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
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
/** Untrusted provider/handler messages never become public diagnostics. */
export function safeError(error: unknown, code = "EXECUTION_FAILED"): SafeError {
  return error instanceof FrameworkError
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : { code, message: "The operation failed." };
}

/** Authorization suspension preserves the pending tool batch for resumption. */
export class ToolSuspended extends Error {
  constructor(readonly continuationId: string) {
    super("Tool authorization requires input.");
  }
}
