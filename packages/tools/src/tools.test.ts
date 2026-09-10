import { expect, it } from "vitest";
import { createAgent, memoryStorage, type ToolContext } from "@nova/agent-core";
import { bash, bashRisk } from "./bash.js";
import { editFile } from "./edit-file.js";
import { grep } from "./grep.js";
import { listDir } from "./list-dir.js";
import { readDocument } from "./read-document.js";
import { readFile } from "./read-file.js";
import { readUrl } from "./read-url.js";
import * as XLSX from "xlsx";
import { z } from "./shared.js";

it("describes the direct-executable and explicit-shell bash calling conventions to the model", () => {
  const parameters = z.toJSONSchema(bash.schema) as {
    properties?: Record<string, { description?: string }>;
  };

  expect(bash.description).toContain("{command: `pnpm`, args:");
  expect(bash.description).toContain("{command: `sh`, args: [`-lc`");
  expect(parameters.properties?.command?.description).toContain("single executable");
  expect(parameters.properties?.args?.description).toContain("one array item per argument");
  expect(parameters.properties?.cwd?.description).toContain("Prefer this over putting `cd`");
  expect(parameters.properties?.timeoutMs?.description).toContain("10000 (10 seconds)");
  expect(parameters.properties?.timeoutMs?.description).toContain("explicitly set");
});

it.each([undefined, 300_000])("uses the default or explicit bash execution timeout (%s)", async (timeoutMs) => {
  const output = {
    ok: true as const,
    value: { exitCode: 0, stdout: "done", stderr: "", truncated: false, durationMs: 1 },
  };
  const runtime = ctx(output);
  const input = bash.schema.parse({ command: "pnpm", args: ["test"], cwd: "/workspace/app", timeoutMs });
  let called = false;
  runtime.exec = async (command, options) => {
    called = true;
    expect(command).toBe("pnpm");
    expect(options).toEqual({ args: ["test"], cwd: "/workspace/app", timeoutMs: timeoutMs ?? 10_000 });
    return output;
  };
  expect((await bash.execute(input, runtime)).status).toBe("ok");
  expect(called).toBe(true);
  expect(bash.timeoutMs?.(input)).toBe((timeoutMs ?? 10_000) + 5_000);
});

it("rejects timeout values that disable the execution limit or overflow the call timer", () => {
  for (const timeoutMs of [0, -1, 1.5, Infinity, 2_147_478_648]) {
    expect(bash.schema.safeParse({ command: "pnpm", timeoutMs }).success).toBe(false);
  }
});

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

it("classifies direct read-only bash queries without relaxing shell or mutating commands", () => {
  for (const command of ["ls", "/usr/bin/find", "WHICH.EXE", "pwd", "rg", "tree"]) {
    expect(bashRisk({ command })).toBe("read");
  }
  expect(bashRisk({ command: "git", args: ["status", "--short"] })).toBe("read");
  expect(bashRisk({ command: "git", args: ["commit", "-m", "change"] })).toBe("exec");
  expect(bashRisk({ command: "find", args: [".", "-delete"] })).toBe("exec");
  expect(bashRisk({ command: "tree", args: ["-o", "tree.txt"] })).toBe("exec");
  expect(bashRisk({ command: "rg", args: ["--pre", "generator"] })).toBe("exec");
  expect(bashRisk({ command: "git", args: ["diff", "--output=changes.patch"] })).toBe("exec");
  expect(bashRisk({ command: "sh", args: ["-c", "ls"] })).toBe("exec");
  expect(bashRisk({ command: "powershell.exe", args: ["Get-ChildItem"] })).toBe("exec");
});

it("classifies a standalone sh cd as read-only, including literal quoted paths", () => {
  for (const script of [
    "cd /xxx",
    "cd ../app",
    "cd /项目",
    "cd",
    "cd ~",
    "cd -- /xxx",
    " cd\t/xxx ",
    "cd '/my project'",
    'cd "/my project"',
  ]) {
    for (const flag of ["-c", "-lc"]) {
      expect(bashRisk({ command: "/bin/sh", args: [flag, script] }), script).toBe("read");
    }
  }
});

it("keeps compound cd scripts, expansions and extra shell arguments subject to approval", () => {
  for (const script of [
    "cd /xxx && touch file",
    "cd /xxx; touch file",
    "cd /xxx\ntouch file",
    "cd /xxx | tee file",
    "cd /xxx > file",
    "cd /xxx &",
    "cd $(touch file)",
    'cd "$(touch file)"',
    "cd `touch file`",
    'cd "$HOME"',
    "cd /xxx\\\n; touch file",
    "cd /xxx /yyy",
    "CD /xxx",
    "cd '/xxx",
    'cd "/xxx',
  ]) {
    expect(bashRisk({ command: "sh", args: ["-lc", script] }), script).toBe("exec");
  }
  expect(bashRisk({ command: "sh", args: ["-lc", "cd /xxx", "extra"] })).toBe("exec");
  expect(bashRisk({ command: "sh", args: ["-lC", "cd /xxx"] })).toBe("exec");
});

it("executes sh -lc cd under the default policy without requesting user approval", async () => {
  const input = { command: "sh", args: ["-lc", "cd /xxx"] };
  const output = { ok: true as const, value: { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1 } };
  const runtime = ctx(output);
  let executions = 0;
  let approvals = 0;
  runtime.exec = async (command, options) => {
    executions++;
    expect(command).toBe(input.command);
    expect(options?.args).toEqual(input.args);
    return output;
  };
  let turns = 0;
  const agent = createAgent({
    model: { provider: "gateway", model: "test-model" },
    storage: memoryStorage(),
    ctx: runtime,
    tools: [bash],
    decide: async () => {
      approvals++;
      return { kind: "approval", decision: "deny" };
    },
    stream: async function* () {
      if (turns++ === 0) {
        yield { type: "block.start", index: 0, blockType: "tool_call" };
        yield { type: "block.end", index: 0, block: { type: "tool_call", callId: "cd", name: "bash", args: input } };
        yield { type: "finish", stopReason: "tool_use" };
      } else {
        yield { type: "finish", stopReason: "stop" };
      }
    },
  });
  expect((await agent.prompt("change directory")).stopReason).toBe("done");
  expect(executions).toBe(1);
  expect(approvals).toBe(0);
});

it("reports edit semantic failures explicitly", async () => {
  const runtime = ctx({ ok: true, value: { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1 } });
  runtime.fs.read = async () => ({
    ok: true,
    value: {
      text: "hello",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      totalSize: 5,
      truncated: false,
      lineTruncated: false,
    },
  });
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

it("uses Runner-side bounded line reads", async () => {
  const runtime = ctx({ ok: true, value: { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1 } });
  runtime.fs.read = async (path, opts) => {
    expect(path).toBe("large.log");
    expect(opts).toEqual({ offset: 500, limit: 25 });
    return {
      ok: true,
      value: {
        text: "alpha\nbeta\n",
        startLine: 500,
        endLine: 501,
        totalSize: 50_000_000,
        truncated: true,
        lineTruncated: false,
      },
    };
  };

  const result = await readFile.execute({ path: "large.log", offset: 500, limit: 25 }, runtime);

  expect(result.content).toEqual([
    { type: "text", text: "500: alpha\n501: beta\n… more content available from line 502" },
  ]);
  expect(result.details).toMatchObject({ totalSize: 50_000_000, truncated: true });
});

it("preserves grep truncation facts and list depth", async () => {
  const runtime = ctx({ ok: true, value: { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1 } });
  runtime.fs.grep = async () => ({
    ok: true,
    value: { matches: [{ file: "src/a.ts", line: 3, text: "needle" }], total: 2, truncated: true },
  });
  runtime.fs.list = async (_path, opts) => {
    expect(opts).toEqual({ depth: 3 });
    return { ok: true, value: [{ name: "src/a.ts", kind: "file" }] };
  };

  const grepResult = await grep.execute({ pattern: "needle" }, runtime);
  const listResult = await listDir.execute({ depth: 3 }, runtime);

  expect(grepResult.details).toMatchObject({ total: 2, truncated: true });
  expect(listResult.status).toBe("ok");
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
