import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiErrorSchema, BindProjectWorkspaceSchema, CreateProjectSchema, ProjectSchema, UpdateProjectSchema } from "@nova/protocol";
import type { AgentStore } from "../../store.js";
import type { RunnerRegistry } from "../runner/registry.js";
import { invalidInput } from "../../errors.js";
import { createProjectService } from "./project.service.js";

const IdParams = z.object({ id: z.uuid() });
const DeleteHeaders = z.object({ "x-confirm-delete": z.string().min(1) });

export function projectRoutes(app: FastifyInstance, store: AgentStore, runners: RunnerRegistry): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const projects = createProjectService(store, runners);

  server.get("/projects", {
    schema: {
      operationId: "listProjects", tags: ["projects"], security: [{ bearerAuth: [] }],
      response: { 200: z.array(ProjectSchema), 401: ApiErrorSchema },
    },
  }, request => projects.list(request.userId));

  server.post("/projects", {
    schema: {
      operationId: "createProject", tags: ["projects"], security: [{ bearerAuth: [] }], body: CreateProjectSchema,
      response: { 201: ProjectSchema, 400: ApiErrorSchema, 401: ApiErrorSchema },
    },
  }, async (request, reply) => reply.code(201).send(await projects.create(request.userId, request.body.name)));

  server.patch("/projects/:id", {
    schema: {
      operationId: "updateProject", tags: ["projects"], security: [{ bearerAuth: [] }], params: IdParams, body: UpdateProjectSchema,
      response: { 200: ProjectSchema, 400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, request => projects.rename(request.userId, request.params.id, request.body.name));

  server.post("/projects/:id/workspace", {
    schema: {
      operationId: "bindProjectWorkspace", tags: ["projects"], security: [{ bearerAuth: [] }], params: IdParams, body: BindProjectWorkspaceSchema,
      response: { 200: ProjectSchema, 400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, request => projects.bind(request.userId, request.params.id, request.body.runnerId, request.body.path));

  server.delete("/projects/:id", {
    schema: {
      operationId: "deleteProject", tags: ["projects"], security: [{ bearerAuth: [] }], params: IdParams, headers: DeleteHeaders,
      response: { 204: z.null(), 400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    if (request.headers["x-confirm-delete"] !== request.params.id) throw invalidInput("Project deletion must be confirmed with its id");
    await projects.remove(request.userId, request.params.id);
    request.log.info({ projectId: request.params.id, userId: request.userId }, "project deleted");
    return reply.code(204).send(null);
  });
}
