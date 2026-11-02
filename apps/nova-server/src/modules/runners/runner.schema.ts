import { z } from "zod";
import { okEnvelope, success } from "../../shared/response.schema.js";

/**
 * Runner token DTO:
 * - 所属用户可复制有效的连接 token，数据库保存加密密文与校验 hash。
 * - 旧版仅保存 hash 的记录、已失效的凭据返回 token: null。
 */
export const runnerTokenSchema = z.object({
  id: z.string().uuid(),
  token: z.string().min(16).nullable(),
  label: z.string().nullable(),
  capabilities: z.array(z.string()),
  status: z.enum(["active", "rotated", "revoked"]),
  statusChangedAt: z.string().datetime(),
  rotatedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const runnerTokenWithSecretSchema = runnerTokenSchema.extend({
  token: z.string().min(16),
});

export const createRunnerTokenBodySchema = z
  .object({
    label: z.string().trim().min(1).max(64).optional(),
    capabilities: z.array(z.string().min(1).max(64)).max(32).default([]),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const rotateRunnerTokenBodySchema = z
  .object({
    /** 可选: 立即作废旧 token */
    revokePrevious: z.boolean().default(true),
  })
  .strict();

export const runnerSchema = z.object({
  id: z.string().uuid(),
  runnerId: z.string(),
  bootId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  capabilities: z.array(z.string()),
  lastSeenAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const runnerListSchema = z.object({ items: z.array(runnerSchema) });
export const runnerTokenListSchema = z.object({ items: z.array(runnerTokenSchema) });

export const remoteFileListingSchema = z.object({
  root: z.string(),
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      kind: z.enum(["file", "directory"]),
    }),
  ),
});

export const runnerIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

export const fileSummaryBodySchema = z
  .object({
    paths: z.array(z.string().min(1).max(1024)).min(1).max(64),
  })
  .strict();

export const fileListingQuerySchema = z.object({ path: z.string().min(1).max(1024).default(".") }).strict();

export const fileSummaryResponseSchema = z.object({
  items: z.array(
    z.object({
      path: z.string(),
      size: z.number().int().nonnegative(),
      sha256: z.string(),
      mtime: z.string().datetime(),
    }),
  ),
});

export { okEnvelope, success };
