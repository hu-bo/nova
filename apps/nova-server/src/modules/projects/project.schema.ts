import { z } from "zod";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { paginationQuerySchema } from "../../shared/pagination.schema.js";
import { okEnvelope, success } from "../../shared/response.schema.js";

/**
 * Project DTO (返回):
 * - ownerUserId 出现在 DTO 中用于客户端 awareness; 不是鉴权凭据, 客户端不能据此
 *   假设自己拥有别 owner 的资源。
 * - deletedAt 仅在已软删除时返回; 客户端据此不再发起 create conversation 等写操作。
 */
export const projectSchema = z.object({
  id: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  name: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});
export const createProjectBodySchema = z
  .object({ name: z.string().trim().min(1).max(200) })
  .strict();
export const updateProjectBodySchema = createProjectBodySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, "At least one field must be supplied");
export const projectParamsSchema = z.object({ id: z.string().uuid() }).strict();
export const projectListSchema = z.object({ items: z.array(projectSchema) });
export { errorResponseSchema, okEnvelope, paginationQuerySchema, success };
export type CreateProjectInput = z.infer<typeof createProjectBodySchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectBodySchema>;