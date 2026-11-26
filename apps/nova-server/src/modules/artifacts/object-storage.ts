import { extname } from "node:path";
import * as Minio from "minio";
import type { ArtifactPreviewKind } from "@nova/agent-ui-contracts";
import { DomainError } from "../../shared/domain-error.js";

/**
 * 产物对象存储（docs/design/nova-skills.md §5.2、§7，P1-C1）。
 * 与图片附件的 UploadStorage 分离：附件签名接口只认附件对象键，产物必须走本模块
 * （红线：不复用图片专用 completeUpload，§2 文件展示契约行）。
 * 对象键一律由服务端按 §5.2 前缀构造；显示文件名只存数据库，不参与拼键。
 */

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TTL_SECONDS = 5 * 60;
const PREVIEW_TTL_SECONDS = 5 * 60;
/** 受限文本预览的字节上限（读取后按截断标记返回）。 */
export const MAX_PREVIEW_TEXT_BYTES = 512 * 1024;

export type ArtifactObjectStorage = {
  /** 幂等不可变键上传：同键同字节重复 put 安全（崩溃窗口重放）。 */
  putObject(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** NotFound 返回 undefined；瞬时错误必须抛出，不得当作不存在（§7 窗口表）。 */
  statObject(key: string): Promise<{ size: number; etag: string } | undefined>;
  readObject(key: string, maxBytes: number): Promise<{ body: Uint8Array; truncated: boolean } | undefined>;
  removeObject(key: string): Promise<void>;
  presignGet(key: string, options: { expiresSeconds: number; downloadFileName?: string }): Promise<{ url: string; expiresAt: string }>;
  /** 前缀列举（孤儿扫描用）：返回 key/size/最后修改时间。 */
  listObjects(prefix: string): Promise<{ key: string; size: number; lastModified: Date }[]>;
};

export type ArtifactStorageConfig = {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
};

export function disabledArtifactStorage(): ArtifactObjectStorage {
  const unavailable = async (): Promise<never> => {
    throw new DomainError("SERVICE_UNAVAILABLE", "Artifact storage is not configured");
  };
  return { putObject: unavailable, statObject: unavailable, readObject: unavailable, removeObject: unavailable, presignGet: unavailable, listObjects: unavailable };
}

export function createMinioArtifactStorage(
  config: ArtifactStorageConfig,
  logError: (error: unknown, operation: string) => void,
): ArtifactObjectStorage {
  const client = new Minio.Client(config);
  let bucketReady: Promise<void> | undefined;
  const ensureBucket = () => {
    bucketReady ??= (async () => {
      if (await client.bucketExists(config.bucket)) return;
      try {
        await client.makeBucket(config.bucket);
      } catch (error) {
        if (!(await client.bucketExists(config.bucket))) throw error;
      }
    })().catch((error: unknown) => {
      bucketReady = undefined;
      throw error;
    });
    return bucketReady;
  };
  return {
    async putObject(key, body, contentType) {
      try {
        await ensureBucket();
        await client.putObject(config.bucket, key, Buffer.from(body), body.length, { "Content-Type": contentType });
      } catch (error) {
        logError(error, "putObject");
        throw error;
      }
    },
    async statObject(key) {
      try {
        const info = await client.statObject(config.bucket, key);
        return { size: Number(info.size), etag: info.etag ?? "" };
      } catch (error) {
        if (isNotFound(error)) return undefined;
        logError(error, "statObject");
        throw error;
      }
    },
    async readObject(key, maxBytes) {
      let response: import("node:stream").Readable | undefined;
      try {
        response = await client.getObject(config.bucket, key);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        logError(error, "readObject");
        throw error;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      for await (const chunk of response) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        if (total + buffer.length > maxBytes) {
          chunks.push(buffer.subarray(0, Math.max(0, maxBytes - total)));
          truncated = true;
          break;
        }
        chunks.push(buffer);
        total += buffer.length;
      }
      await response.destroy();
      const body = Buffer.concat(chunks);
      return { body, truncated };
    },
    async removeObject(key) {
      try {
        await client.removeObject(config.bucket, key);
      } catch (error) {
        if (isNotFound(error)) return;
        logError(error, "removeObject");
        throw error;
      }
    },
    async presignGet(key, options) {
      try {
        const url = await client.presignedGetObject(
          config.bucket,
          key,
          options.expiresSeconds,
          options.downloadFileName
            ? { "response-content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(options.downloadFileName)}` }
            : undefined,
        );
        return { url, expiresAt: new Date(Date.now() + options.expiresSeconds * 1000).toISOString() };
      } catch (error) {
        logError(error, "presignGet");
        throw error;
      }
    },
    async listObjects(prefix) {
      try {
        const objects: { key: string; size: number; lastModified: Date }[] = [];
        for await (const item of client.listObjectsV2(config.bucket, prefix, true))
          objects.push({ key: String(item.name ?? ""), size: Number(item.size ?? 0), lastModified: item.lastModified ?? new Date(0) });
        return objects;
      } catch (error) {
        logError(error, "listObjects");
        throw error;
      }
    },
  };
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code ?? "";
  return code === "NotFound" || code === "NoSuchKey" || (error as { statusCode?: number } | undefined)?.statusCode === 404;
}

/** §5.2 对象键前缀（服务端构造；P2 资源包共用本模块，前缀 skill-bundles/）。 */
export function artifactObjectKey(input: { ownerUserId: string; conversationId: string; runId: string; artifactId: string; sha256: string }): string {
  return `artifacts/${input.ownerUserId}/${input.conversationId}/${input.runId}/${input.artifactId}/${input.sha256}`;
}

export function downloadTtlSeconds(): number {
  return DOWNLOAD_TTL_SECONDS;
}
export function previewTtlSeconds(): number {
  return PREVIEW_TTL_SECONDS;
}

/**
 * 文件类型矩阵单来源（§7 下载段）：决定可否发布与预览策略。
 * html/svg 等主动内容只发布、强制下载；Office/PDF 首版仅下载。
 */
const EXTENSION_PREVIEW: Record<string, ArtifactPreviewKind> = {
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  csv: "text",
  json: "text",
  log: "text",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  html: "download",
  htm: "download",
  svg: "download",
  pdf: "download",
  doc: "download",
  docx: "download",
  xls: "download",
  xlsx: "download",
  ppt: "download",
  pptx: "download",
};
const MIME_PREVIEW: Record<string, ArtifactPreviewKind> = {
  "text/markdown": "markdown",
  "text/plain": "text",
  "text/csv": "text",
  "application/json": "text",
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
};

export function artifactPreviewKind(mimeType: string, fileName: string): ArtifactPreviewKind | undefined {
  const extension = extname(fileName).toLowerCase().replace(/^\./, "");
  if (MIME_PREVIEW[mimeType.toLowerCase()]) return MIME_PREVIEW[mimeType.toLowerCase()]!;
  return EXTENSION_PREVIEW[extension];
}

/** Run 级发布额度（§5.3）：文件数与总量；单文件上限见 MAX_ARTIFACT_BYTES。账户级配额值留在配置层。 */
export const MAX_ARTIFACT_FILES_PER_RUN = 100;
export const MAX_ARTIFACT_BYTES_PER_RUN = 200 * 1024 * 1024;
/** 对象键前缀与孤儿保护期（§7 清理段：TTL 值留在配置）。 */
export const ARTIFACT_OBJECT_PREFIX = "artifacts/";
export const ORPHAN_PROTECTION_DAYS = 7;

const MIME_BY_EXTENSION: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** 显示文件名派生 mime；不在白名单内的扩展名不发布（§7 类型校验）。 */
export function guessArtifactMimeType(fileName: string): string | undefined {
  const extension = extname(fileName).toLowerCase().replace(/^\./, "");
  return MIME_BY_EXTENSION[extension];
}
