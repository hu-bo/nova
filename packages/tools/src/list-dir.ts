import { context, errorResult, text, type Tool, z } from "./shared.js";
const schema = z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(8).optional() });
export const listDir: Tool<z.output<typeof schema>> = {
  name: "list_dir",
  description: "List workspace directory entries.",
  schema,
  risk: "read",
  async execute(input, ctx) {
    const path = input.path ?? "";
    const result = await context(ctx).fs.list(path, { depth: input.depth ?? 1 });
    if (!result.ok) return errorResult(result.error, `${result.error.code}: ${result.error.message}`);
    return {
      status: "ok",
      content: text(
        result.value.map((entry) => `${entry.kind === "dir" ? "[dir]" : "     "} ${entry.name}`).join("\n") ||
          "(empty)",
      ),
      details: { path, entries: result.value, depth: input.depth ?? 1 },
    };
  },
};
