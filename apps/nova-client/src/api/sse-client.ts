import { expireAuth, getAuthToken, refreshAuth, retryAfterSeconds } from './transport';
export type SseConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';
export type SseFrame = { eventId: string; eventName: string; data: unknown };

// Line-oriented parsing preserves CR/LF pairs split between network chunks.
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private eventName = 'message';
  private eventId = '';
  private frameSize = 0;
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const end = this.buffer.search(/[\r\n]/);
      if (end < 0 || (this.buffer[end] === '\r' && end === this.buffer.length - 1)) break;
      const line = this.buffer.slice(0, end);
      const width = this.buffer[end] === '\r' && this.buffer[end + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(end + width);
      this.frameSize += new TextEncoder().encode(line).byteLength + width;
      if (this.frameSize > 4 * 1024 * 1024) throw new Error('SSE_FRAME_TOO_LARGE');
      if (!line) {
        if (this.data.length) {
          const raw = this.data.join('\n');
          let data: unknown = raw;
          try {
            data = JSON.parse(raw);
          } catch {
            /* SSE also permits non-JSON data. */
          }
          frames.push({ eventId: this.eventId, eventName: this.eventName, data });
        }
        this.data = [];
        this.eventName = 'message';
        this.frameSize = 0;
        continue;
      }
      if (line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.data.push(value);
      if (field === 'event') this.eventName = value || 'message';
      if (field === 'id' && !value.includes('\0')) this.eventId = value;
    }
    if (new TextEncoder().encode(this.buffer).byteLength + this.frameSize > 4 * 1024 * 1024)
      throw new Error('SSE_FRAME_TOO_LARGE');
    return frames;
  }
}
export type SseConnectionOptions = {
  url: string;
  cursor: string;
  onFrame(frame: SseFrame): string | undefined;
  onStateChange(state: SseConnectionState): void;
  onSnapshotRequired(): Promise<string>;
  onError?(error: { status: number; retryAfterSeconds?: number | undefined }): void;
  heartbeatTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  checkReady?(signal: AbortSignal): Promise<boolean>;
};
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
export class SseConnection {
  private readonly lifetime = new AbortController();
  private attemptController: AbortController | null = null;
  private cursor: string;
  private state: SseConnectionState = 'connecting';
  private retryAfter = 0;
  private healthy = false;
  private refreshed = false;
  constructor(private readonly options: SseConnectionOptions) {
    this.cursor = options.cursor;
    void this.open();
  }
  shutdown(): void {
    this.lifetime.abort();
    this.attemptController?.abort();
  }
  currentState(): SseConnectionState {
    return this.state;
  }
  private transition(state: SseConnectionState) {
    this.state = state;
    this.options.onStateChange(state);
  }
  private async open() {
    let failures = 0;
    while (!this.lifetime.signal.aborted) {
      this.transition(failures ? 'reconnecting' : 'connecting');
      let result: 'retry' | 'fatal' | 'resync' = 'retry';
      try {
        result = await this.streamOnce();
      } catch {
        /* Interrupted streams resume from the last applied cursor. */
      }
      if (this.lifetime.signal.aborted) return;
      if (result === 'fatal') break;
      if (result === 'resync') {
        try {
          this.cursor = await this.options.onSnapshotRequired();
        } catch {
          break;
        }
      }
      if (this.healthy) {
        failures = 0;
        this.healthy = false;
      }
      failures += 1;
      if (failures >= 7) break;
      const ready = this.options.checkReady
        ? await this.options.checkReady(this.lifetime.signal).catch(() => false)
        : true;
      const backoff = Math.max(
        this.retryAfter,
        Math.min(30000, (ready ? 1 : 2) * 1000 * 2 ** (failures - 1)) *
          (0.85 + Math.random() * 0.3),
      );
      await delay(backoff, this.lifetime.signal);
      this.retryAfter = 0;
    }
    if (!this.lifetime.signal.aborted) this.transition('offline');
  }
  private async streamOnce(): Promise<'retry' | 'fatal' | 'resync'> {
    const controller = new AbortController();
    this.attemptController = controller;
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const headers = new Headers({ accept: 'text/event-stream' });
    const token = getAuthToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    const url = new URL(this.options.url, window.location.origin);
    // Current server query cursors are decimal strings; Last-Event-ID carries the same cursor.
    url.searchParams.set('cursor', this.cursor.split(':').at(-1) ?? '0');
    headers.set(
      'last-event-id',
      url.pathname.split('/').at(-2) + ':' + (this.cursor.split(':').at(-1) ?? '0'),
    );
    const headerTimeout = setTimeout(() => controller.abort(), 30000);
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, {
        headers,
        signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } finally {
      clearTimeout(headerTimeout);
    }
    if (signal.aborted) return 'fatal';
    if (!response.ok) {
      const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
      this.options.onError?.({ status: response.status, retryAfterSeconds: retryAfter });
      if (response.status === 410) return 'resync';
      if (response.status === 401) {
        if (this.refreshed) {
          expireAuth();
          return 'fatal';
        }
        this.refreshed = true;
        return (await refreshAuth()) ? 'retry' : 'fatal';
      }
      if ([403, 404].includes(response.status)) return 'fatal';
      if (response.status === 429) {
        if (retryAfter === undefined) return 'fatal';
        this.retryAfter = retryAfter * 1000;
      }
      return 'retry';
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
      return 'fatal';
    this.refreshed = false;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const connectedAt = Date.now();
    let watchdog: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(), this.options.heartbeatTimeoutMs ?? 45000);
    };
    this.transition('live');
    arm();
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return 'retry';
        arm();
        if (Date.now() - connectedAt >= 30000) this.healthy = true;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const cursor = this.options.onFrame(frame);
          if (cursor !== undefined) this.cursor = cursor;
          if (signal.aborted) return 'fatal';
        }
      }
    } finally {
      clearTimeout(watchdog!);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return 'retry';
  }
}
