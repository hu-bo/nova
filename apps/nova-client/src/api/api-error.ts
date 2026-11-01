export class ApiError extends Error {
  /** 已由请求层通过 Toast 提示，业务仍可读取全部错误信息。 */
  notified = false;
  constructor(
    public readonly status: number,
    public readonly code: number | string,
    message: string,
    public readonly requestId?: string,
    public readonly field?: string,
    public readonly details?: Record<string, unknown>,
    public readonly retryAfterSeconds?: number,
    public readonly httpStatus = status,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return '操作暂时未能完成，请稍后重试。';
}
