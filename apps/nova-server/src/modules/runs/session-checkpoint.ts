import { type SessionCommit, type SessionSnapshot } from "@nnova/harness";
import type { Checkpoint } from "./runtime-adapter.js";

export function checkpointAfter(checkpoint: Checkpoint, next: SessionSnapshot, batch: SessionCommit): Checkpoint {
  const updated: Checkpoint = {
    ...checkpoint,
    nativeState: {
      messages: next.messages,
      runs: next.runs.slice(-1),
      ...(next.summary ? { summary: next.summary } : {}),
    } as unknown as Checkpoint["nativeState"],
    executions: [...next.executions],
    reservedInputs: checkpoint.reservedInputs.filter(
      (input) => !batch.messages?.some((message) => message.id === input.messageId),
    ),
  };
  if (next.continuation !== undefined) updated.continuation = next.continuation;
  else delete updated.continuation;
  if (batch.run?.kind === "completed")
    updated.outcome = {
      kind: "completed",
      state: batch.run.status,
      ...(batch.run.error ? { reason: batch.run.error.code } : {}),
    };
  else if (batch.messages?.some((message) => message.role === "user")) delete updated.outcome;
  return updated;
}

/** Cache immutable subtrees so an execution transition never scans old message text. */
export function createJsonSizer() {
  const sizes = new WeakMap<object, number>();
  const size = (value: unknown): number => {
    if (!value || typeof value !== "object") return Buffer.byteLength(JSON.stringify(value) ?? "null");
    const known = sizes.get(value);
    if (known !== undefined) return known;
    const bytes = Array.isArray(value)
      ? 2 + Math.max(0, value.length - 1) + value.reduce((sum, item) => sum + size(item), 0)
      : 2 +
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .reduce(
            (sum, [key, item], index) =>
              sum + (index ? 1 : 0) + Buffer.byteLength(JSON.stringify(key)) + 1 + size(item),
            0,
          );
    sizes.set(value, bytes);
    return bytes;
  };
  return size;
}
