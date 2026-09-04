import { UiEventSchema, type UiEvent } from "@nova/protocol";

export type StreamConnection = "connecting" | "open" | "reconnecting" | "closed";

interface StreamCallbacks {
  onConnection(connection: StreamConnection): void;
  onEvent(event: UiEvent): void;
  onOpen(): void;
  onResync(): Promise<void>;
  onRunEnd(): void;
}

export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

type EventSourceFactory = (url: string) => EventSourceLike;

interface OpenWaiter {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const EVENT_SOURCE_OPEN = 1;
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;

export class ConversationStream {
  private source: EventSourceLike | null = null;
  private openWaiter: OpenWaiter | null = null;
  private resyncTask: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private lastEventId: string | null = null;

  constructor(
    private readonly conversationId: string,
    private readonly callbacks: StreamCallbacks,
    private readonly createEventSource: EventSourceFactory = (url) => new EventSource(url),
    private readonly openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS,
  ) {}

  ensureConnected(): Promise<void> {
    if (this.resyncTask) return this.resyncTask.then(() => this.ensureConnected());
    if (this.source?.readyState === EVENT_SOURCE_OPEN) return Promise.resolve();
    if (!this.source) {
      try {
        this.openSource("connecting");
      } catch (error) {
        const cause = error instanceof Error ? error : new Error("无法创建实时消息流");
        this.callbacks.onEvent({ type: "error", code: "SSE_CONNECT_FAILED", message: cause.message });
        this.callbacks.onConnection("closed");
        return Promise.reject(cause);
      }
    }
    return this.waitForOpen();
  }

  close(reason = new Error("实时消息流已关闭")): void {
    this.generation += 1;
    this.clearReconnectTimer();
    this.disposeSource();
    this.rejectOpen(reason);
    this.callbacks.onConnection("closed");
  }

  private openSource(connection: Extract<StreamConnection, "connecting" | "reconnecting">): void {
    this.callbacks.onConnection(connection);
    const query = this.lastEventId ? `?after=${encodeURIComponent(this.lastEventId)}` : "";
    const source = this.createEventSource(
      `/api/conversations/${encodeURIComponent(this.conversationId)}/events${query}`,
    );
    this.source = source;

    source.onopen = () => {
      if (this.source !== source) return;
      this.callbacks.onConnection("open");
      this.callbacks.onOpen();
      this.resolveOpen();
    };
    source.onmessage = (message) => {
      if (this.source !== source) return;
      this.handleMessage(source, message);
    };
    source.onerror = () => {
      if (this.source !== source) return;
      this.callbacks.onConnection("reconnecting");
      // EventSource normally retries itself while CONNECTING, but a failed
      // fetch can also leave it CLOSED. In that state ensureConnected() would
      // wait on a dead source forever, so create a fresh subscription.
      if (source.readyState === 2) this.scheduleReconnect(source);
    };
  }

  private scheduleReconnect(source: EventSourceLike): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.source !== source || source.readyState === EVENT_SOURCE_OPEN) return;
      this.disposeSource();
      try {
        this.openSource("reconnecting");
      } catch (error) {
        const cause = error instanceof Error ? error : new Error("无法创建实时消息流");
        this.callbacks.onEvent({ type: "error", code: "SSE_CONNECT_FAILED", message: cause.message });
        this.callbacks.onConnection("closed");
        this.rejectOpen(cause);
      }
    }, 1_000);
  }

  private waitForOpen(): Promise<void> {
    if (this.source?.readyState === EVENT_SOURCE_OPEN) return Promise.resolve();
    if (this.openWaiter) return this.openWaiter.promise;

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const timer = setTimeout(() => {
      const error = new Error("实时消息流连接超时");
      this.callbacks.onEvent({ type: "error", code: "SSE_CONNECT_TIMEOUT", message: error.message });
      this.close(error);
    }, this.openTimeoutMs);
    this.openWaiter = { promise, resolve, reject, timer };
    return promise;
  }

  private handleMessage(source: EventSourceLike, message: MessageEvent<string>): void {
    // Advance past a malformed event as well. Otherwise reconnecting would replay the
    // same poison event forever and prevent a later run.end from reaching the UI.
    if (message.lastEventId) this.lastEventId = message.lastEventId;

    let event: UiEvent;
    try {
      event = UiEventSchema.parse(JSON.parse(message.data));
    } catch (error) {
      this.callbacks.onEvent({
        type: "error",
        code: "INVALID_SSE_EVENT",
        message: error instanceof Error ? error.message : "收到无效的实时消息",
      });
      return;
    }

    if (event.type === "error" && event.code === "RESYNC") {
      const task = this.resync(source);
      this.resyncTask = task;
      void task.finally(() => {
        if (this.resyncTask === task) this.resyncTask = null;
      });
      return;
    }

    this.callbacks.onEvent(event);
    if (event.type === "run.end") {
      this.callbacks.onRunEnd();
    }
  }

  private async resync(source: EventSourceLike): Promise<void> {
    if (this.source !== source) return;
    this.disposeSource();
    this.rejectOpen(new Error("实时消息流需要重新同步"));
    const generation = ++this.generation;
    this.callbacks.onConnection("reconnecting");

    try {
      // The server has told us that this cursor cannot be replayed anymore. Keeping it
      // would make every replacement stream request the same stale `after` value and
      // receive RESYNC forever (especially after the server/event hub restarts).
      this.lastEventId = null;
      await this.callbacks.onResync();
      if (this.generation !== generation) return;
      this.openSource("reconnecting");
      await this.waitForOpen();
    } catch (error) {
      if (this.generation !== generation) return;
      const message = error instanceof Error ? error.message : "实时消息重新同步失败";
      this.callbacks.onEvent({ type: "error", code: "RESYNC_FAILED", message });
      this.close(error instanceof Error ? error : undefined);
    }
  }

  private disposeSource(): void {
    const source = this.source;
    if (!source) return;
    this.source = null;
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    source.close();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private resolveOpen(): void {
    const waiter = this.openWaiter;
    if (!waiter) return;
    this.openWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve();
  }

  private rejectOpen(error: Error): void {
    const waiter = this.openWaiter;
    if (!waiter) return;
    this.openWaiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}
