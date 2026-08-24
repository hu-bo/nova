import { context, errorResult, text, type Tool, z } from "./shared.js";
const schema = z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() });
export const readFile: Tool<z.output<typeof schema>> = {
  name: "read_file",
  description: "Read a text file with one-based line slicing.",
  schema,
  risk: "read",
  async execute(input, ctx) {
    const result = await context(ctx).fs.read(input.path, { offset: input.offset, limit: input.limit });
    if (!result.ok) return errorResult(result.error, `${result.error.code}: ${result.error.message}`);
    const start = input.offset ?? 1;
    const lines = result.value.text.split("\n").map((line, index) => `${start + index}: ${line}`);
    return {
      status: "ok",
      content: text(`${lines.join("\n")}${result.value.truncated ? "\n… lines omitted" : ""}`),
      details: {
        path: input.path,
        offset: input.offset,
        limit: input.limit,
        totalLines: result.value.totalLines,
        truncated: result.value.truncated,
      },
    };
  },
};
