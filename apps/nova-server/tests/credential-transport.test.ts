import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { createCredentialCipher } from "../src/shared/credential-cipher.js";
import {
  deriveTransportSecret,
  deriveWrapKey,
  openCredential,
  sealCredential,
  unwrapTransportSecret,
  wrapTransportSecret,
} from "../src/shared/credential-transport.js";
import { remotesModule } from "../src/modules/remotes/index.js";
import { identityPlugin } from "../src/modules/identity/index.js";
import { registerErrorHandlers } from "../src/plugins/errors.js";
import type { Database } from "../database/index.js";
import { loadConfig } from "../src/config.js";

const MASTER_KEY = "ab".repeat(32);
const TOKEN = "dev:user-1:identity-1";

test("credential transport keys are locked to the documented HKDF convention", () => {
  // 客户端 (apps/nova-client/src/api/credential-transport.ts) 用同一组参数派生;
  // 已知向量一旦变化, 说明两端约定被改动, 必须同步更新。
  assert.equal(
    deriveWrapKey(TOKEN).toString("hex"),
    "6fc3be3d72b51d366cc0eafe3bcc0d3adcd7c9d2a3708602257e65e9ea47a37c",
  );
  assert.equal(
    deriveTransportSecret(MASTER_KEY).toString("hex"),
    "420263c210dbfc083577fcaf2267282375256e91a3c0b63036448ec764cfb9fa",
  );
  assert.throws(() => deriveTransportSecret(undefined));
});

test("credential envelopes keep the plaintext out of the payload and round-trip", () => {
  const secret = deriveTransportSecret(MASTER_KEY);
  const envelope = sealCredential("s3cr3t-password", secret);
  assert.match(envelope, /^enc1\.[0-9a-f]{24}\.[0-9a-f]{32}\.[0-9a-f]+$/);
  assert.ok(!envelope.includes("s3cr3t"));
  assert.ok(!envelope.includes("base64"));
  assert.equal(openCredential(envelope, secret), "s3cr3t-password");
  assert.throws(() => openCredential(envelope, deriveTransportSecret("cd".repeat(32))), {
    code: "VALIDATION_ERROR",
  });
  assert.throws(() => openCredential("plain-password", secret), { code: "VALIDATION_ERROR" });
});

test("the transport key is only handed out wrapped under the caller's bearer token", () => {
  const secret = deriveTransportSecret(MASTER_KEY);
  const wrapped = wrapTransportSecret(secret, TOKEN);
  assert.match(wrapped, /^w1\.[0-9a-f]{24}\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
  assert.ok(!wrapped.includes(secret.toString("hex")));
  assert.deepEqual(unwrapTransportSecret(wrapped, TOKEN), secret);
  assert.throws(() => unwrapTransportSecret(wrapped, "dev:other:identity"));
});

test("remote connection routes accept envelopes only and keep credentials encrypted at rest", async (t) => {
  const stored: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        returning: async () => {
          const row = {
            id: "c3412289-13be-47a8-ad60-c8fad3671987",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            lastCheckedAt: null,
            lastError: null,
            hostFingerprint: null,
            deletedAt: null,
            passphraseCiphertext: null,
            ...value,
          };
          stored.push(row);
          return [row];
        },
      }),
    }),
  };
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandlers(app);
  app.decorate("db", db as unknown as Database);
  app.decorate("credentialEncryptionKey", MASTER_KEY);
  app.register(
    identityPlugin,
    loadConfig({
      DATABASE_URL: "postgresql://unused/unused",
      AUTH_MODE: "dev",
    }),
  );
  app.register(remotesModule, { prefix: "/api" });
  await app.ready();
  const headers = { authorization: `Bearer ${TOKEN}` };

  await t.test("rejects plaintext credentials", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/remote-connections",
      headers,
      payload: {
        name: "dev",
        hostname: "test.invalid",
        username: "dev",
        rootPath: "/",
        authMethod: "password",
        credential: "plain-password",
      },
    });
    assert.equal(response.statusCode, 400);
    assert.ok(!response.body.includes("plain-password"));
  });

  await t.test("stores the decrypted credential encrypted at rest", async () => {
    const envelope = sealCredential("plain-password", deriveTransportSecret(MASTER_KEY));
    const response = await app.inject({
      method: "POST",
      url: "/api/remote-connections",
      headers,
      payload: {
        name: "dev",
        hostname: "test.invalid",
        username: "dev",
        rootPath: "/",
        authMethod: "password",
        credential: envelope,
        passphrase: sealCredential("key-passphrase", deriveTransportSecret(MASTER_KEY)),
      },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes("plain-password"));
    assert.ok(!response.body.includes("key-passphrase"));
    const row = stored.at(-1)!;
    const cipher = createCredentialCipher(MASTER_KEY);
    assert.equal(cipher.decrypt(String(row.credentialCiphertext)), "plain-password");
    assert.equal(cipher.decrypt(String(row.passphraseCiphertext)), "key-passphrase");
  });

  await t.test("hands out the transport key only for verified identities", async () => {
    const authorized = await app.inject({
      method: "GET",
      url: "/api/remote-connections/transport-key",
      headers,
    });
    assert.equal(authorized.statusCode, 200);
    const { key } = authorized.json().data as { key: string };
    assert.match(key, /^w1\./);
    assert.ok(!authorized.body.includes(deriveTransportSecret(MASTER_KEY).toString("hex")));
    assert.deepEqual(unwrapTransportSecret(key, TOKEN), deriveTransportSecret(MASTER_KEY));

    const anonymous = await app.inject({ method: "GET", url: "/api/remote-connections/transport-key" });
    assert.equal(anonymous.statusCode, 401);
  });

  await t.test("rejects envelopes sealed with a stale transport key", async () => {
    const stale = sealCredential("plain-password", deriveTransportSecret("cd".repeat(32)));
    const response = await app.inject({
      method: "PATCH",
      url: "/api/remote-connections/c3412289-13be-47a8-ad60-c8fad3671987",
      headers,
      payload: {
        name: "dev",
        hostname: "test.invalid",
        username: "dev",
        rootPath: "/",
        authMethod: "password",
        credential: stale,
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().details.reason, "CREDENTIAL_ENVELOPE_INVALID");
  });

  await t.test("rejects credentials that exceed the plaintext limit", async () => {
    const oversized = sealCredential("x".repeat(70_000), deriveTransportSecret(MASTER_KEY));
    const response = await app.inject({
      method: "POST",
      url: "/api/remote-connections",
      headers,
      payload: {
        name: "dev",
        hostname: "test.invalid",
        username: "dev",
        rootPath: "/",
        authMethod: "password",
        credential: oversized,
      },
    });
    assert.equal(response.statusCode, 400);
  });
});
