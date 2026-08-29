import * as Minio from "minio";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { createLogger } from "@nova/logger";

const logger = createLogger("agent-server").child("upload-storage");

export interface UploadStorage {
  ensureBucket(): Promise<void>;
  createUpload(input: { userId: string; filename: string }): Promise<{ upload: string; download: string }>;
  putFile(input: {
    userId: string;
    filename: string;
    data: Uint8Array;
    mimeType: string;
  }): Promise<{ download: string }>;
}

const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

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
        return { upload, download };
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
        return { download: await client.presignedGetObject(config.bucket, key, SIGNED_URL_TTL_SECONDS) };
      } catch (error) {
        logger.error(
          { err: error, component: "server", dependency: "minio", bucket: config.bucket },
          "failed to store uploaded file",
        );
        throw error;
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
