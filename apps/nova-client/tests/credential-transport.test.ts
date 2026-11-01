import { describe, expect, it } from 'vitest';
import {
  deriveWrapKey,
  sealCredential,
  unwrapTransportKey,
  unwrapTransportSecret,
} from '@/api/credential-transport';

const TOKEN = 'dev:user-1:identity-1';
/** 服务端 (nova-server) 用同一组约定生成的固定样本。 */
const WRAPPED_KEY =
  'w1.4f0224882e53077caef3af17.305be14a9327b595e8e0156f609b6e53.f8d3fa4a0987d1e0fb00c43667e2a12596f408426280cc1e9b8e95354e85df36';
const SERVER_ENVELOPE =
  'enc1.25052b687fda06d1f6138bb6.b4fc2d3bc243afebba87840d5a711a82.f5d8d3fa3018b1ff7d54cc110bd5df';
const TRANSPORT_SECRET = '420263c210dbfc083577fcaf2267282375256e91a3c0b63036448ec764cfb9fa';

const toHex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const fromHex = (value: string) =>
  new Uint8Array(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));

describe('credential transport envelopes', () => {
  it('derives the wrap key exactly like the server', async () => {
    expect(toHex(await deriveWrapKey(TOKEN))).toBe(
      '6fc3be3d72b51d366cc0eafe3bcc0d3adcd7c9d2a3708602257e65e9ea47a37c',
    );
  });

  it('unwraps the transport key handed out by the server', async () => {
    expect(toHex(await unwrapTransportSecret(WRAPPED_KEY, TOKEN))).toBe(TRANSPORT_SECRET);
  });

  it('seals credentials into envelopes the server can open', async () => {
    const key = await unwrapTransportKey(WRAPPED_KEY, TOKEN);
    const envelope = await sealCredential('s3cr3t-password', key);
    expect(envelope).toMatch(/^enc1\.[0-9a-f]{24}\.[0-9a-f]{32}\.[0-9a-f]+$/);
    expect(envelope).not.toContain('s3cr3t');
    expect(envelope).not.toContain('base64');
  });

  it('opens envelopes produced by the server', async () => {
    const secret = await unwrapTransportSecret(WRAPPED_KEY, TOKEN);
    const key = await crypto.subtle.importKey('raw', secret, { name: 'AES-GCM' }, false, [
      'decrypt',
    ]);
    const [version, iv, tag, ciphertext] = SERVER_ENVELOPE.split('.');
    expect(version).toBe('enc1');
    const sealed = new Uint8Array([...fromHex(ciphertext!), ...fromHex(tag!)]);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(iv!) }, key, sealed);
    expect(new TextDecoder().decode(plain)).toBe('s3cr3t-password');
  });

  it('refuses a transport key wrapped for another bearer token', async () => {
    await expect(unwrapTransportSecret(WRAPPED_KEY, 'dev:other:identity')).rejects.toThrow();
  });
});
