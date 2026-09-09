import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

const minio = vi.hoisted(() => ({
  bucketExists: vi.fn(async () => true),
  presignedPutObject: vi.fn(async (_bucket: string, key: string) => `http://storage.example.com/${key}?upload=1`),
  presignedGetObject: vi.fn(async (_bucket: string, key: string) => `http://storage.example.com/${key}?download=1`),
  putObject: vi.fn(async () => ({ etag: "etag", versionId: null })),
  getObject: vi.fn<(_bucket: string, _key: string) => Promise<Readable>>(),
}));

vi.mock("minio", () => ({
  Client: class {
    constructor(_config: unknown) {}
    bucketExists = minio.bucketExists;
    makeBucket = vi.fn(async () => undefined);
    presignedPutObject = minio.presignedPutObject;
    presignedGetObject = minio.presignedGetObject;
    putObject = minio.putObject;
    getObject = minio.getObject;
  },
}));

import { createMinioUploadStorage } from "./upload-storage.js";

describe("MinIO upload storage", () => {
  beforeEach(() => {
    minio.bucketExists.mockClear();
    minio.presignedPutObject.mockClear();
    minio.presignedGetObject.mockClear();
    minio.putObject.mockClear();
    minio.getObject.mockReset();
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

  it("reads image bytes from the owned object, independent of signed URLs and claimed MIME", async () => {
    const storage = createStorage();
    const key = "uploads/alice%40example.com/06400028-78c6-4dcd-a7ad-6ec7fd906770.png";
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT4sAAAAASUVORK5CYII=",
      "base64",
    );
    minio.getObject.mockResolvedValueOnce(Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]));
    expect(await storage.readImage("alice@example.com", key)).toEqual({
      data: bytes.toString("base64"),
      mimeType: "image/png",
    });
    expect(minio.getObject).toHaveBeenCalledWith("nova", key);
    expect(await storage.imageUrl("alice@example.com", key)).toContain(key);
  });

  it.each([
    "uploads/bob/06400028-78c6-4dcd-a7ad-6ec7fd906770.png",
    "uploads/alice/../bob/photo.png",
    "uploads/alice/%2e%2e/photo.png",
    "https://internal.example/image.png",
  ])("rejects unowned or malformed object identities before storage access: %s", async (key) => {
    const storage = createStorage();
    await expect(storage.readImage("alice", key)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(storage.imageUrl("alice", key)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(minio.getObject).not.toHaveBeenCalled();
    expect(minio.presignedGetObject).not.toHaveBeenCalled();
  });

  it("rejects oversized and non-image objects and closes their streams", async () => {
    const storage = createStorage();
    const key = "uploads/alice/06400028-78c6-4dcd-a7ad-6ec7fd906770.png";
    for (const bytes of [Buffer.alloc(5 * 1024 * 1024 + 1), Buffer.from("<svg>untrusted</svg>"), Buffer.alloc(0)]) {
      const stream = Readable.from([bytes]);
      minio.getObject.mockResolvedValueOnce(stream);
      await expect(storage.readImage("alice", key)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(stream.destroyed).toBe(true);
    }
    minio.getObject.mockRejectedValueOnce({ code: "NoSuchKey" });
    await expect(storage.readImage("alice", key)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    minio.getObject.mockRejectedValueOnce(new Error("secret storage failure"));
    await expect(storage.readImage("alice", key)).rejects.toMatchObject({
      code: "UPLOAD_UNAVAILABLE",
      message: "附件存储暂时不可用，请稍后重试",
    });
  });

  it("times out stalled image reads and destroys the stream", async () => {
    vi.useFakeTimers();
    try {
      const stream = new Readable({ read() {} });
      minio.getObject.mockResolvedValueOnce(stream);
      const result = expect(
        createStorage().readImage("alice", "uploads/alice/06400028-78c6-4dcd-a7ad-6ec7fd906770.png"),
      ).rejects.toMatchObject({ code: "UPLOAD_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(30_000);
      await result;
      expect(stream.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
