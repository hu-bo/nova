import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import * as Minio from "minio";
import type { Attachment, FileRef } from "@nova/agent-ui-contracts";
import { DomainError } from "../../shared/domain-error.js";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MIB } from "./attachment-policy.js";

export type CreateUploadRequest = { ownerUserId: string; filename: string; mime: string; size: number };
export type CreateUploadResponse = {
  key: string;
  upload: { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string };
  download: { url: string; expiresAt: string };
};

/** A configured storage verifies uploaded bytes before making an immutable attachment object. */
export interface UploadStorage {
  createUpload(input: CreateUploadRequest): Promise<CreateUploadResponse>;
  completeUpload(input: CreateUploadRequest & { key: string; sha256: string }): Promise<Attachment>;
  readImage(
    ownerUserId: string,
    ref: Extract<FileRef, { kind: "object" }>,
  ): Promise<{ data: string; mimeType: string }>;
  imageUrl(ownerUserId: string, ref: Extract<FileRef, { kind: "object" }>): Promise<{ url: string; expiresAt: string }>;
}

export type MinioUploadStorageConfig = {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
};

const UPLOAD_TTL_SECONDS = 10 * 60;
const DOWNLOAD_TTL_SECONDS = 5 * 60;
const OVERSIZED_ATTACHMENT_MESSAGE = `Attachments cannot exceed ${MAX_ATTACHMENT_MIB} MiB`;
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export function disabledUploadStorage(): UploadStorage {
  const unavailable = async (): Promise<never> => {
    throw new DomainError("SERVICE_UNAVAILABLE", "Attachment storage is not configured");
  };
  return { createUpload: unavailable, completeUpload: unavailable, readImage: unavailable, imageUrl: unavailable };
}

export function createMinioUploadStorage(
  config: MinioUploadStorageConfig,
  logError: (error: unknown, operation: string) => void,
): UploadStorage {
  const client = new Minio.Client(config);
  let bucketReady: Promise<void> | undefined;

  const ensureBucket = () => {
    bucketReady ??= (async () => {
      if (await client.bucketExists(config.bucket)) return;
      try {
        await client.makeBucket(config.bucket);
      } catch (error) {
        // Another API instance may have created the bucket between the existence check and create.
        if (!(await client.bucketExists(config.bucket))) throw error;
      }
    })().catch((error: unknown) => {
      bucketReady = undefined;
      throw error;
    });
    return bucketReady;
  };

  const providerCall = async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
    try {
      await ensureBucket();
      return await action();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      logError(error, operation);
      throw storageUnavailable();
    }
  };

  const readObject = async (key: string): Promise<Buffer> => {
    const stream = await client.getObject(config.bucket, key);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stream.destroy(new Error("Attachment read timed out"));
    }, 30_000);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_ATTACHMENT_BYTES) throw invalidAttachment(OVERSIZED_ATTACHMENT_MESSAGE);
        chunks.push(bytes);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (timedOut) throw storageUnavailable();
      throw error;
    } finally {
      clearTimeout(timer);
      stream.destroy();
    }
  };

  const verifyBytes = (data: Buffer, input: { size: number; mime: string; sha256: string }) => {
    if (data.byteLength !== input.size) throw invalidAttachment("Uploaded file size does not match");
    const mimeType = imageMimeType(data);
    if (mimeType !== input.mime) throw invalidAttachment("Uploaded file type does not match");
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (sha256 !== input.sha256.toLowerCase()) throw invalidAttachment("Uploaded file checksum does not match");
    return { mimeType, sha256 };
  };

  const finalKeyFor = (pendingKey: string, ownerUserId: string) => {
    const leaf = ownedLeaf(ownerUserId, pendingKey, "pending");
    return `uploads/${encodeURIComponent(ownerUserId)}/${leaf}`;
  };

  return {
    async createUpload(input) {
      validateUpload(input);
      const extension = safeExtension(input.filename, input.mime);
      const key = `uploads/pending/${encodeURIComponent(input.ownerUserId)}/${randomUUID()}${extension}`;
      return providerCall("create upload ticket", async () => {
        const [upload, download] = await Promise.all([
          client.presignedPutObject(config.bucket, key, UPLOAD_TTL_SECONDS),
          client.presignedGetObject(config.bucket, key, DOWNLOAD_TTL_SECONDS),
        ]);
        const now = Date.now();
        return {
          key,
          upload: {
            url: upload,
            method: "PUT" as const,
            headers: { "content-type": input.mime },
            expiresAt: new Date(now + UPLOAD_TTL_SECONDS * 1000).toISOString(),
          },
          download: {
            url: download,
            expiresAt: new Date(now + DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
          },
        };
      });
    },

    async completeUpload(input) {
      validateUpload(input);
      if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw invalidAttachment("Invalid attachment checksum");
      const finalKey = finalKeyFor(input.key, input.ownerUserId);
      return providerCall("complete upload", async () => {
        let sourceKey = input.key;
        try {
          const stat = await client.statObject(config.bucket, sourceKey);
          if (stat.size > MAX_ATTACHMENT_BYTES) throw invalidAttachment(OVERSIZED_ATTACHMENT_MESSAGE);
          if (stat.size !== input.size) throw invalidAttachment("Uploaded file size does not match");
        } catch (error) {
          if (!isMissingObject(error)) throw error;
          // A completed request may be retried after its response was lost. The final object
          // uses the same opaque ID and is immutable through the still-live pending PUT URL.
          sourceKey = finalKey;
          const stat = await client.statObject(config.bucket, sourceKey).catch((cause: unknown) => {
            if (isMissingObject(cause)) throw invalidAttachment("Upload was not found or is incomplete");
            throw cause;
          });
          if (stat.size > MAX_ATTACHMENT_BYTES) throw invalidAttachment(OVERSIZED_ATTACHMENT_MESSAGE);
          if (stat.size !== input.size) throw invalidAttachment("Uploaded file size does not match");
        }

        const data = await readObject(sourceKey);
        const verified = verifyBytes(data, input);
        if (sourceKey !== finalKey) {
          await client.putObject(config.bucket, finalKey, data, data.byteLength, {
            "Content-Type": verified.mimeType,
          });
          // Keep a failed cleanup from turning a successful, verified upload into a retry loop.
          await client.removeObject(config.bucket, sourceKey).catch((error: unknown) => {
            logError(error, "remove pending upload");
          });
        }
        return {
          ref: { kind: "object", key: finalKey },
          name: input.filename,
          mimeType: verified.mimeType,
          size: data.byteLength,
          sha256: verified.sha256,
        };
      });
    },

    async readImage(ownerUserId, ref) {
      validateOwnedFinalKey(ownerUserId, ref.key);
      return providerCall("read attachment image", async () => {
        try {
          const stat = await client.statObject(config.bucket, ref.key);
          if (stat.size > MAX_ATTACHMENT_BYTES) throw invalidAttachment(OVERSIZED_ATTACHMENT_MESSAGE);
          const data = await readObject(ref.key);
          return { data: data.toString("base64"), mimeType: imageMimeType(data) };
        } catch (error) {
          if (isMissingObject(error)) throw new DomainError("NOT_FOUND", "Attachment not found");
          throw error;
        }
      });
    },

    async imageUrl(ownerUserId, ref) {
      validateOwnedFinalKey(ownerUserId, ref.key);
      return providerCall("create attachment image URL", async () => {
        try {
          const stat = await client.statObject(config.bucket, ref.key);
          if (stat.size > MAX_ATTACHMENT_BYTES) throw invalidAttachment(OVERSIZED_ATTACHMENT_MESSAGE);
          const url = await client.presignedGetObject(config.bucket, ref.key, DOWNLOAD_TTL_SECONDS);
          return { url, expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000).toISOString() };
        } catch (error) {
          if (isMissingObject(error)) throw new DomainError("NOT_FOUND", "Attachment not found");
          throw error;
        }
      });
    },
  };
}

function validateUpload(input: CreateUploadRequest): void {
  if (!MIME_EXTENSIONS[input.mime]) throw invalidAttachment("Only PNG, JPEG, GIF, and WebP images are supported");
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > MAX_ATTACHMENT_BYTES)
    throw invalidAttachment(`Attachments must be between 1 byte and ${MAX_ATTACHMENT_MIB} MiB`);
}

function safeExtension(filename: string, mime: string): string {
  const extension = extname(filename).toLowerCase();
  if (mime === "image/jpeg" && [".jpg", ".jpeg"].includes(extension)) return extension;
  return extension === MIME_EXTENSIONS[mime] ? extension : MIME_EXTENSIONS[mime]!;
}

function imageMimeType(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) return "image/gif";
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw invalidAttachment("File content is not a supported image");
}

function ownedLeaf(ownerUserId: string, key: string, kind: "pending" | "final"): string {
  const prefix =
    kind === "pending"
      ? `uploads/pending/${encodeURIComponent(ownerUserId)}/`
      : `uploads/${encodeURIComponent(ownerUserId)}/`;
  const leaf = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)$/.test(leaf))
    throw new DomainError("FORBIDDEN", "Attachment upload does not belong to this user");
  return leaf;
}

function validateOwnedFinalKey(ownerUserId: string, key: string): void {
  ownedLeaf(ownerUserId, key, "final");
}

function isMissingObject(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ["NoSuchKey", "NoSuchObject", "NotFound"].includes(String(error.code)),
  );
}

function invalidAttachment(message: string): DomainError {
  return new DomainError("VALIDATION_ERROR", message);
}

function storageUnavailable(): DomainError {
  return new DomainError("SERVICE_UNAVAILABLE", "Attachment storage is temporarily unavailable");
}
