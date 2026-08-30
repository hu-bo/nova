import { afterEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, registerApp } from "./app/app.js";
import { createMemoryStore } from "./store.js";
import { createEventHub } from "./modules/runtime/event-hub.js";
import { createPendingDecisions } from "./modules/decision/pending-decisions.js";
import { createRunnerRegistry } from "./modules/runner/registry.js";
import { createCredentialCipher } from "./modules/model-config/credential.js";
import { createMemoryModelConfigStore } from "./modules/model-config/model-config.store.js";
import { memoryStorage } from "@nova/agent-core";
import { createAgentRuntime } from "./modules/runtime/create-agent-runtime.js";

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

it("creates an unbound standalone chat runtime with only self-contained tools", () => {
  const events = createEventHub();
  const agent = createAgentRuntime(
    {
      userId: "alice",
      project: null,
      conversation: {
        id: "0e484465-b5a8-47d0-9ffb-49bc1913e7eb",
        userId: "alice",
        projectId: null,
        runnerId: null,
        title: "Chat",
        modelConfig: {
          provider: "openai",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-5",
          credential: "test-secret",
          contextWindow: 128_000,
          maxOutput: 16_384,
          thinkingLevels: ["off", "high"],
          parallelToolCalls: true,
          reasoningFormat: "openai",
          inputModalities: ["text"],
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
    {
      storage: () => memoryStorage(),
      decisions: createPendingDecisions(events),
      runners: createRunnerRegistry(),
    },
  );

  expect(agent.state.activeTools).toContain("read_url");
  expect(agent.state.activeTools).not.toContain("bash");
});

it("creates a runner-bound standalone chat runtime with coding tools", () => {
  const events = createEventHub();
  const picks: unknown[][] = [];
  const pick = (...args: unknown[]) => {
    picks.push(args);
    return { identity: { workspace: "E:\\workspace" } };
  };
  const runners = {
    pick,
  } as unknown as ReturnType<typeof createRunnerRegistry>;
  const agent = createAgentRuntime(
    {
      userId: "alice",
      project: null,
      conversation: {
        id: "3a7d1744-a854-4a9c-98f3-d1f314ab5b58",
        userId: "alice",
        projectId: null,
        runnerId: "runner-1",
        title: "Chat with runner",
        modelConfig: {
          provider: "openai",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-5",
          credential: "test-secret",
          contextWindow: 128_000,
          maxOutput: 16_384,
          thinkingLevels: ["off", "high"],
          parallelToolCalls: true,
          reasoningFormat: "openai",
          inputModalities: ["text"],
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
    {
      storage: () => memoryStorage(),
      decisions: createPendingDecisions(events),
      runners,
    },
  );

  expect(agent.state.activeTools).toContain("bash");
  expect(picks).toEqual([["alice", "runner-1"]]);
});

it("runs the authenticated project and conversation flow with ownership isolation", async () => {
  const store = createMemoryStore();
  const events = createEventHub();
  const modelConfig = {
    provider: "openai" as const,
    endpoint: "https://api.openai.com/v1",
    model: "gpt-5",
    credential: "test-secret",
    contextWindow: 128_000,
    maxOutput: 16_384,
    thinkingLevels: ["off", "high"] as const,
    parallelToolCalls: true,
    reasoningFormat: "openai" as const,
    inputModalities: ["text"] as const,
  };
  app = createApp(false);
  await registerApp(app, {
    store,
    events,
    decisions: createPendingDecisions(events),
    runners: createRunnerRegistry(),
    runnerEndpoint: "http://127.0.0.1:50051",
    authService: {
      async verifyAccessToken() {
        return null;
      },
      async createAuthorizeUrl(_appName, input) {
        return { url: `https://auth.example.com/login?state=${input.state}` };
      },
    },
    verifyAccessToken: async (token) =>
      ({
        "admin-token": {
          casdoorId: "admin",
          username: "admin",
          displayName: "Admin",
          role: "admin",
          isAdmin: true,
          isActive: true,
        },
        "alice-token": {
          casdoorId: "alice",
          username: "alice",
          displayName: "Alice",
          role: "developer",
          isAdmin: false,
          isActive: true,
        },
        "bob-token": {
          casdoorId: "bob",
          username: "bob",
          displayName: "Bob",
          role: "developer",
          isAdmin: false,
          isActive: true,
        },
      })[token] ?? null,
    modelConfigStore: createMemoryModelConfigStore(),
    credentialCipher: createCredentialCipher(Buffer.alloc(32).toString("base64url")),
    runtimes: {
      async send(route, text) {
        await store.appendMessage({
          id: "assistant-1",
          conversationId: route.conversation.id,
          role: "assistant",
          blocks: [{ type: "text", text: `received: ${text}` }],
          status: "done",
          createdAt: new Date(),
        });
        events.publish(route.conversation.id, { type: "run.end", runId: "run-1", stopReason: "done" });
      },
      async abort() {},
      async context() {
        return { inputTokens: 32_000, contextWindow: 128_000 };
      },
      async compact() {
        return { trigger: "manual", summarized: true, replacedFrom: "entry-1", replacedTo: "entry-2" };
      },
      async clear() {
        return { inputTokens: 32_000, contextWindow: 128_000 };
      },
      invalidate() {},
    },
  });

  const unauthorized = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { "x-request-id": "request-1" },
  });
  expect(unauthorized.statusCode).toBe(401);
  expect(unauthorized.headers["x-request-id"]).toBe("request-1");
  expect(unauthorized.json()).toEqual({
    code: "UNAUTHORIZED",
    message: "Authentication is required",
    requestId: "request-1",
  });

  const authorizeUrl = await app.inject({
    method: "POST",
    url: "/api/apps/nova/oauth/authorize-url",
    payload: { redirect_uri: "http://localhost:5173/callback", state: "state-1" },
  });
  expect(authorizeUrl.statusCode).toBe(200);
  expect(authorizeUrl.json()).toEqual({ url: "https://auth.example.com/login?state=state-1" });

  const currentUser = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: "Bearer alice-token" },
  });
  expect(currentUser.statusCode).toBe(200);
  expect(currentUser.json()).toMatchObject({
    id: 1,
    casdoorId: "alice",
    username: "alice",
    displayName: "Alice",
    role: "developer",
    isAdmin: false,
    isActive: true,
  });
  expect(await store.getUser("alice")).toMatchObject({
    ...currentUser.json(),
    createdAt: expect.any(Date),
    updatedAt: expect.any(Date),
  });

  const forbiddenProviders = await app.inject({
    method: "GET",
    url: "/admin/model-config/providers",
    headers: { authorization: "Bearer alice-token" },
  });
  expect(forbiddenProviders.statusCode).toBe(403);

  const createdProvider = await app.inject({
    method: "POST",
    url: "/admin/model-config/providers",
    headers: { authorization: "Bearer admin-token" },
    payload: {
      protocol: "openai",
      name: "Example",
      baseUrl: "https://api.example.com/v1",
      credential: "sk-top-secret",
      enabled: true,
      isPublic: false,
    },
  });
  expect(createdProvider.statusCode).toBe(201);
  expect(createdProvider.json()).toMatchObject({
    protocol: "openai",
    name: "Example",
    baseUrl: "https://api.example.com/v1",
    credentialMasked: "••••cret",
    enabled: true,
    isPublic: false,
    ownerId: "admin",
  });
  expect(JSON.stringify(createdProvider.json())).not.toContain("sk-top-secret");

  const listedProviders = await app.inject({
    method: "GET",
    url: "/admin/model-config/providers",
    headers: { authorization: "Bearer admin-token" },
  });
  expect(listedProviders.statusCode).toBe(200);
  expect(listedProviders.json()).toEqual([createdProvider.json()]);

  const providerId = createdProvider.json().id as string;
  const createdModel = await app.inject({
    method: "POST",
    url: "/admin/model-config/models",
    headers: { authorization: "Bearer admin-token" },
    payload: {
      publicName: "nova-fast",
      providerId,
      upstreamName: "example-fast",
      contextWindow: 128000,
      maxOutput: 8192,
      thinkingLevels: [],
      parallelToolCalls: true,
      reasoningFormat: "none",
      inputModalities: ["text"],
      enabled: true,
      priceIn: "1.25",
      priceOut: "5",
      priceCacheRead: "0.25",
    },
  });
  expect(createdModel.statusCode).toBe(201);
  expect(createdModel.json()).toMatchObject({ publicName: "nova-fast", providerId, providerName: "Example" });
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/admin/model-config/models",
        headers: { authorization: "Bearer admin-token" },
      })
    ).json(),
  ).toHaveLength(1);
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/admin/model-config/models",
        headers: { authorization: "Bearer alice-token" },
      })
    ).json(),
  ).toEqual([]);
  const quotas = await app.inject({
    method: "GET",
    url: "/admin/model-config/quotas",
    headers: { authorization: "Bearer admin-token" },
  });
  expect(quotas.statusCode).toBe(200);
  expect(quotas.json()).toEqual([]);
  const usage = await app.inject({
    method: "GET",
    url: "/admin/model-config/usage?from=2026-07-31T16%3A00%3A00.000Z&to=2026-08-23T15%3A59%3A59.999Z&limit=100",
    headers: { authorization: "Bearer admin-token" },
  });
  expect(usage.statusCode).toBe(200);
  expect(usage.json()).toMatchObject({
    items: [],
    totals: { requests: 0, input: 0, output: 0, cacheRead: 0, cost: "0.00000000" },
  });

  const deletedProvider = await app.inject({
    method: "DELETE",
    url: `/admin/model-config/providers/${providerId}`,
    headers: { authorization: "Bearer admin-token" },
  });
  expect(deletedProvider.statusCode).toBe(204);
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/admin/model-config/providers",
        headers: { authorization: "Bearer admin-token" },
      })
    ).json(),
  ).toEqual([]);

  const createdProject = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { authorization: "Bearer alice-token" },
    payload: { name: "Nova" },
  });
  expect(createdProject.statusCode).toBe(201);
  expect(createdProject.json()).toMatchObject({ name: "Nova", workspace: null, runnerState: "disconnected" });
  const projectId = createdProject.json().id as string;

  const hiddenFromOtherUser = await app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}`,
    headers: { authorization: "Bearer bob-token" },
    payload: { name: "Stolen" },
  });
  expect(hiddenFromOtherUser.statusCode).toBe(404);

  const createdConversation = await app.inject({
    method: "POST",
    url: "/api/conversations",
    headers: { authorization: "Bearer alice-token" },
    payload: { title: "Server work", runnerId: "runner-1", modelConfig },
  });
  expect(createdConversation.statusCode).toBe(201);
  const conversationId = createdConversation.json().id as string;

  const context = await app.inject({
    method: "GET",
    url: `/api/conversations/${conversationId}/context`,
    headers: { authorization: "Bearer alice-token" },
  });
  expect(context.statusCode).toBe(200);
  expect(context.json()).toEqual({ inputTokens: 32_000, contextWindow: 128_000 });

  const compacted = await app.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/compact`,
    headers: { authorization: "Bearer alice-token" },
  });
  expect(compacted.statusCode).toBe(200);
  expect(compacted.json()).toEqual({
    compacted: true,
    summarized: true,
    context: { inputTokens: 32_000, contextWindow: 128_000 },
  });

  const cleared = await app.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/clear`,
    headers: { authorization: "Bearer alice-token" },
  });
  expect(cleared.statusCode).toBe(200);
  expect(cleared.json()).toEqual({ context: { inputTokens: 32_000, contextWindow: 128_000 } });

  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const eventController = new AbortController();
  const eventResponse = await fetch(`${origin}/api/conversations/${conversationId}/events`, {
    signal: eventController.signal,
  });
  expect(eventResponse.status).toBe(200);
  expect(eventResponse.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  const eventReader = eventResponse.body!.getReader();
  const connectedChunk = await eventReader.read();
  expect(new TextDecoder().decode(connectedChunk.value)).toBe(":connected\n\n");

  const unauthenticatedSend = await app.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/messages`,
    payload: { text: "This must not run" },
  });
  expect(unauthenticatedSend.statusCode).toBe(401);

  const sent = await app.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/messages`,
    headers: { authorization: "Bearer alice-token" },
    payload: { text: "Build the server" },
  });
  expect(sent.statusCode).toBe(202);
  let eventText = "";
  while (!eventText.includes('data: {"type":"run.end","runId":"run-1","stopReason":"done"}')) {
    const chunk = await eventReader.read();
    if (chunk.done) break;
    eventText += new TextDecoder().decode(chunk.value);
  }
  expect(eventText).toContain('data: {"type":"run.end","runId":"run-1","stopReason":"done"}');
  await eventReader.cancel();
  eventController.abort();

  const history = await app.inject({
    method: "GET",
    url: `/api/conversations/${conversationId}/messages`,
    headers: { authorization: "Bearer alice-token" },
  });
  expect(history.statusCode).toBe(200);
  expect(history.json().items).toMatchObject([
    { role: "user", blocks: [{ type: "text", text: "Build the server" }], status: "done" },
    { role: "assistant", blocks: [{ type: "text", text: "received: Build the server" }], status: "done" },
  ]);

  const untitledConversation = await app.inject({
    method: "POST",
    url: "/api/conversations",
    headers: { authorization: "Bearer alice-token" },
    payload: { modelConfig },
  });
  expect(untitledConversation.statusCode).toBe(201);
  const untitledConversationId = untitledConversation.json().id as string;
  await app.inject({
    method: "POST",
    url: `/api/conversations/${untitledConversationId}/messages`,
    headers: { authorization: "Bearer alice-token" },
    payload: { text: "  Build\n a concise conversation title  " },
  });
  const conversations = await app.inject({
    method: "GET",
    url: "/api/conversations?limit=100",
    headers: { authorization: "Bearer alice-token" },
  });
  expect(conversations.json().items).toContainEqual(
    expect.objectContaining({ id: untitledConversationId, title: "Build a concise conversa…" }),
  );

  const openapi = await app.inject({
    method: "GET",
    url: "/api/openapi.json",
    headers: { authorization: "Bearer alice-token" },
  });
  expect(openapi.statusCode).toBe(200);
  expect(openapi.json().paths["/api/apps/{appName}/oauth/authorize-url"].post.operationId).toBe("createAuthorizeUrl");
  expect(openapi.json().paths["/api/me"].get.operationId).toBe("getCurrentUser");
  expect(openapi.json().paths["/api/conversations/{id}/messages"].post.operationId).toBe("sendMessage");
  expect(openapi.json().paths["/api/conversations/{id}/compact"].post.operationId).toBe("compactConversation");
  expect(openapi.json().paths["/api/conversations/{id}/clear"].post.operationId).toBe("clearConversationContext");
  expect(openapi.json().paths["/api/conversations/{id}/events"].get.security).toBeUndefined();
  expect(openapi.json().paths["/admin/model-config/providers"].get.operationId).toBe("listProviders");
});
