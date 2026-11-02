export type DomainErrorCode =
  | "SERVICE_UNAVAILABLE"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "EVENT_CURSOR_EXPIRED"
  | "EXECUTION_OUTCOME_UNKNOWN"
  | "INFERENCE_STRENGTH_UNAVAILABLE"
  | "RESERVATION_RELEASED";

/**
 * 字符串业务码 → 响应信封数字 code (语义对齐 HTTP 状态码,新增业务码时在此登记).
 *
 * 所有错误使用真实 HTTP 状态码和统一错误信封，定义见 plugins/errors.ts。
 */
const domainErrorCodes: Record<DomainErrorCode, number> = {
  SERVICE_UNAVAILABLE: 503,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  EVENT_CURSOR_EXPIRED: 410,
  EXECUTION_OUTCOME_UNKNOWN: 409,
  INFERENCE_STRENGTH_UNAVAILABLE: 409,
  RESERVATION_RELEASED: 409,
};

export function domainErrorStatusCode(code: DomainErrorCode): number {
  return domainErrorCodes[code] ?? 400;
}

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DomainError";
  }
}
