import { webcrypto } from 'node:crypto';
import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ ticket: vi.fn(), complete: vi.fn() }));
vi.mock('../src/api/generated/attachments', () => ({
  createAttachmentUpload: mocks.ticket,
  completeAttachmentUpload: mocks.complete,
}));
import { UploadQueue } from '../src/features/attachments/upload-service';
afterEach(() => {
  vi.unstubAllGlobals();
  mocks.ticket.mockReset();
  mocks.complete.mockReset();
});
function image() {
  const file = new File(['image bytes'], 'image.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode('image bytes').buffer,
  });
  return file;
}
const ticket = (key = 'owned/key') => ({
  key,
  upload: {
    url: 'https://storage.example/put',
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  },
});
describe('direct upload lifecycle', () => {
  it('rejects unsupported and oversized files before requesting storage tickets', () => {
    const queue = new UploadQueue();
    queue.add([
      new File(['x'], 'file.txt', { type: 'text/plain' }),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }),
    ]);
    expect(queue.getSnapshot().map((item) => item.status)).toEqual(['failed', 'failed']);
    expect(mocks.ticket).not.toHaveBeenCalled();
    queue.dispose();
  });
  it('limits outstanding uploads to three', () => {
    mocks.ticket.mockImplementation(() => new Promise(() => {}));
    const queue = new UploadQueue();
    queue.add([image(), image(), image(), image(), image()]);
    expect(mocks.ticket).toHaveBeenCalledTimes(3);
    expect(queue.getSnapshot().filter((item) => item.status === 'ready')).toHaveLength(0);
    queue.dispose();
  });
  it('puts binary bytes directly to storage and exposes only verified metadata', async () => {
    vi.stubGlobal('crypto', webcrypto);
    mocks.ticket.mockResolvedValue(ticket());
    mocks.complete.mockResolvedValue({
      key: 'owned/key',
      size: 11,
      mime: 'image/png',
      sha256: 'a'.repeat(64),
    });
    const fetcher = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const queue = new UploadQueue();
    const file = image();
    queue.add([file]);
    await waitFor(() => expect(queue.getSnapshot()[0]?.status).toBe('ready'));
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://storage.example/put');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      body: file,
      credentials: 'omit',
      method: 'PUT',
    });
    expect(queue.getSnapshot()[0]?.attachment).toEqual({
      ref: { kind: 'object', key: 'owned/key' },
      name: 'image.png',
      sha256: 'a'.repeat(64),
      mimeType: 'image/png',
      size: 11,
    });
    queue.dispose();
  });
  it('keeps failures visible and obtains a fresh ticket on manual retry', async () => {
    vi.stubGlobal('crypto', webcrypto);
    mocks.ticket.mockResolvedValue(ticket());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    const queue = new UploadQueue();
    queue.add([image()]);
    await waitFor(() => expect(queue.getSnapshot()[0]?.status).toBe('failed'));
    const id = queue.getSnapshot()[0]!.id;
    const firstKey = mocks.ticket.mock.calls[0]![1].idempotencyKey;
    queue.retry(id);
    await waitFor(() => expect(mocks.ticket).toHaveBeenCalledTimes(2));
    expect(mocks.ticket.mock.calls[1]![1].idempotencyKey).not.toBe(firstKey);
    expect(queue.getSnapshot()[0]?.attachment).toBeUndefined();
    queue.dispose();
  });
  it('cancels removed files and never restores them when a ticket completes late', async () => {
    let resolve!: (value: unknown) => void;
    mocks.ticket.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const queue = new UploadQueue();
    queue.add([image()]);
    const signal = mocks.ticket.mock.calls[0]![1].signal as AbortSignal;
    queue.remove(queue.getSnapshot()[0]!.id);
    expect(signal.aborted).toBe(true);
    resolve(ticket());
    await Promise.resolve();
    expect(queue.getSnapshot()).toEqual([]);
    queue.dispose();
  });
});
