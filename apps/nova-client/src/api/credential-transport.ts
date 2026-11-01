import { ApiError } from './api-error';
import { getRemoteCredentialTransportKey } from './generated/remotes';
import { getAuthToken } from './transport';

/**
 * 传输层凭据信封 (与 apps/nova-server/src/shared/credential-transport.ts 对齐的约定)
 * ---------------------------------------------------------------------------
 * 1. 信封格式: `enc1.<ivHex>.<tagHex>.<ciphertextHex>` (AES-256-GCM, 十六进制, 不用 base64)
 * 2. 传输密钥: 服务端用 Bearer token 派生的 wrap key 加密后下发, 客户端解开后缓存于内存
 * 3. wrap key: HKDF-SHA256(ikm = Bearer token), 客户端与服务端各自算出, 密钥不上线
 *
 * 约定常量必须与服务端保持一致; 已知向量由 tests/credential-transport.test.ts 锁定。
 */
const WRAP_SALT = 'nova-credential-transport-wrap-v1';
const WRAP_INFO = 'nova-credential-transport-wrap-key-v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();

function toHex(bytes: Bytes): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Bytes {
  if (value.length % 2 !== 0 || !/^[\da-f]*$/i.test(value)) throw new Error('Invalid hex payload');
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function concat(...parts: Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle)
    throw new ApiError(
      0,
      'CRYPTO_UNAVAILABLE',
      '当前环境不支持加密信封，请使用 HTTPS 或 localhost 访问。',
    );
  return globalThis.crypto.subtle;
}

/** HKDF-SHA256 (RFC 5869): extract 用 salt 作 HMAC key, expand 取第一段。 */
async function hkdfSha256(ikm: string, salt: string, info: string, length: number): Promise<Bytes> {
  const crypto = subtle();
  const importHmac = (secret: ArrayBuffer | Bytes) =>
    crypto.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = await crypto.sign(
    'HMAC',
    await importHmac(encoder.encode(salt)),
    encoder.encode(ikm),
  );
  const okm = await crypto.sign(
    'HMAC',
    await importHmac(prk),
    concat(encoder.encode(info), new Uint8Array([1])),
  );
  return new Uint8Array(okm.slice(0, length));
}

async function importAesKey(raw: Bytes, usages: KeyUsage[]): Promise<CryptoKey> {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
}

/** 由 Bearer token 派生 wrap key, 与服务端 deriveWrapKey 一致。 */
export async function deriveWrapKey(token: string): Promise<Bytes> {
  return hkdfSha256(token, WRAP_SALT, WRAP_INFO, KEY_BYTES);
}

/** 解开服务端下发的传输密钥 (`w1.<iv>.<tag>.<ct>`), 返回原始密钥字节。 */
export async function unwrapTransportSecret(wrapped: string, token: string): Promise<Bytes> {
  const [version, iv, tag, ciphertext] = wrapped.split('.');
  if (version !== 'w1' || !iv || !tag || ciphertext === undefined)
    throw new Error('Transport key envelope has an unsupported format');
  const key = await importAesKey(await deriveWrapKey(token), ['decrypt']);
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromHex(iv) },
    key,
    concat(fromHex(ciphertext), fromHex(tag)),
  );
  return new Uint8Array(plain);
}

/** 取传输密钥并包装成只用于加密的 AES-GCM key。 */
export async function unwrapTransportKey(wrapped: string, token: string): Promise<CryptoKey> {
  return importAesKey(await unwrapTransportSecret(wrapped, token), ['encrypt']);
}

/** 用传输密钥加密明文凭据, 得到 `enc1.<iv>.<tag>.<ct>` 信封。 */
export async function sealCredential(value: string, key: CryptoKey): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(value)),
  );
  const tag = sealed.slice(sealed.length - TAG_BYTES);
  const ciphertext = sealed.slice(0, sealed.length - TAG_BYTES);
  return ['enc1', toHex(iv), toHex(tag), toHex(ciphertext)].join('.');
}

let cached: { token: string; key: CryptoKey } | null = null;

/** 取传输密钥: 同一 token 下复用缓存, token 变化(刷新/切换账号)后重新下发。 */
export async function transportKey(): Promise<CryptoKey> {
  // 服务端按 "Bearer <token>" 去掉前缀并 trim, 这里必须用同一个字符串派生 wrap key。
  const token = getAuthToken()?.trim();
  if (!token) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已过期，请重新登录。');
  if (cached && cached.token === token) return cached.key;
  const response = await getRemoteCredentialTransportKey();
  const key = await unwrapTransportKey(response.key, token);
  cached = { token, key };
  return key;
}

/** 服务端主密钥轮换后丢弃缓存, 下一次提交会重新下发传输密钥。 */
export function invalidateCredentialTransportKey(): void {
  cached = null;
}

/** 把明文凭据封装成传输信封, 请求体里不再出现明文密码。 */
export async function sealRemoteCredential(value: string): Promise<string> {
  return sealCredential(value, await transportKey());
}

/** 服务端拒绝信封(密钥轮换)时, 允许刷新密钥后重试一次。 */
export function isCredentialEnvelopeInvalid(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    (error.details?.reason === 'CREDENTIAL_ENVELOPE_INVALID' ||
      error.details?.reason === 'CREDENTIAL_ENVELOPE_FORMAT')
  );
}
