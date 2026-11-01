import type { Attachment, FileRef } from "@nova/agent-ui-contracts";
import { DomainError } from "../../shared/domain-error.js";
export type CreateUploadRequest = { ownerUserId: string; filename: string; mime: string; size: number };
export type CreateUploadResponse = {
  key: string;
  upload: { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string };
  download: { url: string; expiresAt: string };
};
/** A configured storage must verify actual bytes and its owner-bound upload ticket. */
export interface UploadStorage {
  createUpload(input: CreateUploadRequest): Promise<CreateUploadResponse>;
  completeUpload(input: CreateUploadRequest & { key: string; sha256: string }): Promise<Attachment>;
  readImage(ref: Extract<FileRef, { kind: "object" }>): Promise<{ data: string; mimeType: string }>;
  imageUrl(ref: Extract<FileRef, { kind: "object" }>): Promise<{ url: string; expiresAt: string }>;
}
export function disabledUploadStorage(): UploadStorage {
  const unavailable = async (): Promise<never> => {
    throw new DomainError("CONFLICT", "Object storage is not configured");
  };
  return { createUpload: unavailable, completeUpload: unavailable, readImage: unavailable, imageUrl: unavailable };
}
