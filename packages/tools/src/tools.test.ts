import { expect, it } from "vitest";
import type { ToolContext } from "@nova/agent-core";
import { bash } from "./bash.js";
import { editFile } from "./edit-file.js";
import { readDocument } from "./read-document.js";
import { readFile } from "./read-file.js";
import { readUrl } from "./read-url.js";
import * as XLSX from "xlsx";

it("maps Runner failures and non-zero command exits to error", async () => {
  const runnerFailure = await bash.execute(
    { command: "test" },
    ctx({ ok: false, error: { code: "RUNNER_UNAVAILABLE", message: "offline" } }),
  );
  expect(runnerFailure.status).toBe("error");
  expect(runnerFailure.details).toMatchObject({ code: "RUNNER_UNAVAILABLE" });

  const nonZero = await bash.execute(
    { command: "test" },
    ctx({ ok: true, value: { exitCode: 2, stdout: "", stderr: "failed", truncated: false, durationMs: 1 } }),
  );
  expect(nonZero.status).toBe("error");
  expect(nonZero.details).toMatchObject({ exitCode: 2 });
});

it("reports edit semantic failures explicitly", async () => {
  const runtime = ctx({ ok: true, value: { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1 } });
  runtime.fs.read = async () => ({ ok: true, value: { text: "hello", totalLines: 1, truncated: false } });
  const result = await editFile.execute({ path: "a.txt", oldText: "missing", newText: "new" }, runtime);
  expect(result.status).toBe("error");
  expect(result.details).toMatchObject({ reason: "not_found" });
});

it("rejects private URLs before fetching attachment content", async () => {
  const result = await readUrl.execute({ url: "http://127.0.0.1/private.txt" });
  expect(result.status).toBe("error");
  expect(result.content).toEqual([{ type: "text", text: "Private network URLs are not allowed" }]);
});

it("rejects binary content from read_file", async () => {
  const runtime = ctx({ ok: true, value: { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1 } });
  runtime.fs.readBytes = async () => ({ ok: true, value: new TextEncoder().encode("%PDF-1.7") });
  const result = await readFile.execute({ path: "report.pdf" }, runtime);
  expect(result.status).toBe("error");
  expect(result.details).toMatchObject({ code: "BINARY_FILE", path: "report.pdf" });
});

it("extracts workbook sheets through read_document", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["name", "score"],
      ["Ada", 10],
    ]),
    "Results",
  );
  const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
  const runtime = ctx({ ok: true, value: { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1 } });
  runtime.fs.stat = async () => ({
    ok: true,
    value: { path: "scores.xlsx", kind: "file", size: bytes.byteLength, mtime: 0 },
  });
  runtime.fs.readBytes = async () => ({ ok: true, value: bytes });
  const result = await readDocument.execute({ path: "scores.xlsx" }, runtime);
  expect(result.status).toBe("ok");
  expect(result.content).toEqual([{ type: "text", text: "# Results\nname,score\nAda,10" }]);
});

function ctx(execResult: Awaited<ReturnType<ToolContext["exec"]>>): ToolContext {
  const unavailable = async () => ({ ok: false as const, error: { code: "IO" as const, message: "unused" } });
  return {
    cwd: "/workspace",
    signal: new AbortController().signal,
    exec: async () => execResult,
    fs: {
      read: unavailable,
      readBytes: unavailable,
      write: unavailable,
      rename: unavailable,
      remove: unavailable,
      mkdir: unavailable,
      list: unavailable,
      stat: unavailable,
      tempDir: unavailable,
      grep: unavailable,
    } as ToolContext["fs"],
  };
}
