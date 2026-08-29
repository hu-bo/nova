import { beforeEach, describe, expect, it, vi } from "vitest";

const minio = vi.hoisted(() => ({
  bucketExists: vi.fn(async () => true),
  presignedPutObject: vi.fn(async (_bucket: string, key: string) => `http://storage.example.com/${key}?upload=1`),
  presignedGetObject: vi.fn(async (_bucket: string, key: string) => `http://storage.example.com/${key}?download=1`),
  putObject: vi.fn(async () => ({ etag: "etag", versionId: null })),
}));

vi.mock("minio", () => ({
  Client: class {
    constructor(_config: unknown) {}
    bucketExists = minio.bucketExists;
    makeBucket = vi.fn(async () => undefined);
    presignedPutObject = minio.presignedPutObject;
    presignedGetObject = minio.presignedGetObject;
    putObject = minio.putObject;
  },
}));

import { createMinioUploadStorage } from "./upload-storage.js";

describe("MinIO upload storage", () => {
  beforeEach(() => {
    minio.bucketExists.mockClear();
    minio.presignedPutObject.mockClear();
    minio.presignedGetObject.mockClear();
    minio.putObject.mockClear();
  });

  it("signs user-scoped PUT and GET URLs", async () => {
    const storage = createStorage();
    const result = await storage.createUpload({ userId: "alice@example.com", filename: "Report.TXT" });

    expect(result.upload).toMatch(
      /^http:\/\/storage\.example\.com\/uploads\/alice%40example\.com\/[0-9a-f-]+\.txt\?upload=1$/,
    );
    expect(result.download).toMatch(
      /^http:\/\/storage\.example\.com\/uploads\/alice%40example\.com\/[0-9a-f-]+\.txt\?download=1$/,
    );
    expect(minio.bucketExists).toHaveBeenCalledTimes(1);
  });

  it("stores server-provided bytes with their content type and signs a download URL", async () => {
    const storage = createStorage();
    const result = await storage.putFile({
      userId: "alice@example.com",
      filename: "photo.PNG",
      data: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
    });

    expect(result.download).toMatch(
      /^http:\/\/storage\.example\.com\/uploads\/alice%40example\.com\/[0-9a-f-]+\.png\?download=1$/,
    );
    expect(minio.putObject).toHaveBeenCalledWith(
      "nova",
      expect.stringMatching(/^uploads\/alice%40example\.com\/[0-9a-f-]+\.png$/),
      Buffer.from([1, 2, 3]),
      3,
      { "Content-Type": "image/png" },
    );
  });
});

function createStorage() {
  return createMinioUploadStorage({
    endPoint: "storage.example.com",
    port: 443,
    useSSL: true,
    accessKey: "access-key",
    secretKey: "secret-key",
    bucket: "nova",
  });
}
