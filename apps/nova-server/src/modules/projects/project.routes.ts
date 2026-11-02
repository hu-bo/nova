import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requirePrincipal } from "../../shared/authorization.js";
import { errorResponses } from "../../shared/error.schema.js";
import {
  createProjectBodySchema,
  okEnvelope,
  paginationQuerySchema,
  projectListSchema,
  projectParamsSchema,
  projectSchema,
  success,
  updateProjectBodySchema,
} from "./project.schema.js";
import type { ProjectService } from "./project.service.js";
import type { ProjectBindingService } from "./project-binding.service.js";
import { bindingSchema, bindProjectBodySchema } from "./project-binding.schema.js";

const responseProject = (project: {
  id: string;
  ownerUserId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) => ({
  id: project.id,
  ownerUserId: project.ownerUserId,
  name: project.name,
  createdAt: project.createdAt.toISOString(),
  updatedAt: project.updatedAt.toISOString(),
  deletedAt: project.deletedAt?.toISOString() ?? null,
});

/**
 * /api/projects 路由: owner-scoped。
 * - 列表/查询/创建/更新/软删除全部以当前 principal.localUserId 作为 owner predicate;
 *   客户端传入的 owner 字段不被采纳, 由统一错误处理 (DomainError UNAUTHORIZED) 拦截
 *   匿名访问。
 * - 当前未实现 expectedRevision; 在此之前 update 必须给 name(见 project.service.ts);
 *   后续接入 v2 时把 partial 行为迁移到 expectedRevision 协议。
 */
export async function projectRoutes(
  app: FastifyInstance,
  service: ProjectService,
  bindings: ProjectBindingService,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    "/:id/binding",
    {
      schema: {
        operationId: "getProjectBinding",
        tags: ["projects"],
        params: projectParamsSchema,
        response: { 200: okEnvelope(bindingSchema.nullable()), ...errorResponses(404) },
      },
    },
    async (request) => success(await bindings.get(request.params.id, requirePrincipal(request).localUserId)),
  );
  typed.put(
    "/:id/binding",
    {
      schema: {
        operationId: "bindProjectEnvironment",
        tags: ["projects"],
        params: projectParamsSchema,
        body: bindProjectBodySchema,
        response: {
          200: okEnvelope(bindingSchema),
          ...errorResponses(400, 409, 404),
        },
      },
    },
    async (request) =>
      success(await bindings.bind(request.params.id, requirePrincipal(request).localUserId, request.body)),
  );
  typed.get(
    "/",
    {
      schema: {
        operationId: "listProjects",
        tags: ["projects"],
        querystring: paginationQuerySchema,
        response: { 200: okEnvelope(projectListSchema), ...errorResponses(401, 500) },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return success({
        items: (await service.list({ ownerUserId: principal.localUserId, limit: request.query.limit })).map(
          responseProject,
        ),
      });
    },
  );
  typed.post(
    "/",
    {
      schema: {
        operationId: "createProject",
        tags: ["projects"],
        body: createProjectBodySchema,
        response: { 200: okEnvelope(projectSchema), ...errorResponses(401, 500) },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return success(responseProject(await service.create(request.body, principal.localUserId)));
    },
  );
  typed.get(
    "/:id",
    {
      schema: {
        operationId: "getProject",
        tags: ["projects"],
        params: projectParamsSchema,
        response: {
          200: okEnvelope(projectSchema),
          ...errorResponses(401, 404, 500),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return success(responseProject(await service.get(request.params.id, principal.localUserId)));
    },
  );
  typed.patch(
    "/:id",
    {
      schema: {
        operationId: "updateProject",
        tags: ["projects"],
        params: projectParamsSchema,
        body: updateProjectBodySchema,
        response: {
          200: okEnvelope(projectSchema),
          ...errorResponses(400, 401, 404, 500),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return success(responseProject(await service.update(request.params.id, request.body, principal.localUserId)));
    },
  );
  typed.delete(
    "/:id",
    {
      schema: {
        operationId: "deleteProject",
        tags: ["projects"],
        params: projectParamsSchema,
        response: {
          200: okEnvelope(z.null()),
          ...errorResponses(401, 404, 500),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      await service.delete(request.params.id, principal.localUserId);
      return success(null);
    },
  );
}
