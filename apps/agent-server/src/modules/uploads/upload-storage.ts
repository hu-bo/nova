import * as Minio from "minio";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { createLogger } from "@nova/logger";

const logger = createLogger("agent-server").child("upload-storage");

export interface UploadStorage {
  ensureBucket(): Promise<void>;
  put(input: {
    userId: string;
    filename: string;
    mimeType: string;
    data: Buffer;
  }): Promise<{ url: string; key: string }>;
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
    async put(input) {
      try {
        await ensureBucket();
        const suffix = safeExtension(input.filename);
        const key = `uploads/${encodeURIComponent(input.userId)}/${randomUUID()}${suffix}`;
        await client.putObject(config.bucket, key, input.data, input.data.byteLength, {
          "Content-Type": input.mimeType || "application/octet-stream",
          "X-Amz-Meta-Original-Name": encodeURIComponent(input.filename),
        });
        return { key, url: await client.presignedGetObject(config.bucket, key, 7 * 24 * 60 * 60) };
      } catch (error) {
        logger.error(
          { err: error, component: "server", dependency: "minio", bucket: config.bucket, mimeType: input.mimeType },
          "upload failed",
        );
        throw error;
      }
    },
  };
}

function safeExtension(filename: string): string {
  const extension = extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
}
