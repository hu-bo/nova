import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { attachmentRoutes } from "../src/modules/attachments/attachment.routes.js";
import { AttachmentService } from "../src/modules/attachments/attachment.service.js";
import { createMinioUploadStorage, type UploadStorage } from "../src/modules/attachments/upload-storage.js";
import { registerErrorHandlers } from "../src/plugins/errors.js";

test("attachment upload routes accept the reported JPEG and enforce the same 30 MiB limit at completion", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandlers(app);
  app.addHook("onRequest", async (request) => {
    request.principal = { identityId: "alice", localUserId: "owner", roles: [] };
  });
  const key = "uploads/pending/owner/image.jpg";
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const createUpload = t.mock.fn<UploadStorage["createUpload"]>(async () => ({
    key,
    upload: { url: "https://storage.example/put", method: "PUT", headers: {}, expiresAt },
    download: { url: "https://storage.example/get", expiresAt },
  }));
  const completeUpload = t.mock.fn<UploadStorage["completeUpload"]>(async (input) => ({
    ref: { kind: "object", key: "uploads/owner/image.jpg" },
    name: input.filename,
    mimeType: input.mime,
    size: input.size,
    sha256: input.sha256,
  }));
  const storage: UploadStorage = {
    createUpload,
    completeUpload,
    async readImage() {
      throw new Error("Unexpected image read");
    },
    async imageUrl() {
      throw new Error("Unexpected image URL request");
    },
  };
  await app.register(
    (app) => attachmentRoutes(app, new AttachmentService({ readMessageBlock: async () => undefined }, storage)),
    { prefix: "/api/attachments" },
  );

  for (const size of [11_519_687, 30 * 1024 * 1024]) {
    const upload = await app.inject({
      method: "POST",
      url: "/api/attachments/uploads",
      payload: { filename: "8and1.cn.jpg", mime: "image/jpeg", size },
    });
    assert.equal(upload.statusCode, 200, upload.body);
    assert.deepEqual(createUpload.mock.calls.at(-1)?.arguments[0], {
      ownerUserId: "owner",
      filename: "8and1.cn.jpg",
      mime: "image/jpeg",
      size,
    });
    const complete = await app.inject({
      method: "POST",
      url: `/api/attachments/uploads/${encodeURIComponent(key)}/complete`,
      payload: { mime: "image/jpeg", size, sha256: "a".repeat(64) },
    });
    assert.equal(complete.statusCode, 200, complete.body);
    assert.equal(complete.json().data.size, size);
    assert.equal(completeUpload.mock.calls.at(-1)?.arguments[0].size, size);
  }

  for (const size of [0, -1, 1.5, 30 * 1024 * 1024 + 1]) {
    const upload = await app.inject({
      method: "POST",
      url: "/api/attachments/uploads",
      payload: { filename: "8and1.cn.jpg", mime: "image/jpeg", size },
    });
    const complete = await app.inject({
      method: "POST",
      url: `/api/attachments/uploads/${encodeURIComponent(key)}/complete`,
      payload: { mime: "image/jpeg", size, sha256: "a".repeat(64) },
    });
    assert.equal(upload.statusCode, 400, upload.body);
    assert.equal(complete.statusCode, 400, complete.body);
  }
  assert.equal(createUpload.mock.callCount(), 2);
  assert.equal(completeUpload.mock.callCount(), 2);
});

test("storage rejects oversized upload metadata with the current limit before contacting MinIO", async () => {
  const storage = createMinioUploadStorage(
    { endPoint: "localhost", port: 9000, useSSL: false, accessKey: "test", secretKey: "test", bucket: "test" },
    () => assert.fail("Invalid upload metadata must not reach MinIO"),
  );
  const input = { ownerUserId: "owner", filename: "image.jpg", mime: "image/jpeg", size: 30 * 1024 * 1024 + 1 };
  const expected = { code: "VALIDATION_ERROR", message: "Attachments must be between 1 byte and 30 MiB" };
  await assert.rejects(storage.createUpload(input), expected);
  await assert.rejects(storage.completeUpload({ ...input, key: "unused", sha256: "a".repeat(64) }), expected);
});
