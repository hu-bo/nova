import { z } from "zod";
import { CREDENTIAL_ENVELOPE_PATTERN, WRAPPED_TRANSPORT_KEY_PATTERN } from "../../shared/credential-transport.js";

/**
 * 凭据只接受传输层信封: enc1.<ivHex>.<tagHex>.<ciphertextHex>。
 * 明文凭据在 zod 层就被拒绝, 服务端不会看到明文密码。
 */
export const credentialEnvelopeSchema = z
  .string()
  .max(131_200)
  .regex(CREDENTIAL_ENVELOPE_PATTERN, "凭据必须以加密信封提交");
/** 口令用空串表示清除已保存的口令; undefined 表示保持不变。 */
export const passphraseEnvelopeSchema = z.union([credentialEnvelopeSchema, z.literal("")]);

const remoteFields = {
  name: z.string().trim().min(1).max(100),
  hostname: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-z\d._:-]+$/i),
  port: z.number().int().min(1).max(65535).default(22),
  username: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^\s\x00-\x1f]+$/),
  rootPath: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine((path) => path.startsWith("/") && !/[\x00-\x1f]/.test(path), "Use an absolute remote path"),
  authMethod: z.enum(["private_key", "password"]),
};
export const remoteConnectionBodySchema = z
  .object({ ...remoteFields, credential: credentialEnvelopeSchema, passphrase: passphraseEnvelopeSchema.optional() })
  .strict();
export const remoteConnectionPatchSchema = z
  .object({
    ...remoteFields,
    credential: credentialEnvelopeSchema.optional(),
    passphrase: passphraseEnvelopeSchema.optional(),
  })
  .strict();
export const remoteConnectionSchema = z.object({
  ...remoteFields,
  port: z.number().int(),
  id: z.string().uuid(),
  hostFingerprint: z.string().nullable(),
  status: z.enum(["unverified", "verified", "offline"]),
  lastCheckedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const remoteConnectionParamsSchema = z.object({ id: z.string().uuid() }).strict();
export const remoteTestBodySchema = z
  .object({
    fingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
      .optional(),
  })
  .strict();
export const remoteTestReceiptSchema = z.object({
  status: z.enum(["verified", "trust_required"]),
  fingerprint: z.string(),
  rootPath: z.string().optional(),
});
/** 传输密钥下发结果: 密钥本体用 Bearer token 派生的 wrap key 加密, 响应体不含明文。 */
export const remoteTransportKeySchema = z.object({
  key: z.string().regex(WRAPPED_TRANSPORT_KEY_PATTERN),
  algorithm: z.literal("AES-256-GCM"),
});
export type RemoteConnectionInput = z.infer<typeof remoteConnectionBodySchema>;
export type RemoteConnectionPatch = z.infer<typeof remoteConnectionPatchSchema>;
