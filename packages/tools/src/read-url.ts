import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import * as XLSX from "xlsx";
import { errorResult, text, type Tool, z } from "./shared.js";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 250_000;
const schema = z.object({ url: z.url().describe("Public HTTP(S) URL returned by the upload service") });

export const readUrl: Tool<z.output<typeof schema>> = {
  name: "read_url",
  description:
    "Read an uploaded URL. Supports text, images, PDF, DOCX, XLSX and CSV; private network addresses are rejected.",
  schema,
  risk: "read",
  requiresContext: false,
  async execute({ url }, ctx) {
    try {
      const response = await safeFetch(url, ctx?.signal);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) return errorResult({ code: "TOO_LARGE" }, "URL content exceeds 20 MB");
      const contentType =
        response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? "application/octet-stream";
      if (contentType.startsWith("image/")) {
        return {
          status: "ok",
          content: [{ type: "image", mimeType: contentType, data: Buffer.from(bytes).toString("base64") }],
          details: { url, contentType, size: bytes.byteLength },
        };
      }
      const extracted = await extractText(bytes, contentType, new URL(response.url).pathname);
      const truncated = extracted.length > MAX_TEXT;
      return {
        status: "ok",
        content: text(truncated ? `${extracted.slice(0, MAX_TEXT)}\n… content truncated` : extracted),
        details: { url, contentType, size: bytes.byteLength, truncated },
      };
    } catch (error) {
      return errorResult(error, error instanceof Error ? error.message : "Unable to read URL");
    }
  },
};

async function safeFetch(input: string, signal?: AbortSignal): Promise<Response> {
  let url = new URL(input);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await requirePublicUrl(url);
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(url, {
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status < 300 || response.status >= 400) {
      if (!response.ok) throw new Error(`URL returned HTTP ${response.status}`);
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_BYTES) throw new Error("URL content exceeds 20 MB");
      return response;
    }
    const location = response.headers.get("location");
    if (!location) throw new Error("URL redirect is missing a location");
    url = new URL(location, url);
  }
  throw new Error("URL has too many redirects");
}

async function requirePublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) URLs are supported");
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address)))
    throw new Error("Private network URLs are not allowed");
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  )
    return true;
  const mapped = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  const parts = mapped.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
  );
}

async function extractText(bytes: Uint8Array, contentType: string, pathname: string): Promise<string> {
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
  throw new Error(`Unsupported uploaded content type: ${contentType}`);
}
