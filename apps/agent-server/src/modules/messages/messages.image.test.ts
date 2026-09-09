import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent, memoryStorage, type ModelRequest } from "@nova/agent-core";
import type { ModelConfig } from "@nova/protocol";
import { createMemoryStore } from "../../store.js";
import { registerErrorHandler } from "../../app/plugins/error-handler.js";
import { invalidInput } from "../../errors.js";
import { createMemoryModelConfigStore } from "../model-config/model-config.store.js";
import { createRuntimeRegistry } from "../runtime/runtime-registry.js";
import type { UploadStorage } from "../uploads/upload-storage.js";
import { messageRoutes } from "./messages.route.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const image = { key: "uploads/alice/06400028-78c6-4dcd-a7ad-6ec7fd906770.png", name: "截图.png" };
const pixels = { mimeType: "image/png", data: "aW1hZ2U=" };

async function setup(supportsImages = true) {
  const store = createMemoryStore();
  const modelConfig: ModelConfig = {
    provider: "openai",
    endpoint: "https://model.example/v1",
    model: "vision",
    credential: "test",
    contextWindow: 128000,
    maxOutput: 4096,
    reasoningFormat: "none",
    thinkingLevels: [],
    parallelToolCalls: true,
    inputModalities: supportsImages ? ["text", "image"] : ["text"],
  };
  const conversation = await store.createConversation({
    userId: "alice",
    projectId: null,
    runnerId: null,
    title: "New conversation",
    modelConfig,
  });
  const storage = memoryStorage();
  const requests: ModelRequest[] = [];
  const finished = vi.fn();
  const runtimes = createRuntimeRegistry(
    async (route) =>
      createAgent({
        model: {
          provider: "openai",
          model: route.conversation.modelConfig.model,
          inputModalities: route.conversation.modelConfig.inputModalities,
        },
        sessionId: conversation.id,
        storage,
        tools: [],
        decide: async () => {
          throw new Error("unexpected decision");
        },
        stream: async function* (request) {
          requests.push(request);
          yield { type: "finish", stopReason: "stop" };
        },
      }),
    (_id, agent) => {
      agent.subscribe((event) => {
        if (event.type === "run.end") finished();
      });
    },
    () => {},
  );
  const uploads: UploadStorage = {
    ensureBucket: async () => {},
    createUpload: async () => {
      throw new Error("unused");
    },
    putFile: async () => {
      throw new Error("unused");
    },
    readImage: vi.fn(async (userId, key) => {
      if (userId !== "alice" || key !== image.key) throw invalidInput("invalid image");
      return pixels;
    }),
    imageUrl: vi.fn(async () => "https://storage.example/image.png?fresh=1"),
  };
  const app = Fastify({ logger: false });
  apps.push(app);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (request) => {
    request.userId = request.headers["x-test-user"] === "bob" ? "bob" : "alice";
  });
  messageRoutes(
    app,
    store,
    runtimes,
    createMemoryModelConfigStore(),
    { encrypt: (s) => s, decrypt: (s) => s, masked: () => "***" },
    uploads,
  );
  return {
    app,
    store,
    uploads,
    requests,
    finished,
    runtimes,
    conversation,
    url: `/conversations/${conversation.id}/messages`,
  };
}

describe("image messages", () => {
  it("sends image-only input to the model, persists display metadata, refreshes previews, and restores image context", async () => {
    const { app, store, requests, finished, uploads, runtimes, conversation, url } = await setup();
    expect((await app.inject({ method: "POST", url, payload: { text: "", images: [image] } })).statusCode).toBe(202);
    await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(1));
    expect(requests[0]!.messages[0]!.blocks).toEqual([{ type: "image", ...pixels }]);
    const saved = await store.listMessages({ userId: "alice", conversationId: conversation.id, limit: 10 });
    expect(saved.items[0]!.blocks).toEqual([{ type: "image", ...image, mimeType: "image/png" }]);
    const history = await app.inject({ method: "GET", url });
    expect(history.json().items[0].blocks[0]).toMatchObject({
      type: "image",
      url: "https://storage.example/image.png?fresh=1",
    });
    expect(history.body).not.toContain(pixels.data);
    expect((await store.routeConversation("alice", conversation.id)).conversation.title).toBe(image.name);
    runtimes.invalidate(conversation.id);
    expect((await app.inject({ method: "POST", url, payload: { text: "继续分析" } })).statusCode).toBe(202);
    await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(2));
    expect(
      requests[1]!.messages.some((message) =>
        message.blocks.some((block) => block.type === "image" && block.data === pixels.data),
      ),
    ).toBe(true);
    expect(uploads.readImage).toHaveBeenCalledTimes(1);
    vi.mocked(uploads.imageUrl).mockRejectedValueOnce(new Error("storage offline"));
    const offline = await app.inject({ method: "GET", url });
    expect(offline.statusCode).toBe(200);
    expect(offline.body).toContain(image.name);
  });

  it("rejects unsupported models and invalid uploads before saving the message", async () => {
    const plain = await setup(false);
    const response = await plain.app.inject({
      method: "POST",
      url: plain.url,
      payload: { text: "看图", images: [image] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("不支持图片");
    expect(plain.uploads.readImage).not.toHaveBeenCalled();
    expect((await plain.app.inject({ method: "GET", url: plain.url })).json().items).toEqual([]);
    const vision = await setup();
    expect(
      (
        await vision.app.inject({
          method: "POST",
          url: vision.url,
          payload: { text: "", images: [{ ...image, key: "uploads/bob/foreign.png" }] },
        })
      ).statusCode,
    ).toBe(400);
    expect((await vision.app.inject({ method: "GET", url: vision.url })).json().items).toEqual([]);
    expect(
      (
        await vision.app.inject({
          method: "POST",
          url: vision.url,
          headers: { "x-test-user": "bob" },
          payload: { text: "", images: [image] },
        })
      ).statusCode,
    ).toBe(404);
  });
});
