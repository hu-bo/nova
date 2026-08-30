import { documentContentType, extractDocumentText, MAX_DOCUMENT_BYTES } from "./document-text.js";
import { context, errorResult, text, type Tool, z } from "./shared.js";

const MAX_TEXT = 250_000;
const schema = z.object({ path: z.string().describe("PDF, DOCX, XLSX, XLS, or CSV file in the workspace") });

export const readDocument: Tool<z.output<typeof schema>> = {
  name: "read_document",
  description:
    "Extract readable text from a workspace document (PDF, DOCX, XLSX, XLS, or CSV). Use this instead of read_file for binary documents.",
  schema,
  risk: "read",
  async execute({ path }, ctx) {
    const fs = context(ctx).fs;
    const info = await fs.stat(path);
    if (!info.ok) return errorResult(info.error, `${info.error.code}: ${info.error.message}`);
    if (info.value.kind !== "file") return errorResult({ code: "NOT_FILE", path }, `${path} is not a file`);
    if (info.value.size > MAX_DOCUMENT_BYTES)
      return errorResult({ code: "TOO_LARGE", path, size: info.value.size }, "Document exceeds 20 MB");

    const result = await fs.readBytes(path);
    if (!result.ok) return errorResult(result.error, `${result.error.code}: ${result.error.message}`);
    try {
      const extracted = await extractDocumentText(result.value, documentContentType(path), path);
      const truncated = extracted.length > MAX_TEXT;
      return {
        status: "ok",
        content: text(truncated ? `${extracted.slice(0, MAX_TEXT)}\n… content truncated` : extracted),
        details: { path, size: info.value.size, truncated },
      };
    } catch (error) {
      return errorResult(error, error instanceof Error ? error.message : "Unable to read document");
    }
  },
};
