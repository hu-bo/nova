import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  agentCatalogEntrySchema,
  skillVersionDetailSchema,
  type SkillCatalogEntry,
} from "@nova/agent-ui-contracts";
import type { LocalCatalogView } from "./skill-directory.js";
import { requirePrincipal } from "../../shared/authorization.js";
import { errorResponses } from "../../shared/error.schema.js";
import { okEnvelope, success } from "../../shared/response.schema.js";
import {
  agentListQuerySchema,
  agentListResponseSchema,
  createSkillBodySchema,
  publishSkillVersionBodySchema,
  skillDetailSchema,
  skillIdParamsSchema,
  skillListQuerySchema,
  skillListResponseSchema,
  skillVersionListQuerySchema,
  skillVersionListSchema,
  skillVersionParamsSchema,
  updateSkillDraftBodySchema,
  versionSummarySchema,
  type SkillCatalogMeta,
} from "./skill.schema.js";
import type { SkillService } from "./skill.service.js";
import { listSkillCatalog, type CatalogSource } from "./skill-catalog.js";
import { resolveSkillEnvironment, type EnvironmentDeps } from "./skill-environment.js";

/** 平台管理与合并目录路由（§8.2；沿用成功/错误信封，不可见资源 404）。 */
export async function skillRoutes(
  app: FastifyInstance,
  deps: { service: SkillService; catalog: CatalogSource; environment: EnvironmentDeps },
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { service, catalog, environment } = deps;

  typed.get("/skills", {
    schema: {
      operationId: "listSkills",
      tags: ["skills"],
      querystring: skillListQuerySchema,
      response: { 200: okEnvelope(skillListResponseSchema), ...errorResponses(400, 401, 404) },
    },
  }, async (request) => {
    const principal = requirePrincipal(request);
    const query = request.query;
    const resolved = await resolveSkillEnvironment(environment, principal.localUserId, query);
    return success(await listSkillCatalog(catalog, resolved, {
      ...(query.source ? { source: query.source } : {}),
      ...(query.q ? { q: query.q } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    }));
  });

  typed.post("/skills", {
    schema: {
      operationId: "createSkill",
      tags: ["skills"],
      body: createSkillBodySchema,
      response: { 201: okEnvelope(skillDetailSchema), ...errorResponses(400, 401, 404) },
    },
  }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const view = await service.createPlatform(principal.localUserId, request.body);
    return reply.code(201).send(success(view));
  });

  typed.get("/skills/:skillId", {
    schema: {
      operationId: "getSkill",
      tags: ["skills"],
      params: skillIdParamsSchema,
      response: { 200: okEnvelope(skillDetailSchema), ...errorResponses(401, 404) },
    },
  }, async (request) => {
    const principal = requirePrincipal(request);
    return success(await service.getPlatform(principal.localUserId, request.params.skillId));
  });

  typed.patch("/skills/:skillId/draft", {
    schema: {
      operationId: "updateSkillDraft",
      tags: ["skills"],
      params: skillIdParamsSchema,
      body: updateSkillDraftBodySchema,
      response: { 200: okEnvelope(skillDetailSchema), ...errorResponses(400, 401, 404, 409) },
    },
  }, async (request) => {
    const principal = requirePrincipal(request);
    const { expectedRevision, body, requirements } = request.body;
    return success(
      await service.updateDraft(principal.localUserId, request.params.skillId, {
        expectedRevision,
        body,
        ...(requirements ? { requirements } : {}),
      }),
    );
  });

  typed.post("/skills/:skillId/versions", {
    schema: {
      operationId: "publishSkillVersion",
      tags: ["skills"],
      params: skillIdParamsSchema,
      body: publishSkillVersionBodySchema,
      response: { 200: okEnvelope(versionSummarySchema), ...errorResponses(400, 401, 404, 409) },
    },
  }, async (request) => {
    const principal = requirePrincipal(request);
    // 相同版本同内容幂等返回原版本；内容不同 409（§8.2）。
    return success(await service.publish(principal.localUserId, request.params.skillId, request.body));
  });

  typed.get("/skills/:skillId/versions/:version", {
    schema: {
      operationId: "getSkillVersion",
      tags: ["skills"],
      params: skillVersionParamsSchema,
      response: { 200: okEnvelope(skillVersionDetailSchema), ...errorResponses(401, 404) },
    },
  }, async (request) => {
    const principal = requirePrincipal(request);
    return success(await service.getVersionDetail(principal.localUserId, request.params.skillId, request.params.version));
  });

  typed.get("/skills/:skillId/versions", {
    schema: {
      operationId: "listSkillVersions",
      tags: ["skills"],
      params: skillIdParamsSchema,
      querystring: skillVersionListQuerySchema,
      response: { 200: okEnvelope(skillVersionListSchema), ...errorResponses(401, 404) },
    },
  }, async (request) => {
    const principal = requirePrincipal(request);
    return success(
      await service.listVersions(principal.localUserId, request.params.skillId, {
        limit: request.query.limit,
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      }),
    );
  });

  typed.post("/skills/:skillId/disable", {
    schema: {
      operationId: "disableSkill",
      tags: ["skills"],
      params: skillIdParamsSchema,
      response: { 200: okEnvelope(skillDetailSchema), ...errorResponses(401, 404, 409) },
    },
  }, async (request) => {
    const principal = requirePrincipal(request);
    return success(await service.disable(principal.localUserId, request.params.skillId));
  });

  // GET /agents（§8.2）：当前 Runner/项目可见的主 Agent 配置与兼容性；只列本地来源。
  typed.get("/agents", {
    schema: {
      operationId: "listAgents",
      tags: ["skills"],
      querystring: agentListQuerySchema,
      response: { 200: okEnvelope(agentListResponseSchema), ...errorResponses(400, 401, 404) },
    },
  }, async (request) => {
    const principal = requirePrincipal(request);
    const resolved = await resolveSkillEnvironment(environment, principal.localUserId, {
      limit: 100,
      ...(request.query.conversationId ? { conversationId: request.query.conversationId } : {}),
      ...(request.query.projectId ? { projectId: request.query.projectId } : {}),
    });
    return success({
      items: service.listAgents({
        ownerUserId: principal.localUserId,
        runnerRowId: resolved.runnerRowId,
        workspaceId: resolved.workspaceId,
        relativeCwd: resolved.relativeCwd,
      }),
      catalog: agentCatalogMeta(resolved.runnerRowId, resolved.runnerRowId ? catalog.directory.view(resolved.runnerRowId, principal.localUserId) : undefined),
    });
  });
}

function agentCatalogMeta(runnerRowId: string | null, view: LocalCatalogView | undefined): SkillCatalogMeta | null {
  if (!runnerRowId) return null;
  if (!view) return { runnerId: runnerRowId, status: "offline", revision: 0, complete: false, diagnostics: [] };
  return {
    runnerId: runnerRowId,
    status: view.status,
    revision: view.revision,
    complete: view.complete,
    diagnostics: [...view.diagnostics],
  };
}
