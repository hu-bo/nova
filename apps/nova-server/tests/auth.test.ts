import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createAuthServiceClient } from "../src/modules/identity/auth-service.js";
import { createCasdoorIdentityVerifier } from "../src/modules/identity/identity.service.js";
import { identityPlugin } from "../src/modules/identity/index.js";
import { requirePrincipal, requireRole } from "../src/shared/authorization.js";
import { registerErrorHandlers } from "../src/plugins/errors.js";

const config = loadConfig({
  DATABASE_URL: "postgresql://unused/unused",
  AUTH_MODE: "casdoor",
  AUTH_SERVICE_TOKEN_TRANSPORT: "header",
});
const alice = { id: "stable-alice", name: "alice", displayName: "Alice", roles: [{ name: "admin", isEnabled: false }] };
const response = (user: object = alice) => new Response(JSON.stringify({ user }));

test("Auth Service sends Bearer by default selection and explicit query compatibility without fallback", async () => {
  for (const mode of ["header", "query"] as const) {
    const auth = createAuthServiceClient({ ...config, AUTH_SERVICE_TOKEN_TRANSPORT: mode }, async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/me");
      assert.equal(url.searchParams.get("token"), mode === "query" ? "secret" : null);
      assert.equal(new Headers(init?.headers).get("authorization"), mode === "header" ? "Bearer secret" : null);
      assert.equal(init?.redirect, "error");
      return response();
    });
    assert.deepEqual(await auth.verify("secret"), { identityId: alice.id, displayName: "Alice", roles: [] });
  }
});

test("Auth Service maps rejected/disabled credentials to 401 and dependency failures to safe 503", async () => {
  for (const status of [401, 403, 500, 503]) {
    const auth = createAuthServiceClient(config, async () => new Response("secret provider body", { status }));
    await assert.rejects(auth.verify("secret"), { code: status < 500 ? "UNAUTHORIZED" : "SERVICE_UNAVAILABLE" });
  }
  for (const fetchImpl of [
    async () => {
      throw new Error("https://provider/me?token=secret");
    },
    async () => new Response("invalid json"),
    async () => new Response(JSON.stringify({ user: { id: "alice" } })),
  ]) {
    await assert.rejects(createAuthServiceClient(config, fetchImpl).verify("secret"), (error: unknown) => {
      assert.equal((error as { code: string }).code, "SERVICE_UNAVAILABLE");
      assert.doesNotMatch(String(error), /secret|provider/);
      assert.equal((error as Error).cause, undefined);
      return true;
    });
  }
  for (const flags of [{ isForbidden: true }, { isDeleted: true }])
    await assert.rejects(
      createAuthServiceClient(config, async () => response({ ...alice, ...flags })).verify("token"),
      { code: "UNAUTHORIZED" },
    );
});

test("verified roles and stable local projection define the principal, preserving local suspension", async () => {
  const auth = createAuthServiceClient(config, async () =>
    response({ ...alice, isGlobalAdmin: true, roles: [{ name: "member", isEnabled: true }] }),
  );
  let active = true;
  const id = randomUUID();
  const identities: string[] = [];
  const verifier = createCasdoorIdentityVerifier(auth, {
    async upsert(identity) {
      identities.push(identity.identityId);
      return { id, active };
    },
  });
  const principals = await Promise.all([verifier.verifyAccessToken("one"), verifier.verifyAccessToken("two")]);
  assert.deepEqual(principals[0], { identityId: alice.id, localUserId: id, roles: ["member", "admin"] });
  assert.equal(principals[1]?.localUserId, id);
  assert.deepEqual(identities, [alice.id, alice.id]);
  active = false;
  await assert.rejects(verifier.verifyAccessToken("one"), { code: "UNAUTHORIZED" });
});

test("Fastify keeps public health available, rejects invalid identity and preserves upstream 503", async (t) => {
  const app = Fastify({ logger: false });
  registerErrorHandlers(app);
  let upstream = () => response();
  t.mock.method(globalThis, "fetch", async () => upstream());
  // Exercise the real plugin and repository query chain without a network database.
  const id = randomUUID();
  await app.register(
    fp(
      async (app) => {
        app.decorate("db", {
          insert: () => ({
            values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [{ id, active: true }] }) }),
          }),
        } as never);
      },
      { name: "database" },
    ),
  );
  await app.register(identityPlugin, config);
  app.get("/health", async () => ({ ok: true }));
  app.get("/private", async (request) => requirePrincipal(request));
  app.get("/admin", async (request) => requireRole(request, "admin"));
  t.after(() => app.close());
  assert.equal((await app.inject("/health")).statusCode, 200);
  for (const authorization of [undefined, "Basic secret", "Bearer "])
    assert.equal(
      (await app.inject({ url: "/private", headers: authorization ? { authorization } : {} })).statusCode,
      401,
    );
  const success = await app.inject({ url: "/private", headers: { authorization: "Bearer valid" } });
  assert.equal(success.json().localUserId, id);
  assert.equal((await app.inject({ url: "/admin", headers: { authorization: "Bearer member" } })).statusCode, 403);
  upstream = () => new Response("no", { status: 401 });
  assert.equal((await app.inject({ url: "/private", headers: { authorization: "Bearer rejected" } })).statusCode, 401);
  upstream = () => new Response("down", { status: 503 });
  const failure = await app.inject({ url: "/private", headers: { authorization: "Bearer valid" } });
  assert.equal(failure.statusCode, 503);
  assert.equal(failure.json().code, 503);
});

test("Auth Service timeout is bounded and reported as 503", async () => {
  const auth = createAuthServiceClient(
    { ...config, AUTH_SERVICE_TIMEOUT_MS: 15 },
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout was not propagated")), 1000);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  );
  await assert.rejects(auth.verify("private-token"), { code: "SERVICE_UNAVAILABLE" });
});

test("production rejects dev bypass and accepts previous endpoint configuration", () => {
  assert.equal(loadConfig({ DATABASE_URL: "postgresql://unused/unused" }).AUTH_MODE, "casdoor");
  assert.throws(() =>
    loadConfig({ DATABASE_URL: "postgresql://unused/unused", NODE_ENV: "production", AUTH_MODE: "dev" }),
  );
  assert.equal(
    loadConfig({
      DATABASE_URL: "postgresql://unused/unused",
      AUTH_MODE: "casdoor",
      CASDOOR_ENDPOINT: "https://legacy.example",
    }).AUTH_SERVICE_URL,
    "https://legacy.example",
  );
  assert.equal(
    loadConfig({
      DATABASE_URL: "postgresql://unused/unused",
      AUTH_SERVICE_URL: "https://current.example",
      CASDOOR_ENDPOINT: "https://legacy.example",
    }).AUTH_SERVICE_URL,
    "https://current.example",
  );
});
