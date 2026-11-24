import { z } from "zod";
import {
  agentCatalogEntrySchema,
  skillCatalogEntrySchema,
  skillCatalogDiagnosticSchema,
  skillCatalogStatusSchema,
  skillExecutionRequirementsSchema,
  skillSourceSchema,
  skillVersionDetailSchema,
  skillVersionSchema,
} from "@nova/agent-ui-contracts";

/** GET /skills 查询（§8.2）：会话按原绑定、项目按当前绑定、纯设备按全局层；多参数一致性由服务端裁决。 */
export const skillListQuerySchema = z
  .object({
    conversationId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    runnerId: z.uuid().optional(),
    source: skillSourceSchema.optional(),
    q: z.string().trim().min(1).max(128).optional(),
    cursor: z.string().max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const skillCatalogMetaSchema = z
  .object({
    runnerId: z.uuid(),
    status: skillCatalogStatusSchema,
    revision: z.number().int().nonnegative(),
    complete: z.boolean(),
    diagnostics: z.array(skillCatalogDiagnosticSchema),
  })
  .strict();
export type SkillCatalogMeta = z.infer<typeof skillCatalogMetaSchema>;

/** GET /agents 查询（§8.2）：会话按原绑定、项目按当前绑定解析可见层。 */
export const agentListQuerySchema = z
  .object({
    conversationId: z.uuid().optional(),
    projectId: z.uuid().optional(),
  })
  .strict()
  .refine((query) => !query.conversationId || !query.projectId, "Use either conversationId or projectId");

export const agentListResponseSchema = z
  .object({
    items: z.array(agentCatalogEntrySchema),
    catalog: skillCatalogMetaSchema.nullable(),
  })
  .strict();

export const skillListResponseSchema = z
  .object({
    items: z.array(skillCatalogEntrySchema),
    nextCursor: z.string().nullable(),
    catalog: skillCatalogMetaSchema.nullable(),
  })
  .strict();

const params = z.object({ skillId: z.uuid() }).strict();
export const skillIdParamsSchema = params;
export const skillVersionParamsSchema = params.extend({ version: skillVersionSchema });

export const createSkillBodySchema = z
  .object({
    projectId: z.uuid().nullable().optional(),
    body: z.string().min(1).max(256 * 1024),
    requirements: skillExecutionRequirementsSchema.optional(),
  })
  .strict();

export const updateSkillDraftBodySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    body: z.string().min(1).max(256 * 1024),
    requirements: skillExecutionRequirementsSchema.optional(),
  })
  .strict();

export const publishSkillVersionBodySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    version: skillVersionSchema,
  })
  .strict();

export const skillVersionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(256).optional(),
  })
  .strict();

export const versionSummarySchema = z
  .object({
    id: z.uuid(),
    version: skillVersionSchema,
    slug: z.string(),
    description: z.string(),
    displayName: z.string().nullable(),
    requirements: skillExecutionRequirementsSchema,
    sha256: z.string(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const skillDetailSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    displayName: z.string().nullable(),
    description: z.string(),
    source: skillSourceSchema,
    projectId: z.uuid().nullable(),
    draftRevision: z.number().int().positive(),
    disabled: z.boolean(),
    currentPublished: versionSummarySchema.nullable(),
    draft: z
      .object({ body: z.string(), requirements: skillExecutionRequirementsSchema, revision: z.number().int().positive() })
      .strict()
      .nullable(),
  })
  .strict();

export const skillVersionListSchema = z.object({ items: z.array(versionSummarySchema), nextCursor: z.string().nullable() }).strict();
export const skillVersionDetailResponseSchema = skillVersionDetailSchema;
