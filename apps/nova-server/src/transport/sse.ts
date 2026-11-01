import type { FastifyReply } from "fastify";
import type { ProductEvent } from "@nova/agent-ui-contracts";
export type SseAdapterConfig = { heartbeatMs: number; queueFrames: number; queueBytes: number };
export type SseEnvelope = { eventId: string; sequence: string; type: string; data: ProductEvent };
export function formatSseFrame(envelope: SseEnvelope) {
  return "id: " + envelope.eventId + "\nevent: " + envelope.type + "\ndata: " + JSON.stringify(envelope.data) + "\n\n";
}
export class SseSubscriber {
  private closed = false;
  private readonly controller = new AbortController();
  private queuedFrames = 0;
  lastSequence = "0";
  constructor(
    private readonly reply: FastifyReply,
    private readonly config: SseAdapterConfig,
    private readonly heartbeat: NodeJS.Timeout,
  ) {}
  signal(): AbortSignal {
    return this.controller.signal;
  }
  isClosed() {
    return this.closed;
  }
  send(envelope: SseEnvelope) {
    if (this.closed) return false;
    const frame = formatSseFrame(envelope);
    try {
      if (!this.reply.raw.writableLength) this.queuedFrames = 0;
      if (
        this.reply.raw.writableLength + Buffer.byteLength(frame) > this.config.queueBytes ||
        this.queuedFrames >= this.config.queueFrames
      ) {
        this.close();
        return false;
      }
      this.reply.raw.write(frame);
      this.queuedFrames++;
      this.lastSequence = envelope.sequence;
      return true;
    } catch {
      this.close();
      return false;
    }
  }
  sendComment(text: string) {
    if (!this.closed)
      try {
        this.reply.raw.write(": " + text + "\n\n");
      } catch {
        this.close();
      }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    clearInterval(this.heartbeat);
    try {
      this.reply.raw.end();
    } catch {
      /* Connection already closed. */
    }
  }
}
