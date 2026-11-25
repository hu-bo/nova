import { randomUUID } from "node:crypto";
import {
  type ExecutionRecord,
  type MessagePart,
  type SessionCommit,
  type SessionSnapshot,
  type ToolCallResult,
} from "@nnova/harness";
import { nativeSnapshot, type Checkpoint } from "./runtime-adapter.js";

export function executionEffectState(executions: readonly ExecutionRecord[]) {
  const effects = executions.filter((entry) => entry.effects !== "read");
  return effects.some((entry) => !entry.result && entry.dispatch === "dispatched") ? "pending" : "known";
}

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
      ...(batch.run.budgetReason ? { reason: batch.run.budgetReason } : {}),
      ...(batch.run.error
        ? {
            reason: batch.run.error.code,
            ...(batch.run.error.detail ? { detail: batch.run.error.detail } : {}),
          }
        : {}),
    };
  else if (batch.messages?.some((message) => message.role === "user")) delete updated.outcome;
  return updated;
}

/** A suspended run has no live loop to close its accepted calls when cancellation wins. */
export function cancelPendingTools(
  checkpoint: Checkpoint,
  reason: "cancel" | "timeout" | "error" = "cancel",
  operations: import("@nova/agent-ui-contracts").ToolOperation[] = [],
): { checkpoint: Checkpoint; results: ToolCallResult[] } {
  if (checkpoint.backendId !== "nova") return { checkpoint, results: [] };
  const { continuation: _continuation, ...snapshot } = nativeSnapshot(checkpoint, 0);
  const pending = new Map<string, Extract<MessagePart, { type: "tool-call" }>>();
  for (const message of snapshot.messages)
    for (const part of message.parts) {
      if (part.type === "tool-call") pending.set(part.callId, part);
      if (part.type === "tool-result") pending.delete(part.callId);
    }
  const results = [...pending.values()].map((call): ToolCallResult => {
    const execution = snapshot.executions.findLast((entry) => entry.callId === call.callId);
    if (execution?.result) return execution.result;
    let error: { code: string; message: string };
    if (reason === "cancel") error = { code: "CANCELLED", message: "流程已取消。" };
    else if (reason === "timeout") error = { code: "TIMEOUT", message: "工具执行超时，操作已中断。" };
    else error = { code: "RUN_INTERRUPTED", message: "工具因运行异常而中断。" };
    const operation = execution && operations.find((item) => item.id === execution.executionId);
    const stdout = operation?.stdout?.text ?? "";
    const stderr = operation?.stderr?.text ?? "";
    return {
      executionId: execution?.executionId ?? randomUUID(),
      callId: call.callId,
      name: call.name,
      status: "failed",
      outcome: "known",
      error,
      value: {
        error,
        outcome: "known",
        ...(stdout || stderr
          ? { details: { stdout, stderr, outputGap: false, outputTruncated: false } }
          : {}),
      },
    };
  });
  const executions = snapshot.executions.map((entry) => {
    const result = results.find((item) => item.executionId === entry.executionId);
    return result ? { ...entry, result } : entry;
  });
  const messages: SessionSnapshot["messages"] = results.map((result) => ({
    id: result.executionId,
    role: "tool",
    parts: [
      {
        type: "tool-result",
        callId: result.callId,
        name: result.name,
        status: result.status,
        value: result.value ?? null,
      },
    ],
  }));
  return {
    checkpoint: checkpointAfter(
      checkpoint,
      { ...snapshot, executions, messages: [...snapshot.messages, ...messages] },
      { continuation: null },
    ),
    results,
  };
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
