// §4.3 Hooks —— Turn 之间可变的状态只有三个：model / thinkingLevel / activeTools。
import type { ThinkingLevel } from "@nova/model-adapters";
import type { AgentToolResult, Risk, ToolCall } from "../types.js";

export interface AgentHooks {
  beforeToolCall?(call: ToolCall & { risk: Risk }, signal: AbortSignal): "allow" | "ask" | "deny" | undefined | Promise<"allow" | "ask" | "deny" | undefined>;
  afterToolCall?(call: ToolCall, result: AgentToolResult<unknown>): void | Promise<void>;
  shouldStopAfterTurn?(): boolean;
  prepareNextTurn?(): { model?: string; thinkingLevel?: ThinkingLevel; activeTools?: string[] } | void;
}
