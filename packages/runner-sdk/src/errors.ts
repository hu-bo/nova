import type { RunnerFailure } from "@nova/runner-protocol";
import type { Result } from "./types.js";

export function failure<T = never>(
  code: string,
  message: string,
  outcome: RunnerFailure["outcome"] = "known",
  operationId?: string,
  details?: RunnerFailure["details"],
): Result<T> {
  return {
    ok: false,
    error: {
      code,
      message: safeMessage(message),
      outcome,
      ...(operationId ? { operationId } : {}),
      ...(details ? { details } : {}),
    },
  };
}

export function safeMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(token|api[_-]?key|secret)=\S+/gi, "$1=[redacted]")
    .slice(0, 1_024);
}

export function asUnsigned(value: unknown, field: string): number {
  const converted = typeof value === "string" ? Number(value) : Number(value ?? 0);
  if (!Number.isSafeInteger(converted) || converted < 0)
    throw new TypeError(`${field} exceeds JavaScript's safe integer range`);
  return converted;
}

export function messageBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255))
    return Uint8Array.from(value);
  throw new TypeError("WebSocket message is not a Protobuf binary frame");
}
