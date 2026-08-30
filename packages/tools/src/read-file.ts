import { context, errorResult, text, type Tool, z } from "./shared.js";
const schema = z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() });
export const readFile: Tool<z.output<typeof schema>> = {
  name: "read_file",
  description:
    "Read a UTF-8 text file with one-based line slicing. Do not use for PDF, Office, or other binary files; use read_document.",
  schema,
  risk: "read",
  async execute(input, ctx) {
    const result = await context(ctx).fs.readBytes(input.path);
    if (!result.ok) return errorResult(result.error, `${result.error.code}: ${result.error.message}`);
    let source: string;
    try {
      source = decodeTextFile(input.path, result.value);
    } catch (error) {
      return errorResult(
        { code: "BINARY_FILE", path: input.path },
        "Binary file; use read_document for PDF or Office documents",
      );
    }
    const start = input.offset ?? 1;
    const allLines = source.split("\n");
    const end = input.limit === undefined ? allLines.length : Math.min(allLines.length, start - 1 + input.limit);
    const lines = allLines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`);
    return {
      status: "ok",
      content: text(`${lines.join("\n")}${end < allLines.length ? "\n… lines omitted" : ""}`),
      details: {
        path: input.path,
        offset: input.offset,
        limit: input.limit,
        totalLines: allLines.length,
        truncated: end < allLines.length,
      },
    };
  },
};

function decodeTextFile(path: string, bytes: Uint8Array): string {
  if (isKnownBinaryPath(path) || isBinarySignature(bytes) || bytes.includes(0)) throw new Error("binary file");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isKnownBinaryPath(path: string): boolean {
  const extension = path.toLowerCase().split(".").pop();
  return ["pdf", "doc", "docx", "xls", "xlsx", "zip", "gz", "png", "jpg", "jpeg", "gif", "webp"].includes(
    extension ?? "",
  );
}

function isBinarySignature(bytes: Uint8Array): boolean {
  const header = new TextDecoder().decode(bytes.slice(0, 5));
  return header === "%PDF-" || (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04);
}
