import {
  ApiErrorSchema,
  RunnerConnectionInfoSchema,
  RunnerDirectoryQuerySchema,
  RunnerDirectorySchema,
  RunnerEventSchema,
  RunnerQuerySchema,
  RunnerSchema,
  RunnerTokenSchema,
  pageSchema,
} from "@nova/protocol";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AgentStore } from "../../store.js";
import type { RunnerRegistry } from "./registry.js";
import { createRunnerService } from "./runner.service.js";

const TokenParams = z.object({ id: z.uuid() });
const RunnerParams = z.object({ id: z.string().trim().min(1).max(256) });

export function runnerRoutes(
  app: FastifyInstance,
  store: AgentStore,
  registry: RunnerRegistry,
  endpoint: string,
): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const runners = createRunnerService(store, registry);

  server.get(
    "/runner-connection",
    {
      schema: {
        operationId: "getRunnerConnectionInfo",
        tags: ["runners"],
        security: [{ bearerAuth: [] }],
        response: { 200: RunnerConnectionInfoSchema, 401: ApiErrorSchema },
      },
    },
    () => ({ endpoint }),
  );

  server.get(
    "/runner-tokens",
    {
      schema: {
        operationId: "listRunnerTokens",
        tags: ["runners"],
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(RunnerTokenSchema), 401: ApiErrorSchema },
      },
    },
    (request) => runners.listTokens(request.userId),
  );

  server.post(
    "/runner-tokens",
    {
      schema: {
        operationId: "createRunnerToken",
        tags: ["runners"],
        security: [{ bearerAuth: [] }],
        response: { 201: RunnerTokenSchema, 401: ApiErrorSchema, 409: ApiErrorSchema },
      },
    },
    async (request, reply) => reply.code(201).send(await runners.createToken(request.userId)),
  );

  server.delete(
    "/runner-tokens/:id",
    {
      schema: {
        operationId: "deleteRunnerToken",
        tags: ["runners"],
        security: [{ bearerAuth: [] }],
        params: TokenParams,
        response: { 204: z.null(), 401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      await runners.deleteToken(request.userId, request.params.id);
      return reply.code(204).send(null);
    },
  );

  server.get(
    "/runners",
    {
      schema: {
        operationId: "listRunners",
        tags: ["runners"],
        security: [{ bearerAuth: [] }],
        querystring: RunnerQuerySchema,
        response: { 200: pageSchema(RunnerSchema), 400: ApiErrorSchema, 401: ApiErrorSchema },
      },
    },
    (request) => runners.list(request.userId, request.query),
  );

  server.get(
    "/runners/directories",
    {
      schema: {
        operationId: "listRunnerDirectories",
        tags: ["runners"],
        security: [{ bearerAuth: [] }],
        querystring: RunnerDirectoryQuerySchema,
        response: { 200: RunnerDirectorySchema, 400: ApiErrorSchema, 401: ApiErrorSchema, 409: ApiErrorSchema },
      },
    },
    (request) => runners.listDirectories(request.userId, request.query.runnerId, request.query.path),
  );

  server.delete(
    "/runners/:id",
    {
      schema: {
        operationId: "deleteRunner",
        tags: ["runners"],
        security: [{ bearerAuth: [] }],
        params: RunnerParams,
        response: { 204: z.null(), 401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      await runners.remove(request.userId, request.params.id);
      return reply.code(204).send(null);
    },
  );

  server.get(
    "/runners/events",
    {
      schema: {
        operationId: "subscribeRunnerEvents",
        tags: ["runners"],
        security: [{ bearerAuth: [] }],
        response: { 401: ApiErrorSchema },
      },
    },
    (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const unsubscribe = registry.subscribe(request.userId, (event) => {
        const parsed = RunnerEventSchema.parse(event);
        reply.raw.write(`data: ${JSON.stringify(parsed)}\n\n`);
      });
      reply.raw.write(":connected\n\n");
      const heartbeat = setInterval(() => reply.raw.write(":ka\n\n"), 15_000);
      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.raw.once("close", close);
      reply.raw.once("close", close);
    },
  );
}
