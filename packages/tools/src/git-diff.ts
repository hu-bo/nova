import { context, errorResult, text, type Tool, z } from "./shared.js";
const schema = z.object({ path: z.string().optional(), staged: z.boolean().optional() });
export const gitDiff: Tool<z.output<typeof schema>> = {
  name: "git_diff",
  description: "Show the current Git diff.",
  schema,
  risk: "read",
  async execute(input, ctx) {
    const parameters = [
      "diff",
      ...(input.staged === true ? ["--staged"] : []),
      ...(input.path ? ["--", input.path] : []),
    ];
    const result = await context(ctx).exec("git", { args: parameters });
    if (!result.ok) return errorResult(result.error, `${result.error.code}: ${result.error.message}`);
    const content =
      result.value.stdout ||
      result.value.stderr ||
      (result.value.exitCode === 0 ? "No changes" : `git diff exited ${result.value.exitCode}`);
    return {
      status: result.value.exitCode === 0 ? "ok" : "error",
      content: text(content),
      details: { ...result.value, path: input.path ?? null, staged: input.staged === true },
    };
  },
};
