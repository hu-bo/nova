export class ApiClientError extends Error {
  /** 已由请求层通过 Toast 提示，业务仍可读取全部错误信息。 */
  notified = false;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "发生未知错误";
}
