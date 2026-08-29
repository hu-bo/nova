import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerErrorHandler } from "../../app/plugins/error-handler.js";
import { createRunnerRegistry, type RunnerRegistry } from "../runner/registry.js";
import { uploadRoutes } from "./upload.route.js";
import type { UploadStorage } from "./upload-storage.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function buildUploadApp(storage: UploadStorage, runners: RunnerRegistry = createRunnerRegistry()) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (request) => {
    request.userId = "alice";
  });
  await uploadRoutes(app, storage, runners);
  await app.ready();
  return app;
}

const unusedPutFile: UploadStorage["putFile"] = async () => ({ download: "" });

describe("upload route", () => {
  it("returns a direct-upload ticket without receiving file bytes", async () => {
    const createUpload = vi.fn(async () => ({
      upload: "http://storage.example.com/file.txt?upload=1",
      download: "http://storage.example.com/file.txt?download=1",
    }));
    const app = await buildUploadApp({ ensureBucket: async () => undefined, createUpload, putFile: unusedPutFile });

    const response = await app.inject({
      method: "POST",
      url: "/uploads",
      headers: { referer: "https://nova.example.com/chat" },
      payload: { name: "file.txt" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      upload: "https://storage.example.com/file.txt?upload=1",
      download: "https://storage.example.com/file.txt?download=1",
    });
    expect(createUpload).toHaveBeenCalledWith({
      userId: "alice",
      filename: "file.txt",
    });
  });

  it("maps signing failures to a stable service error", async () => {
    const app = await buildUploadApp({
      ensureBucket: async () => undefined,
      createUpload: async () => {
        throw new Error("secret MinIO failure");
      },
      putFile: unusedPutFile,
    });

    const response = await app.inject({
      method: "POST",
      url: "/uploads",
      payload: { name: "file.txt" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "UPLOAD_UNAVAILABLE",
      message: "附件存储暂时不可用，请稍后重试",
      requestId: expect.any(String),
    });
    expect(response.body).not.toContain("secret MinIO failure");
  });

  it("reads an owned runner file and stores it without sending bytes through the browser", async () => {
    const data = new TextEncoder().encode("hello");
    const readFile = vi.fn(async () => ({ name: "note.txt", size: data.byteLength, data }));
    const putFile = vi.fn(async () => ({ download: "http://storage.example.com/note.txt?download=1" }));
    const app = await buildUploadApp(
      {
        ensureBucket: async () => undefined,
        createUpload: async () => ({ upload: "", download: "" }),
        putFile,
      },
      { readFile } as unknown as RunnerRegistry,
    );

    const response = await app.inject({
      method: "POST",
      url: "/uploads/runner",
      headers: { referer: "https://nova.example.com/chat" },
      payload: { runnerId: "runner-1", path: "/workspace/note.txt" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      url: "https://storage.example.com/note.txt?download=1",
      name: "note.txt",
      size: 5,
      mimeType: "text/plain",
    });
    expect(readFile).toHaveBeenCalledWith("alice", "runner-1", "/workspace/note.txt", 20 * 1024 * 1024);
    expect(putFile).toHaveBeenCalledWith({
      userId: "alice",
      filename: "note.txt",
      data,
      mimeType: "text/plain",
    });
  });

  it("maps runner file storage failures to the stable upload error", async () => {
    const app = await buildUploadApp(
      {
        ensureBucket: async () => undefined,
        createUpload: async () => ({ upload: "", download: "" }),
        putFile: async () => {
          throw new Error("secret storage failure");
        },
      },
      {
        readFile: async () => ({ name: "note.txt", size: 1, data: new Uint8Array([1]) }),
      } as unknown as RunnerRegistry,
    );

    const response = await app.inject({
      method: "POST",
      url: "/uploads/runner",
      payload: { runnerId: "runner-1", path: "/workspace/note.txt" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "UPLOAD_UNAVAILABLE" });
    expect(response.body).not.toContain("secret storage failure");
  });
});
