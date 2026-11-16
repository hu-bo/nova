import type { SafeError } from "./errors.js";
import type { JsonValue } from "./message.js";
export type TerminalStatus = "succeeded" | "budget_exhausted" | "failed" | "cancelled" | "timed_out";
export type BudgetReason = "STEP_LIMIT" | "TOOL_LIMIT";
export interface UsageSummary {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
}
export interface ToolCallResult {
  name: string;
  callId: string;
  executionId: string;
  status: "succeeded" | "failed";
  outcome?: "known" | "unknown";
  value?: JsonValue;
  error?: SafeError;
}
export interface CompletedRunResult {
  kind: "completed";
  sessionId: string;
  runId: string;
  status: TerminalStatus;
  text: string;
  toolCalls: readonly ToolCallResult[];
  usage: UsageSummary;
  budgetReason?: BudgetReason;
  error?: SafeError;
}
export interface SuspendedRunResult {
  kind: "suspended";
  sessionId: string;
  runId: string;
  status: "waiting_input" | "waiting_external";
  continuationId: string;
  text: string;
  toolCalls: readonly ToolCallResult[];
  usage: UsageSummary;
  error?: never;
}
export type RunResult = CompletedRunResult | SuspendedRunResult;
