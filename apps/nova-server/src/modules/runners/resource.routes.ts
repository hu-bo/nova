import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { skillCatalogDiagnosticSchema, skillCatalogStatusSchema } from "@nova/agent-ui-contracts";
import { requirePrincipal } from "../../shared/authorization.js";
import { errorResponses } from "../../shared/error.schema.js";
import { okEnvelope, success } from "../../shared/response.schema.js";
import { runnerIdParamsSchema } from "./runner.schema.js";
import type { RunnerLocalResources } from "./local-resources.js";

/**
 * POST /runners/:id/resources/refresh（§8.2、P0-E1）：校验归属及 workspace/cwd 后定向刷新，
 * 返回目录版本与诊断。归属与在线判定由 RunnerLocalResources 在已认证 session 下完成。
 */

export const resourceRefreshBodySchema = z
  .object({
    scope: z.enum(["global", "project"]),
    workspaceId: z.string().min(1).max(256).optional(),
    relativeDir: z.string().max(1024).optional(),
  })
  .strict()
  .refine((body) => body.scope !== "project" || Boolean(body.workspaceId), "Project refresh requires workspaceId");

export const resourceCatalogViewSchema = z
  .object({
    status: skillCatalogStatusSchema,
    revision: z.number().int().nonnegative(),
    complete: z.boolean(),
    online: z.boolean(),
    writable: z.boolean(),
    diagnostics: z.array(skillCatalogDiagnosticSchema),
  })
  .strict();

export async function resourceRoutes(app: FastifyInstance, localResources: RunnerLocalResources) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post("/runners/:id/resources/refresh", {
    schema: {
      operationId: "refreshRunnerResources",
      tags: ["runners"],
      params: runnerIdParamsSchema,
      body: resourceRefreshBodySchema,
      response: { 200: okEnvelope(resourceCatalogViewSchema), ...errorResponses(400, 401, 404, 409) },
    },
  }, async (request) => {
    const principal = requirePrincipal(request);
    const view = await localResources.refresh({
      ownerUserId: principal.localUserId,
      runnerRowId: request.params.id,
      scope: request.body.scope,
      ...(request.body.workspaceId ? { workspaceId: request.body.workspaceId } : {}),
      ...(request.body.relativeDir ? { relativeDir: request.body.relativeDir } : {}),
    });
    return success({
      status: view.status,
      revision: view.revision,
      complete: view.complete,
      online: view.online,
      writable: view.writable,
      diagnostics: [...view.diagnostics],
    });
  });
}
