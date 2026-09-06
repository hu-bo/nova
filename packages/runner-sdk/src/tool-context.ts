// 组装桥接（docs/runner-sdk.md §3）：RunnerSession → agent-core ToolContext。
// 这里是"协议事件/错误 → Result<T, FsError|ExecError>"的唯一转换点：
// fs / exec 绝不 throw（agent-core.md §3.3）。
//
// 语义注意：ToolContext.fs.read 的 offset/limit 是 1-based 行语义，直接映射
// Runner 的 ReadTextOp；readBytes 才映射字节范围 ReadFileRequest。
import { randomUUID } from "node:crypto";
import { posix, win32, type PlatformPath } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ErrorCode } from "./gen/common_pb.js";
import { ExecuteRequestSchema, ExecutionStatus, FileKind, OutputStream } from "./gen/execution_pb.js";
import type { ExecutionEvent, Finished } from "./gen/execution_pb.js";
import type {
  DirEntry as CoreDirEntry,
  ExecError,
  ExecOptions,
  ExecOutput,
  FileInfo as CoreFileInfo,
  FileSystem,
  FsError,
  GrepResult as CoreGrepResult,
  GrepOptions,
  OutputChunk,
  Result,
  TextFile,
  ToolContext,
} from "@nova/agent-core";
import { RunnerError, fromWireError, runnerUnavailable, toExecError, toFsError } from "./errors.js";
import { Utf8Decoder } from "./decode.js";
import type { RunnerSession } from "./session.js";

export function toToolContext(session: RunnerSession, opts: { cwd: string; signal?: AbortSignal }): ToolContext {
  const paths = remotePaths(session.identity.platform, session.identity.workspace, opts.cwd);
  return {
    fs: mapFs(session, paths),
    cwd: paths.cwd,
    signal: opts.signal ?? new AbortController().signal,
    exec(cmd: string, execOpts?: ExecOptions): Promise<Result<ExecOutput, ExecError>> {
      return runExec(session, cmd, execOpts, opts.signal, paths);
    },
  };
}

// —— exec：聚合事件流直到 Finished ——

async function runExec(
  session: RunnerSession,
  cmd: string,
  execOpts: ExecOptions | undefined,
  ctxSignal: AbortSignal | undefined,
  paths: RemotePaths,
): Promise<Result<ExecOutput, ExecError>> {
  const signals = [ctxSignal, execOpts?.signal].filter((s): s is AbortSignal => s !== undefined);
  // session.execute 内部已处理 abort → CancelRequest；这里只负责组合信号
  const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const request = create(ExecuteRequestSchema, {
    executionId: `execution-${randomUUID()}`,
    command: cmd,
    args: execOpts?.args ?? [],
    cwd: paths.resolve(execOpts?.cwd ?? "."),
    env: execOpts?.env ?? {},
    timeoutMs: execOpts?.timeoutMs ?? 0, // 0 = Runner 默认值
  });
  const stdoutDecoder = new Utf8Decoder();
  const stderrDecoder = new Utf8Decoder();
  let stdout = "";
  let stderr = "";
  try {
    for await (const event of session.execute(request, signal)) {
      if (event.event.case === "output") {
        const { stream, data } = event.event.value;
        if (stream === OutputStream.STDOUT) {
          const text = stdoutDecoder.decode(data);
          stdout += text;
          emit(execOpts?.onOutput, { stream: "stdout", text });
        } else if (stream === OutputStream.STDERR) {
          const text = stderrDecoder.decode(data);
          stderr += text;
          emit(execOpts?.onOutput, { stream: "stderr", text });
        }
        continue;
      }
      if (event.event.case === "finished") {
        stdout += stdoutDecoder.flush();
        stderr += stderrDecoder.flush();
        return finishResult(event.event.value, stdout, stderr);
      }
      // started：无消费方需要，跳过
    }
    // 流正常结束但没有 Finished = 连接失效（协议保证每个 execution 以 Finished 收尾）
    return { ok: false, error: toExecError(runnerUnavailable("execution stream ended without Finished")) };
  } catch (err) {
    return { ok: false, error: toExecError(toRunnerError(err)) };
  }
}

function emit(onOutput: ((chunk: OutputChunk) => void) | undefined, chunk: OutputChunk): void {
  if (onOutput === undefined) return;
  try {
    onOutput(chunk);
  } catch {
    // onOutput 是观测回调，失败不影响执行结果
  }
}

// Finished → Result。exit_code != 0 是 COMPLETED 事实，不是错误（proto.md §4.1）
function finishResult(finished: Finished, stdout: string, stderr: string): Result<ExecOutput, ExecError> {
  const truncated = finished.error !== undefined && finished.error.code === ErrorCode.TOO_LARGE;
  if (finished.status === ExecutionStatus.COMPLETED) {
    return {
      ok: true,
      value: { exitCode: finished.exitCode, stdout, stderr, truncated, durationMs: Number(finished.durationMs) },
    };
  }
  const runnerError =
    finished.status === ExecutionStatus.TIMED_OUT
      ? new RunnerError("TIMEOUT", finished.error?.message || "execution timed out")
      : finished.status === ExecutionStatus.CANCELLED
        ? new RunnerError("CANCELLED", finished.error?.message || "execution cancelled")
        : finished.error !== undefined
          ? fromWireError(finished.error) // BUSY 拒绝也走这里 → RUNNER_UNAVAILABLE
          : new RunnerError("IO", "execution failed");
  return { ok: false, error: toExecError(runnerError) };
}

function toRunnerError(err: unknown): RunnerError {
  return err instanceof RunnerError ? err : runnerUnavailable(err instanceof Error ? err.message : String(err));
}

// —— fs：session.fs（抛 RunnerError）→ Result<T, FsError>（不 throw）——

const WHOLE_TEXT_MAX_LINES = 2_000;
const TEXT_MAX_BYTES = 1024 * 1024;

function mapFs(session: RunnerSession, paths: RemotePaths): FileSystem {
  const wrap = async <T>(path: string | undefined, op: () => Promise<T>): Promise<Result<T, FsError>> => {
    try {
      return { ok: true, value: await op() };
    } catch (err) {
      return { ok: false, error: toFsError(toRunnerError(err), path) };
    }
  };
  return {
    read: (path, opts) =>
      wrap(path, async (): Promise<TextFile> => {
        const result = await session.fs.readText(paths.resolve(path), {
          offset: opts?.offset ?? 1,
          limit: opts?.limit ?? WHOLE_TEXT_MAX_LINES,
          maxBytes: TEXT_MAX_BYTES,
        });
        return {
          text: result.text,
          startLine: Number(result.startLine),
          endLine: Number(result.endLine),
          ...(result.totalLines === undefined ? {} : { totalLines: Number(result.totalLines) }),
          totalSize: Number(result.totalSize),
          truncated: result.truncated,
          lineTruncated: result.lineTruncated,
        };
      }),
    readBytes: (path) => wrap(path, async () => (await session.fs.readFile(paths.resolve(path))).data),
    write: (path, content, opts) =>
      wrap(path, async () => {
        await session.fs.writeFile(paths.resolve(path), new TextEncoder().encode(content), {
          append: opts?.append ?? false,
        });
      }),
    rename: (from, to) => wrap(from, () => session.fs.rename(paths.resolve(from), paths.resolve(to))),
    remove: (path, opts) =>
      wrap(path, () => session.fs.remove(paths.resolve(path), { recursive: opts?.recursive ?? false })),
    mkdir: (path) => wrap(path, () => session.fs.mkdir(paths.resolve(path))),
    list: (path, opts) =>
      wrap(path, async (): Promise<CoreDirEntry[]> =>
        (await session.fs.list(paths.resolve(path), opts?.depth)).map((entry) => ({
          name: entry.name,
          kind: kindToString(entry.kind),
        })),
      ),
    stat: (path) =>
      wrap(path, async (): Promise<CoreFileInfo> => {
        const info = await session.fs.stat(paths.resolve(path));
        return {
          path: paths.display(info.path),
          kind: kindToString(info.kind),
          size: Number(info.size),
          mtime: Number(info.mtime),
        };
      }),
    tempDir: (prefix) => wrap(undefined, async () => paths.display(await session.fs.tempDir(prefix))),
    grep: (pattern: string, opts?: GrepOptions) =>
      wrap(opts?.path, async (): Promise<CoreGrepResult> => {
        const result = await session.fs.grep(pattern, {
          ...opts,
          path: paths.resolve(opts?.path ?? "."),
        });
        return {
          matches: result.matches.map((match) => ({
            file: paths.display(match.file),
            line: match.line,
            text: match.text,
          })),
          total: result.total,
          truncated: result.truncated,
        };
      }),
  };
}

interface RemotePaths {
  cwd: string;
  resolve(path: string): string;
  display(path: string): string;
}

function remotePaths(platform: string, root: string, cwd: string): RemotePaths {
  const paths: PlatformPath = platform.startsWith("windows") ? win32 : posix;
  const normalizedRoot = paths.resolve(root);
  const normalizedCwd = paths.isAbsolute(cwd) ? paths.normalize(cwd) : paths.resolve(normalizedRoot, cwd);
  return {
    cwd: normalizedCwd,
    resolve(path) {
      return paths.isAbsolute(path) ? paths.normalize(path) : paths.resolve(normalizedCwd, path);
    },
    display(path) {
      const absolute = paths.isAbsolute(path) ? paths.normalize(path) : paths.resolve(normalizedRoot, path);
      return paths.relative(normalizedCwd, absolute) || ".";
    },
  };
}

function kindToString(kind: FileKind): "file" | "dir" | "symlink" {
  switch (kind) {
    case FileKind.DIR:
      return "dir";
    case FileKind.SYMLINK:
      return "symlink";
    default:
      return "file";
  }
}
