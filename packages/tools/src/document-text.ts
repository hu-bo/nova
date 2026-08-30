import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import * as XLSX from "xlsx";

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export async function extractDocumentText(bytes: Uint8Array, contentType: string, pathname: string): Promise<string> {
  const extension = pathname.toLowerCase().split(".").pop();
  const buffer = Buffer.from(bytes);
  if (contentType === "application/pdf" || extension === "pdf") {
    const parser = new PDFParse({ data: bytes });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  if (contentType.includes("wordprocessingml") || extension === "docx")
    return (await mammoth.extractRawText({ buffer })).value;
  if (
    contentType.includes("spreadsheetml") ||
    contentType.includes("excel") ||
    extension === "xlsx" ||
    extension === "xls"
  ) {
    const workbook = XLSX.read(buffer);
    return workbook.SheetNames.map((name) => `# ${name}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name]!)}`).join(
      "\n\n",
    );
  }
  if (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    ["md", "txt", "csv", "tsv", "json", "xml", "yaml", "yml"].includes(extension ?? "")
  )
    return buffer.toString("utf8");
  throw new Error(`Unsupported document type: ${contentType}`);
}

export function documentContentType(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  switch (extension) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "xls":
      return "application/vnd.ms-excel";
    case "csv":
      return "text/csv";
    default:
      return "application/octet-stream";
  }
}
