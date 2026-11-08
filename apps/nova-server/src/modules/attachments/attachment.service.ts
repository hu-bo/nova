import type { ConversationReader, MessageReference } from "../conversations/index.js";
import { DomainError } from "../../shared/domain-error.js";
import { disabledUploadStorage, type UploadStorage } from "./upload-storage.js";
export class AttachmentService {
  constructor(
    private readonly conversations: Pick<ConversationReader, "readMessageBlock">,
    private readonly storage: UploadStorage = disabledUploadStorage(),
  ) {}
  createUpload(input: { ownerUserId: string; filename: string; mime: string; size: number }) {
    return this.storage.createUpload(input);
  }
  async completeUpload(input: { ownerUserId: string; key: string; mime: string; size: number; sha256: string }) {
    const verified = await this.storage.completeUpload({ ...input, filename: input.key.split("/").at(-1) ?? "file" });
    if (verified.ref.kind !== "object") throw new DomainError("CONFLICT", "Storage returned an invalid reference");
    return { key: verified.ref.key, mime: verified.mimeType, size: verified.size ?? 0, sha256: verified.sha256 ?? "" };
  }
  private async objectRef(input: MessageReference) {
    const block = await this.conversations.readMessageBlock(input);
    if (!block || (block.type !== "image" && block.type !== "file") || block.attachment.ref.kind !== "object")
      throw new DomainError("NOT_FOUND", "Attachment not found");
    return block.attachment.ref;
  }
  async readImage(input: MessageReference) {
    return this.storage.readImage(input.ownerUserId, await this.objectRef(input));
  }
  async imageUrl(input: MessageReference) {
    return this.storage.imageUrl(input.ownerUserId, await this.objectRef(input));
  }
}
