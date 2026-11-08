import { AsyncLocalStorage } from "node:async_hooks";
import { basename, posix } from "node:path";
import { defineTool, ToolFailureError, type JsonValue, type ToolDefinition } from "@nnova/harness";
import type { ToolContext as RunnerToolContext } from "@nova/runner-sdk";
import { formatPatch, structuredPatch } from "diff";
import { z } from "zod";

export interface RemoteToolContext {
  readonly fs: RunnerToolContext["fs"];
  readonly exec: RunnerToolContext["exec"];
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export type RemoteToolContextFactory = (context: import("@nnova/harness").ToolContext) => Promise<RemoteToolContext>;

const outputSchema = z.record(z.string(), z.unknown()) as unknown as z.ZodType<JsonValue>;
function tool<Schema extends z.ZodType>(definition: {
  name: string;
  description: string;
  inputSchema: Schema;
  effects: ToolDefinition["effects"];
  timeoutMs?: number;
  resourceKey?: ToolDefinition["resourceKey"];
  execute(input: z.output<Schema>, context: import("@nnova/harness").ToolContext): Promise<unknown>;
}): ToolDefinition {
  return defineTool({
    ...definition,
    inputSchema: definition.inputSchema as unknown as z.ZodType<JsonValue>,
    outputSchema,
    async execute(input, context) {
      return toJson(await definition.execute(definition.inputSchema.parse(input), context));
    },
  });
}

function success(content: string, details: unknown): JsonValue {
  return toJson({ status: "ok", content, details });
}
function remoteFailure(
  error: { code: string; message: string; outcome: "known" | "unknown"; details?: Readonly<Record<string, unknown>> },
  details?: unknown,
): never {
  const combined = {
    ...(error.details ?? {}),
    ...(details === undefined ? {} : isRecord(details) ? details : { details }),
  };
  throw new ToolFailureError(
    error.code,
    `${error.code}: ${error.message}`,
    error.outcome,
    Object.keys(combined).length ? toJson(combined) : undefined,
  );
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
function boundedOutput(output: { stdout: string; stderr: string }) {
  const clip = (value: string) =>
    value.length <= 32_768 ? value : `${value.slice(0, 32_768)}\n[partial output truncated]`;
  return { stdout: clip(output.stdout), stderr: clip(output.stderr) };
}
function resourcePath(value: string): string {
  return posix.normalize(value.replaceAll("\\", "/")).toLowerCase();
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function baseName(path: string): string {
  return basename(path.replaceAll("\\", "/")) || path;
}

function filePatch(path: string, before: string | undefined, after: string): string | null | undefined {
  if (before === after) return undefined;
  // A null patch records that the diff could not be generated within the preview budget.
  if (before === undefined || before.length + after.length > 512_000) return null;
  const patch = structuredPatch(path, path, before, after, "", "", { context: 3, maxEditLength: 2_000 });
  return patch ? formatPatch(patch) : null;
}

export const listDir = tool({
  name: "list_dir",
  description: "List files and directories in the Runner workspace.",
  inputSchema: z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(8).optional() }),
  effects: "read",
  async execute(input, harnessContext) {
    const ctx = await resolveContext(harnessContext);
    const path = input.path ?? ".";
    const result = await ctx.fs.list(path, { depth: input.depth ?? 1, maxEntries: 10_000 });
    if (!result.ok) remoteFailure(result.error, { path });
    const lines = result.value.map(
      (entry) =>
        `${entry.kind === "dir" ? "[dir]" : entry.kind === "symlink" ? "[link]" : "     "} ${baseName(entry.path)}`,
    );
    return success(lines.join("\n") || "(empty)", { path, entries: result.value, depth: input.depth ?? 1 });
  },
});

export const readFile = tool({
  name: "read_file",
  description: "Read a UTF-8 text file by one-based line number. Binary files are not supported.",
  inputSchema: z.object({
    path: z.string().min(1),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(2_000).optional(),
  }),
  effects: "read",
  async execute(input, harnessContext) {
    if (isBinaryPath(input.path))
      throw new ToolFailureError("BINARY_FILE", "Binary files are not supported by read_file.", "known", {
        path: input.path,
      });
    const ctx = await resolveContext(harnessContext);
    const result = await ctx.fs.read(input.path, { offset: input.offset ?? 1, limit: input.limit ?? 200 });
    if (!result.ok) remoteFailure(result.error, { path: input.path });
    const lines = result.value.text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const numbered = lines.map((line, index) => `${result.value.startLine + index}: ${line}`).join("\n");
    const markers = [
      result.value.lineTruncated ? "… line content truncated at the Runner byte limit" : "",
      result.value.truncated ? `… more content available from line ${result.value.endLine + 1}` : "",
    ].filter(Boolean);
    return success([numbered || "(empty)", ...markers].join("\n"), { path: input.path, ...result.value });
  },
});

export const writeFile = tool({
  name: "write_file",
  description: "Create a text file or replace its full contents using the digest returned by read_file.",
  inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
  effects: "write",
  resourceKey(input) {
    return `runner-path:${resourcePath(String((input as { path: string }).path))}`;
  },
  async execute(input, harnessContext) {
    const ctx = await resolveContext(harnessContext);
    const before = await ctx.fs.read(input.path, { offset: 1, limit: 2_000, signal: ctx.signal });
    let expectedSha256: string | undefined;
    if (before.ok) expectedSha256 = before.value.sha256;
    else if (before.error.code !== "NOT_FOUND") remoteFailure(before.error, { path: input.path });
    const result = await ctx.fs.write(input.path, input.content, {
      ...(expectedSha256 ? { expectedSha256 } : {}),
      signal: ctx.signal,
    });
    if (!result.ok) remoteFailure(result.error, { path: input.path });
    const previous = before.ok
      ? before.value.truncated || before.value.lineTruncated
        ? undefined
        : before.value.text
      : "";
    return success(`Wrote ${input.content.split("\n").length} lines to ${input.path}`, {
      path: input.path,
      bytes: new TextEncoder().encode(input.content).byteLength,
      created: result.value.created,
      sha256: result.value.sha256,
      sizeBytes: result.value.sizeBytes,
      patch: filePatch(input.path, previous, input.content),
    });
  },
});

export const editFile = tool({
  name: "edit_file",
  description: "Replace exact text in a file. oldText must be unique unless replaceAll is true.",
  inputSchema: z.object({
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    replaceAll: z.boolean().optional(),
  }),
  effects: "write",
  resourceKey(input) {
    return `runner-path:${resourcePath(String((input as { path: string }).path))}`;
  },
  async execute(input, harnessContext) {
    const ctx = await resolveContext(harnessContext);
    const read = await ctx.fs.read(input.path, { offset: 1, limit: 2_000, signal: ctx.signal });
    if (!read.ok) remoteFailure(read.error, { path: input.path });
    if (read.value.truncated || read.value.lineTruncated)
      throw new ToolFailureError("TOO_LARGE", "File is too large for an exact edit.", "known", { path: input.path });
    const occurrences = read.value.text.split(input.oldText).length - 1;
    if (!occurrences)
      throw new ToolFailureError("NOT_FOUND", "oldText was not found.", "known", {
        path: input.path,
        replacements: 0,
        reason: "not_found",
      });
    if (occurrences > 1 && input.replaceAll !== true)
      throw new ToolFailureError(
        "CONFLICT",
        "oldText occurs more than once; provide more context or set replaceAll.",
        "known",
        { path: input.path, occurrences, reason: "ambiguous" },
      );
    const before = read.value.text;
    const after = input.replaceAll
      ? before.split(input.oldText).join(input.newText)
      : before.replace(input.oldText, () => input.newText);
    const edits = input.replaceAll
      ? [{ oldText: before, newText: after }]
      : [{ oldText: input.oldText, newText: input.newText }];
    const result = await ctx.fs.patch(input.path, edits, { expectedSha256: read.value.sha256, signal: ctx.signal });
    if (!result.ok) remoteFailure(result.error, { path: input.path, occurrences });
    const replacements = input.replaceAll ? occurrences : 1;
    return success(`Replaced ${replacements} occurrence(s) in ${input.path}`, {
      path: input.path,
      replacements,
      sha256: result.value.sha256,
      patch: filePatch(input.path, before, after),
    });
  },
});

export const grep = tool({
  name: "grep",
  description: "Search workspace files using a regular expression.",
  inputSchema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    glob: z.string().optional(),
    maxResults: z.number().int().min(1).max(1_000).optional(),
  }),
  effects: "read",
  async execute(input, harnessContext) {
    const ctx = await resolveContext(harnessContext);
    const result = await ctx.fs.grep(input.pattern, {
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.glob === undefined ? {} : { glob: input.glob }),
      maxResults: input.maxResults ?? 100,
      signal: ctx.signal,
    });
    if (!result.ok) remoteFailure(result.error, { pattern: input.pattern });
    const content =
      result.value.matches
        .slice(0, 50)
        .map((match) => `${match.path}:${match.line}: ${match.text}`)
        .join("\n") || "No matches";
    return success(content, result.value);
  },
});

export const bash = tool({
  name: "bash",
  description: [
    "Run ONE program directly. Despite the name bash, this tool does not start a shell.",
    "command is only an executable name or path. Put each flag and argument in the args array.",
    "Use cwd for the working directory. For shell syntax, explicitly run sh -lc (POSIX) or powershell.exe -NoProfile -Command (Windows).",
    "Execution is treated as side-effecting; the host's tool policy decides whether to authorize it.",
  ].join("\n"),
  inputSchema: z.object({
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().max(900_000).optional(),
  }),
  effects: "write",
  async execute(input, harnessContext) {
    const ctx = await resolveContext(harnessContext);
    const streamed = { stdout: "", stderr: "" };
    let outputQueue = Promise.resolve();
    let queuedBytes = 0;
    const result = await ctx.exec(input.command, {
      args: input.args,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      timeoutMs: input.timeoutMs ?? 120_000,
      signal: ctx.signal,
      onOutput(chunk) {
        streamed[chunk.stream] = (streamed[chunk.stream] + chunk.text).slice(-32768);
        const bytes = Buffer.byteLength(chunk.text);
        queuedBytes += bytes;
        if (queuedBytes > 1048576) {
          outputQueue = outputQueue.then(() => {
            throw new ToolFailureError("OUTPUT_LIMIT", "Output persistence buffer exceeded.", "unknown");
          });
          return;
        }
        outputQueue = outputQueue
          .then(() => harnessContext.output?.(chunk.stream, chunk.text))
          .then(() => {
            queuedBytes -= bytes;
          });
        void outputQueue.catch(() => undefined);
      },
    });
    await outputQueue;
    if (!result.ok)
      remoteFailure(result.error, {
        command: input.command,
        args: input.args,
        streamedOutput: boundedOutput(streamed),
      });
    const content =
      [result.value.stdout, result.value.stderr].filter(Boolean).join("\n") ||
      `(command exited ${result.value.exitCode})`;
    return {
      status: result.value.exitCode === 0 ? "ok" : "error",
      content,
      details: result.value,
    };
  },
});

export const gitDiff = tool({
  name: "git_diff",
  description: "Show the current Git diff in the Runner workspace.",
  inputSchema: z.object({ path: z.string().optional(), staged: z.boolean().optional() }),
  effects: "read",
  async execute(input, harnessContext) {
    const ctx = await resolveContext(harnessContext);
    const args = ["diff", ...(input.staged ? ["--staged"] : []), ...(input.path ? ["--", input.path] : [])];
    const result = await ctx.exec("git", { args, signal: ctx.signal });
    if (result.ok) {
      if (result.value.stdout) await harnessContext.output?.("stdout", result.value.stdout);
      if (result.value.stderr) await harnessContext.output?.("stderr", result.value.stderr);
    }
    if (!result.ok) remoteFailure(result.error, { path: input.path ?? null });
    const content =
      result.value.stdout ||
      result.value.stderr ||
      (result.value.exitCode === 0 ? "No changes" : `git diff exited ${result.value.exitCode}`);
    return success(content, { ...result.value, path: input.path ?? null, staged: input.staged === true });
  },
});

export const remoteToolDefinitions = [listDir, readFile, writeFile, editFile, grep, bash, gitDiff] as const;

export function bindRemoteContext(
  factory: RemoteToolContextFactory,
): (context: import("@nnova/harness").ToolContext) => Promise<RemoteToolContext> {
  return factory;
}

function resolveContext(context: import("@nnova/harness").ToolContext): Promise<RemoteToolContext> {
  const resolver = resolverStorage.getStore();
  if (!resolver) throw new Error("Remote tool context factory is not active; use createRemoteTools().");
  return resolver(context);
}

const resolverStorage = new AsyncLocalStorage<RemoteToolContextFactory>();

export function withRemoteContextResolver<T>(resolver: RemoteToolContextFactory, action: () => T): T {
  return resolverStorage.run(resolver, action);
}

function isBinaryPath(path: string): boolean {
  const extension = path.toLowerCase().split(".").at(-1);
  return [
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "zip",
    "gz",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "woff",
    "woff2",
  ].includes(extension ?? "");
}
