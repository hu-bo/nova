import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requirePrincipal } from "../../shared/authorization.js";
import { DomainError } from "../../shared/domain-error.js";
import { errorResponses } from "../../shared/error.schema.js";
import { okEnvelope, success } from "../../shared/response.schema.js";
import type { SpecService } from "./spec.service.js";
import { attemptListSchema, attemptQuerySchema, createSpecSchema, evidenceSchema, exportSchema, generationSchema, listQuerySchema, projectParamsSchema, receiptSchema, reconcileSchema, reviewSchema, revisionQuerySchema, saveDraftSchema, specIdempotencyHeader, specListSchema, specParamsSchema, specSnapshotSchema, specStageSchema, taskAttemptSchema } from "./spec.schema.js";

const requestKey = (headers: Record<string, unknown>) => {
  const value = headers["idempotency-key"];
  if (typeof value !== "string" || value.trim().length < 1 || value.length > 128)
    throw new DomainError("VALIDATION_ERROR", "Idempotency-Key header is required");
  return value.trim();
};

export async function specRoutes(app: FastifyInstance, service: SpecService) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/projects/:projectId/specs", { schema: { operationId: "listSpecs", tags: ["specs"], params: projectParamsSchema, querystring: listQuerySchema, response: { 200: okEnvelope(specListSchema), ...errorResponses(401, 404) } } }, async (request) => success(await service.list(request.params.projectId, requirePrincipal(request).localUserId, request.query.limit, request.query.cursor)));
  typed.post("/projects/:projectId/specs", { schema: { operationId: "createSpec", tags: ["specs"], params: projectParamsSchema, headers: specIdempotencyHeader, body: createSpecSchema, response: { 201: okEnvelope(z.object({ id: z.uuid(), projectId: z.uuid(), conversationId: z.uuid(), title: z.string(), currentRevision: z.number() })), ...errorResponses(400, 401, 404, 409) } } }, async (request, reply) => {
    const spec = await service.create(request.params.projectId, requirePrincipal(request).localUserId, request.body, requestKey(request.headers));
    return reply.code(201).send(success(spec));
  });
  typed.get("/projects/:projectId/specs/:specId", { schema: { operationId: "getSpec", tags: ["specs"], params: specParamsSchema, querystring: revisionQuerySchema, response: { 200: okEnvelope(specSnapshotSchema), ...errorResponses(401, 404) } } }, async (request) => success(await service.get(request.params.projectId, request.params.specId, requirePrincipal(request).localUserId, request.query.revision)));
  typed.patch("/projects/:projectId/specs/:specId/draft", { schema: { operationId: "saveSpecDraft", tags: ["specs"], params: specParamsSchema, body: saveDraftSchema, response: { 200: okEnvelope(specSnapshotSchema), ...errorResponses(400, 401, 404, 409) } } }, async (request) => success(await service.save(request.params.projectId, request.params.specId, requirePrincipal(request).localUserId, request.body.expectedRevision, request.body.stage, request.body.content)));
  typed.post("/projects/:projectId/specs/:specId/reviews/:stage", { schema: { operationId: "reviewSpecStage", tags: ["specs"], params: specParamsSchema.extend({ stage: specStageSchema }), body: reviewSchema, response: { 200: okEnvelope(specSnapshotSchema), ...errorResponses(400, 401, 404, 409) } } }, async (request) => success(await service.review(request.params.projectId, request.params.specId, requirePrincipal(request).localUserId, request.body.expectedRevision, request.params.stage)));
  typed.post("/projects/:projectId/specs/:specId/generations", { schema: { operationId: "generateSpecDraft", tags: ["specs"], params: specParamsSchema, headers: specIdempotencyHeader, body: generationSchema, response: { 202: okEnvelope(receiptSchema), ...errorResponses(400, 401, 404, 409) } } }, async (request, reply) => {
    const receipt = await service.generate(request.params.projectId, request.params.specId, requirePrincipal(request).localUserId, request.body.expectedRevision, request.body.stage, request.body.instruction, request.body.configuration, requestKey(request.headers));
    return reply.code(202).send(success(receipt));
  });
  typed.post("/projects/:projectId/specs/:specId/tasks/:taskKey/attempts", { schema: { operationId: "startSpecTaskAttempt", tags: ["specs"], params: specParamsSchema.extend({ taskKey: z.string().regex(/^T-\d{2,}$/) }), headers: specIdempotencyHeader, body: taskAttemptSchema, response: { 202: okEnvelope(receiptSchema), ...errorResponses(400, 401, 404, 409) } } }, async (request, reply) => {
    const receipt = await service.startAttempt(request.params.projectId, request.params.specId, request.params.taskKey, requirePrincipal(request).localUserId, request.body.expectedRevision, request.body.configuration, requestKey(request.headers));
    return reply.code(202).send(success(receipt));
  });
  typed.get("/projects/:projectId/specs/:specId/attempts", { schema: { operationId: "listSpecAttempts", tags: ["specs"], params: specParamsSchema, querystring: attemptQuerySchema, response: { 200: okEnvelope(attemptListSchema), ...errorResponses(401, 404) } } }, async (request) => success(await service.attempts(request.params.projectId, request.params.specId, requirePrincipal(request).localUserId, request.query.revision, request.query.taskKey, request.query.cursor)));
  typed.post("/projects/:projectId/specs/:specId/attempts/:attemptId/reconcile", { schema: { operationId: "reconcileSpecTaskAttempt", tags: ["specs"], params: specParamsSchema.extend({ attemptId: z.uuid() }), body: reconcileSchema, response: { 200: okEnvelope(z.object({ id: z.uuid(), releasedAt: z.iso.datetime(), resolution: z.unknown().nullable() }).passthrough()), ...errorResponses(401, 404, 409) } } }, async (request) => success(await service.reconcile(request.params.projectId, request.params.specId, request.params.attemptId, requirePrincipal(request).localUserId, request.body.expectedRevision, request.body.note)));
  typed.post("/projects/:projectId/specs/:specId/evidence", { schema: { operationId: "recordSpecEvidence", tags: ["specs"], params: specParamsSchema, body: evidenceSchema, response: { 200: okEnvelope(specSnapshotSchema), ...errorResponses(400, 401, 404, 409) } } }, async (request) => success(await service.recordEvidence(request.params.projectId, request.params.specId, requirePrincipal(request).localUserId, request.body)));
  typed.post("/projects/:projectId/specs/:specId/acceptance", { schema: { operationId: "acceptSpec", tags: ["specs"], params: specParamsSchema, body: reviewSchema, response: { 200: okEnvelope(specSnapshotSchema), ...errorResponses(401, 404, 409) } } }, async (request) => success(await service.accept(request.params.projectId, request.params.specId, requirePrincipal(request).localUserId, request.body.expectedRevision)));
  typed.get("/projects/:projectId/specs/:specId/export", { schema: { operationId: "exportSpec", tags: ["specs"], params: specParamsSchema, querystring: revisionQuerySchema, response: { 200: okEnvelope(exportSchema), ...errorResponses(401, 404) } } }, async (request) => success(await service.export(request.params.projectId, request.params.specId, requirePrincipal(request).localUserId, request.query.revision)));
  typed.delete("/projects/:projectId/specs/:specId", { schema: { operationId: "deleteSpec", tags: ["specs"], params: specParamsSchema, body: reviewSchema, response: { 200: okEnvelope(z.null()), ...errorResponses(401, 404, 409) } } }, async (request) => success(await service.delete(request.params.projectId, request.params.specId, requirePrincipal(request).localUserId, request.body.expectedRevision)));
}
