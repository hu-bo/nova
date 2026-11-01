import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

export async function registerOpenApi(app: FastifyInstance, enableUi: boolean): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Projects API",
        version: "0.1.0",
        description:
          "统一 /api 接口。成功返回 { code: 200, message, data }；错误返回真实 HTTP 4xx/5xx 与 { code, subCode, message, requestId, details? }。",
      },
      servers: [],
    },
    transform: jsonSchemaTransform,
  });
  if (enableUi) {
    await app.register(swaggerUi, { routePrefix: "/documentation" });
  }
}
