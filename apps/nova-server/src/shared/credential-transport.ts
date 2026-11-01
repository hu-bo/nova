import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { ModelConfigUnavailableError } from "./credential-cipher.js";
import { DomainError } from "./domain-error.js";

/**
 * 传输层凭据信封 (client ⇄ server 约定)
 * ---------------------------------------------------------------------------
 * 1. 信封格式: `enc1.<ivHex>.<tagHex>.<ciphertextHex>`
 *    AES-256-GCM, 96-bit 随机 IV, 128-bit auth tag; 十六进制编码, 不用 base64。
 * 2. 传输密钥: 由服务端主密钥 (MODEL_CONFIG_ENCRYPTION_KEY) 经 HKDF-SHA256 派生,
 *    永不以明文出现在任何响应体里。
 * 3. 密钥下发: `GET /api/remote-connections/transport-key` 返回用 wrap key 加密后的
 *    传输密钥 (`w1.<ivHex>.<tagHex>.<ciphertextHex>`); wrap key 由调用方的 Bearer
 *    token 经 HKDF-SHA256 派生, 客户端与服务端各自独立算出, 线上不传密钥本身。
 *
 * 约定常量必须与 apps/nova-client/src/api/credential-transport.ts 保持一致;
 * 两侧的 HKDF 参数由 tests/credential-transport.test.ts 的已知向量锁定。
 */
const TRANSPORT_SALT = "nova-credential-transport-v1";
const TRANSPORT_INFO = "nova-credential-transport-secret-v1";
const WRAP_SALT = "nova-credential-transport-wrap-v1";
const WRAP_INFO = "nova-credential-transport-wrap-key-v1";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export const CREDENTIAL_ENVELOPE_PATTERN = /^enc1\.[0-9a-f]{24}\.[0-9a-f]{32}\.[0-9a-f]{2,}$/i;
export const WRAPPED_TRANSPORT_KEY_PATTERN = /^w1\.[0-9a-f]{24}\.[0-9a-f]{32}\.[0-9a-f]{64}$/i;

/** 主密钥派生的传输密钥; 主密钥缺失时与凭据落库保持同样的 503 语义。 */
export function deriveTransportSecret(masterKeyHex: string | undefined): Buffer {
  if (!masterKeyHex) throw new ModelConfigUnavailableError();
  const master = Buffer.from(masterKeyHex, "hex");
  if (master.length !== KEY_BYTES) throw new ModelConfigUnavailableError();
  return Buffer.from(hkdfSync("sha256", master, TRANSPORT_SALT, TRANSPORT_INFO, KEY_BYTES));
}

/** 由 Bearer token 派生的 wrap key; 只用于包裹传输密钥, 不直接加密凭据。 */
export function deriveWrapKey(token: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(token, "utf8"), WRAP_SALT, WRAP_INFO, KEY_BYTES));
}

export function sealCredential(plaintext: string, secret: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["enc1", iv.toString("hex"), cipher.getAuthTag().toString("hex"), ciphertext.toString("hex")].join(".");
}

export function openCredential(envelope: string, secret: Buffer): string {
  const [version, iv, tag, ciphertext] = envelope.split(".");
  if (version !== "enc1" || !iv || !tag || ciphertext === undefined)
    throw new DomainError("VALIDATION_ERROR", "凭据信封格式不正确", { reason: "CREDENTIAL_ENVELOPE_INVALID" });
  try {
    const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "hex")), decipher.final()]).toString("utf8");
  } catch {
    throw new DomainError("VALIDATION_ERROR", "凭据信封无法解密，请重新提交密码", {
      reason: "CREDENTIAL_ENVELOPE_INVALID",
    });
  }
}

export function wrapTransportSecret(secret: Buffer, token: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveWrapKey(token), iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ["w1", iv.toString("hex"), cipher.getAuthTag().toString("hex"), ciphertext.toString("hex")].join(".");
}

export function unwrapTransportSecret(wrapped: string, token: string): Buffer {
  const [version, iv, tag, ciphertext] = wrapped.split(".");
  if (version !== "w1" || !iv || !tag || ciphertext === undefined)
    throw new Error("Transport key envelope has an unsupported format");
  const decipher = createDecipheriv("aes-256-gcm", deriveWrapKey(token), Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "hex")), decipher.final()]);
}
