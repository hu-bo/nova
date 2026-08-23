import type { FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { AppError } from "../../errors.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      request.log.warn({ component: "server", code: error.code, statusCode: error.statusCode }, error.message);
      return reply.code(error.statusCode).send({ code: error.code, message: error.message, requestId: request.id });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.warn({ component: "server", code: "INVALID_INPUT", statusCode: 400 }, "request validation failed");
      return reply
        .code(400)
        .send({ code: "INVALID_INPUT", message: "Request validation failed", requestId: request.id });
    }
    request.log.error({ component: "server", err: error, requestId: request.id }, "request failed");
    return reply
      .code(500)
      .send({ code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId: request.id });
  });
}
