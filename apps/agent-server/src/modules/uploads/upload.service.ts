import { extname } from "node:path";
import { uploadUnavailable } from "../../errors.js";
import type { RunnerRegistry } from "../runner/registry.js";
import type { UploadStorage } from "./upload-storage.js";

export const MAX_RUNNER_UPLOAD_SIZE = 20 * 1024 * 1024;

export function createUploadService(storage: UploadStorage, runners: RunnerRegistry) {
  return {
    async createTicket(userId: string, filename: string) {
      try {
        return await storage.createUpload({ userId, filename });
      } catch {
        throw uploadUnavailable();
      }
    },
    async uploadRunnerFile(userId: string, runnerId: string, path: string) {
      const file = await runners.readFile(userId, runnerId, path, MAX_RUNNER_UPLOAD_SIZE);
      const mimeType = mimeTypeFor(file.name);
      try {
        const { download } = await storage.putFile({
          userId,
          filename: file.name,
          data: file.data,
          mimeType,
        });
        return { url: download, name: file.name, size: file.size, mimeType };
      } catch {
        throw uploadUnavailable();
      }
    },
  };
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

function mimeTypeFor(filename: string): string {
  return MIME_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
}
