import { posix } from "node:path";
import type { Result, ToolContext } from "@nova/runner-sdk";
import type { RemoteConnectionService } from "../remotes/index.js";
import { DomainError } from "../../shared/domain-error.js";

function relative(path: string) {
  const normalized = path.replaceAll("\\", "/");
  if (
    /[\x00-\x1f]/.test(normalized) ||
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized) ||
    normalized.split("/").includes("..")
  )
    throw new DomainError("FORBIDDEN", "Tool path must stay inside the project workspace");
  return posix.normalize(normalized);
}
export async function sshToolContext(
  service: RemoteConnectionService,
  remoteId: string,
  owner: string,
  cwd: string,
  signal: AbortSignal,
  operationId: string,
): Promise<ToolContext> {
  const environment = await service.getEnvironment(remoteId, owner);
  const root = posix.resolve(environment.rootPath, cwd);
  const path = (value: string) => posix.join(root, relative(value));
  const result = async <T>(operation: () => Promise<T>): Promise<Result<T>> => {
    try {
      signal.throwIfAborted();
      const value = await operation();
      signal.throwIfAborted();
      return { ok: true, value };
    } catch (error) {
      const details = error instanceof DomainError ? error.details : undefined;
      const timeout =
        (error instanceof DomainError && error.details?.reason === "SSH_TIMEOUT") ||
        (signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError") ||
        (signal.aborted && signal.reason === "timeout");
      const cancelled = signal.aborted && signal.reason === "cancel";
      let code = error instanceof DomainError ? error.code : "IO";
      let message = error instanceof Error ? error.message : "Remote operation failed";
      if (timeout) {
        code = "TIMEOUT";
        message = "Remote command timed out.";
      } else if (cancelled) {
        code = "CANCELLED";
        message = "Remote command cancelled.";
      } else if (signal.aborted) {
        code = "RUN_INTERRUPTED";
      }
      return {
        ok: false,
        error: {
          code,
          message,
          outcome: "known",
          ...(details ? { details } : {}),
        },
      };
    }
  };
  return {
    cwd: root,
    signal,
    fs: {
      read: (value, options = {}) =>
        result(async () => {
          const file = await service.readText(remoteId, owner, path(value), options.signal ?? signal);
          const lines = file.text.split("\n"),
            start = options.offset ?? 1,
            limit = options.limit ?? 200;
          return {
            text: lines.slice(start - 1, start - 1 + limit).join("\n"),
            startLine: start,
            endLine: Math.min(lines.length, start - 1 + limit),
            totalLines: lines.length,
            totalSize: file.size,
            sha256: file.sha256,
            truncated: lines.length > start - 1 + limit,
            lineTruncated: false,
          };
        }),
      readBytes: (value, options = {}) =>
        result(async () =>
          Buffer.from((await service.readText(remoteId, owner, path(value), options.signal ?? signal)).text),
        ),
      list: (value = ".", options = {}) =>
        result(async () => {
          if ((options.depth ?? 1) !== 1)
            throw new DomainError("VALIDATION_ERROR", "List SSH subdirectories separately");
          const listing = await service.files(remoteId, owner, path(value));
          return listing.entries.slice(0, options.maxEntries ?? 500).map((entry) => ({
            path: posix.relative(root, entry.path),
            kind: entry.kind === "directory" ? ("dir" as const) : ("file" as const),
            sizeBytes: 0,
          }));
        }),
      write: (value, content, options = {}) =>
        result(async () => {
          const written = await service.writeText(
            remoteId,
            owner,
            path(value),
            content,
            options.expectedSha256,
            options.signal ?? signal,
          );
          return { path: value, sha256: written.sha256, sizeBytes: written.size, created: !options.expectedSha256 };
        }),
      patch: (value, edits, options) =>
        result(async () => {
          const file = await service.readText(remoteId, owner, path(value), options.signal ?? signal);
          if (file.sha256 !== options.expectedSha256)
            throw new DomainError("CONFLICT", "File changed since it was read");
          let content = file.text;
          for (const edit of edits) {
            if (!edit.oldText || content.split(edit.oldText).length !== 2)
              throw new DomainError("CONFLICT", "Edit must match exactly once");
            content = content.replace(edit.oldText, () => edit.newText);
          }
          const written = await service.writeText(
            remoteId,
            owner,
            path(value),
            content,
            file.sha256,
            options.signal ?? signal,
          );
          return { path: value, sha256: written.sha256, sizeBytes: written.size, editCount: edits.length };
        }),
      grep: (pattern, options = {}) =>
        result(async () => {
          if (options.glob) throw new DomainError("VALIDATION_ERROR", "SSH search does not support glob filters");
          // Literal search is bounded and never executes a model-supplied regular expression.
          const queue = [relative(options.path ?? ".")],
            matches: { path: string; line: number; text: string }[] = [];
          let inspected = 0,
            truncated = Boolean(options.glob);
          while (queue.length && inspected < 50 && matches.length < (options.maxResults ?? 100)) {
            signal.throwIfAborted();
            const directory = queue.shift()!;
            const listing = await service.files(remoteId, owner, path(directory));
            for (const entry of listing.entries) {
              const value = posix.relative(root, entry.path);
              if (entry.kind === "directory") {
                if (!["node_modules", ".git", "dist", ".next"].includes(entry.name) && queue.length < 100)
                  queue.push(value);
                continue;
              }
              if (++inspected > 50) break;
              let file;
              try {
                file = await service.readText(remoteId, owner, path(value), signal);
              } catch {
                continue;
              }
              for (const [index, line] of file.text.split("\n").entries())
                if (line.includes(pattern)) {
                  matches.push({ path: value, line: index + 1, text: line.slice(0, 1000) });
                  if (matches.length >= (options.maxResults ?? 100)) break;
                }
            }
          }
          return {
            matches,
            truncated:
              truncated || Boolean(queue.length) || inspected >= 50 || matches.length >= (options.maxResults ?? 100),
          };
        }),
    },
    exec: (executable, options = {}) =>
      result(async () => {
        if (options.env || options.stdin)
          throw new DomainError("VALIDATION_ERROR", "SSH commands do not support custom environment or stdin");
        const started = Date.now(),
          output = await service.execute(
            remoteId,
            owner,
            path(options.cwd ?? "."),
            executable,
            [...(options.args ?? [])],
            options.signal ?? signal,
            options.timeoutMs,
          );
        if (output.stdout) options.onOutput?.({ stream: "stdout", text: output.stdout });
        if (output.stderr) options.onOutput?.({ stream: "stderr", text: output.stderr });
        return {
          ...output,
          operationId,
          durationMs: Date.now() - started,
          outputGap: false,
        };
      }),
  };
}
