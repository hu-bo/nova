import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requirePrincipal } from "../../shared/authorization.js";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { okEnvelope, success } from "./runner.schema.js";
import {
  createRunnerTokenBodySchema,
  fileListingQuerySchema,
  fileSummaryBodySchema,
  fileSummaryResponseSchema,
  remoteFileListingSchema,
  rotateRunnerTokenBodySchema,
  runnerIdParamsSchema,
  runnerListSchema,
  runnerTokenListSchema,
  runnerTokenSchema,
  runnerTokenWithSecretSchema,
} from "./runner.schema.js";
import type { RunnerService } from "./runner.service.js";
import type { RunnerTokenService } from "./runner-token.service.js";

function toRunnerTokenDTO(row: {
  id: string;
  label: string | null;
  capabilities: readonly string[];
  status: "active" | "rotated" | "revoked";
  statusChangedAt: Date;
  rotatedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  token?: string | null;
}) {
  return {
    id: row.id,
    token: row.token ?? null,
    label: row.label,
    capabilities: [...row.capabilities],
    status: row.status,
    statusChangedAt: row.statusChangedAt.toISOString(),
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRunnerDTO(row: {
  id: string;
  runnerId: string;
  bootId: string | null;
  workspaceId: string | null;
  capabilities: readonly string[];
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    runnerId: row.runnerId,
    bootId: row.bootId,
    workspaceId: row.workspaceId,
    capabilities: [...row.capabilities],
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function runnerRoutes(
  app: FastifyInstance,
  tokenService: RunnerTokenService,
  runnerService: RunnerService,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    "/runner-connection",
    {
      schema: {
        operationId: "getRunnerConnectionInfo",
        tags: ["runners"],
        response: { 200: okEnvelope(z.object({ endpoint: z.string() })), 401: errorResponseSchema },
      },
    },
    async (request) => {
      requirePrincipal(request);
      return success({
        endpoint: (request.protocol === "https" ? "wss://" : "ws://") + request.headers.host + "/runner/v1/connect",
      });
    },
  );
  typed.get(
    "/runner-tokens",
    {
      schema: {
        operationId: "listRunnerTokens",
        tags: ["runners"],
        response: { 200: okEnvelope(runnerTokenListSchema), 401: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      reply.header("cache-control", "no-store");
      const rows = await tokenService.list(principal.localUserId);
      return success({ items: rows.map(toRunnerTokenDTO) });
    },
  );

  typed.post(
    "/runner-tokens",
    {
      schema: {
        operationId: "createRunnerToken",
        tags: ["runners"],
        body: createRunnerTokenBodySchema,
        response: {
          200: okEnvelope(runnerTokenWithSecretSchema),
          401: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      reply.header("cache-control", "no-store");
      const { row, secret } = await tokenService.create({
        ownerUserId: principal.localUserId,
        ...(request.body.label !== undefined ? { label: request.body.label } : {}),
        capabilities: request.body.capabilities,
        ...(request.body.expiresAt !== undefined ? { expiresAt: request.body.expiresAt } : {}),
      });
      return success({ ...toRunnerTokenDTO(row), token: secret });
    },
  );

  typed.delete(
    "/runner-tokens/:id",
    {
      schema: {
        operationId: "revokeRunnerToken",
        tags: ["runners"],
        params: runnerIdParamsSchema,
        response: {
          200: okEnvelope(runnerTokenSchema.nullable()),
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      await tokenService.revoke({ ownerUserId: principal.localUserId, id: request.params.id });
      return success(null);
    },
  );

  typed.post(
    "/runner-tokens/:id/rotate",
    {
      schema: {
        operationId: "rotateRunnerToken",
        tags: ["runners"],
        params: runnerIdParamsSchema,
        body: rotateRunnerTokenBodySchema,
        response: {
          200: okEnvelope(runnerTokenWithSecretSchema),
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      reply.header("cache-control", "no-store");
      const { row, secret } = await tokenService.rotate({
        ownerUserId: principal.localUserId,
        id: request.params.id,
        revokePrevious: request.body.revokePrevious,
      });
      return success({ ...toRunnerTokenDTO(row), token: secret });
    },
  );

  typed.get(
    "/runners",
    {
      schema: {
        operationId: "listRunners",
        tags: ["runners"],
        response: { 200: okEnvelope(runnerListSchema), 401: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const rows = await runnerService.list(principal.localUserId);
      return success({ items: rows.map(toRunnerDTO) });
    },
  );

  typed.get(
    "/runners/:id/files",
    {
      schema: {
        operationId: "listRunnerFiles",
        tags: ["runners"],
        params: runnerIdParamsSchema,
        querystring: fileListingQuerySchema,
        response: {
          200: okEnvelope(remoteFileListingSchema),
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return success(
        await runnerService.listFiles({
          ownerUserId: principal.localUserId,
          runnerId: request.params.id,
          path: request.query.path,
        }),
      );
    },
  );

  typed.post(
    "/runners/:id/files/summary",
    {
      schema: {
        operationId: "summariseRunnerFiles",
        tags: ["runners"],
        params: runnerIdParamsSchema,
        body: fileSummaryBodySchema,
        response: {
          200: okEnvelope(fileSummaryResponseSchema),
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const summaries = await runnerService.summary({
        ownerUserId: principal.localUserId,
        runnerId: request.params.id,
        paths: request.body.paths,
      });
      return success({ items: summaries });
    },
  );
}
