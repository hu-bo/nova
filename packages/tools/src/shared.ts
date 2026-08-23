import { z, type AgentTool, type AgentToolResult, type ContentPart, type ToolContext } from "@nova/agent-core";
export { z };
export type Tool<A = unknown, D = unknown> = AgentTool<A, D>;
export const text = (value: string): ContentPart[] => [{ type: "text", text: value }];
export function context(ctx: ToolContext | undefined): ToolContext { if (!ctx) throw new Error("This tool requires a project workspace"); return ctx; }
export function errorResult(details: unknown, message?: string): AgentToolResult<unknown> {
  const fallback = details && typeof details === "object" && "message" in details ? String((details as { message: unknown }).message) : String(details);
  return { status: "error", content: text(message ?? fallback), details };
}
