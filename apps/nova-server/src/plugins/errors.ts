import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { DomainError, domainErrorStatusCode } from "../shared/domain-error.js";

/**
 * fastify-type-provider-zod 的 serializerCompiler 在响应数据不匹配 schema 时抛出
 * ResponseSerializationError: code=FST_ERR_RESPONSE_SERIALIZATION, 携带 method/url
 * 与 cause(zod 错误, issues 数组含 path/code/format/message)。默认只记 type+code
 * 会丢掉全部定位信息, 因此这里统一提取。
 */
function describeZodIssue(issue: unknown): Record<string, unknown> {
  if (typeof issue !== "object" || issue === null) return { message: String(issue) };
  const { path, code, format, origin, message } = issue as Record<string, unknown>;
  const described: Record<string, unknown> = {};
  if (Array.isArray(path)) described.path = path.join(".");
  if (typeof code === "string") described.code = code;
  if (typeof format === "string") described.format = format;
  if (typeof origin === "string") described.origin = origin;
  if (typeof message === "string") described.message = message;
  return described;
}

/**
 * 展平错误的可安全记录部分: type/code/statusCode/message/stack, 以及 cause 链
 * (含 zod issues)。刻意不打印 issue.input / validation.params —— 它们可能携带
 * 请求体原文(凭证等); 堆栈保留原始行号, 便于定位序列化失败的字段来源。
 */
function describeError(error: unknown, depth = 0): Record<string, unknown> {
  const described: Record<string, unknown> = {
    type: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof error !== "object" || error === null) return described;
  const fields = error as Record<string, unknown>;
  // Only retain diagnostic fields: ssh2/socket errors may also carry credentials or other payloads.
  for (const key of ["code", "statusCode", "level", "errno", "syscall", "address", "port", "hostname"]) {
    const value = fields[key];
    if (typeof value === "string" || typeof value === "number") described[key] = value;
  }
  // ResponseSerializationError 特有字段: 出错路由与 schema 归属
  if (typeof fields.method === "string") described.method = fields.method;
  if (typeof fields.url === "string") described.schemaUrl = fields.url;
  if (error instanceof Error && error.stack !== undefined) described.stack = error.stack;
  if (Array.isArray(fields.issues)) described.issues = fields.issues.map(describeZodIssue);
  if (fields.cause !== undefined && depth < 5) described.cause = describeError(fields.cause, depth + 1);
  return described;
}

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  message: string,
  details?: Record<string, unknown>,
) {
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .serializer(JSON.stringify)
    .send({ code: status, subCode: status, message, requestId: request.id, ...(details ? { details } : {}) });
}
export function registerErrorHandlers(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) => sendError(reply, request, 404, "Route not found"));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      const statusCode = domainErrorStatusCode(error.code);
      const diagnostic = {
        url: request.url,
        method: request.method,
        ...describeError(error),
        statusCode,
        reason: typeof error.details?.reason === "string" ? error.details.reason : error.code,
      };
      if (statusCode >= 500) request.log.error(diagnostic, "Request failed");
      else request.log.warn(diagnostic, "Request rejected");
      return sendError(reply, request, statusCode, error.message, {
        reason: error.code,
        ...error.details,
      });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      // 入参校验失败默认是静默 400; 这里留一条 warn 方便排查前端提交的形状。
      request.log.warn(
        {
          url: request.url,
          issues: error.validation.map((entry) => ({
            path: entry.instancePath,
            code: entry.keyword,
            message: entry.message,
          })),
        },
        "Request validation failed",
      );
      return sendError(reply, request, 400, "Request validation failed");
    }
    const status = (error as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      request.log.debug({ url: request.url, ...describeError(error) }, "Request rejected");
      return sendError(reply, request, status, "Request could not be processed");
    }
    request.log.error({ url: request.url, ...describeError(error) }, "Request failed");
    return sendError(reply, request, 500, "Internal server error");
  });
}
