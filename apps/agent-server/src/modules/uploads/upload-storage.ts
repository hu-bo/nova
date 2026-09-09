import * as Minio from "minio";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { createLogger } from "@nova/logger";
import { AppError, invalidInput, uploadUnavailable } from "../../errors.js";

const logger = createLogger("agent-server").child("upload-storage");

export interface UploadStorage {
  ensureBucket(): Promise<void>;
  createUpload(input: { userId: string; filename: string }): Promise<{ key: string; upload: string; download: string }>;
  putFile(input: {
    userId: string;
    filename: string;
    data: Uint8Array;
    mimeType: string;
  }): Promise<{ key: string; download: string }>;
  readImage(userId: string, key: string): Promise<{ data: string; mimeType: string }>;
  imageUrl(userId: string, key: string): Promise<string>;
}

const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function validateOwnedKey(userId: string, key: string): void {
  const prefix = `uploads/${encodeURIComponent(userId)}/`;
  if (
    !key.startsWith(prefix) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,10})?$/.test(key.slice(prefix.length))
  ) {
    throw invalidInput("图片附件无效，请重新上传");
  }
}

function imageMimeType(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) return "image/gif";
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw invalidInput("图片格式不支持，请使用 PNG、JPEG、GIF 或 WebP");
}

export function createMinioUploadStorage(config: {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
}): UploadStorage {
  const client = new Minio.Client(config);
  let bucketReady: Promise<void> | null = null;
  const ensureBucket = () => {
    if (!bucketReady)
      bucketReady = (async () => {
        if (!(await client.bucketExists(config.bucket))) await client.makeBucket(config.bucket);
      })().catch((error) => {
        logger.error(
          { err: error, component: "server", dependency: "minio", bucket: config.bucket },
          "failed to initialize upload bucket",
        );
        bucketReady = null;
        throw error;
      });
    return bucketReady;
  };
  return {
    ensureBucket,
    async createUpload(input) {
      try {
        await ensureBucket();
        const key = objectKey(input.userId, input.filename);
        const [upload, download] = await Promise.all([
          client.presignedPutObject(config.bucket, key, SIGNED_URL_TTL_SECONDS),
          client.presignedGetObject(config.bucket, key, SIGNED_URL_TTL_SECONDS),
        ]);
        return { key, upload, download };
      } catch (error) {
        logger.error(
          { err: error, component: "server", dependency: "minio", bucket: config.bucket },
          "failed to create upload URLs",
        );
        throw error;
      }
    },
    async putFile(input) {
      try {
        await ensureBucket();
        const key = objectKey(input.userId, input.filename);
        const data = Buffer.from(input.data);
        await client.putObject(config.bucket, key, data, data.byteLength, { "Content-Type": input.mimeType });
        return { key, download: await client.presignedGetObject(config.bucket, key, SIGNED_URL_TTL_SECONDS) };
      } catch (error) {
        logger.error(
          { err: error, component: "server", dependency: "minio", bucket: config.bucket },
          "failed to store uploaded file",
        );
        throw error;
      }
    },
    async readImage(userId, key) {
      validateOwnedKey(userId, key);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(uploadUnavailable());
          }, 30_000);
        });
        const read = async () => {
          const stream = await client.getObject(config.bucket, key);
          const abort = () => stream.destroy(new Error("Image read timed out"));
          if (controller.signal.aborted) {
            stream.destroy();
            throw uploadUnavailable();
          }
          controller.signal.addEventListener("abort", abort, { once: true });
          try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of stream) {
              const bytes = Buffer.from(chunk);
              size += bytes.length;
              if (size > MAX_IMAGE_BYTES) throw invalidInput("每张图片不能超过 5 MiB");
              chunks.push(bytes);
            }
            const bytes = Buffer.concat(chunks);
            return { data: bytes.toString("base64"), mimeType: imageMimeType(bytes) };
          } finally {
            controller.signal.removeEventListener("abort", abort);
            stream.destroy();
          }
        };
        return await Promise.race([read(), timeout]);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error && typeof error === "object" && "code" in error && error.code === "NoSuchKey") {
          throw invalidInput("图片尚未上传完成或已删除，请重新上传");
        }
        throw uploadUnavailable();
      } finally {
        clearTimeout(timer);
      }
    },
    async imageUrl(userId, key) {
      validateOwnedKey(userId, key);
      try {
        return await client.presignedGetObject(config.bucket, key, SIGNED_URL_TTL_SECONDS);
      } catch {
        throw uploadUnavailable();
      }
    },
  };
}

function objectKey(userId: string, filename: string): string {
  return `uploads/${encodeURIComponent(userId)}/${randomUUID()}${safeExtension(filename)}`;
}

function safeExtension(filename: string): string {
  const extension = extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
}
