import { context, errorResult, text, type Tool, z } from "./shared.js";
const schema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
});
export const bash: Tool<z.output<typeof schema>> = {
  name: "bash",
  description: "Run a command in the workspace.",
  schema,
  risk: "exec",
  async execute(input, ctx) {
    const result = await context(ctx).exec(input.command, {
      args: input.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
    });
    if (!result.ok) return errorResult(result.error, `${result.error.code}: ${result.error.message}`);
    const { value } = result;
    const content = [value.stdout, value.stderr].filter(Boolean).join("\n") || `(command exited ${value.exitCode})`;
    return { status: value.exitCode === 0 ? "ok" : "error", content: text(content), details: value };
  },
};
