const HEX: string[] = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

/**
 * 生成 RFC 4122 v4 UUID。
 * crypto.randomUUID 仅在安全上下文（HTTPS / localhost）可用，
 * 线上以 HTTP 访问时为 undefined，这里用同样可用的 getRandomValues 兜底。
 */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant（8-b，可通过服务端 zod uuid 校验）
  const hex = Array.from(bytes, (byte) => HEX[byte]!).join('');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20)
  );
}
