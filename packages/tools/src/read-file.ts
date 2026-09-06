import { context, errorResult, text, type Tool, z } from "./shared.js";
const DEFAULT_LIMIT = 200;
const schema = z.object({
  path: z.string(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(2_000).optional(),
});
export const readFile: Tool<z.output<typeof schema>> = {
  name: "read_file",
  description:
    "Read a UTF-8 text file with one-based line slicing. Do not use for PDF, Office, or other binary files; use read_document.",
  schema,
  risk: "read",
  async execute(input, ctx) {
    if (isKnownBinaryPath(input.path)) {
      return errorResult(
        { code: "BINARY_FILE", path: input.path },
        "Binary file; use read_document for PDF or Office documents",
      );
    }
    const result = await context(ctx).fs.read(input.path, {
      offset: input.offset ?? 1,
      limit: input.limit ?? DEFAULT_LIMIT,
    });
    if (!result.ok) return errorResult(result.error, `${result.error.code}: ${result.error.message}`);
    const lines = result.value.text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const numbered = lines.map((line, index) => `${result.value.startLine + index}: ${line}`).join("\n");
    const markers = [
      result.value.lineTruncated ? "… line content truncated at the Runner byte limit" : "",
      result.value.truncated ? `… more content available from line ${result.value.endLine + 1}` : "",
    ].filter(Boolean);
    return {
      status: "ok",
      content: text([numbered || "(empty)", ...markers].join("\n")),
      details: {
        path: input.path,
        ...result.value,
      },
    };
  },
};

function isKnownBinaryPath(path: string): boolean {
  const extension = path.toLowerCase().split(".").pop();
  return ["pdf", "doc", "docx", "xls", "xlsx", "zip", "gz", "png", "jpg", "jpeg", "gif", "webp"].includes(
    extension ?? "",
  );
}
