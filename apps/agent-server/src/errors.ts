export type AppErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_INPUT"
  | "RUNNER_UNAVAILABLE"
  | "RUNTIME_UNAVAILABLE"
  | "AUTH_SERVICE_UNAVAILABLE"
  | "AUTH_SERVICE_ERROR";

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export const unauthorized = () => new AppError("UNAUTHORIZED", "Authentication is required", 401);
export const forbidden = () => new AppError("FORBIDDEN", "Administrator access is required", 403);
export const notFound = (resource: string) => new AppError("NOT_FOUND", `${resource} was not found`, 404);
export const conflict = (message: string) => new AppError("CONFLICT", message, 409);
export const invalidInput = (message: string) => new AppError("INVALID_INPUT", message, 400);
export const runnerUnavailable = (message = "The selected runner is unavailable") =>
  new AppError("RUNNER_UNAVAILABLE", message, 409);
export const runtimeUnavailable = (message = "The conversation runtime is unavailable") =>
  new AppError("RUNTIME_UNAVAILABLE", message, 503);
export const authServiceUnavailable = () =>
  new AppError("AUTH_SERVICE_UNAVAILABLE", "Authentication service is unavailable", 503);
export const authServiceError = () =>
  new AppError("AUTH_SERVICE_ERROR", "Authentication service returned an invalid response", 502);
