export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.requestId) {
    return `${error.message}（请求 ID：${error.requestId}）`;
  }
  return error instanceof Error ? error.message : "发生未知错误";
}
