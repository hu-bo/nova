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

/** 表单提交失败时的反馈还原：字段级错误 + 顶部兜底提示（message 为 null 表示请求层已提示）。 */
export function formFeedbackFrom(error: unknown): { fieldErrors: Record<string, string>; message: string | null } {
  if (error instanceof ApiClientError) {
    return { fieldErrors: error.fieldErrors, message: error.notified ? null : errorMessage(error) };
  }
  return { fieldErrors: {}, message: errorMessage(error) };
}
