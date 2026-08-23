import swagger from "@fastify/swagger";
import type { FastifyInstance } from "fastify";
import { BlockSchema } from "@nova/protocol";
import { z } from "zod";
import { jsonSchemaTransform, jsonSchemaTransformObject } from "fastify-type-provider-zod";

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  if (!z.globalRegistry.get(BlockSchema)) z.globalRegistry.add(BlockSchema, { id: "Block" });
  await app.register(swagger, {
    openapi: {
      info: { title: "Nova Agent Server", version: "0.1.0" },
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
}
