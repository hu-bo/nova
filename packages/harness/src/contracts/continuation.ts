import type { JsonValue } from "./message.js";
import type { Schema } from "./plugin.js";
export interface TaskSignal {
  readonly taskId: string;
  readonly waitId: string;
  readonly eventId: string;
  readonly payload: JsonValue;
  readonly namespace?: string;
}
export interface WaitDefinition {
  readonly expiresAt: number;
  readonly inputSchema?: Schema<JsonValue>;
}
export type HandlerOutcome =
  { kind: "completed"; output: JsonValue } | { kind: "waiting"; waitId: string; state: JsonValue; expiresAt: number };
export interface SignalReceipt {
  status: "accepted" | "duplicate" | "ignored";
}
