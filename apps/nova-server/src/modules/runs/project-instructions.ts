import type { z } from "zod";
import type { bindingSchema } from "../projects/index.js";
import type { ToolContext } from "@nova/runner-sdk";

export async function resolveProjectInstructions(
  config: z.infer<typeof bindingSchema>["instructions"] | undefined,
  createContext: (signal: AbortSignal) => Promise<ToolContext>,
  signal: AbortSignal,
): Promise<string> {
  const source = config?.source ?? (config?.customPrompt ? "custom" : "none");
  if (source === "none") return "";
  if (source === "custom") return config?.customPrompt ?? "";
  const filename = source === "agents" ? "AGENTS.md" : "CLAUDE.md";
  signal.throwIfAborted();
  const instructionSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  try {
    const context = await createContext(instructionSignal);
    const file = await context.fs.read(filename, { limit: 2000, signal: instructionSignal });
    signal.throwIfAborted();
    if (instructionSignal.aborted || !file.ok) return "";
    if (file.value.truncated || file.value.lineTruncated || file.value.text.length > 32000) return "";
    return file.value.text;
  } catch {
    // Optional project instructions must not block a run; user cancellation still wins.
    signal.throwIfAborted();
    return "";
  }
}
