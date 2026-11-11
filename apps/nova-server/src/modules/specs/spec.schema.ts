import { z } from "zod";
import type { SpecTask } from "../../../database/schema/spec-revision.table.js";

const text = (max: number) => z.string().max(max);
export const taskCheckSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/),
  criterionIds: z.array(z.string().regex(/^AC-\d{2,}$/)).max(50),
  label: z.string().trim().min(1).max(200),
  method: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("manual") }).strict(),
    z.object({ kind: z.literal("command"), command: z.string().trim().min(1).max(256), args: z.array(z.string().max(1024)).max(64), cwd: z.string().max(1024).optional() }).strict(),
  ]),
}).strict();
export const taskSchema = z.object({
  key: z.string().regex(/^T-\d{2,}$/),
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(4000),
  dependsOn: z.array(z.string().regex(/^T-\d{2,}$/)).max(50),
  checks: z.array(taskCheckSchema).min(1).max(10),
}).strict();
export const taskPlanSchema = z.array(taskSchema).max(50);
export const specStageSchema = z.enum(["requirements", "design", "tasks"]);
export const specParamsSchema = z.object({ projectId: z.uuid(), specId: z.uuid() }).strict();
export const projectParamsSchema = z.object({ projectId: z.uuid() }).strict();
export const revisionQuerySchema = z.object({ revision: z.coerce.number().int().positive().optional() }).strict();
export const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(256).optional() }).strict();
const specModelConfigurationSchema = z.object({ backendId: z.string().min(1), modelId: z.uuid().nullable(), reasoningEffort: z.enum(["off", "low", "medium", "high", "max"]).optional() }).strict();
export const createSpecSchema = z.object({
  title: z.string().trim().min(1).max(200), brief: text(131072),
  startGeneration: z.boolean().optional(), configuration: specModelConfigurationSchema.optional(),
}).strict().refine((input) => !input.startGeneration || input.brief.trim().length > 0, "Initial Spec query must not be empty");
export type CreateSpecInput = z.infer<typeof createSpecSchema>;
export const saveDraftSchema = z.object({ expectedRevision: z.number().int().positive(), stage: specStageSchema, content: z.union([text(131072), taskPlanSchema]) }).strict();
export const reviewSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export const generationSchema = z.object({ expectedRevision: z.number().int().positive(), stage: z.enum(["requirements", "design", "tasks"]), instruction: z.string().max(4000).optional(), configuration: specModelConfigurationSchema.optional() }).strict();
export const taskAttemptSchema = z.object({ expectedRevision: z.number().int().positive(), configuration: specModelConfigurationSchema.optional() }).strict();
export const evidenceSchema = z.object({
  expectedRevision: z.number().int().positive(), evidenceId: z.uuid(), taskKey: z.string().regex(/^T-\d{2,}$/), checkKey: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("manual"), attemptId: z.uuid(), passed: z.boolean(), note: z.string().max(2000) }).strict(),
    z.object({ kind: z.literal("carried"), revision: z.number().int().positive(), evidenceId: z.uuid(), note: z.string().trim().min(1).max(2000) }).strict(),
  ]),
}).strict();
export const reconcileSchema = z.object({ expectedRevision: z.number().int().positive(), note: z.string().max(2000).optional() }).strict();
export type RecordEvidenceInput = z.infer<typeof evidenceSchema>;
export const attemptQuerySchema = z.object({ revision: z.coerce.number().int().positive(), taskKey: z.string().optional(), cursor: z.string().optional() }).strict();
export const specIdempotencyHeader = z.object({ "idempotency-key": z.string().trim().min(1).max(128) }).passthrough();

export const taskStatusSchema = z.enum(["not_started", "queued", "running", "waiting", "passed", "needs_verification", "failed", "cancelled", "timed_out", "needs_reconciliation"]);
export const evidenceViewSchema = z.object({ id: z.uuid(), taskKey: z.string(), checkKey: z.string(), passed: z.boolean(), source: z.enum(["automatic", "manual", "carried"]), attemptId: z.uuid().optional(), toolOperationId: z.string().optional(), fromRevision: z.number().optional(), reviewedBy: z.uuid().optional(), note: z.string().optional(), createdBy: z.uuid(), createdAt: z.iso.datetime() }).strict();
export const specSnapshotSchema = z.object({
  id: z.uuid(), projectId: z.uuid(), conversationId: z.uuid(), title: z.string(), currentRevision: z.number().int().positive(), revision: z.number().int().positive(), requirementsMd: z.string(), designMd: z.string().nullable(), taskPlan: taskPlanSchema, reviews: z.record(z.string(), z.object({ revision: z.number(), sourceRevision: z.number().optional(), reviewerId: z.uuid(), reviewedAt: z.iso.datetime() })).default({}), evidence: z.array(evidenceViewSchema), acceptance: z.object({ reviewerId: z.uuid(), acceptedAt: z.iso.datetime(), revision: z.number(), evidenceIds: z.array(z.uuid()) }).nullable(), tasks: z.array(z.object({ key: z.string(), status: taskStatusSchema, attemptId: z.uuid().nullable(), runId: z.uuid().nullable() }).strict()), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), history: z.array(z.object({ revision: z.number(), createdAt: z.iso.datetime(), createdBy: z.uuid() })),
}).strict();
export const specListSchema = z.object({ items: z.array(z.object({ id: z.uuid(), projectId: z.uuid(), title: z.string(), currentRevision: z.number(), conversationId: z.uuid(), updatedAt: z.iso.datetime() })), nextCursor: z.string().nullable() }).strict();
export const attemptListSchema = z.object({ items: z.array(z.object({ id: z.uuid(), revision: z.number(), taskKey: z.string(), pendingInputId: z.uuid(), requestKey: z.string(), createdAt: z.iso.datetime(), releasedAt: z.iso.datetime().nullable(), runId: z.uuid().nullable(), runState: z.string().nullable(), resolution: z.unknown().nullable() })), nextCursor: z.string().nullable() }).strict();
export const receiptSchema = z.object({ pendingInputId: z.uuid(), attemptId: z.uuid().optional(), runId: z.uuid().nullable() }).strict();
export const exportSchema = z.object({ revision: z.number(), files: z.array(z.object({ name: z.string(), content: z.string() })) }).strict();
export const asTaskPlan = (value: unknown): SpecTask[] => taskPlanSchema.parse(value);
