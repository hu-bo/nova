import { useEffect, useState, useSyncExternalStore } from 'react';
import { createAttachmentUpload, completeAttachmentUpload } from '@/api/generated/attachments';
import type { CreateAttachmentUpload200 } from '@/api/generated/projectsAPI.schemas';
import type { Attachment } from '@nova/agent-ui-contracts';
import { ApiError, errorMessage } from '@/api/api-error';
export type UploadStatus = 'selected' | 'ticketed' | 'uploading' | 'verifying' | 'ready' | 'failed';
export type UploadEntry = {
  id: string;
  file: File;
  status: UploadStatus;
  attachment?: Attachment | undefined;
  error?: unknown;
};
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
export const statusLabel = (status: UploadStatus) =>
  ({
    selected: '等待上传',
    ticketed: '链接已生成',
    uploading: '正在上传',
    verifying: '正在验证',
    ready: '已就绪',
    failed: '上传失败',
  })[status];
export class UploadQueue {
  private entries: UploadEntry[] = [];
  private listeners = new Set<() => void>();
  private controllers = new Map<string, AbortController>();
  private active = 0;
  private disposed = false;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.entries;
  private update(id: string, values: Partial<UploadEntry>) {
    this.entries = this.entries.map((entry) => (entry.id === id ? { ...entry, ...values } : entry));
    for (const listener of this.listeners) listener();
  }
  add(files: Iterable<File>) {
    if (this.disposed) return;
    const added = Array.from(files)
      .slice(0, Math.max(0, 32 - this.entries.length))
      .map((file): UploadEntry => ({
        id: crypto.randomUUID(),
        file,
        status:
          ALLOWED.has(file.type) && file.size > 0 && file.size <= 5 * 1024 * 1024
            ? 'selected'
            : 'failed',
        ...(!ALLOWED.has(file.type) || !file.size || file.size > 5 * 1024 * 1024
          ? { error: new ApiError(400, 400, '请选择不超过 5 MiB 的 PNG、JPEG、GIF 或 WebP 图片。') }
          : {}),
      }));
    this.entries = [...this.entries, ...added];
    for (const listener of this.listeners) listener();
    this.pump();
  }
  retry(id: string) {
    const entry = this.entries.find((item) => item.id === id);
    if (
      entry &&
      ALLOWED.has(entry.file.type) &&
      entry.file.size > 0 &&
      entry.file.size <= 5 * 1024 * 1024
    ) {
      this.update(id, { status: 'selected', error: undefined, attachment: undefined });
      this.pump();
    }
  }
  remove(id: string) {
    this.controllers.get(id)?.abort();
    this.entries = this.entries.filter((item) => item.id !== id);
    for (const listener of this.listeners) listener();
  }
  clear() {
    for (const controller of this.controllers.values()) controller.abort();
    this.entries = [];
    for (const listener of this.listeners) listener();
  }
  dispose() {
    this.disposed = true;
    this.clear();
  }
  private pump() {
    while (!this.disposed && this.active < 3) {
      const entry = this.entries.find(
        (item) => item.status === 'selected' && !this.controllers.has(item.id),
      );
      if (!entry) break;
      const controller = new AbortController();
      this.controllers.set(entry.id, controller);
      this.active += 1;
      void this.upload(entry, controller).finally(() => {
        this.controllers.delete(entry.id);
        this.active -= 1;
        this.pump();
      });
    }
  }
  private async upload(entry: UploadEntry, controller: AbortController) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    try {
      const ticket: CreateAttachmentUpload200 = await createAttachmentUpload(
        { filename: entry.file.name, mime: entry.file.type, size: entry.file.size },
        { signal, idempotencyKey: crypto.randomUUID() },
      );
      this.update(entry.id, { status: 'ticketed' });
      if (Date.parse(ticket.upload.expiresAt) <= Date.now())
        throw new ApiError(410, 410, '上传链接已过期，请重新上传。');
      this.update(entry.id, { status: 'uploading' });
      const response = await fetch(ticket.upload.url, {
        method: ticket.upload.method,
        headers: ticket.upload.headers,
        body: entry.file,
        signal,
        credentials: 'omit',
      });
      if (!response.ok)
        throw new ApiError(response.status, response.status, '上传中断，请重新上传。');
      this.update(entry.id, { status: 'verifying' });
      const digest = await crypto.subtle.digest('SHA-256', await entry.file.arrayBuffer());
      signal.throwIfAborted();
      const sha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const verified = await completeAttachmentUpload(
        encodeURIComponent(ticket.key),
        { sha256, mime: entry.file.type, size: entry.file.size },
        { signal },
      );
      this.update(entry.id, {
        status: 'ready',
        attachment: {
          ref: { kind: 'object', key: verified.key },
          name: entry.file.name,
          sha256: verified.sha256,
          mimeType: verified.mime,
          size: verified.size,
        },
      });
    } catch (error) {
      this.update(entry.id, {
        status: 'failed',
        error: signal.aborted
          ? new ApiError(
              0,
              0,
              controller.signal.aborted ? '上传已取消。' : '上传超时，请重新上传。',
            )
          : error,
      });
    }
  }
}
export function useUploadQueue() {
  const [queue] = useState(() => new UploadQueue());
  const entries = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  useEffect(() => () => queue.clear(), [queue]);
  return {
    entries,
    add: (files: Iterable<File>) => queue.add(files),
    retry: (id: string) => queue.retry(id),
    remove: (id: string) => queue.remove(id),
    clear: () => queue.clear(),
    errorMessage,
  };
}
