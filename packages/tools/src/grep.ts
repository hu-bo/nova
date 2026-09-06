import { context, errorResult, text, type Tool, z } from "./shared.js";
const schema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  maxResults: z.number().int().min(1).max(1_000).optional(),
});
export const grep: Tool<z.output<typeof schema>> = {
  name: "grep",
  description: "Search files with a regular expression.",
  schema,
  risk: "read",
  async execute(input, ctx) {
    const result = await context(ctx).fs.grep(input.pattern, {
      path: input.path,
      glob: input.glob,
      maxResults: input.maxResults,
    });
    if (!result.ok) return errorResult(result.error, `${result.error.code}: ${result.error.message}`);
    return {
      status: "ok",
      content: text(
        result.value.matches
          .slice(0, 50)
          .map((match) => `${match.file}:${match.line}: ${match.text}`)
          .join("\n") || "No matches",
      ),
      details: result.value,
    };
  },
};
