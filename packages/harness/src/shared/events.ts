import { FrameworkError } from "../contracts/errors.js";
export class EventStream<T> {
  private readonly history: T[] = [];
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private closed = false;
  constructor(private readonly capacity = 128) {}
  get oldestSequence(): number {
    return this.sequence - this.history.length + 1;
  }
  get latestSequence(): number {
    return this.sequence;
  }
  publish(event: T): void {
    if (this.closed) return;
    this.history.push(structuredClone(event));
    this.sequence++;
    if (this.history.length > this.capacity) this.history.shift();
    for (const notify of [...this.listeners]) notify();
  }
  close(): void {
    this.closed = true;
    for (const notify of [...this.listeners]) notify();
  }
  async *read(): AsyncIterable<T> {
    yield* this.readFrom(this.sequence - this.history.length);
  }
  async *readFrom(afterSequence: number): AsyncIterable<T> {
    let cursor = Math.max(0, afterSequence);
    let wake: (() => void) | undefined;
    const notify = () => wake?.();
    this.listeners.add(notify);
    try {
      while (true) {
        const first = this.sequence - this.history.length;
        if (cursor < first)
          throw new FrameworkError("EVENTS_EXPIRED", "Event reader fell behind the retention window.");
        const batch = this.history.slice(cursor - first);
        if (batch.length) {
          for (const value of batch) {
            cursor++;
            yield structuredClone(value);
          }
          continue;
        }
        if (this.closed) return;
        const ready = new Promise<void>((resolve) => {
          wake = resolve;
        });
        await ready;
      }
    } finally {
      this.listeners.delete(notify);
    }
  }
}
