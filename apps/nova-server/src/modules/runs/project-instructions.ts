import type { z } from "zod";
import type { bindingSchema } from "../projects/index.js";
import type { ToolContext } from "@nova/runner-sdk";
import { DomainError } from "../../shared/domain-error.js";

export async function resolveProjectInstructions(
  config: z.infer<typeof bindingSchema>["instructions"] | undefined,
  createContext: () => Promise<ToolContext>,
  signal: AbortSignal,
): Promise<string> {
  const source = config?.source ?? (config?.customPrompt ? "custom" : "none");
  if (source === "none") return "";
  if (source === "custom") return config?.customPrompt ?? "";
  const filename = source === "agents" ? "AGENTS.md" : "CLAUDE.md";
  let context: ToolContext;
  try {
    context = await createContext();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof DomainError && error.details?.reason === "RUNNER_OFFLINE")
      return `Project instructions are configured in ${filename}. Before any other workspace operation, use read_file to read this file and follow its instructions. If the tool fails, explain the failure to the user and stop workspace operations.`;
    throw error;
  }
  const file = await context.fs.read(filename, { limit: 2000, signal });
  signal.throwIfAborted();
  if (!file.ok) throw new DomainError("CONFLICT", `无法读取工作目录中的 ${filename}，请检查文件或更改项目指令来源。`);
  if (file.value.truncated || file.value.lineTruncated || file.value.text.length > 32000)
    throw new DomainError("CONFLICT", `${filename} 超出项目指令限制（32000 字符、2000 行）。`);
  return file.value.text;
}
