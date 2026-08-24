import { context, errorResult, text, type Tool, z } from "./shared.js";
const schema = z.object({ path: z.string(), content: z.string() });
export const writeFile: Tool<z.output<typeof schema>> = {
  name: "write_file",
  description: "Write a complete text file.",
  schema,
  risk: "write",
  executionMode: "sequential",
  async execute(input, ctx) {
    const runtime = context(ctx);
    const before = await runtime.fs.stat(input.path);
    const result = await runtime.fs.write(input.path, input.content);
    if (!result.ok) return errorResult(result.error, `${result.error.code}: ${result.error.message}`);
    return {
      status: "ok",
      content: text(`Wrote ${input.content.split("\n").length} lines to ${input.path}`),
      details: {
        path: input.path,
        bytes: new TextEncoder().encode(input.content).length,
        created: !before.ok && before.error.code === "NOT_FOUND",
        previous: before.ok ? before.value : null,
      },
    };
  },
};
